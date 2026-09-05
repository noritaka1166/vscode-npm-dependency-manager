const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

function createModel(files) {
  const filename = path.resolve(__dirname, '../extension.js');
  const localRequire = createRequire(filename);
  const documents = [];
  const vscode = {
    TreeItem: class {},
    EventEmitter: class { event() {} fire() {} },
    Uri: { file: (fsPath) => ({ fsPath }) },
    FileType: { File: 1 },
    workspace: {
      textDocuments: documents,
      fs: {
        async readFile(uri) {
          if (!files.has(uri.fsPath)) throw Object.assign(new Error('Missing file'), { code: 'FileNotFound' });
          return Buffer.from(JSON.stringify(files.get(uri.fsPath)));
        },
        async stat(uri) {
          if (!files.has(uri.fsPath)) throw Object.assign(new Error('Missing file'), { code: 'FileNotFound' });
          return { type: 1 };
        }
      }
    }
  };
  const sandbox = {
    require: (name) => name === 'vscode' ? vscode : localRequire(name),
    module: { exports: {} }, Buffer, console
  };
  vm.runInNewContext(`${fs.readFileSync(filename, 'utf8')}\nmodule.exports.Model = NpmWorkspaceModel;`, sandbox, { filename });
  const model = new sandbox.module.exports.Model({ workspaceState: { get: () => undefined } });
  model.packageFiles = [...files.keys()].filter((value) => value.endsWith('/package.json')).map((value) => ({ path: value }));
  return { model, documents };
}

test('更新前後のバージョンはregistryの推測値ではなく直接依存のlockfileから読む', async () => {
  const files = new Map([
    ['/a/package.json', { dependencies: { example: '^1.0.0' } }],
    ['/a/package-lock.json', { lockfileVersion: 3, packages: {
      'node_modules/example': { version: '1.0.0' },
      'node_modules/parent/node_modules/example': { version: '9.0.0' }
    } }]
  ]);
  const { model } = createModel(files);
  assert.equal((await model.getUpdateContext('example', '/a/package.json')).resolvedVersion, '1.0.0');
  files.get('/a/package-lock.json').packages['node_modules/example'].version = '1.1.0';
  assert.equal((await model.getUpdateContext('example', '/a/package.json')).resolvedVersion, '1.1.0');
  delete files.get('/a/package-lock.json').packages['node_modules/example'];
  assert.equal((await model.getUpdateContext('example', '/a/package.json')).resolvedVersion, '');
});

test('lockfile未解析のマネージャーとlockfileなしでは指定値と解決済み値を区別する', async () => {
  for (const packageManager of ['npm', 'pnpm', 'yarn', 'bun']) {
    const { model } = createModel(new Map([['/a/package.json', { packageManager, dependencies: { example: '^1.0.0' } }]]));
    const context = await model.getUpdateContext('example', '/a/package.json');
    assert.equal(context.range, '^1.0.0');
    assert.equal(context.resolvedVersion, '');
    assert.equal(context.packageManager.id, packageManager);
  }
});

test('未保存のpackage.json、別プロジェクト、重複した依存グループを拒否する', async () => {
  const files = new Map([['/a/package.json', { dependencies: { example: '^1.0.0' } }]]);
  const { model, documents } = createModel(files);
  await assert.rejects(model.getUpdateContext('example', '/b/package.json'), /Select a package.json/);
  documents.push({ uri: { fsPath: '/a/package.json' }, isDirty: true });
  await assert.rejects(model.getUpdateContext('example', '/a/package.json'), /Save package.json/);
  documents.length = 0;
  files.get('/a/package.json').devDependencies = { example: '^1.0.0' };
  await assert.rejects(model.getUpdateContext('example', '/a/package.json'), /exactly one/);
});

test('再取得中にプロジェクトを切り替えても古い応答で上書きしない', async () => {
  const { model } = createModel(new Map([
    ['/a/package.json', { dependencies: { first: '^1.0.0' } }],
    ['/b/package.json', { dependencies: { second: '^2.0.0' } }]
  ]));
  let releaseFirst;
  let firstStarted;
  const started = new Promise((resolve) => { firstStarted = resolve; });
  model.getRegistryPackage = async (name) => {
    if (name === 'first') {
      firstStarted();
      await new Promise((resolve) => { releaseFirst = resolve; });
    }
    const version = name === 'first' ? '1.0.0' : '2.0.0';
    return { latestVersion: version, versions: { [version]: {} } };
  };
  model.security.enrichDependencies = async () => {};
  model.selectedPackageJson = '/a/package.json';
  const first = model.loadDependencies();
  await started;
  await model.selectPackageJson('/b/package.json');
  releaseFirst();
  await first;
  assert.equal(model.allDependencies[0].name, 'second');
  assert.equal(model.packageJson.dependencies.second, '^2.0.0');
  assert.equal(model.selectedPackageJson, '/b/package.json');
  assert.equal(model.isLoading, false);
});

test('更新後の読込エラーでローディング表示が残らない', async () => {
  const { model } = createModel(new Map());
  model.selectedPackageJson = '/a/package.json';
  await assert.rejects(model.loadDependencies(), /Missing file/);
  assert.equal(model.isLoading, false);
  assert.match(model.message, /Missing file/);
});
