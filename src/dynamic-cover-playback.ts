import type Hls from 'hls.js';

interface DynamicCoverPlaybackOptions {
    onPlaying: () => void;
    onFailure: () => void;
    loadHls?: () => Promise<typeof import('hls.js')>;
}

export interface DynamicCoverVisibility {
    url: string | null | undefined;
    /** The document is hidden, e.g. the window is minimized. */
    hidden: boolean;
    /** The user asked the system for reduced motion. */
    reducedMotion: boolean;
}

/** A motion cover plays only for an http(s) URL in a visible window without reduced motion. */
export function shouldShowDynamicCover({ url, hidden, reducedMotion }: DynamicCoverVisibility): boolean {
    return typeof url === 'string' && /^https?:\/\//i.test(url.trim()) && !hidden && !reducedMotion;
}

/** Own one muted cover playback session; disposing it also cancels pending HLS setup. */
export function attachDynamicCoverPlayback(
    video: HTMLVideoElement,
    url: string,
    { onPlaying, onFailure, loadHls = () => import('hls.js') }: DynamicCoverPlaybackOptions
): () => void {
    let disposed = false;
    let playRequested = false;
    let hls: Hls | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;

    const clearTimeoutTimer = () => {
        if (timeout !== undefined) clearTimeout(timeout);
        timeout = undefined;
    };

    const dispose = () => {
        if (disposed) return;
        disposed = true;
        clearTimeoutTimer();
        video.removeEventListener('canplay', requestPlayback);
        video.removeEventListener('playing', handlePlaying);
        video.removeEventListener('error', fail);
        video.removeEventListener('waiting', armTimeout);
        video.removeEventListener('stalled', handleStalled);
        hls?.destroy();
        hls = undefined;
        video.pause();
        video.removeAttribute('src');
        video.load();
    };

    function fail() {
        if (disposed) return;
        dispose();
        onFailure();
    }

    function armTimeout() {
        if (disposed || timeout !== undefined) return;
        timeout = setTimeout(fail, 10_000);
    }

    function handleStalled() {
        // A stopped network transfer is harmless while enough frames are buffered.
        if (video.readyState < 3) armTimeout();
    }

    function requestPlayback() {
        if (disposed || playRequested) return;
        playRequested = true;
        try {
            void Promise.resolve(video.play()).catch(fail);
        } catch {
            fail();
        }
    }

    function handlePlaying() {
        if (disposed) return;
        clearTimeoutTimer();
        onPlaying();
    }

    video.muted = true;
    video.defaultMuted = true;
    video.loop = true;
    video.autoplay = true;
    video.playsInline = true;
    video.addEventListener('canplay', requestPlayback);
    video.addEventListener('playing', handlePlaying);
    video.addEventListener('error', fail);
    video.addEventListener('waiting', armTimeout);
    video.addEventListener('stalled', handleStalled);
    armTimeout();

    try {
        const isHls = /\.m3u8(?:[?#]|$)/i.test(url);
        if (!isHls) {
            video.src = url;
            video.load();
        } else {
            const useNativeHls = () => {
                if (disposed) return;
                const canPlayNativeHls = video.canPlayType('application/vnd.apple.mpegurl')
                    || video.canPlayType('application/x-mpegURL');
                if (!canPlayNativeHls) {
                    fail();
                    return;
                }
                video.src = url;
                video.load();
            };
            // Chromium can advertise native HLS without actually playing it.
            // Prefer MSE; native playback is only a fallback for unavailable Hls.js.
            void loadHls().then(({ default: HlsPlayer }) => {
                if (disposed) return;
                if (!HlsPlayer.isSupported()) {
                    useNativeHls();
                    return;
                }
                hls = new HlsPlayer({
                    enableWorker: true,
                    capLevelToPlayerSize: true,
                    startLevel: 0,
                    maxBufferLength: 20,
                    maxMaxBufferLength: 30
                });
                hls.on(HlsPlayer.Events.ERROR, (_event, data) => {
                    if (data.fatal) fail();
                });
                hls.loadSource(url);
                hls.attachMedia(video);
            }, useNativeHls).catch(fail);
        }
    } catch {
        fail();
    }

    return dispose;
}
