const test = require('node:test');
const assert = require('node:assert/strict');
const { DependencyUpdater, executeUpdateTask, getUpdateTargets } = require('../lib/dependency-update');

const registry = {
  latestVersion: '2.0.0',
  versions: Object.fromEntries(['1.0.0', '1.0.5', '1.1.0', '2.0.0', '3.0.0-beta.1'].map((version) => [version, {}]))
};

function eventSource() {
  const listeners = new Set();
  return {
    event(listener) { listeners.add(listener); return { dispose: () => listeners.delete(listener) }; },
    fire(value) { for (const listener of [...listeners]) listener(value); },
    get size() { return listeners.size; }
  };
}

function harness(options = {}) {
  const processEnd = eventSource();
  const taskEnd = eventSource();
  const calls = { tasks: [], contexts: [], refresh: 0, notices: [], picks: [], states: [] };
  let installed = false;
  const context = {
    name: 'example', packageJsonPath: '/project/package.json', type: 'devDependencies',
    range: '^1.0.0', resolvedVersion: '1.0.0', manifestSignature: 'before',
    packageManager: { id: 'npm', label: 'npm' }, ...options.context
  };
  const vscode = {
    workspace: { isTrusted: true, getWorkspaceFolder: () => ({ uri: '/project' }) },
    Uri: { file: (fsPath) => ({ fsPath }) },
    TaskScope: { Workspace: 1 }, TaskRevealKind: { Always: 1 }, TaskPanelKind: { Dedicated: 2 },
    Task: class { constructor(definition, scope, name, source, execution) { Object.assign(this, { definition, scope, name, source, execution }); } },
    ShellExecution: class { constructor(command, args, settings) { Object.assign(this, { command, args, settings }); } },
    env: { clipboard: { async writeText(text) { calls.copied = text; } } },
    window: {
      async showQuickPick(items) {
        calls.picks.push(items);
        return options.pick ? options.pick(items, calls.picks.length) : items[0];
      },
      async showWarningMessage(message, config, ...actions) {
        calls.notices.push({ kind: 'warning', message });
        return actions.length ? options.confirm?.() ?? 'Run command' : undefined;
      },
      showInformationMessage: (message) => calls.notices.push({ kind: 'info', message }),
      showErrorMessage: (message) => calls.notices.push({ kind: 'error', message })
    },
    tasks: {
      onDidEndTaskProcess: processEnd.event,
      onDidEndTask: taskEnd.event,
      async executeTask(task) {
        calls.tasks.push(task);
        if (options.launchError) throw new Error('executable unavailable');
        if (options.onExecute) return options.onExecute(task, processEnd, taskEnd);
        const execution = { task };
        const exitCode = Object.hasOwn(options, 'exitCode') ? options.exitCode : 0;
        installed = exitCode === 0;
        // Intentionally emit before executeTask resolves to test the fast-process race.
        processEnd.fire({ execution, exitCode });
        taskEnd.fire({ execution });
        return execution;
      }
    }
  };
  const host = {
    async getContext(name, packageJsonPath) {
      calls.contexts.push(packageJsonPath);
      if (options.readError && calls.contexts.length > 2) throw new Error('file unreadable');
      return { ...context, ...(installed ? { range: '^1.1.0', resolvedVersion: options.noLock ? '' : '1.1.0' } : {}) };
    },
    async getRegistry() { return registry; },
    async refresh() {
      calls.refresh++;
      if (options.refreshError) throw new Error('network unavailable');
    }
  };
  const updater = new DependencyUpdater(vscode, host, () => calls.states.push(structuredClone(updater.getState(context.packageJsonPath))));
  return { updater, calls, context, vscode, host, processEnd, taskEnd };
}

test('指定範囲内の最新版をSemVerで判定し、latestタグとプレリリースを区別する', () => {
  assert.equal(getUpdateTargets(registry, '^1.0.0').wanted, '1.1.0');
  assert.equal(getUpdateTargets(registry, '~1.0.0').wanted, '1.0.5');
  assert.equal(getUpdateTargets(registry, '1.0.0').wanted, '1.0.0');
  assert.equal(getUpdateTargets(registry, '>=1 <2 || >=3').wanted, '1.1.0');
  assert.equal(getUpdateTargets(registry, '^3.0.0-beta.1').wanted, '3.0.0-beta.1');
  assert.equal(getUpdateTargets(registry, '^9').wanted, null);
  assert.equal(getUpdateTargets(registry, 'workspace:*').wanted, null);
  assert.equal(getUpdateTargets(registry, '*').latest, '2.0.0');
  assert.equal(getUpdateTargets(registry, '*').versions[0], '3.0.0-beta.1');
});

test('成功後に元のファイルを再読込し、再取得と更新結果の表示を行う', async () => {
  const h = harness();
  await h.updater.run('example', '/project/package.json');
  const result = h.updater.getState('/project/package.json').updateResult;
  assert.equal(result.status, 'succeeded');
  assert.equal(result.targetVersion, '1.1.0');
  assert.equal(result.before.resolvedVersion, '1.0.0');
  assert.equal(result.after.resolvedVersion, '1.1.0');
  assert.equal(h.calls.refresh, 1);
  assert.deepEqual(h.calls.contexts, Array(3).fill('/project/package.json'));
  assert.deepEqual(h.calls.tasks[0].execution.args, ['install', 'example@1.1.0', '--save-dev']);
  assert.equal(h.calls.tasks[0].execution.settings.cwd, '/project');
  assert.equal(h.updater.busy, false);
  assert.equal(h.processEnd.size + h.taskEnd.size, 0);
  assert(h.calls.states.some((state) => state.updateResult?.status === 'running'));
  assert(h.calls.states.some((state) => state.updateResult?.refreshing));
});

test('特定バージョンはプレリリースや旧版も選べる', async () => {
  const h = harness({ pick: (items, index) => index === 1 ? items.find((item) => item.custom) : items.find((item) => item.version === '3.0.0-beta.1') });
  await h.updater.run('example', '/project/package.json');
  assert.equal(h.calls.tasks[0].execution.args[1], 'example@3.0.0-beta.1');
});

test('latestを選ぶと範囲内最新版とは別の更新先になる', async () => {
  const h = harness({ pick: (items) => items.find((item) => item.label === 'Latest release') });
  await h.updater.run('example', '/project/package.json');
  assert.equal(h.calls.tasks[0].execution.args[1], 'example@2.0.0');
});

test('更新失敗でもファイルと依存情報を再取得し、成功と表示しない', async () => {
  const h = harness({ exitCode: 1 });
  await h.updater.run('example', '/project/package.json');
  const result = h.updater.getState('/project/package.json').updateResult;
  assert.equal(result.status, 'failed');
  assert.equal(result.after.resolvedVersion, '1.0.0');
  assert.equal(h.calls.refresh, 1);
  assert.equal(h.calls.notices.at(-1).kind, 'error');
});

test('終了コード不明とタスク起動失敗を成功扱いしない', async () => {
  for (const options of [{ exitCode: undefined }, { launchError: true }]) {
    const h = harness(options);
    await h.updater.run('example', '/project/package.json');
    assert.equal(h.updater.getState('/project/package.json').updateResult.status, options.launchError ? 'failed' : 'unknown');
    assert.equal(h.calls.refresh, 1);
    assert.equal(h.processEnd.size + h.taskEnd.size, 0);
  }
});

test('再取得やファイル読込に失敗しても、コマンドの成功とは分けて記録する', async () => {
  const h = harness({ refreshError: true, readError: true });
  await h.updater.run('example', '/project/package.json');
  const result = h.updater.getState('/project/package.json').updateResult;
  assert.equal(result.status, 'succeeded');
  assert.match(result.refreshError, /network unavailable/);
  assert.match(result.readError, /file unreadable/);
  assert.equal(h.calls.notices.at(-1).kind, 'warning');
});

test('lockfileがない結果に選択バージョンを代入しない', async () => {
  const h = harness({ noLock: true, context: { resolvedVersion: '' } });
  await h.updater.run('example', '/project/package.json');
  const result = h.updater.getState('/project/package.json').updateResult;
  assert.equal(result.after.resolvedVersion, '');
  assert.equal(result.after.range, '^1.1.0');
  assert.match(h.calls.notices.at(-1).message, /resolved version unavailable/);
});

test('選択キャンセルとコマンドコピーでは更新も再取得も行わない', async () => {
  for (const options of [{ pick: () => undefined }, { confirm: () => 'Copy command' }, { confirm: () => 'Cancel' }]) {
    const h = harness(options);
    await h.updater.run('example', '/project/package.json');
    assert.equal(h.calls.tasks.length, 0);
    assert.equal(h.calls.refresh, 0);
    assert.equal(h.updater.busy, false);
    if (options.confirm?.() === 'Copy command') assert.equal(h.calls.copied, "npm install 'example@1.1.0' --save-dev");
  }
});

test('選択中にpackage.jsonが変更されたら実行しない', async () => {
  const h = harness({ confirm: () => { h.context.manifestSignature = 'changed'; return 'Run command'; } });
  await h.updater.run('example', '/project/package.json');
  assert.equal(h.calls.tasks.length, 0);
  assert.match(h.calls.notices.at(-1).message, /changed/);
});

test('未信頼ワークスペースと非対応の依存指定を実行しない', async () => {
  for (const range of ['file:../local', 'workspace:*', 'npm:other@^1', 'git+https://example.com/repo']) {
    const h = harness({ context: { range } });
    await h.updater.run('example', '/project/package.json');
    assert.equal(h.calls.tasks.length, 0);
    assert.equal(h.calls.picks.length, 0);
  }
  const h = harness();
  h.vscode.workspace.isTrusted = false;
  await h.updater.run('example', '/project/package.json');
  assert.equal(h.calls.tasks.length, 0);
  assert.equal(h.calls.contexts.length, 0);
});

test('別タスクの終了を無視し、プロセスを起動できず終わった場合も待機を解除する', async () => {
  const h = harness({ onExecute: async (task, processEnd, taskEnd) => {
    processEnd.fire({ execution: { task: { definition: { updateId: 'other' } } }, exitCode: 0 });
    taskEnd.fire({ execution: { task } });
    return { task };
  } });
  const result = await executeUpdateTask(h.vscode, { definition: { updateId: 'test' } });
  assert.equal(result, undefined);
  assert.equal(h.processEnd.size + h.taskEnd.size, 0);
});

test('二重起動を防ぎ、他プロジェクトに結果を混ぜない', async () => {
  let execution;
  const h = harness({ onExecute: async (task) => { execution = { task }; return execution; } });
  const first = h.updater.run('example', '/project/package.json');
  await new Promise((resolve) => setImmediate(resolve));
  await h.updater.run('example', '/other/package.json');
  assert.equal(h.calls.tasks.length, 1);
  assert.equal(h.updater.getState('/other/package.json').updateResult, null);
  h.processEnd.fire({ execution, exitCode: 0 });
  await first;
  assert.equal(h.updater.busy, false);
});

test('拡張機能の終了時はイベント購読を破棄し結果通知を止める', async () => {
  const h = harness({ onExecute: async (task) => ({ task }) });
  const run = h.updater.run('example', '/project/package.json');
  await new Promise((resolve) => setImmediate(resolve));
  h.updater.dispose();
  await run;
  assert.equal(h.processEnd.size + h.taskEnd.size, 0);
  assert.equal(h.calls.refresh, 0);
});
