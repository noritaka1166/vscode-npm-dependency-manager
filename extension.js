const vscode = require('vscode');
const { randomBytes } = require('node:crypto');
const path = require('node:path');
const MarkdownIt = require('markdown-it');
const { SecurityService } = require('./lib/security');
const { normalizeRepositoryUrl } = require('./lib/repository');
const { PACKAGE_MANAGERS, createPackageInstallCommand, detectPackageManager } = require('./lib/package-manager');

const VIEW_ID = 'workspaceNpmSidebar.dependenciesView';
const PANEL_TYPE = 'workspaceNpmSidebar.dashboard';
const FILTER_STATE_KEY = 'workspaceNpmSidebar.filters';
const VISIBLE_COLUMNS_STATE_KEY = 'workspaceNpmSidebar.visibleColumns';
const COLUMN_WIDTHS_STATE_KEY = 'workspaceNpmSidebar.columnWidths';
const REGISTRY_BASE_URL = 'https://registry.npmjs.org';
const DOWNLOADS_API_BASE_URL = 'https://api.npmjs.org/downloads/point/last-week';
const markdown = new MarkdownIt({
  html: true,
  linkify: true,
  typographer: false
});

function activate(context) {
  const model = new NpmWorkspaceModel(context);
  const panel = new DashboardPanel(context, model);
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
      if (dependency?.name) {
        await panel.showPackage(dependency.name, dependency);
      }
    })
  );

  model.refresh().catch((error) => vscode.window.showErrorMessage(getErrorMessage(error)));
}

function deactivate() {
  // The extension does not hold resources that need explicit disposal.
}

async function openExternalUrl(value) {
  const url = String(value || '').trim();
  if (!/^(https?:|mailto:)/i.test(url)) {
    throw new Error('Only external http, https, and mailto links can be opened.');
  }

  await vscode.env.openExternal(vscode.Uri.parse(url));
}

class NpmWorkspaceModel {
  constructor(context) {
    this.context = context;
    const filters = normalizeFilterState(context?.workspaceState.get(FILTER_STATE_KEY));
    this.packageFiles = [];
    this.selectedPackageJson = undefined;
    this.filter = filters.filter;
    this.riskFilter = filters.riskFilter;
    this.updateFilter = filters.updateFilter;
    this.licenseFilter = filters.licenseFilter;
    this.searchQuery = filters.searchQuery;
    this.dependencies = [];
    this.allDependencies = [];
    this.dependencyCounts = {
      dependencies: 0,
      devDependencies: 0
    };
    this.isLoading = false;
    this.message = '';
    this.lockInfo = createMissingLockInfo('');
    this.packageManager = this.lockInfo.packageManager;
    this.registryCache = new Map();
    this.dependencyCache = new Map();
    this.security = new SecurityService();
    this.readmeFallbackCache = new Map();
    this.downloadCache = new Map();
    this.emitter = new vscode.EventEmitter();
    this.onDidChange = this.emitter.event;
  }

  async refresh() {
    this.isLoading = true;
    this.message = 'Finding package.json files...';
    this.emit();

    this.packageFiles = await findPackageJsonFiles();

    if (!this.packageFiles.length) {
      this.selectedPackageJson = undefined;
      this.dependencies = [];
      this.allDependencies = [];
      this.isLoading = false;
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
    this.security.clear();
    this.readmeFallbackCache.clear();
    this.downloadCache.clear();
  }

  clearPackageCaches(name) {
    this.registryCache.delete(name);
    this.readmeFallbackCache.delete(name);
    this.downloadCache.delete(name);
    this.security.clearPackage(name);
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
    this.filter = normalizeDependencyFilter(filter);
    await this.saveFilterState();
    this.applyDependencyView();
  }

  async setSearchQuery(query) {
    this.searchQuery = String(query || '');
    await this.saveFilterState();
    this.applyDependencyView(true, 'search');
  }

  async setRiskFilter(filter) {
    this.riskFilter = normalizeRiskFilter(filter);
    await this.saveFilterState();
    this.applyDependencyView(true, 'risk');
  }

  async setUpdateFilter(filter) {
    this.updateFilter = normalizeUpdateFilter(filter);
    await this.saveFilterState();
    this.applyDependencyView(true, 'update');
  }

  async setLicenseFilter(filter) {
    this.licenseFilter = normalizeLicenseFilter(filter);
    await this.saveFilterState();
    this.applyDependencyView(true, 'license');
  }

  async saveFilterState() {
    if (!this.context) {
      return;
    }

    await this.context.workspaceState.update(FILTER_STATE_KEY, {
      filter: this.filter,
      riskFilter: this.riskFilter,
      updateFilter: this.updateFilter,
      licenseFilter: this.licenseFilter,
      searchQuery: this.searchQuery
    });
  }

  async loadDependencies() {
    if (!this.selectedPackageJson) {
      await this.refresh();
      return;
    }

    this.isLoading = true;
    this.message = 'Loading dependencies...';
    this.emit();

    const packageJson = await readPackageJson(this.selectedPackageJson);
    this.lockInfo = await readLockInfo(this.selectedPackageJson, packageJson);
    this.packageManager = this.lockInfo.packageManager;
    this.dependencyCounts = getDependencyCounts(packageJson);
    const entries = collectDependencyEntries(packageJson, 'all');

    this.allDependencies = await mapWithConcurrency(entries, 8, async (entry) => {
      return this.enrichDependency(entry, this.lockInfo.packages.get(entry.name));
    });

    await this.attachAuditInfo(this.allDependencies);

    this.isLoading = false;
    this.message = '';
    this.applyDependencyView(false);
    this.emit();
  }

  applyDependencyView(emit = true, reason = 'state') {
    this.dependencies = filterDependencyEntries(
      filterDependencyLicense(filterDependencyUpdate(filterDependencyRisk(filterDependencyType(this.allDependencies, this.filter), this.riskFilter), this.updateFilter), this.licenseFilter),
      this.searchQuery
    );

    if (emit) {
      this.emit(reason);
    }
  }

  async enrichDependency(entry, lockPackage) {
    const registry = await this.getRegistryPackage(entry.name);
    const resolvedVersion = lockPackage?.version ? lockPackage.version : '';
    const versionInfo = resolveVersionInfo(registry, resolvedVersion || entry.currentVersion);
    const updateInfo = getUpdateInfo(resolvedVersion || versionInfo.version || entry.currentVersion, registry.latestVersion);

    return {
      ...entry,
      resolvedVersion: resolvedVersion || versionInfo.version || '',
      latestVersion: registry.latestVersion,
      resolvedPublishedAt: getPublishedAt(registry.time, resolvedVersion || versionInfo.version),
      latestPublishedAt: getPublishedAt(registry.time, registry.latestVersion),
      lockStatus: getDependencyLockStatus(lockPackage, this.lockInfo),
      lockPath: lockPackage?.path ? lockPackage.path : '',
      lockResolved: lockPackage?.resolved ? lockPackage.resolved : '',
      lockIntegrity: lockPackage?.integrity ? lockPackage.integrity : '',
      lockDev: Boolean(lockPackage?.dev),
      lockOptional: Boolean(lockPackage?.optional),
      lockPeer: Boolean(lockPackage?.peer),
      description: registry.description,
      license: normalizeLicenseValue(versionInfo.manifest?.license ? versionInfo.manifest.license : registry.license),
      npmUrl: `https://www.npmjs.com/package/${entry.name}`,
      status: getVersionStatus(entry.currentVersion, registry.latestVersion),
      updateType: updateInfo.type,
      updateLabel: updateInfo.label,
      deprecated: Boolean(versionInfo.manifest?.deprecated),
      deprecatedMessage: versionInfo.manifest?.deprecated ? versionInfo.manifest.deprecated : ''
    };
  }

  async attachAuditInfo(dependencies) {
    await this.security.enrichDependencies(dependencies, this.lockInfo);
  }

  async getDetail(name, dependencyHint) {
    const dependency = dependencyHint || this.findKnownDependency(name);
    const lockPackage = dependency?.lockStatus ? dependency : this.lockInfo.packages.get(name);
    const initialResolvedVersion = dependency?.resolvedVersion ? dependency.resolvedVersion : '';
    const registryPromise = this.getRegistryPackage(name);
    const weeklyDownloadsPromise = this.getWeeklyDownloads(name);
    const earlySecurityPromise = initialResolvedVersion
      ? this.security.getPackageSecurity({
        name,
        resolvedVersion: initialResolvedVersion,
        dependency,
        lockPackage,
        lockInfo: this.lockInfo
      })
      : null;

    const registry = await registryPromise;
    const versionInfo = resolveVersionInfo(registry, dependency && (dependency.resolvedVersion || dependency.currentVersion));
    const useRegistryReadme = isUsefulReadme(registry.readme);
    const resolvedVersion = initialResolvedVersion || versionInfo.version;
    const updateInfo = getUpdateInfo(resolvedVersion, registry.latestVersion);
    const securityPromise = earlySecurityPromise || this.security.getPackageSecurity({
      name,
      resolvedVersion,
      dependency,
      lockPackage,
      lockInfo: this.lockInfo
    });
    const [fallbackReadme, weeklyDownloads, security] = await Promise.all([
      useRegistryReadme ? Promise.resolve('') : this.getFallbackReadme(name, registry),
      weeklyDownloadsPromise,
      securityPromise
    ]);
    const readme = useRegistryReadme ? registry.readme : (fallbackReadme || 'This package does not publish README content to the npm registry.');

    return {
      name,
      description: registry.description,
      type: dependency?.type ? dependency.type : '',
      currentVersion: dependency?.currentVersion ? dependency.currentVersion : '',
      latestVersion: registry.latestVersion,
      resolvedVersion,
      resolvedPublishedAt: getPublishedAt(registry.time, resolvedVersion),
      latestPublishedAt: getPublishedAt(registry.time, registry.latestVersion),
      updateType: updateInfo.type,
      updateLabel: updateInfo.label,
      dependencyPath: dependency?.dependencyPath ? dependency.dependencyPath : '',
      dependencyDepth: dependency && Number.isFinite(dependency.dependencyDepth) ? dependency.dependencyDepth : 0,
      parentName: dependency?.parentName ? dependency.parentName : '',
      parentVersion: dependency?.parentVersion ? dependency.parentVersion : '',
      parentRange: dependency?.parentRange ? dependency.parentRange : '',
      resolvedFromVersion: dependency?.resolvedFromVersion ? dependency.resolvedFromVersion : '',
      lockStatus: lockPackage?.lockStatus ? lockPackage.lockStatus : getDependencyLockStatus(lockPackage, this.lockInfo),
      lockPath: lockPackage?.lockPath ? lockPackage.lockPath : (lockPackage?.path ? lockPackage.path : ''),
      lockResolved: lockPackage?.lockResolved ? lockPackage.lockResolved : (lockPackage?.resolved ? lockPackage.resolved : ''),
      lockIntegrity: lockPackage?.lockIntegrity ? lockPackage.lockIntegrity : (lockPackage?.integrity ? lockPackage.integrity : ''),
      lockDev: Boolean(lockPackage && (lockPackage.lockDev || lockPackage.dev)),
      lockOptional: Boolean(lockPackage && (lockPackage.lockOptional || lockPackage.optional)),
      lockPeer: Boolean(lockPackage && (lockPackage.lockPeer || lockPackage.peer)),
      lockInfo: {
        exists: this.lockInfo.exists,
        path: this.lockInfo.path,
        label: this.lockInfo.path ? vscode.workspace.asRelativePath(this.lockInfo.path, false) : '',
        lockfileVersion: this.lockInfo.lockfileVersion,
        packageCount: this.lockInfo.packageCount,
        error: this.lockInfo.error,
        packageManager: this.packageManager
      },
      packageManager: this.packageManager,
      installCommand: createPackageInstallCommand(this.packageManager, name, dependency?.type || 'dependencies'),
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
      deprecated: Boolean(versionInfo.manifest?.deprecated),
      deprecatedMessage: versionInfo.manifest?.deprecated ? versionInfo.manifest.deprecated : '',
      ...security,
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
        if (isUsefulReadme(text)) {
          const readme = await resolveReadmeAssetUrls(text, url);
          this.readmeFallbackCache.set(name, readme);
          return readme;
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
    const dependencies = versionInfo.manifest?.dependencies ? versionInfo.manifest.dependencies : {};
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
    const parentLockPath = parentDependency?.lockPath ? parentDependency.lockPath : '';
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
      latestVersion: data['dist-tags']?.latest ? data['dist-tags'].latest : '',
      distTags: data['dist-tags'] || {},
      time: data.time || {},
      versions: data.versions || {},
      readme: data.readme || '',
      readmeFilename: data.readmeFilename || '',
      homepage: data.homepage || '',
      repository: normalizeRepositoryUrl(data.repository),
      license: data.license || '',
      author: normalizePerson(data.author),
      publisher: normalizePerson(data._npmUser),
      maintainers: Array.isArray(data.maintainers) ? data.maintainers.map(normalizePerson).filter(Boolean) : [],
      keywords: Array.isArray(data.keywords) ? data.keywords.filter(Boolean) : [],
      createdAt: data.time?.created ? data.time.created : '',
      modifiedAt: data.time?.modified ? data.time.modified : '',
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
      licenseFilter: this.licenseFilter,
      licenseOptions: getLicenseOptions(filterDependencyType(this.allDependencies, this.filter)),
      searchQuery: this.searchQuery,
      dependencyCounts: this.dependencyCounts,
      isLoading: this.isLoading,
      cacheStats: this.getCacheStats(),
      packageManager: this.packageManager,
      lockInfo: {
        exists: this.lockInfo.exists,
        path: this.lockInfo.path,
        label: this.lockInfo.path ? vscode.workspace.asRelativePath(this.lockInfo.path, false) : '',
        lockfileVersion: this.lockInfo.lockfileVersion,
        packageCount: this.lockInfo.packageCount,
        error: this.lockInfo.error,
        packageManager: this.packageManager
      },
      dependencies: filterDependencyType(this.allDependencies, this.filter),
      message: this.message
    };
  }

  createUpdateCommand(message) {
    const name = String(message?.name ? message.name : '').trim();
    const version = String(message?.version ? message.version : '').trim();
    if (!name || !version) {
      throw new Error('Package name and latest version are required to build an update command.');
    }

    if (!this.selectedPackageJson) {
      throw new Error('Select a package.json before running an update.');
    }

    const knownDependency = this.allDependencies.find((dependency) => dependency.name === name);
    if (!knownDependency) {
      throw new Error(`${name} is not a direct dependency in the selected package.json.`);
    }

    const effectiveType = knownDependency.type || 'dependencies';
    const specifier = `${name}@${version}`;
    const command = createPackageInstallCommand(this.packageManager, specifier, effectiveType);

    return {
      name,
      version,
      command,
      cwd: path.dirname(this.selectedPackageJson),
      packageManager: this.packageManager
    };
  }

  emit(reason = 'state') {
    this.emitter.fire(reason);
  }

  getCacheStats() {
    return {
      registry: this.registryCache.size,
      dependencies: this.dependencyCache.size,
      ...this.security.getCacheStats(),
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
    if (item?.dependency) {
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
  constructor(context, model) {
    this.context = context;
    this.extensionUri = context.extensionUri;
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
          case 'setLicenseFilter':
            await this.model.setLicenseFilter(message.filter);
            break;
          case 'setVisibleColumns':
            await this.setVisibleColumns(message.columns);
            break;
          case 'setColumnWidths':
            await this.setColumnWidths(message.widths);
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
          case 'runUpdate':
            await this.runUpdate(message);
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

  async runUpdate(message) {
    const command = this.model.createUpdateCommand(message);
    const selection = await vscode.window.showWarningMessage(
      `Run ${command.command}?`,
      { modal: true, detail: `This will update ${command.name} in ${command.cwd}.` },
      'Run command',
      'Copy command'
    );

    if (selection === 'Copy command') {
      await vscode.env.clipboard.writeText(command.command);
      vscode.window.showInformationMessage(`Copied: ${command.command}`);
      return;
    }

    if (selection !== 'Run command') {
      return;
    }

    const terminal = vscode.window.createTerminal({
      name: `${command.packageManager.label} dependency update`,
      cwd: command.cwd
    });
    terminal.show();
    terminal.sendText(command.command, true);
  }

  update() {
    this.post({
      ...this.model.getState(),
      visibleColumns: this.getVisibleColumns(),
      columnWidths: this.getColumnWidths()
    });
  }

  async setVisibleColumns(columns) {
    const visibleColumns = Array.isArray(columns) ? columns.filter((column) => typeof column === 'string') : [];
    await this.context.globalState.update(VISIBLE_COLUMNS_STATE_KEY, visibleColumns);
  }

  getVisibleColumns() {
    const columns = this.context.globalState.get(VISIBLE_COLUMNS_STATE_KEY);
    return Array.isArray(columns) ? columns : undefined;
  }

  async setColumnWidths(widths) {
    const normalized = {};
    Object.entries(widths && typeof widths === 'object' ? widths : {}).forEach(([key, value]) => {
      const width = Number(value);
      if (key && Number.isFinite(width)) {
        normalized[key] = width;
      }
    });
    await this.context.globalState.update(COLUMN_WIDTHS_STATE_KEY, normalized);
  }

  getColumnWidths() {
    const widths = this.context.globalState.get(COLUMN_WIDTHS_STATE_KEY);
    return widths && typeof widths === 'object' && !Array.isArray(widths) ? widths : undefined;
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

async function readLockInfo(packageJsonPath, packageJson) {
  const directory = path.dirname(packageJsonPath);
  const lockfiles = await findLockfiles(directory);
  const packageManager = detectPackageManager(packageJson, lockfiles);
  const fallbackLockfile = PACKAGE_MANAGERS[packageManager.id].lockfiles[0];
  const lockPath = path.join(directory, packageManager.lockfile || fallbackLockfile);

  if (packageManager.id !== 'npm') {
    const lockInfo = createMissingLockInfo(lockPath, packageManager);
    lockInfo.exists = packageManager.hasLockfile;
    return lockInfo;
  }

  return readNpmPackageLock(lockPath, packageManager);
}

async function findLockfiles(directory) {
  const lockfiles = [...new Set(Object.values(PACKAGE_MANAGERS).flatMap((manager) => manager.lockfiles))];
  const results = await Promise.all(lockfiles.map(async (lockfile) => {
    try {
      const stat = await vscode.workspace.fs.stat(vscode.Uri.file(path.join(directory, lockfile)));
      return stat.type & vscode.FileType.File ? lockfile : '';
    } catch {
      return '';
    }
  }));

  return results.filter(Boolean);
}

async function readNpmPackageLock(lockPath, packageManager) {
  const lockInfo = createMissingLockInfo(lockPath, packageManager);

  try {
    const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(lockPath));
    const lock = JSON.parse(Buffer.from(bytes).toString('utf8'));
    lockInfo.exists = true;
    lockInfo.lockfileVersion = lock.lockfileVersion || '';

    if (lock.packages) {
      Object.entries(lock.packages).forEach(([packagePath, info]) => {
        if (!packagePath.startsWith('node_modules/') || !info?.version) {
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
    lockInfo.error = error?.code === 'FileNotFound' ? '' : getErrorMessage(error);
    return lockInfo;
  }

  lockInfo.packageCount = lockInfo.packages.size;
  return lockInfo;
}

function createMissingLockInfo(lockPath, packageManager = detectPackageManager({}, [])) {
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
    error: '',
    packageManager
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
    dependencies: info.dependencies || {},
    optionalDependencies: info.optionalDependencies || {},
    depth: getLockPackageDepth(packagePath)
  };
}

function getDependencyLockStatus(lockPackage, lockInfo) {
  if (lockPackage?.version) {
    return 'locked';
  }
  if (lockInfo?.exists && lockInfo.packageManager?.id !== 'npm') {
    return 'notParsed';
  }
  return 'unlocked';
}

function getLockPackageDepth(packagePath) {
  return String(packagePath || '').split('node_modules/').length - 1;
}

function collectLockDependencyInfo(dependencies, packages, parentPath = 'node_modules') {
  Object.entries(dependencies || {}).forEach(([name, info]) => {
    if (info?.version) {
      const packagePath = `${parentPath}/${name}`;
      setLockPackage(packages, normalizeLockPackage(name, info, packagePath));
    }
    if (info?.dependencies) {
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
      return entry.auditStatus === 'vulnerable' || entry.transitiveVulnerabilityCount > 0 || (entry.osvVulnerabilities || []).length || (entry.transitiveOsvVulnerabilities || []).length || (entry.securitySignals?.kev?.length);
    }
    if (filter === 'deprecated') {
      return entry.deprecated;
    }
    if (filter === 'notChecked') {
      return entry.auditStatus === 'unknown';
    }
    if (filter === 'ok') {
      return !entry.deprecated && entry.auditStatus !== 'vulnerable' && entry.auditStatus !== 'unknown' && !entry.transitiveVulnerabilityCount && !(entry.osvVulnerabilities || []).length && !(entry.transitiveOsvVulnerabilities || []).length && !(entry.securitySignals?.kev?.length);
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

function filterDependencyLicense(entries, filter) {
  if (!filter || filter === 'all') {
    return entries;
  }

  return entries.filter((entry) => getLicenseFilterValue(entry.license) === filter);
}

function normalizeFilterState(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    filter: normalizeDependencyFilter(source.filter),
    riskFilter: normalizeRiskFilter(source.riskFilter),
    updateFilter: normalizeUpdateFilter(source.updateFilter),
    licenseFilter: normalizeLicenseFilter(source.licenseFilter),
    searchQuery: String(source.searchQuery || '')
  };
}

function normalizeDependencyFilter(value) {
  return ['all', 'dependencies', 'devDependencies'].includes(value) ? value : 'all';
}

function normalizeRiskFilter(value) {
  return ['all', 'vulnerable', 'deprecated', 'notChecked', 'ok'].includes(value) ? value : 'all';
}

function normalizeUpdateFilter(value) {
  return ['all', 'update', 'major', 'minor', 'patch', 'current'].includes(value) ? value : 'all';
}

function normalizeLicenseFilter(value) {
  const normalized = String(value || 'all').trim();
  return normalized || 'all';
}

function getLicenseOptions(entries) {
  const counts = new Map();
  entries.forEach((entry) => {
    const value = getLicenseFilterValue(entry.license);
    counts.set(value, (counts.get(value) || 0) + 1);
  });

  return [...counts.entries()]
    .map(([value, count]) => ({
      value,
      label: value === '__unknown__' ? 'Unknown' : value,
      count
    }))
    .sort((a, b) => {
      if (a.value === '__unknown__') {
        return 1;
      }
      if (b.value === '__unknown__') {
        return -1;
      }
      return a.label.localeCompare(b.label);
    });
}

function getLicenseFilterValue(license) {
  const value = normalizeLicenseValue(license);
  return value || '__unknown__';
}

function normalizeLicenseValue(license) {
  if (Array.isArray(license)) {
    return license.map(normalizeLicenseValue).filter(Boolean).join(', ');
  }

  if (license && typeof license === 'object') {
    return normalizeLicenseValue(license.type || license.name || '');
  }

  return String(license || '').trim();
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

function renderReadmeHtml(readme) {
  return sanitizeReadmeHtml(markdown.render(String(readme || '')));
}

async function resolveReadmeAssetUrls(readme, readmeUrl) {
  const baseUrl = getReadmeBaseUrl(readmeUrl);
  if (!baseUrl) {
    return readme;
  }
  const assetUrlMap = await getReadmeAssetUrlMap(readme, readmeUrl, baseUrl);

  return String(readme || '')
    .replace(/(!?\[[^\]]*]\()([^)\s]+)(\))/g, (match, prefix, url, suffix) => {
      return `${prefix}${resolveReadmeUrl(url, baseUrl, assetUrlMap)}${suffix}`;
    })
    .replace(/^(\s*\[[^\]]+]:\s*)(\S+)/gm, (match, prefix, url) => {
      return `${prefix}${resolveReadmeUrl(url, baseUrl, assetUrlMap)}`;
    })
    .replace(/\s(src|href)\s*=\s*(['"])([^'"]+)\2/gi, (match, attr, quote, url) => {
      return ` ${attr}=${quote}${resolveReadmeUrl(url, baseUrl, assetUrlMap)}${quote}`;
    })
    .replace(/\ssrcset\s*=\s*(['"])([^'"]+)\1/gi, (match, quote, value) => {
      const resolved = value.split(',').map((part) => {
        const pieces = part.trim().split(/\s+/);
        if (!pieces[0]) {
          return '';
        }
        return [resolveReadmeUrl(pieces[0], baseUrl, assetUrlMap), ...pieces.slice(1)].join(' ');
      }).filter(Boolean).join(', ');
      return ` srcset=${quote}${resolved}${quote}`;
    });
}

async function getReadmeAssetUrlMap(readme, readmeUrl, baseUrl) {
  const rootBaseUrl = getGitHubRawRootBaseUrl(readmeUrl);
  if (!rootBaseUrl || rootBaseUrl === baseUrl) {
    return new Map();
  }

  const urls = getReadmeRelativeAssetUrls(readme);
  const entries = await Promise.all(urls.map(async (url) => {
    const primary = resolveReadmeUrl(url, baseUrl);
    const fallback = resolveReadmeUrl(url, rootBaseUrl);
    if (primary === fallback || await canFetchAsset(primary)) {
      return [url, primary];
    }
    if (await canFetchAsset(fallback)) {
      return [url, fallback];
    }
    return [url, primary];
  }));
  return new Map(entries);
}

function getReadmeRelativeAssetUrls(readme) {
  const urls = new Set();
  const patterns = [
    /!\[[^\]]*]\(([^)\s]+)\)/g,
    /\s(?:src|href)\s*=\s*['"]([^'"]+)['"]/gi,
    /\ssrcset\s*=\s*['"]([^'"]+)['"]/gi
  ];

  patterns.forEach((pattern) => {
    for (const match of String(readme || '').matchAll(pattern)) {
      String(match[1] || '').split(',').forEach((part) => {
        const url = part.trim().split(/\s+/)[0];
        if (isRelativeAssetUrl(url)) {
          urls.add(url);
        }
      });
    }
  });
  return [...urls];
}

function isRelativeAssetUrl(url) {
  return Boolean(url)
    && !url.startsWith('#')
    && !/^(https?:|mailto:|data:)/i.test(url)
    && /\.(svg|png|jpe?g|gif|webp|avif)(?:[?#].*)?$/i.test(url);
}

function getGitHubRawRootBaseUrl(readmeUrl) {
  const match = String(readmeUrl || '').match(/^(https:\/\/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/[^/]+\/)/i);
  return match ? match[1] : '';
}

async function canFetchAsset(url) {
  try {
    const response = await fetch(url, { method: 'HEAD' });
    if (response.ok) {
      return true;
    }
  } catch (error) {
    // Some hosts reject HEAD. Fall through to GET.
  }

  try {
    const response = await fetch(url);
    return response.ok;
  } catch (error) {
    return false;
  }
}

function getReadmeBaseUrl(readmeUrl) {
  try {
    return new URL('.', readmeUrl).href;
  } catch (error) {
    return '';
  }
}

function resolveReadmeUrl(value, baseUrl, assetUrlMap = new Map()) {
  const url = String(value || '').trim();
  if (assetUrlMap.has(url)) {
    return assetUrlMap.get(url);
  }
  if (!url || url.startsWith('#') || /^(https?:|mailto:|data:)/i.test(url)) {
    return value;
  }
  try {
    return new URL(url, baseUrl).href;
  } catch (error) {
    return value;
  }
}

function isUsefulReadme(readme) {
  const text = String(readme || '').trim();
  if (text.length < 80) {
    return false;
  }
  if (isReadmePath(text)) {
    return false;
  }
  return !/does not publish readme content|no readme/i.test(text);
}

function isReadmePath(value) {
  const text = String(value || '').trim();
  return /^[./\w@-][\w@./-]*readme\.(md|markdown|mdx|txt)$/i.test(text);
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
  if (dependency.transitiveVulnerabilityCount) {
    flags.push(`${dependency.transitiveVulnerabilityCount} transitive`);
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
  if (dependency.transitiveVulnerabilityCount) {
    lines.push(`Transitive vulnerabilities: ${dependency.transitiveVulnerabilityCount}`);
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
  const explicitReadmePath = getExplicitReadmePath(registry);
  const paths = [
    explicitReadmePath ? explicitReadmePath.replace(/\/?readme\.(md|markdown|mdx|txt)$/i, '') : '',
    github.path,
    '',
    `packages/${unscopedName}`,
    `packages/${packagePath}`,
    unscopedName,
    packagePath
  ].filter((value, index, list) => value !== undefined && list.indexOf(value) === index);

  const refs = [github.ref, 'canary', 'main', 'master'].filter((value, index, list) => value && list.indexOf(value) === index);
  return refs.flatMap((ref) =>
    paths.flatMap((readmePath) => {
      const prefix = readmePath ? `${readmePath.replace(/\/$/, '')}/` : '';
      const candidates = [
        `https://raw.githubusercontent.com/${github.owner}/${github.repo}/${ref}/${prefix}README.md`,
        `https://raw.githubusercontent.com/${github.owner}/${github.repo}/${ref}/${prefix}readme.md`
      ];
      if (explicitReadmePath) {
        candidates.unshift(`https://raw.githubusercontent.com/${github.owner}/${github.repo}/${ref}/${explicitReadmePath.replace(/^\//, '')}`);
      }
      return candidates;
    })
  ).filter((url, index, list) => list.indexOf(url) === index);
}

function getExplicitReadmePath(registry) {
  const candidates = [registry.readmeFilename, registry.readme];
  return candidates.find(isReadmePath) || '';
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
  return error?.message ? error.message : String(error);
}

function getNonce() {
  return randomBytes(24).toString('base64url');
}

module.exports = { activate, deactivate };
