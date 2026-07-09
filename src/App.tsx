import React, { useState, useEffect, useRef } from 'react';

// ==========================================
// 0. 环境检测
// ==========================================
const isElectron = new URLSearchParams(window.location.search).get('mode') === 'electron';

let ipcRenderer: any = null;
if (isElectron) {
    try {
        ipcRenderer = require('electron').ipcRenderer;
    } catch {
        console.warn('ipcRenderer 不可用');
    }
}

// ==========================================
// 1. 类型定义
// ==========================================
interface Theme {
    titleColor: string;
    textColor: string;
    subTextColor: string;
    bgColor: string;
    bgOpacity: number;
    showTitleBar: boolean;
    syncTitleBarWithBg: boolean;
    titleBarBgColor: string;
    titleBarOpacity?: number;
    compactQueue: boolean;
}

interface SongInfo {
    Id: string;
    SongName: string;
    ArtistName: string;
    OrderedByUid: string;
    OrderedByAvatar: string;
    OrderedBy: string;
    GuardLevel?: number;
}

interface ToastInfo {
    id: number;
    msg: string;
}

interface DragInfo {
    type: 'current' | 'queue';
    index: number;
    item: SongInfo;
    x: number;
    y: number;
    actionType?: 'none' | 'delete' | 'play' | 'push';
}

interface WidgetStyle {
    w: number;
    h: number;
    x: number;
    y: number;
}

interface SysLog {
    Time: string;
    Color: string;
    Message: string;
}

interface UpdateInfo {
    checking: boolean;
    info: any;
}

interface QrState {
    loading: boolean;
    base64: string;
    message: string;
}

interface LyricLine {
    readonly index: number;
    readonly time: number;
    readonly text: string;
    readonly translation: string;
}

interface LyricsPayload {
    readonly trackId: string;
    readonly songName: string;
    readonly artistName: string;
    readonly playedTime: number | null;
    readonly duration: number | null;
    readonly progress: number;
    readonly lines: LyricLine[];
    readonly current: LyricLine | null;
    readonly previous: LyricLine | null;
    readonly next: LyricLine | null;
    readonly hasLyrics: boolean;
    readonly isLoading: boolean;
    readonly isPlaying: boolean;
    readonly updatedAt: number;
}

interface LyricsWidgetSettings {
    readonly Alignment: 'left' | 'center' | 'right';
    readonly ShowSongInfo: boolean;
    readonly ShowTranslation: boolean;
    readonly MainColor: string;
    readonly TranslationColor: string;
    readonly OutlineEnabled: boolean;
    readonly OutlineColor: string;
    readonly OutlineSize: number;
    readonly ShadowEnabled: boolean;
    readonly ShadowSize: number;
    readonly FontFamily: string;
    readonly MainFontSize: number;
    readonly TranslationFontSize: number;
}

interface LyricsApiResponse {
    readonly lyrics: LyricsPayload | null;
    readonly cdpConnected: boolean;
    readonly config: LyricsWidgetSettings;
}

interface LyricsDisplayOptions {
    readonly alignment: 'left' | 'center' | 'right';
    readonly showSongInfo: boolean;
    readonly showTranslation: boolean;
    readonly textColor: string;
    readonly translationColor: string;
    readonly outlineEnabled: boolean;
    readonly outlineColor: string;
    readonly outlineSize: number;
    readonly shadowEnabled: boolean;
    readonly shadowSize: number;
    readonly fontFamily: string;
    readonly mainFontSize: number;
    readonly translationFontSize: number;
}

interface SystemFontsResponse {
    readonly fonts: readonly string[];
}

interface AdminConfigState {
    readonly config?: Record<string, unknown>;
    readonly [key: string]: unknown;
}

type LyricsToggleSettingKey = 'ShowSongInfo' | 'ShowTranslation' | 'OutlineEnabled' | 'ShadowEnabled';
type LyricsColorSettingKey = 'MainColor' | 'TranslationColor' | 'OutlineColor';

const defaultLyricsWidgetSettings: LyricsWidgetSettings = {
    Alignment: 'center',
    ShowSongInfo: true,
    ShowTranslation: true,
    MainColor: '#ffffff',
    TranslationColor: '#d1d5db',
    OutlineEnabled: true,
    OutlineColor: '#000000',
    OutlineSize: 2,
    ShadowEnabled: true,
    ShadowSize: 24,
    FontFamily: 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    MainFontSize: 56,
    TranslationFontSize: 30
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function readString(value: unknown): string {
    return typeof value === 'string' ? value : '';
}

function readFiniteNumber(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim()) {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) return parsed;
    }
    return null;
}

function readBoolean(value: unknown, fallback: boolean): boolean {
    return typeof value === 'boolean' ? value : fallback;
}

function readColor(value: unknown, fallback: string): string {
    if (typeof value !== 'string') return fallback;
    return /^#[0-9a-fA-F]{6}$/.test(value) ? value : fallback;
}

function readBoundedNumber(value: unknown, fallback: number, min: number, max: number): number {
    const parsed = readFiniteNumber(value);
    if (parsed === null) return fallback;
    return Math.max(min, Math.min(max, Math.round(parsed)));
}

function readLyricsAlignment(value: unknown): LyricsWidgetSettings['Alignment'] {
    return value === 'left' || value === 'right' || value === 'center' ? value : defaultLyricsWidgetSettings.Alignment;
}

function readLyricLine(value: unknown): LyricLine | null {
    if (!isRecord(value)) return null;

    const index = readFiniteNumber(value.index);
    const time = readFiniteNumber(value.time);
    if (index === null || time === null) return null;

    return {
        index,
        time,
        text: readString(value.text),
        translation: readString(value.translation)
    };
}

function readLyricLines(value: unknown): LyricLine[] {
    if (!Array.isArray(value)) return [];

    const lines: LyricLine[] = [];
    for (const item of value) {
        const line = readLyricLine(item);
        if (line) lines.push(line);
    }
    return lines;
}

function readLyricsWidgetSettings(value: unknown): LyricsWidgetSettings {
    if (!isRecord(value)) return defaultLyricsWidgetSettings;

    return {
        Alignment: readLyricsAlignment(value.Alignment),
        ShowSongInfo: readBoolean(value.ShowSongInfo, defaultLyricsWidgetSettings.ShowSongInfo),
        ShowTranslation: readBoolean(value.ShowTranslation, defaultLyricsWidgetSettings.ShowTranslation),
        MainColor: readColor(value.MainColor, defaultLyricsWidgetSettings.MainColor),
        TranslationColor: readColor(value.TranslationColor, defaultLyricsWidgetSettings.TranslationColor),
        OutlineEnabled: readBoolean(value.OutlineEnabled, defaultLyricsWidgetSettings.OutlineEnabled),
        OutlineColor: readColor(value.OutlineColor, defaultLyricsWidgetSettings.OutlineColor),
        OutlineSize: readBoundedNumber(value.OutlineSize, defaultLyricsWidgetSettings.OutlineSize, 0, 8),
        ShadowEnabled: readBoolean(value.ShadowEnabled, defaultLyricsWidgetSettings.ShadowEnabled),
        ShadowSize: readBoundedNumber(value.ShadowSize, defaultLyricsWidgetSettings.ShadowSize, 0, 80),
        FontFamily: readString(value.FontFamily) || defaultLyricsWidgetSettings.FontFamily,
        MainFontSize: readBoundedNumber(value.MainFontSize, defaultLyricsWidgetSettings.MainFontSize, 24, 96),
        TranslationFontSize: readBoundedNumber(value.TranslationFontSize, defaultLyricsWidgetSettings.TranslationFontSize, 14, 64)
    };
}

function toLyricsDisplayOptions(settings: LyricsWidgetSettings): LyricsDisplayOptions {
    return {
        alignment: settings.Alignment,
        showSongInfo: settings.ShowSongInfo,
        showTranslation: settings.ShowTranslation,
        textColor: settings.MainColor,
        translationColor: settings.TranslationColor,
        outlineEnabled: settings.OutlineEnabled,
        outlineColor: settings.OutlineColor,
        outlineSize: settings.OutlineSize,
        shadowEnabled: settings.ShadowEnabled,
        shadowSize: settings.ShadowSize,
        fontFamily: settings.FontFamily,
        mainFontSize: settings.MainFontSize,
        translationFontSize: settings.TranslationFontSize
    };
}

function readLyricsPayload(value: unknown): LyricsPayload | null {
    if (!isRecord(value)) return null;

    const progress = readFiniteNumber(value.progress);
    const updatedAt = readFiniteNumber(value.updatedAt);
    if (progress === null || updatedAt === null) return null;

    return {
        trackId: readString(value.trackId),
        songName: readString(value.songName),
        artistName: readString(value.artistName),
        playedTime: readFiniteNumber(value.playedTime),
        duration: readFiniteNumber(value.duration),
        progress: Math.max(0, Math.min(1, progress)),
        lines: readLyricLines(value.lines),
        current: readLyricLine(value.current),
        previous: readLyricLine(value.previous),
        next: readLyricLine(value.next),
        hasLyrics: value.hasLyrics === true,
        isLoading: value.isLoading === true,
        isPlaying: value.isPlaying === true,
        updatedAt
    };
}

function readLyricsApiResponse(value: unknown): LyricsApiResponse {
    if (!isRecord(value)) return { lyrics: null, cdpConnected: false, config: defaultLyricsWidgetSettings };

    return {
        lyrics: readLyricsPayload(value.lyrics),
        cdpConnected: value.cdpConnected === true,
        config: readLyricsWidgetSettings(value.config)
    };
}

function readStringList(value: unknown): readonly string[] {
    if (!Array.isArray(value)) return [];
    return value.filter(item => typeof item === 'string' && item.trim().length > 0);
}

function readSystemFontsResponse(value: unknown): SystemFontsResponse {
    if (!isRecord(value)) return { fonts: [] };
    return { fonts: readStringList(value.fonts) };
}

function estimatePlayedTime(lyrics: LyricsPayload, now: number): number | null {
    if (lyrics.playedTime === null) return null;
    if (!lyrics.isPlaying) return lyrics.playedTime;

    const elapsedSeconds = Math.max(0, (now - lyrics.updatedAt) / 1000);
    const estimated = lyrics.playedTime + elapsedSeconds;
    return lyrics.duration === null ? estimated : Math.min(lyrics.duration, estimated);
}

function findLyricLineIndex(lines: LyricLine[], playedTime: number | null): number {
    if (playedTime === null) return -1;
    for (let index = lines.length - 1; index >= 0; index--) {
        if (playedTime >= lines[index].time) return index;
    }
    return -1;
}

function resolveLocalLyrics(lyrics: LyricsPayload | null, now: number): LyricsPayload | null {
    if (!lyrics || lyrics.lines.length === 0) return lyrics;

    const playedTime = estimatePlayedTime(lyrics, now);
    const index = findLyricLineIndex(lyrics.lines, playedTime);
    if (index < 0) return { ...lyrics, playedTime, current: null, previous: null, next: lyrics.lines[0] || null };

    const current = lyrics.lines[index] || null;
    const previous = index > 0 ? lyrics.lines[index - 1] || null : null;
    const next = index + 1 < lyrics.lines.length ? lyrics.lines[index + 1] || null : null;
    const progress = current && next && playedTime !== null && next.time > current.time
        ? Math.max(0, Math.min(1, (playedTime - current.time) / (next.time - current.time)))
        : 0;

    return { ...lyrics, playedTime, progress, current, previous, next };
}

function getLyricsProbeDelay(lyrics: LyricsPayload | null): number {
    if (!lyrics || lyrics.isLoading || !lyrics.hasLyrics) return 250;

    const playedTime = estimatePlayedTime(lyrics, Date.now());
    if (playedTime !== null && lyrics.duration !== null && lyrics.duration - playedTime < 2) return 200;
    if (!lyrics.isPlaying) return 1200;

    const localLyrics = resolveLocalLyrics(lyrics, Date.now());
    if (localLyrics?.next && playedTime !== null) {
        const nextLineDelay = (localLyrics.next.time - playedTime) * 1000;
        if (nextLineDelay < 300) return 120;
        if (nextLineDelay < 1500) return 250;
        return Math.min(1400, Math.max(500, nextLineDelay - 300));
    }

    return 900;
}

function buildLyricsTextShadow(options: LyricsDisplayOptions): string | undefined {
    if (!options.shadowEnabled || options.shadowSize <= 0) return undefined;

    const offset = Math.max(1, Math.round(options.shadowSize / 4));
    return `0 ${offset}px ${options.shadowSize}px rgba(0, 0, 0, 0.6)`;
}

// ==========================================
// 2. 全局样式
// ==========================================
const GlobalStyles: React.FC = () => (
    <style>{`
    @keyframes slideInUp { from { opacity: 0; transform: translateY(15px) scale(0.98); } to { opacity: 1; transform: translateY(0) scale(1); } }
    @keyframes slideInRight { from { opacity: 0; transform: translateX(10px); } to { opacity: 1; transform: translateX(0); } }
    @keyframes fadeIn { from { opacity: 0; transform: scale(0.95); } to { opacity: 1; transform: scale(1); } }
    @keyframes toastSlideIn { from { opacity: 0; transform: translate(-50%, -20px); } to { opacity: 1; transform: translate(-50%, 0); } }
    
    html, body, #root { 
        background: transparent !important; 
        margin: 0; padding: 0; 
        width: 100%; height: 100%;
        overflow: visible !important; 
    }
    
    ::-webkit-scrollbar { display: none; }
    
    .custom-scrollbar::-webkit-scrollbar { display: block; width: 4px; }
    .custom-scrollbar::-webkit-scrollbar-track { background: transparent; }
    .custom-scrollbar::-webkit-scrollbar-thumb { background: rgba(255, 255, 255, 0.15); border-radius: 4px; }
    .custom-scrollbar::-webkit-scrollbar-thumb:hover { background: rgba(255, 255, 255, 0.3); }
    
    .glass-panel-base { 
        backdrop-filter: blur(20px); 
        -webkit-backdrop-filter: blur(20px); 
        border: 1px solid rgba(255, 255, 255, 0.12); 
        box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3); 
    }
    .glass-card { background: rgba(255, 255, 255, 0.05); border: 1px solid rgba(255, 255, 255, 0.08); box-shadow: 0 4px 16px rgba(0, 0, 0, 0.1); }
    img { user-drag: none; -webkit-user-drag: none; }
    input[type="color"] { -webkit-appearance: none; border: none; padding: 0; }
    input[type="color"]::-webkit-color-swatch-wrapper { padding: 0; }
    input[type="color"]::-webkit-color-swatch { border: 1px solid rgba(255,255,255,0.2); border-radius: 4px; }
    
    .no-drag { -webkit-app-region: no-drag; }
  `}</style>
);

const hexToRgba = (hex: string, alpha: number): string => {
    if (!hex) return `rgba(0, 0, 0, ${alpha})`;
    const r = parseInt(hex.slice(1, 3), 16) || 22;
    const g = parseInt(hex.slice(3, 5), 16) || 24;
    const b = parseInt(hex.slice(5, 7), 16) || 30;
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
};

const mapConsoleColor = (color: string): string => {
    const map: Record<string, string> = {
        'Cyan': '#22d3ee', 'Yellow': '#facc15', 'Green': '#4ade80',
        'Red': '#f87171', 'DarkGray': '#9ca3af', 'Magenta': '#c084fc'
    };
    return map[color] || '#e5e7eb';
};

const getGuardStyle = (level?: number) => {
    switch(level) {
        case 1: return { border: 'border-red-500 shadow-[0_0_8px_rgba(239,68,68,0.6)]', tag: 'bg-gradient-to-r from-red-600 to-red-400 text-white shadow-sm', label: '总督' };
        case 2: return { border: 'border-purple-400 shadow-[0_0_8px_rgba(192,132,252,0.6)]', tag: 'bg-gradient-to-r from-purple-600 to-purple-400 text-white shadow-sm', label: '提督' };
        case 3: return { border: 'border-blue-400 shadow-[0_0_8px_rgba(96,165,250,0.6)]', tag: 'bg-gradient-to-r from-blue-600 to-blue-400 text-white shadow-sm', label: '舰长' };
        default: return { border: 'border-white/10', tag: '', label: '' };
    }
};

const defaultTheme: Theme = {
    titleColor: '#ffffff', textColor: '#ffffff', subTextColor: '#a0aec0', bgColor: '#16181e', bgOpacity: 0.85,
    showTitleBar: true, syncTitleBarWithBg: false, titleBarBgColor: '#000000', titleBarOpacity: 0.2,
    compactQueue: false
};

// ==========================================
// 3. 核心组件: Overlay 悬浮窗面板
// ==========================================
interface OverlayWidgetProps {
    onToggleAdmin: () => void;
}

const OverlayWidget: React.FC<OverlayWidgetProps> = ({ onToggleAdmin }) => {
    const [data, setData] = useState<{ current: SongInfo | null; queue: SongInfo[]; status: string }>({ current: null, queue: [], status: '' });
    const [isConnected, setIsConnected] = useState<boolean>(true);
    const [isCdpConnected, setIsCdpConnected] = useState<boolean>(true);
    const [accepting, setAccepting] = useState<boolean>(true);
    const [playing, setPlaying] = useState<boolean>(true);

    const [rejects, setRejects] = useState<any[]>([]);
    const [, setPrevQueue] = useState<SongInfo[]>([]);
    const [newItemsIds, setNewItemsIds] = useState<Set<string>>(new Set());

    const [dragInfo, setDragInfo] = useState<DragInfo | null>(null);
    const [showSettings, setShowSettings] = useState<boolean>(false);

    // ⭐ 新增: 全局 UI 500ms 冷却锁定
    const [actionLock, setActionLock] = useState<boolean>(false);

    const [theme, setTheme] = useState<Theme>(() => {
        try {
            const saved = localStorage.getItem('bili-widget-theme');
            return saved ? { ...defaultTheme, ...JSON.parse(saved) } : defaultTheme;
        } catch { return defaultTheme; }
    });

    const [toasts, setToasts] = useState<ToastInfo[]>([]);
    const lastToastTimeRef = useRef<number>(0);
    const lastSyncTimeRef = useRef<number>(0);
    const appsIssueToastShownRef = useRef<boolean>(false);

    const triggerToast = (msg: string) => {
        const id = Date.now() + Math.random();
        setToasts(prev => [...prev, { id, msg }]);
        setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 5000);
    };

    // ⭐ 触发冷却锁的方法
    const triggerActionLock = () => {
        setActionLock(true);
        setTimeout(() => setActionLock(false), 1000);
    };

    const [widgetStyle, setWidgetStyle] = useState<WidgetStyle>(() => {
        if (isElectron) return { w: 0, h: 0, x: 0, y: 0 };
        let w = 320, h = 480, x = 50, y = 50;
        try {
            const savedSize = JSON.parse(localStorage.getItem('bili-widget-size') || '{}');
            if (savedSize && savedSize.w >= 200) { w = savedSize.w; h = savedSize.h; }
            const savedPos = JSON.parse(localStorage.getItem('bili-widget-pos') || '{}');
            if (savedPos && typeof savedPos.x === 'number') {
                let safeX = savedPos.x; let safeY = savedPos.y;
                if (safeX < -100 || safeX > window.innerWidth || safeY < -100 || safeY > window.innerHeight) { safeX = 50; safeY = 50; }
                x = safeX; y = safeY;
            }
        } catch {}
        return { w, h, x, y };
    });

    useEffect(() => {
        const isFirstTime = localStorage.getItem('bili-first-launch') === null;
        if (isFirstTime && isElectron) {
            localStorage.setItem('bili-first-launch', 'false');
            setTimeout(() => {
                triggerToast("🎉 欢迎使用！已自动为您打开控制面板。如果您关闭了它，可随时点击右上角的 ⚙️ 按钮呼出！");
                ipcRenderer?.send('open-admin');
            }, 1000);
        }
    }, []);

    // 外观设置自动保存机制 (防抖 0.5s)
    useEffect(() => {
        localStorage.setItem('bili-widget-theme', JSON.stringify(theme));

        const syncTimer = setTimeout(() => {
            const timestamp = Date.now();
            let currentW = widgetStyle.w; let currentH = widgetStyle.h;

            if (isElectron) {
                currentW = window.innerWidth; currentH = window.innerHeight;
            }

            const widgetStyleToSave = {
                theme,
                size: { w: Math.max(240, currentW), h: Math.max(300, currentH) },
                timestamp
            };

            lastSyncTimeRef.current = timestamp;
            fetch('http://localhost:5555/api/config', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ widgetStyle: widgetStyleToSave })
            }).catch(()=>{});
        }, 500);

        return () => clearTimeout(syncTimer);
    }, [theme, widgetStyle, isElectron]);

    useEffect(() => {
        if (isElectron) return;
        const target = document.querySelector('.react-widget-root') as HTMLElement;
        if (target) {
            target.style.width = `${widgetStyle.w}px`;
            target.style.height = `${widgetStyle.h}px`;
            target.style.left = `${widgetStyle.x}px`;
            target.style.top = `${widgetStyle.y}px`;
            target.style.margin = '0';
        }
    }, [widgetStyle, isElectron]);

    useEffect(() => {
        const fetchData = async () => {
            try {
                const res = await fetch('http://localhost:5555/data');
                if (!res.ok) throw new Error("Network response was not ok");
                const json: any = await res.json();

                if (json.uiConfig && json.uiConfig.timestamp) {
                    if (json.uiConfig.timestamp > lastSyncTimeRef.current) {
                        const { theme: bTheme, timestamp, size: bSize } = json.uiConfig;
                        if (bTheme) setTheme({ ...defaultTheme, ...bTheme });

                        if (!isElectron) {
                            setWidgetStyle(prev => {
                                const next = { ...prev };
                                let changed = false;
                                if (bSize && typeof bSize.w === 'number') {
                                    next.w = Math.max(240, bSize.w);
                                    next.h = Math.max(300, bSize.h);
                                    localStorage.setItem('bili-widget-size', JSON.stringify({ w: next.w, h: next.h }));
                                    changed = true;
                                }
                                return changed ? next : prev;
                            });
                        }
                        lastSyncTimeRef.current = timestamp;
                    }
                }

                if (json.toast && json.toast.time > lastToastTimeRef.current) {
                    lastToastTimeRef.current = json.toast.time;
                    triggerToast(json.toast.msg);
                }

                setRejects(json.rejects || []);

                const safeQueue: SongInfo[] = Array.isArray(json.queue) ? json.queue : [];
                setPrevQueue(prev => {
                    const prevIds = new Set(prev.map(s => `${s.Id}-${s.OrderedByUid}`));
                    const currentIds = safeQueue.map(s => `${s.Id}-${s.OrderedByUid}`);
                    const newIds = new Set<string>();
                    currentIds.forEach(id => { if (!prevIds.has(id)) newIds.add(id); });
                    if (newIds.size > 0) { setNewItemsIds(newIds); setTimeout(() => setNewItemsIds(new Set()), 1000); }
                    return safeQueue;
                });

                setData({ current: json.current || null, queue: safeQueue, status: json.status || '' });
                setAccepting(json.accepting ?? true);
                setPlaying(json.playing ?? true);
                setIsConnected(true);

                if (typeof json.cdpConnected === 'boolean') {
                    setIsCdpConnected(json.cdpConnected);
                }

                // ⭐ 针对 WindowsApps 启动权限错误的 Overlay 静默诊断与浮窗强提示
                if (json.status && (json.status.includes('EPERM') || json.status.includes('WindowsApps'))) {
                    if (!appsIssueToastShownRef.current) {
                        appsIssueToastShownRef.current = true;
                        triggerToast("⚠️ 启动失败！检测到网易云可能处于系统安全目录下(WindowsApps)或发生权限问题。请点击设置进入控制面板查看异常排查指南！");
                    }
                } else {
                    appsIssueToastShownRef.current = false;
                }

            } catch { setIsConnected(false); }
        };
        fetchData();
        const timer = setInterval(fetchData, 1000);
        return () => clearInterval(timer);
    }, []);

    const handleQueueAction = async (action: string, payload: any) => {
        // ⭐ 防抖保护
        if (!isElectron || actionLock) return;
        triggerActionLock();
        try {
            await fetch('http://localhost:5555/api/queue/action', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action, ...payload })
            });
        } catch(err) { console.error("操作失败", err); }
    };

    const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>, type: 'current' | 'queue', index: number, item: SongInfo) => {
        // ⭐ 防抖保护
        if (!isElectron || actionLock) return;
        e.preventDefault(); e.stopPropagation();
        setDragInfo({ type, index, item, x: e.clientX, y: e.clientY, actionType: 'none' });

        const appZoneRect = document.querySelector('.glass-panel-base')?.getBoundingClientRect();
        const queueZoneRect = document.querySelector('.queue-zone')?.getBoundingClientRect();

        let currentActionType: 'none' | 'delete' | 'play' | 'push' = 'none';

        const onPointerMove = (ev: PointerEvent) => {
            if ((window as any)._dragTimer) return;
            (window as any)._dragTimer = requestAnimationFrame(() => {
                let renderX = ev.clientX;
                let renderY = ev.clientY;
                if (isElectron) {
                    renderX = Math.max(140, Math.min(renderX, window.innerWidth - 140));
                    renderY = Math.max(35, Math.min(renderY, window.innerHeight - 35));
                }

                const ghostEl = document.getElementById('drag-ghost');
                if (ghostEl) {
                    ghostEl.style.transform = `translate3d(${renderX}px, ${renderY}px, 0) translate(-50%, -50%)`;
                }

                let newActionType: 'none' | 'delete' | 'play' | 'push' = 'none';

                if (appZoneRect) {
                    const isOutside = ev.clientX < appZoneRect.left || ev.clientX > appZoneRect.right ||
                        ev.clientY < appZoneRect.top || ev.clientY > appZoneRect.bottom;

                    if (isOutside) {
                        newActionType = 'delete';
                    } else if (queueZoneRect) {
                        const dividingY = queueZoneRect.top - 5;

                        if (type === 'queue' && ev.clientY < dividingY) {
                            newActionType = 'play';
                        } else if (type === 'current' && ev.clientY >= dividingY) {
                            newActionType = 'push';
                        }
                    }
                }

                if (newActionType !== currentActionType) {
                    currentActionType = newActionType;
                    setDragInfo(prev => prev ? { ...prev, x: ev.clientX, y: ev.clientY, actionType: newActionType } : null);
                }

                (window as any)._dragTimer = null;
            });
        };

        const onPointerUp = (ev: PointerEvent) => {
            if ((window as any)._dragTimer) {
                cancelAnimationFrame((window as any)._dragTimer);
                (window as any)._dragTimer = null;
            }
            document.removeEventListener('pointermove', onPointerMove);
            document.removeEventListener('pointerup', onPointerUp);
            setDragInfo(null);

            // ⭐ 拖拽释放后，同样启动 500ms 冷却锁定
            triggerActionLock();

            if (currentActionType === 'delete') {
                if (type === 'queue') handleQueueAction('delete', { index });
                if (type === 'current') handleQueueAction('skip_current', {});
            } else if (currentActionType === 'play') {
                if (type === 'queue') handleQueueAction('play_now', { index });
            } else if (currentActionType === 'push') {
                if (type === 'current') handleQueueAction('push_current_to_queue', {});
            } else {
                if (type === 'queue') {
                    const items = Array.from(document.querySelectorAll('.queue-item'));
                    let targetIndex = items.length - 1;
                    for (let i = 0; i < items.length; i++) {
                        const rect = items[i].getBoundingClientRect();
                        if (ev.clientY < rect.top + rect.height / 2) { targetIndex = i; break; }
                    }
                    targetIndex = Math.max(0, targetIndex);
                    if (targetIndex !== index) handleQueueAction('reorder', { from: index, to: targetIndex });
                }
            }
        };

        document.addEventListener('pointermove', onPointerMove);
        document.addEventListener('pointerup', onPointerUp);
    };

    const toggleAccepting = async (e?: React.MouseEvent) => {
        if (!isElectron || actionLock) return;
        e?.stopPropagation?.();
        triggerActionLock();
        try {
            await fetch('http://localhost:5555/api/state/toggle', { method: 'POST' });
            setAccepting(!accepting);
        } catch(err) { console.error(err); }
    };

    const togglePlaying = async (e?: React.MouseEvent) => {
        if (!isElectron || actionLock) return;
        e?.stopPropagation?.();
        triggerActionLock();
        try {
            await fetch('http://localhost:5555/api/state/toggle_play', { method: 'POST' });
            setPlaying(!playing);
        } catch(err) { console.error(err); }
    };

    const handleWindowClose = () => {
        if (isElectron && ipcRenderer) ipcRenderer.send('close-window');
        else { fetch('http://localhost:5555/api/exit', { method: 'POST' }); window.close(); }
    };

    const handleWindowMinimize = () => {
        if (isElectron && ipcRenderer) ipcRenderer.send('minimize-window');
    };

    const handleDragStart = (e: React.MouseEvent<HTMLDivElement>) => {
        if (isElectron) return;
        const targetElement = e.target as HTMLElement;
        if (targetElement.tagName.toLowerCase() === 'input' || targetElement.tagName.toLowerCase() === 'button' || targetElement.closest('.no-drag')) return;
        const target = (e.currentTarget as HTMLElement).closest('.react-widget-root') as HTMLElement;
        if (!target) return;

        let startX = e.clientX, startY = e.clientY, initialX = widgetStyle.x, initialY = widgetStyle.y;

        const onMouseMove = (ev: MouseEvent) => {
            target.style.left = `${initialX + (ev.clientX - startX)}px`;
            target.style.top = `${initialY + (ev.clientY - startY)}px`;
        };
        const onMouseUp = () => {
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);

            const newPos = { x: target.offsetLeft, y: target.offsetTop };
            setWidgetStyle(prev => ({ ...prev, x: newPos.x, y: newPos.y }));
            localStorage.setItem('bili-widget-pos', JSON.stringify(newPos));
        };
        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
    };

    const handleResizeStart = (e: React.PointerEvent<HTMLDivElement>) => {
        if (isElectron) return;
        e.stopPropagation(); e.preventDefault();
        const targetHandle = e.currentTarget;
        const target = targetHandle.closest('.react-widget-root') as HTMLElement;
        if (!target) return;

        targetHandle.setPointerCapture(e.pointerId);

        let startX = e.clientX, startY = e.clientY, initialW = widgetStyle.w, initialH = widgetStyle.h;
        let animationFrameId: number;

        const onPointerMove = (ev: PointerEvent) => {
            if (animationFrameId) cancelAnimationFrame(animationFrameId);
            animationFrameId = requestAnimationFrame(() => {
                target.style.width = `${Math.max(240, initialW + (ev.clientX - startX))}px`;
                target.style.height = `${Math.max(300, initialH + (ev.clientY - startY))}px`;
            });
        };
        const onPointerUp = (ev: PointerEvent) => {
            if (animationFrameId) cancelAnimationFrame(animationFrameId);
            targetHandle.releasePointerCapture(ev.pointerId);
            targetHandle.removeEventListener('pointermove', onPointerMove as any);
            targetHandle.removeEventListener('pointerup', onPointerUp as any);

            const newSize = { w: target.offsetWidth, h: target.offsetHeight };
            setWidgetStyle(prev => ({ ...prev, w: newSize.w, h: newSize.h }));
            localStorage.setItem('bili-widget-size', JSON.stringify(newSize));
        };
        targetHandle.addEventListener('pointermove', onPointerMove as any);
        targetHandle.addEventListener('pointerup', onPointerUp as any);
    };

    const handleElectronResizeStart = (e: React.PointerEvent<HTMLDivElement>) => {
        if (!isElectron) return;
        e.stopPropagation(); e.preventDefault();
        const target = e.currentTarget;
        target.setPointerCapture(e.pointerId);

        const startX = e.screenX; const startY = e.screenY;
        const initialW = window.outerWidth; const initialH = window.outerHeight;
        let lastW = initialW; let lastH = initialH;
        let animationFrameId: number;

        const onPointerMove = (ev: PointerEvent) => {
            if (animationFrameId) cancelAnimationFrame(animationFrameId);
            animationFrameId = requestAnimationFrame(() => {
                lastW = Math.max(300, initialW + (ev.screenX - startX));
                lastH = Math.max(400, initialH + (ev.screenY - startY));
                ipcRenderer?.send('overlay-resize', lastW, lastH);
            });
        };

        const onPointerUp = (ev: PointerEvent) => {
            if (animationFrameId) cancelAnimationFrame(animationFrameId);
            target.releasePointerCapture(ev.pointerId);
            target.removeEventListener('pointermove', onPointerMove as any);
            target.removeEventListener('pointerup', onPointerUp as any);
        };

        target.addEventListener('pointermove', onPointerMove as any);
        target.addEventListener('pointerup', onPointerUp as any);
    };

    let dragRenderX = 0, dragRenderY = 0;
    if (dragInfo) {
        dragRenderX = dragInfo.x;
        dragRenderY = dragInfo.y;
        if (isElectron) {
            dragRenderX = Math.max(140, Math.min(dragInfo.x, window.innerWidth - 140));
            dragRenderY = Math.max(35, Math.min(dragInfo.y, window.innerHeight - 35));
        }
    }

    const getStatusColor = (status: string | undefined) => {
        if (!status) return theme.subTextColor;
        if (status.includes('❌') || status.includes('🔴')) return '#f87171';
        if (status.includes('✅') || status.includes('🟢')) return '#4ade80';
        if (status.includes('⚠️') || status.includes('拦截')) return '#facc15';
        if (status.includes('⬆️') || status.includes('⏭️') || status.includes('🔙') || status.includes('🔄') || status.includes('▶️') || status.includes('⚡')) return '#c084fc';
        if (status.includes('test') || status.includes('测试')) return '#22d3ee';
        return theme.subTextColor;
    };

    const getStatusAnimation = (status: string | undefined) => {
        if (!status) return '';
        if (status.includes('test') || status.includes('测试') || status.includes('⚠️') || status.includes('❌') || status.includes('⚡') || status.includes('▶️')) return 'animate-pulse';
        return '';
    };

    return (
        <div className={isElectron
            ? "w-full h-screen p-5 flex flex-col font-sans select-none group box-border overflow-hidden bg-transparent pointer-events-none no-drag"
            : "react-widget-root absolute p-4 flex flex-col font-sans select-none z-[50] group cursor-grab active:cursor-grabbing"
        }>
            <div className="fixed top-8 left-1/2 transform -translate-x-1/2 z-[9999] flex flex-col gap-2 pointer-events-none w-max">
                {toasts.map(t => (
                    <div key={t.id} className="animate-toast bg-gradient-to-r from-blue-600 to-cyan-500 border border-cyan-400/50 text-white px-5 py-2.5 rounded-full shadow-[0_10px_30px_rgba(6,182,212,0.4)] text-sm font-bold flex items-center gap-2.5">
                        <span className="text-xl">🔔</span> {t.msg}
                    </div>
                ))}
            </div>

            {dragInfo && (
                <div
                    id="drag-ghost"
                    className="no-drag fixed z-[999999] rounded-xl p-2.5 flex items-center gap-3 opacity-95 scale-105 pointer-events-none transition-colors duration-200 overflow-hidden"
                    style={{
                        left: 0, top: 0,
                        transform: `translate3d(${dragRenderX}px, ${dragRenderY}px, 0) translate(-50%, -50%)`,
                        willChange: 'transform',
                        width: '260px',
                        background: dragInfo.actionType === 'delete' ? 'rgba(239, 68, 68, 0.95)' :
                            dragInfo.actionType === 'play' ? 'rgba(34, 197, 94, 0.95)' :
                                dragInfo.actionType === 'push' ? 'rgba(59, 130, 246, 0.95)' : 'rgba(20,20,20,0.7)',
                        border: dragInfo.actionType === 'delete' ? '2px solid #ef4444' :
                            dragInfo.actionType === 'play' ? '2px solid #22c55e' :
                                dragInfo.actionType === 'push' ? '2px solid #3b82f6' : '1px solid rgba(255,255,255,0.08)',
                        boxShadow: dragInfo.actionType === 'delete' ? '0 10px 30px rgba(239,68,68,0.6)' :
                            dragInfo.actionType === 'play' ? '0 10px 30px rgba(34,197,94,0.6)' :
                                dragInfo.actionType === 'push' ? '0 10px 30px rgba(59,130,246,0.6)' : '0 20px 50px rgba(0,0,0,0.6)',
                        backdropFilter: 'blur(16px)'
                    }}
                >
                    {dragInfo.actionType === 'delete' ? (
                        <div className="w-full py-1 text-center font-bold text-white text-[15px] tracking-widest flex items-center justify-center gap-2">
                            <span className="text-xl animate-bounce">🗑️</span> 松开以删除该歌曲
                        </div>
                    ) : dragInfo.actionType === 'play' ? (
                        <div className="w-full py-1 text-center font-bold text-white text-[15px] tracking-widest flex items-center justify-center gap-2">
                            <span className="text-xl animate-pulse">▶️</span> 松开以立即播放
                        </div>
                    ) : dragInfo.actionType === 'push' ? (
                        <div className="w-full py-1 text-center font-bold text-white text-[15px] tracking-widest flex items-center justify-center gap-2">
                            <span className="text-xl animate-pulse">🔙</span> 松开以退回队列
                        </div>
                    ) : (
                        <>
                            <div className="w-8 h-8 rounded-full overflow-hidden shrink-0 border border-white/20">
                                <img src={dragInfo.item.OrderedByAvatar} alt="avatar" className="w-full h-full object-cover" />
                            </div>
                            <div className="flex flex-col min-w-0 flex-1">
                                <div className="text-[13px] font-bold truncate text-white">{dragInfo.item.SongName}</div>
                                <div className="text-[11px] truncate text-gray-400">{dragInfo.item.ArtistName}</div>
                            </div>
                        </>
                    )}
                </div>
            )}

            <div
                onMouseDown={!isElectron ? handleDragStart : undefined}
                className={`glass-panel-base w-full ${isElectron ? 'flex-1 rounded-[20px] pointer-events-auto' : 'h-full rounded-[20px]'} flex flex-col overflow-hidden relative`}
                style={{
                    backgroundColor: hexToRgba(theme.bgColor, theme.bgOpacity),
                    ...(isElectron ? { WebkitAppRegion: 'drag' } : {})
                } as React.CSSProperties}
            >
                <div className="absolute -top-20 -left-20 w-48 h-48 bg-blue-500 rounded-full mix-blend-screen filter blur-[80px] opacity-20 pointer-events-none"></div>
                <div className="absolute -bottom-20 -right-20 w-48 h-48 bg-purple-500 rounded-full mix-blend-screen filter blur-[80px] opacity-20 pointer-events-none"></div>

                {isElectron && (
                    <div
                        onPointerDown={handleElectronResizeStart}
                        className="no-drag absolute bottom-0 right-0 w-6 h-6 cursor-se-resize z-[60] rounded-br-[20px] opacity-80 hover:opacity-100 transition-opacity pointer-events-auto"
                        style={{ background: 'linear-gradient(135deg, transparent 40%, rgba(255,255,255,0.4) 100%)' }}
                    />
                )}
                {!isElectron && (
                    <div
                        onPointerDown={handleResizeStart}
                        className="no-drag absolute bottom-0 right-0 w-6 h-6 cursor-se-resize z-[60] rounded-br-[20px] opacity-80 hover:opacity-100 transition-opacity pointer-events-auto"
                        style={{ background: 'linear-gradient(135deg, transparent 40%, rgba(255,255,255,0.4) 100%)' }}
                    />
                )}

                {!theme.showTitleBar && isElectron && (
                    <div className="no-drag absolute top-3 right-3 flex gap-2 z-50 drop-shadow-md opacity-0 group-hover:opacity-100 transition-opacity duration-300">
                        <button onMouseDown={e => e.stopPropagation()} onClick={onToggleAdmin} className="text-white/50 hover:text-white transition-colors cursor-pointer text-lg" title="控制面板">⚙️</button>
                        <button onMouseDown={e => e.stopPropagation()} onClick={() => setShowSettings(!showSettings)} className="text-white/50 hover:text-white transition-colors cursor-pointer text-lg" title="外观设置">🎨</button>

                        <button onMouseDown={e => e.stopPropagation()} onClick={handleWindowMinimize} className="flex items-center justify-center w-6 h-6 rounded-full transition-colors text-white/50 hover:text-white hover:bg-white/20 text-md font-bold" title="最小化">—</button>
                        <button onMouseDown={e => e.stopPropagation()} onClick={handleWindowClose} className="flex items-center justify-center w-6 h-6 rounded-full transition-colors text-white/50 hover:text-red-400 hover:bg-red-500/20 text-md" title="关闭点歌机">✖</button>
                    </div>
                )}

                {theme.showTitleBar && (
                    <div className={`px-5 py-3 flex justify-between items-center z-10 transition-colors ${theme.syncTitleBarWithBg ? '' : 'border-b border-white/10'}`} style={{ backgroundColor: theme.syncTitleBarWithBg ? 'transparent' : hexToRgba(theme.titleBarBgColor || '#000000', theme.titleBarOpacity !== undefined ? theme.titleBarOpacity : 0.2) }}>
                        <div className="flex items-center gap-2.5 shrink-0 pr-2">
                            <button
                                onMouseDown={e => { if(isElectron) e.stopPropagation(); }}
                                onClick={togglePlaying}
                                disabled={actionLock}
                                className={`flex items-center justify-center w-5 h-5 rounded-full transition-colors ${isElectron ? 'pointer-events-auto cursor-pointer no-drag' : 'pointer-events-none'} ${playing ? (isElectron ? 'bg-green-500/20 text-green-400 hover:bg-green-500/40' : 'bg-green-500/20 text-green-400') : (isElectron ? 'bg-red-500/20 text-red-400 hover:bg-red-500/40' : 'bg-red-500/20 text-red-400')} ${actionLock ? 'opacity-50 pointer-events-none' : ''}`}
                                title={isElectron ? (playing ? '点击暂停自动播放' : '点击开启自动播放') : undefined}
                            >
                                <span className="text-[10px] leading-none">{playing ? '🟢' : '🔴'}</span>
                            </button>
                            <h1 className="font-bold text-[15px] tracking-wide pointer-events-none whitespace-nowrap shrink-0" style={{ color: theme.titleColor }}>嗷呜点歌机</h1>
                        </div>

                        <div className="no-drag flex items-center relative h-6 flex-1 justify-end min-w-0">
                            <div
                                className={`absolute right-0 text-xs font-medium max-w-[150px] truncate pointer-events-none transition-all duration-300 ${isElectron ? 'group-hover:-translate-x-[115px] group-hover:opacity-50' : ''} ${getStatusAnimation(data.status)}`}
                                style={{ color: !isConnected ? theme.subTextColor : getStatusColor(data.status) }}
                            >
                                {!isConnected ? '等待后端...' : (data.status || '点歌就绪')}
                            </div>

                            {isElectron && (
                                <div className="absolute right-0 flex gap-2 items-center opacity-0 transform translate-x-3 group-hover:translate-x-0 group-hover:opacity-100 transition-all duration-300 z-20">
                                    <button onMouseDown={e => e.stopPropagation()} onClick={onToggleAdmin} className="text-white/60 hover:text-white transition-colors cursor-pointer text-sm" title="控制面板">⚙️</button>
                                    <button onMouseDown={e => e.stopPropagation()} onClick={() => setShowSettings(!showSettings)} className="text-white/60 hover:text-white transition-colors cursor-pointer text-sm" title="外观设置">🎨</button>
                                    <button onMouseDown={e => e.stopPropagation()} onClick={handleWindowMinimize} className="flex items-center justify-center w-5 h-5 rounded-full transition-colors text-white/60 hover:text-white hover:bg-white/20 text-xs font-bold" title="最小化">—</button>
                                    <button onMouseDown={e => e.stopPropagation()} onClick={handleWindowClose} className="flex items-center justify-center w-5 h-5 rounded-full transition-colors text-white/60 hover:text-red-400 hover:bg-red-500/20 text-xs" title="关闭本窗口">✖</button>
                                </div>
                            )}
                        </div>
                    </div>
                )}

                <div className="flex-1 flex flex-col p-4 overflow-hidden z-10 gap-4 custom-scrollbar relative">
                    {data.current ? (
                        <div
                            className={`${isElectron ? 'no-drag cursor-move' : ''} current-zone glass-card rounded-xl p-4 flex items-center gap-4 relative overflow-hidden shrink-0 transition-opacity ${dragInfo?.type === 'current' ? 'opacity-30' : ''} ${actionLock ? 'pointer-events-none' : ''}`}
                            style={{ touchAction: 'none' }}
                            onPointerDown={isElectron && !actionLock ? (e) => handlePointerDown(e, 'current', -1, data.current as SongInfo) : undefined}
                        >
                            <div className="absolute right-[-10px] top-[-10px] opacity-5 text-7xl select-none pointer-events-none">🎵</div>
                            <div className={`w-12 h-12 rounded-full overflow-hidden border-[3px] ${playing ? getGuardStyle(data.current.GuardLevel).border || 'border-green-400/60 shadow-[0_0_15px_rgba(74,222,128,0.2)]' : 'border-yellow-400/60 shadow-[0_0_15px_rgba(250,204,21,0.2)]'} shrink-0 relative pointer-events-none`}>
                                <img src={data.current.OrderedByAvatar} alt="avatar" referrerPolicy="no-referrer" className={`w-full h-full object-cover ${!playing ? 'grayscale opacity-80' : ''}`} onError={(e)=>{(e.target as HTMLImageElement).src=`https://api.dicebear.com/7.x/identicon/svg?seed=${(data.current as SongInfo).OrderedByUid}`}} />
                            </div>
                            <div className="flex flex-col min-w-0 pointer-events-none">
                                {playing ? (
                                    <div className="text-green-400 text-[10px] font-bold mb-1 tracking-wider flex items-center gap-1.5"><span className="w-1.5 h-1.5 bg-green-400 rounded-full animate-pulse"></span> 正在播放</div>
                                ) : (
                                    <div className="text-yellow-400 text-[10px] font-bold mb-1 tracking-wider flex items-center gap-1.5"><span className="w-1.5 h-1.5 bg-yellow-400 rounded-full"></span> 自动播放已暂停</div>
                                )}
                                <div className="text-[15px] font-bold truncate drop-shadow-md" style={{ color: theme.textColor }}>{data.current.SongName}</div>
                                <div className="text-xs truncate mt-0.5" style={{ color: theme.subTextColor }}>{data.current.ArtistName}</div>
                                <div className="text-[11px] mt-1 flex items-center gap-1.5" style={{ color: theme.subTextColor }}>
                                    <span className="truncate">由 <span style={{ color: theme.titleColor, opacity: 0.9 }}>{data.current.OrderedBy}</span> 点播</span>
                                    {getGuardStyle(data.current.GuardLevel).label && <span className={`text-[9px] px-1 rounded-sm font-bold tracking-wider leading-none py-0.5 shadow-sm ${getGuardStyle(data.current.GuardLevel).tag}`}>{getGuardStyle(data.current.GuardLevel).label}</span>}
                                </div>
                            </div>
                        </div>
                    ) : (
                        <div className="current-zone glass-card rounded-xl p-4 flex flex-col items-center justify-center border-dashed border-white/20 shrink-0 min-h-[110px] relative overflow-hidden">
                            {!playing ? (
                                <>
                                    <div className="absolute inset-0 bg-yellow-500/10 animate-[pulse_3s_infinite] pointer-events-none"></div>
                                    <div className="text-4xl mb-2 opacity-90 drop-shadow-[0_0_15px_rgba(250,204,21,0.6)] pointer-events-none z-10 animate-bounce">⏸️</div>
                                    <div className="text-sm font-bold tracking-wide pointer-events-none z-10 text-yellow-400 drop-shadow-md">自动播放已暂停</div>
                                    <div className="text-[10px] mt-1 font-medium pointer-events-none z-10 opacity-70" style={{ color: theme.subTextColor }}>队列歌曲将被保留并跳过</div>
                                </>
                            ) : !isCdpConnected ? (
                                <>
                                    <div className="absolute inset-0 bg-red-500/10 animate-[pulse_3s_infinite] pointer-events-none"></div>
                                    <div className="text-3xl mb-2 opacity-90 drop-shadow-[0_0_15px_rgba(239,68,68,0.6)] pointer-events-none z-10 animate-bounce">🔌</div>
                                    <div className="text-sm font-bold tracking-wide pointer-events-none z-10 text-red-400 drop-shadow-md">播放器未连接</div>
                                    <div className="text-[10px] mt-1 font-medium pointer-events-none z-10 opacity-70" style={{ color: theme.subTextColor }}>请在控制面板检查注入状态</div>
                                </>
                            ) : (
                                <>
                                    <div className="text-3xl mb-2 opacity-60 drop-shadow-lg pointer-events-none">🎧</div>
                                    <div className="text-sm font-medium tracking-wide pointer-events-none" style={{ color: theme.subTextColor }}>当前没有播放任务</div>
                                </>
                            )}
                        </div>
                    )}

                    <div className="queue-zone flex-1 overflow-y-auto custom-scrollbar pr-1 flex flex-col gap-2.5 pb-4">
                        <div className="flex items-center gap-2 mb-0.5 px-1 shrink-0">
                            <button
                                onMouseDown={e => { if(isElectron) e.stopPropagation(); }}
                                onClick={toggleAccepting}
                                disabled={actionLock}
                                className={`flex items-center justify-center w-5 h-5 rounded-full transition-colors ${isElectron ? 'no-drag pointer-events-auto cursor-pointer' : 'pointer-events-none'} ${accepting ? (isElectron ? 'bg-green-500/20 text-green-400 hover:bg-green-500/40' : 'bg-green-500/20 text-green-400') : (isElectron ? 'bg-red-500/20 text-red-400 hover:bg-red-500/40' : 'bg-red-500/20 text-red-400')} ${actionLock ? 'opacity-50 pointer-events-none' : ''}`}
                                title={isElectron ? (accepting ? '点击暂停接单' : '点击开启接单') : undefined}
                            >
                                <span className="text-[10px] leading-none">{accepting ? '🟢' : '🔴'}</span>
                            </button>
                            <div className="text-[10px] font-bold uppercase tracking-widest pointer-events-none" style={{ color: theme.subTextColor }}>
                                待播队列 ({data.queue?.length || 0})
                            </div>
                        </div>

                        {!accepting && (
                            <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-2.5 flex items-center justify-center gap-2 animate-fade-in mb-1 relative overflow-hidden shrink-0 mx-1">
                                <div className="absolute inset-0 bg-gradient-to-r from-transparent via-red-500/10 to-transparent -translate-x-full animate-[shimmer_2s_infinite]"></div>
                                <span className="text-lg relative z-10 animate-pulse">⏸️</span>
                                <span className="text-xs font-bold text-red-400 tracking-wide relative z-10">已暂停接收新点歌</span>
                            </div>
                        )}

                        {rejects.map((rej) => (
                            <div key={rej.id} className="animate-slide-in glass-card rounded-lg p-2 flex items-center gap-3 border border-red-500/30 bg-red-500/10 mb-1 relative overflow-hidden shrink-0">
                                <div className="absolute inset-0 bg-gradient-to-r from-transparent via-red-500/5 to-transparent -translate-x-full animate-[shimmer_2s_infinite]"></div>
                                <div className="w-8 h-8 rounded-full overflow-hidden shrink-0 border border-red-500/50 shadow-[0_0_8px_rgba(239,68,68,0.3)]">
                                    <img src={rej.user.avatar} className="w-full h-full object-cover" />
                                </div>
                                <div className="flex flex-col min-w-0 z-10">
                                    <div className="text-[12px] font-bold text-red-400 truncate drop-shadow-md flex items-center gap-1.5"><span>⚠️</span> <span>{rej.user.name} 点歌失败</span></div>
                                    <div className="text-[10px] text-white/80 truncate mt-0.5">{rej.reason}</div>
                                </div>
                            </div>
                        ))}

                        {(!data.queue || data.queue.length === 0) && (
                            <div className="flex-1 flex flex-col items-center justify-center text-xs italic pointer-events-none" style={{ color: theme.subTextColor }}>
                                <span className="mb-2 text-xl opacity-60">👻</span>
                                发送「点歌 歌名」来点歌吧
                            </div>
                        )}

                        {data.queue?.map((song, index) => {
                            const uniqueKey = `${song.Id}-${song.OrderedByUid}-${index}`;
                            const isNew = newItemsIds.has(`${song.Id}-${song.OrderedByUid}`);
                            const itemGuardStyle = getGuardStyle(song.GuardLevel);

                            return (
                                <div
                                    key={uniqueKey}
                                    style={{ touchAction: 'none' }}
                                    onPointerDown={isElectron && !actionLock ? (e) => handlePointerDown(e, 'queue', index, song) : undefined}
                                    className={`${isElectron ? 'no-drag cursor-move' : ''} queue-item glass-card rounded-lg flex items-center gap-3 transition-all hover:bg-white/10 relative group/item ${isNew ? 'animate-slide-in' : ''} ${dragInfo?.type === 'queue' && dragInfo.index === index ? 'opacity-30' : ''} ${theme.compactQueue ? 'p-1.5' : 'p-2.5'} ${actionLock ? 'pointer-events-none' : ''}`}
                                >
                                    {theme.compactQueue ? (
                                        <div className="flex items-center w-full min-w-0 pointer-events-none pr-14">
                                            <div className="text-[10px] font-bold w-4 text-center shrink-0 mr-1" style={{ color: theme.subTextColor }}>{index + 1}</div>
                                            <div className="text-[12px] font-bold truncate text-white max-w-[55%] shrink-0 pr-1">{song.SongName}</div>
                                            <div className="text-[10px] truncate flex items-center gap-1 opacity-80 min-w-0" style={{ color: theme.subTextColor }}>
                                                <span className="truncate">- {song.OrderedBy}</span>
                                                {itemGuardStyle.label && <span className={`text-[8px] px-1 rounded-sm font-bold tracking-wider leading-none shrink-0 ${itemGuardStyle.tag}`}>{itemGuardStyle.label}</span>}
                                            </div>
                                        </div>
                                    ) : (
                                        <>
                                            <div className="text-[11px] font-bold w-4 text-center shrink-0 pointer-events-none" style={{ color: theme.subTextColor }}>{index + 1}</div>
                                            <div className={`w-8 h-8 rounded-full overflow-hidden shrink-0 bg-black/30 border-2 ${itemGuardStyle.label ? itemGuardStyle.border : 'border-white/10'} pointer-events-none`}>
                                                <img src={song.OrderedByAvatar} alt="avatar" referrerPolicy="no-referrer" className="w-full h-full object-cover" onError={(e)=>{(e.target as HTMLImageElement).src=`https://api.dicebear.com/7.x/identicon/svg?seed=${song.OrderedByUid}`}} />
                                            </div>
                                            <div className="flex flex-col min-w-0 flex-1 pointer-events-none">
                                                <div className="text-[13px] font-bold truncate drop-shadow-sm pr-16" style={{ color: theme.textColor }}>{song.SongName}</div>
                                                <div className="text-[11px] truncate flex items-center gap-1.5 mt-0.5" style={{ color: theme.subTextColor }}>
                                                    <span>{song.ArtistName}</span>
                                                    <span className="w-0.5 h-0.5 bg-white/30 rounded-full"></span>
                                                    <span className="truncate flex items-center gap-1" style={{ color: theme.titleColor, opacity: 0.8 }}>
                                                        {song.OrderedBy}
                                                        {itemGuardStyle.label && <span className={`text-[8px] px-1 py-0.5 rounded-[2px] font-bold tracking-wider leading-none shadow-sm ${itemGuardStyle.tag}`}>{itemGuardStyle.label}</span>}
                                                    </span>
                                                </div>
                                            </div>
                                        </>
                                    )}

                                    {isElectron && (
                                        <div className="absolute right-2 top-1/2 transform -translate-y-1/2 flex items-center gap-1 opacity-0 group-hover/item:opacity-100 transition-opacity bg-black/60 p-1 rounded-md backdrop-blur-md border border-white/10 z-20">
                                            <button onPointerDown={e => { e.stopPropagation(); handleQueueAction('top', { index }); }} className="p-1 hover:bg-white/20 rounded text-xs transition-colors" title="置顶/优先播放">⬆️</button>
                                            <button onPointerDown={e => { e.stopPropagation(); handleQueueAction('play_now', { index }); }} className="p-1 hover:bg-white/20 rounded text-xs transition-colors" title="无视顺序，强行立即切歌播放">▶️</button>
                                            <button onPointerDown={e => { e.stopPropagation(); handleQueueAction('delete', { index }); }} className="p-1 hover:bg-red-500/40 rounded text-xs transition-colors text-red-400" title="移出点歌队列">🗑️</button>
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                </div>

                {/* 界面设置抽屉 */}
                {isElectron && showSettings && (
                    <div
                        onMouseDown={e => e.stopPropagation()}
                        className="no-drag absolute top-0 right-0 bottom-0 w-[220px] bg-black/85 backdrop-blur-xl z-[70] border-l border-white/10 p-4 flex flex-col gap-4 animate-slide-in-right shadow-2xl custom-scrollbar overflow-y-auto"
                        style={{ transform: 'translateZ(0)', backfaceVisibility: 'hidden' }}
                    >
                        <div className="flex justify-between items-center border-b border-white/10 pb-2">
                            <h2 className="font-bold text-sm text-white">🎨 外观设置</h2>
                            <button onClick={() => setShowSettings(false)} className="text-white/50 hover:text-white text-lg leading-none cursor-pointer">×</button>
                        </div>

                        <div className="flex flex-col gap-3 pb-3 border-b border-white/10">
                            <div className="flex justify-between items-center">
                                <label className="text-[11px] text-white/70 font-medium">极简待播队列 (Mini模式)</label>
                                <button onClick={() => setTheme({...theme, compactQueue: !theme.compactQueue})} className={`w-7 h-4 rounded-full p-0.5 transition-colors ${theme.compactQueue ? 'bg-blue-500' : 'bg-white/20'}`}><div className={`w-3 h-3 rounded-full bg-white transition-transform ${theme.compactQueue ? 'translate-x-3' : 'translate-x-0'}`}></div></button>
                            </div>
                            <div className="flex justify-between items-center">
                                <label className="text-[11px] text-white/70 font-medium">显示标题栏</label>
                                <button onClick={() => setTheme({...theme, showTitleBar: !theme.showTitleBar})} className={`w-7 h-4 rounded-full p-0.5 transition-colors ${theme.showTitleBar ? 'bg-blue-500' : 'bg-white/20'}`}><div className={`w-3 h-3 rounded-full bg-white transition-transform ${theme.showTitleBar ? 'translate-x-3' : 'translate-x-0'}`}></div></button>
                            </div>
                            {theme.showTitleBar && (
                                <>
                                    <div className="flex justify-between items-center">
                                        <label className="text-[11px] text-white/70 font-medium">标题栏融入背景</label>
                                        <button onClick={() => setTheme({...theme, syncTitleBarWithBg: !theme.syncTitleBarWithBg})} className={`w-7 h-4 rounded-full p-0.5 transition-colors ${theme.syncTitleBarWithBg ? 'bg-blue-500' : 'bg-white/20'}`}><div className={`w-3 h-3 rounded-full bg-white transition-transform ${theme.syncTitleBarWithBg ? 'translate-x-3' : 'translate-x-0'}`}></div></button>
                                    </div>
                                    {!theme.syncTitleBarWithBg && (
                                        <div className="flex justify-between items-center">
                                            <label className="text-[11px] text-white/70 font-medium">背景色</label>
                                            <input type="color" value={theme.titleBarBgColor} onChange={e => setTheme({...theme, titleBarBgColor: e.target.value})} className="w-5 h-5 rounded cursor-pointer shrink-0" />
                                        </div>
                                    )}
                                </>
                            )}
                        </div>

                        <div className="flex flex-col gap-2.5 pb-3 border-b border-white/10">
                            <div className="flex justify-between items-center"><label className="text-[11px] text-white/70 font-medium">标题/高亮字</label><input type="color" value={theme.titleColor} onChange={e => setTheme({...theme, titleColor: e.target.value})} className="w-5 h-5 rounded cursor-pointer shrink-0" /></div>
                            <div className="flex justify-between items-center"><label className="text-[11px] text-white/70 font-medium">主体文字</label><input type="color" value={theme.textColor} onChange={e => setTheme({...theme, textColor: e.target.value})} className="w-5 h-5 rounded cursor-pointer shrink-0" /></div>
                            <div className="flex justify-between items-center"><label className="text-[11px] text-white/70 font-medium">次要文字</label><input type="color" value={theme.subTextColor} onChange={e => setTheme({...theme, subTextColor: e.target.value})} className="w-5 h-5 rounded cursor-pointer shrink-0" /></div>
                        </div>

                        <div className="flex flex-col gap-2.5">
                            <div className="flex justify-between items-center"><label className="text-[11px] text-white/70 font-medium">全局背景色</label><input type="color" value={theme.bgColor} onChange={e => setTheme({...theme, bgColor: e.target.value})} className="w-5 h-5 rounded cursor-pointer shrink-0" /></div>
                            <div className="flex flex-col gap-1.5 mb-2">
                                <label className="text-[11px] text-white/70 font-medium flex justify-between"><span>不透明度</span><span className="text-white/90">{Math.round(theme.bgOpacity * 100)}%</span></label>
                                <input type="range" min="0" max="1" step="0.05" value={theme.bgOpacity} onChange={e => setTheme({...theme, bgOpacity: parseFloat(e.target.value)})} className="w-full h-1 bg-white/20 rounded-lg appearance-none cursor-pointer accent-white" />
                            </div>
                        </div>

                        <div className="mt-auto flex flex-col gap-2">
                            <button className="py-2 w-full bg-white/10 hover:bg-white/20 rounded-lg text-white text-[11px] font-medium transition-colors" onClick={() => setTheme(defaultTheme)}>恢复默认外观</button>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
};

// ==========================================
// 4. 核心组件: 后台管理控制面板
// ==========================================

interface AdminWidgetProps {
    onClose: () => void;
}

interface LyricsTextProps {
    readonly text: string;
    readonly className: string;
    readonly style: React.CSSProperties;
    readonly color: string;
    readonly textShadow: string | undefined;
    readonly outlineEnabled: boolean;
    readonly outlineColor: string;
    readonly outlineSize: number;
}

const LyricsText: React.FC<LyricsTextProps> = ({
    text,
    className,
    style,
    color,
    textShadow,
    outlineEnabled,
    outlineColor,
    outlineSize
}) => {
    const strokeStyle: React.CSSProperties = {
        color: 'transparent',
        WebkitTextFillColor: 'transparent',
        WebkitTextStroke: `${outlineSize}px ${outlineColor}`
    };

    return (
        <div className={className} style={{ ...style, position: 'relative' }}>
            {outlineEnabled && outlineSize > 0 && (
                <span aria-hidden="true" className="absolute inset-0 block pointer-events-none select-none" style={strokeStyle}>
                    {text}
                </span>
            )}
            <span className="relative block" style={{ color, textShadow }}>
                {text}
            </span>
        </div>
    );
};

const AdminWidget: React.FC<AdminWidgetProps> = ({ onClose: _onClose }) => {
    const [config, setConfig] = useState<any>(null);
    const [systemFonts, setSystemFonts] = useState<readonly string[]>([]);
    const [activeTab, setActiveTab] = useState<string>('settings');

    const [updateInfo, setUpdateInfo] = useState<UpdateInfo>({ checking: false, info: null });
    const [downloadProgress, setDownloadProgress] = useState<number | null>(null);

    const [qrState, setQrState] = useState<QrState>({ loading: false, base64: '', message: '' });
    const [roomIdInput, setRoomIdInput] = useState<string>('');
    const [sysLogs, setSysLogs] = useState<SysLog[]>([]);
    const logsEndRef = useRef<HTMLDivElement>(null);

    // ⭐ 新增: 自动滚动日志锁定与日志容器引用
    const [autoScroll, setAutoScroll] = useState<boolean>(true);
    const logContainerRef = useRef<HTMLDivElement>(null);

    // ⭐ 新增: 智能诊断警告触发状态
    const [hasWindowsAppsIssue, setHasWindowsAppsIssue] = useState<boolean>(false);
    const [hasBiliLoopIssue, setHasBiliLoopIssue] = useState<boolean>(false);

    const [superUserInput, setSuperUserInput] = useState<string>('');
    const [debugInput, setDebugInput] = useState<string>('');

    const [adminToast, setAdminToast] = useState<string>('');

    // ⭐ 防抖重连定时器引用
    const restartTimerRef = useRef<NodeJS.Timeout | null>(null);

    const showAdminToast = (msg: string) => {
        setAdminToast(msg);
        setTimeout(() => setAdminToast(''), 3000);
    };

    const activeTabRef = useRef<string>(activeTab);
    useEffect(() => { activeTabRef.current = activeTab; }, [activeTab]);

    const isInitialConfigLoad = useRef(true);
    const lastConfigString = useRef('');

    // ⭐ 组件卸载时清理定时器，防止内存泄漏
    useEffect(() => {
        return () => {
            if (restartTimerRef.current) {
                clearTimeout(restartTimerRef.current);
            }
        };
    }, []);

    useEffect(() => {
        const fetchConfig = async () => {
            try {
                const res = await fetch('http://localhost:5555/api/config');
                const json = await res.json();

                setConfig((prev: any) => {
                    if (!prev) return json;
                    return {
                        ...json,
                        config: activeTabRef.current === 'settings' ? prev.config : json.config
                    };
                });

                setRoomIdInput(prev => {
                    if (prev === '' && json.roomId !== 0 && json.roomId !== json.uid) return json.roomId.toString();
                    return prev;
                });

                setActiveTab(prev => {
                    if (!json.biliLogin && prev !== 'login') return 'login';
                    return prev;
                });

            } catch { }
        };
        fetchConfig();
        const timer = setInterval(fetchConfig, 2000);
        return () => clearInterval(timer);
    }, []);

    useEffect(() => {
        let disposed = false;
        const fetchFonts = async () => {
            try {
                const res = await fetch('http://localhost:5555/api/system/fonts');
                const body: unknown = await res.json();
                if (!disposed) setSystemFonts(readSystemFontsResponse(body).fonts);
            } catch {
                if (!disposed) setSystemFonts([]);
            }
        };
        fetchFonts();
        return () => {
            disposed = true;
        };
    }, []);

    useEffect(() => {
        if (!config || !config.config) return;

        const currentStr = JSON.stringify(config.config);

        if (isInitialConfigLoad.current) {
            isInitialConfigLoad.current = false;
            lastConfigString.current = currentStr;
            return;
        }

        if (currentStr === lastConfigString.current) return;

        const timer = setTimeout(() => {
            lastConfigString.current = currentStr;
            fetch('http://localhost:5555/api/config', {
                method: 'POST',
                headers: {'Content-Type':'application/json'},
                body: JSON.stringify({ sysConfig: config.config })
            }).then(res => {
                if (res.ok) showAdminToast("✅ 基础设置已自动保存！");
            }).catch(() => {});
        }, 800);

        return () => clearTimeout(timer);
    }, [config?.config]);

    useEffect(() => {
        if (activeTab !== 'login') return;
        const fetchQr = async () => {
            try {
                const res = await fetch('http://localhost:5555/api/bili/qrstatus');
                const json = await res.json();
                setQrState({ loading: false, base64: json.qrBase64, message: json.status });
            } catch {}
        };
        fetchQr();
        const timer = setInterval(fetchQr, 2000);
        return () => clearInterval(timer);
    }, [activeTab]);

    // ⭐ 改动：不管处于哪个 Tab 都会在后台静默轮询日志进行环境检测（如果是 logs tab 轮询频率调至 1秒，其他 tab 为 2.5秒）
    useEffect(() => {
        const fetchLogs = async () => {
            try {
                const res = await fetch('http://localhost:5555/api/logs');
                const json = await res.json();
                setSysLogs(json);
            } catch {}
        };
        fetchLogs();
        const intervalTime = activeTab === 'logs' ? 1000 : 2500;
        const timer = setInterval(fetchLogs, intervalTime);
        return () => clearInterval(timer);
    }, [activeTab]);

    // ⭐ 新增: 实时自动化诊断错误关键字分析
    useEffect(() => {
        if (sysLogs.length === 0) return;

        // 1. 诊断 WindowsApps / spawn EPERM 权限受阻
        const winAppsError = sysLogs.some(log =>
            log.Message.includes('spawn EPERM') ||
            log.Message.includes('WindowsApps') ||
            log.Message.includes('权限不足')
        );
        setHasWindowsAppsIssue(winAppsError);

        // 2. 诊断 B站 直播间 WebSocket 连接断线环路 (重复产生连接事件)
        const connectEvents = sysLogs.filter(log =>
            log.Message.includes('直播间已连接') ||
            log.Message.includes('弹幕监控启动')
        );
        // 如果日志中多次出现该日志，且相互间隔排布，说明正在遭遇频繁断线重连问题
        setHasBiliLoopIssue(connectEvents.length >= 2);

    }, [sysLogs]);

    // ⭐ 新增: 处理日志自适应滚动和手动阅读判定
    const handleLogScroll = () => {
        const el = logContainerRef.current;
        if (!el) return;

        // 判定用户是否已经滚动到最下方 (误差距离 45px)
        const isAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 45;

        if (isAtBottom && !autoScroll) {
            setAutoScroll(true); // 恢复自动滚动
        } else if (!isAtBottom && autoScroll) {
            setAutoScroll(false); // 锁定滚动，支持用户自由阅读
        }
    };

    // ⭐ 改动: 仅当 autoScroll 为开启状态时执行平滑置底滚动
    useEffect(() => {
        if (activeTab === 'logs' && autoScroll && logContainerRef.current) {
            logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
        }
    }, [sysLogs, activeTab, autoScroll]);

    const handleConnectRoom = async () => {
        const rid = parseInt(roomIdInput);
        if (!rid) return showAdminToast("❌ 请输入正确的房间号");
        try {
            const res = await fetch('http://localhost:5555/api/room', {
                method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ roomId: rid })
            });
            const json = await res.json();
            if(json.success) showAdminToast("✅ 连接请求成功！请查看运行日志确认。");
            else showAdminToast("❌ 连接失败，请检查网络或确认扫码登录是否有效。");
        } catch { showAdminToast("❌ 请求后端失败"); }
    };

    const handleRestartNCM = async () => {
        try {
            const res = await fetch('http://localhost:5555/api/sys/restart_ncm', { method: 'POST' });
            if(res.ok) showAdminToast("✅ 操作指令已发送，请查看运行日志！");
        } catch { showAdminToast("❌ 发送指令失败"); }
    };

    const handleUpdateCheck = async () => {
        setUpdateInfo({ checking: true, info: null });
        try {
            const res = await fetch('http://localhost:5555/api/update/check');
            const json = await res.json();
            setUpdateInfo({ checking: false, info: json });

            if (!json.hasUpdate && !json.error) {
                showAdminToast("✅ 当前已经是最新版本，无需更新！");
            } else if (json.error) {
                showAdminToast(`❌ 检查失败: ${json.error}`);
            }
        } catch {
            setUpdateInfo({ checking: false, info: { error: '检查失败，请重试' } });
            showAdminToast("❌ 网络请求失败，请检查网络！");
        }
    };

    const handleApplyUpdate = async () => {
        if(!confirm("确定要开始更新吗？程序将会自动下载并重启。")) return;
        setDownloadProgress(0);

        try {
            await fetch('http://localhost:5555/api/update/apply', { method: 'POST' });
            showAdminToast("正在后台下载更新，请稍候，程序将自动重启...");

            // 模拟进度条，真实后台正在走 Updater 更新流
            const timer = setInterval(() => {
                setDownloadProgress(prev => {
                    if (prev === null) {
                        clearInterval(timer);
                        return null;
                    }
                    const next = prev + (Math.random() * 8 + 2);
                    return next > 95 ? 95 : next; // 卡在 95% 直到后端完成并自动重启
                });
            }, 1000);
        } catch {
            setDownloadProgress(null);
            showAdminToast("❌ 更新请求失败，请检查网络连接");
        }
    };

    const startQrLogin = async () => {
        setQrState(prev => ({ ...prev, loading: true, base64: '' }));
        await fetch('http://localhost:5555/api/bili/qrstart', { method: 'POST' });
    };

    const toggleAccepting = async () => {
        try {
            await fetch('http://localhost:5555/api/state/toggle', { method: 'POST' });
            setConfig((prev: any) => ({...prev, accepting: !prev.accepting}));
        } catch(err) { console.error(err); }
    };

    const togglePlaying = async () => {
        try {
            await fetch('http://localhost:5555/api/state/toggle_play', { method: 'POST' });
            setConfig((prev: any) => ({...prev, playing: !prev.playing}));
        } catch(err) { console.error(err); }
    };

    const handleDebugInsert = async () => {
        if(!debugInput.trim()) return showAdminToast("❌ 请输入需要搜索并插入的歌曲名！");
        try {
            const res = await fetch('http://localhost:5555/api/debug/insert_next', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ keyword: debugInput })
            });
            const json = await res.json();
            if(json.success) {
                showAdminToast("✅ 搜索并插入成功！请前往播放列表查看。");
            } else {
                showAdminToast("❌ 操作失败。可能是没搜到歌曲，请查看运行日志。");
            }
        } catch(err: any) { showAdminToast("❌ 请求后端失败：" + err.message); }
    };

    // ⭐ 增加了错误状态识别 and Toast 拦截提示
    const handleDebugPlayNext = async () => {
        try {
            const res = await fetch('http://localhost:5555/api/debug/play_next', { method: 'POST' });
            const json = await res.json();
            if(json.success) showAdminToast("✅ 切歌指令已成功发送！");
            else showAdminToast("❌ 切歌失败，播放器拒绝响应或未连接！");
        } catch(err: any) { showAdminToast("❌ 请求后端失败：" + err.message); }
    };

    const updatePermission = (permKey: string, field: string, value: any) => {
        setConfig((prev: any) => ({
            ...prev,
            config: {
                ...prev.config,
                [permKey]: {
                    ...(prev.config[permKey] || { AllowManager: true, MinGuardType: (permKey === 'ForceControlPermission' ? -1 : 0), MinMedalLevel: 0 }),
                    [field]: value
                }
            }
        }));
    };

    const updateCooldown = (tier: string, value: string) => {
        const val = parseInt(value) || 0;
        setConfig((prev: any) => ({
            ...prev,
            config: {
                ...prev.config,
                Cooldowns: {
                    ...(prev.config.Cooldowns || { Normal: 0, Captain: 0, Admiral: 0, Governor: 0 }),
                    [tier]: val
                }
            }
        }));
    };

    const lyricsWidgetSettings = config?.config ? readLyricsWidgetSettings(config.config.LyricsWidget) : defaultLyricsWidgetSettings;
    const fontOptions = [
        ...(systemFonts.includes(lyricsWidgetSettings.FontFamily) ? [] : [lyricsWidgetSettings.FontFamily]),
        ...systemFonts
    ];
    const updateLyricsWidgetSetting = <K extends keyof LyricsWidgetSettings>(key: K, value: LyricsWidgetSettings[K]) => {
        setConfig((prev: AdminConfigState | null) => {
            if (!prev?.config) return prev;
            const current = readLyricsWidgetSettings(prev.config.LyricsWidget);
            return {
                ...prev,
                config: {
                    ...prev.config,
                    LyricsWidget: {
                        ...current,
                        [key]: value
                    }
                }
            };
        });
    };

    const renderLyricsToggle = (key: LyricsToggleSettingKey, label: string) => {
        const enabled = lyricsWidgetSettings[key];
        return (
            <button
                key={key}
                onClick={() => updateLyricsWidgetSetting(key, !enabled)}
                className={`flex items-center justify-between rounded-lg border px-3 py-2.5 text-sm transition-colors ${enabled ? 'bg-cyan-500/15 border-cyan-400/40 text-cyan-100' : 'bg-black/30 border-white/10 text-gray-400'}`}
            >
                <span>{label}</span>
                <span className={`h-5 w-9 rounded-full p-0.5 transition-colors ${enabled ? 'bg-cyan-500' : 'bg-gray-600'}`}>
                    <span className={`block h-4 w-4 rounded-full bg-white transition-transform ${enabled ? 'translate-x-4' : 'translate-x-0'}`}></span>
                </span>
            </button>
        );
    };

    const renderLyricsColorInput = (key: LyricsColorSettingKey, label: string) => (
        <label key={key} className="flex items-center gap-3 bg-black/30 border border-white/10 rounded-lg p-2.5">
            <input
                type="color"
                value={lyricsWidgetSettings[key]}
                onChange={e => updateLyricsWidgetSetting(key, readColor(e.target.value, lyricsWidgetSettings[key]))}
                className="h-8 w-10 rounded bg-transparent cursor-pointer"
            />
            <span className="text-sm text-gray-300">{label}</span>
        </label>
    );

    const addSuperUser = () => {
        if(!superUserInput.trim()) return;
        const currentSu = config.config.SuperUsers || [];
        if(currentSu.includes(superUserInput.trim())) { setSuperUserInput(''); return; }
        setConfig((prev: any) => ({...prev, config: {...prev.config, SuperUsers: [...currentSu, superUserInput.trim()]}}));
        setSuperUserInput('');
    };

    const removeSuperUser = (name: string) => {
        const currentSu: string[] = config.config.SuperUsers || [];
        setConfig((prev: any) => ({...prev, config: {...prev.config, SuperUsers: currentSu.filter(n => n !== name)}}));
    };

    const handleSetPlayerType = (type: string) => {
        setConfig((prev: any) => ({
            ...prev,
            config: { ...prev.config, PlayerType: type }
        }));

        // ⭐ 如果 1.2 秒内用户又切了播放器，清除之前的定时器
        if (restartTimerRef.current) {
            clearTimeout(restartTimerRef.current);
        }

        showAdminToast("已切换播放器，等待自动保存后将自动重连...");

        // ⭐ 设置 1.2 秒定时器 (确保 800ms 的自动保存完成后触发重连)
        restartTimerRef.current = setTimeout(() => {
            handleRestartNCM();
        }, 1200);
    };

    const permTypes = [
        { key: 'OrderPermission', label: '点歌权限' },
        { key: 'SkipPermission', label: '切歌权限' },
        { key: 'PriorityPermission', label: '置顶权限 (放到队列第一首)' },
        { key: 'CancelPermission', label: '撤回权限 (撤回自己点的最近一首)' },
        { key: 'ToggleAcceptPermission', label: '开关接单权限 (开启/关闭)' },
        { key: 'ForceControlPermission', label: '强控队列权限 (立即/插队/撤回他人)' },
    ];

    return (
        <div className="admin-widget-root animate-fade-in text-gray-200 flex flex-col font-sans select-none w-full h-screen overflow-hidden" style={{ backgroundColor: '#0d1117' }}>

            {adminToast && (
                <div className="fixed top-8 left-1/2 transform -translate-x-1/2 z-[99999] bg-blue-600 text-white px-6 py-3 rounded-full shadow-2xl font-bold animate-slide-in flex items-center gap-2">
                    {adminToast}
                </div>
            )}

            <div className="px-4 py-2 border-b border-white/10 flex justify-between items-center bg-white/5" style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}>
                <div className="font-bold text-white text-sm flex items-center gap-2">⚙️ 控制面板</div>
            </div>

            <div className="flex-1 flex overflow-hidden relative">
                <div className="w-36 border-r border-white/5 bg-white/[0.02] flex flex-col p-2 gap-1 overflow-y-auto custom-scrollbar shrink-0 z-10">
                    {[
                        { id: 'status', icon: '🏠', label: '运行状态' },
                        { id: 'settings', icon: '⚙️', label: '基础设置' },
                        { id: 'logs', icon: '📝', label: '运行日志' },
                        { id: 'faq', icon: '❓', label: '常见问题' },
                        { id: 'login', icon: '📱', label: '扫码登录' },
                        { id: 'update', icon: '🚀', label: '版本升级' },
                        { id: 'debug', icon: '🐞', label: '调试测试' }
                    ].map(t => (
                        <button key={t.id} onClick={() => setActiveTab(t.id)} className={`flex items-center gap-2.5 p-2.5 rounded-lg text-sm transition-colors text-left ${activeTab === t.id ? 'bg-blue-600 text-white font-bold' : 'hover:bg-white/10 text-gray-400'}`}>
                            <span>{t.icon}</span> <span className="truncate">{t.label}</span>
                        </button>
                    ))}
                </div>

                <div className="flex-1 p-6 overflow-y-auto custom-scrollbar select-text relative">
                    {!config ? (
                        <div className="h-full flex items-center justify-center text-white/50">正在连接后端服务...</div>
                    ) : (
                        <div className="max-w-3xl mx-auto">

                            {/* ⭐ 新增: 全局联动智能异常自诊断提示栏 (在所有Tab的最上方持续警醒显示) */}
                            {(hasWindowsAppsIssue || hasBiliLoopIssue) && (
                                <div className="mb-6 space-y-3 animate-fadeIn">
                                    {hasWindowsAppsIssue && (
                                        <div className="bg-red-500/15 border border-red-500/30 p-4 rounded-xl flex items-start gap-3 text-red-200 shadow-lg">
                                            <span className="text-xl shrink-0 mt-0.5">⚠️</span>
                                            <div className="text-xs space-y-1 flex-1">
                                                <div className="font-bold text-red-400 text-sm">检测到网易云音乐启动受阻 (spawn EPERM)</div>
                                                <p className="leading-relaxed text-gray-300">
                                                    当前点歌机自动锁定并运行的路径带有 <code className="text-red-300 bg-red-950 px-1 py-0.5 rounded font-mono">WindowsApps</code>。
                                                    说明您之前安装并使用的是 **Windows 应用商店版网易云**，该版本运行于独立受保沙盒中，系统强行阻止一切第三方点歌机直接将其调起控制。
                                                </p>
                                                <div className="pt-2 flex flex-col sm:flex-row gap-2">
                                                    <span className="font-bold text-white bg-red-500/30 px-2 py-0.5 rounded shrink-0 self-start">核心解决方案</span>
                                                    <span className="text-gray-200">
                                                        请前往系统控制面板中<strong>彻底卸载微软商店版网易云</strong>，然后必须前往 <a href="https://music.163.com/" target="_blank" rel="noreferrer" className="text-blue-400 underline font-bold hover:text-blue-300">网易云音乐官方网站</a> 重新下载 Win32 传统安装包。安装完成后，删除或清理点歌机的旧路径缓存后再启动。
                                                    </span>
                                                </div>
                                            </div>
                                        </div>
                                    )}

                                    {hasBiliLoopIssue && (
                                        <div className="bg-amber-500/15 border border-amber-500/30 p-4 rounded-xl flex items-start gap-3 text-amber-200 shadow-lg">
                                            <span className="text-xl shrink-0 mt-0.5">🌐</span>
                                            <div className="text-xs space-y-1.5 flex-1">
                                                <div className="font-bold text-amber-400 text-sm">检测到 B站弹幕监控连接不断断线重连</div>
                                                <p className="leading-relaxed text-gray-300">
                                                    诊断发现日志中正在密集、频繁地重复刷新“<span className="text-amber-300">直播间已连接，弹幕监控启动！</span>”。这代表弹幕服务器连接在建立成功后瞬间遭遇断裂阻碍。
                                                </p>
                                                <div className="pt-1 flex flex-col gap-1 text-gray-200 bg-black/20 p-2.5 rounded-lg border border-white/5">
                                                    <div className="font-bold text-white flex items-center gap-1">🛠️ 请依序排查以下3项：</div>
                                                    <ul className="list-decimal pl-4 space-y-1 text-gray-300 mt-1">
                                                        <li>
                                                            <strong className="text-white">关闭全局 VPN/代理网络：</strong>
                                                            如果您使用了纯美国或其他海外节点的全局梯子，B站会出于风控安全直接拒绝/掐断来自这些回环 IP 的直播 Websocket 连接。请尝试**关掉代理**，或切回**国内节点**，或在梯子中设置**绕过本地主机 / PAC分流模式**。
                                                        </li>
                                                        <li>
                                                            <strong className="text-white">重新登录：</strong>
                                                            有些时候 B站 连接握手鉴权信息超时失效也会导致不断被断线重连。请前往 <button className="text-cyan-400 font-bold underline hover:text-cyan-300 focus:outline-none" onClick={() => setActiveTab('login')}>扫码登录</button> 页，重新绑定登录任意一个普通的 B站 账号获取全新的连接状态。
                                                        </li>
                                                        <li>
                                                            <strong className="text-white">核对房间号：</strong>
                                                            请务必输入正确的**直播间数字房间号**，而绝非主播的个人 UID。
                                                        </li>
                                                    </ul>
                                                </div>
                                            </div>
                                        </div>
                                    )}
                                </div>
                            )}

                            {activeTab === 'status' && (
                                <div className="space-y-6 animate-slide-in-right flex flex-col h-full">
                                    <div>
                                        <h2 className="text-2xl font-bold text-white mb-6">运行状态</h2>

                                        <div className="bg-white/5 p-5 rounded-xl border border-white/10 flex justify-between items-center mb-5 shadow-inner">
                                            <div>
                                                <div className="text-sm text-gray-400 mb-1">OBS 捕捉地址 / 局域网访问</div>
                                                <div className="text-lg font-mono text-cyan-400 select-all">http://localhost:5555/</div>
                                            </div>
                                            <button onClick={() => { navigator.clipboard.writeText("http://localhost:5555/"); showAdminToast("✅ 链接复制成功！"); }} className="px-5 py-2.5 bg-blue-600/20 text-blue-400 hover:bg-blue-600/40 rounded-lg text-sm font-bold transition-colors border border-blue-500/30 flex items-center gap-2">
                                                📋 复制链接
                                            </button>
                                        </div>

                                        <div className="bg-white/5 p-5 rounded-xl border border-white/10 shadow-inner mb-5">
                                            <div className="text-sm text-gray-400 mb-3 flex justify-between">
                                                <span>当前监控直播间</span>
                                                <span className="text-blue-400 text-xs">发弹幕 "test" 或 "测试" 验证连接</span>
                                            </div>
                                            <div className="flex gap-3">
                                                <input
                                                    type="text"
                                                    value={roomIdInput}
                                                    onChange={e => setRoomIdInput(e.target.value)}
                                                    className="flex-1 bg-black/30 border border-white/10 rounded-lg p-3 text-md text-white focus:border-blue-500 outline-none"
                                                    placeholder="输入直播间的真实房间ID (非UID)..."
                                                />
                                                <button onClick={handleConnectRoom} className="px-6 py-3 bg-blue-600 hover:bg-blue-500 text-white text-md rounded-lg font-bold shadow-lg transition-colors">连接 / 切换</button>
                                            </div>
                                        </div>

                                        <div className="grid grid-cols-2 gap-5">
                                            <div className="bg-white/5 p-5 rounded-xl border border-white/10 flex justify-between items-center">
                                                <div>
                                                    <div className="text-sm text-gray-400 mb-2">点歌功能状态</div>
                                                    <div className="text-2xl font-bold flex items-center gap-3 mt-1">
                                                        {config.accepting ? <><span className="w-3 h-3 rounded-full bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.8)]"></span> <span className="text-green-400">接收中</span></> : <><span className="w-3 h-3 rounded-full bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.8)]"></span> <span className="text-red-400">已暂停</span></>}
                                                    </div>
                                                </div>
                                                <button onClick={toggleAccepting} className={`px-5 py-2.5 rounded-lg text-sm font-bold shadow-lg transition-colors border ${config.accepting ? 'bg-red-600/20 text-red-500 border-red-500/30 hover:bg-red-600/40' : 'bg-green-600/20 text-green-500 border-green-500/30 hover:bg-green-600/40'}`}>
                                                    {config.accepting ? '停单' : '接单'}
                                                </button>
                                            </div>

                                            <div className="bg-white/5 p-5 rounded-xl border border-white/10 flex justify-between items-center">
                                                <div>
                                                    <div className="text-sm text-gray-400 mb-2">自动播放状态</div>
                                                    <div className="text-2xl font-bold flex items-center gap-3 mt-1">
                                                        {config.playing ? <><span className="w-3 h-3 rounded-full bg-blue-500 shadow-[0_0_8px_rgba(59,130,246,0.8)]"></span> <span className="text-blue-400">播放中</span></> : <><span className="w-3 h-3 rounded-full bg-gray-500 shadow-[0_0_8px_rgba(107,114,128,0.8)]"></span> <span className="text-gray-400">已暂停</span></>}
                                                    </div>
                                                </div>
                                                <button onClick={togglePlaying} className={`px-5 py-2.5 rounded-lg text-sm font-bold shadow-lg transition-colors border ${config.playing ? 'bg-gray-600/40 text-gray-400 border-gray-500/30 hover:bg-gray-600/60' : 'bg-blue-600/20 text-blue-500 border-blue-500/30 hover:bg-blue-600/40'}`}>
                                                    {config.playing ? '暂停' : '恢复'}
                                                </button>
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            )}

                            {activeTab === 'logs' && (
                                <div className="space-y-4 animate-slide-in-right flex flex-col h-[70vh]">
                                    <div className="flex justify-between items-center pr-2">
                                        <h2 className="text-2xl font-bold text-white mb-2">后端实时日志 (Log)</h2>
                                        {/* ⭐ 新增: 精致的滚动模式控制开关，让用户在阅读日志时可手动锁定 */}
                                        <div className="flex items-center gap-3 bg-black/40 px-3 py-1.5 rounded-lg border border-white/5">
                                            <label className="text-xs text-gray-400 flex items-center gap-1.5 cursor-pointer select-none">
                                                <input
                                                    type="checkbox"
                                                    checked={autoScroll}
                                                    onChange={e => {
                                                        setAutoScroll(e.target.checked);
                                                        if (e.target.checked && logContainerRef.current) {
                                                            logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
                                                        }
                                                    }}
                                                    className="w-3.5 h-3.5 rounded border-white/20 bg-black/50 text-blue-500 focus:ring-0 cursor-pointer"
                                                />
                                                <span>自动滚动</span>
                                            </label>
                                            <div className="w-[1px] h-3 bg-white/10"></div>
                                            <button
                                                onClick={() => {
                                                    setAutoScroll(true);
                                                    if (logContainerRef.current) {
                                                        logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
                                                    }
                                                }}
                                                className="text-xs text-blue-400 hover:text-blue-300 font-medium transition-colors"
                                            >
                                                ⬇️ 滚到底部
                                            </button>
                                        </div>
                                    </div>

                                    {/* ⭐ 改动: 日志容器加入 ref 监听和 scroll 回调事件，检测用户向上翻页操作并智能关闭 autoScroll */}
                                    <div className="flex-1 relative min-h-0">
                                        <div
                                            ref={logContainerRef}
                                            onScroll={handleLogScroll}
                                            className="w-full h-full bg-[#090b0f] rounded-xl border border-white/10 p-4 font-mono text-[13px] overflow-y-auto custom-scrollbar flex flex-col gap-2 shadow-inner"
                                        >
                                            {sysLogs.length === 0 ? (
                                                <div className="text-gray-500 text-center mt-10">暂无日志...</div>
                                            ) : (
                                                sysLogs.map((log, i) => (
                                                    <div key={i} className="flex gap-4 leading-relaxed">
                                                        <span className="text-gray-600 shrink-0">[{log.Time}]</span>
                                                        <span style={{color: mapConsoleColor(log.Color)}} className="break-all whitespace-pre-wrap">{log.Message}</span>
                                                    </div>
                                                ))
                                            )}
                                            <div ref={logsEndRef} className="h-[2px]" />
                                        </div>

                                        {/* ⭐ 新增: 当 autoScroll 在用户查阅日志时被锁定，显示极为好看和友好的动态按钮，一键恢复置底滚动 */}
                                        {!autoScroll && (
                                            <button
                                                onClick={() => {
                                                    setAutoScroll(true);
                                                    if (logContainerRef.current) {
                                                        logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
                                                    }
                                                }}
                                                className="absolute bottom-4 right-4 bg-blue-600 hover:bg-blue-500 text-white px-3 py-2 rounded-full shadow-lg text-xs font-bold transition-all flex items-center gap-1.5 animate-bounce select-none border border-blue-400/30"
                                            >
                                                <span>⬇️</span> 自动滚动已暂停 (点击恢复)
                                            </button>
                                        )}
                                    </div>
                                </div>
                            )}

                            {/* ⭐ 新增: 常见问题异常排查 FAQ 界面 */}
                            {activeTab === 'faq' && (
                                <div className="space-y-6 animate-slide-in-right pb-10">
                                    <h2 className="text-2xl font-bold text-white mb-6">❓ 常见问题与自助诊断</h2>

                                    {/* FAQ CARD 1: 网易云无法控制 */}
                                    <div className="bg-white/5 p-6 rounded-xl border border-white/10 space-y-4 shadow-inner">
                                        <h3 className="text-md font-bold text-red-400 flex items-center gap-2 pb-2 border-b border-white/5">
                                            <span>🎵</span> 问题 1：点歌机启动网易云失败或无法控制（无法连接/雷达离线）？
                                        </h3>

                                        <div className="space-y-4 text-sm leading-relaxed text-gray-300">
                                            <div>
                                                <strong className="text-white block mb-1">诊断 A：检查您是否安装了“微软商店（Microsoft Store）”版本</strong>
                                                <p className="text-xs text-gray-400 leading-relaxed">
                                                    请进入控制面板的 <button className="text-cyan-400 font-bold underline hover:text-cyan-300" onClick={() => setActiveTab('logs')}>运行日志</button> 查看最近一轮网易云启动地址。若路径中包含 <code className="px-1.5 py-0.5 rounded bg-red-950 text-red-300 font-mono text-xs">WindowsApps</code> 文件夹（如 <code>C:\Program Files\WindowsApps\...</code>），则代表此应用是微软商店包。
                                                </p>
                                                <div className="mt-2 text-xs bg-black/40 p-3 rounded-lg border border-white/5">
                                                    <span className="text-amber-400 font-bold block mb-1">为什么这会导致失败？</span>
                                                    微软商店下载的版本处于系统严密沙箱保护中。Windows 规定任何第三方外部应用都**无权直接通过绝对路径调起**沙箱内的 `.exe`，因此会导致后端抛出 <strong>spawn EPERM</strong> 的“权限不足”报错。同时，沙盒内隔离了底层的 WebSocket 通信，令点歌雷达无法获取控制权。
                                                </div>
                                                <p className="text-xs text-gray-300 mt-2 font-bold flex items-center gap-1.5">
                                                    <span className="text-green-400">💡 解决方案：</span>
                                                    前往系统“已安装的应用”里<strong>卸载商店版网易云音乐</strong>，然后打开 <a href="https://music.163.com/" target="_blank" rel="noreferrer" className="text-cyan-400 font-bold underline hover:text-cyan-300">网易云官方网站</a> 下载传统的 Win32 客户端。重新安装后，请清理或重新选择点歌机里的扫描路径即可。
                                                </p>
                                            </div>

                                            <div className="border-t border-white/5 pt-3">
                                                <strong className="text-white block mb-1">诊断 B：端口占用情况（普通Win32版重试指南）</strong>
                                                <p className="text-xs text-gray-400 leading-relaxed">
                                                    如果是官网传统版本网易云仍然无法正常连接，可能是其默认的控制端口 <code className="text-blue-400 font-mono">9222</code> 被您的浏览器、网游加速器或其他注入软件提前占用。
                                                </p>
                                                <p className="text-xs text-gray-300 mt-2 font-bold flex items-center gap-1.5">
                                                    <span className="text-green-400">💡 解决方案：</span>
                                                    请切换至 <button className="text-cyan-400 font-bold underline hover:text-cyan-300" onClick={() => setActiveTab('settings')}>基础设置</button>，将网易云调试端口由 <code className="text-blue-400 font-mono">9222</code> 调整更改为 <code className="text-blue-400 font-mono">9223</code>（即原端口值 + 1），然后点击其右侧的<strong>“强制重载 / 重连”</strong>按钮！
                                                </p>
                                            </div>

                                            <div className="border-t border-white/5 pt-3">
                                                <strong className="text-white block mb-1">🛠️ 如何一键测试网易云是否控制成功？</strong>
                                                <p className="text-xs text-gray-400 leading-relaxed">
                                                    点歌机是否已完成对接，不需要真正等人点歌。直接前往控制面板的 <button className="text-cyan-400 font-bold underline hover:text-cyan-300" onClick={() => setActiveTab('debug')}>调试测试</button> 分页下，点击<strong>“模拟切歌指令：立即触发播放下一首”</strong>。如果您的电脑桌面端网易云音乐瞬间执行了切歌操作，说明连接控制已经**完全打通且完美在线**！
                                                </p>
                                            </div>
                                        </div>
                                    </div>

                                    {/* FAQ CARD 2: B站弹幕无法监控 */}
                                    <div className="bg-white/5 p-6 rounded-xl border border-white/10 space-y-4 shadow-inner">
                                        <h3 className="text-md font-bold text-yellow-400 flex items-center gap-2 pb-2 border-b border-white/5">
                                            <span>💬</span> 问题 2：在直播间里发送弹幕点歌，点歌机完全没有反应？
                                        </h3>

                                        <div className="space-y-4 text-sm leading-relaxed text-gray-300">
                                            <div>
                                                <strong className="text-white block mb-1">第一步：自测点歌机是否正常收到弹幕消息</strong>
                                                <p className="text-xs text-gray-400 leading-relaxed">
                                                    请前往您的 B 站直播间发送一条极其简单的测试弹幕：<code className="px-1 py-0.5 rounded bg-black/50 text-cyan-300 font-mono font-bold">test</code> 或 <code className="px-1 py-0.5 rounded bg-black/50 text-cyan-300 font-mono font-bold">测试</code>。
                                                </p>
                                                <p className="text-xs text-gray-400 leading-relaxed mt-1">
                                                    随后，立刻在点歌机控制台点击 <button className="text-cyan-400 font-bold underline hover:text-cyan-300" onClick={() => setActiveTab('logs')}>运行日志</button> 翻阅刚刚产生的新记录，寻找是否出现了以下类似信息：
                                                </p>
                                                <code className="text-cyan-300 font-mono text-[12px] block bg-black/60 p-2.5 rounded border border-white/5 mt-1.5 select-all">
                                                    [23:16:30] [弹幕] 测试通信: test
                                                </code>
                                                <p className="text-xs text-gray-400 leading-relaxed mt-1.5">
                                                    <strong className="text-red-400">如果没有刷新任何弹幕日志：</strong> 代表您根本没有与 B 站直播间建立底层的物理网络连接。请看下方的第二步排查。
                                                </p>
                                            </div>

                                            <div className="border-t border-white/5 pt-3">
                                                <strong className="text-white block mb-1.5">第二步：依次进行网络、凭证和房间号校准排查</strong>
                                                <ul className="list-decimal pl-5 space-y-2.5 text-xs text-gray-400">
                                                    <li>
                                                        <strong className="text-white">是否开启了全局代理梯子（如纯美国/海外节点 VPN）？</strong>
                                                        如果您挂了全局科学上网，B站 的直播服务器检测到境外 IP 连接时，出于防爬虫与账号风控安全拦截策略，会<strong>直接掐灭并拒绝</strong> Websocket 弹幕回环请求，导致连接一直反复断开（频繁报“弹幕监控启动！”）。<br/>
                                                        <strong className="text-green-400">解决方法：</strong> 请尝试彻底<strong>关闭全局网络代理（梯子）</strong>，切换回<strong>中国本地宽带/5G直连</strong>，或在梯子中设置 Bypass 局域网分流。
                                                    </li>
                                                    <li>
                                                        <strong className="text-white">账号授权凭证失效？</strong>
                                                        有时系统缓存的扫码登录身份由于过期被服务器丢弃，阻碍了后续的监视连接。<br/>
                                                        <strong className="text-green-400">解决方法：</strong> 请前往 <button className="text-cyan-400 font-bold underline hover:text-cyan-300" onClick={() => setActiveTab('login')}>扫码登录</button> 重新生成一个登录二维码并重新扫码鉴权绑定。使用任意普通 B 站个人号登录均可成功拉取弹幕。
                                                    </li>
                                                    <li>
                                                        <strong className="text-white">房间号错填成 UID？</strong>
                                                        千万不要在运行状态配置中把主播的个人 UID（即几千万的一长串数字）填了进去。<br/>
                                                        <strong className="text-green-400">解决方法：</strong> 请前往 <button className="text-cyan-400 font-bold underline hover:text-cyan-300" onClick={() => setActiveTab('status')}>运行状态</button>，确认输入的房间号是该直播网页链接最末尾的那串纯数字，如果是短号就输入短号。
                                                    </li>
                                                </ul>
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            )}

                            {activeTab === 'debug' && (
                                <div className="space-y-6 animate-slide-in-right flex flex-col h-full">
                                    <h2 className="text-2xl font-bold text-white mb-2">调试与测试</h2>

                                    <div className="bg-white/5 p-6 rounded-xl border border-white/10 shadow-inner">
                                        <h3 className="text-sm font-bold text-purple-400 mb-4 uppercase tracking-wider">🛠️ 测试一：搜索并加入播放列表</h3>
                                        <div className="flex gap-3 mb-3">
                                            <input
                                                type="text"
                                                value={debugInput}
                                                onChange={e => setDebugInput(e.target.value)}
                                                className="flex-1 bg-black/30 border border-white/10 rounded-lg p-3 text-sm text-white outline-none focus:border-purple-500"
                                                placeholder="输入要搜索的歌曲名称"
                                                onKeyDown={e => e.key === 'Enter' && handleDebugInsert()}
                                            />
                                            <button onClick={handleDebugInsert} className="px-6 py-3 bg-purple-600 hover:bg-purple-500 text-white text-sm rounded-lg font-bold transition-colors shadow-lg">发送到播放器</button>
                                        </div>
                                        <p className="text-xs text-gray-500 mb-8 leading-relaxed">此操作将调用搜索接口提取歌曲ID，然后推送给网易云/Folia播放器。你可以用它来测试底层注入/API连接是否正常工作。</p>

                                        <h3 className="text-sm font-bold text-blue-400 mb-4 uppercase tracking-wider">🛠️ 测试二：模拟切歌指令</h3>
                                        <button onClick={handleDebugPlayNext} className="w-full px-6 py-4 bg-blue-600 hover:bg-blue-500 text-white text-sm rounded-lg font-bold transition-colors shadow-lg flex justify-center items-center gap-2">
                                            ⏭️ 立即触发播放下一首
                                        </button>
                                        <p className="text-xs text-gray-500 mt-3 text-center leading-relaxed">向播放器发送播放下一首指令，用于测试控制权连接状态。</p>
                                    </div>
                                </div>
                            )}

                            {activeTab === 'settings' && (
                                <div className="animate-slide-in-right pb-10">
                                    <h2 className="text-2xl font-bold text-white mb-6">基础设置</h2>

                                    {/* 登录账号信息卡 */}
                                    {config.biliLogin && config.currentUser?.uid ? (
                                        <div className="bg-white/5 p-5 rounded-xl border border-white/10 mb-6 shadow-inner flex items-center gap-5">
                                            <img
                                                src={config.currentUser.face ? `${config.currentUser.face}@160w_160h.webp` : `https://api.dicebear.com/7.x/identicon/svg?seed=${config.currentUser.uid}`}
                                                referrerPolicy="no-referrer"
                                                alt="avatar"
                                                onError={(e) => { (e.target as HTMLImageElement).src = `https://api.dicebear.com/7.x/identicon/svg?seed=${config.currentUser.uid}`; }}
                                                className="w-16 h-16 rounded-full border-2 border-pink-400/60 object-cover shrink-0 shadow-lg"
                                            />
                                            <div className="flex-1 min-w-0">
                                                <div className="flex items-center gap-2 mb-1.5">
                                                    <span className="text-lg font-bold text-white truncate">{config.currentUser.uname || '未知用户'}</span>
                                                    {config.currentUser.level > 0 && (
                                                        <span className="text-[11px] font-bold px-2 py-0.5 rounded-full bg-pink-500/20 text-pink-300 border border-pink-400/30 shrink-0">Lv.{config.currentUser.level}</span>
                                                    )}
                                                </div>
                                                <div className="flex flex-wrap gap-x-5 gap-y-1.5 text-xs text-gray-400">
                                                    <span>🆔 UID: <span className="text-gray-200 font-mono select-all">{config.currentUser.uid}</span></span>
                                                    <span>🏠 直播间: {config.currentUser.myRoomId > 0
                                                        ? <span className="text-cyan-400 font-mono select-all">{config.currentUser.myRoomId}</span>
                                                        : <span className="text-gray-500">未开通</span>}</span>
                                                    <span>💖 粉丝: <span className="text-gray-200">{config.currentUser.followerCount ?? 0}</span></span>
                                                    {config.currentUser.myRoomId > 0 && (
                                                        <>
                                                            <span>⛵ 大航海: <span className="text-gray-200">{config.currentUser.guardCount ?? 0}</span></span>
                                                            <span>🛡️ 粉丝团: <span className="text-gray-200">{config.currentUser.fanClubCount ?? 0}</span></span>
                                                        </>
                                                    )}
                                                </div>
                                            </div>
                                        </div>
                                    ) : (
                                        <div className="bg-white/5 p-4 rounded-xl border border-white/10 mb-6 text-sm text-gray-400 flex items-center gap-2">
                                            <span>👤</span>
                                            <span>当前未登录，请前往「扫码登录」获取账号信息。</span>
                                        </div>
                                    )}

                                    {/* 播放器注入控制区域 */}
                                    <div className="bg-white/5 p-6 rounded-xl border border-purple-500/40 space-y-5 mb-6 shadow-[0_0_15px_rgba(168,85,247,0.15)] relative overflow-hidden">
                                        <div className="absolute top-0 right-0 bg-purple-600 text-white text-xs px-3 py-1 rounded-bl-lg font-bold">新特性</div>

                                        <h3 className="text-sm font-bold text-purple-400 uppercase tracking-widest border-b border-white/10 pb-3">
                                            <span>💻 播放器设置</span>
                                        </h3>

                                        <div className="hidden md:grid grid-cols-12 gap-4 text-[11px] text-gray-500 font-bold uppercase tracking-wider pb-2 border-b border-white/5 mt-3">
                                            <div className="col-span-3">目标播放器</div>
                                            <div className="col-span-2">当前状态</div>
                                            <div className="col-span-4">环境配置</div>
                                            <div className="col-span-3 text-right">操作</div>
                                        </div>

                                        <div className="flex flex-col gap-3 mt-2">
                                            {/* 网易云原生 */}
                                            <div className={`grid grid-cols-1 md:grid-cols-12 gap-4 items-center bg-black/40 border ${config.config.PlayerType === 'NCM' ? 'border-purple-500/50 shadow-inner' : 'border-white/10'} rounded-lg p-3 transition-colors hover:bg-white/5`}>
                                                <div className="col-span-3 flex items-center gap-3">
                                                    <button onClick={() => handleSetPlayerType('NCM')} className={`w-5 h-5 rounded-full border-2 flex items-center justify-center ${config.config.PlayerType === 'NCM' ? 'border-purple-500' : 'border-gray-500'}`}>
                                                        {config.config.PlayerType === 'NCM' && <div className="w-2.5 h-2.5 bg-purple-500 rounded-full" />}
                                                    </button>
                                                    <span className={`text-sm font-bold tracking-wide ${config.config.PlayerType === 'NCM' ? 'text-white' : 'text-gray-400'}`}>网易云音乐</span>
                                                </div>
                                                <div className="col-span-2">
                                                    {config.config.PlayerType === 'NCM' ? (
                                                        <span className={`text-[10px] px-2.5 py-1 rounded-full font-bold shadow-md ${config.cdpConnected ? 'bg-green-500/20 text-green-400 border border-green-500/30' : 'bg-red-500/20 text-red-400 border border-red-500/30'}`}>
                                                            {config.cdpConnected ? '✅ 雷达在线' : '❌ 未连接'}
                                                        </span>
                                                    ) : (
                                                        <span className="text-[10px] px-2.5 py-1 rounded-full font-bold bg-gray-600/20 text-gray-500 border border-gray-500/30">未启用</span>
                                                    )}
                                                </div>
                                                <div className="col-span-4 flex items-center gap-2">
                                                    <span className={`text-xs ${config.config.PlayerType === 'NCM' ? 'text-gray-300' : 'text-gray-600'}`}>调试端口:</span>
                                                    <input disabled={config.config.PlayerType !== 'NCM'} type="number" className="w-20 bg-black/50 border border-white/10 rounded text-xs text-white p-1.5 focus:border-purple-500 outline-none text-center disabled:opacity-50" value={config.config.CdpPort || 9222} onChange={e => setConfig({...config, config: {...config.config, CdpPort: parseInt(e.target.value)}})} />
                                                </div>
                                                <div className="col-span-3 flex justify-end">
                                                    <button disabled={config.config.PlayerType !== 'NCM'} onClick={handleRestartNCM} className="px-4 py-1.5 bg-purple-600 hover:bg-purple-500 text-white text-xs rounded-lg font-bold shadow transition-colors border border-purple-400/50 disabled:opacity-30 disabled:cursor-not-allowed">
                                                        🔌 强制重载
                                                    </button>
                                                </div>
                                            </div>

                                            {/* Folia */}
                                            <div className={`grid grid-cols-1 md:grid-cols-12 gap-4 items-center bg-black/40 border ${config.config.PlayerType === 'Folia' ? 'border-purple-500/50 shadow-inner' : 'border-white/10'} rounded-lg p-3 transition-colors hover:bg-white/5`}>
                                                <div className="col-span-3 flex items-center gap-3">
                                                    <button onClick={() => handleSetPlayerType('Folia')} className={`w-5 h-5 rounded-full border-2 flex items-center justify-center ${config.config.PlayerType === 'Folia' ? 'border-purple-500' : 'border-gray-500'}`}>
                                                        {config.config.PlayerType === 'Folia' && <div className="w-2.5 h-2.5 bg-purple-500 rounded-full" />}
                                                    </button>
                                                    <span className={`text-sm font-bold tracking-wide flex items-center gap-1 ${config.config.PlayerType === 'Folia' ? 'text-white' : 'text-gray-400'}`}>Folia 播放器</span>
                                                </div>
                                                <div className="col-span-2">
                                                    {config.config.PlayerType === 'Folia' ? (
                                                        <span className={`text-[10px] px-2.5 py-1 rounded-full font-bold shadow-md ${config.cdpConnected ? 'bg-green-500/20 text-green-400 border border-green-500/30' : 'bg-red-500/20 text-red-400 border border-red-500/30'}`}>
                                                            {config.cdpConnected ? '✅ API 在线' : '❌ 未连接'}
                                                        </span>
                                                    ) : (
                                                        <span className="text-[10px] px-2.5 py-1 rounded-full font-bold bg-gray-600/20 text-gray-500 border border-gray-500/30">未启用</span>
                                                    )}
                                                </div>
                                                <div className="col-span-4 flex items-center gap-2">
                                                    <span className={`text-xs ${config.config.PlayerType === 'Folia' ? 'text-pink-400' : 'text-gray-600'}`}>Stage Token:</span>
                                                    <input
                                                        disabled={config.config.PlayerType !== 'Folia'}
                                                        type="text"
                                                        className="flex-1 min-w-[80px] bg-black/50 border border-white/10 rounded-lg text-xs text-white p-1.5 outline-none focus:border-pink-500 placeholder-gray-600 disabled:opacity-50"
                                                        placeholder="Bearer Token..."
                                                        value={config.config.FoliaToken || ''}
                                                        onChange={e => setConfig({...config, config: {...config.config, FoliaToken: e.target.value}})}
                                                    />
                                                </div>
                                                <div className="col-span-3 flex justify-end">
                                                    <button disabled={config.config.PlayerType !== 'Folia'} onClick={handleRestartNCM} className="px-4 py-1.5 bg-purple-600 hover:bg-purple-500 text-white text-xs rounded-lg font-bold shadow transition-colors border border-purple-400/50 disabled:opacity-30 disabled:cursor-not-allowed">
                                                        🔄 测试连接
                                                    </button>
                                                </div>
                                            </div>

                                            <div className="grid grid-cols-1 md:grid-cols-12 gap-4 items-center bg-black/20 border border-white/5 rounded-lg p-3 opacity-50 cursor-not-allowed grayscale">
                                                <div className="col-span-3 flex items-center gap-3">
                                                    <div className="w-5 h-5 rounded-full border-2 border-gray-500 shrink-0"></div>
                                                    <span className="text-sm text-gray-400 font-bold tracking-wide">关闭所有注入</span>
                                                </div>
                                                <div className="col-span-9 flex justify-end">
                                                    <span className="text-[10px] px-2.5 py-1 rounded-full font-bold bg-gray-600/20 text-gray-500 border border-gray-500/30">纯净模式 / UI展示</span>
                                                </div>
                                            </div>
                                        </div>

                                        <div className="text-xs text-gray-500 mt-2 italic flex gap-2 leading-relaxed">
                                            <span className="shrink-0">💡</span>
                                            <span>
                                                网易云使用 CDP 原生通信。<br/>
                                                Folia 请在播放器设置开启 <strong>Stage Mode</strong>，将数据源设为 Stage API 并填入给出的 Bearer Token。
                                            </span>
                                        </div>
                                    </div>

                                    <div className="bg-white/5 p-6 rounded-xl border border-white/10 space-y-5 mb-6">
                                        <h3 className="text-sm font-bold text-cyan-400 uppercase tracking-widest border-b border-white/10 pb-3">歌词窗口样式</h3>

                                        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                                            {renderLyricsToggle('ShowSongInfo', '显示歌名')}
                                            {renderLyricsToggle('ShowTranslation', '显示翻译')}
                                            {renderLyricsToggle('OutlineEnabled', '文字描边')}
                                            {renderLyricsToggle('ShadowEnabled', '投影阴影')}
                                        </div>

                                        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                                            <div>
                                                <label className="block text-xs text-gray-400 mb-2">对齐方式</label>
                                                <select
                                                    value={lyricsWidgetSettings.Alignment}
                                                    onChange={e => updateLyricsWidgetSetting('Alignment', readLyricsAlignment(e.target.value))}
                                                    className="w-full bg-black/30 border border-white/10 rounded-lg p-2.5 text-sm text-white outline-none"
                                                >
                                                    <option value="left">左对齐</option>
                                                    <option value="center">居中</option>
                                                    <option value="right">右对齐</option>
                                                </select>
                                            </div>

                                            <div>
                                                <label className="block text-xs text-gray-400 mb-2">主歌词字号</label>
                                                <input
                                                    type="number"
                                                    min="24"
                                                    max="96"
                                                    value={lyricsWidgetSettings.MainFontSize}
                                                    onChange={e => updateLyricsWidgetSetting('MainFontSize', readBoundedNumber(e.target.value, defaultLyricsWidgetSettings.MainFontSize, 24, 96))}
                                                    className="w-full bg-black/30 border border-white/10 rounded-lg p-2.5 text-sm text-white outline-none"
                                                />
                                            </div>

                                            <div>
                                                <label className="block text-xs text-gray-400 mb-2">翻译字号</label>
                                                <input
                                                    type="number"
                                                    min="14"
                                                    max="64"
                                                    value={lyricsWidgetSettings.TranslationFontSize}
                                                    onChange={e => updateLyricsWidgetSetting('TranslationFontSize', readBoundedNumber(e.target.value, defaultLyricsWidgetSettings.TranslationFontSize, 14, 64))}
                                                    className="w-full bg-black/30 border border-white/10 rounded-lg p-2.5 text-sm text-white outline-none"
                                                />
                                            </div>
                                        </div>

                                        <div>
                                            <label className="block text-xs text-gray-400 mb-2">字体</label>
                                            <select
                                                value={lyricsWidgetSettings.FontFamily}
                                                onChange={e => updateLyricsWidgetSetting('FontFamily', e.target.value)}
                                                className="w-full bg-black/30 border border-white/10 rounded-lg p-2.5 text-sm text-white outline-none"
                                                style={{ fontFamily: lyricsWidgetSettings.FontFamily }}
                                            >
                                                {fontOptions.map(font => (
                                                    <option key={font} value={font} style={{ fontFamily: font }}>
                                                        {font}
                                                    </option>
                                                ))}
                                            </select>
                                        </div>

                                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                            <div>
                                                <label className="block text-xs text-gray-400 mb-2">描边大小</label>
                                                <input
                                                    type="number"
                                                    min="0"
                                                    max="8"
                                                    value={lyricsWidgetSettings.OutlineSize}
                                                    onChange={e => updateLyricsWidgetSetting('OutlineSize', readBoundedNumber(e.target.value, defaultLyricsWidgetSettings.OutlineSize, 0, 8))}
                                                    className="w-full bg-black/30 border border-white/10 rounded-lg p-2.5 text-sm text-white outline-none"
                                                />
                                            </div>

                                            <div>
                                                <label className="block text-xs text-gray-400 mb-2">投影大小</label>
                                                <input
                                                    type="number"
                                                    min="0"
                                                    max="80"
                                                    value={lyricsWidgetSettings.ShadowSize}
                                                    onChange={e => updateLyricsWidgetSetting('ShadowSize', readBoundedNumber(e.target.value, defaultLyricsWidgetSettings.ShadowSize, 0, 80))}
                                                    className="w-full bg-black/30 border border-white/10 rounded-lg p-2.5 text-sm text-white outline-none"
                                                />
                                            </div>
                                        </div>

                                        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                                            {renderLyricsColorInput('MainColor', '主歌词颜色')}
                                            {renderLyricsColorInput('TranslationColor', '翻译颜色')}
                                            {renderLyricsColorInput('OutlineColor', '描边颜色')}
                                        </div>
                                    </div>

                                    <div className="bg-white/5 p-6 rounded-xl border border-white/10 space-y-5 mb-6">
                                        <h3 className="text-sm font-bold text-blue-400 uppercase tracking-widest border-b border-white/10 pb-3">⏱️ 点歌冷却设置 (秒)</h3>
                                        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                                            <div>
                                                <label className="block text-xs text-gray-400 mb-2">普通用户</label>
                                                <input type="number" className="w-full bg-black/30 border border-white/10 rounded-lg p-2.5 text-md text-white focus:border-blue-500 outline-none" value={config.config.Cooldowns?.Normal || 0} onChange={e => updateCooldown('Normal', e.target.value)} />
                                            </div>
                                            <div>
                                                <label className="block text-xs text-blue-400 mb-2 font-bold">舰长</label>
                                                <input type="number" className="w-full bg-blue-900/30 border border-blue-500/30 rounded-lg p-2.5 text-md text-blue-200 focus:border-blue-500 outline-none" value={config.config.Cooldowns?.Captain || 0} onChange={e => updateCooldown('Captain', e.target.value)} />
                                            </div>
                                            <div>
                                                <label className="block text-xs text-purple-400 mb-2 font-bold">提督</label>
                                                <input type="number" className="w-full bg-purple-900/30 border border-purple-500/30 rounded-lg p-2.5 text-md text-purple-200 focus:border-purple-500 outline-none" value={config.config.Cooldowns?.Admiral || 0} onChange={e => updateCooldown('Admiral', e.target.value)} />
                                            </div>
                                            <div>
                                                <label className="block text-xs text-red-400 mb-2 font-bold">总督</label>
                                                <input type="number" className="w-full bg-red-900/30 border border-red-500/30 rounded-lg p-2.5 text-md text-red-200 focus:border-red-500 outline-none" value={config.config.Cooldowns?.Governor || 0} onChange={e => updateCooldown('Governor', e.target.value)} />
                                            </div>
                                        </div>
                                    </div>

                                    <div className="bg-white/5 p-6 rounded-xl border border-white/10 space-y-5 mb-6">
                                        <h3 className="text-sm font-bold text-blue-400 uppercase tracking-widest border-b border-white/10 pb-3">⚙️ 常规参数</h3>
                                        <div className="grid grid-cols-2 gap-6">
                                            <div>
                                                <label className="block text-xs text-gray-400 mb-2">空闲时点歌行为</label>
                                                <select
                                                    value={config.config.IdleWaitNext === false ? 'false' : 'true'}
                                                    onChange={e => setConfig({...config, config: {...config.config, IdleWaitNext: e.target.value === 'true'}})}
                                                    className="w-full bg-black/30 border border-white/10 rounded-lg p-2.5 text-md text-white focus:border-blue-500 outline-none cursor-pointer"
                                                >
                                                    <option value="true">加入网易云/Folia下一首 (等当前播完)</option>
                                                    <option value="false">立即强行切歌播放</option>
                                                </select>
                                            </div>

                                            <div className="flex flex-col justify-center pt-3">
                                                <div className="flex justify-between items-center bg-black/30 border border-white/10 rounded-lg p-3">
                                                    <div>
                                                        <label className="block text-sm text-white font-medium">记录所有弹幕日志</label>
                                                        <span className="text-xs text-gray-500 block mt-1">用于在日志排错抓取</span>
                                                    </div>
                                                    <button onClick={() => setConfig({...config, config: {...config.config, ShowAllDanmaku: !config.config.ShowAllDanmaku}})} className={`w-10 h-6 rounded-full p-1 transition-colors ${config.config.ShowAllDanmaku ? 'bg-blue-600' : 'bg-gray-600'}`}>
                                                        <div className={`w-4 h-4 rounded-full bg-white transition-transform ${config.config.ShowAllDanmaku ? 'translate-x-4' : 'translate-x-0'}`}></div>
                                                    </button>
                                                </div>
                                            </div>
                                        </div>
                                    </div>

                                    <div className="bg-white/5 p-6 rounded-xl border border-white/10 space-y-5 mb-6">
                                        <h3 className="text-sm font-bold text-yellow-400 uppercase tracking-widest border-b border-white/10 pb-3">👑 超级用户白名单</h3>
                                        <p className="text-sm text-gray-500">在下方名单中的 B站用户名，将完全无视冷却时间和任何点歌、切歌权限限制。</p>

                                        <div className="flex gap-3">
                                            <input
                                                type="text"
                                                value={superUserInput}
                                                onChange={e => setSuperUserInput(e.target.value)}
                                                onKeyDown={e => e.key === 'Enter' && addSuperUser()}
                                                className="flex-1 bg-black/30 border border-white/10 rounded-lg p-2.5 text-md text-white focus:border-blue-500 outline-none"
                                                placeholder="输入需要特权的 B站完整用户名..."
                                            />
                                            <button onClick={addSuperUser} className="px-6 py-2.5 bg-yellow-600 hover:bg-yellow-500 text-white text-md rounded-lg font-bold transition-colors">添加</button>
                                        </div>

                                        <div className="flex flex-wrap gap-3 mt-3">
                                            {!(config.config.SuperUsers?.length > 0) ? (
                                                <span className="text-sm text-gray-600 italic">暂无超级用户</span>
                                            ) : (
                                                config.config.SuperUsers.map((su: string) => (
                                                    <div key={su} className="bg-white/10 border border-white/20 text-white px-3 py-1.5 rounded-lg text-sm flex items-center gap-2">
                                                        <span>{su}</span>
                                                        <button onClick={() => removeSuperUser(su)} className="text-red-400 hover:text-red-300 font-bold ml-1">✕</button>
                                                    </div>
                                                ))
                                            )}
                                        </div>
                                    </div>

                                    <div className="bg-white/5 p-6 rounded-xl border border-white/10">
                                        <h3 className="text-sm font-bold text-green-400 uppercase tracking-widest border-b border-white/10 pb-3 mb-5">🛡️ 弹幕指令权限控制</h3>

                                        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                                            {permTypes.map(pt => {
                                                const pData = config.config[pt.key] || { AllowManager: true, MinGuardType: (pt.key === 'ForceControlPermission' ? -1 : 0), MinMedalLevel: 0 };

                                                return (
                                                    <div key={pt.key} className="bg-black/40 border border-white/5 p-4 rounded-xl flex flex-col gap-4">
                                                        <div className="font-bold text-white text-md border-b border-white/5 pb-2">{pt.label}</div>

                                                        <div className="flex justify-between items-center">
                                                            <span className="text-sm text-gray-300">允许房管无视限制</span>
                                                            <button onClick={() => updatePermission(pt.key, 'AllowManager', !pData.AllowManager)} className={`w-10 h-6 rounded-full p-1 transition-colors ${pData.AllowManager ? 'bg-green-600' : 'bg-gray-600'}`}>
                                                                <div className={`w-4 h-4 rounded-full bg-white transition-transform ${pData.AllowManager ? 'translate-x-4' : 'translate-x-0'}`}></div>
                                                            </button>
                                                        </div>

                                                        <div>
                                                            <label className="block text-xs text-gray-500 mb-1.5">最低航海舰队要求</label>
                                                            <select
                                                                value={pData.MinGuardType}
                                                                onChange={e => updatePermission(pt.key, 'MinGuardType', parseInt(e.target.value))}
                                                                className="w-full bg-black border border-white/10 rounded-lg p-2.5 text-sm text-white outline-none cursor-pointer"
                                                            >
                                                                <option value="0">无限制 (所有人)</option>
                                                                <option value="3">舰长 及以上</option>
                                                                <option value="2">提督 及以上</option>
                                                                <option value="1">仅限 总督</option>
                                                                <option value="-1">仅限 房管和超级用户</option>
                                                            </select>
                                                        </div>

                                                        <div>
                                                            <label className="block text-xs text-gray-500 mb-1.5">最低粉丝牌等级要求 (0为无限制)</label>
                                                            <input
                                                                type="number"
                                                                value={pData.MinMedalLevel}
                                                                onChange={e => updatePermission(pt.key, 'MinMedalLevel', parseInt(e.target.value))}
                                                                className="w-full bg-black border border-white/10 rounded-lg p-2.5 text-sm text-white outline-none"
                                                                min="0" max="40"
                                                            />
                                                        </div>
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    </div>
                                </div>
                            )}

                            {activeTab === 'login' && (
                                <div className="space-y-6 animate-slide-in-right flex flex-col items-center pt-10">
                                    <h2 className="text-2xl font-bold text-white mb-2 self-start w-full max-w-md">B站账号授权</h2>
                                    <div className="bg-white/5 p-8 rounded-2xl border border-white/10 flex flex-col items-center justify-center w-full max-w-md text-center shadow-xl">

                                        {config.biliLogin ? (
                                            <div className="mb-6 w-full bg-green-500/20 border border-green-500/40 p-4 rounded-xl text-green-400 font-medium text-sm leading-relaxed">
                                                已检测到有效的账号登录缓存 <br/> (UID: {config.uid}) <br/><br/> 您可直接前往「运行状态」切换房间号！
                                            </div>
                                        ) : (
                                            <div className="mb-6 w-full bg-red-500/20 border border-red-500/40 p-4 rounded-xl text-red-400 font-medium text-sm">
                                                未检测到账号登录信息，请先扫码登录！
                                            </div>
                                        )}

                                        {qrState.base64 ? (
                                            <div className="bg-white p-3 rounded-2xl shadow-2xl mb-6"><img src={qrState.base64} alt="Bilibili Login QR" className="w-48 h-48" /></div>
                                        ) : (
                                            <div className="w-48 h-48 bg-black/30 rounded-2xl mb-6 flex items-center justify-center text-6xl border border-white/5">📱</div>
                                        )}

                                        <h3 className="text-md text-white font-bold mb-5">{qrState.message}</h3>
                                        <button onClick={startQrLogin} disabled={qrState.loading} className="px-6 py-3 bg-[#fb7299] hover:bg-[#ff85a8] text-white text-md rounded-xl font-bold shadow-lg disabled:opacity-50 transition-colors w-full">
                                            {config.biliLogin ? '我要换号 (重新获取二维码)' : (qrState.loading ? '正在获取...' : '点击获取登录二维码')}
                                        </button>

                                        <p className="text-xs text-gray-500 mt-4 leading-relaxed">
                                            完全在本地完成登录。⚠️ 请注意：只需扫码登录<strong className="text-pink-400">任意普通B站账号</strong>即可获取弹幕，不需要必须是主播的账号！
                                        </p>
                                    </div>
                                </div>
                            )}

                            {activeTab === 'update' && (
                                <div className="space-y-6 animate-slide-in-right flex flex-col items-center text-center pt-10">
                                    <h2 className="text-2xl font-bold text-white mb-2 self-start w-full max-w-md">自动更新管理</h2>
                                    <div className="bg-white/5 p-8 rounded-2xl border border-white/10 flex flex-col items-center justify-center w-full max-w-md shadow-xl">
                                        <div className="text-6xl mb-5">🚀</div>

                                        <div className="text-sm text-green-400 font-bold mb-8 bg-green-500/10 px-4 py-1.5 rounded-full border border-green-500/20">
                                            当前运行版本: v{config.version || '未知'}
                                        </div>

                                        <p className="text-sm text-gray-400 mb-8 leading-relaxed">一键连接 GitHub 检查最新版本。</p>

                                        {downloadProgress !== null ? (
                                            <div className="bg-green-900/30 border border-green-500/30 p-5 rounded-xl w-full text-left">
                                                <div className="text-green-400 font-bold text-md mb-2 flex justify-between">
                                                    <span>🚀 正在下载更新...</span>
                                                    <span>{Math.floor(downloadProgress)}%</span>
                                                </div>
                                                <div className="w-full bg-black/50 h-3 rounded-full overflow-hidden">
                                                    <div
                                                        className="bg-green-500 h-full transition-all duration-300 ease-out"
                                                        style={{ width: `${downloadProgress}%` }}
                                                    ></div>
                                                </div>
                                                <div className="text-xs text-green-400/70 mt-3 text-center">下载完成后程序将自动重启，请勿关闭本窗口</div>
                                            </div>
                                        ) : updateInfo.info?.hasUpdate ? (
                                            <div className="bg-green-900/30 border border-green-500/30 p-5 rounded-xl w-full">
                                                <div className="text-green-400 font-bold text-md mb-4">🎉 发现新版本: {updateInfo.info.version}</div>
                                                <button onClick={handleApplyUpdate} className="px-5 py-3 bg-green-600 hover:bg-green-500 text-white text-md rounded-xl font-bold shadow-lg w-full transition-colors">立刻下载并重启更新</button>
                                            </div>
                                        ) : (
                                            <button onClick={handleUpdateCheck} disabled={updateInfo.checking} className="px-6 py-3 bg-blue-600 hover:bg-blue-500 text-white text-md rounded-xl font-bold shadow-lg disabled:opacity-50 transition-colors w-full">
                                                {updateInfo.checking ? '正在检查 GitHub...' : '检查最新更新'}
                                            </button>
                                        )}
                                        {updateInfo.info?.error && <div className="mt-4 text-red-400 text-sm">{updateInfo.info.error}</div>}
                                    </div>
                                </div>
                            )}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};

const LyricsWidget: React.FC = () => {
    const [lyrics, setLyrics] = useState<LyricsPayload | null>(null);
    const [settings, setSettings] = useState<LyricsWidgetSettings>(defaultLyricsWidgetSettings);
    const [cdpConnected, setCdpConnected] = useState(false);
    const [requestFailed, setRequestFailed] = useState(false);
    const [clockNow, setClockNow] = useState(() => Date.now());
    const options = toLyricsDisplayOptions(settings);
    const displayedLyrics = resolveLocalLyrics(lyrics, clockNow);
    const textShadow = buildLyricsTextShadow(options);

    useEffect(() => {
        let disposed = false;
        let timer: number | null = null;

        const refreshLyrics = async () => {
            try {
                const res = await fetch('http://localhost:5555/api/lyrics');
                const body: unknown = await res.json();
                const parsed = readLyricsApiResponse(body);
                if (disposed) return;
                setLyrics(parsed.lyrics);
                setSettings(parsed.config);
                setCdpConnected(parsed.cdpConnected);
                setRequestFailed(false);
                timer = window.setTimeout(refreshLyrics, getLyricsProbeDelay(parsed.lyrics));
            } catch {
                if (disposed) return;
                setLyrics(null);
                setCdpConnected(false);
                setRequestFailed(true);
                timer = window.setTimeout(refreshLyrics, 300);
            }
        };

        refreshLyrics();
        return () => {
            disposed = true;
            if (timer !== null) window.clearTimeout(timer);
        };
    }, []);

    useEffect(() => {
        const timer = window.setInterval(() => setClockNow(Date.now()), 80);
        return () => window.clearInterval(timer);
    }, []);

    const currentLine = displayedLyrics?.current;
    const translation = options.showTranslation ? currentLine?.translation : '';
    const statusText = requestFailed
        ? '歌词服务未连接'
        : !cdpConnected
            ? '等待网易云连接'
            : displayedLyrics?.isLoading
                ? '歌词加载中'
                : displayedLyrics && !displayedLyrics.hasLyrics
                    ? '暂无歌词'
                    : '等待播放';
    const mainText = currentLine?.text || statusText;
    const songLabel = displayedLyrics?.songName
        ? `${displayedLyrics.songName}${displayedLyrics.artistName ? ` - ${displayedLyrics.artistName}` : ''}`
        : '';
    const alignItems = options.alignment === 'center' ? 'center' : options.alignment === 'right' ? 'flex-end' : 'flex-start';
    const mainTextStyle: React.CSSProperties = {
        wordBreak: 'keep-all',
        overflowWrap: 'anywhere',
        fontSize: `clamp(24px, 8vw, ${options.mainFontSize}px)`
    };
    const translationStyle: React.CSSProperties = {
        wordBreak: 'keep-all',
        overflowWrap: 'anywhere',
        fontSize: `clamp(18px, 5vw, ${options.translationFontSize}px)`
    };

    return (
        <>
            <GlobalStyles />
            <div
                className="min-h-screen w-screen overflow-hidden bg-transparent px-6 py-8 text-white flex items-center justify-center"
                style={{ fontFamily: options.fontFamily }}
            >
                <div
                    className="w-full max-w-5xl flex flex-col gap-4"
                    style={{ textAlign: options.alignment, alignItems }}
                >
                    {options.showSongInfo && songLabel && (
                        <LyricsText
                            text={songLabel}
                            className="max-w-full truncate text-xs sm:text-sm md:text-base font-medium tracking-normal"
                            style={{}}
                            color={options.translationColor}
                            textShadow={textShadow}
                            outlineEnabled={options.outlineEnabled}
                            outlineColor={options.outlineColor}
                            outlineSize={options.outlineSize}
                        />
                    )}

                    <LyricsText
                        text={mainText}
                        className="max-w-full whitespace-pre-wrap break-words font-bold leading-tight tracking-normal"
                        style={mainTextStyle}
                        color={options.textColor}
                        textShadow={textShadow}
                        outlineEnabled={options.outlineEnabled}
                        outlineColor={options.outlineColor}
                        outlineSize={options.outlineSize}
                    />

                    {translation && (
                        <LyricsText
                            text={translation}
                            className="max-w-full whitespace-pre-wrap break-words font-semibold leading-snug tracking-normal"
                            style={translationStyle}
                            color={options.translationColor}
                            textShadow={textShadow}
                            outlineEnabled={options.outlineEnabled}
                            outlineColor={options.outlineColor}
                            outlineSize={options.outlineSize}
                        />
                    )}
                </div>
            </div>
        </>
    );
};

const App: React.FC = () => {
    const params = new URLSearchParams(window.location.search);
    const isAdmin = params.get('admin') === 'true';
    const isLyrics = window.location.pathname === '/lyrics';

    if (isLyrics) {
        return <LyricsWidget />;
    }

    if (isAdmin) {
        return (
            <>
                <GlobalStyles />
                <div style={{ background: '#0d1117', minHeight: '100vh' }}>
                    <AdminWidget onClose={() => ipcRenderer?.send('close-window')} />
                </div>
            </>
        );
    }

    return (
        <>
            <GlobalStyles />
            <OverlayWidget onToggleAdmin={() => {
                if (isElectron) ipcRenderer?.send('open-admin');
            }}/>
        </>
    );
};

export default App;
