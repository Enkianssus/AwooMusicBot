import { useEffect, useRef, useState } from 'react';

export interface PollingOptions<T> {
    /** Pause between the end of one poll and the start of the next. */
    intervalMs: number;
    /** While false nothing polls and the request in flight is aborted. */
    enabled?: boolean;
    /** Skip polls while the document is hidden and poll at once when it is shown again. */
    pauseWhenHidden?: boolean;
    /** When it returns true the previous data is kept, so an unchanged poll does not re-render. */
    isEqual?: (previous: T, next: T) => boolean;
}

/** True when both values serialize to the same JSON text. */
export function sameJson(previous: unknown, next: unknown): boolean {
    if (Object.is(previous, next)) return true;
    try {
        return JSON.stringify(previous) === JSON.stringify(next);
    } catch {
        return false;
    }
}

/**
 * Polls with a setTimeout chain, so requests never overlap. The fetcher gets
 * an AbortSignal that fires on unmount or when polling is disabled. A fetcher
 * may apply its result itself and resolve undefined; anything else becomes the
 * returned data, which keeps its identity while `isEqual` reports no change.
 */
export function usePolling<T>(
    fetcher: (signal: AbortSignal) => Promise<T>,
    { intervalMs, enabled = true, pauseWhenHidden = true, isEqual = sameJson }: PollingOptions<T>
): T | undefined {
    const [data, setData] = useState<T>();
    const fetcherRef = useRef(fetcher);
    const isEqualRef = useRef(isEqual);

    useEffect(() => {
        fetcherRef.current = fetcher;
        isEqualRef.current = isEqual;
    });

    useEffect(() => {
        if (!enabled) return;
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        let inFlight = false;
        const paused = () => pauseWhenHidden && document.hidden;

        const poll = async () => {
            timer = undefined;
            if (inFlight || controller.signal.aborted || paused()) return;
            inFlight = true;
            try {
                const next = await fetcherRef.current(controller.signal);
                if (next !== undefined && !controller.signal.aborted) {
                    setData(previous => previous !== undefined && isEqualRef.current(previous, next) ? previous : next);
                }
            } catch {
                // The next poll tries again.
            } finally {
                inFlight = false;
            }
            if (!controller.signal.aborted && !paused()) timer = setTimeout(() => void poll(), intervalMs);
        };

        const onVisibilityChange = () => {
            if (document.hidden) {
                if (timer) clearTimeout(timer);
                timer = undefined;
            } else if (!timer) {
                void poll();
            }
        };

        if (pauseWhenHidden) document.addEventListener('visibilitychange', onVisibilityChange);
        void poll();
        return () => {
            controller.abort();
            if (timer) clearTimeout(timer);
            document.removeEventListener('visibilitychange', onVisibilityChange);
        };
    }, [enabled, intervalMs, pauseWhenHidden]);

    return data;
}
