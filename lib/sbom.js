const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');

const CYCLONEDX_SPEC_VERSION = '1.5';
const SPDX_VERSION = 'SPDX-2.3';

function createCycloneDxSbom({ packageJson, packageJsonPath, lockInfo, toolVersion = '' }) {
  const manifest = packageJson && typeof packageJson === 'object' ? packageJson : {};
  const lockPackages = getLockPackages(lockInfo);
  const directDependencies = getDirectDependencies(manifest);
  const componentsByRef = new Map();

  lockPackages.forEach((lockPackage) => {
    const component = createLockedComponent(lockPackage);
    if (component) {
      componentsByRef.set(component['bom-ref'], component);
    }
  });

  directDependencies.forEach((directDependency) => {
    const lockPackage = getDirectLockPackage(directDependency.name, lockInfo);
    if (!lockPackage) {
      const component = createUnresolvedComponent(directDependency);
      componentsByRef.set(component['bom-ref'], component);
    }
  });

  const rootComponent = createRootComponent(manifest, packageJsonPath);
  const components = [...componentsByRef.values()].sort(compareComponents);
  const dependencies = createDependencyGraph(rootComponent, directDependencies, lockPackages, lockInfo);

  return {
    bomFormat: 'CycloneDX',
    specVersion: CYCLONEDX_SPEC_VERSION,
    version: 1,
    metadata: {
      timestamp: new Date().toISOString(),
      tools: {
        components: [{
          type: 'application',
          supplier: { name: 'noritaka1166' },
          name: 'npm-dependency-manager',
          version: toolVersion || 'unknown'
        }]
      },
      component: rootComponent
    },
    components,
    dependencies
  };
}

function createSpdxSbom({ packageJson, packageJsonPath, lockInfo, toolVersion = '' }) {
  const manifest = packageJson && typeof packageJson === 'object' ? packageJson : {};
  const rootComponent = createRootComponent(manifest, packageJsonPath);
  const lockPackages = getLockPackages(lockInfo);
  const directDependencies = getDirectDependencies(manifest);
  const rootPackage = createSpdxPackage({
    name: rootComponent.name,
    version: rootComponent.version,
    purl: rootComponent.purl,
    purpose: 'APPLICATION',
    license: manifest.license
  });
  const packagesById = new Map([[rootPackage.SPDXID, rootPackage]]);

  lockPackages.forEach((lockPackage) => {
    const spdxPackage = createSpdxPackage({
      name: lockPackage.name,
      version: lockPackage.version,
      purl: createNpmPurl(lockPackage.name, lockPackage.version),
      downloadLocation: lockPackage.resolved,
      purpose: 'LIBRARY',
      integrity: lockPackage.integrity,
      path: lockPackage.path
    });
    packagesById.set(spdxPackage.SPDXID, spdxPackage);
  });

  directDependencies.forEach((directDependency) => {
    if (!getDirectLockPackage(directDependency.name, lockInfo)) {
      const spdxPackage = createSpdxPackage({
        name: directDependency.name,
        version: directDependency.version,
        purpose: 'LIBRARY',
        requestedVersion: directDependency.version,
        unresolved: true
      });
      packagesById.set(spdxPackage.SPDXID, spdxPackage);
    }
  });

  const documentName = `${rootComponent.name}-${rootComponent.version}-sbom`;
  return {
    spdxVersion: SPDX_VERSION,
    dataLicense: 'CC0-1.0',
    SPDXID: 'SPDXRef-DOCUMENT',
    name: documentName,
    documentNamespace: `https://spdx.org/spdxdocs/${encodeURIComponent(documentName)}-${randomUUID()}`,
    creationInfo: {
      created: new Date().toISOString(),
      creators: [`Tool: npm-dependency-manager-${toolVersion || 'unknown'}`]
    },
    documentDescribes: [rootPackage.SPDXID],
    packages: [...packagesById.values()].sort((a, b) => a.name.localeCompare(b.name)),
    relationships: createSpdxRelationships(rootPackage, directDependencies, lockPackages, lockInfo)
  };
}

function createSpdxPackage({ name, version, purl, downloadLocation, purpose, integrity, path: packagePath, license, requestedVersion, unresolved }) {
  const spdxPackage = {
    name: String(name),
    SPDXID: createSpdxPackageId(name, version),
    versionInfo: String(version || 'NOASSERTION'),
    downloadLocation: downloadLocation || 'NOASSERTION',
    filesAnalyzed: false,
    licenseConcluded: 'NOASSERTION',
    licenseDeclared: 'NOASSERTION',
    copyrightText: 'NOASSERTION',
    primaryPackagePurpose: purpose || 'LIBRARY'
  };
  const externalRefs = purl ? [{
    referenceCategory: 'PACKAGE-MANAGER',
    referenceType: 'purl',
    referenceLocator: purl
  }] : [];
  const commentLines = [
    requestedVersion ? `npm requested version: ${requestedVersion}` : '',
    packagePath ? `npm package path: ${packagePath}` : '',
    integrity ? `npm integrity: ${integrity}` : '',
    license ? `npm declared license: ${license}` : '',
    unresolved ? 'Package version is not resolved because no npm package-lock entry is available.' : ''
  ].filter(Boolean);

  if (externalRefs.length) {
    spdxPackage.externalRefs = externalRefs;
  }
  if (commentLines.length) {
    spdxPackage.comment = commentLines.join('\n');
  }
  return spdxPackage;
}

function createSpdxRelationships(rootPackage, directDependencies, lockPackages, lockInfo) {
  const relationships = new Map();
  addSpdxRelationship(relationships, 'SPDXRef-DOCUMENT', 'DESCRIBES', rootPackage.SPDXID);

  directDependencies.forEach((directDependency) => {
    const lockPackage = getDirectLockPackage(directDependency.name, lockInfo);
    const dependencyId = lockPackage
      ? createSpdxPackageId(lockPackage.name, lockPackage.version)
      : createSpdxPackageId(directDependency.name, directDependency.version);
    if (directDependency.type === 'devDependencies') {
      addSpdxRelationship(relationships, dependencyId, 'DEV_DEPENDENCY_OF', rootPackage.SPDXID);
    } else if (directDependency.type === 'optionalDependencies') {
      addSpdxRelationship(relationships, dependencyId, 'OPTIONAL_DEPENDENCY_OF', rootPackage.SPDXID);
    } else {
      addSpdxRelationship(relationships, rootPackage.SPDXID, 'DEPENDS_ON', dependencyId);
    }
  });

  lockPackages.forEach((lockPackage) => {
    const packageId = createSpdxPackageId(lockPackage.name, lockPackage.version);
    getLockDependencyNames(lockPackage)
      .map((name) => resolveLockDependency(lockPackage.path, name, lockInfo))
      .filter(Boolean)
      .forEach((dependency) => {
        addSpdxRelationship(relationships, packageId, 'DEPENDS_ON', createSpdxPackageId(dependency.name, dependency.version));
      });
  });

  return [...relationships.values()].sort((a, b) => {
    return `${a.spdxElementId}:${a.relationshipType}:${a.relatedSpdxElement}`.localeCompare(
      `${b.spdxElementId}:${b.relationshipType}:${b.relatedSpdxElement}`
    );
  });
}

function addSpdxRelationship(relationships, spdxElementId, relationshipType, relatedSpdxElement) {
  const key = `${spdxElementId}:${relationshipType}:${relatedSpdxElement}`;
  relationships.set(key, { spdxElementId, relationshipType, relatedSpdxElement });
}

function createSpdxPackageId(name, version) {
  const digest = createHash('sha256').update(`${name}@${version}`).digest('hex').slice(0, 24);
  return `SPDXRef-Package-${digest}`;
}

function createRootComponent(packageJson, packageJsonPath) {
  const fallbackName = packageJsonPath ? path.basename(path.dirname(packageJsonPath)) : 'application';
  const name = String(packageJson.name || fallbackName || 'application');
  const version = String(packageJson.version || '0.0.0');
  const reference = createNpmReference(name, version);
  const component = {
    type: 'application',
    'bom-ref': reference,
    name,
    version,
    purl: createNpmPurl(name, version)
  };

  if (packageJson.license) {
    component.licenses = [{ license: { name: String(packageJson.license) } }];
  }
  return component;
}

function createLockedComponent(lockPackage) {
  if (!lockPackage?.name || !lockPackage.version) {
    return null;
  }

  const reference = createNpmReference(lockPackage.name, lockPackage.version);
  const properties = [
    createProperty('npm:packagePath', lockPackage.path),
    createProperty('npm:integrity', lockPackage.integrity),
    createProperty('npm:resolved', lockPackage.resolved),
    lockPackage.dev ? createProperty('npm:dev', 'true') : null,
    lockPackage.peer ? createProperty('npm:peer', 'true') : null
  ].filter(Boolean);
  const component = {
    type: 'library',
    'bom-ref': reference,
    name: lockPackage.name,
    version: String(lockPackage.version),
    purl: createNpmPurl(lockPackage.name, lockPackage.version),
    scope: lockPackage.optional ? 'optional' : 'required'
  };

  if (properties.length) {
    component.properties = properties;
  }
  return component;
}

function createUnresolvedComponent(directDependency) {
  const reference = createUnresolvedReference(directDependency.name);
  return {
    type: 'library',
    'bom-ref': reference,
    name: directDependency.name,
    version: '0.0.0',
    scope: directDependency.type === 'optionalDependencies' ? 'optional' : 'required',
    properties: [createProperty('npm:requestedVersion', directDependency.version)]
  };
}

function createDependencyGraph(rootComponent, directDependencies, lockPackages, lockInfo) {
  const dependencies = new Map();
  const rootReferences = directDependencies.map((dependency) => {
    const lockPackage = getDirectLockPackage(dependency.name, lockInfo);
    return lockPackage ? createNpmReference(lockPackage.name, lockPackage.version) : createUnresolvedReference(dependency.name);
  });

  dependencies.set(rootComponent['bom-ref'], createDependencyEntry(rootComponent['bom-ref'], rootReferences));
  lockPackages.forEach((lockPackage) => {
    const reference = createNpmReference(lockPackage.name, lockPackage.version);
    const dependencyReferences = getLockDependencyNames(lockPackage)
      .map((name) => resolveLockDependency(lockPackage.path, name, lockInfo))
      .filter(Boolean)
      .map((dependency) => createNpmReference(dependency.name, dependency.version));
    dependencies.set(reference, createDependencyEntry(reference, dependencyReferences));
  });

  return [...dependencies.values()].sort((a, b) => a.ref.localeCompare(b.ref));
}

function createDependencyEntry(reference, dependsOn) {
  return {
    ref: reference,
    dependsOn: [...new Set(dependsOn)].sort((a, b) => a.localeCompare(b))
  };
}

function getLockPackages(lockInfo) {
  const source = lockInfo?.paths instanceof Map && lockInfo.paths.size
    ? [...lockInfo.paths.values()]
    : lockInfo?.packages instanceof Map ? [...lockInfo.packages.values()] : [];
  const packagesByPath = new Map();
  source.forEach((lockPackage) => {
    if (lockPackage?.name && lockPackage.version) {
      packagesByPath.set(lockPackage.path || `${lockPackage.name}@${lockPackage.version}`, lockPackage);
    }
  });
  return [...packagesByPath.values()];
}

function getDirectDependencies(packageJson) {
  const groups = ['dependencies', 'devDependencies', 'optionalDependencies'];
  const result = new Map();
  groups.forEach((type) => {
    Object.entries(packageJson[type] || {}).forEach(([name, version]) => {
      if (!result.has(name)) {
        result.set(name, { name, version: String(version), type });
      }
    });
  });
  return [...result.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function getDirectLockPackage(name, lockInfo) {
  const directPath = `node_modules/${name}`;
  return lockInfo?.paths?.get(directPath) || lockInfo?.packages?.get(name) || null;
}

function getLockDependencyNames(lockPackage) {
  return [...new Set([
    ...Object.keys(lockPackage.dependencies || {}),
    ...Object.keys(lockPackage.optionalDependencies || {}),
    ...Object.keys(lockPackage.peerDependencies || {})
  ])];
}

function resolveLockDependency(packagePath, name, lockInfo) {
  const paths = lockInfo?.paths;
  if (!(paths instanceof Map)) {
    return lockInfo?.packages?.get(name) || null;
  }

  let currentPath = String(packagePath || '');
  while (currentPath) {
    const candidate = `${currentPath}/node_modules/${name}`;
    if (paths.has(candidate)) {
      return paths.get(candidate);
    }
    const parentNodeModules = currentPath.lastIndexOf('/node_modules/');
    if (parentNodeModules === -1) {
      break;
    }
    currentPath = currentPath.slice(0, parentNodeModules);
  }
  return paths.get(`node_modules/${name}`) || lockInfo?.packages?.get(name) || null;
}

function createNpmReference(name, version) {
  return createNpmPurl(name, version);
}

function createUnresolvedReference(name) {
  return `npm:${name}@unresolved`;
}

function createNpmPurl(name, version) {
  return `pkg:npm/${encodePackageName(name)}@${encodeURIComponent(String(version))}`;
}

function encodePackageName(name) {
  return encodeURIComponent(String(name)).replace(/%2F/gi, '/');
}

function createProperty(name, value) {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  return { name, value: String(value) };
}

function compareComponents(a, b) {
  return `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`);
}

module.exports = {
  createCycloneDxSbom,
  createSpdxSbom,
  resolveLockDependency
};
