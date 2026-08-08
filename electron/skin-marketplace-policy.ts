export const SKIN_MARKETPLACE_URL =
  'https://awoo-skins.enkianss.us/';

const OFFICIAL_SKIN_MARKETPLACE_ORIGINS = new Set([
  'https://awoo-skins.enkianss.us'
]);
const LOCAL_SKIN_MARKETPLACE_ORIGINS = new Set([
  'http://127.0.0.1:5178',
  'http://localhost:5178'
]);
const SKIN_DOWNLOAD_PATH =
  /^\/api\/skins\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/download$/i;

export function isAllowedSkinMarketplaceOrigin(
  origin: string | undefined
): boolean {
  if (!origin) return false;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (parsed.origin !== origin) return false;
  if (LOCAL_SKIN_MARKETPLACE_ORIGINS.has(parsed.origin)) return true;
  if (parsed.protocol !== 'https:') return false;
  return OFFICIAL_SKIN_MARKETPLACE_ORIGINS.has(parsed.origin);
}

export function validateSkinMarketplaceDownloadUrl(
  value: unknown,
  requestOrigin: string | undefined
): string {
  if (!isAllowedSkinMarketplaceOrigin(requestOrigin)) {
    throw new Error('皮肤站来源不受信任');
  }
  let parsed: URL;
  try {
    parsed = new URL(String(value || ''));
  } catch {
    throw new Error('皮肤下载地址无效');
  }
  if (
    parsed.origin !== requestOrigin
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
    || !SKIN_DOWNLOAD_PATH.test(parsed.pathname)
  ) {
    throw new Error('皮肤下载地址不属于当前皮肤站');
  }
  return parsed.toString();
}
