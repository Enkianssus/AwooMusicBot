import { useEffect, useRef, useState, type ReactNode } from 'react';
import { attachDynamicCoverPlayback, shouldShowDynamicCover } from './dynamic-cover-playback';

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

interface DynamicCoverProps {
    /** Motion cover URL; empty keeps the static cover. */
    url?: string;
    /** The static cover, shown until the motion cover plays and whenever it cannot. */
    children: ReactNode;
    /** Holds the motion cover on its current frame, e.g. while autoplay is paused. */
    paused?: boolean;
    /** Classes for the wrapper around both covers, such as the paused dimming. */
    wrapperClassName?: string;
}

function readReducedMotion(): boolean {
    return typeof window.matchMedia === 'function' && window.matchMedia(REDUCED_MOTION_QUERY).matches;
}

function usePrefersReducedMotion(): boolean {
    const [reducedMotion, setReducedMotion] = useState(readReducedMotion);

    useEffect(() => {
        if (typeof window.matchMedia !== 'function') return;
        const query = window.matchMedia(REDUCED_MOTION_QUERY);
        const update = () => setReducedMotion(query.matches);
        update();
        query.addEventListener('change', update);
        return () => query.removeEventListener('change', update);
    }, []);

    return reducedMotion;
}

function DynamicCoverVideo({ url, paused }: { url: string; paused: boolean }) {
    const videoRef = useRef<HTMLVideoElement>(null);
    const [state, setState] = useState<'loading' | 'playing' | 'failed'>('loading');

    useEffect(() => {
        const video = videoRef.current;
        if (!video) return;
        return attachDynamicCoverPlayback(video, url, {
            onPlaying: () => setState('playing'),
            onFailure: () => setState('failed')
        });
    }, [url]);

    useEffect(() => {
        const video = videoRef.current;
        if (!video || state === 'failed') return;
        if (paused) {
            video.pause();
        } else if (state === 'playing' && video.paused) {
            // The playback session handles a refused or failed start; here it only resumes.
            void Promise.resolve(video.play()).catch(() => undefined);
        }
    }, [paused, state]);

    if (state === 'failed') return null;

    return (
        <video
            ref={videoRef}
            muted
            loop
            autoPlay
            playsInline
            preload="auto"
            aria-hidden="true"
            tabIndex={-1}
            className={`absolute inset-0 w-full h-full object-cover pointer-events-none ${state === 'playing' ? 'opacity-100' : 'opacity-0'}`}
        />
    );
}

/**
 * Always renders the same wrapper with the static cover inside, so a motion
 * cover arriving or ending never remounts the image; the video is layered on
 * top only while it can play.
 */
export default function DynamicCover({ url = '', children, paused = false, wrapperClassName = '' }: DynamicCoverProps) {
    const [hidden, setHidden] = useState(() => document.hidden);
    const reducedMotion = usePrefersReducedMotion();

    useEffect(() => {
        const updateVisibility = () => setHidden(document.hidden);
        document.addEventListener('visibilitychange', updateVisibility);
        return () => document.removeEventListener('visibilitychange', updateVisibility);
    }, []);

    return (
        <div className={`relative w-full h-full ${wrapperClassName}`}>
            {children}
            {shouldShowDynamicCover({ url, hidden, reducedMotion }) && (
                <DynamicCoverVideo key={url} url={url} paused={paused} />
            )}
        </div>
    );
}
