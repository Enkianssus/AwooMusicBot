import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

export type AdminToastTone = 'error' | 'warning' | 'info';

export interface AdminToastMessage {
    id: number;
    message: string;
    tone: AdminToastTone;
    passive: boolean;
}

export interface AdminToastOptions {
    /** Background confirmations such as autosave never cover a toast that is still on screen. */
    passive?: boolean;
}

const BASE_DURATION_MS = 3000;
const PER_CHARACTER_MS = 60;
const MAX_DURATION_MS = 8000;
const ALERT_MIN_DURATION_MS = 6000;

const TONE_BACKGROUNDS: Record<AdminToastTone, string> = {
    info: 'var(--studio-action, #0874d0)',
    warning: '#916310',
    error: '#c43d59'
};

// @types/react 18 does not list the Popover API yet; React forwards the attribute unchanged.
const MANUAL_POPOVER: Record<string, string> = { popover: 'manual' };

function toastTone(message: string): AdminToastTone {
    const text = message.trimStart();
    if (text.startsWith('❌')) return 'error';
    return text.startsWith('⚠') ? 'warning' : 'info';
}

/** Long messages stay readable; failures and warnings get 6–8 s. */
function toastDuration(message: string, tone: AdminToastTone): number {
    const scaled = Math.min(MAX_DURATION_MS, BASE_DURATION_MS + PER_CHARACTER_MS * Array.from(message).length);
    return tone === 'info' ? scaled : Math.max(ALERT_MIN_DURATION_MS, scaled);
}

// The hook and the view it feeds belong together; fast refresh reloads this file in full.
export function useAdminToast() {
    const [toast, setToast] = useState<AdminToastMessage | null>(null);
    const visibleRef = useRef<AdminToastMessage | null>(null);
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const nextIdRef = useRef(0);

    const showToast = useCallback((message: string, options: AdminToastOptions = {}) => {
        if (!message.trim()) return;
        const passive = options.passive === true;
        if (passive && visibleRef.current && !visibleRef.current.passive) return;
        const tone = toastTone(message);
        nextIdRef.current += 1;
        const next = { id: nextIdRef.current, message, tone, passive };
        visibleRef.current = next;
        setToast(next);
        // A new toast restarts the countdown, so an older timer cannot cut it short.
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => {
            timerRef.current = null;
            visibleRef.current = null;
            setToast(null);
        }, toastDuration(message, tone));
    }, []);

    useEffect(() => () => {
        if (timerRef.current) clearTimeout(timerRef.current);
    }, []);

    return { toast, showToast };
}

/**
 * Renders in the top layer as a manual popover, so it also paints above the
 * update dialog opened with showModal() and its blurred backdrop.
 */
export function AdminToast({ toast }: { toast: AdminToastMessage | null }) {
    const elementRef = useRef<HTMLDivElement>(null);

    useLayoutEffect(() => {
        const element = elementRef.current;
        if (!element || typeof element.showPopover !== 'function') return;
        try {
            // Showing again moves the toast above a modal that opened after it.
            if (element.matches(':popover-open')) element.hidePopover();
            if (toast) element.showPopover();
        } catch {
            // Without the Popover API the fixed-position toast is still visible.
        }
    }, [toast]);

    const alert = toast?.tone === 'error';
    return (
        <div
            ref={elementRef}
            {...MANUAL_POPOVER}
            hidden={!toast}
            role={alert ? 'alert' : 'status'}
            aria-live={alert ? undefined : 'polite'}
            className="pointer-events-none fixed z-[99999] overflow-visible whitespace-pre-line break-words rounded-xl border-0 px-5 py-3 text-sm font-bold leading-relaxed"
            style={{
                inset: '32px 0 auto',
                margin: '0 auto',
                width: 'fit-content',
                maxWidth: 'min(520px, calc(100vw - 48px))',
                color: '#fff',
                background: TONE_BACKGROUNDS[toast?.tone || 'info'],
                boxShadow: '0 12px 32px rgba(6, 21, 39, 0.35)'
            }}
        >
            {toast?.message}
        </div>
    );
}
