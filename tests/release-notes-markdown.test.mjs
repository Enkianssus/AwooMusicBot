import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
    parseReleaseNotes,
    parseReleaseNotesInline,
} from '../src/release-notes-markdown.ts';

const root = path.resolve(import.meta.dirname, '..');
const text = value => ({ type: 'text', text: value });

test('parses headings, lists, bold and inline code', () => {
    const blocks = parseReleaseNotes('# 新功能\n\n## 更新内容\n- 支持 **QQ 连接器 22.76.1**\n* 修复 `qqmusic` 画像\n+ 第三项\n\n普通说明');
    assert.deepEqual(blocks, [
        { type: 'heading', level: 1, content: [text('新功能')] },
        { type: 'heading', level: 2, content: [text('更新内容')] },
        { type: 'list', items: [
            [text('支持 '), { type: 'strong', text: 'QQ 连接器 22.76.1' }],
            [text('修复 '), { type: 'code', text: 'qqmusic' }, text(' 画像')],
            [text('第三项')],
        ] },
        { type: 'paragraph', lines: [[text('普通说明')]] },
    ]);
});

test('deeper headings read as section headings and closing hashes are dropped', () => {
    assert.deepEqual(parseReleaseNotes('### What’s Changed ###'), [
        { type: 'heading', level: 2, content: [text('What’s Changed')] },
    ]);
    assert.deepEqual(parseReleaseNotes('#没有空格不是标题'), [
        { type: 'paragraph', lines: [[text('#没有空格不是标题')]] },
    ]);
});

test('raw HTML stays visible text and is never turned into markup', () => {
    const blocks = parseReleaseNotes('<script>alert(1)</script>\n<img src=x onerror=alert(1)>\n- <b>粗体</b>');
    assert.deepEqual(blocks, [
        { type: 'paragraph', lines: [[text('<script>alert(1)</script>')], [text('<img src=x onerror=alert(1)>')]] },
        { type: 'list', items: [[text('<b>粗体</b>')]] },
    ]);
    const tokens = blocks.flatMap(block => block.type === 'list' ? block.items.flat() : block.type === 'paragraph' ? block.lines.flat() : block.content);
    assert.ok(tokens.every(token => ['text', 'strong', 'code'].includes(token.type)));
});

test('GitHub generator comments and Full Changelog lines are removed', () => {
    const blocks = parseReleaseNotes([
        '<!-- Release notes generated using configuration in .github/release.yml -->',
        '## What\'s Changed',
        '* 修复网易云封面 by @someone in https://github.com/Enkianssus/awoo-connectors/pull/12',
        '',
        '**Full Changelog**: https://github.com/Enkianssus/awoo-connectors/compare/netease-v3.1.37.205354.8...netease-v3.1.37.205354.9',
        'Full Changelog: https://example.com/compare',
    ].join('\r\n'));
    assert.deepEqual(blocks, [
        { type: 'heading', level: 2, content: [text('What\'s Changed')] },
        { type: 'list', items: [[text('修复网易云封面 by @someone in https://github.com/Enkianssus/awoo-connectors/pull/12')]] },
    ]);
});

test('links and images become their text without the URL', () => {
    assert.deepEqual(parseReleaseNotesInline('详见 [发布说明](https://github.com/Enkianssus/AwooMusicBot/releases "说明") 和 ![截图](a.png)。'), [
        text('详见 发布说明 和 截图。'),
    ]);
    assert.deepEqual(parseReleaseNotesInline('**[QQ 连接器](https://example.com/(x))**'), [
        { type: 'strong', text: 'QQ 连接器' },
    ]);
    assert.deepEqual(parseReleaseNotesInline('<https://app.enkianss.us/update/awoo>'), [text('https://app.enkianss.us/update/awoo')]);
    assert.deepEqual(parseReleaseNotesInline('javascript:[x](javascript:alert(1))'), [text('javascript:x')]);
});

test('unmatched markers, escapes and code spans stay literal', () => {
    assert.deepEqual(parseReleaseNotesInline('**未闭合 与 `未闭合'), [text('**未闭合 与 `未闭合')]);
    assert.deepEqual(parseReleaseNotesInline('\\*\\*不是粗体\\*\\* `**也不是**`'), [
        text('**不是粗体** '),
        { type: 'code', text: '**也不是**' },
    ]);
    assert.deepEqual(parseReleaseNotesInline('[不是链接] (x)'), [text('[不是链接] (x)')]);
});

test('quotes, rules, fences and list continuations stay readable', () => {
    assert.deepEqual(parseReleaseNotes('> 引用说明\n---\n```\n  npm test\n```\n- 第一项\n  接着第一项'), [
        { type: 'paragraph', lines: [[text('引用说明')]] },
        { type: 'paragraph', lines: [[{ type: 'code', text: '  npm test' }]] },
        { type: 'list', items: [[text('第一项 接着第一项')]] },
    ]);
    assert.deepEqual(parseReleaseNotes(''), []);
    assert.deepEqual(parseReleaseNotes('\n\n**Full Changelog**: x\n'), []);
});

test('the published core release notes render without Markdown symbols', () => {
    const notes = fs.readFileSync(path.join(root, 'docs', 'release-notes', 'v1.2.5.md'), 'utf8');
    const blocks = parseReleaseNotes(notes);
    assert.equal(blocks[0].type, 'heading');
    assert.equal(blocks[1].type, 'list');
    const visible = JSON.stringify(blocks.map(block => block.type === 'list' ? block.items : block.type === 'paragraph' ? block.lines : block.content));
    assert.doesNotMatch(visible, /"text":"(?:[^"]*\s)?(?:#|\*\*|- )/);
    assert.match(JSON.stringify([{ type: 'text', text: notes.split('\n')[0] }]), /"text":"(?:[^"]*\s)?(?:#|\*\*|- )/);
    assert.match(visible, /"type":"strong","text":"QQ 连接器 22\.76\.1"/);
});
