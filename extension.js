const vscode = require('vscode');
const path = require('path');

const VIEW_ID = 'workspaceNpmSidebar.dependenciesView';
const PANEL_TYPE = 'workspaceNpmSidebar.dashboard';
const REGISTRY_BASE_URL = 'https://registry.npmjs.org';
const AUDIT_BULK_URL = `${REGISTRY_BASE_URL}/-/npm/v1/security/advisories/bulk`;

function activate(context) {
  const model = new NpmWorkspaceModel();
  const panel = new DashboardPanel(context.extensionUri, model);
  const tree = new DependenciesTreeProvider(model);
  const treeView = vscode.window.createTreeView(VIEW_ID, { treeDataProvider: tree });

  context.subscriptions.push(
    treeView,
    treeView.onDidChangeVisibility((event) => {
      if (event.visible) {
        panel.show();
      }
    }),
    model.onDidChange(() => {
      tree.refresh();
      panel.update();
    }),
    vscode.commands.registerCommand('workspaceNpmSidebar.show', () => panel.show()),
    vscode.commands.registerCommand('workspaceNpmSidebar.refresh', async () => {
      await model.refresh();
      panel.show();
    }),
    vscode.commands.registerCommand('workspaceNpmSidebar.openPackage', async (dependency) => {
      if (dependency && dependency.name) {
        await panel.showPackage(dependency.name, dependency);
      }
    })
  );

  model.refresh().catch((error) => vscode.window.showErrorMessage(getErrorMessage(error)));
}

function deactivate() {}

class NpmWorkspaceModel {
  constructor() {
    this.packageFiles = [];
    this.selectedPackageJson = undefined;
    this.filter = 'all';
    this.dependencies = [];
    this.dependencyCounts = {
      dependencies: 0,
      devDependencies: 0
    };
    this.message = '';
    this.lockVersions = new Map();
    this.registryCache = new Map();
    this.dependencyCache = new Map();
    this.auditCache = new Map();
    this.readmeFallbackCache = new Map();
    this.emitter = new vscode.EventEmitter();
    this.onDidChange = this.emitter.event;
  }

  async refresh() {
    this.message = 'Finding package.json files...';
    this.emit();

    this.packageFiles = await findPackageJsonFiles();

    if (!this.packageFiles.length) {
      this.selectedPackageJson = undefined;
      this.dependencies = [];
      this.message = 'No package.json files found in this workspace.';
      this.emit();
      return;
    }

    if (!this.selectedPackageJson || !this.packageFiles.some((file) => file.path === this.selectedPackageJson)) {
      this.selectedPackageJson = this.packageFiles[0].path;
    }

    await this.loadDependencies();
  }

  async selectPackageJson(path) {
    this.selectedPackageJson = path;
    await this.loadDependencies();
  }

  async setFilter(filter) {
    this.filter = filter || 'all';
    await this.loadDependencies();
  }

  async loadDependencies() {
    if (!this.selectedPackageJson) {
      await this.refresh();
      return;
    }

    this.message = 'Loading dependencies...';
    this.emit();

    const packageJson = await readPackageJson(this.selectedPackageJson);
    this.lockVersions = await readLockVersions(this.selectedPackageJson);
    this.dependencyCounts = getDependencyCounts(packageJson);
    const entries = collectDependencyEntries(packageJson, this.filter);

    this.dependencies = await mapWithConcurrency(entries, 8, async (entry) => {
      return this.enrichDependency(entry, this.lockVersions.get(entry.name));
    });

    await this.attachAuditInfo(this.dependencies);

    this.message = '';
    this.emit();
  }

  async enrichDependency(entry, resolvedVersion) {
    const registry = await this.getRegistryPackage(entry.name);
    const versionInfo = resolveVersionInfo(registry, resolvedVersion || entry.currentVersion);
    const fallbackReadme = registry.readme ? '' : await this.getFallbackReadme(name, registry);

    return {
      ...entry,
      resolvedVersion: resolvedVersion || versionInfo.version || '',
      latestVersion: registry.latestVersion,
      resolvedPublishedAt: getPublishedAt(registry.time, resolvedVersion || versionInfo.version),
      latestPublishedAt: getPublishedAt(registry.time, registry.latestVersion),
      description: registry.description,
      npmUrl: `https://www.npmjs.com/package/${entry.name}`,
      status: getVersionStatus(entry.currentVersion, registry.latestVersion),
      deprecated: Boolean(versionInfo.manifest && versionInfo.manifest.deprecated),
      deprecatedMessage: versionInfo.manifest && versionInfo.manifest.deprecated ? versionInfo.manifest.deprecated : ''
    };
  }

  async attachAuditInfo(dependencies) {
    const auditInput = {};
    dependencies.forEach((dependency) => {
      if (!dependency.resolvedVersion) {
        dependency.auditStatus = 'unknown';
        dependency.vulnerabilities = [];
        return;
      }

      if (!auditInput[dependency.name]) {
        auditInput[dependency.name] = [];
      }
      auditInput[dependency.name].push(dependency.resolvedVersion);
    });

    const auditResult = await this.getAuditAdvisories(auditInput);
    dependencies.forEach((dependency) => {
      if (!dependency.resolvedVersion) {
        return;
      }

      dependency.vulnerabilities = auditResult.get(dependency.name) || [];
      if (dependency.vulnerabilities.every((advisory) => advisory.auditError)) {
        dependency.auditStatus = 'unknown';
        dependency.auditError = dependency.vulnerabilities[0] && dependency.vulnerabilities[0].title;
        dependency.vulnerabilities = [];
        return;
      }
      dependency.auditStatus = dependency.vulnerabilities.length ? 'vulnerable' : 'ok';
      dependency.maxSeverity = getMaxSeverity(dependency.vulnerabilities);
    });
  }

  async getAuditAdvisories(packageVersions) {
    const normalized = {};
    Object.entries(packageVersions).forEach(([name, versions]) => {
      const uniqueVersions = [...new Set(versions.filter(Boolean))];
      if (uniqueVersions.length) {
        normalized[name] = uniqueVersions;
      }
    });

    const cacheKey = JSON.stringify(normalized);
    if (this.auditCache.has(cacheKey)) {
      return this.auditCache.get(cacheKey);
    }

    const result = new Map();
    if (!Object.keys(normalized).length) {
      this.auditCache.set(cacheKey, result);
      return result;
    }

    try {
      const response = await fetch(AUDIT_BULK_URL, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json'
        },
        body: JSON.stringify(normalized)
      });

      if (!response.ok) {
        throw new Error(`npm audit returned ${response.status}`);
      }

      const data = await response.json();
      Object.entries(data || {}).forEach(([name, advisories]) => {
        result.set(name, Array.isArray(advisories) ? advisories.map(normalizeAdvisory) : []);
      });
    } catch (error) {
      Object.keys(normalized).forEach((name) => {
        result.set(name, [{
          title: getErrorMessage(error),
          severity: 'unknown',
          url: '',
          vulnerableVersions: '',
          auditError: true
        }]);
      });
    }

    this.auditCache.set(cacheKey, result);
    return result;
  }

  async getDetail(name, dependencyHint) {
    const registry = await this.getRegistryPackage(name);
    const dependency = dependencyHint || this.findKnownDependency(name);
    const versionInfo = resolveVersionInfo(registry, dependency && (dependency.resolvedVersion || dependency.currentVersion));
    const vulnerabilities = dependency && dependency.vulnerabilities ? dependency.vulnerabilities : [];

    return {
      name,
      description: registry.description,
      latestVersion: registry.latestVersion,
      resolvedVersion: dependency && dependency.resolvedVersion ? dependency.resolvedVersion : versionInfo.version,
      resolvedPublishedAt: getPublishedAt(registry.time, dependency && dependency.resolvedVersion ? dependency.resolvedVersion : versionInfo.version),
      latestPublishedAt: getPublishedAt(registry.time, registry.latestVersion),
      npmUrl: `https://www.npmjs.com/package/${name}`,
      homepage: registry.homepage,
      repository: registry.repository,
      license: registry.license,
      deprecated: Boolean(versionInfo.manifest && versionInfo.manifest.deprecated),
      deprecatedMessage: versionInfo.manifest && versionInfo.manifest.deprecated ? versionInfo.manifest.deprecated : '',
      vulnerabilities,
      auditStatus: dependency && dependency.auditStatus ? dependency.auditStatus : (dependency && dependency.resolvedVersion ? 'ok' : 'unknown'),
      auditError: dependency && dependency.auditError ? dependency.auditError : '',
      maxSeverity: dependency && dependency.maxSeverity ? dependency.maxSeverity : getMaxSeverity(vulnerabilities),
      readme: registry.readme || fallbackReadme || 'This package does not publish README content to the npm registry.'
    };
  }

  async getFallbackReadme(name, registry) {
    if (this.readmeFallbackCache.has(name)) {
      return this.readmeFallbackCache.get(name);
    }

    for (const url of getGitHubReadmeCandidates(name, registry)) {
      try {
        const response = await fetch(url, { headers: { accept: 'text/plain' } });
        if (!response.ok) {
          continue;
        }

        const text = await response.text();
        if (text.trim()) {
          this.readmeFallbackCache.set(name, text);
          return text;
        }
      } catch (error) {
        continue;
      }
    }

    this.readmeFallbackCache.set(name, '');
    return '';
  }

  findKnownDependency(name) {
    return this.dependencies.find((dependency) => dependency.name === name);
  }

  async getPackageDependencies(dependency, ancestry) {
    const cacheKey = `${dependency.name}@${dependency.resolvedVersion || dependency.currentVersion || 'latest'}`;
    const cached = this.dependencyCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const registry = await this.getRegistryPackage(dependency.name);
    const versionInfo = resolveVersionInfo(registry, dependency.resolvedVersion || dependency.currentVersion);
    const dependencies = versionInfo.manifest && versionInfo.manifest.dependencies ? versionInfo.manifest.dependencies : {};
    const entries = Object.entries(dependencies)
      .map(([name, currentVersion]) => ({
        name,
        currentVersion,
        type: 'dependencies',
        resolvedFromVersion: versionInfo.version
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    const result = await mapWithConcurrency(entries, 8, async (entry) => {
      return this.enrichDependency(entry, undefined);
    });

    await this.attachAuditInfo(result);

    this.dependencyCache.set(cacheKey, result);
    return result;
  }

  async getRegistryPackage(name) {
    const cached = this.registryCache.get(name);
    if (cached) {
      return cached;
    }

    const url = `${REGISTRY_BASE_URL}/${encodeURIComponent(name)}`;
    const response = await fetch(url, { headers: { accept: 'application/json' } });

    if (!response.ok) {
      throw new Error(`npm registry returned ${response.status} for ${name}`);
    }

    const data = await response.json();
    const normalized = {
      name,
      description: data.description || '',
      latestVersion: data['dist-tags'] && data['dist-tags'].latest ? data['dist-tags'].latest : '',
      time: data.time || {},
      versions: data.versions || {},
      readme: data.readme || '',
      homepage: data.homepage || '',
      repository: normalizeRepository(data.repository),
      license: data.license || ''
    };

    this.registryCache.set(name, normalized);
    return normalized;
  }

  getSelectedLabel() {
    const packageFile = this.packageFiles.find((file) => file.path === this.selectedPackageJson);
    return packageFile ? packageFile.label : this.selectedPackageJson;
  }

  getState() {
    return {
      type: 'state',
      packageFiles: this.packageFiles,
      selectedPackageJson: this.selectedPackageJson,
      selectedLabel: this.getSelectedLabel(),
      filter: this.filter,
      dependencyCounts: this.dependencyCounts,
      dependencies: this.dependencies,
      message: this.message
    };
  }

  emit() {
    this.emitter.fire();
  }
}

class DependenciesTreeProvider {
  constructor(model) {
    this.model = model;
    this.emitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.emitter.event;
  }

  refresh() {
    this.emitter.fire();
  }

  getTreeItem(item) {
    return item;
  }

  async getChildren(item) {
    if (item && item.dependency) {
      if (item.ancestry.includes(item.dependency.name)) {
        return [new MessageTreeItem('Circular dependency')];
      }

      try {
        const dependencies = await this.model.getPackageDependencies(item.dependency, item.ancestry);
        if (!dependencies.length) {
          return [new MessageTreeItem('No dependencies')];
        }

        const ancestry = [...item.ancestry, item.dependency.name];
        return dependencies.map((dependency) => new DependencyTreeItem(dependency, ancestry));
      } catch (error) {
        return [new MessageTreeItem(getErrorMessage(error))];
      }
    }

    if (this.model.message) {
      return [new MessageTreeItem(this.model.message)];
    }

    if (!this.model.selectedPackageJson) {
      return [new MessageTreeItem('No package.json selected')];
    }

    if (!this.model.dependencies.length) {
      return [new MessageTreeItem('No dependencies found')];
    }

    return this.model.dependencies.map((dependency) => new DependencyTreeItem(dependency, []));
  }
}

class DependencyTreeItem extends vscode.TreeItem {
  constructor(dependency, ancestry) {
    super(dependency.name, vscode.TreeItemCollapsibleState.Collapsed);
    this.dependency = dependency;
    this.ancestry = ancestry;
    this.description = getTreeDescription(dependency);
    this.tooltip = getTreeTooltip(dependency);
    this.contextValue = 'dependency';
    this.command = {
      command: 'workspaceNpmSidebar.openPackage',
      title: 'Open Package',
      arguments: [dependency]
    };
    this.iconPath = getDependencyIcon(dependency);
  }
}

class MessageTreeItem extends vscode.TreeItem {
  constructor(message) {
    super(message, vscode.TreeItemCollapsibleState.None);
    this.tooltip = message;
  }
}

class DashboardPanel {
  constructor(extensionUri, model) {
    this.extensionUri = extensionUri;
    this.model = model;
    this.panel = undefined;
  }

  show() {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.One);
      this.update();
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      PANEL_TYPE,
      'npm Packages',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')]
      }
    );

    this.panel.webview.html = this.getHtml(this.panel.webview);
    this.panel.onDidDispose(() => {
      this.panel = undefined;
    });

    this.panel.webview.onDidReceiveMessage(async (message) => {
      try {
        switch (message.type) {
          case 'ready':
            this.update();
            break;
          case 'selectPackageJson':
            await this.model.selectPackageJson(message.path);
            break;
          case 'setFilter':
            await this.model.setFilter(message.filter);
            break;
          case 'openPackage':
            await this.showPackage(message.name);
            break;
          case 'backToList':
            this.update();
            break;
        }
      } catch (error) {
        this.post({ type: 'error', message: getErrorMessage(error) });
      }
    });

    this.update();
  }

  async showPackage(name, dependency) {
    this.show();
    this.post({ type: 'loading', message: `Loading ${name}...` });
    const detail = await this.model.getDetail(name, dependency);
    this.post({ type: 'detail', detail });
  }

  update() {
    this.post(this.model.getState());
  }

  post(message) {
    if (this.panel) {
      this.panel.webview.postMessage(message);
    }
  }

  getHtml(webview) {
    const nonce = getNonce();
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'main.js'));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'styles.css'));

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https: data:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${styleUri}">
  <title>npm Packages</title>
</head>
<body>
  <main id="app"></main>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

async function findPackageJsonFiles() {
  const files = await vscode.workspace.findFiles(
    '**/package.json',
    '{**/node_modules/**,**/.git/**,**/dist/**,**/out/**,**/build/**}',
    500
  );

  return files
    .map((uri) => ({
      path: uri.fsPath,
      label: vscode.workspace.asRelativePath(uri, false)
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

async function readPackageJson(fsPath) {
  const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(fsPath));
  return JSON.parse(Buffer.from(bytes).toString('utf8'));
}

async function readLockVersions(packageJsonPath) {
  const lockPath = path.join(path.dirname(packageJsonPath), 'package-lock.json');
  const versions = new Map();

  try {
    const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(lockPath));
    const lock = JSON.parse(Buffer.from(bytes).toString('utf8'));

    if (lock.packages) {
      Object.entries(lock.packages).forEach(([packagePath, info]) => {
        if (!packagePath.startsWith('node_modules/') || !info || !info.version) {
          return;
        }

        const name = packagePath.split('node_modules/').at(-1);
        versions.set(name, info.version);
      });
      return versions;
    }

    if (lock.dependencies) {
      collectLockDependencyVersions(lock.dependencies, versions);
    }
  } catch (error) {
    return versions;
  }

  return versions;
}

function collectLockDependencyVersions(dependencies, versions) {
  Object.entries(dependencies || {}).forEach(([name, info]) => {
    if (info && info.version) {
      versions.set(name, info.version);
    }
    if (info && info.dependencies) {
      collectLockDependencyVersions(info.dependencies, versions);
    }
  });
}

function collectDependencyEntries(packageJson, filter) {
  const groups = [
    ['dependencies', packageJson.dependencies || {}],
    ['devDependencies', packageJson.devDependencies || {}]
  ];

  return groups
    .filter(([type]) => filter === 'all' || filter === type)
    .flatMap(([type, deps]) =>
      Object.entries(deps).map(([name, currentVersion]) => ({
        name,
        currentVersion,
        type
      }))
    )
    .sort((a, b) => a.name.localeCompare(b.name));
}

function getDependencyCounts(packageJson) {
  return {
    dependencies: Object.keys(packageJson.dependencies || {}).length,
    devDependencies: Object.keys(packageJson.devDependencies || {}).length
  };
}

function getVersionStatus(currentRange, latestVersion) {
  const current = String(currentRange || '').replace(/^[~^<>=\s]+/, '');
  if (!latestVersion) {
    return 'unknown';
  }
  if (current === latestVersion) {
    return 'current';
  }
  return 'update';
}

function getPublishedAt(timeMap, version) {
  if (!timeMap || !version || !timeMap[version]) {
    return '';
  }
  return timeMap[version];
}

function normalizeAdvisory(advisory) {
  return {
    title: advisory.title || advisory.name || 'Security advisory',
    severity: advisory.severity || 'unknown',
    url: advisory.url || advisory.source || '',
    vulnerableVersions: advisory.vulnerable_versions || advisory.vulnerableVersions || advisory.range || '',
    patchedVersions: advisory.patched_versions || advisory.patchedVersions || ''
  };
}

function getMaxSeverity(vulnerabilities) {
  const order = ['info', 'low', 'moderate', 'high', 'critical'];
  return (vulnerabilities || []).reduce((max, vulnerability) => {
    const severity = vulnerability.severity || 'unknown';
    return order.indexOf(severity) > order.indexOf(max) ? severity : max;
  }, 'info');
}

function getTreeDescription(dependency) {
  const flags = [];
  if (dependency.deprecated) {
    flags.push('deprecated');
  }
  if (dependency.auditStatus === 'vulnerable') {
    flags.push(dependency.maxSeverity || 'vulnerable');
  }
  return flags.length ? `${dependency.currentVersion}  ${flags.join(', ')}` : dependency.currentVersion;
}

function getTreeTooltip(dependency) {
  const lines = [
    dependency.name,
    dependency.type,
    `Required: ${dependency.currentVersion}`,
    `Resolved: ${dependency.resolvedVersion || '-'}`,
    `Latest: ${dependency.latestVersion || '-'}`
  ];

  if (dependency.deprecated) {
    lines.push(`Deprecated: ${dependency.deprecatedMessage || 'yes'}`);
  }
  if (dependency.auditStatus === 'vulnerable') {
    lines.push(`Vulnerabilities: ${dependency.vulnerabilities.length}`);
  }
  if (dependency.auditStatus === 'unknown') {
    lines.push('Vulnerabilities: not checked');
  }

  return lines.join('\n');
}

function getDependencyIcon(dependency) {
  if (dependency.auditStatus === 'vulnerable') {
    return new vscode.ThemeIcon('warning', new vscode.ThemeColor('testing.iconFailed'));
  }
  if (dependency.deprecated) {
    return new vscode.ThemeIcon('warning', new vscode.ThemeColor('testing.iconQueued'));
  }
  return new vscode.ThemeIcon(dependency.type === 'dependencies' ? 'package' : 'tools');
}

function resolveVersionInfo(registry, requestedRange) {
  const versions = registry.versions || {};
  const requestedVersion = String(requestedRange || '').replace(/^[~^<>=\s]+/, '').trim();

  if (requestedVersion && versions[requestedVersion]) {
    return { version: requestedVersion, manifest: versions[requestedVersion] };
  }

  if (registry.latestVersion && versions[registry.latestVersion]) {
    return { version: registry.latestVersion, manifest: versions[registry.latestVersion] };
  }

  const fallbackVersion = Object.keys(versions).at(-1);
  return {
    version: fallbackVersion || '',
    manifest: fallbackVersion ? versions[fallbackVersion] : {}
  };
}

function normalizeRepository(repository) {
  if (!repository) {
    return '';
  }
  if (typeof repository === 'string') {
    return repository;
  }
  return repository.url || '';
}

function getGitHubReadmeCandidates(packageName, registry) {
  const github = getGitHubRepoInfo(registry.homepage) || getGitHubRepoInfo(registry.repository);
  if (!github) {
    return [];
  }

  const unscopedName = packageName.split('/').at(-1);
  const packagePath = packageName.replace(/^@/, '');
  const paths = [
    github.path,
    '',
    `packages/${unscopedName}`,
    `packages/${packagePath}`,
    unscopedName,
    packagePath
  ].filter((value, index, list) => value !== undefined && list.indexOf(value) === index);

  const refs = [github.ref, 'main', 'master'].filter((value, index, list) => value && list.indexOf(value) === index);
  return refs.flatMap((ref) =>
    paths.flatMap((readmePath) => {
      const prefix = readmePath ? `${readmePath.replace(/\/$/, '')}/` : '';
      return [
        `https://raw.githubusercontent.com/${github.owner}/${github.repo}/${ref}/${prefix}README.md`,
        `https://raw.githubusercontent.com/${github.owner}/${github.repo}/${ref}/${prefix}readme.md`
      ];
    })
  );
}

function getGitHubRepoInfo(value) {
  if (!value) {
    return null;
  }

  const normalized = String(value)
    .replace(/^git\+/, '')
    .replace(/^git:\/\//, 'https://')
    .replace(/\.git(#.*)?$/, '$1');

  const match = normalized.match(/^https:\/\/github\.com\/([^/]+)\/([^/#]+)(?:\/(?:tree|blob)\/([^/#]+)(?:\/([^#]+))?)?(?:#.*)?$/i);
  if (!match) {
    return null;
  }

  return {
    owner: match[1],
    repo: match[2].replace(/\.git$/, ''),
    ref: match[3] || 'main',
    path: match[4] || ''
  };
}

async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      try {
        results[index] = await mapper(items[index], index);
      } catch (error) {
        results[index] = {
          ...items[index],
          latestVersion: '',
          resolvedPublishedAt: '',
          latestPublishedAt: '',
          description: getErrorMessage(error),
          npmUrl: `https://www.npmjs.com/package/${items[index].name}`,
          status: 'unknown'
        };
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function getErrorMessage(error) {
  return error && error.message ? error.message : String(error);
}

function getNonce() {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i += 1) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

module.exports = { activate, deactivate };
