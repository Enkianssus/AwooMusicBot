import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  isTransientFsLockError,
  removeStaleEntries,
  renameSyncWithRetry,
  renameWithRetry,
  rmWithRetry
} from '../electron/fs-retry.ts';

function fsError(code) {
  return Object.assign(new Error(`${code}: simulated`), { code });
}

// A fake fs whose operation fails with the queued codes before succeeding.
function failingFs(method, codes) {
  const calls = [];
  const queue = [...codes];
  return {
    calls,
    fsImpl: {
      [method]: async (...args) => {
        calls.push(args);
        const code = queue.shift();
        if (code) throw fsError(code);
      }
    }
  };
}

function recordingSleep() {
  const delays = [];
  return { delays, sleep: async milliseconds => { delays.push(milliseconds); } };
}

test('classifies only Windows lock codes as transient', () => {
  for (const code of ['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY', 'eperm']) {
    assert.equal(isTransientFsLockError(fsError(code)), true, code);
  }
  for (const value of [fsError('ENOENT'), fsError('EEXIST'), new Error('x'), null, 'EPERM']) {
    assert.equal(isTransientFsLockError(value), false, String(value?.code ?? value));
  }
});

test('rename retries EPERM twice with exponential backoff, then succeeds', async () => {
  const { calls, fsImpl } = failingFs('rename', ['EPERM', 'EPERM']);
  const { delays, sleep } = recordingSleep();
  await renameWithRetry('staging', 'version', { fsImpl, sleep });
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[2], ['staging', 'version']);
  assert.deepEqual(delays, [100, 200]);
});

test('ENOENT and other non-lock errors reject immediately', async () => {
  const { calls, fsImpl } = failingFs('rename', ['ENOENT']);
  const { delays, sleep } = recordingSleep();
  await assert.rejects(
    renameWithRetry('missing', 'version', { fsImpl, sleep }),
    error => error.code === 'ENOENT'
  );
  assert.equal(calls.length, 1);
  assert.deepEqual(delays, []);
});

test('gives up after the configured attempts and keeps the original error', async () => {
  const { calls, fsImpl } = failingFs('rm', Array(10).fill('EBUSY'));
  const { delays, sleep } = recordingSleep();
  await assert.rejects(
    rmWithRetry('locked', { attempts: 4, fsImpl, sleep }),
    error => error.code === 'EBUSY'
  );
  assert.equal(calls.length, 4);
  assert.deepEqual(delays, [100, 200, 400]);
  assert.deepEqual(calls[0], ['locked', { recursive: true, force: true }]);
});

test('backoff is capped at maxDelayMs', async () => {
  const { calls, fsImpl } = failingFs('rename', Array(9).fill('EACCES'));
  const { delays, sleep } = recordingSleep();
  await renameWithRetry('a', 'b', { fsImpl, sleep });
  assert.equal(calls.length, 10);
  assert.deepEqual(delays, [100, 200, 400, 800, 1000, 1000, 1000, 1000, 1000]);
});

test('synchronous rename retries locks without sleeping and stops at five attempts', () => {
  let calls = 0;
  renameSyncWithRetry('config.tmp', 'config.json', {
    fsImpl: { renameSync: () => { if (++calls < 3) throw fsError('EPERM'); } }
  });
  assert.equal(calls, 3);

  calls = 0;
  assert.throws(() => renameSyncWithRetry('config.tmp', 'config.json', {
    fsImpl: { renameSync: () => { calls++; throw fsError('EBUSY'); } }
  }), error => error.code === 'EBUSY');
  assert.equal(calls, 5);

  calls = 0;
  assert.throws(() => renameSyncWithRetry('config.tmp', 'config.json', {
    fsImpl: { renameSync: () => { calls++; throw fsError('ENOENT'); } }
  }), error => error.code === 'ENOENT');
  assert.equal(calls, 1);
});

test('stale sweep removes only old prefixed debris and never versions or active files', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'awoo-fs-retry-'));
  try {
    await fs.writeFile(path.join(root, '.download-1.2.3-ab.zip'), 'partial');
    await fs.mkdir(path.join(root, '.staging-1.2.3-ab', 'nested'), { recursive: true });
    await fs.mkdir(path.join(root, '.backup-1.2.3-ab'));
    await fs.mkdir(path.join(root, '1.2.3'));
    await fs.writeFile(path.join(root, 'active.json'), '{}');
    await fs.writeFile(path.join(root, 'active.json.1.tmp'), '{}');
    const options = {
      prefixes: ['.download-', '.staging-', '.backup-'],
      maxAgeMs: 60 * 60 * 1000
    };

    const fresh = await removeStaleEntries(root, options);
    assert.deepEqual(fresh, { removed: [], failed: [] });

    const later = await removeStaleEntries(root, {
      ...options,
      now: Date.now() + 2 * 60 * 60 * 1000
    });
    assert.deepEqual(later.removed.sort(), [
      '.backup-1.2.3-ab',
      '.download-1.2.3-ab.zip',
      '.staging-1.2.3-ab'
    ]);
    assert.deepEqual(later.failed, []);
    assert.deepEqual((await fs.readdir(root)).sort(), [
      '1.2.3',
      'active.json',
      'active.json.1.tmp'
    ]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('stale sweep of a missing directory is a no-op', async () => {
  const missing = path.join(os.tmpdir(), `awoo-fs-retry-missing-${process.pid}-${Date.now()}`);
  assert.deepEqual(
    await removeStaleEntries(missing, { prefixes: ['.staging-'], maxAgeMs: 0 }),
    { removed: [], failed: [] }
  );
});
