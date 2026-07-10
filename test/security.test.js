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
  service.getThreatIntelForCves = async () => ({ epss: new Map(), kev: new Map() });
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
