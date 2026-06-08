const vscode = require('vscode');
const path = require('path');
const MarkdownIt = require('markdown-it');

const VIEW_ID = 'workspaceNpmSidebar.dependenciesView';
const PANEL_TYPE = 'workspaceNpmSidebar.dashboard';
const REGISTRY_BASE_URL = 'https://registry.npmjs.org';
const AUDIT_BULK_URL = `${REGISTRY_BASE_URL}/-/npm/v1/security/advisories/bulk`;
const DOWNLOADS_API_BASE_URL = 'https://api.npmjs.org/downloads/point/last-week';
const markdown = new MarkdownIt({
  html: true,
  linkify: true,
  typographer: false
});

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
    model.onDidChange((reason) => {
      tree.refresh();
      if (reason !== 'search' && reason !== 'detailRefresh') {
        panel.update();
      }
    }),
    vscode.commands.registerCommand('workspaceNpmSidebar.show', () => panel.show()),
    vscode.commands.registerCommand('workspaceNpmSidebar.refresh', async () => {
      await model.refreshFromNetwork();
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

async function openExternalUrl(value) {
  const url = String(value || '').trim();
  if (!/^(https?:|mailto:)/i.test(url)) {
    throw new Error('Only external http, https, and mailto links can be opened.');
  }

  await vscode.env.openExternal(vscode.Uri.parse(url));
}

class NpmWorkspaceModel {
  constructor() {
    this.packageFiles = [];
    this.selectedPackageJson = undefined;
    this.filter = 'all';
    this.riskFilter = 'all';
    this.updateFilter = 'all';
    this.searchQuery = '';
    this.dependencies = [];
    this.allDependencies = [];
    this.dependencyCounts = {
      dependencies: 0,
      devDependencies: 0
    };
    this.message = '';
    this.lockInfo = createMissingLockInfo('');
    this.registryCache = new Map();
    this.dependencyCache = new Map();
    this.auditCache = new Map();
    this.readmeFallbackCache = new Map();
    this.downloadCache = new Map();
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
      this.allDependencies = [];
      this.message = 'No package.json files found in this workspace.';
      this.emit();
      return;
    }

    if (!this.selectedPackageJson || !this.packageFiles.some((file) => file.path === this.selectedPackageJson)) {
      this.selectedPackageJson = this.packageFiles[0].path;
    }

    await this.loadDependencies();
  }

  async refreshFromNetwork() {
    this.clearCaches();
    await this.refresh();
  }

  clearCaches() {
    this.registryCache.clear();
    this.dependencyCache.clear();
    this.auditCache.clear();
    this.readmeFallbackCache.clear();
    this.downloadCache.clear();
  }

  clearPackageCaches(name) {
    this.registryCache.delete(name);
    this.readmeFallbackCache.delete(name);
    this.downloadCache.delete(name);
    this.auditCache.clear();
    [...this.dependencyCache.keys()].forEach((key) => {
      if (key.startsWith(`${name}@`)) {
        this.dependencyCache.delete(key);
      }
    });
  }

  async refreshPackage(name) {
    this.clearPackageCaches(name);
    const index = this.allDependencies.findIndex((dependency) => dependency.name === name);
    if (index === -1) {
      this.applyDependencyView(false);
      this.emit('detailRefresh');
      return undefined;
    }

    const current = this.allDependencies[index];
    const refreshed = await this.enrichDependency(
      {
        name: current.name,
        currentVersion: current.currentVersion,
        type: current.type
      },
      this.lockInfo.packages.get(name)
    );
    await this.attachAuditInfo([refreshed]);
    this.allDependencies[index] = refreshed;
    this.applyDependencyView(false);
    this.emit('detailRefresh');
    return refreshed;
  }

  async selectPackageJson(path) {
    this.selectedPackageJson = path;
    await this.loadDependencies();
  }

  async setFilter(filter) {
    this.filter = filter || 'all';
    this.applyDependencyView();
  }

  async setSearchQuery(query) {
    this.searchQuery = String(query || '');
    this.applyDependencyView(true, 'search');
  }

  async setRiskFilter(filter) {
    this.riskFilter = filter || 'all';
    this.applyDependencyView(true, 'risk');
  }

  async setUpdateFilter(filter) {
    this.updateFilter = filter || 'all';
    this.applyDependencyView(true, 'update');
  }

  async loadDependencies() {
    if (!this.selectedPackageJson) {
      await this.refresh();
      return;
    }

    this.message = 'Loading dependencies...';
    this.emit();

    const packageJson = await readPackageJson(this.selectedPackageJson);
    this.lockInfo = await readPackageLock(this.selectedPackageJson);
    this.dependencyCounts = getDependencyCounts(packageJson);
    const entries = collectDependencyEntries(packageJson, 'all');

    this.allDependencies = await mapWithConcurrency(entries, 8, async (entry) => {
      return this.enrichDependency(entry, this.lockInfo.packages.get(entry.name));
    });

    await this.attachAuditInfo(this.allDependencies);

    this.message = '';
    this.applyDependencyView(false);
    this.emit();
  }

  applyDependencyView(emit = true, reason = 'state') {
    this.dependencies = filterDependencyEntries(
      filterDependencyUpdate(filterDependencyRisk(filterDependencyType(this.allDependencies, this.filter), this.riskFilter), this.updateFilter),
      this.searchQuery
    );

    if (emit) {
      this.emit(reason);
    }
  }

  async enrichDependency(entry, lockPackage) {
    const registry = await this.getRegistryPackage(entry.name);
    const resolvedVersion = lockPackage && lockPackage.version ? lockPackage.version : '';
    const versionInfo = resolveVersionInfo(registry, resolvedVersion || entry.currentVersion);
    const updateInfo = getUpdateInfo(resolvedVersion || versionInfo.version || entry.currentVersion, registry.latestVersion);

    return {
      ...entry,
      resolvedVersion: resolvedVersion || versionInfo.version || '',
      latestVersion: registry.latestVersion,
      resolvedPublishedAt: getPublishedAt(registry.time, resolvedVersion || versionInfo.version),
      latestPublishedAt: getPublishedAt(registry.time, registry.latestVersion),
      lockStatus: lockPackage && lockPackage.version ? 'locked' : 'unlocked',
      lockPath: lockPackage && lockPackage.path ? lockPackage.path : '',
      lockResolved: lockPackage && lockPackage.resolved ? lockPackage.resolved : '',
      lockIntegrity: lockPackage && lockPackage.integrity ? lockPackage.integrity : '',
      lockDev: Boolean(lockPackage && lockPackage.dev),
      lockOptional: Boolean(lockPackage && lockPackage.optional),
      lockPeer: Boolean(lockPackage && lockPackage.peer),
      description: registry.description,
      npmUrl: `https://www.npmjs.com/package/${entry.name}`,
      status: getVersionStatus(entry.currentVersion, registry.latestVersion),
      updateType: updateInfo.type,
      updateLabel: updateInfo.label,
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
    const fallbackReadme = registry.readme ? '' : await this.getFallbackReadme(name, registry);
    const weeklyDownloads = await this.getWeeklyDownloads(name);
    const readme = registry.readme || fallbackReadme || 'This package does not publish README content to the npm registry.';
    const resolvedVersion = dependency && dependency.resolvedVersion ? dependency.resolvedVersion : versionInfo.version;
    const updateInfo = getUpdateInfo(resolvedVersion, registry.latestVersion);
    const lockPackage = dependency && dependency.lockStatus ? dependency : this.lockInfo.packages.get(name);

    return {
      name,
      description: registry.description,
      currentVersion: dependency && dependency.currentVersion ? dependency.currentVersion : '',
      latestVersion: registry.latestVersion,
      resolvedVersion,
      resolvedPublishedAt: getPublishedAt(registry.time, resolvedVersion),
      latestPublishedAt: getPublishedAt(registry.time, registry.latestVersion),
      updateType: updateInfo.type,
      updateLabel: updateInfo.label,
      dependencyPath: dependency && dependency.dependencyPath ? dependency.dependencyPath : '',
      dependencyDepth: dependency && Number.isFinite(dependency.dependencyDepth) ? dependency.dependencyDepth : 0,
      parentName: dependency && dependency.parentName ? dependency.parentName : '',
      parentVersion: dependency && dependency.parentVersion ? dependency.parentVersion : '',
      parentRange: dependency && dependency.parentRange ? dependency.parentRange : '',
      resolvedFromVersion: dependency && dependency.resolvedFromVersion ? dependency.resolvedFromVersion : '',
      lockStatus: lockPackage && lockPackage.lockStatus ? lockPackage.lockStatus : (lockPackage && lockPackage.version ? 'locked' : 'unlocked'),
      lockPath: lockPackage && lockPackage.lockPath ? lockPackage.lockPath : (lockPackage && lockPackage.path ? lockPackage.path : ''),
      lockResolved: lockPackage && lockPackage.lockResolved ? lockPackage.lockResolved : (lockPackage && lockPackage.resolved ? lockPackage.resolved : ''),
      lockIntegrity: lockPackage && lockPackage.lockIntegrity ? lockPackage.lockIntegrity : (lockPackage && lockPackage.integrity ? lockPackage.integrity : ''),
      lockDev: Boolean(lockPackage && (lockPackage.lockDev || lockPackage.dev)),
      lockOptional: Boolean(lockPackage && (lockPackage.lockOptional || lockPackage.optional)),
      lockPeer: Boolean(lockPackage && (lockPackage.lockPeer || lockPackage.peer)),
      lockInfo: {
        exists: this.lockInfo.exists,
        path: this.lockInfo.path,
        label: this.lockInfo.path ? vscode.workspace.asRelativePath(this.lockInfo.path, false) : '',
        lockfileVersion: this.lockInfo.lockfileVersion,
        packageCount: this.lockInfo.packageCount,
        error: this.lockInfo.error
      },
      npmUrl: `https://www.npmjs.com/package/${name}`,
      homepage: registry.homepage,
      repository: registry.repository,
      license: registry.license,
      author: registry.author,
      publisher: registry.publisher,
      maintainers: registry.maintainers,
      keywords: registry.keywords,
      distTags: registry.distTags,
      createdAt: registry.createdAt,
      modifiedAt: registry.modifiedAt,
      versionCount: registry.versionCount,
      deprecated: Boolean(versionInfo.manifest && versionInfo.manifest.deprecated),
      deprecatedMessage: versionInfo.manifest && versionInfo.manifest.deprecated ? versionInfo.manifest.deprecated : '',
      vulnerabilities,
      auditStatus: dependency && dependency.auditStatus ? dependency.auditStatus : (dependency && dependency.resolvedVersion ? 'ok' : 'unknown'),
      auditError: dependency && dependency.auditError ? dependency.auditError : '',
      maxSeverity: dependency && dependency.maxSeverity ? dependency.maxSeverity : getMaxSeverity(vulnerabilities),
      weeklyDownloads,
      cacheStats: this.getCacheStats(),
      readme,
      readmeHtml: renderReadmeHtml(readme)
    };
  }

  async getWeeklyDownloads(name) {
    if (this.downloadCache.has(name)) {
      return this.downloadCache.get(name);
    }

    try {
      const response = await fetch(`${DOWNLOADS_API_BASE_URL}/${encodeURIComponent(name)}`, {
        headers: { accept: 'application/json' }
      });
      if (!response.ok) {
        throw new Error(`npm downloads returned ${response.status}`);
      }

      const data = await response.json();
      const downloads = Number.isFinite(data.downloads) ? data.downloads : null;
      this.downloadCache.set(name, downloads);
      return downloads;
    } catch (error) {
      this.downloadCache.set(name, null);
      return null;
    }
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
    return this.allDependencies.find((dependency) => dependency.name === name);
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
        parentName: dependency.name,
        parentVersion: dependency.resolvedVersion || versionInfo.version,
        parentRange: dependency.currentVersion,
        resolvedFromVersion: versionInfo.version
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    const result = await mapWithConcurrency(entries, 8, async (entry) => {
      return this.enrichDependency(entry, this.findLockPackageForChild(dependency, entry.name));
    });

    await this.attachAuditInfo(result);

    this.dependencyCache.set(cacheKey, result);
    return result;
  }

  findLockPackageForChild(parentDependency, childName) {
    const parentLockPath = parentDependency && parentDependency.lockPath ? parentDependency.lockPath : '';
    if (parentLockPath) {
      const childPath = `${parentLockPath}/node_modules/${childName}`;
      const byPath = this.lockInfo.paths.get(childPath);
      if (byPath) {
        return byPath;
      }
    }

    return this.lockInfo.packages.get(childName);
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
      distTags: data['dist-tags'] || {},
      time: data.time || {},
      versions: data.versions || {},
      readme: data.readme || '',
      homepage: data.homepage || '',
      repository: normalizeRepository(data.repository),
      license: data.license || '',
      author: normalizePerson(data.author),
      publisher: normalizePerson(data._npmUser),
      maintainers: Array.isArray(data.maintainers) ? data.maintainers.map(normalizePerson).filter(Boolean) : [],
      keywords: Array.isArray(data.keywords) ? data.keywords.filter(Boolean) : [],
      createdAt: data.time && data.time.created ? data.time.created : '',
      modifiedAt: data.time && data.time.modified ? data.time.modified : '',
      versionCount: data.versions ? Object.keys(data.versions).length : 0
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
      riskFilter: this.riskFilter,
      updateFilter: this.updateFilter,
      searchQuery: this.searchQuery,
      dependencyCounts: this.dependencyCounts,
      cacheStats: this.getCacheStats(),
      lockInfo: {
        exists: this.lockInfo.exists,
        path: this.lockInfo.path,
        label: this.lockInfo.path ? vscode.workspace.asRelativePath(this.lockInfo.path, false) : '',
        lockfileVersion: this.lockInfo.lockfileVersion,
        packageCount: this.lockInfo.packageCount,
        error: this.lockInfo.error
      },
      dependencies: filterDependencyType(this.allDependencies, this.filter),
      message: this.message
    };
  }

  emit(reason = 'state') {
    this.emitter.fire(reason);
  }

  getCacheStats() {
    return {
      registry: this.registryCache.size,
      dependencies: this.dependencyCache.size,
      audit: this.auditCache.size,
      readme: this.readmeFallbackCache.size,
      downloads: this.downloadCache.size
    };
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
        return [new MessageTreeItem(`Circular dependency: ${[...item.ancestry, item.dependency.name].join(' > ')}`)];
      }

      try {
        const dependencies = filterDependencyEntries(
          await this.model.getPackageDependencies(item.dependency, item.ancestry),
          this.model.searchQuery
        );
        if (!dependencies.length) {
          return [new MessageTreeItem(`No dependencies for ${item.dependency.name}@${item.dependency.resolvedVersion || item.dependency.currentVersion || 'latest'}`)];
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
      return [new MessageTreeItem(this.model.searchQuery ? 'No packages match search' : 'No dependencies found')];
    }

    return this.model.dependencies.map((dependency) => new DependencyTreeItem(dependency, []));
  }
}

class DependencyTreeItem extends vscode.TreeItem {
  constructor(dependency, ancestry) {
    super(dependency.name, vscode.TreeItemCollapsibleState.Collapsed);
    this.dependency = {
      ...dependency,
      dependencyPath: [...ancestry, dependency.name].join(' > '),
      dependencyDepth: ancestry.length
    };
    this.ancestry = ancestry;
    this.description = getTreeDescription(this.dependency, ancestry);
    this.tooltip = getTreeTooltip(this.dependency, ancestry);
    this.contextValue = ancestry.length ? 'transitiveDependency' : 'dependency';
    this.command = {
      command: 'workspaceNpmSidebar.openPackage',
      title: 'Open Package',
      arguments: [this.dependency]
    };
    this.iconPath = getDependencyIcon(this.dependency);
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
          case 'setSearchQuery':
            await this.model.setSearchQuery(message.query);
            break;
          case 'setRiskFilter':
            await this.model.setRiskFilter(message.filter);
            break;
          case 'setUpdateFilter':
            await this.model.setUpdateFilter(message.filter);
            break;
          case 'refreshAll':
            await this.model.refreshFromNetwork();
            break;
          case 'refreshPackage':
            await this.refreshPackage(message.name);
            break;
          case 'openPackage':
            await this.showPackage(message.name);
            break;
          case 'backToList':
            this.update();
            break;
          case 'openExternal':
            await openExternalUrl(message.url);
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

  async refreshPackage(name) {
    this.show();
    this.post({ type: 'loading', message: `Refreshing ${name}...` });
    const dependency = await this.model.refreshPackage(name);
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
      label: vscode.workspace.asRelativePath(uri, false),
      isWorkspaceRootPackageJson: isWorkspaceRootPackageJson(uri)
    }))
    .sort((a, b) => {
      if (a.isWorkspaceRootPackageJson !== b.isWorkspaceRootPackageJson) {
        return a.isWorkspaceRootPackageJson ? -1 : 1;
      }
      return a.label.localeCompare(b.label);
    });
}

function isWorkspaceRootPackageJson(uri) {
  return (vscode.workspace.workspaceFolders || []).some((folder) => {
    return path.dirname(uri.fsPath) === folder.uri.fsPath && path.basename(uri.fsPath) === 'package.json';
  });
}

async function readPackageJson(fsPath) {
  const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(fsPath));
  return JSON.parse(Buffer.from(bytes).toString('utf8'));
}

async function readPackageLock(packageJsonPath) {
  const lockPath = path.join(path.dirname(packageJsonPath), 'package-lock.json');
  const lockInfo = createMissingLockInfo(lockPath);

  try {
    const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(lockPath));
    const lock = JSON.parse(Buffer.from(bytes).toString('utf8'));
    lockInfo.exists = true;
    lockInfo.lockfileVersion = lock.lockfileVersion || '';

    if (lock.packages) {
      Object.entries(lock.packages).forEach(([packagePath, info]) => {
        if (!packagePath.startsWith('node_modules/') || !info || !info.version) {
          return;
        }

        const name = packagePath.split('node_modules/').at(-1);
        setLockPackage(lockInfo.packages, normalizeLockPackage(name, info, packagePath));
      });
      lockInfo.packageCount = lockInfo.packages.size;
      return lockInfo;
    }

    if (lock.dependencies) {
      collectLockDependencyInfo(lock.dependencies, lockInfo.packages);
    }
  } catch (error) {
    lockInfo.error = error && error.code === 'FileNotFound' ? '' : getErrorMessage(error);
    return lockInfo;
  }

  lockInfo.packageCount = lockInfo.packages.size;
  return lockInfo;
}

function createMissingLockInfo(lockPath) {
  const packages = new Map();
  const paths = new Map();
  packages.paths = paths;

  return {
    exists: false,
    path: lockPath,
    lockfileVersion: '',
    packageCount: 0,
    packages,
    paths,
    error: ''
  };
}

function normalizeLockPackage(name, info, packagePath) {
  return {
    name,
    path: packagePath || '',
    version: info.version || '',
    resolved: info.resolved || '',
    integrity: info.integrity || '',
    dev: Boolean(info.dev),
    optional: Boolean(info.optional),
    peer: Boolean(info.peer),
    depth: getLockPackageDepth(packagePath)
  };
}

function getLockPackageDepth(packagePath) {
  return String(packagePath || '').split('node_modules/').length - 1;
}

function collectLockDependencyInfo(dependencies, packages, parentPath = 'node_modules') {
  Object.entries(dependencies || {}).forEach(([name, info]) => {
    if (info && info.version) {
      const packagePath = `${parentPath}/${name}`;
      setLockPackage(packages, normalizeLockPackage(name, info, packagePath));
    }
    if (info && info.dependencies) {
      collectLockDependencyInfo(info.dependencies, packages, `${parentPath}/${name}/node_modules`);
    }
  });
}

function setLockPackage(packages, packageInfo) {
  if (packages.paths) {
    packages.paths.set(packageInfo.path, packageInfo);
  }

  const existing = packages.get(packageInfo.name);
  if (!existing || packageInfo.depth < existing.depth) {
    packages.set(packageInfo.name, packageInfo);
  }
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

function filterDependencyEntries(entries, searchQuery) {
  const query = String(searchQuery || '').trim().toLowerCase();
  if (!query) {
    return entries;
  }

  return entries.filter((entry) => {
    return entry.name.toLowerCase().includes(query) || String(entry.description || '').toLowerCase().includes(query);
  });
}

function filterDependencyType(entries, filter) {
  if (filter === 'all') {
    return entries;
  }
  return entries.filter((entry) => entry.type === filter);
}

function filterDependencyRisk(entries, filter) {
  if (filter === 'all') {
    return entries;
  }

  return entries.filter((entry) => {
    if (filter === 'vulnerable') {
      return entry.auditStatus === 'vulnerable';
    }
    if (filter === 'deprecated') {
      return entry.deprecated;
    }
    if (filter === 'notChecked') {
      return entry.auditStatus === 'unknown';
    }
    if (filter === 'ok') {
      return !entry.deprecated && entry.auditStatus !== 'vulnerable' && entry.auditStatus !== 'unknown';
    }
    return true;
  });
}

function filterDependencyUpdate(entries, filter) {
  if (!filter || filter === 'all') {
    return entries;
  }

  return entries.filter((entry) => {
    if (filter === 'update') {
      return ['major', 'minor', 'patch'].includes(entry.updateType);
    }
    return entry.updateType === filter;
  });
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

function getUpdateInfo(currentRange, latestVersion) {
  const current = parseSemver(currentRange);
  const latest = parseSemver(latestVersion);

  if (!current || !latest) {
    return { type: 'unknown', label: latestVersion ? 'update' : 'unknown' };
  }
  if (current.major === latest.major && current.minor === latest.minor && current.patch === latest.patch) {
    return { type: 'current', label: 'current' };
  }
  if (latest.major > current.major) {
    return { type: 'major', label: 'major' };
  }
  if (latest.major === current.major && latest.minor > current.minor) {
    return { type: 'minor', label: 'minor' };
  }
  if (latest.major === current.major && latest.minor === current.minor && latest.patch > current.patch) {
    return { type: 'patch', label: 'patch' };
  }
  return { type: 'current', label: 'current' };
}

function parseSemver(value) {
  const match = String(value || '').match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) {
    return null;
  }
  return {
    major: Number.parseInt(match[1], 10),
    minor: Number.parseInt(match[2], 10),
    patch: Number.parseInt(match[3], 10)
  };
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

function renderReadmeHtml(readme) {
  return sanitizeReadmeHtml(markdown.render(String(readme || '')));
}

function sanitizeReadmeHtml(html) {
  return String(html || '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[\s\S]*?<\/style>/gi, '')
    .replace(/<(iframe|object|embed|form|input|button|textarea|select|meta|link)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<(iframe|object|embed|form|input|button|textarea|select|meta|link)\b[^>]*>/gi, '')
    .replace(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\s+(href|src|srcset)\s*=\s*(['"])\s*javascript:[\s\S]*?\2/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');
}

function getMaxSeverity(vulnerabilities) {
  const order = ['info', 'low', 'moderate', 'high', 'critical'];
  return (vulnerabilities || []).reduce((max, vulnerability) => {
    const severity = vulnerability.severity || 'unknown';
    return order.indexOf(severity) > order.indexOf(max) ? severity : max;
  }, 'info');
}

function getTreeDescription(dependency, ancestry = []) {
  const flags = [];
  if (dependency.updateType && dependency.updateType !== 'current' && dependency.updateType !== 'unknown') {
    flags.push(dependency.updateType);
  }
  if (dependency.lockStatus === 'unlocked') {
    flags.push('unlocked');
  }
  if (dependency.deprecated) {
    flags.push('deprecated');
  }
  if (dependency.auditStatus === 'vulnerable') {
    flags.push(dependency.maxSeverity || 'vulnerable');
  }

  const versionText = getTreeVersionText(dependency);
  const parentText = dependency.parentName ? `via ${dependency.parentName}@${dependency.parentVersion || dependency.resolvedFromVersion || 'unknown'}` : '';
  const depthText = ancestry.length ? `depth ${ancestry.length}` : 'direct';
  return [versionText, parentText || depthText, flags.join(', ')].filter(Boolean).join('  ');
}

function getTreeTooltip(dependency, ancestry = []) {
  const dependencyPath = [...ancestry, dependency.name];
  const lines = [
    dependency.name,
    `Type: ${ancestry.length ? 'transitive dependency' : 'direct dependency'}`,
    `Path: ${dependencyPath.join(' > ')}`,
    `Depth: ${ancestry.length}`,
    `Required: ${dependency.currentVersion}`,
    `Resolved: ${dependency.resolvedVersion || '-'}`,
    `Latest: ${dependency.latestVersion || '-'}`,
    `Update: ${dependency.updateLabel || '-'}`,
    `Lock: ${dependency.lockStatus || 'unknown'}`
  ];

  if (dependency.parentName) {
    lines.push(`Required by: ${dependency.parentName}@${dependency.parentVersion || '-'}`);
  }
  if (dependency.resolvedFromVersion) {
    lines.push(`Parent manifest version: ${dependency.resolvedFromVersion}`);
  }

  if (dependency.lockPath) {
    lines.push(`Lock path: ${dependency.lockPath}`);
  }
  if (dependency.lockResolved) {
    lines.push(`Tarball: ${dependency.lockResolved}`);
  }

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

function getTreeVersionText(dependency) {
  if (dependency.currentVersion && dependency.resolvedVersion && dependency.resolvedVersion !== normalizeVersionRange(dependency.currentVersion)) {
    return `${dependency.currentVersion} -> ${dependency.resolvedVersion}`;
  }
  return dependency.currentVersion || dependency.resolvedVersion || '-';
}

function normalizeVersionRange(value) {
  return String(value || '').replace(/^[~^<>=\s]+/, '').trim();
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

function normalizePerson(person) {
  if (!person) {
    return '';
  }
  if (typeof person === 'string') {
    return person;
  }

  const name = person.name || person.username || person.email || '';
  const email = person.email && person.email !== name ? ` <${person.email}>` : '';
  return `${name}${email}`.trim();
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
