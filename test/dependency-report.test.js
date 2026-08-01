const test = require('node:test');
const assert = require('node:assert/strict');
const { createDependencyReportCsv } = require('../lib/dependency-report');

test('依存関係レポートを UTF-8 BOM 付き CSV に変換する', () => {
  const csv = createDependencyReportCsv([{
    name: 'example-package',
    type: 'dependencies',
    currentVersion: '^1.0.0',
    resolvedVersion: '1.2.3',
    latestVersion: '2.0.0',
    license: 'MIT',
    lockStatus: 'locked',
    updateType: 'major',
    auditStatus: 'vulnerable',
    vulnerabilities: [{}, {}],
    osvVulnerabilities: [{}],
    transitiveVulnerabilityCount: 4,
    maxSeverity: 'high',
    deprecated: true,
    lockPath: 'node_modules/example-package',
    lockResolved: 'https://registry.npmjs.org/example-package/-/example-package-1.2.3.tgz',
    description: 'Contains "quoted" text'
  }]);

  assert.ok(csv.startsWith('\uFEFF"Package","Dependency type"'));
  assert.ok(csv.includes('"3","4","high","Yes"'));
  assert.ok(csv.includes('"Contains ""quoted"" text"'));
  assert.ok(csv.endsWith('\r\n'));
});

test('任意の外部テキストだけをCSV数式として解釈されない文字列に変換する', () => {
  const csv = createDependencyReportCsv([{
    name: '@biomejs/biome',
    description: '=HYPERLINK("https://example.com")'
  }]);

  assert.ok(csv.includes('"@biomejs/biome"'));
  assert.ok(!csv.includes('"\u200B@biomejs/biome"'));
  assert.ok(csv.includes('"\u200B=HYPERLINK(""https://example.com"")"'));
});
