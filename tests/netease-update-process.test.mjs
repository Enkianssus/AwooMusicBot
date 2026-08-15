import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isTransientNeteaseFileLock,
  NeteaseProcessControlError,
  NeteaseUpdateProcessController,
  parseNeteaseProcessList,
  selectNeteaseRestartExecutable,
  selectNeteaseRootProcessIds
} from '../electron/netease-update-process.ts';

const executablePath = 'F:\\Program Files\\NetEase\\CloudMusic\\cloudmusic.exe';

function processInfo(processId, parentProcessId, commandLine = '') {
  return {
    processId,
    parentProcessId,
    executablePath,
    commandLine
  };
}

class FakeRuntime {
  processes = [];
  closeCalls = [];
  launchCalls = [];
  gracefulCloseWorks = true;
  forceCloseWorks = true;
  listFailureCall = 0;
  listCalls = 0;

  async listProcesses() {
    this.listCalls++;
    if (this.listCalls === this.listFailureCall) {
      throw new Error('process inspection failed');
    }
    return this.processes.map(item => ({ ...item }));
  }

  async closeProcessTrees(processIds, force) {
    this.closeCalls.push({ processIds, force });
    if (
      (force && this.forceCloseWorks)
      || (!force && this.gracefulCloseWorks)
    ) {
      this.processes = [];
    }
  }

  async launch(filePath) {
    this.launchCalls.push(filePath);
    this.processes = [processInfo(900, 1, `"${filePath}"`)];
  }

  fileExists(filePath) {
    return filePath === executablePath;
  }

  async wait() {}
}

function createController(runtime, logs = []) {
  return new NeteaseUpdateProcessController({
    runtime,
    onLog: message => logs.push(message),
    gracefulTimeoutMs: 0,
    forceTimeoutMs: 0,
    restartTimeoutMs: 0,
    pollIntervalMs: 50
  });
}

test('parses PowerShell process JSON in object and array forms', () => {
  assert.deepEqual(parseNeteaseProcessList(JSON.stringify({
    processId: 10,
    parentProcessId: 1,
    executablePath,
    commandLine: 'cloudmusic.exe'
  })), [processInfo(10, 1, 'cloudmusic.exe')]);
  assert.equal(parseNeteaseProcessList(JSON.stringify([
    { processId: 0 },
    processInfo(11, 10, '--type=renderer')
  ])).length, 1);
  assert.throws(
    () => parseNeteaseProcessList('not-json'),
    NeteaseProcessControlError
  );
});

test('selects the main executable and only root process trees', () => {
  const processes = [
    processInfo(100, 50, `"${executablePath}"`),
    processInfo(101, 100, '--type=gpu-process'),
    processInfo(102, 100, '--type=renderer')
  ];
  assert.deepEqual(selectNeteaseRootProcessIds(processes), [100]);
  assert.equal(
    selectNeteaseRestartExecutable(processes, () => true),
    executablePath
  );
});

test('does nothing when NetEase was not running', async () => {
  const runtime = new FakeRuntime();
  const controller = createController(runtime);
  const session = await controller.stopForConnectorUpdate();
  assert.equal(session.wasRunning, false);
  assert.deepEqual(runtime.closeCalls, []);
  assert.equal(await controller.restartAfterConnectorUpdate(session), false);
  assert.deepEqual(runtime.launchCalls, []);
});

test('closes NetEase before replacement and restores the same executable', async () => {
  const runtime = new FakeRuntime();
  const logs = [];
  runtime.processes = [
    processInfo(100, 50, `"${executablePath}"`),
    processInfo(101, 100, '--type=renderer')
  ];
  const controller = createController(runtime, logs);
  const session = await controller.stopForConnectorUpdate();
  assert.equal(session.wasRunning, true);
  assert.deepEqual(runtime.closeCalls, [
    { processIds: [100], force: false }
  ]);
  assert.equal(await controller.restartAfterConnectorUpdate(session), true);
  assert.deepEqual(runtime.launchCalls, [executablePath]);
  assert.ok(logs.some(message => message.includes('安全替换')));
  assert.ok(logs.some(message => message.includes('自动重新启动')));
});

test('force-closes only when graceful shutdown leaves processes behind', async () => {
  const runtime = new FakeRuntime();
  runtime.gracefulCloseWorks = false;
  runtime.processes = [processInfo(100, 50)];
  const controller = createController(runtime);
  const session = await controller.stopForConnectorUpdate();
  assert.equal(session.wasRunning, true);
  assert.deepEqual(runtime.closeCalls, [
    { processIds: [100], force: false },
    { processIds: [100], force: true }
  ]);
});

test('refuses replacement when the player cannot be restored or stopped', async () => {
  const missingPathRuntime = new FakeRuntime();
  missingPathRuntime.processes = [{
    ...processInfo(100, 50),
    executablePath: 'C:\\missing\\cloudmusic.exe'
  }];
  await assert.rejects(
    createController(missingPathRuntime).stopForConnectorUpdate(),
    /无法读取其程序路径/
  );
  assert.deepEqual(missingPathRuntime.closeCalls, []);

  const blockedRuntime = new FakeRuntime();
  blockedRuntime.gracefulCloseWorks = false;
  blockedRuntime.forceCloseWorks = false;
  blockedRuntime.processes = [processInfo(100, 50)];
  await assert.rejects(
    createController(blockedRuntime).stopForConnectorUpdate(),
    /网易云仍在运行/
  );
});

test('restores NetEase if inspection fails after it was closed', async () => {
  const runtime = new FakeRuntime();
  runtime.processes = [processInfo(100, 50)];
  runtime.listFailureCall = 2;
  await assert.rejects(
    createController(runtime).stopForConnectorUpdate(),
    /关闭网易云失败/
  );
  assert.deepEqual(runtime.launchCalls, [executablePath]);
});

test('recognizes only transient Windows backup lock errors', () => {
  for (const code of ['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY']) {
    assert.equal(isTransientNeteaseFileLock({ code }), true);
  }
  assert.equal(isTransientNeteaseFileLock({ code: 'ENOENT' }), false);
  assert.equal(isTransientNeteaseFileLock(new Error('EPERM text only')), false);
});
