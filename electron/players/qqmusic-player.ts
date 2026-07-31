import type { PlayerBridgeClient, PlayerTrack } from '../player-bridge-client';
import { NativePlayerBackend } from './native-player';

const QQ_SHARE_BASE = 'https://c6.y.qq.com/base/fcgi-bin/u?__=';
const QQ_DETAIL_ENDPOINT =
  'https://c.y.qq.com/v8/fcg-bin/fcg_play_single_song.fcg';

interface QqShareReference {
  kind: 'songid' | 'songmid';
  value: string;
}

interface QqLookupCandidate {
  reference?: QqShareReference;
  shareUrl?: string;
}

function findQqShareUrl(input: string): string | null {
  const trimmed = input.trim();
  const fullMatch = trimmed.match(
    /https?:\/\/c6\.y\.qq\.com\/base\/fcgi-bin\/u\?__=([A-Za-z0-9_-]+)/i
  );
  if (fullMatch) return fullMatch[0];

  const shortMatch = trimmed.match(
    /(?:^|\s)(?:u\?__=|c6\.y\.qq\.com\/base\/fcgi-bin\/u\?__=)([A-Za-z0-9_-]+)/i
  );
  return shortMatch ? `${QQ_SHARE_BASE}${shortMatch[1]}` : null;
}

function parseDirectQqReference(input: string): QqShareReference | null {
  const routeMatch = input.match(
    /(?:y\.qq\.com\/(?:n\/)?ryqq(?:_v2)?\/songDetail\/)([A-Za-z0-9]+)/i
  );
  const explicitId = input.match(/^id\s*=\s*([A-Za-z0-9]+)\s*$/i);
  const value = routeMatch?.[1] || explicitId?.[1];
  if (!value) return null;
  return {
    kind: /^\d+$/.test(value) ? 'songid' : 'songmid',
    value
  };
}

async function resolveQqShareReference(
  query: string
): Promise<QqShareReference | null> {
  const direct = parseDirectQqReference(query);
  if (direct) return direct;

  const shareUrl = findQqShareUrl(query);
  if (!shareUrl) return null;

  const response = await fetch(shareUrl, {
    redirect: 'follow',
    signal: AbortSignal.timeout(8000),
    headers: {
      'User-Agent': 'Mozilla/5.0',
      'Referer': 'https://y.qq.com/'
    }
  });
  if (!response.ok) {
    throw new Error(`QQ 分享链接解析失败（HTTP ${response.status}）`);
  }

  const reference = parseDirectQqReference(response.url);
  if (!reference) {
    throw new Error('QQ 分享链接已打开，但未找到歌曲 songID/songMID');
  }
  return reference;
}

function getQqLookupCandidates(query: string): QqLookupCandidate[] {
  const trimmed = query.trim();
  const direct = parseDirectQqReference(trimmed);
  if (direct) {
    const explicitValue = trimmed.match(
      /^id\s*=\s*([A-Za-z0-9_-]+)\s*$/i
    )?.[1];
    const candidates: QqLookupCandidate[] = [{ reference: direct }];
    if (explicitValue && /^[A-Za-z0-9_-]{12}$/.test(explicitValue)) {
      candidates.push({ shareUrl: `${QQ_SHARE_BASE}${explicitValue}` });
    }
    return candidates;
  }

  const shareUrl = findQqShareUrl(trimmed);
  if (shareUrl) {
    return [{ shareUrl }];
  }

  if (/^\d+$/.test(trimmed)) {
    return [{ reference: { kind: 'songid', value: trimmed } }];
  }

  // QQ short share codes are currently 12 characters. A songMid is commonly
  // 14 characters; explicit id= keeps accepting other compatible lengths.
  if (/^[A-Za-z0-9_-]{12}$/.test(trimmed)) {
    return [
      { shareUrl: `${QQ_SHARE_BASE}${trimmed}` },
      { reference: { kind: 'songmid', value: trimmed } }
    ];
  }

  if (/^[A-Za-z0-9]{14}$/.test(trimmed)) {
    return [{ reference: { kind: 'songmid', value: trimmed } }];
  }

  return [];
}

async function resolveQqCandidate(
  candidate: QqLookupCandidate
): Promise<QqShareReference | null> {
  if (candidate.reference) return candidate.reference;
  if (!candidate.shareUrl) return null;
  return await resolveQqShareReference(candidate.shareUrl);
}

function readQqArtist(song: any): string {
  return Array.isArray(song?.singer)
    ? song.singer.map((singer: any) => singer?.name).filter(Boolean).join(' / ')
    : '';
}

async function fetchQqTrack(
  reference: QqShareReference
): Promise<PlayerTrack | null> {
  const parameters = new URLSearchParams({
    [reference.kind]: reference.value,
    tpl: 'yqq_song_detail',
    format: 'json'
  });
  const response = await fetch(`${QQ_DETAIL_ENDPOINT}?${parameters}`, {
    signal: AbortSignal.timeout(8000),
    headers: {
      'User-Agent': 'Mozilla/5.0 QQMusicControl/1.1.0',
      'Referer': 'https://y.qq.com/'
    }
  });
  if (!response.ok) {
    throw new Error(`QQ 歌曲详情请求失败（HTTP ${response.status}）`);
  }

  const song = (await response.json())?.data?.[0];
  if (!song?.id || !song?.mid || !song?.name) return null;

  const albumMid = String(song?.album?.mid || '').trim();
  const switchValue = Number(song?.action?.switch);
  const isPlayable = !Number.isFinite(switchValue)
    || (switchValue & 1) !== 0;
  return {
    id: String(song.id),
    title: String(song.name),
    artist: readQqArtist(song),
    album: song?.album?.name || '',
    coverUrl: albumMid
      ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${albumMid}.jpg`
      : '',
    nativeData: JSON.stringify({
      SongId: Number(song.id),
      SongType: Number(song.type || 0),
      SongMid: String(song.mid),
      IsPlayable: isPlayable
    })
  };
}

export class QQMusicPlayerBackend extends NativePlayerBackend {
  constructor(bridge: PlayerBridgeClient) {
    super('qqmusic', 'QQ 音乐', bridge);
  }

  override async search(query: string): Promise<PlayerTrack[]> {
    const originalQuery = query.trim();
    const candidates = getQqLookupCandidates(originalQuery);
    if (candidates.length === 0) {
      return await super.search(originalQuery);
    }

    const keywordSearch = super.search(originalQuery).then(
      tracks => ({ tracks, error: null as unknown }),
      error => ({ tracks: [] as PlayerTrack[], error })
    );
    const exactLookups = candidates.map(async candidate => {
      try {
        const reference = await resolveQqCandidate(candidate);
        return reference ? await fetchQqTrack(reference) : null;
      } catch {
        return null;
      }
    });
    const exactResults = await Promise.all(exactLookups);
    const exactTrack = exactResults.find(
      (track): track is PlayerTrack => track !== null
    );
    if (exactTrack) return [exactTrack];

    const keywordResult = await keywordSearch;
    if (keywordResult.error) throw keywordResult.error;
    return keywordResult.tracks;
  }
}
