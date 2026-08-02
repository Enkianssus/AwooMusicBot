import type { PlayerBridgeClient, PlayerTrack } from '../player-bridge-client';
import { selectQqArtworkCover } from '../qqmusic-artwork';
import { findQqShareUrl } from '../song-query-policy';
import { NativePlayerBackend } from './native-player';

const QQ_DETAIL_ENDPOINT =
  'https://c.y.qq.com/v8/fcg-bin/fcg_play_single_song.fcg';

interface QqShareReference {
  kind: 'songid' | 'songmid';
  value: string;
}

interface QqLookupCandidate {
  shareUrl: string;
}

function parseDirectQqReference(input: string): QqShareReference | null {
  const routeMatch = input.match(
    /(?:y\.qq\.com\/(?:n\/)?ryqq(?:_v2)?\/songDetail\/)([A-Za-z0-9]+)/i
  );
  const value = routeMatch?.[1];
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
  const shareUrl = findQqShareUrl(query);
  return shareUrl ? [{ shareUrl }] : [];
}

async function resolveQqCandidate(
  candidate: QqLookupCandidate
): Promise<QqShareReference | null> {
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
    if (exactTrack) {
      if (exactTrack.coverUrl) return [exactTrack];

      const artworkQuery = [exactTrack.title, exactTrack.artist]
        .filter(Boolean)
        .join(' ');
      const artworkCandidates = artworkQuery
        ? await super.search(artworkQuery).catch(() => [])
        : [];
      return [{
        ...exactTrack,
        coverUrl: selectQqArtworkCover(exactTrack, artworkCandidates)
      }];
    }

    const keywordResult = await keywordSearch;
    if (keywordResult.error) throw keywordResult.error;
    return keywordResult.tracks;
  }
}
