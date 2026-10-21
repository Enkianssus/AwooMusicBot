import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { attachDynamicCoverPlayback, shouldShowDynamicCover } from '../src/dynamic-cover-playback.ts';

class Video extends EventTarget {
    src = '';
    loadCount = 0;
    pauseCount = 0;
    playCount = 0;
    readyState = 0;
    nativeHls = '';
    playResult = Promise.resolve();
    canPlayType() { return this.nativeHls; }
    load() { this.loadCount += 1; }
    pause() { this.pauseCount += 1; }
    play() { this.playCount += 1; return this.playResult; }
    removeAttribute(name) { if (name === 'src') this.src = ''; }
    emit(name) { this.dispatchEvent(new Event(name)); }
}

function createCallbacks() {
    const results = { playing: 0, failed: 0 };
    return {
        results,
        onPlaying: () => { results.playing += 1; },
        onFailure: () => { results.failed += 1; }
    };
}

test('MP4 keeps the static cover until playback starts and releases its source on disposal', async () => {
    const video = new Video();
    const callbacks = createCallbacks();
    const dispose = attachDynamicCoverPlayback(video, 'https://example.test/cover.mp4', callbacks);
    assert.equal(video.src, 'https://example.test/cover.mp4');
    assert.equal(video.muted, true);
    assert.equal(video.defaultMuted, true);
    assert.equal(video.loop, true);
    assert.equal(video.playsInline, true);
    video.emit('canplay');
    await Promise.resolve();
    assert.deepEqual(callbacks.results, { playing: 0, failed: 0 });
    video.emit('playing');
    assert.deepEqual(callbacks.results, { playing: 1, failed: 0 });
    dispose();
    dispose();
    video.emit('canplay');
    video.emit('playing');
    video.emit('error');
    assert.equal(video.src, '');
    assert.equal(video.pauseCount, 1);
    assert.equal(video.playCount, 1);
    assert.deepEqual(callbacks.results, { playing: 1, failed: 0 });
});

test('native HLS playback is used when Hls.js does not support MSE', async () => {
    const video = new Video();
    video.nativeHls = 'probably';
    const dispose = attachDynamicCoverPlayback(video, 'https://example.test/cover.m3u8?token=a', {
        ...createCallbacks(),
        loadHls: async () => ({ default: { isSupported: () => false } })
    });
    await Promise.resolve();
    assert.equal(video.src, 'https://example.test/cover.m3u8?token=a');
    dispose();
});

test('Hls.js is preferred even when Chromium advertises native HLS support', async () => {
    const video = new Video();
    video.nativeHls = 'probably';
    let attachedVideo;
    class HlsPlayer {
        static Events = { ERROR: 'error' };
        static isSupported() { return true; }
        on() {}
        loadSource() {}
        attachMedia(media) { attachedVideo = media; }
        destroy() {}
    }
    const dispose = attachDynamicCoverPlayback(video, 'https://example.test/cover.m3u8', {
        ...createCallbacks(),
        loadHls: async () => ({ default: HlsPlayer })
    });
    await Promise.resolve();
    assert.equal(attachedVideo, video);
    assert.equal(video.src, '');
    assert.equal(video.loadCount, 0);
    dispose();
});

test('Hls.js import failure tries native HLS once without retrying failed playback', async () => {
    const video = new Video();
    video.nativeHls = 'probably';
    const callbacks = createCallbacks();
    let importCount = 0;
    const dispose = attachDynamicCoverPlayback(video, 'https://example.test/cover.m3u8', {
        ...callbacks,
        loadHls: async () => { importCount += 1; throw new Error('Hls.js could not be loaded'); }
    });
    await Promise.resolve();
    assert.equal(video.src, 'https://example.test/cover.m3u8');
    assert.equal(video.loadCount, 1);
    video.emit('error');
    video.emit('error');
    await Promise.resolve();
    assert.equal(importCount, 1);
    assert.equal(callbacks.results.failed, 1);
    assert.equal(video.src, '');
    dispose();
});

test('fatal HLS failure returns to the static cover and destroys the player once', async () => {
    const video = new Video();
    const callbacks = createCallbacks();
    let player;
    class HlsPlayer {
        static Events = { ERROR: 'error' };
        static isSupported() { return true; }
        destroyed = 0;
        constructor() { player = this; }
        on(_event, callback) { this.onError = callback; }
        loadSource(url) { this.url = url; }
        attachMedia(media) { this.video = media; }
        destroy() { this.destroyed += 1; }
    }
    const dispose = attachDynamicCoverPlayback(video, 'https://example.test/cover.m3u8', {
        ...callbacks,
        loadHls: async () => ({ default: HlsPlayer })
    });
    await Promise.resolve();
    assert.equal(player.video, video);
    assert.equal(player.url, 'https://example.test/cover.m3u8');
    player.onError('error', { fatal: false });
    assert.equal(callbacks.results.failed, 0);
    player.onError('error', { fatal: true });
    player.onError('error', { fatal: true });
    dispose();
    assert.equal(callbacks.results.failed, 1);
    assert.equal(player.destroyed, 1);
    assert.equal(video.pauseCount, 1);
});

test('switching tracks while Hls.js loads prevents a stale player from starting', async () => {
    const video = new Video();
    const callbacks = createCallbacks();
    let resolveImport;
    let constructed = false;
    class HlsPlayer {
        static isSupported() { return true; }
        constructor() { constructed = true; }
    }
    const dispose = attachDynamicCoverPlayback(video, 'https://example.test/cover.m3u8', {
        ...callbacks,
        loadHls: () => new Promise(resolve => { resolveImport = resolve; })
    });
    dispose();
    resolveImport({ default: HlsPlayer });
    await Promise.resolve();
    assert.equal(constructed, false);
    assert.deepEqual(callbacks.results, { playing: 0, failed: 0 });
});

test('autoplay rejection falls back without retrying', async () => {
    const video = new Video();
    const callbacks = createCallbacks();
    video.playResult = Promise.reject(new Error('autoplay denied'));
    const dispose = attachDynamicCoverPlayback(video, 'https://example.test/cover.mp4', callbacks);
    video.emit('canplay');
    await Promise.resolve();
    video.emit('canplay');
    assert.equal(callbacks.results.failed, 1);
    assert.equal(video.playCount, 1);
    assert.equal(video.src, '');
    dispose();
});

test('an old autoplay rejection cannot change the next track after disposal', async () => {
    const video = new Video();
    const callbacks = createCallbacks();
    let rejectPlay;
    video.playResult = new Promise((_resolve, reject) => { rejectPlay = reject; });
    const dispose = attachDynamicCoverPlayback(video, 'https://example.test/cover.mp4', callbacks);
    video.emit('canplay');
    dispose();
    rejectPlay(new Error('previous playback was interrupted'));
    await Promise.resolve();
    assert.deepEqual(callbacks.results, { playing: 0, failed: 0 });
});

test('loading or buffering for ten seconds stops playback and shows the static cover', t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const loadingVideo = new Video();
    const loadingCallbacks = createCallbacks();
    const disposeLoading = attachDynamicCoverPlayback(loadingVideo, 'https://example.test/cover.mp4', loadingCallbacks);
    t.mock.timers.tick(9_999);
    assert.equal(loadingCallbacks.results.failed, 0);
    t.mock.timers.tick(1);
    assert.equal(loadingCallbacks.results.failed, 1);
    assert.equal(loadingVideo.src, '');
    disposeLoading();

    const bufferingVideo = new Video();
    const bufferingCallbacks = createCallbacks();
    const disposeBuffering = attachDynamicCoverPlayback(bufferingVideo, 'https://example.test/cover.mp4', bufferingCallbacks);
    bufferingVideo.readyState = 3;
    bufferingVideo.emit('playing');
    // A network stall while enough frames are buffered is not a playback failure.
    bufferingVideo.emit('stalled');
    t.mock.timers.tick(10_000);
    assert.equal(bufferingCallbacks.results.failed, 0);
    bufferingVideo.emit('waiting');
    t.mock.timers.tick(10_000);
    assert.equal(bufferingCallbacks.results.failed, 1);
    disposeBuffering();

    const stalledVideo = new Video();
    const stalledCallbacks = createCallbacks();
    const disposeStalled = attachDynamicCoverPlayback(stalledVideo, 'https://example.test/cover.mp4', stalledCallbacks);
    stalledVideo.emit('playing');
    stalledVideo.readyState = 2;
    stalledVideo.emit('stalled');
    t.mock.timers.tick(10_000);
    assert.equal(stalledCallbacks.results.failed, 1);
    disposeStalled();
});

test('unsupported HLS playback and module load failures retain the static cover', async () => {
    for (const loadHls of [
        async () => ({ default: { isSupported: () => false } }),
        async () => { throw new Error('Hls.js could not be loaded'); }
    ]) {
        const video = new Video();
        const callbacks = createCallbacks();
        const dispose = attachDynamicCoverPlayback(video, 'https://example.test/cover.m3u8', { ...callbacks, loadHls });
        await Promise.resolve();
        await Promise.resolve();
        assert.deepEqual(callbacks.results, { playing: 0, failed: 1 });
        assert.equal(video.pauseCount, 1);
        dispose();
    }
});

test('a motion cover plays only for an http(s) URL in a visible window without reduced motion', () => {
    const visible = { hidden: false, reducedMotion: false };
    assert.equal(shouldShowDynamicCover({ url: 'https://mvod.itunes.apple.com/cover.m3u8', ...visible }), true);
    assert.equal(shouldShowDynamicCover({ url: 'http://127.0.0.1:5555/cover.mp4', ...visible }), true);
    for (const url of ['', '   ', null, undefined, 'javascript:alert(1)', 'data:video/mp4;base64,AAAA', '/cover.m3u8']) {
        assert.equal(shouldShowDynamicCover({ url, ...visible }), false, String(url));
    }
    assert.equal(shouldShowDynamicCover({ url: 'https://example.test/cover.m3u8', hidden: true, reducedMotion: false }), false);
    assert.equal(shouldShowDynamicCover({ url: 'https://example.test/cover.m3u8', hidden: false, reducedMotion: true }), false);
});

test('dimming applies to the cover wrapper while the video keeps only layout and loading classes', () => {
    const root = path.resolve(import.meta.dirname, '..');
    const cover = fs.readFileSync(path.join(root, 'src', 'DynamicCover.tsx'), 'utf8');
    const app = fs.readFileSync(path.join(root, 'src', 'App.tsx'), 'utf8');
    const videoStart = cover.indexOf('<video');
    const video = cover.slice(videoStart, cover.indexOf('/>', videoStart));
    assert.match(video, /className=\{`absolute inset-0 w-full h-full object-cover pointer-events-none \$\{state === 'playing' \? 'opacity-100' : 'opacity-0'\}`\}/);
    assert.match(cover, /className=\{`relative w-full h-full \$\{wrapperClassName\}`\}/);
    assert.match(cover, /\(prefers-reduced-motion: reduce\)/);
    assert.match(cover, /video\.pause\(\)/);

    const artworkStart = app.indexOf('const CurrentSongArtwork');
    const artwork = app.slice(artworkStart, app.indexOf('\n};', artworkStart));
    // Covers always render the wrapper, so a motion cover arriving later does not remount the image.
    assert.doesNotMatch(artwork, /DynamicCoverUrl\)\s*return/);
    assert.match(artwork, /wrapperClassName=\{className\}/);
    assert.match(artwork, /paused=\{paused\}/);
    assert.match(app, /<CurrentSongArtwork [^>]*paused=\{!playing\}/);
});
