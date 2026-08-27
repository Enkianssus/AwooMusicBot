/**
 * Policy for the request overlay's always-on-top preference.
 *
 * Keep the default and the state transition outside Electron so that the
 * preference remains deterministic and can be covered without starting a
 * BrowserWindow.
 */
export const DEFAULT_OVERLAY_ALWAYS_ON_TOP = true;

export function normalizeOverlayAlwaysOnTop(value: unknown): boolean {
  return typeof value === 'boolean'
    ? value
    : DEFAULT_OVERLAY_ALWAYS_ON_TOP;
}

export function toggleOverlayAlwaysOnTop(current: boolean): boolean {
  return !current;
}
