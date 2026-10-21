import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

// Light and dark mode work because admin-ui.css and overlay-polish.css remap
// every Tailwind palette utility the UI uses to theme tokens. A utility missing
// from both files silently keeps its dark-palette color in light mode.

const root = path.resolve(import.meta.dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');
const adminCss = read('src', 'admin-ui.css');
const overlayCss = read('src', 'overlay-polish.css');
const appSource = read('src', 'App.tsx');
const sources = [
    { name: 'src/App.tsx', text: appSource },
    ...fs.readdirSync(path.join(root, 'src', 'components'))
        .filter(name => name.endsWith('.tsx'))
        .map(name => ({ name: `src/components/${name}`, text: read('src', 'components', name) }))
];

const PALETTE = 'slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose';
// bg-, text- and border- colors plus gradient stops, with variants (hover:, focus:…) and /opacity.
const COLOR_UTILITY = new RegExp(String.raw`(?<![\w\-:/\[])((?:[a-z0-9-]+:)*)(bg|text|border|from|via|to)-((?:${PALETTE})-\d{2,3}|white|black|\[#[0-9a-fA-F]{3,8}\])(\/(?:\d{1,3}|\[[^\]\s]+\]))?(?![\w-])`, 'g');

// Colors that stay the same in both modes on purpose.
const FIXED_COLORS = new Map([
    ['bg-white', 'toggle knobs on a colored track, and the QR code backdrop that must stay white to scan']
]);

// Gradient stops: the control panel neutralizes .bg-gradient-to-* in admin-ui.css,
// the overlay repaints its toast and current-song wash, the red shimmer is a
// translucent sweep, and the guard badges keep their fixed colors.
const GRADIENT_STOPS = new Set([
    'from-blue-500/[0.07]', 'from-blue-600', 'from-cyan-500/10', 'from-cyan-600', 'from-pink-600',
    'from-violet-600', 'to-cyan-600', 'to-violet-500/10', 'to-violet-500/[0.08]', 'to-violet-600',
    'to-white/[0.025]', 'via-cyan-500/[0.04]',
    'from-red-600', 'to-red-400', 'from-purple-600', 'to-purple-400', 'to-blue-400',
    'from-sky-500/10', 'to-cyan-500/5', 'from-sky-400/10', 'via-sky-950/5',
    'via-red-500/10', 'via-red-500/5'
]);

// Pinned overlay utilities that overlay-polish.css restyles through structure
// (.glass-card, .current-zone > .w-12, .queue-item …) or keeps on purpose.
const OVERLAY_EXCEPTIONS = new Map([
    ['bg-sky-950/20', '.glass-card paints the playlist card'],
    ['border-sky-300/20', '.glass-card draws the card border'],
    ['border-white/20', '.glass-card draws the empty card border; the drag ghost stays dark'],
    ['border-sky-300/35', '.current-zone > .w-12 frames the artwork'],
    ['border-sky-400/60', '.current-zone > .w-12 frames the artwork'],
    ['border-yellow-400/60', '.current-zone > .w-12 frames the artwork'],
    ['border-sky-400/30', '.queue-item > .w-8 frames the artwork'],
    ['border-white/10', '.queue-item > .w-8 frames the artwork'],
    ['hover:bg-white/10', '.queue-item:hover sets the hover card'],
    ['bg-red-500/10', 'translucent danger tint of refused requests and paused intake, readable in both modes'],
    ['border-red-500/20', 'translucent danger border, readable in both modes'],
    ['border-red-500/30', 'translucent danger border, readable in both modes'],
    ['border-red-500/50', 'translucent danger border, readable in both modes'],
    ['bg-yellow-500/10', 'translucent warning wash of the paused card'],
    ['text-white', 'the drag ghost is a dark or colored chip in both modes'],
    ['text-gray-400', 'the drag ghost is a dark chip in both modes']
]);

function cssEscape(className) {
    return className.replace(/[:/[\].#%(),]/g, character => `\\${character}`);
}

/** True when the stylesheet has a selector for exactly this class (not a longer one). */
function hasSelector(css, className) {
    const needle = `.${cssEscape(className)}`;
    for (let index = css.indexOf(needle); index >= 0; index = css.indexOf(needle, index + 1)) {
        if (!/[\w\\-]/.test(css[index + needle.length] || '')) return true;
    }
    return false;
}

function colorUtilities(text) {
    return [...text.matchAll(COLOR_UTILITY)].map(match => ({ className: match[0], kind: match[2] }));
}

function overlayWidgetSource() {
    const start = appSource.indexOf('const OverlayWidget');
    assert.ok(start >= 0, 'App.tsx defines OverlayWidget');
    const end = /\r?\n\};\r?\n/.exec(appSource.slice(start));
    assert.ok(end, 'OverlayWidget has a closing brace');
    return appSource.slice(start, start + end.index);
}

test('the escaping helper matches how the stylesheets spell utility selectors', () => {
    assert.equal(cssEscape('hover:bg-blue-500/20'), 'hover\\:bg-blue-500\\/20');
    assert.equal(cssEscape('bg-[#17222c]/95'), 'bg-\\[\\#17222c\\]\\/95');
    assert.equal(cssEscape('bg-cyan-500/[0.06]'), 'bg-cyan-500\\/\\[0\\.06\\]');
    assert.ok(hasSelector('.a :is(.bg-white\\/5) {}', 'bg-white/5'));
    assert.ok(!hasSelector('.a :is(.bg-white\\/5) {}', 'bg-white'));
    assert.deepEqual(colorUtilities(`'disabled:hover:border-white/10 text-xs border-0 bg-gradient-to-r from-sky-500/10'`).map(item => item.className),
        ['disabled:hover:border-white/10', 'from-sky-500/10']);
});

test('every bg-, text- and border- color utility has a light/dark mapping', () => {
    const missing = [];
    for (const { name, text } of sources) {
        for (const { className, kind } of colorUtilities(text)) {
            if (['from', 'via', 'to'].includes(kind) || FIXED_COLORS.has(className)) continue;
            if (!hasSelector(adminCss, className) && !hasSelector(overlayCss, className)) missing.push(`${name}: ${className}`);
        }
    }
    assert.deepEqual([...new Set(missing)], [], 'map these in admin-ui.css or overlay-polish.css, or use studio-* classes');
});

test('the pinned overlay maps its colors in overlay-polish.css', () => {
    const missing = colorUtilities(overlayWidgetSource())
        .filter(({ kind, className }) => !['from', 'via', 'to'].includes(kind)
            && !OVERLAY_EXCEPTIONS.has(className)
            && !FIXED_COLORS.has(className)
            && !hasSelector(overlayCss, className))
        .map(({ className }) => className);
    assert.deepEqual([...new Set(missing)], [], 'a class mapped only in admin-ui.css stays dark-palette in the light overlay');
});

test('gradient stops are explicit and every gradient direction is neutralized in the control panel', () => {
    const stops = new Set();
    const directions = new Set();
    for (const { text } of sources) {
        for (const { className, kind } of colorUtilities(text)) if (['from', 'via', 'to'].includes(kind)) stops.add(className);
        for (const match of text.matchAll(/\bbg-gradient-to-(?:t|tr|r|br|b|bl|l|tl)\b/g)) directions.add(match[0]);
    }
    assert.deepEqual([...stops].filter(stop => !GRADIENT_STOPS.has(stop)), [], 'new gradient stops need a light-mode decision');
    for (const direction of directions) assert.ok(hasSelector(adminCss, direction), `${direction} is neutralized in admin-ui.css`);
});

test('the overlay status line and refused requests use theme tokens', () => {
    const statusStart = appSource.indexOf('const getStatusColor');
    const statusColor = appSource.slice(statusStart, appSource.indexOf('const getStatusAnimation', statusStart));
    assert.ok(statusStart >= 0 && statusColor.length > 0);
    assert.doesNotMatch(statusColor, /#[0-9a-f]{3,8}\b/i);
    for (const token of ['--overlay-danger', '--overlay-success', '--overlay-warning', '--overlay-info']) {
        assert.match(statusColor, new RegExp(`var\\(${token}\\)`));
    }
    const [lightTokens, darkTokens] = overlayCss.split('.awoo-overlay[data-color-mode="dark"] {');
    for (const block of [lightTokens, darkTokens.slice(0, darkTokens.indexOf('}'))]) {
        assert.match(block, /--overlay-info: #[0-9a-f]{6};/);
        assert.match(block, /--overlay-success: #[0-9a-f]{6};/);
    }
    assert.match(overlayCss, /\.awoo-overlay \.text-white\\\/80 \{ color: var\(--overlay-muted\); \}/);
    assert.match(overlayCss, /\.awoo-overlay \.bg-white\\\/30 \{ background-color: var\(--overlay-line\); \}/);
});

test('missing avatars use the local placeholder instead of a third-party service', () => {
    assert.doesNotMatch(appSource, /dicebear/i);
    const rejectStart = appSource.indexOf('{rejects.map(');
    const rejectCard = appSource.slice(rejectStart, appSource.indexOf('))}', rejectStart));
    assert.match(rejectCard, /<AvatarImage /);
    assert.doesNotMatch(rejectCard, /<img /);
    assert.match(appSource, /const AvatarImage[\s\S]{0,400}referrerPolicy="no-referrer"[\s\S]{0,200}onError=/);
});
