// The admin console polls /api/config every two seconds while edits are saved
// after a short debounce. A poll must never replace an edit that is still
// waiting for its save, or whose save has not been confirmed yet; otherwise a
// quick tab switch silently reverts the setting and the edit is never sent.
// Nor may it replace the settings while a text field has focus: the server
// trims gift names and never echoes FoliaToken, so adopting its copy between
// two keystrokes rewrites the text the user is still typing.

export interface ConfigDirtyState {
    /** A sysConfig edit is waiting for its debounce timer or for the server reply. */
    configDirty: boolean;
    /** A control UI theme edit is waiting for its debounce timer or for the server reply. */
    widgetStyleDirty: boolean;
    /** A text field of the control panel has focus, so its value may be half-typed. */
    editing?: boolean;
}

export interface PolledConfigSnapshot {
    config?: unknown;
    widgetStyle?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Input types that hold typed text; NumberField drafts are type="text". */
const TEXT_ENTRY_INPUT_TYPES: ReadonlySet<string> = new Set([
    'text', 'password', 'search', 'url', 'email', 'tel', 'number'
]);

/** What a focused element exposes to tell whether it holds typed text. */
export interface FocusedElementLike {
    tagName: string;
    type?: unknown;
    readOnly?: unknown;
}

/** A focused text-like input or textarea may hold a half-typed value. */
export function isTextEntryElement(element: FocusedElementLike | null | undefined): boolean {
    if (!element || typeof element.tagName !== 'string' || element.readOnly === true) return false;
    const tag = element.tagName.toUpperCase();
    if (tag === 'TEXTAREA') return true;
    // A missing or unknown type attribute reads back as "text".
    const type = typeof element.type === 'string' ? element.type.toLowerCase() : 'text';
    return tag === 'INPUT' && TEXT_ENTRY_INPUT_TYPES.has(type);
}

/**
 * The server never sends FoliaToken back, only FoliaTokenConfigured (see
 * getPublicSysConfig in electron/main.ts). Adopting its copy keeps a token
 * typed in this window, so the field does not empty under the user and a
 * later keystroke cannot save just the rest of the token. Every other key,
 * FoliaTokenConfigured included, comes from the server.
 */
export function adoptPolledSysConfig<C>(local: unknown, polled: C): C {
    if (!isRecord(polled) || polled.FoliaToken !== undefined) return polled;
    if (!isRecord(local) || typeof local.FoliaToken !== 'string') return polled;
    return { ...polled, FoliaToken: local.FoliaToken };
}

/**
 * Whether the token field's placeholder says a token is configured. Once the
 * token was edited in this window, the local value (saved, or about to be)
 * is newer than the server's flag; both ignore a token of only spaces.
 */
export function isFoliaTokenConfigured(config: unknown): boolean {
    if (!isRecord(config)) return false;
    return typeof config.FoliaToken === 'string'
        ? config.FoliaToken.trim() !== ''
        : config.FoliaTokenConfigured === true;
}

/**
 * Live status (connection, queue, versions) always comes from the poll. The
 * editable parts keep the local copy while they are dirty or being typed in;
 * widgetStyle is tracked separately because theme edits have their own save.
 */
export function mergePolledConfig<T extends PolledConfigSnapshot>(
    prev: T | null | undefined,
    polled: T,
    dirty: ConfigDirtyState
): T {
    if (!prev) return polled;
    // A response without config is not a settings snapshot to adopt, and
    // without a local copy there is nothing to keep.
    const keepLocalConfig = polled.config === undefined
        || (prev.config !== undefined && (dirty.configDirty || dirty.editing === true));
    return {
        ...polled,
        config: keepLocalConfig ? prev.config : adoptPolledSysConfig(prev.config, polled.config),
        widgetStyle: dirty.widgetStyleDirty ? prev.widgetStyle : polled.widgetStyle
    };
}

export const SAVE_RETRY_DELAYS_MS: readonly number[] = [1000, 3000];

export type SaveRetryDecision =
    | { retry: true; delayMs: number }
    | { retry: false };

/**
 * `failedAttempts` counts the attempts that have failed so far. The first two
 * failures are retried after 1 s and then 3 s; after the third the edit stays
 * unsaved and the UI reports the error instead of retrying forever.
 */
export function shouldRetrySave(failedAttempts: number): SaveRetryDecision {
    if (!Number.isInteger(failedAttempts) || failedAttempts < 1) return { retry: false };
    const delayMs = SAVE_RETRY_DELAYS_MS[failedAttempts - 1];
    return delayMs === undefined ? { retry: false } : { retry: true, delayMs };
}

/** Older servers reply without `success`; only an explicit `false` is a rejection. */
export function isConfigSaveAccepted(ok: boolean, result: unknown): boolean {
    if (!ok) return false;
    return !(result && typeof result === 'object'
        && (result as { success?: unknown }).success === false);
}
