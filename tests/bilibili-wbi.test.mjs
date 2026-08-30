import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  buildBiliWbiSignedUrl,
  deriveBiliWbiMixinKey,
  fetchBiliDanmuInfoWithFallback,
  fetchBiliWbiKeys,
  parseBiliWbiKeys
} from '../electron/bili-wbi.ts';

test('derives WBI keys from the current nav image URLs', () => {
  const imgKey = '1234567890abcdef1234567890abcdef';
  const subKey = 'fedcba0987654321fedcba0987654321';
  const result = parseBiliWbiKeys({
    code: 0,
    data: {
      wbi_img: {
        img_url: `https://i0.hdslb.com/bfs/wbi/${imgKey}.png`,
        sub_url: `https://i0.hdslb.com/bfs/wbi/${subKey}.png`
      }
    }
  });

  assert.deepEqual(result, {
    imgKey,
    subKey,
    mixinKey: deriveBiliWbiMixinKey(imgKey, subKey)
  });
  assert.equal(parseBiliWbiKeys({ code: 0, data: {} }), null);
  assert.equal(parseBiliWbiKeys({ code: -403, data: 'blocked' }), null);
});

test('matches the published WBI mixin and signature vector', () => {
  const imgKey = '7cd084941338484aae1ad9425b84077c';
  const subKey = '4932caff0ff746eab6f01bf08b70ac45';
  const keys = parseBiliWbiKeys({
    data: {
      wbi_img: {
        img_url: `https://i0.hdslb.com/bfs/wbi/${imgKey}.png`,
        sub_url: `https://i0.hdslb.com/bfs/wbi/${subKey}.png`
      }
    }
  });
  assert.equal(keys?.mixinKey, 'ea1db124af3c7062474693fa704f4ff8');

  const signedUrl = buildBiliWbiSignedUrl(
    'https://api.bilibili.com/x/web-interface/example',
    { foo: '114', bar: '514', zab: 1919810 },
    keys,
    1_702_204_169
  );
  assert.equal(
    new URL(signedUrl).searchParams.get('w_rid'),
    '8f6f2b5b3d485fe1886cec6a0be8c5d4'
  );
});

test('fetches WBI material without requiring or exposing a login cookie', async () => {
  const requested = [];
  const keys = await fetchBiliWbiKeys(async (url, init) => {
    requested.push({ url: String(url), init });
    return new Response(JSON.stringify({
      code: 0,
      data: {
        wbi_img: {
          img_url: 'https://i0.hdslb.com/bfs/wbi/1234567890abcdef1234567890abcdef.png',
          sub_url: 'https://i0.hdslb.com/bfs/wbi/fedcba0987654321fedcba0987654321.png'
        }
      }
    }), { status: 200 });
  }, { headers: { 'User-Agent': 'Mozilla/5.0' } });

  assert.equal(keys.imgKey, '1234567890abcdef1234567890abcdef');
  assert.equal(keys.subKey, 'fedcba0987654321fedcba0987654321');
  assert.equal(requested.length, 1);
  assert.equal(requested[0].url, 'https://api.bilibili.com/x/web-interface/nav');
  assert.deepEqual(requested[0].init.headers, { 'User-Agent': 'Mozilla/5.0' });
});

test('fails closed when WBI material is unavailable and does not echo response secrets', async () => {
  const cookie = 'SESSDATA=do-not-log-this-value';
  await assert.rejects(
    () => fetchBiliWbiKeys(async () => new Response(cookie, { status: 403 })),
    error => {
      assert.match(String(error), /WBI 导航接口 HTTP 403/);
      assert.doesNotMatch(String(error), /do-not-log-this-value/);
      return true;
    }
  );

  await assert.rejects(
    () => fetchBiliWbiKeys(async () => new Response(JSON.stringify({ code: -352, data: {} }), { status: 200 })),
    /WBI 导航接口缺少签名材料/
  );
});

test('falls back to the legacy room token when WBI is unavailable', async () => {
  const requested = [];
  const notices = [];
  const result = await fetchBiliDanmuInfoWithFallback(async url => {
    const requestedUrl = String(url);
    requested.push(requestedUrl);
    if (requestedUrl.includes('/x/web-interface/nav')) {
      return new Response(JSON.stringify({ code: -352, data: {} }), { status: 200 });
    }
    if (requestedUrl.includes('/xlive/web-room/v1/index/getDanmuInfo')) {
      return new Response(JSON.stringify({ code: -352, data: {} }), { status: 200 });
    }
    assert.match(requestedUrl, /room\/v1\/Danmu\/getConf/);
    return new Response(JSON.stringify({
      code: 0,
      data: {
        token: 'legacy-room-token',
        host_list: [{ host: 'broadcastlv.chat.bilibili.com', wss_port: 443 }]
      }
    }), { status: 200 });
  }, 1871510762, {
    onWbiFailure: message => notices.push(message)
  });

  assert.equal(result.data.token, 'legacy-room-token');
  assert.deepEqual(requested, [
    'https://api.bilibili.com/x/web-interface/nav',
    'https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo?id=1871510762&type=0',
    'https://api.live.bilibili.com/room/v1/Danmu/getConf?room_id=1871510762&platform=pc&player=web'
  ]);
  assert.deepEqual(notices, ['WBI 导航接口缺少签名材料，code=-352']);
});

test('tries unsigned getDanmuInfo before getConf when signed WBI fails', async () => {
  const requested = [];
  const imgKey = '1234567890abcdef1234567890abcdef';
  const subKey = 'fedcba0987654321fedcba0987654321';
  const result = await fetchBiliDanmuInfoWithFallback(async url => {
    const requestedUrl = String(url);
    requested.push(requestedUrl);
    if (requestedUrl.includes('/x/web-interface/nav')) {
      return new Response(JSON.stringify({
        code: 0,
        data: {
          wbi_img: {
            img_url: `https://i0.hdslb.com/bfs/wbi/${imgKey}.png`,
            sub_url: `https://i0.hdslb.com/bfs/wbi/${subKey}.png`
          }
        }
      }), { status: 200 });
    }
    if (requestedUrl.includes('/xlive/web-room/v1/index/getDanmuInfo')) {
      if (requestedUrl.includes('w_rid=')) {
        return new Response(JSON.stringify({ code: -352, data: {} }), { status: 200 });
      }
      return new Response(JSON.stringify({ code: 0, data: { token: 'unsigned-room-token' } }), { status: 200 });
    }
    throw new Error('getConf should not be reached');
  }, 1871510762);

  assert.equal(result.data.token, 'unsigned-room-token');
  assert.equal(requested.length, 3);
  assert.match(requested[1], /w_rid=/);
  assert.equal(
    requested[2],
    'https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo?id=1871510762&type=0'
  );
});

test('builds the signed getDanmuInfo URL with sorted parameters and w_rid', () => {
  const mixinKey = 'private-mixin-key';
  const signedUrl = buildBiliWbiSignedUrl(
    'https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo',
    { id: 1871510762, type: 0, web_location: '444.8', ignored: 'a b!' },
    { mixinKey },
    1_700_000_000
  );
  const parsed = new URL(signedUrl);

  assert.equal(parsed.searchParams.get('id'), '1871510762');
  assert.equal(parsed.searchParams.get('type'), '0');
  assert.equal(parsed.searchParams.get('web_location'), '444.8');
  assert.equal(parsed.searchParams.get('ignored'), 'a b');
  assert.equal(parsed.searchParams.get('wts'), '1700000000');

  const query = 'id=1871510762&ignored=a%20b&type=0&web_location=444.8&wts=1700000000';
  const expectedRid = createHash('md5')
    .update(`${query}${mixinKey}`, 'utf8')
    .digest('hex');
  assert.equal(parsed.searchParams.get('w_rid'), expectedRid);
  assert.doesNotMatch(signedUrl, /private-mixin-key/);
});

test('uses WBI signed getDanmuInfo before the legacy compatibility endpoint', async () => {
  const [mainSource, wbiSource] = await Promise.all([
    readFile(new URL('../electron/main.ts', import.meta.url), 'utf8'),
    readFile(new URL('../electron/bili-wbi.ts', import.meta.url), 'utf8')
  ]);
  assert.match(mainSource, /fetchBiliDanmuInfoWithFallback\(/);
  assert.match(wbiSource, /getDanmuInfo/);
  assert.match(wbiSource, /onWbiFailure/);
  assert.match(wbiSource, /room\/v1\/Danmu\/getConf/);
  assert.doesNotMatch(mainSource, /writeLog\([^\n]*biliCookie/);
});
