/**
 * A small, safe Markdown subset for release notes. The parser only produces
 * text tokens and the view renders them as React text, so HTML in a release
 * body is shown literally and never interpreted.
 */

export type ReleaseNotesInline =
    | { type: 'text'; text: string }
    | { type: 'strong'; text: string }
    | { type: 'code'; text: string };

export type ReleaseNotesBlock =
    | { type: 'heading'; level: 1 | 2; content: ReleaseNotesInline[] }
    | { type: 'list'; items: ReleaseNotesInline[][] }
    | { type: 'paragraph'; lines: ReleaseNotesInline[][] };

const ESCAPABLE = '\\`*_{}[]()#+-.!|>~<';
// GitHub appends “**Full Changelog**: https://…/compare/…” to generated notes.
const FULL_CHANGELOG = /^(?:[-*+>]\s+)?(?:\*\*|__)?\s*full\s+changelog\b/i;
const HEADING = /^(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
const LIST_ITEM = /^[-*+]\s+(.*)$/;
const THEMATIC_BREAK = /^([-*_])(?:\s*\1){2,}$/;
const FENCE = /^(?:```|~~~)/;
const AUTOLINK = /^<(https?:\/\/[^\s<>]+)>/;

/** `[text](url)` starting at `start`, or null; the URL is dropped. */
function matchLink(source: string, start: number): { text: string; end: number } | null {
    const close = source.indexOf(']', start + 1);
    if (close < 0 || source[close + 1] !== '(') return null;
    const label = source.slice(start + 1, close);
    if (label.includes('[')) return null;
    let depth = 0;
    for (let index = close + 1; index < source.length; index += 1) {
        const character = source[index];
        if (character === '(') depth += 1;
        else if (character === ')') {
            depth -= 1;
            if (depth === 0) return { text: label, end: index + 1 };
        } else if (character === ' ' && depth === 1 && source[index + 1] !== '"') {
            return null;
        }
    }
    return null;
}

function pushText(tokens: ReleaseNotesInline[], text: string) {
    if (!text) return;
    const last = tokens[tokens.length - 1];
    if (last?.type === 'text') last.text += text;
    else tokens.push({ type: 'text', text });
}

function plainText(tokens: ReleaseNotesInline[]): string {
    return tokens.map(token => token.text).join('');
}

/** Bold (`**x**`), code (`` `x` ``), links and images as their text, and backslash escapes. */
export function parseReleaseNotesInline(source: string): ReleaseNotesInline[] {
    const tokens: ReleaseNotesInline[] = [];
    let index = 0;
    while (index < source.length) {
        const character = source[index];
        const next = source[index + 1];
        if (character === '\\' && next !== undefined && ESCAPABLE.includes(next)) {
            pushText(tokens, next);
            index += 2;
            continue;
        }
        if (character === '`') {
            const end = source.indexOf('`', index + 1);
            if (end > index + 1) {
                tokens.push({ type: 'code', text: source.slice(index + 1, end) });
                index = end + 1;
                continue;
            }
        }
        if (character === '*' && next === '*') {
            const end = source.indexOf('**', index + 2);
            const inner = end > index + 2 ? plainText(parseReleaseNotesInline(source.slice(index + 2, end))) : '';
            if (inner.trim()) {
                tokens.push({ type: 'strong', text: inner });
                index = end + 2;
                continue;
            }
        }
        if (character === '[' || (character === '!' && next === '[')) {
            const link = matchLink(source, character === '!' ? index + 1 : index);
            if (link) {
                pushText(tokens, plainText(parseReleaseNotesInline(link.text)));
                index = link.end;
                continue;
            }
        }
        if (character === '<') {
            const autolink = AUTOLINK.exec(source.slice(index));
            if (autolink) {
                pushText(tokens, autolink[1]);
                index += autolink[0].length;
                continue;
            }
        }
        pushText(tokens, character);
        index += 1;
    }
    return tokens;
}

export function parseReleaseNotes(markdown: string): ReleaseNotesBlock[] {
    // Comments such as GitHub's generator note are dropped; every other tag stays visible text.
    const source = String(markdown || '').replace(/\r\n?/g, '\n').replace(/<!--[\s\S]*?(?:-->|$)/g, '');
    const blocks: ReleaseNotesBlock[] = [];
    let list: ReleaseNotesInline[][] | null = null;
    let paragraph: ReleaseNotesInline[][] | null = null;
    let fenced = false;

    const addLine = (content: ReleaseNotesInline[]) => {
        list = null;
        if (!paragraph) {
            paragraph = [];
            blocks.push({ type: 'paragraph', lines: paragraph });
        }
        paragraph.push(content);
    };

    for (const rawLine of source.split('\n')) {
        const trimmed = rawLine.trim();
        if (FENCE.test(trimmed)) {
            fenced = !fenced;
            list = null;
            paragraph = null;
            continue;
        }
        if (fenced) {
            if (trimmed) addLine([{ type: 'code', text: rawLine.replace(/\s+$/, '') }]);
            continue;
        }
        const line = trimmed.replace(/^>\s?/, '').trim();
        if (!line || THEMATIC_BREAK.test(line)) {
            list = null;
            paragraph = null;
            continue;
        }
        if (FULL_CHANGELOG.test(line)) continue;

        const heading = HEADING.exec(line);
        if (heading) {
            list = null;
            paragraph = null;
            if (heading[2]) blocks.push({ type: 'heading', level: heading[1].length === 1 ? 1 : 2, content: parseReleaseNotesInline(heading[2]) });
            continue;
        }
        const item = LIST_ITEM.exec(line);
        if (item) {
            paragraph = null;
            if (!list) {
                list = [];
                blocks.push({ type: 'list', items: list });
            }
            list.push(parseReleaseNotesInline(item[1]));
            continue;
        }
        if (list && /^\s{2,}/.test(rawLine)) {
            // An indented line continues the previous list item.
            const items: ReleaseNotesInline[][] = list;
            const previous = items[items.length - 1];
            pushText(previous, ' ');
            for (const token of parseReleaseNotesInline(line)) {
                if (token.type === 'text') pushText(previous, token.text);
                else previous.push(token);
            }
            continue;
        }
        addLine(parseReleaseNotesInline(line));
    }
    return blocks;
}
