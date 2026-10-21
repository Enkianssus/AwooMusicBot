import { useCallback, useEffect, useRef, useState } from 'react';
import { internalApiUrl } from '../internal-api';
import { usePolling } from '../hooks/usePolling';
import { lastLogSeq, mergeLogEntries, type KeyedLogEntry } from '../log-buffer-policy';
import type { ColorMode } from '../ui-appearance';

const LOG_POLL_MS = 1000;
/** Closer to the bottom than this counts as following the newest lines. */
const FOLLOW_THRESHOLD_PX = 45;
const NO_LOGS: readonly KeyedLogEntry[] = [];

const mapConsoleColor = (color: string, mode: ColorMode): string => {
    const map: Record<string, string> = mode === 'dark' ? {
        Cyan: '#65d5ff', Yellow: '#f3cb70', Green: '#6ab9ff',
        Red: '#ff929f', DarkGray: '#97acc5', Magenta: '#c7adff'
    } : {
        Cyan: '#007dad', Yellow: '#9c6700', Green: '#1477c6',
        Red: '#c43d59', DarkGray: '#667d96', Magenta: '#8452b7'
    };
    return map[color] || (mode === 'dark' ? '#d9e8f8' : '#36516c');
};

/**
 * The 运行日志 tab. It owns the only logs poll, so nothing downloads logs while
 * another tab is open, and it pauses while the window is hidden.
 */
export default function LogsPanel({ colorMode }: { colorMode: ColorMode }) {
    const [autoScroll, setAutoScroll] = useState(true);
    const containerRef = useRef<HTMLDivElement>(null);
    const bufferRef = useRef<readonly KeyedLogEntry[]>(NO_LOGS);

    const pollLogs = useCallback(async (signal: AbortSignal) => {
        const after = lastLogSeq(bufferRef.current);
        // Servers that do not number their lines ignore ?after= and send the whole buffer.
        const query = after === null ? '' : `?after=${after}`;
        const response = await fetch(`${internalApiUrl('/api/logs')}${query}`, { signal, cache: 'no-store' });
        const incoming = await response.json();
        if (response.ok) bufferRef.current = mergeLogEntries(bufferRef.current, incoming);
        return bufferRef.current;
    }, []);

    const logs = usePolling(pollLogs, { intervalMs: LOG_POLL_MS, isEqual: Object.is }) ?? NO_LOGS;

    const scrollToBottom = () => {
        const container = containerRef.current;
        if (container) container.scrollTop = container.scrollHeight;
    };

    useEffect(() => {
        const container = containerRef.current;
        if (autoScroll && container) container.scrollTop = container.scrollHeight;
    }, [logs, autoScroll]);

    // Scrolling up pauses following so the reader keeps their place; reaching the bottom resumes it.
    const handleScroll = () => {
        const container = containerRef.current;
        if (!container) return;
        setAutoScroll(container.scrollHeight - container.scrollTop - container.clientHeight < FOLLOW_THRESHOLD_PX);
    };

    const resumeAutoScroll = () => {
        setAutoScroll(true);
        scrollToBottom();
    };

    return (
        <div className="space-y-4 animate-slide-in-right flex flex-col h-[70vh]">
            <div className="flex justify-between items-center pr-2">
                <div className="flex items-center gap-3 bg-black/40 px-3 py-1.5 rounded-lg border border-white/5">
                    <label className="text-xs text-gray-400 flex items-center gap-1.5 cursor-pointer select-none">
                        <input
                            type="checkbox"
                            checked={autoScroll}
                            onChange={event => {
                                setAutoScroll(event.target.checked);
                                if (event.target.checked) scrollToBottom();
                            }}
                            className="w-3.5 h-3.5 rounded border-white/20 bg-black/50 text-blue-500 focus:ring-0 cursor-pointer"
                        />
                        <span>自动滚动</span>
                    </label>
                    <div className="w-[1px] h-3 bg-white/10"></div>
                    <button onClick={resumeAutoScroll} className="text-xs text-blue-400 hover:text-blue-300 font-medium transition-colors">
                        ⬇️ 滚到底部
                    </button>
                </div>
            </div>

            <div className="flex-1 relative min-h-0">
                <div
                    ref={containerRef}
                    onScroll={handleScroll}
                    className="w-full h-full bg-[#090b0f] rounded-xl border border-white/10 p-4 font-mono text-[13px] overflow-y-auto custom-scrollbar flex flex-col gap-2 shadow-inner"
                >
                    {logs.length === 0 ? (
                        <div className="text-gray-500 text-center mt-10">暂无日志...</div>
                    ) : (
                        logs.map(log => (
                            <div key={log.key} className="flex gap-4 leading-relaxed">
                                <span className="text-gray-600 shrink-0">[{log.Time}]</span>
                                <span style={{ color: mapConsoleColor(log.Color, colorMode) }} className="break-all whitespace-pre-wrap">{log.Message}</span>
                            </div>
                        ))
                    )}
                </div>

                {!autoScroll && (
                    <button
                        onClick={resumeAutoScroll}
                        className="absolute bottom-4 right-4 bg-blue-600 hover:bg-blue-500 text-white px-3 py-2 rounded-full shadow-lg text-xs font-bold transition-all flex items-center gap-1.5 animate-bounce select-none border border-blue-400/30"
                    >
                        <span>⬇️</span> 自动滚动已暂停 (点击恢复)
                    </button>
                )}
            </div>
        </div>
    );
}
