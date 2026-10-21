/**
 * Window-open, navigation and renderer-recovery rules for the app's windows.
 *
 * A target="_blank" link or window.open would otherwise become a bare in-app
 * Electron window on a remote site, sharing the app session, and a top-level
 * navigation could replace the overlay or control panel with another page.
 * Only the project's own pages leave the app, and only in the system browser.
 *
 * Pure (no Electron) so every decision runs under node --test.
 */
import {
  createAppRendererUrlMatcher,
  type AppRendererUrlOptions
} from './internal-api-trust-policy.ts';

const GITHUB_HOST = 'github.com';
// GitHub owner names are case-insensitive.
const GITHUB_OWNER = 'enkianssus';
const OFFICIAL_SITE_HOST = 'app.enkianss.us';
const MAX_LOGGED_URL_LENGTH = 200;

export interface ExternalUrlOptions {
  /** The skin marketplace origins; skin-marketplace-policy owns that list. */
  isMarketplaceOrigin?: (origin: string) => boolean;
}

/**
 * https pages of the project: its GitHub account, the official site, and the
 * skin marketplace.  Everything else, including http, file: and javascript:,
 * is refused.
 */
export function isAllowedExternalUrl(
  url: string,
  { isMarketplaceOrigin }: ExternalUrlOptions = {}
): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port) {
    return false;
  }
  if (parsed.hostname === GITHUB_HOST) {
    const [, owner = ''] = parsed.pathname.split('/');
    return owner.toLowerCase() === GITHUB_OWNER;
  }
  if (parsed.hostname === OFFICIAL_SITE_HOST) return true;
  return Boolean(isMarketplaceOrigin?.(parsed.origin));
}

/**
 * The documents a top-level navigation may open: the renderer's own
 * index.html with any query (?admin=true&tab=updates) and, in development,
 * any page of the dev server so its reloads keep working.  A file dropped onto
 * a window or a link to another site never replaces the app.
 */
export function isAppNavigationUrl(url: string, options: AppRendererUrlOptions): boolean {
  return createAppRendererUrlMatcher(options)(url);
}

/** Scheme, host and path only: a query may carry IDs or tokens, and a local path a user name. */
export function describeUrlForLog(url: string): string {
  let text: string;
  try {
    const parsed = new URL(url);
    text = parsed.protocol === 'https:' || parsed.protocol === 'http:'
      ? `${parsed.origin}${parsed.pathname}`
      : parsed.protocol;
  } catch {
    text = '无效地址';
  }
  return text.length > MAX_LOGGED_URL_LENGTH ? `${text.slice(0, MAX_LOGGED_URL_LENGTH)}…` : text;
}

export type RendererRecovery = 'reload' | 'recreate';

export interface CrashLoopGuardOptions {
  /** Crashes within `windowMs` that are answered by reloading the page. */
  limit?: number;
  windowMs?: number;
}

export interface CrashLoopGuard {
  record(now: number): RendererRecovery;
}

/**
 * The first `limit` renderer crashes within `windowMs` reload the page in
 * place; the next one rebuilds the whole window and starts counting afresh.
 */
export function createCrashLoopGuard({
  limit = 3,
  windowMs = 60_000
}: CrashLoopGuardOptions = {}): CrashLoopGuard {
  let crashes: number[] = [];
  return {
    record(now) {
      // A clock that moved backwards forgets the crashes it can no longer place.
      crashes = crashes.filter(at => at <= now && now - at < windowMs);
      if (crashes.length < limit) {
        crashes.push(now);
        return 'reload';
      }
      crashes = [];
      return 'recreate';
    }
  };
}
