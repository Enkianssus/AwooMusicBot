import { createHash } from 'crypto';

/**
 * The WBI mixin-key permutation published by Bilibili's web client.
 *
 * Keep this implementation independent from Electron so the signing rules
 * can be tested without starting the application or making a live request.
 */
const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32,
  15, 50, 10, 31, 58, 3, 45, 35,
  27, 43, 5, 49, 33, 9, 42, 19,
  29, 28, 14, 39, 12, 38, 41, 13,
  37, 48, 7, 16, 24, 55, 40, 61,
  26, 17, 0, 1, 60, 51, 30, 4,
  22, 25, 54, 21, 56, 59, 6, 63,
  57, 62, 11, 36, 20, 34, 44, 52
] as const;

export interface BiliWbiKeys {
  imgKey: string;
  subKey: string;
  mixinKey: string;
}

export interface BiliWbiFetchOptions {
  headers?: Record<string, string>;
  navUrl?: string;
}

export interface BiliDanmuInfoFetchOptions {
  headers?: Record<string, string>;
  onWbiFailure?: (message: string) => void;
  navUrl?: string;
}

type Fetcher = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>;

function getWbiFileKey(rawUrl: unknown): string {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) return '';

  try {
    const pathname = new URL(rawUrl).pathname;
    const filename = pathname.split('/').pop() || '';
    return filename.replace(/\.[^.]+$/, '');
  } catch {
    const filename = rawUrl.split(/[?#]/)[0].split('/').pop() || '';
    return filename.replace(/\.[^.]+$/, '');
  }
}

export function deriveBiliWbiMixinKey(imgKey: string, subKey: string): string {
  const rawKey = `${imgKey}${subKey}`;
  return MIXIN_KEY_ENC_TAB
    .map(index => rawKey[index] || '')
    .join('')
    .slice(0, 32);
}

/**
 * Extract the current signing material from `/x/web-interface/nav`.
 * Returning null for malformed data lets callers deliberately choose the
 * legacy endpoint instead of accidentally sending an unsigned request.
 */
export function parseBiliWbiKeys(navData: unknown): BiliWbiKeys | null {
  if (!navData || typeof navData !== 'object') return null;

  const data = (navData as { data?: unknown }).data;
  if (!data || typeof data !== 'object') return null;

  const wbiImg = (data as {
    wbi_img?: { img_url?: unknown; sub_url?: unknown };
  }).wbi_img;
  const imgKey = getWbiFileKey(wbiImg?.img_url);
  const subKey = getWbiFileKey(wbiImg?.sub_url);
  if (imgKey.length !== 32 || subKey.length !== 32) return null;

  const mixinKey = deriveBiliWbiMixinKey(imgKey, subKey);
  return mixinKey ? { imgKey, subKey, mixinKey } : null;
}

export async function fetchBiliWbiKeys(
  fetcher: Fetcher,
  options: BiliWbiFetchOptions = {}
): Promise<BiliWbiKeys> {
  const navUrl = options.navUrl || 'https://api.bilibili.com/x/web-interface/nav';
  const response = await fetcher(navUrl, {
    headers: options.headers
  });

  if (!response.ok) {
    throw new Error(`WBI 导航接口 HTTP ${response.status}`);
  }

  let navData: unknown;
  try {
    navData = await response.json();
  } catch {
    throw new Error('WBI 导航接口返回了无法解析的数据');
  }

  const keys = parseBiliWbiKeys(navData);
  if (!keys) {
    const code = navData && typeof navData === 'object'
      ? (navData as { code?: unknown }).code
      : undefined;
    throw new Error(
      `WBI 导航接口缺少签名材料${code === undefined ? '' : `，code=${String(code)}`}`
    );
  }
  return keys;
}

function safeWbiFailureMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  if (/^(?:WBI|未签名) (?:导航接口|弹幕接口) HTTP \d{3}$/.test(message)) return message;
  if (/^WBI 导航接口返回了无法解析的数据$/.test(message)) return message;
  if (/^WBI 导航接口缺少签名材料(?:，code=-?\d+)?$/.test(message)) return message;
  if (/^(?:WBI|未签名) 弹幕接口(?: code=-?\d+|返回了无法解析的数据)$/.test(message)) return message;
  return 'WBI 弹幕鉴权请求失败';
}

/**
 * Request the modern signed room token, falling back to the old endpoint for
 * older Bilibili responses or temporary WBI failures. The callback receives
 * a deliberately allow-listed status string, never a raw network error.
 */
export async function fetchBiliDanmuInfoWithFallback(
  fetcher: Fetcher,
  realRoomId: number,
  options: BiliDanmuInfoFetchOptions = {}
): Promise<unknown> {
  let wbiFailure = 'WBI 弹幕鉴权请求失败';

  try {
    const keys = await fetchBiliWbiKeys(fetcher, {
      headers: options.headers,
      navUrl: options.navUrl
    });
    const signedUrl = buildBiliWbiSignedUrl(
      'https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo',
      { id: realRoomId, type: 0, web_location: '444.8' },
      keys
    );
    const response = await fetcher(signedUrl, { headers: options.headers });
    if (!response.ok) {
      throw new Error(`WBI 弹幕接口 HTTP ${response.status}`);
    }

    let data: any;
    try {
      data = await response.json();
    } catch {
      throw new Error('WBI 弹幕接口返回了无法解析的数据');
    }
    if (data?.code === 0 && data?.data?.token) return data;
    throw new Error(`WBI 弹幕接口 code=${String(data?.code ?? 'unknown')}`);
  } catch (error: unknown) {
    wbiFailure = safeWbiFailureMessage(error);
  }

  options.onWbiFailure?.(wbiFailure);

  // Some older clients or account sessions can still use the same endpoint
  // without WBI. Try that form before falling back to the legacy getConf API.
  // This preserves the compatibility path without allowing an unsigned
  // request to replace the modern signed request when it succeeds.
  try {
    const unsignedUrl =
      'https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo'
      + `?id=${encodeURIComponent(String(realRoomId))}&type=0`;
    const response = await fetcher(unsignedUrl, { headers: options.headers });
    if (!response.ok) {
      throw new Error(`未签名 弹幕接口 HTTP ${response.status}`);
    }

    let data: any;
    try {
      data = await response.json();
    } catch {
      throw new Error('未签名 弹幕接口返回了无法解析的数据');
    }
    if (data?.code === 0 && data?.data?.token) return data;
  } catch {
    // The legacy endpoint below is the final compatibility path.
  }

  const fallbackUrl =
    `https://api.live.bilibili.com/room/v1/Danmu/getConf?room_id=${realRoomId}&platform=pc&player=web`;
  const fallbackResponse = await fetcher(fallbackUrl, { headers: options.headers });
  if (!fallbackResponse.ok) {
    throw new Error(`兼容弹幕接口 HTTP ${fallbackResponse.status}`);
  }
  return await fallbackResponse.json();
}

function encodeWbiValue(value: string): string {
  // Bilibili's web client strips these characters from values before it
  // applies encodeURIComponent. Keep the transformation explicit instead of
  // using URLSearchParams, whose '+' space encoding changes the signature.
  return encodeURIComponent(value.replace(/[!'()*]/g, ''));
}

function normalizeWbiValue(value: unknown): string {
  return String(value ?? '');
}

export function buildBiliWbiSignedUrl(
  endpoint: string,
  params: Record<string, unknown>,
  keys: Pick<BiliWbiKeys, 'mixinKey'>,
  nowSeconds = Math.floor(Date.now() / 1000)
): string {
  const signedParams: Record<string, string> = {};
  for (const [key, value] of Object.entries(params)) {
    if (key === 'w_rid') continue;
    signedParams[key] = normalizeWbiValue(value);
  }
  signedParams.wts = String(Math.floor(nowSeconds));

  const query = Object.keys(signedParams)
    .sort()
    .map(key => `${encodeWbiValue(key)}=${encodeWbiValue(signedParams[key])}`)
    .join('&');
  const wRid = createHash('md5')
    .update(`${query}${keys.mixinKey}`, 'utf8')
    .digest('hex');

  return `${endpoint}?${query}&w_rid=${wRid}`;
}
