function resolveLockDependency(packagePath, name, lockInfo) {
  const paths = lockInfo?.paths;
  if (!paths) return lockInfo?.packages?.get(name) || null;

  let currentPath = String(packagePath || '');
  while (currentPath) {
    const candidate = paths.get(`${currentPath}/node_modules/${name}`);
    if (candidate) return candidate;
    const parentNodeModules = currentPath.lastIndexOf('/node_modules/');
    if (parentNodeModules === -1) break;
    currentPath = currentPath.slice(0, parentNodeModules);
  }

  // A same-name package in a sibling subtree is not reachable from this parent.
  return paths.get(`node_modules/${name}`) || null;
}

module.exports = { resolveLockDependency };
