const test = require('node:test');
const assert = require('node:assert/strict');
const { SecurityService } = require('../lib/security');

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
