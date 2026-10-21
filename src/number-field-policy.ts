// Number inputs keep the text being typed and commit only a valid value on
// blur or Enter. Clamping on every keystroke turned "12" into "42" for a 4–60
// setting, and saving partial ports restarted the external API mid-edit.

export interface NumberDraftRules {
    min?: number;
    max?: number;
    integer?: boolean;
}

export type NumberDraftResult =
    | { ok: true; value: number }
    | { ok: false; error: string };

export const MIN_PORT = 1024;
export const MAX_PORT = 65535;

const DECIMAL_DRAFT = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;

/** A Chinese IME types ０-９, ＋, －, ． or 。 instead of ASCII digits and signs. */
function toHalfWidth(text: string): string {
    return text
        .replace(/[０-９＋－．]/g, character =>
            String.fromCharCode(character.charCodeAt(0) - 0xFEE0))
        .replace(/。/g, '.');
}

function bound(value: number | undefined): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function describeRange(min: number | undefined, max: number | undefined): string {
    if (min !== undefined && max !== undefined) return `范围 ${min}–${max}`;
    return min !== undefined ? `不能小于 ${min}` : `不能大于 ${max}`;
}

export function parseNumberDraft(draft: string, rules: NumberDraftRules = {}): NumberDraftResult {
    const text = toHalfWidth(draft).trim();
    if (!text) return { ok: false, error: '请输入数值' };
    if (!DECIMAL_DRAFT.test(text)) return { ok: false, error: '请输入数字' };
    const value = Number(text);
    if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) {
        return { ok: false, error: '数值过大' };
    }
    if (rules.integer && !Number.isInteger(value)) return { ok: false, error: '请输入整数' };
    const min = bound(rules.min);
    const max = bound(rules.max);
    if ((min !== undefined && value < min) || (max !== undefined && value > max)) {
        return { ok: false, error: describeRange(min, max) };
    }
    return { ok: true, value };
}

export interface PortRules {
    /** Ports already used by the other local service. */
    forbid?: number | readonly number[];
}

export function isValidPort(value: number, { forbid }: PortRules = {}): boolean {
    if (!Number.isInteger(value) || value < MIN_PORT || value > MAX_PORT) return false;
    return !([] as number[]).concat(forbid ?? []).includes(value);
}

export function parsePortDraft(
    draft: string,
    rules: PortRules & { conflictMessage?: string } = {}
): NumberDraftResult {
    const parsed = parseNumberDraft(draft, { min: MIN_PORT, max: MAX_PORT, integer: true });
    if (!parsed.ok || isValidPort(parsed.value, rules)) return parsed;
    return { ok: false, error: rules.conflictMessage || '端口已被占用' };
}

/** Stored settings can hold null (a saved NaN) or strings; show the fallback instead. */
export function finiteNumberOr(value: unknown, fallback: number): number {
    const number = typeof value === 'number'
        ? value
        : typeof value === 'string' && value.trim() ? Number(value) : Number.NaN;
    return Number.isFinite(number) ? number : fallback;
}
