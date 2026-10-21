import test from 'node:test';
import assert from 'node:assert/strict';
import { getFeedbackStatus, sanitizeFeedbackLog } from '../electron/feedback-service.ts';

test('queries the public feedback endpoint without requiring a success field', async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = '';
  globalThis.fetch = async url => {
    requestedUrl = String(url);
    return new Response(JSON.stringify({
      id: 'FB-20260809-ABCDEF12',
      createdAt: '2026-08-09T10:00:00.000Z',
      updatedAt: '2026-08-09T10:05:00.000Z',
      category: 'bug',
      status: 'working',
      title: '播放器没有响应',
      reply: '正在排查。'
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  };
  try {
    const result = await getFeedbackStatus(' fb-20260809-abcdef12 ');
    assert.equal(
      requestedUrl,
      'https://app.enkianss.us/api/v1/feedback/FB-20260809-ABCDEF12'
    );
    assert.equal(result.reply, '正在排查。');
    assert.equal(result.status, 'working');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('rejects an invalid feedback id before requesting the network', async () => {
  const originalFetch = globalThis.fetch;
  let requested = false;
  globalThis.fetch = async () => {
    requested = true;
    return new Response('{}');
  };
  try {
    await assert.rejects(
      () => getFeedbackStatus('../private'),
      /问题编号格式无效/
    );
    assert.equal(requested, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Windows profile paths lose the account name in backslash and file URL forms', () => {
  for (const [input, expected] of [
    [
      "EACCES: permission denied, open 'C:\\Users\\张三\\AppData\\Roaming\\嗷呜点歌机\\logs\\main.log'",
      "EACCES: permission denied, open 'C:\\Users\\<用户>\\AppData\\Roaming\\嗷呜点歌机\\logs\\main.log'"
    ],
    [
      '    at run (file:///C:/Users/Admin/AppData/Local/AwooMusicBot/current/resources/app.asar/dist-electron/main.js:10:5)',
      '    at run (file:///C:/Users/<用户>/AppData/Local/AwooMusicBot/current/resources/app.asar/dist-electron/main.js:10:5)'
    ],
    ['at x (c:\\users\\John Smith\\Desktop\\a.js:1:1)', 'at x (c:\\users\\<用户>\\Desktop\\a.js:1:1)'],
    ["cwd C:\\Users\\O'Brien\\code", 'cwd C:\\Users\\<用户>\\code'],
    ['file:///D:/USERS/%E5%BC%A0%E4%B8%89/x.js', 'file:///D:/USERS/<用户>/x.js'],
    ['{"path":"C:\\\\Users\\\\bob\\\\Music"}', '{"path":"C:\\\\Users\\\\<用户>\\\\Music"}'],
    ['\\\\?\\C:\\Users\\bob\\x', '\\\\?\\C:\\Users\\<用户>\\x'],
    // A path that ends at the name keeps the rest of the message.
    ['home is C:\\Users\\bob and more\nnext C:\\Users\\eve', 'home is C:\\Users\\<用户> and more\nnext C:\\Users\\<用户>'],
    ["open 'C:\\Users\\bob' failed", "open 'C:\\Users\\<用户>' failed"]
  ]) {
    assert.equal(sanitizeFeedbackLog(input), expected, input);
  }
  for (const untouched of ['D:\\Music\\Users\\list.txt', 'https://api.example.com/users/42', 'C:\\Program Files\\嗷呜点歌机']) {
    assert.equal(sanitizeFeedbackLog(untouched), untouched);
  }
});

test('the profile path redaction keeps the cookie and token redactions and the length limit', () => {
  assert.equal(
    sanitizeFeedbackLog("SESSDATA=secret; bili_jct=csrf open 'C:\\Users\\bob\\a' GET /x?token=abc&y=1"),
    "SESSDATA=[已隐藏]; bili_jct=[已隐藏] open 'C:\\Users\\<用户>\\a' GET /x?token=[已隐藏]&y=1"
  );
  assert.equal(sanitizeFeedbackLog(`C:\\Users\\bob\\${'x'.repeat(2000)}`).length, 1200);
  assert.ok(sanitizeFeedbackLog(`C:\\Users\\bob\\${'x'.repeat(2000)}`).startsWith('C:\\Users\\<用户>\\x'));
});
