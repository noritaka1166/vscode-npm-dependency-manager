const test = require('node:test');
const assert = require('node:assert/strict');
const { createPackageInstallCommand, detectPackageManager } = require('../lib/package-manager');

test('packageManager フィールドを lockfile より優先して検出する', () => {
  const manager = detectPackageManager({ packageManager: 'pnpm@9.15.4' }, ['package-lock.json', 'pnpm-lock.yaml']);

  assert.deepEqual(manager, {
    id: 'pnpm',
    label: 'pnpm',
    version: '9.15.4',
    source: 'packageManager',
    lockfile: 'pnpm-lock.yaml',
    hasLockfile: true
  });
});

test('lockfile から npm、pnpm、Yarn、Bun を検出する', () => {
  const cases = [
    [['package-lock.json'], 'npm'],
    [['pnpm-lock.yaml'], 'pnpm'],
    [['yarn.lock'], 'yarn'],
    [['bun.lockb'], 'bun']
  ];

  for (const [lockfiles, expected] of cases) {
    assert.equal(detectPackageManager({}, lockfiles).id, expected);
  }
});

test('判定できない場合は npm にフォールバックする', () => {
  const manager = detectPackageManager({ packageManager: 'unknown@1.0.0' }, []);

  assert.equal(manager.id, 'npm');
  assert.equal(manager.source, 'default');
});

test('更新コマンドをパッケージマネージャーと依存種別に合わせて作成する', () => {
  const specifier = '@scope/package@2.0.0';

  assert.equal(createPackageInstallCommand({ id: 'npm' }, specifier, 'dependencies'), "npm install '@scope/package@2.0.0' --save");
  assert.equal(createPackageInstallCommand({ id: 'pnpm' }, specifier, 'devDependencies'), "pnpm add '@scope/package@2.0.0' --save-dev");
  assert.equal(createPackageInstallCommand({ id: 'yarn' }, specifier, 'devDependencies'), "yarn add '@scope/package@2.0.0' --dev");
  assert.equal(createPackageInstallCommand({ id: 'bun' }, specifier, 'dependencies'), "bun add '@scope/package@2.0.0'");
});
