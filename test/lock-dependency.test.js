const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveLockDependency } = require('../lib/lock-dependency');

test('スコープ付き依存を直下・近い祖先・ルートの順で探索する', () => {
  const parent = 'node_modules/@scope/root/node_modules/parent/node_modules/child';
  const candidates = [
    `${parent}/node_modules/@scope/target`,
    'node_modules/@scope/root/node_modules/parent/node_modules/@scope/target',
    'node_modules/@scope/root/node_modules/@scope/target',
    'node_modules/@scope/target'
  ];
  const paths = new Map(candidates.map((path, index) => [path, { path, version: `${index + 1}.0.0` }]));
  for (const candidate of candidates) {
    assert.equal(resolveLockDependency(parent, '@scope/target', { paths }).path, candidate);
    paths.delete(candidate);
  }
  assert.equal(resolveLockDependency(parent, '@scope/target', { paths }), null);
});

test('探索経路に存在しない同名依存は別サブツリーから代用しない', () => {
  const unrelated = { path: 'node_modules/sibling/node_modules/target', version: '9.0.0' };
  const lockInfo = { paths: new Map([[unrelated.path, unrelated]]), packages: new Map([['target', unrelated]]) };
  assert.equal(resolveLockDependency('node_modules/parent', 'target', lockInfo), null);
  assert.equal(resolveLockDependency('', 'target', lockInfo), null);
  assert.equal(resolveLockDependency('node_modules/parent', 'missing', lockInfo), null);
});
