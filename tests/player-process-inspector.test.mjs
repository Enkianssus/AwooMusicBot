import assert from 'node:assert/strict';
import test from 'node:test';
import ts from 'typescript';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(
  new URL('../electron/player-process-inspector.ts', import.meta.url),
  'utf8'
);
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022
  }
}).outputText;
const module = { exports: {} };
let execInvocation = null;
vm.runInNewContext(compiled, {
  module,
  exports: module.exports,
  require: request => {
    if (request === 'node:child_process') {
      return { execFile: (...args) => {
        execInvocation = args;
        args[3](null, '[]');
      } };
    }
    if (request === 'node:path') {
      const path = { join: (...parts) => parts.join('\\') };
      return { ...path, default: path };
    }
    throw new Error(`unexpected require: ${request}`);
  },
  process: { platform: 'win32' }
});
const {
  inspectPlayerProcess,
  parsePlayerProcessOutput
} = module.exports;

test('parses a single Windows player process and its file version', () => {
  assert.equal(
    JSON.stringify(parsePlayerProcessOutput(
      '\uFEFF{"processId":45592,"path":"D:\\\\CloudMusic\\\\cloudmusic.exe",'
        + '"version":"3.1.38.205386"}'
    )),
    JSON.stringify({
      running: true,
      processId: 45592,
      version: '3.1.38.205386',
      executablePath: 'D:\\CloudMusic\\cloudmusic.exe',
      querySucceeded: true
    })
  );
});

test('handles no matching process without treating it as a query failure', () => {
  assert.equal(
    JSON.stringify(parsePlayerProcessOutput('[]')),
    JSON.stringify({
      running: false,
      processId: null,
      version: null,
      executablePath: null,
      querySucceeded: true
    })
  );
  assert.equal(parsePlayerProcessOutput('').querySucceeded, true);
});

test('rejects malformed or unusable process rows', () => {
  assert.equal(parsePlayerProcessOutput('{"processId":"0"}').running, false);
  assert.equal(parsePlayerProcessOutput('{not-json}').querySucceeded, false);
});

test('does not issue a local-player query for Folia', async () => {
  let called = false;
  const result = await inspectPlayerProcess('folia', async () => {
    called = true;
    return '[]';
  });
  assert.equal(called, false);
  assert.equal(result.running, false);
  assert.equal(result.querySucceeded, false);
});

test('keeps the injected query runner testable', async () => {
  const result = await inspectPlayerProcess(
    'qqmusic',
    async script => {
      assert.match(script, /Get-Process -Name 'QQMusic'/);
      return '{"processId":321,"path":"C:\\\\QQMusic\\\\QQMusic.exe",'
        + '"version":"22.60.1.0"}';
    }
  );
  assert.equal(
    JSON.stringify(result),
    JSON.stringify({
      running: true,
      processId: 321,
      version: '22.60.1.0',
      executablePath: 'C:\\QQMusic\\QQMusic.exe',
      querySucceeded: true
    })
  );
});

test('uses a bounded absolute Windows PowerShell query', async () => {
  execInvocation = null;
  const result = await inspectPlayerProcess('qqmusic');
  assert.equal(result.querySucceeded, true);
  assert.match(execInvocation[0], /System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/i);
  assert.equal(execInvocation[2].windowsHide, true);
  assert.equal(execInvocation[2].encoding, 'utf8');
  assert.equal(execInvocation[2].timeout, 8000);
  assert.equal(execInvocation[2].maxBuffer, 128 * 1024);
  assert.match(execInvocation[1][execInvocation[1].length - 1], /OutputEncoding/);
});
