import type { PlayerBridgeClient } from '../player-bridge-client';
import { buildNeteaseCoverUrlFromPicId } from '../netease-cover';
import { NativePlayerBackend } from './native-player';

const NETEASE_DETAIL_ENDPOINT =
  'https://music.163.com/api/v3/song/detail';

function readNeteaseCover(song: any): string {
  const album = song?.album || song?.al || {};
  const direct = album?.picUrl
    || album?.blurPicUrl
    || album?.coverUrl
    || album?.cover
    || '';
  if (direct) return String(direct).replace(/^http:\/\//i, 'https://');
  return buildNeteaseCoverUrlFromPicId(
    album?.picId_str || album?.pic_str || album?.picId
  );
}

function getChinaBypassHeaders(): Record<string, string> {
  const chinaIps = [
    '218.75.111.114',
    '111.206.176.1',
    '112.12.12.12',
    '223.5.5.5'
  ];
  const fakeIp = chinaIps[Math.floor(Math.random() * chinaIps.length)];
  return {
    'X-Real-IP': fakeIp,
    'X-Forwarded-For': fakeIp
  };
}

async function fetchNeteaseSong(songId: string): Promise<any | null> {
  if (!/^[0-9]{1,19}$/.test(songId)) return null;
  const detailPayload = encodeURIComponent(`[{"id":${songId}}]`);
  const response = await fetch(
    `${NETEASE_DETAIL_ENDPOINT}?c=${detailPayload}`,
    {
      signal: AbortSignal.timeout(8000),
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Referer': 'https://music.163.com/',
        'Cookie': 'os=pc; appver=3.1.37;',
        ...getChinaBypassHeaders()
      }
    }
  );
  if (!response.ok) {
    throw new Error(`网易云歌曲详情请求失败（HTTP ${response.status}）`);
  }
  const payload = await response.json();
  if (payload?.code !== undefined && Number(payload.code) !== 200) {
    throw new Error(
      `网易云歌曲详情请求失败（业务码 ${payload.code}）`
    );
  }
  return Array.isArray(payload?.songs)
    ? payload.songs.find((song: any) => String(song?.id || '') === songId)
      || null
    : null;
}

export async function getNeteaseSongCover(songId: string): Promise<string> {
  try {
    const song = await fetchNeteaseSong(String(songId || ''));
    return readNeteaseCover(song);
  } catch {
    return '';
  }
}

export class NeteasePlayerBackend extends NativePlayerBackend {
  constructor(bridge: PlayerBridgeClient) {
    super('netease', '网易云音乐', bridge);
  }
}
