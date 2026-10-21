import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import * as lifecycleGate from '../electron/connector-lifecycle-gate.ts';
import * as jsonlLineBuffer from '../electron/jsonl-line-buffer.ts';
import * as compatibility from '../electron/qq-native-compatibility-policy.ts';

// Run the actual bridge client against scripted fake connector processes. No
// connector executable, updater download, network or Electron module is used.
const bridgeSource = fs.readFileSync(
  new URL('../electron/player-bridge-client.ts', import.meta.url), 'utf8'
);
const bridgeJs = ts.transpileModule(bridgeSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText;

const PING = {
  connectorId: 'netease',
  protocolVersion: 1,
  capabilities: { search: true, pause: true },
  features: []
};

class FakeConnector extends EventEmitter {
  constructor(respond) {
    super();
    this.stdin = new PassThrough();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.killed = false;
    this.exitCode = null;
    this.signalCode = null;
    this.kills = 0;
    this.requests = [];
    let input = '';
    this.stdin.setEncoding('utf8');
    this.stdin.on('data', chunk => {
      input += chunk;
      for (let newline = input.indexOf('\n'); newline >= 0; newline = input.indexOf('\n')) {
        const request = JSON.parse(input.slice(0, newline));
        input = input.slice(newline + 1);
        this.requests.push(request);
        respond(request, this);
      }
    });
  }

  reply(request, result) {
    this.stdout.write(`${JSON.stringify({ id: request.id, ok: true, result })}\n`);
  }

  fail(request, error) {
    this.stdout.write(`${JSON.stringify({ id: request.id, ok: false, error })}\n`);
  }

  exit(code, signal = null) {
    this.exitCode = code;
    this.signalCode = signal;
    this.stdout.end();
    this.stderr.end();
    this.emit('exit', code, signal);
  }

  kill() {
    this.kills++;
    this.killed = true;
    setImmediate(() => this.exit(null, 'SIGTERM'));
    return true;
  }
}

function harness(respond, options = {}) {
  const children = [];
  const logs = [];
  const events = [];
  class FakeUpdater {
    async ensureInstalled(player) { return `C:\\connectors\\${player}\\connector.exe`; }
    async getLaunchEnvironment() { return {}; }
  }
  const imports = {
    child_process: {
      spawn() {
        const child = new FakeConnector(respond);
        children.push(child);
        return child;
      }
    },
    fs: { __esModule: true, default: { existsSync: () => true }, existsSync: () => true },
    './connector-updater': { ConnectorUpdater: FakeUpdater },
    './connector-lifecycle-gate': lifecycleGate,
    './jsonl-line-buffer': jsonlLineBuffer,
    './qq-native-compatibility-policy': compatibility
  };
  const module = { exports: {} };
  vm.runInNewContext(bridgeJs, {
    module,
    exports: module.exports,
    require(name) {
      assert.ok(Object.hasOwn(imports, name), `Unexpected bridge dependency: ${name}`);
      return imports[name];
    },
    process: { env: {} },
    setTimeout,
    clearTimeout
  });
  const bridge = new module.exports.PlayerBridgeClient(
    message => logs.push(message),
    () => '',
    event => events.push(event),
    options
  );
  return { bridge, children, logs, events };
}

const settle = async (turns = 3) => {
  for (let i = 0; i < turns; i++) await new Promise(resolve => setImmediate(resolve));
};

async function waitFor(condition) {
  for (let i = 0; i < 50 && !condition(); i++) await settle(1);
  assert.ok(condition());
}

const answerPing = (result = PING) => (request, child) => {
  if (request.action === 'ping') child.reply(request, result);
};

test('an unanswered first ping kills the child and the next start spawns a fresh connector', async () => {
  let answer = false;
  const { bridge, children, logs, events } = harness((request, child) => {
    if (request.action === 'ping' && answer) child.reply(request, PING);
  }, { firstPingTimeoutMs: 30 });

  await assert.rejects(bridge.start('netease'), /播放器桥请求超时: ping/);
  assert.equal(children.length, 1);
  assert.equal(children[0].kills, 1);
  assert.equal(bridge.running, false);
  assert.equal(bridge.supportsSnapshotEvents, false);
  await settle();
  assert.deepEqual(events, [], 'a failed handshake is reported by start(), not as a connector exit');
  assert.equal(logs.some(message => message.includes('已退出')), false);

  answer = true;
  await bridge.start('netease');
  assert.equal(children.length, 2, 'the next start performs a full spawn and handshake');
  assert.deepEqual(children[1].requests.map(request => request.action), ['ping']);
  assert.equal(bridge.running, true);
  assert.equal(children[1].kills, 0);
});

test('a failed snapshot subscription falls back to polling without failing the start', async () => {
  for (const failure of ['rejected', 'not-subscribed']) {
    let advertisedWhileSubscribing = null;
    const { bridge, children, logs } = harness((request, child) => {
      if (request.action === 'ping') {
        child.reply(request, { ...PING, features: ['snapshot-events-v1', 'other-feature'] });
      } else if (request.action === 'subscribe') {
        advertisedWhileSubscribing = bridge.supportsSnapshotEvents;
        if (failure === 'rejected') child.fail(request, 'Unsupported event protocol version: 1');
        else child.reply(request, { subscribed: false, reason: 'snapshot-events-unsupported' });
      }
    });
    await bridge.start('netease');
    assert.equal(advertisedWhileSubscribing, false, failure);
    assert.equal(bridge.supportsSnapshotEvents, false, failure);
    assert.equal(bridge.running, true, failure);
    assert.equal(children[0].kills, 0, failure);
    assert.ok(logs.includes('[播放器桥] 实时事件订阅不可用，已回退到状态轮询'), failure);
  }
});

test('a confirmed snapshot subscription enables connector events', async () => {
  const { bridge, children } = harness((request, child) => {
    if (request.action === 'ping') {
      child.reply(request, { ...PING, features: ['snapshot-events-v1'] });
    } else if (request.action === 'subscribe') {
      child.reply(request, { subscribed: true, eventProtocolVersion: 1, feature: 'snapshot-events-v1' });
    }
  });
  await bridge.start('netease');
  assert.equal(bridge.supportsSnapshotEvents, true);
  assert.deepEqual(children[0].requests, [
    { id: children[0].requests[0].id, action: 'ping' },
    { id: children[0].requests[1].id, action: 'subscribe', eventProtocolVersion: 1 }
  ]);
});

test('a connector that exits during its handshake rejects the start with its exit code', async () => {
  const { bridge, children, logs, events } = harness((request, child) => {
    if (request.action !== 'ping') return;
    child.stderr.write('Unhandled exception. System.IO.FileNotFoundException');
    child.exit(-532462766);
  });
  await assert.rejects(bridge.start('netease'), /播放器桥已退出 \(code=-532462766\)/);
  await settle();
  assert.equal(bridge.running, false);
  assert.equal(children[0].kills, 0);
  assert.deepEqual(events, []);
  assert.deepEqual(logs, ['[播放器桥] Unhandled exception. System.IO.FileNotFoundException']);
});

test('a protocol mismatch stops the connector gracefully and keeps its message', async () => {
  const { bridge, children } = harness((request, child) => {
    if (request.action === 'ping') {
      child.reply(request, { ...PING, connectorId: 'kugou' });
    } else if (request.action === 'shutdown') {
      child.reply(request, {});
      setImmediate(() => child.exit(0));
    }
  });
  await assert.rejects(bridge.start('netease'), /连接器协议不匹配: kugou\/1/);
  assert.equal(bridge.running, false);
  assert.equal(children[0].kills, 0);
  assert.deepEqual(children[0].requests.map(request => request.action), ['ping', 'shutdown']);
});

test('a handshake interrupted by stop() is drained by stop() instead of being killed', async () => {
  const { bridge, children, events } = harness((request, child) => {
    if (request.action !== 'shutdown') return;
    setTimeout(() => {
      child.reply(request, {});
      setImmediate(() => child.exit(0));
    }, 60);
  }, { firstPingTimeoutMs: 30 });
  const start = bridge.start('netease');
  await waitFor(() => children[0]?.requests.length === 1);
  const stop = bridge.stop();
  await assert.rejects(start, /播放器桥请求超时: ping/);
  await stop;
  assert.equal(children[0].kills, 0);
  assert.equal(bridge.running, false);
  assert.deepEqual(events, []);
});

test('invalid stdout lines never stall the protocol and are logged at most once per interval', async () => {
  const { bridge, logs } = harness((request, child) => {
    if (request.action !== 'ping') return;
    child.stdout.write('0\ntrue\nnull\n"text"\n[1]\nconnector banner\n');
    child.stdout.write(`${JSON.stringify({ id: request.id, ok: true, result: PING })}\n`);
  });
  await bridge.start('netease');
  assert.equal(bridge.running, true);
  assert.deepEqual(logs.filter(message => message.includes('忽略无效输出')), [
    '[播放器桥] 忽略无效输出（非对象）：0'
  ]);
});

test('connector stderr is logged per line, capped, and flushed when the connector exits', async () => {
  const { bridge, children, logs, events } = harness(answerPing());
  await bridge.start('netease');
  const child = children[0];
  child.stderr.write('first line\r\nsecond');
  child.stderr.write(` part\n${'x'.repeat(5000)}\n`);
  child.stderr.write(`${'y'.repeat(2500)}`);
  child.stderr.write(`${'y'.repeat(100)}\nlast words`);
  await settle();
  child.exit(1);
  await settle();
  assert.deepEqual(logs.filter(message => !message.includes('已退出')), [
    '[播放器桥] first line',
    '[播放器桥] second part',
    `[播放器桥] ${'x'.repeat(2000)}…`,
    `[播放器桥] ${'y'.repeat(2000)}…`,
    '[播放器桥] last words'
  ]);
  // After a completed handshake, an exit is still announced as before.
  assert.ok(logs.includes('[播放器桥] 已退出 (code=1, signal=none)'));
  assert.deepEqual(events.map(event => [event.event, event.player]), [['connectorExit', 'netease']]);
});

test('stdin errors of a running connector are logged once and never thrown', async () => {
  const { bridge, children, logs } = harness(answerPing());
  await bridge.start('netease');
  assert.doesNotThrow(() => {
    children[0].stdin.emit('error', new Error('write EPIPE'));
    children[0].stdin.emit('error', new Error('write EPIPE'));
  });
  assert.deepEqual(logs, ['[播放器桥] 写入连接器失败：write EPIPE']);
});
