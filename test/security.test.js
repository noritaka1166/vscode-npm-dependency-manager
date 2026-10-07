const test = require('node:test');
const assert = require('node:assert/strict');
const { SecurityService } = require('../lib/security');

function mockFetch(t, handler) {
  const originalFetch = global.fetch;
  global.fetch = handler;
  t.after(() => { global.fetch = originalFetch; });
}

test('OSV通信失敗を一覧で取得失敗として扱い、詳細を開くと再試行して正常な空結果をキャッシュする', async (t) => {
  let requests = 0;
  mockFetch(t, async () => {
    if (++requests === 1) throw new Error('Network unavailable');
    return { ok: true, json: async () => ({ results: [{}] }) };
  });
  const service = new SecurityService();
  service.getAuditAdvisories = async () => new Map();
  const lockInfo = { exists: false, paths: new Map() };
  const dependency = { name: 'example', resolvedVersion: '1.0.0' };
  await service.enrichDependencies([dependency], lockInfo);
  assert.equal(dependency.osvStatus, 'error');
  assert.equal(dependency.osvError, 'Network unavailable');
  assert.equal(dependency.auditStatus, 'unknown');
  assert.equal(service.osvCache.has('example@1.0.0'), false);
  const detail = await service.getPackageSecurity({ name: 'example', resolvedVersion: '1.0.0', dependency, lockInfo });
  assert.equal(detail.osvStatus, 'ok');
  assert.equal(detail.osvError, '');
  assert.equal(detail.auditStatus, 'ok');
  assert.deepEqual(detail.osvVulnerabilities, []);
  await service.getOsvVulnerabilities([{ name: 'example', version: '1.0.0' }]);
  assert.equal(requests, 2);
});

test('OSVのHTTPエラー・JSON解析失敗・不完全な応答を正常結果として保存しない', async (t) => {
  const responses = [
    { ok: false, status: 503 },
    { ok: true, json: async () => { throw new Error('Invalid JSON'); } },
    { ok: true, json: async () => ({ results: [] }) },
    { ok: true, json: async () => ({ results: [null] }) },
    { ok: true, json: async () => ({ results: [{ vulns: 'invalid' }] }) }
  ];
  mockFetch(t, async () => responses.shift());
  const service = new SecurityService();
  const packages = [{ name: 'example', version: '1.0.0' }];
  for (let i = 0; i < 5; i++) {
    const result = await service.getOsvVulnerabilities(packages);
    assert.equal(result.statuses.get('example@1.0.0').status, 'error');
    assert.equal(service.osvCache.has('example@1.0.0'), false);
  }
});

test('OSV詳細の部分失敗でも取得済み脆弱性を保持し、失敗した詳細だけ再取得する', async (t) => {
  const counts = new Map();
  mockFetch(t, async (url) => {
    const count = (counts.get(url) || 0) + 1;
    counts.set(url, count);
    if (url.endsWith('/querybatch')) return { ok: true, json: async () => ({ results: [{ vulns: [{ id: 'OSV-A' }, { id: 'OSV-B' }] }] }) };
    if (url.endsWith('/OSV-B') && count === 1) return { ok: false, status: 503 };
    return { ok: true, json: async () => ({ id: url.split('/').at(-1), summary: 'Example vulnerability' }) };
  });
  const service = new SecurityService();
  const packages = [{ name: 'example', version: '1.0.0' }];
  const first = await service.getOsvVulnerabilities(packages);
  assert.equal(first.statuses.get('example@1.0.0').status, 'error');
  assert.deepEqual(first.get('example@1.0.0').map((vuln) => vuln.id), ['OSV-A']);
  assert.equal(service.osvCache.has('example@1.0.0'), false);
  const second = await service.getOsvVulnerabilities(packages);
  assert.equal(second.statuses.get('example@1.0.0').status, 'ok');
  assert.equal(second.get('example@1.0.0').length, 2);
  assert.equal(counts.get('https://api.osv.dev/v1/vulns/OSV-A'), 1);
  assert.equal(counts.get('https://api.osv.dev/v1/vulns/OSV-B'), 2);
});

test('npmで検出済みの脆弱性はOSV失敗時にも維持する', async (t) => {
  mockFetch(t, async () => { throw new Error('OSV unavailable'); });
  const service = new SecurityService();
  service.getAuditAdvisories = async () => new Map([['example', [{ title: 'Known vulnerability', severity: 'high' }]]]);
  const dependency = { name: 'example', resolvedVersion: '1.0.0' };
  await service.enrichDependencies([dependency], { exists: false, paths: new Map() });
  assert.equal(dependency.auditStatus, 'vulnerable');
  assert.equal(dependency.osvStatus, 'error');
  assert.equal(dependency.vulnerabilities.length, 1);
});

test('間接依存のOSV取得失敗も詳細に伝え、次に開くと再試行する', async (t) => {
  let requests = 0;
  mockFetch(t, async () => {
    if (++requests === 1) return { ok: false, status: 503 };
    return { ok: true, json: async () => ({ results: [{}] }) };
  });
  const service = new SecurityService();
  service.getAuditAdvisories = async () => new Map();
  service.osvCache.set('root@1.0.0', []);
  const root = { name: 'root', version: '1.0.0', path: 'node_modules/root', dependencies: { child: '^1.0.0' } };
  const child = { name: 'child', version: '1.0.0', path: 'node_modules/child' };
  const lockInfo = { exists: true, paths: new Map([[root.path, root], [child.path, child]]), packages: new Map([[root.name, root], [child.name, child]]) };
  const context = { name: root.name, resolvedVersion: root.version, lockPackage: root, lockInfo };
  const failed = await service.getPackageSecurity(context);
  assert.equal(failed.osvStatus, 'ok');
  assert.equal(failed.transitiveOsvStatus, 'error');
  assert.equal(failed.auditStatus, 'unknown');
  const retried = await service.getPackageSecurity({ ...context, dependency: failed });
  assert.equal(retried.transitiveOsvStatus, 'ok');
  assert.equal(retried.auditStatus, 'ok');
  assert.equal(requests, 2);
});

function createService(auditInputs) {
  const service = new SecurityService();
  service.getAuditAdvisories = async (input) => {
    auditInputs.push(input);
    return new Map();
  };
  service.getOsvVulnerabilitiesForDependencies = async () => new Map();
  service.getThreatIntelForCves = async () => ({ epss: new Map(), kev: new Map(), ssvc: new Map() });
  return service;
}

test('特殊な直接依存名でも監査入力を集計できる', async () => {
  const auditInputs = [];
  const service = createService(auditInputs);
  const dependencies = [
    { name: 'constructor', resolvedVersion: '1.0.0' },
    { name: '__proto__', resolvedVersion: '2.0.0' },
    { name: 'safe-package', resolvedVersion: '3.0.0' }
  ];

  await service.enrichDependencies(dependencies, { exists: false, paths: new Map() });

  assert.equal(Object.getPrototypeOf(auditInputs[0]), null);
  assert.deepEqual(auditInputs[0].constructor, ['1.0.0']);
  assert.deepEqual(auditInputs[0].__proto__, ['2.0.0']);
  assert.deepEqual(auditInputs[0]['safe-package'], ['3.0.0']);
  assert.equal(dependencies[0].auditStatus, 'ok');
  assert.equal(dependencies[1].auditStatus, 'ok');
  assert.equal(dependencies[2].auditStatus, 'ok');
});

test('特殊なロックファイル依存名でも監査入力を集計できる', async () => {
  const auditInputs = [];
  const service = createService(auditInputs);
  const paths = new Map([
    ['node_modules/constructor', { name: 'constructor', version: '1.0.0' }],
    ['node_modules/__proto__', { name: '__proto__', version: '2.0.0' }]
  ]);

  await service.enrichDependencies(
    [{ name: 'safe-package', resolvedVersion: '3.0.0' }],
    { exists: true, paths }
  );

  const lockAuditInput = auditInputs[1];
  assert.equal(Object.getPrototypeOf(lockAuditInput), null);
  assert.deepEqual(lockAuditInput.constructor, ['1.0.0']);
  assert.deepEqual(lockAuditInput.__proto__, ['2.0.0']);
});

test('ロック依存グラフから監査とOSVの推移的な脆弱性を同じ規則で集計する', async () => {
  const root = { name: 'root', version: '1.0.0', path: 'node_modules/root', dependencies: { child: '^1.0.0' } };
  const child = { name: 'child', version: '1.0.0', path: 'node_modules/root/node_modules/child', dependencies: { leaf: '^1.0.0' } };
  const leaf = { name: 'leaf', version: '1.0.0', path: 'node_modules/root/node_modules/child/node_modules/leaf' };
  const lockInfo = {
    exists: true,
    paths: new Map([[root.path, root], [child.path, child], [leaf.path, leaf]]),
    packages: new Map([[root.name, root], [child.name, child], [leaf.name, leaf]])
  };
  const service = new SecurityService();
  service.getAuditAdvisories = async () => new Map([
    ['child', [{ title: 'child advisory', severity: 'high', vulnerableVersions: '<2.0.0' }]],
    ['leaf', [{ title: 'unavailable audit', auditError: true }]]
  ]);
  service.getOsvVulnerabilities = async () => new Map([
    ['child@1.0.0', [{ id: 'OSV-child', severity: 'moderate' }]],
    ['leaf@1.0.0', [{ id: 'OSV-leaf', severity: 'low' }]]
  ]);
  service.getThreatIntelForCves = async () => ({ epss: new Map(), kev: new Map(), ssvc: new Map() });

  const security = await service.getPackageSecurity({
    name: root.name,
    resolvedVersion: root.version,
    dependency: { lockPath: root.path },
    lockPackage: root,
    lockInfo
  });

  assert.deepEqual(security.transitiveVulnerabilities.map((item) => item.packageName), ['child']);
  assert.deepEqual(security.transitiveOsvVulnerabilities.map((item) => item.id), ['OSV-child', 'OSV-leaf']);
});

test('CISA Vulnrichment から SSVC の意思決定要素を取得してキャッシュする', async (t) => {
  const originalFetch = global.fetch;
  let requests = 0;
  global.fetch = async (url) => {
    requests += 1;
    assert.equal(url, 'https://raw.githubusercontent.com/cisagov/vulnrichment/develop/2025/0xxx/CVE-2025-0752.json');
    return {
      ok: true,
      status: 200,
      json: async () => ({
        containers: {
          adp: [{
            metrics: [{
              other: {
                type: 'ssvc',
                content: {
                  id: 'CVE-2025-0752',
                  role: 'CISA Coordinator',
                  version: '2.0.3',
                  timestamp: '2025-01-28T14:35:14.655204Z',
                  options: [
                    { Exploitation: 'poc' },
                    { Automatable: 'yes' },
                    { 'Technical Impact': 'total' }
                  ]
                }
              }
            }]
          }]
        }
      })
    };
  };
  t.after(() => { global.fetch = originalFetch; });

  const service = new SecurityService();
  const first = await service.getSsvcDecisionPoints(['CVE-2025-0752']);
  const second = await service.getSsvcDecisionPoints(['CVE-2025-0752']);

  assert.deepEqual(first.get('CVE-2025-0752'), {
    cve: 'CVE-2025-0752',
    exploitation: 'poc',
    automatable: 'yes',
    technicalImpact: 'total',
    role: 'CISA Coordinator',
    version: '2.0.3',
    timestamp: '2025-01-28T14:35:14.655204Z'
  });
  assert.deepEqual(second, first);
  assert.equal(requests, 1);
});
