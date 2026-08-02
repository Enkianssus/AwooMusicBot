export type NeteaseSongQuery =
  | { kind: 'keyword'; query: string }
  | { kind: 'explicit-id'; songId: string }
  | { kind: 'suspected-id'; songId: string; keyword: string };

const NETEASE_EXPLICIT_ID_PATTERN = /^id\s*=\s*([0-9]{1,19})$/i;
const NETEASE_SUSPECTED_ID_PATTERN = /^[0-9]{6,19}$/;

export function classifyNeteaseSongQuery(input: string): NeteaseSongQuery {
  const query = input.trim();
  const explicit = query.match(NETEASE_EXPLICIT_ID_PATTERN);
  if (explicit) {
    return { kind: 'explicit-id', songId: explicit[1] };
  }
  if (NETEASE_SUSPECTED_ID_PATTERN.test(query)) {
    return { kind: 'suspected-id', songId: query, keyword: query };
  }
  return { kind: 'keyword', query };
}

const QQ_SHARE_BASE = 'https://c6.y.qq.com/base/fcgi-bin/u?__=';
const QQ_SHARE_CODE_PATTERN = /^(?=.*[A-Za-z])(?=.*[0-9])[A-Za-z0-9]{12}$/;

export function findQqShareUrl(input: string): string | null {
  const query = input.trim();
  const full = query.match(
    /https?:\/\/c6\.y\.qq\.com\/base\/fcgi-bin\/u\?__=([A-Za-z0-9_-]{6,32})/i
  );
  if (full) return full[0];

  const short = query.match(
    /^(?:u\?__=|c6\.y\.qq\.com\/base\/fcgi-bin\/u\?__=)([A-Za-z0-9_-]{6,32})$/i
  );
  if (short) return `${QQ_SHARE_BASE}${short[1]}`;

  return QQ_SHARE_CODE_PATTERN.test(query)
    ? `${QQ_SHARE_BASE}${query}`
    : null;
}
