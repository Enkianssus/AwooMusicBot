import type { PlayerBridgeClient, PlayerTrack } from '../player-bridge-client';
import { NativePlayerBackend } from './native-player';

const NETEASE_DETAIL_ENDPOINT =
  'https://music.163.com/api/song/detail/';

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
  const response = await fetch(
    `${NETEASE_DETAIL_ENDPOINT}?id=${encodeURIComponent(songId)}`
      + `&ids=${encodeURIComponent(`[${songId}]`)}`,
    {
      signal: AbortSignal.timeout(8000),
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Cookie': 'os=pc; appver=3.1.37;',
        ...getChinaBypassHeaders()
      }
    }
  );
  if (!response.ok) {
    throw new Error(`网易云歌曲详情请求失败（HTTP ${response.status}）`);
  }
  return (await response.json())?.songs?.[0] || null;
}

function toNeteaseTrack(song: any, fallbackId: string): PlayerTrack {
  return {
    id: String(song?.id || fallbackId),
    title: song?.name || `ID点歌: ${fallbackId}`,
    artist: song?.artists?.map((artist: any) => artist?.name).filter(Boolean).join('/')
      || song?.ar?.map((artist: any) => artist?.name).filter(Boolean).join('/')
      || '未知歌手',
    album: song?.album?.name || song?.al?.name || '',
    coverUrl: song?.album?.picUrl || song?.al?.picUrl || '',
    nativeData: ''
  };
}

export async function getNeteaseSongCover(songId: string): Promise<string> {
  try {
    const song = await fetchNeteaseSong(String(songId || ''));
    return song?.album?.picUrl || song?.al?.picUrl || '';
  } catch {
    return '';
  }
}

export class NeteasePlayerBackend extends NativePlayerBackend {
  constructor(bridge: PlayerBridgeClient) {
    super('netease', '网易云音乐', bridge);
  }

  override async search(query: string): Promise<PlayerTrack[]> {
    const originalQuery = query.trim();
    const idMatch = originalQuery.match(/^(?:id\s*=\s*)?(\d+)$/i);
    if (!idMatch) {
      return await super.search(originalQuery);
    }

    const keywordSearch = super.search(idMatch[1]).then(
      tracks => ({ tracks, error: null as unknown }),
      error => ({ tracks: [] as PlayerTrack[], error })
    );
    try {
      const song = await fetchNeteaseSong(idMatch[1]);
      if (song?.id && song?.name) {
        return [toNeteaseTrack(song, idMatch[1])];
      }
    } catch {
      // Numeric song titles are valid search text too. The keyword request is
      // already running in parallel, so an invalid ID has no second wait.
    }

    const keywordResult = await keywordSearch;
    if (keywordResult.error) throw keywordResult.error;
    return keywordResult.tracks;
  }
}
