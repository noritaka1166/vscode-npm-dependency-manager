const test = require('node:test');
const assert = require('node:assert/strict');
const { createCycloneDxSbom, createSpdxSbom, resolveLockDependency } = require('../lib/sbom');

function createLockInfo() {
  const rootDependency = {
    name: 'root-dependency',
    version: '1.0.0',
    path: 'node_modules/root-dependency',
    integrity: 'sha512-root',
    dependencies: { nested: '^2.0.0' }
  };
  const nestedDependency = {
    name: 'nested',
    version: '2.0.0',
    path: 'node_modules/root-dependency/node_modules/nested',
    dependencies: {}
  };
  const paths = new Map([
    [rootDependency.path, rootDependency],
    [nestedDependency.path, nestedDependency]
  ]);
  return {
    paths,
    packages: new Map([
      [rootDependency.name, rootDependency],
      [nestedDependency.name, nestedDependency]
    ])
  };
}

test('package-lock の依存グラフを CycloneDX JSON に変換する', () => {
  const sbom = createCycloneDxSbom({
    packageJson: {
      name: 'sample-app',
      version: '3.0.0',
      license: 'MIT',
      dependencies: { 'root-dependency': '^1.0.0' },
      devDependencies: { unpinned: '^4.0.0' }
    },
    packageJsonPath: '/workspace/package.json',
    lockInfo: createLockInfo(),
    toolVersion: '0.0.7'
  });

  assert.equal(sbom.bomFormat, 'CycloneDX');
  assert.equal(sbom.specVersion, '1.5');
  assert.equal(sbom.metadata.component['bom-ref'], 'pkg:npm/sample-app@3.0.0');
  assert.equal(sbom.metadata.tools.components[0].version, '0.0.7');
  assert.deepEqual(
    sbom.components.map((component) => component.name),
    ['nested', 'root-dependency', 'unpinned']
  );
  assert.deepEqual(
    sbom.dependencies.find((dependency) => dependency.ref === 'pkg:npm/root-dependency@1.0.0').dependsOn,
    ['pkg:npm/nested@2.0.0']
  );
  assert.deepEqual(
    sbom.dependencies.find((dependency) => dependency.ref === 'pkg:npm/sample-app@3.0.0').dependsOn,
    ['npm:unpinned@unresolved', 'pkg:npm/root-dependency@1.0.0']
  );
});

test('ネストしたパッケージから Node.js の探索規則で依存先を解決する', () => {
  const lockInfo = createLockInfo();
  assert.equal(
    resolveLockDependency('node_modules/root-dependency/node_modules/nested', 'root-dependency', lockInfo).version,
    '1.0.0'
  );
});

test('package-lock の依存グラフを SPDX 2.3 JSON に変換する', () => {
  const sbom = createSpdxSbom({
    packageJson: {
      name: 'sample-app',
      version: '3.0.0',
      dependencies: { 'root-dependency': '^1.0.0' },
      devDependencies: { unpinned: '^4.0.0' }
    },
    packageJsonPath: '/workspace/package.json',
    lockInfo: createLockInfo(),
    toolVersion: '0.0.7'
  });

  assert.equal(sbom.spdxVersion, 'SPDX-2.3');
  assert.equal(sbom.dataLicense, 'CC0-1.0');
  assert.equal(sbom.documentDescribes.length, 1);
  assert.equal(sbom.packages.length, 4);
  assert.ok(sbom.packages.every((spdxPackage) => spdxPackage.SPDXID.startsWith('SPDXRef-Package-')));
  assert.ok(sbom.relationships.some((relationship) => relationship.relationshipType === 'DESCRIBES'));
  assert.ok(sbom.relationships.some((relationship) => relationship.relationshipType === 'DEV_DEPENDENCY_OF'));
  assert.ok(sbom.relationships.some((relationship) => relationship.relationshipType === 'DEPENDS_ON'));
});
