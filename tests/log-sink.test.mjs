import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { extractFunctions, readSource, sliceBetween } from './helpers/source.mjs';
import {
  FEEDBACK_LOG_PATTERN,
  LOG_RING_LIMIT,
  createLogSink,
  describeErrorForLog,
  formatLogTimestamp,
  parseLogCursor,
  selectFeedbackLogs,
  selectLogsAfter
} from '../electron/log-sink.ts';
import { sanitizeFeedbackLog } from '../electron/feedback-service.ts';

const AT = Date.UTC(2026, 9, 21, 8, 30, 0, 123);
const identity = message => message;

function tempDir(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'awoo-log-sink-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return path.join(directory, 'logs');
}

function fsError(code) {
  return Object.assign(new Error(`${code}: simulated`), { code });
}

function readLines(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
}

test('timestamps are local ISO 8601 times with their UTC offset', () => {
  const stamp = formatLogTimestamp(AT);
  assert.match(stamp, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/);
  assert.equal(new Date(stamp).getTime(), AT);
});

test('each entry becomes one dated line in main.log; continuation lines are indented', async t => {
  const dir = tempDir(t);
  const sink = createLogSink({ dir, sanitize: identity, now: () => AT });
  assert.equal(sink.filePath, path.join(dir, 'main.log'));
  sink.write({ message: '已加载本地配置', color: 'Green', at: AT });
  sink.write({ message: 'Error: boom\n    at main.js:1:1\r\n    at run', color: 'Red' });
  sink.write({ message: 'odd color', color: 'not a color!' });
  await sink.flush();

  const stamp = formatLogTimestamp(AT);
  assert.equal(fs.readFileSync(sink.filePath, 'utf8'), [
    `${stamp} [Green] 已加载本地配置`,
    `${stamp} [Red] Error: boom`,
    '        at main.js:1:1',
    '        at run',
    `${stamp} [Gray] odd color`,
    ''
  ].join('\n'));
});

test('cookies and tokens are hidden before a line reaches the disk', async t => {
  const dir = tempDir(t);
  const sink = createLogSink({ dir, sanitize: sanitizeFeedbackLog, now: () => AT });
  sink.write({ message: '登录凭据 SESSDATA=secret-session; bili_jct=secret-csrf', color: 'Yellow' });
  sink.write({ message: 'GET https://example.test/api?access_token=secret-token&x=1' });
  sink.write({ message: 'x'.repeat(5000) });
  await sink.flush();

  const text = fs.readFileSync(sink.filePath, 'utf8');
  assert.doesNotMatch(text, /secret-/);
  assert.match(text, /SESSDATA=\[已隐藏\]/);
  assert.match(text, /access_token=\[已隐藏\]/);
  // The feedback sanitizer also bounds each message.
  assert.ok(readLines(sink.filePath).every(line => line.length < 1300));
});

test('a message the sanitizer cannot handle is replaced, never written raw', async t => {
  const dir = tempDir(t);
  const sink = createLogSink({
    dir, now: () => AT,
    sanitize: () => { throw new Error('sanitizer failed'); }
  });
  sink.write({ message: 'SESSDATA=raw-secret' });
  await sink.flush();
  const text = fs.readFileSync(sink.filePath, 'utf8');
  assert.doesNotMatch(text, /raw-secret/);
  assert.match(text, /已省略/);
});

test('the file rotates before it would exceed maxBytes and keeps three files', async t => {
  const dir = tempDir(t);
  const sink = createLogSink({ dir, sanitize: identity, now: () => AT, maxBytes: 200, files: 3 });
  const written = [];
  for (let index = 0; index < 40; index += 1) {
    const message = `line-${String(index).padStart(2, '0')}`;
    written.push(message);
    sink.write({ message });
    await sink.flush();
  }

  const names = fs.readdirSync(dir).sort();
  assert.deepEqual(names, ['main.1.log', 'main.2.log', 'main.log']);
  for (const name of names) {
    assert.ok(fs.statSync(path.join(dir, name)).size <= 200, name);
  }
  const kept = ['main.2.log', 'main.1.log', 'main.log']
    .flatMap(name => readLines(path.join(dir, name)))
    .map(line => line.slice(line.lastIndexOf(' ') + 1));
  assert.ok(kept.length > 0 && kept.length < written.length);
  // The newest lines survive, oldest first, without gaps.
  assert.deepEqual(kept, written.slice(written.length - kept.length));
});

test('a single kept file is truncated by rotation', async t => {
  const dir = tempDir(t);
  const sink = createLogSink({ dir, sanitize: identity, now: () => AT, maxBytes: 120, files: 1 });
  for (let index = 0; index < 10; index += 1) {
    sink.write({ message: `entry-${index}` });
    await sink.flush();
  }
  assert.deepEqual(fs.readdirSync(dir), ['main.log']);
  assert.ok(fs.statSync(path.join(dir, 'main.log')).size <= 120);
  assert.match(fs.readFileSync(path.join(dir, 'main.log'), 'utf8'), /entry-9/);
});

test('lines logged in the same tick are appended together', async t => {
  const dir = tempDir(t);
  let appends = 0;
  const fsImpl = {
    ...fs,
    promises: {
      ...fs.promises,
      appendFile: async (...args) => {
        appends += 1;
        return fs.promises.appendFile(...args);
      }
    }
  };
  const sink = createLogSink({ dir, sanitize: identity, fsImpl, now: () => AT });
  for (let index = 0; index < 50; index += 1) sink.write({ message: `burst ${index}` });
  await sink.flush();
  assert.equal(appends, 1);
  assert.equal(readLines(sink.filePath).length, 50);
});

test('a failing disk never throws into the caller and is reported at most once a minute', async t => {
  const dir = tempDir(t);
  const errors = [];
  let clock = AT;
  const fsImpl = {
    ...fs,
    appendFileSync: () => { throw fsError('EACCES'); },
    mkdirSync: () => { throw fsError('EACCES'); },
    promises: {
      ...fs.promises,
      appendFile: async () => { throw fsError('EACCES'); },
      mkdir: async () => { throw fsError('EACCES'); }
    }
  };
  const sink = createLogSink({
    dir, sanitize: identity, fsImpl, now: () => clock, retryDelayMs: 0,
    onError: error => {
      errors.push(error.code);
      throw new Error('a broken reporter is ignored too');
    }
  });
  assert.doesNotThrow(() => sink.write({ message: 'first' }));
  await sink.flush();
  assert.doesNotThrow(() => sink.write({ message: 'second' }));
  await sink.flush();
  assert.doesNotThrow(() => sink.flushSync());
  assert.deepEqual(errors, ['EACCES']);

  clock += 60_000;
  sink.write({ message: 'third' });
  await sink.flush();
  assert.deepEqual(errors, ['EACCES', 'EACCES']);
  assert.doesNotThrow(() => sink.write(null));
});

test('lines kept during a failure are written in order once the disk recovers', async t => {
  const dir = tempDir(t);
  let failing = true;
  const fsImpl = {
    ...fs,
    promises: {
      ...fs.promises,
      appendFile: async (...args) => {
        if (failing) throw fsError('EBUSY');
        return fs.promises.appendFile(...args);
      }
    }
  };
  const sink = createLogSink({ dir, sanitize: identity, fsImpl, now: () => AT, retryDelayMs: 0, maxPendingLines: 3 });
  for (const message of ['one', 'two', 'three', 'four', 'five']) {
    sink.write({ message });
    await sink.flush();
  }
  assert.equal(fs.existsSync(sink.filePath), false);

  failing = false;
  sink.write({ message: 'six' });
  await sink.flush();
  const lines = readLines(sink.filePath).map(line => line.slice(line.indexOf('] ') + 2));
  assert.deepEqual(lines, ['[日志] 有 3 行日志未能写入日志文件', 'four', 'five', 'six']);
});

test('flushSync appends the queue synchronously for the moment the app quits', t => {
  const dir = tempDir(t);
  const sink = createLogSink({ dir, sanitize: identity, now: () => AT });
  sink.write({ message: 'before quit 1' });
  sink.write({ message: 'before quit 2', color: 'Cyan' });
  sink.flushSync();
  const lines = readLines(sink.filePath);
  assert.equal(lines.length, 2);
  assert.match(lines[1], /\[Cyan\] before quit 2$/);
  sink.flushSync();
  assert.equal(readLines(sink.filePath).length, 2);
});

/** A file system whose background stat and append wait until the test releases them. */
function heldFs() {
  const written = [];
  const held = { stat: null, append: null };
  const fsImpl = {
    appendFileSync: (_file, text) => { written.push(['sync', text]); },
    mkdirSync: () => {},
    promises: {
      mkdir: async () => {},
      rename: async () => {},
      rm: async () => {},
      stat: () => new Promise(resolve => { held.stat = () => resolve({ size: 0 }); }),
      appendFile: (_file, text) => new Promise((resolve, reject) => {
        held.append = error => {
          if (error) reject(error);
          else {
            written.push(['async', text]);
            resolve();
          }
        };
      })
    }
  };
  const messages = () => written.map(([kind, text]) => [
    kind, text.split('\n').filter(Boolean).map(line => line.slice(line.indexOf('] ') + 2))
  ]);
  return { fsImpl, held, written, messages };
}

async function waitFor(condition) {
  for (let turn = 0; turn < 100 && !condition(); turn += 1) await new Promise(resolve => setImmediate(resolve));
  assert.ok(condition(), 'the background write started');
}

test('flushSync also writes a batch whose background append has not finished, ahead of newer lines', async () => {
  for (const outcome of ['written late', 'failed late']) {
    const { fsImpl, held, messages } = heldFs();
    const sink = createLogSink({ dir: 'X:\\logs', sanitize: identity, fsImpl, now: () => AT, retryDelayMs: 0 });
    sink.write({ message: 'A: update downloaded' });
    await waitFor(() => held.stat);
    held.stat();
    await waitFor(() => held.append);
    sink.write({ message: 'B: applying update, quitting' });

    sink.flushSync();
    assert.deepEqual(messages(), [['sync', ['A: update downloaded', 'B: applying update, quitting']]], outcome);
    sink.flushSync();
    assert.equal(messages().length, 1, `${outcome}: a second flushSync writes nothing again`);

    // The interrupted append may still land (a duplicate) or fail; either way
    // nothing is queued again and later lines follow normally.
    held.append(outcome === 'failed late' ? fsError('EIO') : undefined);
    await sink.flush();
    held.append = null;
    sink.write({ message: 'C: later' });
    await waitFor(() => held.append);
    held.append();
    await sink.flush();
    assert.deepEqual(messages().slice(1), [
      ...(outcome === 'written late' ? [['async', ['A: update downloaded']]] : []),
      ['async', ['C: later']]
    ], outcome);
  }
});

test('a batch flushSync wrote while rotation was checked is not appended again', async () => {
  const { fsImpl, held, messages } = heldFs();
  const sink = createLogSink({ dir: 'X:\\logs', sanitize: identity, fsImpl, now: () => AT });
  sink.write({ message: 'A' });
  await waitFor(() => held.stat);
  sink.flushSync();
  held.stat();
  await sink.flush();
  assert.equal(held.append, null, 'the background append never started');
  assert.deepEqual(messages(), [['sync', ['A']]]);
});

test('the log cursor accepts only plain non-negative integers', () => {
  assert.equal(parseLogCursor('0'), 0);
  assert.equal(parseLogCursor(' 42 '), 42);
  for (const value of [null, undefined, '', 'abc', '-1', '1.5', '1e3', '12345678901234567']) {
    assert.equal(parseLogCursor(value), null, String(value));
  }
});

test('a poll with a cursor receives only newer lines; without one, the whole ring', () => {
  const ring = [5, 6, 7, 8].map(Seq => ({ Seq, Time: '12:00:00', Color: 'Gray', Message: `m${Seq}` }));
  assert.deepEqual(selectLogsAfter(ring, null), ring);
  assert.notEqual(selectLogsAfter(ring, null), ring);
  assert.deepEqual(selectLogsAfter(ring, 6).map(entry => entry.Seq), [7, 8]);
  assert.deepEqual(selectLogsAfter(ring, 8), []);
  assert.deepEqual(selectLogsAfter(ring, 0).map(entry => entry.Seq), [5, 6, 7, 8]);
  // A cursor from an earlier process is answered with everything.
  assert.deepEqual(selectLogsAfter(ring, 900).map(entry => entry.Seq), [5, 6, 7, 8]);
  assert.deepEqual(selectLogsAfter([], 3), []);
  assert.equal(LOG_RING_LIMIT, 500);
});

function ringOf(messages) {
  return messages.map((Message, index) => ({ Seq: index + 1, Time: `t${index + 1}`, Color: 'Gray', Message }));
}

test('feedback logs add older connector and update lines to the general tail', () => {
  const messages = [];
  for (let index = 0; index < 300; index += 1) {
    if (index % 4 === 0) messages.push(`[连接器热更新] step ${index}`);
    else if (index === 201) messages.push('[更新] 下载失败');
    else if (index === 203) messages.push('[Velopack] apply failed');
    else messages.push(`弹幕 ${index}`);
  }
  const ring = ringOf(messages);
  const selected = selectFeedbackLogs(ring, { sanitize: identity });
  const times = selected.map(entry => entry.time);

  const tail = ring.slice(-80).map(entry => entry.Time);
  const older = ring.slice(0, -80).filter(entry => FEEDBACK_LOG_PATTERN.test(entry.Message)).slice(-40);
  assert.deepEqual(times, [...older.map(entry => entry.Time), ...tail]);
  assert.equal(new Set(times).size, times.length);
  assert.equal(selected.length, 120);
  assert.deepEqual(selected[selected.length - 1], { time: 't300', color: 'Gray', message: '弹幕 299' });

  const small = selectFeedbackLogs(ringOf(['[更新] a', 'b', '[连接器] c', 'd']), { sanitize: identity, tail: 2 });
  assert.deepEqual(small.map(entry => entry.message), ['[更新] a', '[连接器] c', 'd']);
});

test('every tag in the feedback filter is recognised', () => {
  for (const tag of ['连接器', '连接器热更新', '连接器更新', '连接器兼容恢复', '连接器重装', '更新', 'Velopack',
    '播放器桥', '网易云连接器更新', 'QQ 画像', '动态封面']) {
    assert.match(`[${tag}] message`, FEEDBACK_LOG_PATTERN, tag);
  }
  for (const text of ['[Bilibili] 已连接', '更新完成', '[连接器 x]']) {
    assert.doesNotMatch(text, FEEDBACK_LOG_PATTERN, text);
  }
});

test('feedback logs are sanitized and fit the byte budget, keeping tagged lines longest', () => {
  const ring = ringOf([
    '[更新] 失败 SESSDATA=secret',
    ...Array.from({ length: 60 }, (_, index) => `弹幕 ${index} ${'长'.repeat(300)}`),
    '[连接器] 最近的错误'
  ]);
  const selected = selectFeedbackLogs(ring, { sanitize: sanitizeFeedbackLog, maxBytes: 8 * 1024 });
  assert.ok(Buffer.byteLength(JSON.stringify(selected)) <= 8 * 1024);
  assert.equal(selected[0].message, '[更新] 失败 SESSDATA=[已隐藏]');
  assert.equal(selected[selected.length - 1].message, '[连接器] 最近的错误');
  const untagged = selected.filter(entry => entry.message.startsWith('弹幕'));
  assert.ok(untagged.length > 0 && untagged.length < 60);
  // The oldest untagged lines went first.
  assert.equal(untagged[untagged.length - 1].message.startsWith('弹幕 59 '), true);

  const tiny = selectFeedbackLogs(ring, { sanitize: identity, maxBytes: 2 });
  assert.deepEqual(tiny, []);
});

test('uncaught errors are logged with their stack', () => {
  const error = new Error('boom');
  assert.equal(describeErrorForLog(error), error.stack);
  const noStack = new Error('no stack');
  noStack.stack = '';
  assert.equal(describeErrorForLog(noStack), 'no stack');
  assert.equal(describeErrorForLog({ stack: 'custom stack', message: 'm' }), 'custom stack');
  assert.equal(describeErrorForLog({ message: 'only message' }), 'only message');
  assert.equal(describeErrorForLog('plain reason'), 'plain reason');
  assert.equal(describeErrorForLog(undefined), 'undefined');
  assert.equal(describeErrorForLog(Object.create(null)), '未知错误');
});

// ---------------------------------------------------------------------------
// main.ts: the log ring, the sink and the routes that read them
// ---------------------------------------------------------------------------

const transpile = source => ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 }
}).outputText;

function writeLogHarness() {
  const sinkEntries = [];
  const context = vm.createContext({
    sysLogs: [], nextLogSeq: 1, LOG_RING_LIMIT,
    logSink: { write: entry => sinkEntries.push(entry), flushSync() {} },
    console: { log() {}, error() {} },
    Date
  });
  vm.runInContext(transpile(extractFunctions('electron/main.ts', [
    'appendSysLog', 'writeLog', 'reportLogSinkError'
  ])), context);
  return { context, sinkEntries };
}

test('main numbers every log line, keeps the newest 500 and writes each to the log file', () => {
  const { context, sinkEntries } = writeLogHarness();
  for (let index = 1; index <= 600; index += 1) context.writeLog(`line ${index}`, index % 2 ? 'Gray' : 'Red');
  const ring = context.sysLogs;
  assert.equal(ring.length, LOG_RING_LIMIT);
  assert.deepEqual([ring[0].Seq, ring[499].Seq], [101, 600]);
  assert.ok(ring.every((entry, index) => index === 0 || entry.Seq === ring[index - 1].Seq + 1));
  assert.deepEqual(Object.keys(ring[0]).sort(), ['Color', 'Message', 'Seq', 'Time']);
  assert.equal(sinkEntries.length, 600);
  assert.deepEqual({ ...sinkEntries[599], at: 0 }, { message: 'line 600', color: 'Red', at: 0 });
  assert.equal(typeof sinkEntries[0].at, 'number');
  context.writeLog('default colour');
  assert.equal(ring[ring.length - 1].Color, 'Gray');
});

test('a failing log file is reported in the panel only, by error code', () => {
  const { context, sinkEntries } = writeLogHarness();
  const error = Object.assign(new Error("EACCES: permission denied, open 'C:\\Users\\someone\\AppData\\logs\\main.log'"), { code: 'EACCES' });
  context.reportLogSinkError(error);
  assert.equal(sinkEntries.length, 0);
  assert.equal(context.sysLogs.length, 1);
  assert.equal(context.sysLogs[0].Message, '[日志] 无法写入日志文件（EACCES）');
  assert.equal(context.sysLogs[0].Color, 'Yellow');
});

test('uncaught errors reach the log with their stack and are flushed to disk', () => {
  const handlers = {};
  const logs = [];
  let flushed = 0;
  const context = vm.createContext({
    process: { on: (name, handler) => { handlers[name] = handler; } },
    writeLog: (message, color) => logs.push({ message, color }),
    describeErrorForLog,
    logSink: { flushSync: () => { flushed += 1; } }
  });
  const main = readSource('electron/main.ts');
  vm.runInContext(transpile(sliceBetween(main, "process.on('uncaughtException'", 'let overlayWindow')), context);

  const crash = new Error('main exploded');
  handlers.uncaughtException(crash);
  assert.equal(logs[0].color, 'Red');
  assert.ok(logs[0].message.includes(crash.stack));
  assert.equal(flushed, 1);

  handlers.unhandledRejection(new Error('An object could not be cloned.'));
  assert.equal(logs.length, 1);
  const rejection = new TypeError('bad promise');
  handlers.unhandledRejection(rejection);
  assert.equal(logs[1].color, 'Yellow');
  assert.ok(logs[1].message.includes(rejection.stack));
  handlers.unhandledRejection(Object.create(null));
  assert.match(logs[2].message, /未知错误/);
});

test('main creates the sink before the first log line and serves numbered lines', () => {
  const main = readSource('electron/main.ts');
  const sink = main.indexOf('const logSink = createLogSink({');
  assert.ok(sink > main.indexOf('const sysLogs: SysLog[] = [];'));
  // The buffered Velopack lines are the first writeLog calls at start-up.
  assert.ok(sink < main.indexOf('for (const entry of velopackLogBuffer.splice(0))'));
  assert.ok(sink > main.indexOf("app.setPath('userData'"));
  const options = sliceBetween(main, 'const logSink = createLogSink({', '});');
  assert.match(options, /dir: path\.join\(app\.getPath\('userData'\), 'logs'\)/);
  assert.match(options, /sanitize: sanitizeFeedbackLog/);

  const route = sliceBetween(main, "if (url.pathname === '/api/logs') {", '\n    }\n');
  assert.match(route, /parseLogCursor\(url\.searchParams\.get\('after'\)\)/);
  assert.match(route, /selectLogsAfter\(sysLogs, after\)/);
  const feedback = extractFunctions('electron/main.ts', ['buildFeedbackContext']);
  assert.match(feedback, /diagnostics\.recentLogs = selectFeedbackLogs\(sysLogs, \{ sanitize: sanitizeFeedbackLog \}\)/);
  assert.doesNotMatch(main, /sysLogs\.slice\(-80\)|sysLogs\.length > 100/);
});
