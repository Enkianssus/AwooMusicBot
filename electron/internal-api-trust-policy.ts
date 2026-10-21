/**
 * Trust decisions for the internal control API (default port 5555).
 *
 * The internal API changes settings, signs in and out of Bilibili, installs
 * updates and controls the queue, so only the app's own windows and local
 * tools may use it.  Mod UI code runs in sandboxed iframes (Origin "null")
 * both in OBS and inside the admin preview, which share an Origin with the
 * packaged file:// renderer.  The browser token is therefore attached only to
 * the top-level renderer frame of the app's own windows, and every request is
 * checked against the Host header so DNS rebinding cannot reach the API.
 *
 * Pure (no Electron) so every decision runs under node --test.
 */
import { timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const INTERNAL_API_TOKEN_HEADER = 'X-Awoo-Internal-Token';

/**
 * Read routes that expose the login QR key, logs, account and room settings,
 * diagnostics, or that start network update checks.  Prefix match.
 */
export const SENSITIVE_INTERNAL_GET_PREFIXES: readonly string[] = [
  '/api/bili/',
  '/api/logs',
  '/api/config',
  '/api/feedback/',
  '/api/update',
  '/api/updates/',
  '/api/debug',
  '/api/diagnostics'
];

export type InternalRequestDecision =
  | 'allow'
  | 'forbid-origin'
  | 'forbid-mutation'
  | 'forbid-sensitive-read';

/** The requesting frame as reported by Electron's webRequest details. */
export interface RequestFrame {
  isMainFrame: boolean;
  url: string;
}

export interface TokenAttachmentInput {
  isInternalApiUrl: boolean;
  webContentsId: number | undefined;
  trustedWebContentsIds: readonly number[];
  /** `null` when the request no longer has a frame, e.g. a keepalive flush on close. */
  frame: RequestFrame | null | undefined;
  isAppRendererUrl: (url: string) => boolean;
}

export interface InternalRequestFacts {
  /** The Origin header; absent for same-origin GETs and local tools. */
  origin: string | undefined;
  hasValidToken: boolean;
  isTrustedSkinMarketplace: boolean;
  /** The internal API's own origin or the Vite dev server. */
  isSameAppOrigin: boolean;
  method: string | undefined;
  pathname: string;
  /**
   * The Sec-Fetch-Site header. Browsers send it on every request, also on
   * no-cors GETs such as an <img> that carry no Origin; curl and other local
   * tools send none.
   */
  secFetchSite?: string | string[] | undefined;
}

export type NetworkTriggerFacts = Pick<
  InternalRequestFacts,
  'origin' | 'hasValidToken' | 'isSameAppOrigin' | 'secFetchSite'
>;

const READ_METHODS = new Set(['GET', 'HEAD']);

function isLoopbackHostname(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === 'localhost';
}

/**
 * Browsers always send the Host they resolved, so a rebound domain arrives as
 * `evil.example:5555`.  Only the loopback names of the listening port pass.
 */
export function isLoopbackHostHeader(
  host: string | undefined,
  port: number | null | undefined
): boolean {
  if (typeof host !== 'string' || typeof port !== 'number' || !Number.isInteger(port) || port <= 0) {
    return false;
  }
  const normalized = host.toLowerCase();
  return normalized === `127.0.0.1:${port}`
    || normalized === `localhost:${port}`
    || normalized === `[::1]:${port}`;
}

export function shouldAttachInternalToken({
  isInternalApiUrl,
  webContentsId,
  trustedWebContentsIds,
  frame,
  isAppRendererUrl
}: TokenAttachmentInput): boolean {
  if (!isInternalApiUrl) return false;
  if (webContentsId === undefined || !trustedWebContentsIds.includes(webContentsId)) {
    return false;
  }
  // Electron reports no frame for a request that outlives it, such as the
  // keepalive settings flush sent while a trusted window closes.
  if (!frame) return true;
  // Sub-frames (the Mod preview and its sandboxed content) never get the token.
  return frame.isMainFrame && isAppRendererUrl(frame.url);
}

/** Constant-time comparison of the token header with the expected token. */
export function isValidInternalToken(
  value: string | string[] | undefined,
  expected: string
): boolean {
  if (typeof value !== 'string' || !expected) return false;
  const actualBytes = Buffer.from(value);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length
    && timingSafeEqual(actualBytes, expectedBytes);
}

/** http(s) pages served from 127.0.0.1 or localhost on any port. */
export function isLoopbackOrigin(origin: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  return (parsed.protocol === 'http:' || parsed.protocol === 'https:')
    && isLoopbackHostname(parsed.hostname);
}

/** The internal API's own pages, or the Vite dev server in development. */
export function isSameAppOrigin(
  origin: string | undefined,
  { internalApiPort, devUrl }: { internalApiPort: number | null; devUrl?: string }
): boolean {
  if (!origin || origin === 'null') return false;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (
    internalApiPort !== null
    && parsed.protocol === 'http:'
    && isLoopbackHostname(parsed.hostname)
    && Number(parsed.port || 80) === internalApiPort
  ) {
    return true;
  }
  const devOrigin = httpOriginOf(devUrl);
  return Boolean(devOrigin) && parsed.origin === devOrigin;
}

function httpOriginOf(value: string | undefined): string {
  if (!value) return '';
  try {
    const parsed = new URL(value);
    // file:, data: and other opaque origins serialize as "null"; never match those.
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : '';
  } catch {
    return '';
  }
}

export function isSensitiveInternalPath(pathname: string): boolean {
  return SENSITIVE_INTERNAL_GET_PREFIXES.some(prefix => pathname.startsWith(prefix));
}

/**
 * Whether the browser reports that a page of another site started the
 * request. Every port of 127.0.0.1 is one site, so the Mod UI host and other
 * local pages count as "same-site"; only the internal API's own pages are
 * "same-origin", and a typed address is "none".
 */
export function isCrossSiteFetch(secFetchSite: string | string[] | undefined): boolean {
  const values = Array.isArray(secFetchSite) ? secFetchSite : [secFetchSite];
  return values.some(value => typeof value === 'string'
    && value.split(',').some(part => {
      const site = part.trim().toLowerCase();
      return site === 'cross-site' || site === 'same-site';
    }));
}

/**
 * Whether a request may make the app contact the update, catalog or
 * feedback services, e.g. GET /api/update/check or ?refresh=1.  A page that
 * cannot read the answer can still repeat such a GET (an <img> loop), so
 * only the app's own windows (token), its own pages and local tools that are
 * not browsers may; everyone else gets the cached answer or a refusal.
 */
export function mayTriggerNetworkWork({
  origin,
  hasValidToken,
  isSameAppOrigin: fromSameApp,
  secFetchSite
}: NetworkTriggerFacts): boolean {
  if (hasValidToken) return true;
  if (isCrossSiteFetch(secFetchSite)) return false;
  // Without an Origin: same-origin GETs of the app's own pages and local tools.
  return !origin || fromSameApp;
}

export function classifyInternalRequest({
  origin,
  hasValidToken,
  isTrustedSkinMarketplace,
  isSameAppOrigin: fromSameApp,
  method,
  pathname,
  secFetchSite
}: InternalRequestFacts): InternalRequestDecision {
  if (isTrustedSkinMarketplace) return 'allow';
  const normalizedMethod = String(method || 'GET').toUpperCase();
  // A CORS preflight never carries the token and has no effect; the request
  // that follows it is classified on its own.
  const preflight = normalizedMethod === 'OPTIONS';
  const read = READ_METHODS.has(normalizedMethod);
  if (origin === 'null') {
    // The packaged file:// renderer and sandboxed Mod UI frames share this
    // Origin; only the renderer has the token.
    return hasValidToken || preflight ? 'allow' : 'forbid-origin';
  }
  if (origin && !isLoopbackOrigin(origin)) return 'forbid-origin';
  // Another site's page or another local port, whatever Origin it sent (a
  // form post may send none): only the app's own windows may change anything.
  if (!read && !preflight && !hasValidToken && isCrossSiteFetch(secFetchSite)) {
    return 'forbid-mutation';
  }
  // No Origin: same-origin GETs from the classic OBS page and local tools.
  if (!origin || preflight || hasValidToken || fromSameApp) return 'allow';
  // Any other loopback page, such as the Mod UI host or a local web tool.
  if (!read) return 'forbid-mutation';
  return isSensitiveInternalPath(pathname) ? 'forbid-sensitive-read' : 'allow';
}

export interface AppRendererUrlOptions {
  /** index.html files that loadWindow may open with BrowserWindow.loadFile. */
  rendererFiles: readonly string[];
  /** The Vite dev server URL in development. */
  devUrl?: string;
  platform?: NodeJS.Platform;
}

/**
 * Matches the app's own renderer documents: the packaged index.html files
 * (any query or hash) and, in development, the dev server origin.
 */
export function createAppRendererUrlMatcher({
  rendererFiles,
  devUrl,
  platform = process.platform
}: AppRendererUrlOptions): (url: string) => boolean {
  const windows = platform === 'win32';
  const pathApi = windows ? path.win32 : path.posix;
  // Compare decoded paths: Chromium and Node percent-encode file URLs differently.
  const normalize = (file: string) => {
    const resolved = pathApi.resolve(file);
    return windows ? resolved.toLowerCase() : resolved;
  };
  const files = new Set(rendererFiles.map(normalize));
  const devOrigin = httpOriginOf(devUrl);
  return url => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return false;
    }
    if (parsed.protocol === 'file:') {
      try {
        return files.has(normalize(fileURLToPath(parsed, { windows })));
      } catch {
        return false;
      }
    }
    return Boolean(devOrigin) && parsed.origin === devOrigin;
  };
}
