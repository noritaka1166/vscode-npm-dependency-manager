const PACKAGE_MANAGERS = {
  npm: {
    label: 'npm',
    lockfiles: ['package-lock.json']
  },
  pnpm: {
    label: 'pnpm',
    lockfiles: ['pnpm-lock.yaml']
  },
  yarn: {
    label: 'Yarn',
    lockfiles: ['yarn.lock']
  },
  bun: {
    label: 'Bun',
    lockfiles: ['bun.lock', 'bun.lockb']
  }
};

function detectPackageManager(packageJson, lockfiles) {
  const availableLockfiles = new Set((lockfiles || []).filter(Boolean));
  const declared = parsePackageManagerDeclaration(packageJson?.packageManager);

  if (declared) {
    return createPackageManagerInfo(declared.id, declared.version, 'packageManager', availableLockfiles);
  }

  for (const id of Object.keys(PACKAGE_MANAGERS)) {
    if (PACKAGE_MANAGERS[id].lockfiles.some((lockfile) => availableLockfiles.has(lockfile))) {
      return createPackageManagerInfo(id, '', 'lockfile', availableLockfiles);
    }
  }

  return createPackageManagerInfo('npm', '', 'default', availableLockfiles);
}

function parsePackageManagerDeclaration(value) {
  const declarationPattern = /^(npm|pnpm|yarn|bun)(?:@(.+))?$/i;
  const match = declarationPattern.exec(String(value || '').trim());
  if (!match) {
    return null;
  }

  return {
    id: match[1].toLowerCase(),
    version: match[2] || ''
  };
}

function createPackageManagerInfo(id, version, source, availableLockfiles) {
  const definition = PACKAGE_MANAGERS[id] || PACKAGE_MANAGERS.npm;
  const lockfile = definition.lockfiles.find((name) => availableLockfiles.has(name)) || '';

  return {
    id,
    label: definition.label,
    version,
    source,
    lockfile,
    hasLockfile: Boolean(lockfile)
  };
}

function createPackageInstallCommand(packageManager, specifier, dependencyType) {
  const id = packageManager?.id in PACKAGE_MANAGERS ? packageManager.id : 'npm';
  const isDevDependency = dependencyType === 'devDependencies';
  const quotedSpecifier = shellQuote(specifier);

  if (id === 'pnpm') {
    return ['pnpm', 'add', quotedSpecifier, isDevDependency ? '--save-dev' : '--save-prod'].join(' ');
  }
  if (id === 'yarn') {
    return ['yarn', 'add', quotedSpecifier, isDevDependency ? '--dev' : ''].filter(Boolean).join(' ');
  }
  if (id === 'bun') {
    return ['bun', 'add', quotedSpecifier, isDevDependency ? '--dev' : ''].filter(Boolean).join(' ');
  }

  return ['npm', 'install', quotedSpecifier, isDevDependency ? '--save-dev' : '--save'].join(' ');
}

function shellQuote(value) {
  return "'" + String(value).replaceAll("'", String.raw`'\''`) + "'";
}

module.exports = {
  PACKAGE_MANAGERS,
  createPackageInstallCommand,
  detectPackageManager,
  parsePackageManagerDeclaration
};
