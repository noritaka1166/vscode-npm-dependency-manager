const vscode = require('vscode');

const VIEW_ID = 'workspaceNpmSidebar.dependenciesView';
const PANEL_TYPE = 'workspaceNpmSidebar.dashboard';
const REGISTRY_BASE_URL = 'https://registry.npmjs.org';

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
        await panel.showPackage(dependency.name);
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
    this.weeks = 12;
    this.dependencies = [];
    this.message = '';
    this.registryCache = new Map();
    this.dependencyCache = new Map();
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

  async setWeeks(weeks) {
    this.weeks = normalizeWeeks(weeks);
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
    const entries = collectDependencyEntries(packageJson, this.filter);

    this.dependencies = await mapWithConcurrency(entries, 8, async (entry) => {
      const registry = await this.getRegistryPackage(entry.name);
      return {
        ...entry,
        latestVersion: registry.latestVersion,
        recentVersion: getLatestVersionWithinWeeks(registry.time, this.weeks),
        description: registry.description,
        npmUrl: `https://www.npmjs.com/package/${entry.name}`,
        status: getVersionStatus(entry.currentVersion, registry.latestVersion)
      };
    });

    this.message = '';
    this.emit();
  }

  async getDetail(name) {
    const registry = await this.getRegistryPackage(name);
    return {
      name,
      description: registry.description,
      latestVersion: registry.latestVersion,
      recentVersion: getLatestVersionWithinWeeks(registry.time, this.weeks),
      npmUrl: `https://www.npmjs.com/package/${name}`,
      homepage: registry.homepage,
      repository: registry.repository,
      license: registry.license,
      readme: registry.readme || 'This package does not publish README content to the npm registry.'
    };
  }

  async getPackageDependencies(dependency, ancestry) {
    const cacheKey = `${dependency.name}@${dependency.currentVersion || 'latest'}`;
    const cached = this.dependencyCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const registry = await this.getRegistryPackage(dependency.name);
    const versionInfo = resolveVersionInfo(registry, dependency.currentVersion);
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
      const childRegistry = await this.getRegistryPackage(entry.name);
      return {
        ...entry,
        latestVersion: childRegistry.latestVersion,
        recentVersion: getLatestVersionWithinWeeks(childRegistry.time, this.weeks),
        description: childRegistry.description,
        npmUrl: `https://www.npmjs.com/package/${entry.name}`,
        status: getVersionStatus(entry.currentVersion, childRegistry.latestVersion)
      };
    });

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
      weeks: this.weeks,
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
    this.description = dependency.currentVersion;
    this.tooltip = `${dependency.name}\n${dependency.type}\nRequired: ${dependency.currentVersion}\nLatest: ${dependency.latestVersion || '-'}`;
    this.contextValue = 'dependency';
    this.command = {
      command: 'workspaceNpmSidebar.openPackage',
      title: 'Open Package',
      arguments: [dependency]
    };
    this.iconPath = new vscode.ThemeIcon(dependency.type === 'dependencies' ? 'package' : 'tools');
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
          case 'setWeeks':
            await this.model.setWeeks(message.weeks);
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

  async showPackage(name) {
    this.show();
    this.post({ type: 'loading', message: `Loading ${name}...` });
    const detail = await this.model.getDetail(name);
    this.post({ type: 'detail', detail, weeks: this.model.weeks });
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

function getLatestVersionWithinWeeks(timeMap, weeks) {
  const now = Date.now();
  const threshold = now - weeks * 7 * 24 * 60 * 60 * 1000;

  return Object.entries(timeMap || {})
    .filter(([version, publishedAt]) => version !== 'created' && version !== 'modified' && Date.parse(publishedAt) >= threshold)
    .sort((a, b) => Date.parse(b[1]) - Date.parse(a[1]))
    .map(([version, publishedAt]) => ({ version, publishedAt }))
    .at(0) || null;
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

function normalizeWeeks(value) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number) || number < 1) {
    return 1;
  }
  return Math.min(number, 260);
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
          recentVersion: null,
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
