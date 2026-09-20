const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function dashboard(overrides = {}) {
  const source = fs.readFileSync(path.join(__dirname, '../media/main.js'), 'utf8');
  const app = { addEventListener() {}, contains() { return false; } };
  const context = {
    acquireVsCodeApi: () => ({ getState: () => ({}), postMessage() {} }),
    document: { getElementById: (id) => id === 'app' ? app : undefined, addEventListener() {} },
    window: { location: { origin: 'https://webview.test' }, addEventListener() {} }
  };
  vm.runInNewContext(source.replace('  vscode.postMessage({ type: \'ready\' });',
    '  globalThis.dashboard = { state, getVisibleDependencies, renderActiveFilters, renderUpdateStatus, renderPackageCard };'), context);
  Object.assign(context.dashboard.state, overrides);
  return context.dashboard;
}

const packages = [
  { name: 'alpha', description: 'HTTP client', type: 'dependencies', license: 'MIT', updateType: 'patch', auditStatus: 'ok' },
  { name: 'beta', description: 'HTTP client', type: 'devDependencies', license: 'ISC', updateType: 'major', auditStatus: 'vulnerable' },
  { name: 'gamma', description: 'HTTP server', type: 'dependencies', license: 'MIT', updateType: 'major', auditStatus: 'unknown' },
  { name: 'delta', description: 'Validation', type: 'dependencies', license: 'MIT', updateType: 'current', auditStatus: 'ok' }
];

test('種別・検索・更新・ライセンス条件を組み合わせて絞り込む', () => {
  const ui = dashboard({ dependencies: packages, filter: 'dependencies', searchQuery: 'http', updateFilter: 'major', licenseFilter: 'MIT' });
  assert.equal(ui.getVisibleDependencies().map((item) => item.name).join(','), 'gamma');
  ui.state.searchQuery = 'none';
  assert.equal(ui.getVisibleDependencies().length, 0);
});

test('更新とリスクの並べ替えで元のデータ順を変更しない', () => {
  const ui = dashboard({ dependencies: packages, sortBy: 'updates' });
  assert.equal(ui.getVisibleDependencies().map((item) => item.name).join(','), 'beta,gamma,alpha,delta');
  ui.state.sortBy = 'risk';
  assert.equal(ui.getVisibleDependencies().map((item) => item.name).join(','), 'beta,gamma,alpha,delta');
  ui.state.sortBy = 'name';
  assert.equal(ui.getVisibleDependencies().map((item) => item.name).join(','), 'alpha,beta,delta,gamma');
  assert.equal(packages.map((item) => item.name).join(','), 'alpha,beta,gamma,delta');
});

test('初期表示は主要列に絞り、保存した列設定は維持する', () => {
  const ui = dashboard();
  assert.equal(ui.state.visibleColumns.join(','), 'current,latest,update,risk,action');
  const saved = ['license', 'currentPublished'];
  Object.assign(ui.state, { visibleColumns: saved });
  ui.getVisibleDependencies();
  assert.deepEqual(ui.state.visibleColumns, saved);
});

test('検索条件とカード内のパッケージ情報をHTMLとして解釈しない', () => {
  const ui = dashboard({ searchQuery: '<img src=x onerror=alert(1)>' });
  assert(!ui.renderActiveFilters().includes('<img'));
  const card = ui.renderPackageCard({ ...packages[0], name: '<script>x</script>', description: '<img src=x>', currentVersion: '1.0.0' });
  assert(!card.includes('<script>'));
  assert(!card.includes('<img'));
});

test('成功結果は詳細を折りたたみ、失敗の説明は最初から表示する', () => {
  const ui = dashboard({ updateResult: { status: 'succeeded', name: 'alpha', targetVersion: '2.0.0', before: { range: '^1.0.0' }, after: { range: '^2.0.0' } } });
  assert(!ui.renderUpdateStatus().includes('<details open'));
  ui.state.updateResult.status = 'failed';
  assert(ui.renderUpdateStatus().includes('<details open'));
  assert(ui.renderUpdateStatus().includes('Resolved version unavailable'));
});
