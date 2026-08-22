const bridgeOrigin = window.electronAPI?.internalApiOrigin || '';
const browserOrigin = window.location.protocol === 'http:' || window.location.protocol === 'https:'
  ? window.location.origin
  : '';

export const internalApiOrigin = bridgeOrigin || browserOrigin;

export function internalApiUrl(pathname: string): string {
  const path = pathname.startsWith('/') ? pathname : `/${pathname}`;
  return `${internalApiOrigin}${path}`;
}
