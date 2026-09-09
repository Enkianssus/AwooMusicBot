import type { CSSProperties } from 'react';
import appIcon from '../assets/icon.ico?url';

const paths = {
    status: 'M3 10 12 3l9 7M5 9v11h5v-6h4v6h5V9',
    appearance: 'M12 3a9 9 0 1 0 0 18h1a2 2 0 0 0 1-3.7 1.5 1.5 0 0 1 1-2.8h2a4 4 0 0 0 4-4C21 6.4 17 3 12 3ZM7 10h.01M10 7h.01M15 7h.01M18 10h.01',
    settings: 'M4 6h16M4 12h16M4 18h16M8 3v6M16 9v6M10 15v6',
    login: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M17 9l2 2 3-3',
    update: 'M20 11a8 8 0 1 0-2.4 6.7M20 4v7h-7M12 8v8M9 11l3-3 3 3',
    faq: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20M9.1 9a3 3 0 0 1 5.8 1c0 2-3 2-3 4M12 17h.01',
    feedback: 'M21 11.5a8.5 8.5 0 0 1-8.5 8.5H3l1.7-4.2A8.5 8.5 0 1 1 21 11.5ZM8 10h8M8 14h5',
    logs: 'M8 3h8l4 4v14H4V3h4M14 3v5h6M8 12h8M8 16h6',
    debug: 'm8 7-5 5 5 5M16 7l5 5-5 5M14 4l-4 16',
    guide: 'm12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Z',
    music: 'M9 18V5l12-2v13M9 8l12-2M9 18a3 3 0 1 1-3-3 3 3 0 0 1 3 3ZM21 16a3 3 0 1 1-3-3 3 3 0 0 1 3 3Z',
    arrow: 'M5 12h14m-5-5 5 5-5 5',
    external: 'M14 3h7v7m0-7L10 14M10 3H3v18h18v-7',
    radio: 'M8.5 8.5a5 5 0 0 0 0 7M15.5 8.5a5 5 0 0 1 0 7M5.7 5.7a9 9 0 0 0 0 12.6M18.3 5.7a9 9 0 0 1 0 12.6M12 12h.01',
    queue: 'M4 6h16M4 12h11M4 18h8m5-4 5 4-5 4v-8Z',
    play: 'm8 4 13 8-13 8V4Z',
    pause: 'M8 4v16M16 4v16',
    check: 'm5 12 4 4L19 6',
    gift: 'M3 8h18v4H3V8ZM5 12v9h14v-9M12 8v13M12 8H7a3 3 0 1 1 3-3l2 3Zm0 0h5a3 3 0 1 0-3-3l-2 3Z',
    shield: 'm12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Zm-4 9 3 3 5-6',
    clock: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20M12 6v6l4 2',
    monitor: 'M3 3h18v14H3V3ZM8 21h8M12 17v4',
    sun: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
    moon: 'M20.9 13.2A9 9 0 0 1 10.8 3.1 9 9 0 1 0 20.9 13.2Z',
    pin: 'M9 3h6M10 3v6l-4 5v2h12v-2l-4-5V3M12 16v6',
    pinOff: 'm3 3 18 18M9 3h6M14 3v6l4 5v2M9 10l-3 4v2h10M12 16v6',
    minimize: 'M5 12h14',
    close: 'm6 6 12 12M18 6 6 18',
    trash: 'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7',
    top: 'M5 3h14M12 21V7m-6 6 6-6 6 6',
    more: 'M5 12h.01M12 12h.01M19 12h.01',
    headphones: 'M3 14v-3a9 9 0 0 1 18 0v3M3 12h4v9H5a2 2 0 0 1-2-2v-7Zm18 0h-4v9h2a2 2 0 0 0 2-2v-7Z',
} as const;

export type UiIconName = keyof typeof paths;

export function UiIcon({ name, className = '', style }: { name: UiIconName; className?: string; style?: CSSProperties }) {
    return <svg className={`awoo-icon ${className}`} style={style} width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}

export function AwooMark() {
    return <img className="awoo-app-icon" src={appIcon} width="28" height="28" alt="" aria-hidden="true" draggable="false" />;
}
