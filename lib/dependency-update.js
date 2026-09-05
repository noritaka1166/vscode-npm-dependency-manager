const path = require('node:path');
const { randomUUID } = require('node:crypto');
const semver = require('semver');
const { createPackageInstallArguments, createPackageInstallCommand } = require('./package-manager');

function getUpdateTargets(registry, range) {
  const versions = Object.keys(registry.versions || {}).filter((version) => semver.valid(version)).sort(semver.rcompare);
  return {
    versions,
    wanted: semver.validRange(range) ? semver.maxSatisfying(versions, range) : null,
    latest: versions.includes(registry.latestVersion) ? registry.latestVersion : null
  };
}

function snapshot(context) {
  return { range: context.range, resolvedVersion: context.resolvedVersion || '' };
}

function describeSnapshot(value) {
  if (!value) return 'unavailable';
  return value.resolvedVersion
    ? `${value.resolvedVersion} (package.json: ${value.range})`
    : `package.json: ${value.range} (resolved version unavailable)`;
}

// Register before executeTask: a short-lived process can finish before its promise resolves.
function executeUpdateTask(vscode, task, pending = new Set()) {
  return new Promise((resolve, reject) => {
    const listeners = [];
    let settled = false;
    const finish = (error, exitCode) => {
      if (settled) return;
      settled = true;
      listeners.forEach((listener) => listener.dispose());
      pending.delete(disposable);
      if (error) reject(error);
      else resolve(exitCode);
    };
    const disposable = { dispose: () => finish(null, undefined) };
    const matches = (event) => event.execution.task.definition.updateId === task.definition.updateId;
    pending.add(disposable);
    listeners.push(vscode.tasks.onDidEndTaskProcess((event) => {
      if (matches(event)) finish(null, event.exitCode);
    }));
    listeners.push(vscode.tasks.onDidEndTask((event) => {
      // A task that could not start a process has no process-end event.
      if (matches(event)) finish(null, undefined);
    }));
    try {
      Promise.resolve(vscode.tasks.executeTask(task)).catch((error) => finish(error));
    } catch (error) {
      finish(error);
    }
  });
}

class DependencyUpdater {
  constructor(vscode, host, onChange) {
    this.vscode = vscode;
    this.host = host;
    this.onChange = onChange;
    this.busy = false;
    this.results = new Map();
    this.pending = new Set();
    this.disposed = false;
  }

  dispose() {
    this.disposed = true;
    for (const disposable of this.pending) disposable.dispose();
  }

  getState(packageJsonPath) {
    return { updateBusy: this.busy, updateResult: this.results.get(packageJsonPath) || null };
  }

  publish(result) {
    if (this.disposed) return;
    if (result) this.results.set(result.packageJsonPath, result);
    this.onChange();
  }

  async chooseVersion(context, registry) {
    const { vscode } = this;
    const targets = getUpdateTargets(registry, context.range);
    const choices = [];
    if (targets.wanted) choices.push({
      label: 'Latest within declared range', description: targets.wanted,
      detail: `Satisfies ${context.range}; compatibility is not guaranteed.`, version: targets.wanted
    });
    if (targets.latest) choices.push({
      label: 'Latest release', description: targets.latest,
      detail: 'Uses the registry latest tag; may cross major versions.', version: targets.latest
    });
    if (!targets.versions.length) throw new Error(`No published versions are available for ${context.name}.`);
    choices.push({ label: 'Choose a specific version…', detail: 'Search all published versions, including prereleases.', custom: true });
    const choice = await vscode.window.showQuickPick(choices, {
      title: `Update ${context.name}`,
      placeHolder: `Current: ${describeSnapshot(snapshot(context))}`, ignoreFocusOut: true
    });
    if (!choice) return undefined;
    let version = choice.version;
    if (choice.custom) {
      const selected = await vscode.window.showQuickPick(targets.versions.map((value) => ({
        label: value, description: semver.prerelease(value) ? 'Prerelease' : '', version: value
      })), { title: `Choose a version of ${context.name}`, placeHolder: 'Type a version to filter', ignoreFocusOut: true });
      version = selected?.version;
    }
    if (!version) return undefined;
    if (!targets.versions.includes(version)) throw new Error('Select a published package version.');
    return version;
  }

  async run(name, packageJsonPath) {
    const { vscode } = this;
    if (this.busy) {
      vscode.window.showInformationMessage('A dependency update is already in progress.');
      return;
    }
    this.busy = true;
    this.publish();
    try {
      if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before running dependency updates.');
      const context = await this.host.getContext(name, packageJsonPath);
      if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/i.test(name) || !semver.validRange(context.range)) {
        throw new Error('Version selection supports registry dependencies with a semantic version range. File, Git, workspace and alias dependencies are not supported.');
      }
      const registry = await this.host.getRegistry(name);
      const version = await this.chooseVersion(context, registry);
      if (!version || this.disposed) return;
      const specifier = `${name}@${version}`;
      const command = createPackageInstallCommand(context.packageManager, specifier, context.type);
      const manifest = registry.versions[version];
      const detail = [
        `Project: ${packageJsonPath}`,
        `Before: ${describeSnapshot(snapshot(context))}`,
        `Target: ${version}`,
        manifest.engines?.node ? `Required Node.js: ${manifest.engines.node}` : '',
        manifest.deprecated ? `Deprecated: ${manifest.deprecated}` : ''
      ].filter(Boolean).join('\n');
      const selection = await vscode.window.showWarningMessage(`Run ${command}?`,
        { modal: true, detail }, 'Run command', 'Copy command');
      if (selection === 'Copy command') {
        await vscode.env.clipboard.writeText(command);
        vscode.window.showInformationMessage(`Copied: ${command}`);
        return;
      }
      if (selection !== 'Run command' || this.disposed) return;
      // Re-read the original project even if the dashboard selection changed during the picker.
      const before = await this.host.getContext(name, packageJsonPath);
      if (before.manifestSignature !== context.manifestSignature ||
          before.packageManager.id !== context.packageManager.id ||
          before.packageManager.version !== context.packageManager.version) {
        throw new Error('package.json or the package manager changed. Choose the update target again.');
      }
      const result = { name, packageJsonPath, targetVersion: version, before: snapshot(before), status: 'running', message: 'Updating dependency…' };
      this.publish(result);
      await this.execute(context, specifier, result);
    } catch (error) {
      if (!this.disposed) vscode.window.showErrorMessage(`Dependency update: ${error.message || error}`);
    } finally {
      this.busy = false;
      this.publish();
    }
  }

  async execute(context, specifier, result) {
    const { vscode } = this;
    let exitCode;
    let launchError;
    try {
      const { executable, args } = createPackageInstallArguments(context.packageManager, specifier, context.type);
      const task = new vscode.Task(
        { type: 'npm-dependency-manager', updateId: randomUUID() },
        vscode.workspace.getWorkspaceFolder(vscode.Uri.file(result.packageJsonPath)) || vscode.TaskScope.Workspace,
        `Update ${specifier}`, 'npm Packages',
        new vscode.ShellExecution(executable, args, { cwd: path.dirname(result.packageJsonPath) }), []
      );
      task.presentationOptions = { reveal: vscode.TaskRevealKind.Always, panel: vscode.TaskPanelKind.Dedicated, clear: true };
      exitCode = await executeUpdateTask(vscode, task, this.pending);
    } catch (error) {
      launchError = error.message || String(error);
    }
    if (this.disposed) return;
    result.exitCode = exitCode;
    result.status = launchError || (exitCode !== undefined && exitCode !== 0) ? 'failed' : exitCode === 0 ? 'succeeded' : 'unknown';
    result.message = launchError ? `Could not start update: ${launchError}`
      : exitCode === 0 ? 'Update command succeeded.'
        : exitCode === undefined ? 'Update ended without an exit code. It may have been cancelled or could not start.'
          : `Update failed (exit code ${exitCode}). See the task terminal for details.`;
    try {
      result.after = snapshot(await this.host.getContext(result.name, result.packageJsonPath));
    } catch (error) {
      result.readError = `Could not read updated files: ${error.message || error}`;
    }
    this.publish({ ...result, refreshing: true });
    try {
      await this.host.refresh();
    } catch (error) {
      result.refreshError = `Dependency information could not be refreshed: ${error.message || error}`;
    }
    if (this.disposed) return;
    this.publish(result);
    const message = `${result.name}: ${result.message} ${describeSnapshot(result.before)} → ${describeSnapshot(result.after)}`;
    if (result.status === 'failed') vscode.window.showErrorMessage(message);
    else if (result.status === 'unknown' || result.readError || result.refreshError) vscode.window.showWarningMessage(message);
    else vscode.window.showInformationMessage(message);
  }
}

module.exports = { DependencyUpdater, executeUpdateTask, getUpdateTargets };
