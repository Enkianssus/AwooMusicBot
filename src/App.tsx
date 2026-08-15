import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
    FEEDBACK_HISTORY_STORAGE_KEY,
    countUnreadFeedbackReplies,
    markFeedbackReplyRead,
    mergeFeedbackStatus,
    parseFeedbackHistory,
    recordFeedbackSubmission,
    serializeFeedbackHistory,
    type LocalFeedbackHistoryItem,
    type PublicFeedbackStatus
} from './feedback-history-policy';
import {
    buildNeteaseConnectorSuccessMessage,
    shouldWaitForConnectorPlayer
} from './connector-update-feedback-policy';

// ==========================================
// 0. 环境检测
// ==========================================
const isElectron = new URLSearchParams(window.location.search).get('mode') === 'electron';

const electronAPI = window.electronAPI;
const SKIN_MARKETPLACE_URL = 'https://awoo-skins.enkianss.us/';
const FEEDBACK_STATUS_LABELS: Record<string, string> = {
    open: '已收到',
    triaging: '正在确认',
    working: '处理中',
    resolved: '已解决',
    closed: '已关闭',
    duplicate: '重复问题'
};

function formatFeedbackTime(value: string): string {
    if (!value) return '时间未知';
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp)
        ? new Date(timestamp).toLocaleString('zh-CN')
        : '时间未知';
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
    CoverUrl?: string;
    OrderedBy: string;
    GuardLevel?: number;
}

type RequestedSongArtwork = 'bili_avatar' | 'song_cover';

interface SongArtworkImageProps {
    song: SongInfo;
    source: 'avatar' | 'cover';
    className?: string;
}

function getArtworkCandidates(
    song: SongInfo,
    source: 'avatar' | 'cover'
): string[] {
    const primaryUrl = source === 'cover'
        ? song.CoverUrl || ''
        : song.OrderedByAvatar || '';
    const avatarFallback = source === 'avatar' && song.OrderedByUid
        ? `https://api.dicebear.com/7.x/identicon/svg?seed=${encodeURIComponent(song.OrderedByUid)}`
        : '';
    const candidates = [primaryUrl, avatarFallback].filter(Boolean);

    if (source === 'cover' && primaryUrl) {
        try {
            const parsed = new URL(primaryUrl);
            if (/^p\d+\.music\.126\.net$/i.test(parsed.hostname)) {
                for (const host of ['p1.music.126.net', 'p2.music.126.net', 'p3.music.126.net', 'p4.music.126.net']) {
                    const alternative = new URL(parsed.toString());
                    alternative.hostname = host;
                    if (!alternative.search) alternative.search = '?param=256y256';
                    candidates.push(alternative.toString());
                }
            }
        } catch {
            // A malformed external URL will fail once and then use the icon.
        }
    }

    return [...new Set(candidates)];
}

const SongArtworkImage: React.FC<SongArtworkImageProps> = ({ song, source, className = '' }) => {
    const candidates = getArtworkCandidates(song, source);
    const candidateKey = candidates.join('\n');
    const [candidateIndex, setCandidateIndex] = useState(0);
    const imageUrl = candidates[candidateIndex] || '';

    useEffect(() => {
        setCandidateIndex(0);
    }, [candidateKey]);

    if (!imageUrl) return <span className="w-full h-full flex items-center justify-center text-lg" aria-label="暂无歌曲封面">🎵</span>;

    return (
        <img
            src={imageUrl}
            alt={source === 'cover' ? `${song.SongName} 封面` : `${song.OrderedBy} 头像`}
            referrerPolicy="no-referrer"
            className={`w-full h-full object-cover ${className}`}
            onError={() => setCandidateIndex(index => index + 1)}
        />
    );
};

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

type AppUpdateDownloadState =
    | 'idle'
    | 'checking'
    | 'downloading'
    | 'applying'
    | 'no-update'
    | 'error';

interface AppUpdateDownloadStatus {
    state: AppUpdateDownloadState;
    progress: number | null;
    version: string | null;
    message: string;
    updatedAt: string;
}

interface QrState {
    loading: boolean;
    base64: string;
    message: string;
}

type NativeConnectorId = 'netease' | 'kugou' | 'qqmusic' | 'folia';

type GiftRequestTier = 'Normal' | 'Captain' | 'Admiral' | 'Governor';

const GIFT_REQUEST_TIER_OPTIONS: ReadonlyArray<{
    key: GiftRequestTier;
    label: string;
    accent: string;
    inputClass: string;
}> = [
    {
        key: 'Normal',
        label: '普通观众',
        accent: 'text-gray-300',
        inputClass: 'bg-black/30 border-white/10 text-white focus:border-blue-500'
    },
    {
        key: 'Captain',
        label: '舰长',
        accent: 'text-blue-400',
        inputClass: 'bg-blue-900/20 border-blue-500/30 text-blue-100 focus:border-blue-500'
    },
    {
        key: 'Admiral',
        label: '提督',
        accent: 'text-purple-400',
        inputClass: 'bg-purple-900/20 border-purple-500/30 text-purple-100 focus:border-purple-500'
    },
    {
        key: 'Governor',
        label: '总督',
        accent: 'text-red-400',
        inputClass: 'bg-red-900/20 border-red-500/30 text-red-100 focus:border-red-500'
    }
];

interface ConnectorStatus {
    id: NativeConnectorId;
    name: string;
    installed: boolean;
    currentVersion: string | null;
    latestVersion: string | null;
    minimumCoreVersion: string | null;
    compatible: boolean;
    updateAvailable: boolean;
    autoUpdateAvailable: boolean;
    manualUpdateAvailable: boolean;
    updateKind: 'none' | 'install' | 'patch' | 'player' | 'major';
    supportedPlayerVersion: string | null;
    updating: boolean;
    checkedAt: string;
    error: string | null;
}

interface PlayerUpgradeNotice {
    kind: 'upgrade';
    code: 'netease-player-update-suggested' | 'kugou-player-update-suggested' | 'qqmusic-player-update-suggested';
    reason: 'older-than-tested-after-control-failure' | 'player-version-unsupported';
    playerKey: NativeConnectorId;
    playerName: string;
    currentVersion: string;
    testedPlayerVersion: string;
    blockedCommand: string;
    processId: number | null;
    detectedAt: string;
}

interface PlayerProcessAccessNotice {
    kind: 'process-access';
    code: 'qqmusic-control-access-denied';
    reason: 'process-access-denied';
    playerKey: NativeConnectorId;
    playerName: string;
    currentVersion: string;
    blockedCommand: string;
    processId: number | null;
    operation: string;
    detectedAt: string;
}

type PlayerControlNotice = PlayerUpgradeNotice | PlayerProcessAccessNotice;

type OverlaySettingValue = string | number | boolean;

interface OverlaySettingDefinition {
    key: string;
    label: string;
    description: string;
    group: string;
    type: 'color' | 'range' | 'toggle' | 'select' | 'text';
    default: OverlaySettingValue;
    cssVariable: string;
    cssUnit: string;
    min?: number;
    max?: number;
    step?: number;
    maxLength?: number;
    placeholder?: string;
    options?: Array<{ label: string; value: string }>;
}

interface OverlayModRecord {
    schemaVersion: 1;
    id: string;
    name: string;
    version: string;
    entry: string;
    author: string;
    description: string;
    homepage: string;
    minAppVersion: string;
    installedAt: string;
    source: string;
    active: boolean;
    builtin: boolean;
    settings: OverlaySettingDefinition[];
    values: Record<string, OverlaySettingValue>;
}

interface OverlayModState {
    activeId: string;
    active: OverlayModRecord;
    overlays: OverlayModRecord[];
    officialRepository: string;
    officialDescriptorProxy: string;
}

const OverlaySettingControl: React.FC<{
    definition: OverlaySettingDefinition;
    value: OverlaySettingValue | undefined;
    onChange: (value: OverlaySettingValue) => void;
    onReset: () => void;
}> = ({ definition, value, onChange, onReset }) => {
    const currentValue = value ?? definition.default;
    const isDefault = currentValue === definition.default;
    const description = definition.description && (
        <div className="mt-0.5 text-[10px] leading-relaxed text-gray-500">{definition.description}</div>
    );
    const resetButton = (
        <button
            type="button"
            aria-label={`恢复${definition.label}默认值`}
            title="恢复此项默认值"
            disabled={isDefault}
            onClick={event => {
                event.preventDefault();
                event.stopPropagation();
                onReset();
            }}
            className="grid h-6 w-6 shrink-0 place-items-center rounded-md border border-white/10 bg-white/5 text-sm leading-none text-gray-400 transition-colors hover:border-cyan-400/30 hover:bg-cyan-500/10 hover:text-cyan-200 disabled:cursor-default disabled:opacity-25 disabled:hover:border-white/10 disabled:hover:bg-white/5 disabled:hover:text-gray-400"
        >
            ↶
        </button>
    );
    if (definition.type === 'toggle') {
        const enabled = currentValue === true;
        return (
            <div className="flex items-center justify-between gap-4 rounded-lg border border-white/5 bg-black/15 px-3 py-2.5">
                <div className="min-w-0">
                    <div className="text-xs font-medium text-gray-200">{definition.label}</div>
                    {description}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                    {resetButton}
                    <button aria-label={definition.label} onClick={() => onChange(!enabled)} className={`h-6 w-10 shrink-0 rounded-full p-1 transition-colors ${enabled ? 'bg-cyan-500' : 'bg-white/15'}`}>
                        <span className={`block h-4 w-4 rounded-full bg-white transition-transform ${enabled ? 'translate-x-4' : 'translate-x-0'}`} />
                    </button>
                </div>
            </div>
        );
    }
    if (definition.type === 'color') {
        const color = typeof currentValue === 'string' ? currentValue : String(definition.default);
        return (
            <div className="flex items-center justify-between gap-4 rounded-lg border border-white/5 bg-black/15 px-3 py-2.5">
                <span className="min-w-0">
                    <span className="block text-xs font-medium text-gray-200">{definition.label}</span>
                    {description}
                </span>
                <span className="flex shrink-0 items-center gap-2 font-mono text-[10px] text-gray-500">
                    {resetButton}
                    {color}
                    <input aria-label={definition.label} type="color" value={color} onChange={event => onChange(event.target.value)} className="h-8 w-8 cursor-pointer rounded bg-transparent" />
                </span>
            </div>
        );
    }
    if (definition.type === 'range') {
        const numericValue = typeof currentValue === 'number' ? currentValue : Number(definition.default);
        const isFractionalOpacity = definition.key.toLowerCase().includes('opacity') && Number(definition.max) <= 1;
        const displayValue = isFractionalOpacity
            ? `${Math.round(numericValue * 100)}%`
            : `${numericValue}${definition.cssUnit === 's' ? ' 秒' : definition.cssUnit || ''}`;
        return (
            <div className="block rounded-lg border border-white/5 bg-black/15 px-3 py-2.5">
                <span className="flex items-center justify-between gap-3">
                    <span className="text-xs font-medium text-gray-200">{definition.label}</span>
                    <span className="flex items-center gap-2">
                        <span className="text-[11px] font-bold text-cyan-300">{displayValue}</span>
                        {resetButton}
                    </span>
                </span>
                {description}
                <span className="mt-2 flex items-center gap-2">
                    <input aria-label={definition.label} type="range" min={definition.min} max={definition.max} step={definition.step} value={numericValue} onChange={event => onChange(Number(event.target.value))} className="min-w-0 flex-1 accent-cyan-500" />
                    <input aria-label={`${definition.label}数值`} type="number" min={definition.min} max={definition.max} step={definition.step} value={numericValue} onChange={event => {
                        const next = Number(event.target.value);
                        if (Number.isFinite(next)) {
                            onChange(Math.min(Number(definition.max), Math.max(Number(definition.min), next)));
                        }
                    }} className="w-16 rounded-md border border-white/10 bg-black/30 px-1.5 py-1 text-right text-[10px] text-gray-300 outline-none focus:border-cyan-400" />
                </span>
            </div>
        );
    }
    if (definition.type === 'select') {
        return (
            <div className="block rounded-lg border border-white/5 bg-black/15 px-3 py-2.5">
                <span className="flex items-center justify-between gap-3">
                    <span className="text-xs font-medium text-gray-200">{definition.label}</span>
                    {resetButton}
                </span>
                {description}
                <select aria-label={definition.label} value={String(currentValue)} onChange={event => onChange(event.target.value)} className="mt-2 w-full rounded-lg border border-white/10 bg-black px-2.5 py-2 text-xs text-white outline-none focus:border-cyan-400">
                    {(definition.options || []).map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
            </div>
        );
    }
    return (
        <div className="block rounded-lg border border-white/5 bg-black/15 px-3 py-2.5">
            <span className="flex items-center justify-between gap-3">
                <span className="text-xs font-medium text-gray-200">{definition.label}</span>
                {resetButton}
            </span>
            {description}
            <input aria-label={definition.label} type="text" maxLength={definition.maxLength} placeholder={definition.placeholder} value={String(currentValue)} onChange={event => onChange(event.target.value)} className="mt-2 w-full rounded-lg border border-white/10 bg-black/30 px-2.5 py-2 text-xs text-white outline-none focus:border-cyan-400" />
        </div>
    );
};

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
    onOpenAppearance: () => void;
}

const OverlayWidget: React.FC<OverlayWidgetProps> = ({ onToggleAdmin, onOpenAppearance }) => {
    const [data, setData] = useState<{ current: SongInfo | null; currentIsRequested: boolean; playerPausedAfterRequests: boolean; requestedSongArtwork: RequestedSongArtwork; queue: SongInfo[]; status: string }>({ current: null, currentIsRequested: false, playerPausedAfterRequests: false, requestedSongArtwork: 'bili_avatar', queue: [], status: '' });
    const [isConnected, setIsConnected] = useState<boolean>(true);
    const [isCdpConnected, setIsCdpConnected] = useState<boolean>(true);
    const [accepting, setAccepting] = useState<boolean>(true);
    const [playing, setPlaying] = useState<boolean>(true);

    const [rejects, setRejects] = useState<any[]>([]);
    const [, setPrevQueue] = useState<SongInfo[]>([]);
    const [newItemsIds, setNewItemsIds] = useState<Set<string>>(new Set());

    const [dragInfo, setDragInfo] = useState<DragInfo | null>(null);
    const [titleBarActionsOpen, setTitleBarActionsOpen] = useState<boolean>(false);

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
        if (!isElectron) return;

        let cancelled = false;
        let welcomeTimer: ReturnType<typeof setTimeout> | undefined;
        const legacyHintWasShown = (() => {
            try {
                return localStorage.getItem('bili-first-launch') !== null;
            } catch {
                return false;
            }
        })();

        const showWelcomeHint = async () => {
            let shouldShow = !legacyHintWasShown;
            try {
                if (electronAPI?.claimWelcomeHint) {
                    shouldShow = await electronAPI.claimWelcomeHint(legacyHintWasShown);
                }
            } catch {
                // 旧版 preload 或本地存储不可用时，保留原有的一次性行为。
            }

            try {
                localStorage.setItem('bili-first-launch', 'false');
            } catch {
                // 主进程配置仍会负责跨版本持久化。
            }

            if (!shouldShow || cancelled) return;
            welcomeTimer = setTimeout(() => {
                if (cancelled) return;
                triggerToast("🎉 欢迎使用！已自动为您打开控制面板。如果您关闭了它，可随时点击右上角的 ⚙️ 按钮呼出！");
                electronAPI?.openAdmin();
            }, 1000);
        };

        void showWelcomeHint();
        return () => {
            cancelled = true;
            if (welcomeTimer) clearTimeout(welcomeTimer);
        };
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
            fetch('http://127.0.0.1:5555/api/config', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ widgetStyle: widgetStyleToSave })
            }).catch(()=>{});
        }, 500);

        return () => clearTimeout(syncTimer);
    }, [theme, widgetStyle]);

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
    }, [widgetStyle]);

    useEffect(() => {
        const fetchData = async () => {
            try {
                const res = await fetch('http://127.0.0.1:5555/data');
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

                setData({ current: json.current || null, currentIsRequested: json.currentIsRequested === true, playerPausedAfterRequests: json.playerPausedAfterRequests === true, requestedSongArtwork: json.requestedSongArtwork === 'song_cover' ? 'song_cover' : 'bili_avatar', queue: safeQueue, status: json.status || '' });
                setAccepting(json.accepting ?? true);
                setPlaying(json.playing ?? true);
                setIsConnected(true);

                if (typeof json.cdpConnected === 'boolean') {
                    setIsCdpConnected(json.cdpConnected);
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
            await fetch('http://127.0.0.1:5555/api/queue/action', {
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
            await fetch('http://127.0.0.1:5555/api/state/toggle', { method: 'POST' });
            setAccepting(!accepting);
        } catch(err) { console.error(err); }
    };

    const togglePlaying = async (e?: React.MouseEvent) => {
        if (!isElectron || actionLock) return;
        e?.stopPropagation?.();
        triggerActionLock();
        try {
            await fetch('http://127.0.0.1:5555/api/state/toggle_play', { method: 'POST' });
            setPlaying(!playing);
        } catch(err) { console.error(err); }
    };

    const handleWindowClose = () => {
        if (isElectron) electronAPI?.closeWindow();
        else { fetch('http://127.0.0.1:5555/api/exit', { method: 'POST' }); window.close(); }
    };

    const handleWindowMinimize = () => {
        if (isElectron) electronAPI?.minimizeWindow();
    };

    const handleDragStart = (e: React.MouseEvent<HTMLDivElement>) => {
        if (isElectron) return;
        const targetElement = e.target as HTMLElement;
        if (targetElement.tagName.toLowerCase() === 'input' || targetElement.tagName.toLowerCase() === 'button' || targetElement.closest('.no-drag')) return;
        const target = (e.currentTarget as HTMLElement).closest('.react-widget-root') as HTMLElement;
        if (!target) return;

        const startX = e.clientX, startY = e.clientY, initialX = widgetStyle.x, initialY = widgetStyle.y;

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

        const startX = e.clientX, startY = e.clientY, initialW = widgetStyle.w, initialH = widgetStyle.h;
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
                electronAPI?.resizeOverlay(lastW, lastH);
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

    // 后端暂时不可用时不要把控制入口藏在悬停动画里，确保用户仍能打开设置自救。
    const titleBarActionsVisible = titleBarActionsOpen || !isConnected;

    return (
        <div className={isElectron
            ? "w-full h-screen p-5 flex flex-col font-sans select-none group box-border overflow-hidden bg-transparent pointer-events-none no-drag"
            : "react-widget-root absolute p-4 flex flex-col font-sans select-none z-[50] group cursor-grab active:cursor-grabbing"
        }>
            <div className="fixed top-14 left-1/2 z-[9999] flex w-[calc(100%-2rem)] max-w-[430px] -translate-x-1/2 flex-col gap-2 pointer-events-none">
                {toasts.map(t => (
                    <div key={t.id} className="animate-toast flex w-full min-w-0 items-start gap-2.5 rounded-2xl border border-cyan-400/50 bg-gradient-to-r from-blue-600 to-cyan-500 px-4 py-3 text-sm font-bold leading-relaxed text-white shadow-[0_10px_30px_rgba(6,182,212,0.4)]">
                        <span className="shrink-0 text-xl leading-5">🔔</span>
                        <span className="min-w-0 flex-1 whitespace-normal break-words">{t.msg}</span>
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
                            <div className={`w-8 h-8 ${data.requestedSongArtwork === 'song_cover' ? 'rounded-md' : 'rounded-full'} overflow-hidden shrink-0 border border-white/20 bg-slate-800 flex items-center justify-center`}>
                                <SongArtworkImage song={dragInfo.item} source={data.requestedSongArtwork === 'song_cover' ? 'cover' : 'avatar'} />
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
                        <button onMouseDown={e => e.stopPropagation()} onClick={onOpenAppearance} className="text-white/50 hover:text-white transition-colors cursor-pointer text-lg" title="在控制面板打开外观设置">🎨</button>

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

                        <div className="flex items-center relative h-6 flex-1 justify-end min-w-0">
                            <div
                                className={`absolute right-0 text-xs font-medium max-w-[150px] truncate pointer-events-none transition-all duration-150 ${isElectron && titleBarActionsVisible ? '-translate-x-[118px] opacity-50' : ''} ${getStatusAnimation(data.status)}`}
                                style={{ color: !isConnected ? theme.subTextColor : getStatusColor(data.status) }}
                            >
                                {!isConnected ? '等待后端...' : (data.status || '点歌就绪')}
                            </div>

                            {isElectron && (
                                <div
                                    onMouseEnter={() => setTitleBarActionsOpen(true)}
                                    onMouseLeave={() => setTitleBarActionsOpen(false)}
                                    className={`no-drag absolute right-0 top-1/2 -translate-y-1/2 h-8 overflow-hidden z-20 transition-[width] duration-150 ease-out ${titleBarActionsVisible ? 'w-[116px]' : 'w-8'}`}
                                >
                                    <div className={`ml-auto flex h-full w-[112px] items-center justify-end gap-2 transition-all duration-150 ${titleBarActionsVisible ? 'translate-x-0 opacity-100' : 'translate-x-2 opacity-0 pointer-events-none'}`}>
                                        <button onMouseDown={e => e.stopPropagation()} onClick={onToggleAdmin} className="no-drag text-white/60 hover:text-white transition-colors cursor-pointer text-sm" title="控制面板">⚙️</button>
                                        <button onMouseDown={e => e.stopPropagation()} onClick={onOpenAppearance} className="no-drag text-white/60 hover:text-white transition-colors cursor-pointer text-sm" title="在控制面板打开外观设置">🎨</button>
                                        <button onMouseDown={e => e.stopPropagation()} onClick={handleWindowMinimize} className="no-drag flex items-center justify-center w-5 h-5 rounded-full transition-colors text-white/60 hover:text-white hover:bg-white/20 text-xs font-bold" title="最小化">−</button>
                                        <button onMouseDown={e => e.stopPropagation()} onClick={handleWindowClose} className="no-drag flex items-center justify-center w-5 h-5 rounded-full transition-colors text-white/60 hover:text-red-400 hover:bg-red-500/20 text-xs" title="关闭本窗口">✖</button>
                                    </div>
                                </div>
                            )}
                        </div>
                    </div>
                )}

                <div className="flex-1 flex flex-col p-4 overflow-hidden z-10 gap-4 custom-scrollbar relative">
                    {data.current ? (
                        <div
                            className={`${isElectron && data.currentIsRequested ? 'no-drag cursor-move' : ''} current-zone glass-card rounded-xl p-4 flex items-center gap-4 relative overflow-hidden shrink-0 transition-all duration-300 ${data.currentIsRequested ? 'ring-1 ring-green-400/30 shadow-[0_0_24px_rgba(74,222,128,0.18)]' : 'opacity-75 border-sky-300/20 bg-sky-950/20 shadow-[0_0_22px_rgba(125,211,252,0.12)]'} ${dragInfo?.type === 'current' ? 'opacity-30' : ''} ${actionLock ? 'pointer-events-none' : ''}`}
                            style={{ touchAction: 'none' }}
                            onPointerDown={isElectron && data.currentIsRequested && !actionLock ? (e) => handlePointerDown(e, 'current', -1, data.current as SongInfo) : undefined}
                        >
                            <div className={`absolute inset-0 pointer-events-none ${data.currentIsRequested ? 'bg-gradient-to-r from-green-500/10 via-transparent to-cyan-500/5' : 'bg-gradient-to-r from-sky-400/10 via-sky-950/5 to-transparent'}`}></div>
                            <div className="absolute right-[-10px] top-[-10px] opacity-5 text-7xl select-none pointer-events-none">{data.currentIsRequested ? '✨' : '🎵'}</div>
                            {data.currentIsRequested ? (
                                <div className={`w-12 h-12 ${data.requestedSongArtwork === 'song_cover' ? 'rounded-lg' : 'rounded-full'} overflow-hidden border-[3px] ${playing ? (data.requestedSongArtwork === 'song_cover' ? 'border-green-400/60 shadow-[0_0_15px_rgba(74,222,128,0.25)]' : getGuardStyle(data.current.GuardLevel).border || 'border-green-400/60 shadow-[0_0_15px_rgba(74,222,128,0.2)]') : 'border-yellow-400/60 shadow-[0_0_15px_rgba(250,204,21,0.2)]'} bg-slate-800 flex items-center justify-center shrink-0 relative pointer-events-none`}>
                                    <SongArtworkImage song={data.current} source={data.requestedSongArtwork === 'song_cover' ? 'cover' : 'avatar'} className={!playing ? 'grayscale opacity-80' : ''} />
                                </div>
                            ) : (
                                <div className="w-12 h-12 rounded-lg overflow-hidden border-[3px] border-sky-300/35 bg-sky-950/60 shadow-[0_0_14px_rgba(125,211,252,0.16)] flex items-center justify-center text-sky-200 shrink-0 relative pointer-events-none">
                                    <SongArtworkImage song={data.current} source="cover" />
                                </div>
                            )}
                            <div className="flex flex-col min-w-0 pointer-events-none">
                                {!playing ? (
                                    <div className="text-yellow-400 text-[10px] font-bold mb-1 tracking-wider flex items-center gap-1.5"><span className="w-1.5 h-1.5 bg-yellow-400 rounded-full"></span> 自动播放已暂停</div>
                                ) : data.currentIsRequested ? (
                                    <div className="text-green-400 text-[10px] font-bold mb-1 tracking-wider flex items-center gap-1.5"><span className="w-1.5 h-1.5 bg-green-400 rounded-full animate-pulse shadow-[0_0_8px_rgba(74,222,128,0.9)]"></span> 点歌播放中</div>
                                ) : data.playerPausedAfterRequests ? (
                                    <div className="text-amber-400/80 text-[10px] font-bold mb-1 tracking-wider flex items-center gap-1.5"><span className="w-1.5 h-1.5 bg-amber-400/80 rounded-full"></span> 点歌播完 · 播放器已暂停</div>
                                ) : (
                                    <div className="text-sky-300 text-[10px] font-bold mb-1 tracking-wider flex items-center gap-1.5"><span className="w-1.5 h-1.5 bg-sky-300 rounded-full animate-pulse shadow-[0_0_8px_rgba(125,211,252,0.9)]"></span> 主播歌单正在播放</div>
                                )}
                                <div className="text-[15px] font-bold truncate drop-shadow-md" style={{ color: theme.textColor }}>{data.current.SongName}</div>
                                <div className="text-xs truncate mt-0.5" style={{ color: theme.subTextColor }}>{data.current.ArtistName}</div>
                                {data.currentIsRequested && (
                                    <div className="text-[11px] mt-1 flex items-center gap-1.5" style={{ color: theme.subTextColor }}>
                                        <>
                                            <span className="truncate">由 <span style={{ color: theme.titleColor, opacity: 0.9 }}>{data.current.OrderedBy}</span> 点播</span>
                                            {getGuardStyle(data.current.GuardLevel).label && <span className={`text-[9px] px-1 rounded-sm font-bold tracking-wider leading-none py-0.5 shadow-sm ${getGuardStyle(data.current.GuardLevel).tag}`}>{getGuardStyle(data.current.GuardLevel).label}</span>}
                                        </>
                                    </div>
                                )}
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
                                            <div className={`w-8 h-8 ${data.requestedSongArtwork === 'song_cover' ? 'rounded-md' : 'rounded-full'} overflow-hidden shrink-0 bg-black/30 border-2 ${data.requestedSongArtwork === 'song_cover' ? 'border-green-400/30' : (itemGuardStyle.label ? itemGuardStyle.border : 'border-white/10')} flex items-center justify-center pointer-events-none`}>
                                                <SongArtworkImage song={song} source={data.requestedSongArtwork === 'song_cover' ? 'cover' : 'avatar'} />
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

            </div>
        </div>
    );
};

// ==========================================
// 4. 核心组件: 后台管理控制面板
// ==========================================

const AdminWidget: React.FC = () => {
    const [config, setConfig] = useState<any>(null);
    const [activeTab, setActiveTab] = useState<string>(() => (
        new URLSearchParams(window.location.search).get('tab') === 'appearance'
            ? 'appearance'
            : 'settings'
    ));
    const [supportMenuOpen, setSupportMenuOpen] = useState(false);

    const [updateInfo, setUpdateInfo] = useState<UpdateInfo>({ checking: false, info: null });
    const [downloadProgress, setDownloadProgress] = useState<number | null>(null);
    const [updateDownloadStatus, setUpdateDownloadStatus] = useState<AppUpdateDownloadStatus | null>(null);
    const updateStatusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const [qrState, setQrState] = useState<QrState>({ loading: false, base64: '', message: '' });
    const [roomIdInput, setRoomIdInput] = useState<string>('');
    const [sysLogs, setSysLogs] = useState<SysLog[]>([]);
    const logsEndRef = useRef<HTMLDivElement>(null);

    // ⭐ 新增: 自动滚动日志锁定与日志容器引用
    const [autoScroll, setAutoScroll] = useState<boolean>(true);
    const logContainerRef = useRef<HTMLDivElement>(null);

    const [hasBiliLoopIssue, setHasBiliLoopIssue] = useState<boolean>(false);

    const [superUserInput, setSuperUserInput] = useState<string>('');
    const [debugInput, setDebugInput] = useState<string>('');

    const [adminToast, setAdminToast] = useState<string>('');
    const [connectorStatuses, setConnectorStatuses] = useState<
        Partial<Record<NativeConnectorId, ConnectorStatus>>
    >({});
    const [connectorChecking, setConnectorChecking] = useState(false);
    const [connectorUpdating, setConnectorUpdating] = useState<
        NativeConnectorId | null
    >(null);
    const [connectorStatusError, setConnectorStatusError] = useState('');
    const [feedbackForm, setFeedbackForm] = useState({
        category: 'bug',
        priority: 'normal',
        title: '',
        description: '',
        contact: ''
    });
    const [feedbackDiagnostics, setFeedbackDiagnostics] = useState<any>(null);
    const [feedbackIncludeDiagnostics, setFeedbackIncludeDiagnostics] = useState(true);
    const [feedbackIncludeLogs, setFeedbackIncludeLogs] = useState(false);
    const [feedbackLoading, setFeedbackLoading] = useState(false);
    const [feedbackSubmitting, setFeedbackSubmitting] = useState(false);
    const [feedbackResult, setFeedbackResult] = useState<any>(null);
    const [feedbackHistory, setFeedbackHistory] = useState<LocalFeedbackHistoryItem[]>(() => {
        try {
            return parseFeedbackHistory(
                localStorage.getItem(FEEDBACK_HISTORY_STORAGE_KEY)
            );
        } catch {
            return [];
        }
    });
    const [feedbackHistoryRefreshing, setFeedbackHistoryRefreshing] = useState(false);
    const feedbackHistoryRef = useRef(feedbackHistory);
    const feedbackRefreshInFlightRef = useRef(false);
    const activeTabRef = useRef<string>(activeTab);
    const [overlayMods, setOverlayMods] = useState<OverlayModState | null>(null);
    const [overlayUrl, setOverlayUrl] = useState(
        'https://app.enkianss.us/mods/v1/retro-cmd/manifest.json'
    );
    const [overlayBusy, setOverlayBusy] = useState(false);
    const [overlayDropActive, setOverlayDropActive] = useState(false);
    const [overlayPreviewNonce, setOverlayPreviewNonce] = useState(0);
    const [overlayPreviewBackground, setOverlayPreviewBackground] = useState<'checker' | 'dark' | 'light'>('checker');
    const overlayFileInputRef = useRef<HTMLInputElement>(null);
    const appearanceSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const overlaySettingsSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const pendingOverlaySettingsRef = useRef<{
        id: string;
        values: Record<string, OverlaySettingValue>;
    } | null>(null);
    const roomSetupRef = useRef<HTMLDivElement>(null);
    const modUiSetupRef = useRef<HTMLElement>(null);
    const playerSetupRef = useRef<HTMLDivElement>(null);
    const permissionSetupRef = useRef<HTMLDivElement>(null);
    const firstRunGuidePending = (() => {
        try {
            return localStorage.getItem('awoo-admin-onboarding-v1') !== 'completed';
        } catch {
            return true;
        }
    })();
    const [onboardingActive, setOnboardingActive] = useState(firstRunGuidePending);
    const [onboardingOpen, setOnboardingOpen] = useState(firstRunGuidePending);
    const [onboardingStep, setOnboardingStep] = useState(0);
    const [pendingOnboardingTarget, setPendingOnboardingTarget] = useState<'room' | 'mod-ui' | 'player' | 'permission' | null>(null);

    useEffect(() => {
        return electronAPI?.onAdminNavigate(tab => {
            if (tab === 'appearance') setActiveTab('appearance');
        });
    }, []);

    const showAdminToast = useCallback((msg: string) => {
        setAdminToast(msg);
        setTimeout(() => setAdminToast(''), 3000);
    }, []);

    const persistFeedbackHistory = useCallback((items: LocalFeedbackHistoryItem[]) => {
        feedbackHistoryRef.current = items;
        setFeedbackHistory(items);
        try {
            localStorage.setItem(
                FEEDBACK_HISTORY_STORAGE_KEY,
                serializeFeedbackHistory(items)
            );
        } catch {
            // 本地存储不可用时，当前窗口内仍保留历史记录。
        }
    }, []);

    const refreshFeedbackHistory = useCallback(async (announce = false) => {
        if (feedbackRefreshInFlightRef.current) return;
        const ids = feedbackHistoryRef.current.map(item => item.id);
        if (ids.length === 0) {
            if (announce) showAdminToast('还没有本机提交过的反馈');
            return;
        }

        feedbackRefreshInFlightRef.current = true;
        setFeedbackHistoryRefreshing(true);
        try {
            const results = await Promise.all(ids.map(async id => {
                try {
                    const response = await fetch(
                        `http://127.0.0.1:5555/api/feedback/status?id=${encodeURIComponent(id)}`,
                        { cache: 'no-store' }
                    );
                    const result = await response.json();
                    if (!response.ok || !result.success || !result.feedback) {
                        throw new Error(result.message || '查询失败');
                    }
                    return result.feedback as PublicFeedbackStatus;
                } catch {
                    return null;
                }
            }));

            let next = feedbackHistoryRef.current;
            let successCount = 0;
            const checkedAt = new Date().toISOString();
            for (const result of results) {
                if (!result) continue;
                successCount += 1;
                next = mergeFeedbackStatus(next, result.id, result, checkedAt);
            }
            if (successCount > 0) persistFeedbackHistory(next);
            if (announce) {
                showAdminToast(
                    successCount === ids.length
                        ? '✅ 反馈处理进度已刷新'
                        : successCount > 0
                            ? `⚠️ 已刷新 ${successCount}/${ids.length} 条反馈`
                            : '❌ 暂时无法查询反馈进度'
                );
            }
        } finally {
            feedbackRefreshInFlightRef.current = false;
            setFeedbackHistoryRefreshing(false);
        }
    }, [persistFeedbackHistory, showAdminToast]);

    const markFeedbackHistoryItemRead = useCallback((id: string) => {
        const next = markFeedbackReplyRead(feedbackHistoryRef.current, id);
        persistFeedbackHistory(next);
    }, [persistFeedbackHistory]);

    const finishOnboarding = useCallback(() => {
        try {
            localStorage.setItem('awoo-admin-onboarding-v1', 'completed');
        } catch {
            // 本地存储不可用时仍允许用户关闭引导。
        }
        setOnboardingOpen(false);
        setOnboardingActive(false);
    }, []);

    const restartOnboarding = useCallback(() => {
        setOnboardingStep(0);
        setOnboardingActive(true);
        setOnboardingOpen(true);
    }, []);

    const openOnboardingDestination = useCallback((
        tab: 'login' | 'status' | 'appearance' | 'settings',
        target: 'room' | 'mod-ui' | 'player' | 'permission' | null,
        advance: boolean
    ) => {
        setActiveTab(tab);
        setPendingOnboardingTarget(target);
        setOnboardingOpen(false);
        setOnboardingActive(true);
        if (advance) {
            setOnboardingStep(previous => Math.min(previous + 1, 3));
        }
    }, []);

    useEffect(() => {
        if (!pendingOnboardingTarget) return;
        const timer = setTimeout(() => {
            const target = pendingOnboardingTarget === 'room'
                ? roomSetupRef.current
                : pendingOnboardingTarget === 'mod-ui'
                    ? modUiSetupRef.current
                    : pendingOnboardingTarget === 'player'
                        ? playerSetupRef.current
                        : permissionSetupRef.current;
            target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
            setPendingOnboardingTarget(null);
        }, 120);
        return () => clearTimeout(timer);
    }, [activeTab, pendingOnboardingTarget]);

    const updateControlTheme = useCallback((nextTheme: Theme) => {
        if (!config) return;
        const nextWidgetStyle = {
            ...(config.widgetStyle || {}),
            theme: nextTheme,
            timestamp: Date.now()
        };
        setConfig((previous: any) => previous ? ({
            ...previous,
            widgetStyle: nextWidgetStyle
        }) : previous);
        if (appearanceSaveTimerRef.current) {
            clearTimeout(appearanceSaveTimerRef.current);
        }
        appearanceSaveTimerRef.current = setTimeout(() => {
            fetch('http://127.0.0.1:5555/api/config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ widgetStyle: nextWidgetStyle })
            }).catch(() => {
                showAdminToast('❌ 主播控制 UI 外观保存失败');
            });
        }, 300);
    }, [config, showAdminToast]);

    useEffect(() => () => {
        if (appearanceSaveTimerRef.current) {
            clearTimeout(appearanceSaveTimerRef.current);
        }
        if (overlaySettingsSaveTimerRef.current) {
            clearTimeout(overlaySettingsSaveTimerRef.current);
        }
        if (updateStatusTimerRef.current) {
            clearTimeout(updateStatusTimerRef.current);
        }
    }, []);

    const loadOverlayMods = useCallback(async () => {
        try {
            const response = await fetch('http://127.0.0.1:5555/api/overlays');
            const result = await response.json();
            if (!response.ok || !result.success) {
                throw new Error(result.message || '读取 Mod UI 列表失败');
            }
            setOverlayMods(result);
        } catch (error: unknown) {
            console.warn(
                error instanceof Error ? error.message : '读取 Mod UI 列表失败'
            );
        }
    }, []);

    const updateOverlaySetting = useCallback((
        id: string,
        key: string,
        value: OverlaySettingValue
    ) => {
        setOverlayMods(previous => {
            if (!previous) return previous;
            const updateRecord = (record: OverlayModRecord) => record.id === id
                ? { ...record, values: { ...(record.values || {}), [key]: value } }
                : record;
            return {
                ...previous,
                active: updateRecord(previous.active),
                overlays: previous.overlays.map(updateRecord)
            };
        });

        const pending = pendingOverlaySettingsRef.current;
        pendingOverlaySettingsRef.current = {
            id,
            values: pending?.id === id
                ? { ...pending.values, [key]: value }
                : { [key]: value }
        };
        if (overlaySettingsSaveTimerRef.current) {
            clearTimeout(overlaySettingsSaveTimerRef.current);
        }
        overlaySettingsSaveTimerRef.current = setTimeout(async () => {
            const next = pendingOverlaySettingsRef.current;
            pendingOverlaySettingsRef.current = null;
            if (!next) return;
            try {
                const response = await fetch('http://127.0.0.1:5555/api/overlays/settings', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(next)
                });
                const result = await response.json();
                if (!response.ok || !result.success) {
                    throw new Error(result.message || '保存 Mod UI 参数失败');
                }
                setOverlayMods(result);
            } catch (error: unknown) {
                showAdminToast(`❌ ${error instanceof Error ? error.message : '保存 Mod UI 参数失败'}`);
                void loadOverlayMods();
            }
        }, 220);
    }, [loadOverlayMods, showAdminToast]);

    const resetOverlaySettings = useCallback(async (id: string) => {
        if (overlaySettingsSaveTimerRef.current) {
            clearTimeout(overlaySettingsSaveTimerRef.current);
        }
        pendingOverlaySettingsRef.current = null;
        try {
            const response = await fetch('http://127.0.0.1:5555/api/overlays/settings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id, reset: true })
            });
            const result = await response.json();
            if (!response.ok || !result.success) {
                throw new Error(result.message || '恢复 Mod UI 默认参数失败');
            }
            setOverlayMods(result);
            showAdminToast(`✅ 已恢复 ${result.overlays?.find((item: OverlayModRecord) => item.id === id)?.name || 'Mod UI'} 的默认参数`);
        } catch (error: unknown) {
            showAdminToast(`❌ ${error instanceof Error ? error.message : '恢复 Mod UI 默认参数失败'}`);
        }
    }, [showAdminToast]);

    const loadConnectorStatuses = useCallback(async (forceRefresh = false) => {
        setConnectorChecking(true);
        setConnectorStatusError('');
        try {
            const suffix = forceRefresh ? '?refresh=1' : '';
            const response = await fetch(
                `http://127.0.0.1:5555/api/connectors/status${suffix}`
            );
            const result = await response.json();
            if (!result.success) {
                throw new Error(result.message || '连接器更新服务不可用');
            }
            const nextStatuses: Partial<
                Record<NativeConnectorId, ConnectorStatus>
            > = {};
            for (const status of result.connectors || []) {
                nextStatuses[status.id as NativeConnectorId] = status;
            }
            setConnectorStatuses(nextStatuses);
            if (forceRefresh) {
                const statuses = (result.connectors || []) as ConnectorStatus[];
                const count = statuses.filter(
                    (status: ConnectorStatus) => status.updateAvailable
                ).length;
                const failureCount = statuses.filter(
                    status => status.error || !status.compatible
                ).length;
                showAdminToast(
                    failureCount > 0
                        ? `⚠️ ${failureCount} 个连接器无法完成版本检查或与本体不兼容`
                        : count > 0
                        ? `发现 ${count} 个可安装或可更新的连接器`
                        : '✅ 四个播放器连接器均为最新'
                );
            }
        } catch (error: unknown) {
            const message = error instanceof Error
                ? error.message
                : '检查连接器更新失败';
            setConnectorStatusError(message);
            if (forceRefresh) {
                showAdminToast(`❌ ${message}`);
            }
        } finally {
            setConnectorChecking(false);
        }
    }, [showAdminToast]);

    useEffect(() => { activeTabRef.current = activeTab; }, [activeTab]);

    useEffect(() => {
        void refreshFeedbackHistory(false);
        const timer = setInterval(
            () => void refreshFeedbackHistory(false),
            120_000
        );
        const refreshWhenVisible = () => {
            if (document.visibilityState === 'visible') {
                void refreshFeedbackHistory(false);
            }
        };
        window.addEventListener('focus', refreshWhenVisible);
        document.addEventListener('visibilitychange', refreshWhenVisible);
        return () => {
            clearInterval(timer);
            window.removeEventListener('focus', refreshWhenVisible);
            document.removeEventListener('visibilitychange', refreshWhenVisible);
        };
    }, [refreshFeedbackHistory]);

    useEffect(() => {
        setSupportMenuOpen(['faq', 'feedback', 'logs', 'debug'].includes(activeTab));
    }, [activeTab]);

    useEffect(() => {
        if (activeTab !== 'settings') return;
        void loadConnectorStatuses(false);
        const timer = setInterval(
            () => void loadConnectorStatuses(false),
            10_000
        );
        return () => clearInterval(timer);
    }, [activeTab, loadConnectorStatuses]);

    useEffect(() => {
        if (activeTab !== 'appearance') return;
        void loadOverlayMods();
        const timer = setInterval(() => void loadOverlayMods(), 5000);
        return () => clearInterval(timer);
    }, [activeTab, loadOverlayMods]);

    const installOverlayFromUrl = useCallback(async () => {
        const url = overlayUrl.trim();
        if (!url) {
            showAdminToast('❌ 请输入 GitHub 仓库或发布清单网址');
            return;
        }
        setOverlayBusy(true);
        try {
            const response = await fetch(
                'http://127.0.0.1:5555/api/overlays/install-url',
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ url })
                }
            );
            const result = await response.json();
            if (!response.ok || !result.success) {
                throw new Error(result.message || '安装 Mod UI 失败');
            }
            setOverlayMods(result);
            showAdminToast(`✅ 已安装并启用 ${result.active.name} ${result.active.version}`);
        } catch (error: unknown) {
            showAdminToast(
                `❌ ${error instanceof Error ? error.message : '安装 Mod UI 失败'}`
            );
        } finally {
            setOverlayBusy(false);
        }
    }, [overlayUrl, showAdminToast]);

    const openSkinMarketplace = useCallback(async () => {
        try {
            if (electronAPI?.openExternal) {
                await electronAPI.openExternal(SKIN_MARKETPLACE_URL);
            } else {
                window.open(SKIN_MARKETPLACE_URL, '_blank', 'noopener,noreferrer');
            }
        } catch (error: unknown) {
            showAdminToast(`❌ ${error instanceof Error ? error.message : '无法打开嗷呜皮肤站'}`);
        }
    }, [showAdminToast]);

    const installOverlayZip = useCallback(async (file: File) => {
        if (!/\.zip$/i.test(file.name)) {
            showAdminToast('❌ 请选择 .zip 格式的 Mod UI 包');
            return;
        }
        if (file.size > 20 * 1024 * 1024) {
            showAdminToast('❌ Mod UI ZIP 不能超过 20 MiB');
            return;
        }
        setOverlayBusy(true);
        try {
            const response = await fetch(
                'http://127.0.0.1:5555/api/overlays/install-zip',
                {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/zip',
                        'X-Awoo-File-Name': encodeURIComponent(file.name)
                    },
                    body: file
                }
            );
            const result = await response.json();
            if (!response.ok || !result.success) {
                throw new Error(result.message || '安装 ZIP 失败');
            }
            setOverlayMods(result);
            showAdminToast(`✅ 已安装并启用 ${result.active.name} ${result.active.version}`);
        } catch (error: unknown) {
            showAdminToast(
                `❌ ${error instanceof Error ? error.message : '安装 ZIP 失败'}`
            );
        } finally {
            setOverlayBusy(false);
            if (overlayFileInputRef.current) {
                overlayFileInputRef.current.value = '';
            }
        }
    }, [showAdminToast]);

    const activateOverlay = useCallback(async (id: string) => {
        setOverlayBusy(true);
        try {
            const response = await fetch(
                'http://127.0.0.1:5555/api/overlays/activate',
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ id })
                }
            );
            const result = await response.json();
            if (!response.ok || !result.success) {
                throw new Error(result.message || '切换 Mod UI 失败');
            }
            setOverlayMods(result);
            showAdminToast(`🎨 已切换到 ${result.active.name}`);
        } catch (error: unknown) {
            showAdminToast(
                `❌ ${error instanceof Error ? error.message : '切换 Mod UI 失败'}`
            );
        } finally {
            setOverlayBusy(false);
        }
    }, [showAdminToast]);

    const removeOverlay = useCallback(async (id: string) => {
        setOverlayBusy(true);
        try {
            const response = await fetch(
                'http://127.0.0.1:5555/api/overlays/remove',
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ id })
                }
            );
            const result = await response.json();
            if (!response.ok || !result.success) {
                throw new Error(result.message || '删除 Mod UI 失败');
            }
            setOverlayMods(result);
            showAdminToast('🗑️ 已删除 Mod UI；若它正在使用，已切回内置 UI');
        } catch (error: unknown) {
            showAdminToast(
                `❌ ${error instanceof Error ? error.message : '删除 Mod UI 失败'}`
            );
        } finally {
            setOverlayBusy(false);
        }
    }, [showAdminToast]);

    const enableOverlayApi = useCallback(async () => {
        if (!config?.config) return;
        const nextSysConfig = {
            ...config.config,
            ExternalHttpEnabled: true,
            ExternalWebSocketEnabled: true
        };
        try {
            const response = await fetch('http://127.0.0.1:5555/api/config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sysConfig: nextSysConfig })
            });
            if (!response.ok) throw new Error('启动只读接口失败');
            setConfig((previous: any) => previous ? ({
                ...previous,
                config: nextSysConfig,
                externalApi: {
                    ...(previous.externalApi || {}),
                    running: true,
                    httpEnabled: true,
                    webSocketEnabled: true
                }
            }) : previous);
            showAdminToast('✅ Mod UI 只读接口已启动');
        } catch (error: unknown) {
            showAdminToast(
                `❌ ${error instanceof Error ? error.message : '启动只读接口失败'}`
            );
        }
    }, [config, showAdminToast]);

    const isInitialConfigLoad = useRef(true);
    const lastConfigString = useRef('');

    useEffect(() => {
        const fetchConfig = async () => {
            try {
                const res = await fetch('http://127.0.0.1:5555/api/config');
                const json = await res.json();

                setConfig((prev: any) => {
                    if (!prev) return json;
                    return {
                        ...json,
                        config: activeTabRef.current === 'settings' || activeTabRef.current === 'appearance'
                            ? prev.config
                            : json.config,
                        widgetStyle: activeTabRef.current === 'appearance'
                            ? prev.widgetStyle
                            : json.widgetStyle
                    };
                });

                setRoomIdInput(prev => {
                    if (prev === '' && json.roomId !== 0 && json.roomId !== json.uid) return json.roomId.toString();
                    return prev;
                });

            } catch { }
        };
        fetchConfig();
        const timer = setInterval(fetchConfig, 2000);
        return () => clearInterval(timer);
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
            fetch('http://127.0.0.1:5555/api/config', {
                method: 'POST',
                headers: {'Content-Type':'application/json'},
                body: JSON.stringify({ sysConfig: config.config })
            }).then(res => {
                if (res.ok) showAdminToast("✅ 设置已自动保存！");
            }).catch(() => {});
        }, 800);

        return () => clearTimeout(timer);
    }, [config, showAdminToast]);

    useEffect(() => {
        if (activeTab !== 'login') return;
        const fetchQr = async () => {
            try {
                const res = await fetch('http://127.0.0.1:5555/api/bili/qrstatus');
                const json = await res.json();
                setQrState({ loading: false, base64: json.qrBase64, message: json.status });
                if (json.isLogin) {
                    setConfig((prev: any) => prev ? ({
                        ...prev,
                        biliLogin: true,
                        uid: json.uid,
                        currentUser: json.currentUser
                    }) : prev);
                }
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
                const res = await fetch('http://127.0.0.1:5555/api/logs');
                const json = await res.json();
                setSysLogs(json);
            } catch {}
        };
        fetchLogs();
        const intervalTime = activeTab === 'logs' ? 1000 : 2500;
        const timer = setInterval(fetchLogs, intervalTime);
        return () => clearInterval(timer);
    }, [activeTab]);

    // 实时分析 B站弹幕连接是否出现频繁重连。
    useEffect(() => {
        if (sysLogs.length === 0) return;

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
            const res = await fetch('http://127.0.0.1:5555/api/room', {
                method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ roomId: rid })
            });
            const json = await res.json();
            if(json.success) showAdminToast("✅ 连接请求成功！请查看运行日志确认。");
            else showAdminToast("❌ 连接失败，请检查房间号或网络连接。");
        } catch { showAdminToast("❌ 请求后端失败"); }
    };

    const waitForPlayerConnection = async (
        timeoutMs = 4500
    ): Promise<boolean> => {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            await new Promise(resolve => setTimeout(resolve, 350));
            try {
                const response = await fetch(
                    'http://127.0.0.1:5555/api/config'
                );
                const latest = await response.json();
                if (latest.playerConnected === true) {
                    setConfig((previous: any) => previous ? ({
                        ...previous,
                        playerConnected: true,
                        cdpConnected: true,
                        playerConnecting: false,
                        playerSnapshot: latest.playerSnapshot
                    }) : previous);
                    return true;
                }
            } catch {
                // The normal configuration poll will keep retrying.
            }
        }
        return false;
    };

    const handleReconnectPlayer = async () => {
        setConfig((prev: any) => prev ? ({
            ...prev,
            playerConnected: false,
            cdpConnected: false,
            playerConnecting: true,
            playerSnapshot: null
        }) : prev);
        try {
            const res = await fetch('http://127.0.0.1:5555/api/sys/reconnect_player', { method: 'POST' });
            const json = await res.json();
            const connected = json.success === true
                || await waitForPlayerConnection();
            setConfig((prev: any) => prev ? ({
                ...prev,
                playerConnected: connected,
                cdpConnected: connected,
                playerConnecting: false
            }) : prev);
            if(connected) showAdminToast("✅ 播放器已自动连接！");
            else showAdminToast("⚠️ 暂未检测到所选播放器，后台会继续尝试连接。");
        } catch {
            setConfig((prev: any) => prev ? ({
                ...prev,
                playerConnected: false,
                cdpConnected: false,
                playerConnecting: false
            }) : prev);
            showAdminToast("❌ 发送指令失败");
        }
    };

    const handleConnectorUpdate = async (
        connectorId: NativeConnectorId
    ) => {
        if (connectorUpdating) return;
        const status = connectorStatuses[connectorId];
        if (!status?.updateAvailable) {
            showAdminToast('当前连接器没有可安装的更新。');
            return;
        }

        if (status.manualUpdateAvailable) {
            const confirmed = window.confirm(
                `${status.name}连接器将从 v${status.currentVersion || '未安装'} `
                + `更新到 v${status.latestVersion || '未知'}。\n\n`
                + '该版本属于不同的播放器兼容分支，不会自动安装。\n'
                + `目标连接器支持的播放器版本：${status.supportedPlayerVersion || '清单未注明'}\n\n`
                + '请确认你正在使用对应的播放器版本。是否继续手动更新？'
            );
            if (!confirmed) return;
        }

        const playerTypeByConnector: Record<NativeConnectorId, string> = {
            netease: 'NCM',
            kugou: 'Kugou',
            qqmusic: 'QQMusic',
            folia: 'Folia'
        };
        const updatesSelectedPlayer =
            config?.config?.PlayerType === playerTypeByConnector[connectorId];
        setConnectorUpdating(connectorId);
        if (updatesSelectedPlayer) {
            setConfig((previous: any) => previous ? ({
                ...previous,
                playerConnecting: true
            }) : previous);
        }

        try {
            const response = await fetch(
                'http://127.0.0.1:5555/api/connectors/update',
                {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({ connectorId })
                }
            );
            const result = await response.json();
            if (!result.success) {
                throw new Error(result.message || '连接器更新失败');
            }
            if (result.status) {
                setConnectorStatuses(previous => ({
                    ...previous,
                    [connectorId]: result.status
                }));
            }

            let selectedConnected = result.reconnected === true;
            if (updatesSelectedPlayer) {
                if (
                    !selectedConnected
                    && shouldWaitForConnectorPlayer(connectorId, result)
                ) {
                    selectedConnected = await waitForPlayerConnection();
                }
                setConfig((previous: any) => previous ? ({
                    ...previous,
                    playerConnected: selectedConnected,
                    cdpConnected: selectedConnected,
                    playerConnecting: false
                }) : previous);
            }
            await loadConnectorStatuses(false);
            showAdminToast(
                updatesSelectedPlayer && !selectedConnected
                    ? connectorId === 'netease'
                        ? buildNeteaseConnectorSuccessMessage('update', result)
                        : '⚠️ 连接器已更新，后台正在等待播放器连接。'
                    : `✅ ${result.message || '连接器更新完成'}`
            );
        } catch (error: unknown) {
            const message = error instanceof Error
                ? error.message
                : '连接器更新失败';
            showAdminToast(`❌ ${message}`);
            if (updatesSelectedPlayer) {
                setConfig((previous: any) => previous ? ({
                    ...previous,
                    playerConnecting: false
                }) : previous);
            }
        } finally {
            setConnectorUpdating(null);
        }
    };

    const handleConnectorReinstall = async (
        connectorId: NativeConnectorId
    ) => {
        if (connectorUpdating) return;
        const playerTypeByConnector: Record<NativeConnectorId, string> = {
            netease: 'NCM',
            kugou: 'Kugou',
            qqmusic: 'QQMusic',
            folia: 'Folia'
        };
        const reinstallsSelectedPlayer =
            config?.config?.PlayerType === playerTypeByConnector[connectorId];
        setConnectorUpdating(connectorId);
        if (reinstallsSelectedPlayer) {
            setConfig((previous: any) => previous ? ({
                ...previous,
                playerConnecting: true
            }) : previous);
        }

        try {
            const response = await fetch(
                'http://127.0.0.1:5555/api/connectors/reinstall',
                {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({ connectorId })
                }
            );
            const result = await response.json();
            if (!result.success) {
                throw new Error(result.message || '连接器重新安装失败');
            }

            if (result.status) {
                setConnectorStatuses(previous => ({
                    ...previous,
                    [connectorId]: result.status
                }));
            }
            let selectedConnected = result.reconnected === true;
            if (reinstallsSelectedPlayer) {
                if (
                    !selectedConnected
                    && shouldWaitForConnectorPlayer(connectorId, result)
                ) {
                    selectedConnected = await waitForPlayerConnection();
                }
                setConfig((previous: any) => previous ? ({
                    ...previous,
                    playerConnected: selectedConnected,
                    cdpConnected: selectedConnected,
                    playerConnecting: false
                }) : previous);
            }
            await loadConnectorStatuses(false);
            if (!reinstallsSelectedPlayer) {
                showAdminToast('✅ 连接器重新安装完成，正在切换播放器...');
                await handleSetPlayerType(
                    playerTypeByConnector[connectorId],
                    connectorId === 'netease'
                        && !shouldWaitForConnectorPlayer(connectorId, result)
                        ? {
                            waitForConnection: false,
                            disconnectedMessage: buildNeteaseConnectorSuccessMessage(
                                'reinstall',
                                result
                            )
                        }
                        : undefined
                );
            } else {
                showAdminToast(
                    selectedConnected
                        ? `✅ ${result.status?.name || '播放器'}连接器已重新安装并自动连接！`
                        : connectorId === 'netease'
                            ? buildNeteaseConnectorSuccessMessage(
                                'reinstall',
                                result
                            )
                            : '⚠️ 连接器已重新安装，后台正在等待播放器连接。'
                );
            }
        } catch (error: unknown) {
            const message = error instanceof Error
                ? error.message
                : '连接器重新安装失败';
            showAdminToast(`❌ ${message}`);
            if (reinstallsSelectedPlayer) {
                setConfig((previous: any) => previous ? ({
                    ...previous,
                    playerConnecting: false
                }) : previous);
            }
        } finally {
            setConnectorUpdating(null);
        }
    };

    const handleUpdateCheck = async () => {
        setUpdateInfo({ checking: true, info: null });
        try {
            const res = await fetch('http://127.0.0.1:5555/api/update/check');
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
        if (updateStatusTimerRef.current) {
            clearTimeout(updateStatusTimerRef.current);
            updateStatusTimerRef.current = null;
        }
        setDownloadProgress(0);
        setUpdateDownloadStatus({
            state: 'checking',
            progress: 0,
            version: updateInfo.info?.version || null,
            message: '正在确认更新版本',
            updatedAt: new Date().toISOString()
        });

        try {
            const response = await fetch(
                'http://127.0.0.1:5555/api/update/apply',
                { method: 'POST' }
            );
            const result = await response.json();
            if (!response.ok || !result.success) {
                throw new Error(result.message || '更新任务启动失败');
            }
            showAdminToast("正在后台下载更新，请稍候，程序将自动重启...");

            let consecutiveFailures = 0;
            const pollUpdateStatus = async (): Promise<void> => {
                try {
                    const statusResponse = await fetch(
                        'http://127.0.0.1:5555/api/update/status',
                        { cache: 'no-store' }
                    );
                    const statusResult = await statusResponse.json();
                    if (!statusResponse.ok || !statusResult.success) {
                        throw new Error(
                            statusResult.message || '无法读取更新进度'
                        );
                    }
                    consecutiveFailures = 0;
                    const status = statusResult.status as AppUpdateDownloadStatus;
                    setUpdateDownloadStatus(status);

                    if (status.state === 'error') {
                        setDownloadProgress(null);
                        setUpdateInfo({
                            checking: false,
                            info: { error: status.message || '更新失败' }
                        });
                        showAdminToast(`❌ ${status.message || '更新失败'}`);
                        return;
                    }
                    if (status.state === 'no-update') {
                        setDownloadProgress(null);
                        setUpdateInfo({
                            checking: false,
                            info: { hasUpdate: false }
                        });
                        showAdminToast('✅ 当前已经是最新版本');
                        return;
                    }

                    const numericProgress = Number(status.progress);
                    setDownloadProgress(
                        Number.isFinite(numericProgress)
                            ? Math.max(0, Math.min(100, numericProgress))
                            : 0
                    );
                    updateStatusTimerRef.current = setTimeout(
                        () => void pollUpdateStatus(),
                        450
                    );
                } catch (error: unknown) {
                    consecutiveFailures += 1;
                    if (consecutiveFailures < 5) {
                        updateStatusTimerRef.current = setTimeout(
                            () => void pollUpdateStatus(),
                            700
                        );
                        return;
                    }
                    const message = error instanceof Error
                        ? error.message
                        : '读取更新进度失败';
                    setDownloadProgress(null);
                    setUpdateInfo({
                        checking: false,
                        info: { error: message }
                    });
                    showAdminToast(`❌ ${message}`);
                }
            };
            void pollUpdateStatus();
        } catch (error: unknown) {
            setDownloadProgress(null);
            const message = error instanceof Error
                ? error.message
                : '更新请求失败，请检查网络连接';
            setUpdateInfo({ checking: false, info: { error: message } });
            showAdminToast(`❌ ${message}`);
        }
    };

    const startQrLogin = async () => {
        setQrState(prev => ({ ...prev, loading: true, base64: '' }));
        await fetch('http://127.0.0.1:5555/api/bili/qrstart', { method: 'POST' });
    };

    const loadFeedbackDiagnostics = useCallback(async (includeLogs = false) => {
        setFeedbackLoading(true);
        try {
            const response = await fetch(
                'http://127.0.0.1:5555/api/feedback/diagnostics'
                + (includeLogs ? '?logs=1' : '')
            );
            const result = await response.json();
            if (!response.ok || !result.success) {
                throw new Error(result.message || '诊断信息读取失败');
            }
            setFeedbackDiagnostics(result);
        } catch (error: unknown) {
            const message = error instanceof Error
                ? error.message
                : '诊断信息读取失败';
            showAdminToast(`❌ ${message}`);
        } finally {
            setFeedbackLoading(false);
        }
    }, [showAdminToast]);

    useEffect(() => {
        if (activeTab !== 'feedback') return;
        void loadFeedbackDiagnostics(feedbackIncludeLogs);
        void refreshFeedbackHistory(false);
    }, [
        activeTab,
        feedbackIncludeLogs,
        loadFeedbackDiagnostics,
        refreshFeedbackHistory
    ]);

    const handleFeedbackSubmit = async () => {
        if (feedbackSubmitting) return;
        if (feedbackForm.title.trim().length < 4) {
            showAdminToast('❌ 反馈标题至少需要 4 个字符');
            return;
        }
        if (feedbackForm.description.trim().length < 10) {
            showAdminToast('❌ 请至少用 10 个字符描述问题');
            return;
        }

        const submissionSummary = {
            title: feedbackForm.title,
            category: feedbackForm.category,
            priority: feedbackForm.priority
        };
        setFeedbackSubmitting(true);
        setFeedbackResult(null);
        try {
            const response = await fetch(
                'http://127.0.0.1:5555/api/feedback/submit',
                {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({
                        ...feedbackForm,
                        includeDiagnostics: feedbackIncludeDiagnostics,
                        includeLogs:
                            feedbackIncludeDiagnostics && feedbackIncludeLogs
                    })
                }
            );
            const result = await response.json();
            if (!response.ok || !result.success) {
                throw new Error(result.message || '提交失败');
            }
            setFeedbackResult(result);
            persistFeedbackHistory(recordFeedbackSubmission(
                feedbackHistoryRef.current,
                submissionSummary,
                result,
                new Date().toISOString()
            ));
            setFeedbackForm(previous => ({
                ...previous,
                title: '',
                description: ''
            }));
            showAdminToast(`✅ 已提交反馈 ${result.id}`);
        } catch (error: unknown) {
            const message = error instanceof Error
                ? error.message
                : '提交失败';
            showAdminToast(`❌ ${message}`);
        } finally {
            setFeedbackSubmitting(false);
        }
    };

    const logoutBili = async () => {
        if (!window.confirm('确定退出当前 B站账号吗？本地保存的登录凭据将被清除。')) return;
        try {
            const res = await fetch('http://127.0.0.1:5555/api/bili/logout', { method: 'POST' });
            const result = await res.json();
            if (!res.ok || !result.success) throw new Error('logout failed');
            setConfig((prev: any) => ({ ...prev, biliLogin: false, uid: 0, currentUser: null }));
            setQrState({ loading: false, base64: '', message: '已退出登录，可重新扫码绑定账号' });
            showAdminToast('✅ 已退出 B站账号并清除本地登录凭据');
        } catch {
            showAdminToast('❌ 退出登录失败，请检查后端连接');
        }
    };

    const toggleAccepting = async () => {
        try {
            await fetch('http://127.0.0.1:5555/api/state/toggle', { method: 'POST' });
            setConfig((prev: any) => ({...prev, accepting: !prev.accepting}));
        } catch(err) { console.error(err); }
    };

    const togglePlaying = async () => {
        try {
            await fetch('http://127.0.0.1:5555/api/state/toggle_play', { method: 'POST' });
            setConfig((prev: any) => ({...prev, playing: !prev.playing}));
        } catch(err) { console.error(err); }
    };

    const handleDebugInsert = async () => {
        if(!debugInput.trim()) return showAdminToast("❌ 请输入需要搜索并插入的歌曲名！");
        try {
            const res = await fetch('http://127.0.0.1:5555/api/debug/insert_next', {
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
            const res = await fetch('http://127.0.0.1:5555/api/debug/play_next', { method: 'POST' });
            const json = await res.json();
            if(json.success) showAdminToast(`✅ ${json.message || '切歌指令已成功发送！'}`);
            else showAdminToast(`❌ ${json.message || '切歌失败，播放器拒绝响应或未连接！'}`);
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

    const updateGiftRequestRequirement = (
        tier: GiftRequestTier,
        field: 'giftName' | 'giftId',
        value: string
    ) => {
        setConfig((prev: any) => ({
            ...prev,
            config: {
                ...prev.config,
                GiftRequestRequirements: {
                    ...(prev.config.GiftRequestRequirements || {}),
                    [tier]: {
                        ...(prev.config.GiftRequestRequirements?.[tier] || {
                            giftName: '',
                            giftId: ''
                        }),
                        [field]: value
                    }
                }
            }
        }));
    };

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

    const handleSetPlayerType = async (
        type: string,
        options?: {
            waitForConnection?: boolean;
            disconnectedMessage?: string;
        }
    ) => {
        if (!config?.config || config.config.PlayerType === type) return;
        const nextSysConfig = { ...config.config, PlayerType: type };
        lastConfigString.current = JSON.stringify(nextSysConfig);
        setConfig((prev: any) => ({
            ...prev,
            playerConnected: false,
            cdpConnected: false,
            playerConnecting: true,
            playerSnapshot: null,
            config: nextSysConfig
        }));
        showAdminToast("正在切换并自动连接播放器...");

        try {
            const res = await fetch('http://127.0.0.1:5555/api/config', {
                method: 'POST',
                headers: {'Content-Type':'application/json'},
                body: JSON.stringify({ sysConfig: nextSysConfig })
            });
            const json = await res.json();
            const connected = json.playerConnected === true
                || (options?.waitForConnection === false
                    ? false
                    : await waitForPlayerConnection());
            setConfig((prev: any) => prev ? ({
                ...prev,
                playerConnected: connected,
                cdpConnected: connected,
                playerConnecting: connected
                    ? false
                    : json.playerConnecting === true
            }) : prev);
            if (connected) showAdminToast("✅ 已切换并自动连接播放器！");
            else showAdminToast(
                options?.disconnectedMessage
                    || "⚠️ 已切换播放器，后台正在等待连接。"
            );
        } catch {
            setConfig((prev: any) => prev ? ({
                ...prev,
                playerConnected: false,
                cdpConnected: false,
                playerConnecting: false
            }) : prev);
            showAdminToast("❌ 切换播放器失败，请查看运行日志。");
        }
    };

    const permTypes = [
        { key: 'OrderPermission', label: '点歌权限' },
        { key: 'SkipPermission', label: '切歌权限' },
        { key: 'PriorityPermission', label: '置顶权限 (放到队列第一首)' },
        { key: 'CancelPermission', label: '撤回权限 (撤回自己点的最近一首)' },
        { key: 'ToggleAcceptPermission', label: '开关接单权限 (开启/关闭)' },
        { key: 'ForceControlPermission', label: '强控队列权限 (立即/插队/撤回他人)' },
    ];

    const playerOptions: Array<{
        type: string;
        name: string;
        method: string;
        detail: string;
        connectorId: NativeConnectorId;
    }> = [
        { type: 'NCM', name: '网易云音乐', method: '原生 IPC', detail: '不重启客户端，不需要调试端口', connectorId: 'netease' },
        { type: 'Kugou', name: '酷狗音乐', method: '窗口消息 + IPC', detail: '原生控制与安全下一首守卫', connectorId: 'kugou' },
        { type: 'QQMusic', name: 'QQ 音乐', method: '单实例命令 + 静音守卫', detail: '错误下一首静音、暂停后接管', connectorId: 'qqmusic' },
        { type: 'Folia', name: 'Folia', method: '独立 Stage 连接器', detail: 'HTTP + WebSocket；支持 ID 校验与封面', connectorId: 'folia' }
    ];
    const classicObsUrl = 'http://localhost:5555/';
    const externalApiPort = Number(
        config?.externalApi?.port || config?.config?.ExternalApiPort || 5556
    );
    const modObsUrl = `http://127.0.0.1:${externalApiPort}/overlay/`;
    const currentStatusSong = config?.current as SongInfo | null | undefined;
    const currentControlTheme: Theme = {
        ...defaultTheme,
        ...(config?.widgetStyle?.theme || {})
    };
    const activeOverlaySettings = overlayMods?.active?.settings || [];
    const activeOverlaySettingGroups = Array.from(
        activeOverlaySettings.reduce((groups, setting) => {
            const group = setting.group || '常规';
            const items = groups.get(group) || [];
            items.push(setting);
            groups.set(group, items);
            return groups;
        }, new Map<string, OverlaySettingDefinition[]>())
    );
    const overlayPreviewStyle: React.CSSProperties = overlayPreviewBackground === 'dark'
        ? { backgroundColor: '#111827' }
        : overlayPreviewBackground === 'light'
            ? { backgroundColor: '#eef3f8' }
            : {
                backgroundColor: '#20242d',
                backgroundImage: 'linear-gradient(45deg, #2c3340 25%, transparent 25%), linear-gradient(-45deg, #2c3340 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #2c3340 75%), linear-gradient(-45deg, transparent 75%, #2c3340 75%)',
                backgroundSize: '24px 24px',
                backgroundPosition: '0 0, 0 12px, 12px -12px, -12px 0'
            };
    const onboardingSteps = [
        {
            icon: '📱',
            kicker: '账号与权限',
            title: '扫码登录 B站账号',
            description: '游客模式也能普通点歌；扫码登录后，可以设置超级用户白名单和更细的观众权限。'
        },
        {
            icon: '🏠',
            kicker: '直播间连接',
            title: '连接你的直播间',
            description: '填写直播间网址末尾的数字房间号，让点歌机开始接收这间直播间的弹幕。'
        },
        {
            icon: '📺',
            kicker: '直播画面',
            title: '添加 OBS 浏览器捕捉',
            description: '复制固定的 Mod UI 地址到 OBS 或直播姬。以后切换 UI 模组时，不需要修改捕捉地址。'
        },
        {
            icon: '🎵',
            kicker: '播放器与观众',
            title: '选择播放器并配置权限',
            description: '选择你实际使用的音乐播放器，再按需要设置观众点歌、切歌、置顶和撤回等权限。'
        }
    ] as const;
    const currentOnboardingStep = onboardingSteps[onboardingStep] || onboardingSteps[0];
    const feedbackUnreadCount = countUnreadFeedbackReplies(feedbackHistory);
    const playerControlNotice = (config?.playerControlNotice || null) as PlayerControlNotice | null;
    const playerUpgradeTargetVersion = playerControlNotice?.kind === 'upgrade'
        ? connectorStatuses[playerControlNotice.playerKey]?.supportedPlayerVersion
            || playerControlNotice.testedPlayerVersion
        : '';
    const playerAccessBlocked = playerControlNotice?.kind === 'process-access';

    return (
        <div className="admin-widget-root animate-fade-in text-gray-200 flex flex-col font-sans select-none w-full h-screen overflow-hidden" style={{ backgroundColor: '#0d1117' }}>

            {adminToast && (
                <div className="fixed top-8 left-1/2 transform -translate-x-1/2 z-[99999] bg-blue-600 text-white px-6 py-3 rounded-full shadow-2xl font-bold animate-slide-in flex items-center gap-2">
                    {adminToast}
                </div>
            )}

            {onboardingOpen && (
                <div className="fixed inset-0 z-[99990] grid place-items-center bg-black/70 p-5 backdrop-blur-sm">
                    <div className="w-full max-w-xl overflow-hidden rounded-3xl border border-cyan-400/25 bg-[#151922] shadow-[0_24px_100px_rgba(0,0,0,0.65)]" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
                        <div className="border-b border-white/10 bg-gradient-to-r from-cyan-500/10 to-violet-500/10 px-6 py-5">
                            <div className="flex items-start justify-between gap-4">
                                <div>
                                    <div className="text-[11px] font-bold uppercase tracking-[0.2em] text-cyan-300">首次使用向导</div>
                                    <h2 className="mt-1 text-xl font-bold text-white">用 4 步完成点歌机配置</h2>
                                    <p className="mt-1 text-xs text-gray-400">点击“前往设置”会打开对应页面，并自动滚动到需要操作的位置。</p>
                                </div>
                                <button onClick={finishOnboarding} title="关闭并不再自动显示" className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-lg text-gray-500 hover:bg-white/10 hover:text-white">×</button>
                            </div>

                            <div className="mt-5 grid grid-cols-4 gap-2">
                                {onboardingSteps.map((step, index) => (
                                    <button key={step.title} onClick={() => setOnboardingStep(index)} className={`h-1.5 rounded-full transition-colors ${index === onboardingStep ? 'bg-cyan-400' : index < onboardingStep ? 'bg-cyan-700' : 'bg-white/10'}`} aria-label={`查看第 ${index + 1} 步`} />
                                ))}
                            </div>
                        </div>

                        <div className="px-6 py-6">
                            <div className="flex items-start gap-4">
                                <div className="grid h-14 w-14 shrink-0 place-items-center rounded-2xl border border-white/10 bg-white/5 text-3xl">{currentOnboardingStep.icon}</div>
                                <div className="min-w-0">
                                    <div className="text-[11px] font-bold text-cyan-300">第 {onboardingStep + 1} 步 · {currentOnboardingStep.kicker}</div>
                                    <h3 className="mt-1 text-xl font-bold text-white">{currentOnboardingStep.title}</h3>
                                    <p className="mt-2 text-sm leading-relaxed text-gray-400">{currentOnboardingStep.description}</p>
                                </div>
                            </div>

                            <div className="mt-6">
                                {onboardingStep === 0 && (
                                    <button onClick={() => openOnboardingDestination('login', null, true)} className="w-full rounded-xl bg-gradient-to-r from-pink-600 to-violet-600 px-5 py-3 text-sm font-bold text-white shadow-lg hover:brightness-110">前往扫码登录 →</button>
                                )}
                                {onboardingStep === 1 && (
                                    <button onClick={() => openOnboardingDestination('status', 'room', true)} className="w-full rounded-xl bg-gradient-to-r from-blue-600 to-cyan-600 px-5 py-3 text-sm font-bold text-white shadow-lg hover:brightness-110">前往连接直播间 →</button>
                                )}
                                {onboardingStep === 2 && (
                                    <button onClick={() => openOnboardingDestination('appearance', 'mod-ui', true)} className="w-full rounded-xl bg-gradient-to-r from-cyan-600 to-violet-600 px-5 py-3 text-sm font-bold text-white shadow-lg hover:brightness-110">前往设置 Mod UI 捕捉 →</button>
                                )}
                                {onboardingStep === 3 && (
                                    <div className="grid gap-3 sm:grid-cols-2">
                                        <button onClick={() => openOnboardingDestination('settings', 'player', false)} className="rounded-xl border border-purple-400/30 bg-purple-500/15 px-4 py-3 text-sm font-bold text-purple-100 hover:bg-purple-500/25">选择连接的播放器 →</button>
                                        <button onClick={() => openOnboardingDestination('settings', 'permission', false)} className="rounded-xl border border-green-400/30 bg-green-500/15 px-4 py-3 text-sm font-bold text-green-100 hover:bg-green-500/25">配置观众权限 →</button>
                                    </div>
                                )}
                            </div>

                            <div className="mt-5 flex items-center justify-between border-t border-white/10 pt-4">
                                <button disabled={onboardingStep === 0} onClick={() => setOnboardingStep(previous => Math.max(0, previous - 1))} className="text-xs font-bold text-gray-500 hover:text-gray-300 disabled:invisible">← 上一步</button>
                                {onboardingStep === 3 ? (
                                    <button onClick={finishOnboarding} className="rounded-lg bg-white/10 px-4 py-2 text-xs font-bold text-white hover:bg-white/15">完成引导</button>
                                ) : (
                                    <button onClick={finishOnboarding} className="text-xs text-gray-500 hover:text-gray-300">跳过，以后不再自动显示</button>
                                )}
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {onboardingActive && !onboardingOpen && (
                <button onClick={() => setOnboardingOpen(true)} className="fixed bottom-5 right-5 z-[99980] rounded-full border border-cyan-400/30 bg-[#17222c]/95 px-4 py-2.5 text-xs font-bold text-cyan-200 shadow-xl backdrop-blur hover:bg-cyan-500/20">
                    ✨ 继续新手引导 · {onboardingStep + 1}/4
                </button>
            )}

            <div className="px-4 py-2 border-b border-white/10 flex justify-between items-center bg-white/5" style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}>
                <div className="font-bold text-white text-sm flex items-center gap-2">⚙️ 控制面板</div>
            </div>

            <div className="flex-1 flex overflow-hidden relative">
                <div className="w-40 border-r border-white/5 bg-white/[0.02] flex flex-col p-2 gap-1 overflow-y-auto custom-scrollbar shrink-0 z-10">
                    <button
                        onClick={() => void openSkinMarketplace()}
                        className="mb-2 rounded-xl border border-violet-400/35 bg-gradient-to-br from-violet-500/25 via-cyan-500/15 to-blue-500/20 p-3 text-left shadow-lg shadow-violet-950/20 transition hover:border-cyan-300/50 hover:brightness-110"
                    >
                        <span className="flex items-center gap-2 text-sm font-bold text-white">
                            <span>🧩</span>
                            <span>嗷呜皮肤站</span>
                            <span className="ml-auto text-[10px] text-cyan-200">↗</span>
                        </span>
                        <span className="mt-1 block pl-6 text-[10px] leading-relaxed text-cyan-100/70">浏览并一键安装 UI</span>
                    </button>
                    {[
                        { id: 'status', icon: '🏠', label: '运行状态' },
                        { id: 'appearance', icon: '🎨', label: '外观设置' },
                        { id: 'settings', icon: '⚙️', label: '基础设置' },
                        { id: 'login', icon: '📱', label: '扫码登录' },
                        { id: 'update', icon: '🚀', label: '版本升级' }
                    ].map(t => (
                        <button key={t.id} onClick={() => { setActiveTab(t.id); setSupportMenuOpen(false); }} className={`flex items-center gap-2.5 p-2.5 rounded-lg text-sm transition-colors text-left ${activeTab === t.id ? 'bg-blue-600 text-white font-bold' : 'hover:bg-white/10 text-gray-400'}`}>
                            <span>{t.icon}</span> <span className="truncate">{t.label}</span>
                        </button>
                    ))}
                    <details
                        open={supportMenuOpen}
                        onToggle={event => setSupportMenuOpen(event.currentTarget.open)}
                        className="group mt-1 rounded-lg border border-white/[0.06] bg-black/10"
                    >
                        <summary className={`flex cursor-pointer list-none items-center gap-2 rounded-lg px-2.5 py-2 text-xs transition-colors [&::-webkit-details-marker]:hidden ${['faq', 'feedback', 'logs', 'debug'].includes(activeTab) ? 'text-cyan-200' : 'text-gray-500 hover:bg-white/5 hover:text-gray-300'}`}>
                            <span>🛠️</span>
                            <span className="font-bold">帮助与调试</span>
                            {feedbackUnreadCount > 0 && (
                                <span className="ml-auto h-2 w-2 shrink-0 rounded-full bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.8)]" title={`${feedbackUnreadCount} 条反馈有新回复`}></span>
                            )}
                            <span className={`${feedbackUnreadCount > 0 ? '' : 'ml-auto'} text-[10px] transition-transform group-open:rotate-90`}>›</span>
                        </summary>
                        <div className="space-y-0.5 px-1.5 pb-1.5">
                            {[
                                { id: 'faq', icon: '❓', label: '常见问题' },
                                { id: 'feedback', icon: '💬', label: '问题反馈' },
                                { id: 'logs', icon: '📝', label: '运行日志' },
                                { id: 'debug', icon: '🐞', label: '调试测试' }
                            ].map(t => (
                                <button key={t.id} onClick={() => setActiveTab(t.id)} className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors ${activeTab === t.id ? 'bg-blue-600/90 font-bold text-white' : 'text-gray-500 hover:bg-white/5 hover:text-gray-300'}`}>
                                    <span>{t.icon}</span> <span className="truncate">{t.label}</span>
                                    {t.id === 'feedback' && feedbackUnreadCount > 0 && (
                                        <span className="ml-auto h-2 w-2 shrink-0 rounded-full bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.8)]" title={`${feedbackUnreadCount} 条新回复`}></span>
                                    )}
                                </button>
                            ))}
                        </div>
                    </details>
                    <button onClick={restartOnboarding} className="mt-2 flex items-center gap-2.5 rounded-lg border border-cyan-400/15 bg-cyan-500/[0.06] p-2.5 text-left text-xs text-cyan-300 hover:bg-cyan-500/10">
                        <span>✨</span> <span className="truncate">新手引导</span>
                    </button>
                </div>

                <div className="flex-1 p-6 overflow-y-auto custom-scrollbar select-text relative">
                    {!config ? (
                        <div className="h-full flex items-center justify-center text-white/50">正在连接后端服务...</div>
                    ) : (
                        <div className="max-w-3xl mx-auto">

                            {/* ⭐ 新增: 全局联动智能异常自诊断提示栏 (在所有Tab的最上方持续警醒显示) */}
                            {hasBiliLoopIssue && (
                                <div className="mb-6 space-y-3 animate-fadeIn">
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
                                                            <strong className="text-white">美国/海外 IP 应该可以使用：</strong>
                                                            v1.1.1 已加入海外网络兼容处理，正常情况下使用美国或其他海外 IP 也能连接弹幕。若仍反复断线，请先重新连接；仍无法恢复时，再尝试规则/PAC 分流、让 B站直播域名直连，或临时关闭代理、切换国内节点。
                                                        </li>
                                                        <li>
                                                            <strong className="text-white">重新建立连接：</strong>
                                                            游客模式本身可以接收弹幕，不要求扫码。请先在「运行状态」重新连接直播间；如果你原本使用了登录账号，也可以前往 <button className="text-cyan-400 font-bold underline hover:text-cyan-300 focus:outline-none" onClick={() => setActiveTab('login')}>扫码登录</button> 页刷新可选的账号凭据。
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

                            {playerControlNotice && (
                                <div className={`mb-6 animate-fadeIn rounded-xl border p-4 shadow-lg ${playerAccessBlocked ? 'border-red-400/35 bg-red-500/10 text-red-100' : 'border-orange-400/35 bg-orange-500/10 text-orange-100'}`}>
                                    <div className="flex items-start gap-3">
                                        <span className="mt-0.5 shrink-0 text-xl">{playerAccessBlocked ? '🛡️' : '⚠️'}</span>
                                        <div className="min-w-0 flex-1">
                                            <div className={`text-sm font-bold ${playerAccessBlocked ? 'text-red-300' : 'text-orange-300'}`}>
                                                {playerAccessBlocked
                                                    ? `${playerControlNotice.playerName}已连接，但 Windows 阻止了播放控制`
                                                    : `${playerControlNotice.playerName}已连接，但当前版本无法完成点歌播放`}
                                            </div>
                                            <p className="mt-1 text-xs leading-relaxed text-gray-300">
                                                {playerControlNotice.kind === 'process-access'
                                                    ? 'Windows 或 360 等安全软件拒绝了点歌机对播放器进程的控制。请先完全退出点歌机和播放器，确认两者使用相同权限重新打开，并查看安全软件的行为防护或隔离记录。'
                                                    : playerControlNotice.reason === 'older-than-tested-after-control-failure'
                                                        ? `播放器 v${playerControlNotice.currentVersion} 的点歌控制刚刚失败；该版本低于当前连接器已验证的 v${playerUpgradeTargetVersion}。建议升级播放器，而不是反复重新安装连接器。`
                                                        : `连接器已确认当前播放器版本不受支持。建议改用已验证的 v${playerUpgradeTargetVersion}，而不是反复重新安装连接器。`}
                                            </p>
                                            <p className="mt-1 text-[11px] leading-relaxed text-gray-500">
                                                {playerControlNotice.kind === 'process-access'
                                                    ? '如需确认，可临时暂停 360 行为防护并只测试一次；如果恢复正常，请立即重新开启防护，再按下方说明加入信任区。不建议长期关闭杀毒软件。'
                                                    : `升级后请完全退出并重新打开${playerControlNotice.playerName}，再到播放器设置点击“重新连接”。`}
                                            </p>
                                            {playerControlNotice.kind === 'process-access' && (
                                                <div className="mt-3 rounded-lg border border-red-400/20 bg-black/20 p-3 text-[11px] leading-relaxed text-gray-300">
                                                    <div className="font-bold text-red-200">确认是 360 拦截后，将这两个位置加入信任区：</div>
                                                    <div className="mt-1.5 space-y-1 font-mono text-gray-400 select-text">
                                                        <div>1. 包含“嗷呜点歌机.exe”的程序文件夹</div>
                                                        <div>2. %APPDATA%\嗷呜点歌机\player-connectors</div>
                                                    </div>
                                                    <div className="mt-1.5 text-gray-500">不要把整个“下载”、AppData 或用户目录加入白名单。添加后重新开启 360，并完全重启点歌机和播放器。</div>
                                                </div>
                                            )}
                                        </div>
                                        <button
                                            type="button"
                                            onClick={() => {
                                                setActiveTab('settings');
                                                setPendingOnboardingTarget('player');
                                            }}
                                            className={`shrink-0 rounded-lg border px-3 py-2 text-xs font-bold transition ${playerAccessBlocked ? 'border-red-400/30 bg-red-500/15 text-red-200 hover:bg-red-500/25' : 'border-orange-400/30 bg-orange-500/15 text-orange-200 hover:bg-orange-500/25'}`}
                                        >
                                            打开播放器设置
                                        </button>
                                    </div>
                                </div>
                            )}

                            {activeTab === 'status' && (
                                <div className="space-y-5 animate-slide-in-right flex flex-col h-full pb-6">
                                    <div>
                                        <h2 className="text-2xl font-bold text-white mb-2">运行状态</h2>
                                        <p className="text-sm text-gray-500 mb-5">查看直播间、播放器、当前歌曲和点歌开关；界面与 OBS 捕捉请前往「外观设置」。</p>

                                        <div className={`p-4 rounded-xl border mb-5 flex items-center gap-4 ${playerAccessBlocked ? 'bg-red-500/10 border-red-400/30' : playerControlNotice ? 'bg-orange-500/10 border-orange-400/30' : currentStatusSong && !config.currentIsRequested ? 'bg-sky-500/10 border-sky-400/25' : 'bg-white/5 border-white/10'}`}>
                                            <div className={`w-12 h-12 shrink-0 rounded-xl overflow-hidden grid place-items-center ${currentStatusSong && !config.currentIsRequested ? 'bg-sky-400/15 text-sky-200' : 'bg-white/5 text-gray-400'}`}>
                                                {currentStatusSong?.CoverUrl ? (
                                                    <img src={currentStatusSong.CoverUrl} alt="" referrerPolicy="no-referrer" className="w-full h-full object-cover" />
                                                ) : '♫'}
                                            </div>
                                            <div className="min-w-0 flex-1">
                                                <div className={`text-[11px] font-bold mb-1 ${playerAccessBlocked ? 'text-red-300' : playerControlNotice ? 'text-orange-300' : currentStatusSong && !config.currentIsRequested ? 'text-sky-300' : 'text-green-400'}`}>
                                                    {currentStatusSong ? (config.currentIsRequested ? '点歌播放中' : '播放器当前歌曲 · 主播歌单') : '播放器当前歌曲'}
                                                </div>
                                                <div className="font-bold text-white truncate">{currentStatusSong?.SongName || '暂未读取到歌曲'}</div>
                                                <div className="text-xs text-gray-400 truncate mt-0.5">{currentStatusSong?.ArtistName || '连接播放器后会在这里实时显示'}</div>
                                            </div>
                                            <span className={`text-xs px-2.5 py-1 rounded-full border ${playerAccessBlocked ? 'text-red-300 border-red-400/30 bg-red-500/10' : playerControlNotice ? 'text-orange-300 border-orange-400/30 bg-orange-500/10' : config.playerConnected ? 'text-green-300 border-green-500/25 bg-green-500/10' : 'text-red-300 border-red-500/25 bg-red-500/10'}`}>
                                                {playerAccessBlocked ? '已连接 · 权限被阻止' : playerControlNotice ? '已连接 · 版本不兼容' : config.playerConnected ? '播放器已连接' : '播放器未连接'}
                                            </span>
                                        </div>

                                        <div ref={roomSetupRef} className="bg-white/5 p-5 rounded-xl border border-white/10 shadow-inner mb-5 scroll-mt-4">
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

                                        <div className="grid grid-cols-2 gap-4 mb-5">
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

                            {activeTab === 'appearance' && (
                                <div className="space-y-5 animate-slide-in-right pb-6">
                                    <div className="flex flex-wrap items-center justify-between gap-3">
                                        <div>
                                            <h2 className="text-2xl font-bold text-white mb-2">外观设置</h2>
                                            <p className="text-sm text-gray-500">分别设置面向观众的直播画面，以及主播自己操作的点歌机悬浮窗。</p>
                                        </div>
                                        <button onClick={() => void openSkinMarketplace()} className="shrink-0 rounded-xl border border-violet-400/40 bg-gradient-to-r from-violet-600 to-cyan-600 px-4 py-2.5 text-sm font-bold text-white shadow-lg shadow-violet-950/30 transition hover:brightness-110">
                                            🧩 浏览嗷呜皮肤站 ↗
                                        </button>
                                    </div>

                                    <section ref={modUiSetupRef} className="rounded-2xl border border-cyan-400/30 bg-gradient-to-br from-cyan-500/10 via-cyan-500/[0.04] to-violet-500/[0.08] overflow-hidden shadow-inner scroll-mt-4">
                                        <div className="p-5 border-b border-cyan-400/15">
                                            <div className="flex flex-wrap items-start justify-between gap-3">
                                                <div>
                                                    <div className="mb-2 flex flex-wrap items-center gap-2">
                                                        <span className="text-xl">📺</span>
                                                        <h3 className="text-lg font-bold text-cyan-100">面向观众 · Mod UI</h3>
                                                        <span className="rounded-full border border-cyan-400/25 bg-cyan-500/15 px-2 py-1 text-[10px] font-bold text-cyan-300">OBS / 直播姬推荐</span>
                                                    </div>
                                                    <p className="max-w-2xl text-xs leading-relaxed text-gray-300">
                                                        用浏览器捕捉把当前歌曲、待播队列和点歌状态展示给观众。页面只读取公开状态，没有控制按钮，也不会向点歌机发送操作请求。
                                                    </p>
                                                </div>
                                                <a href="https://github.com/Enkianssus/AwooMusicBot-Overlay-Default" target="_blank" rel="noreferrer" className="shrink-0 rounded-lg border border-cyan-400/25 bg-cyan-500/10 px-3 py-2 text-[11px] font-bold text-cyan-300 hover:bg-cyan-500/20">查看 UI 模组开发示例 ↗</a>
                                            </div>

                                            <div className="mt-4 grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(200px,0.42fr)]">
                                                <div className="rounded-xl border border-cyan-400/20 bg-black/20 p-3">
                                                    <div className="mb-1 text-[10px] font-bold text-cyan-300/80">Mod UI 浏览器捕捉地址</div>
                                                    <div className="flex items-center gap-2">
                                                        <div className="min-w-0 flex-1 truncate font-mono text-sm text-cyan-200 select-all">{modObsUrl}</div>
                                                        <button onClick={() => { void navigator.clipboard.writeText(modObsUrl); showAdminToast('✅ 已复制 Mod UI 浏览器捕捉地址'); }} className="shrink-0 rounded-lg border border-cyan-400/25 bg-cyan-500/15 px-3 py-2 text-xs font-bold text-cyan-200 hover:bg-cyan-500/25">复制地址</button>
                                                    </div>
                                                </div>
                                                <div className="rounded-xl border border-white/10 bg-black/15 p-3">
                                                    <div className="mb-1 text-[10px] text-gray-500">当前使用的 Mod UI</div>
                                                    <div className="truncate text-sm font-bold text-white">
                                                        {overlayMods?.active ? `${overlayMods.active.name} · v${overlayMods.active.version}` : '正在读取…'}
                                                    </div>
                                                </div>
                                            </div>

                                            {!config.externalApi?.httpEnabled && (
                                                <div className="mt-3 flex items-center justify-between gap-3 rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2">
                                                    <span className="text-[11px] text-amber-300">只读 HTTP 尚未开启，OBS 暂时打不开此地址。</span>
                                                    <button onClick={enableOverlayApi} className="shrink-0 text-[11px] font-bold text-amber-200 underline">立即开启</button>
                                                </div>
                                            )}

                                            <div className="mt-5 grid gap-4 md:grid-cols-[minmax(0,1fr)_280px]">
                                                <div className="overflow-hidden rounded-2xl border border-white/10 bg-black/20">
                                                    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/10 px-3 py-2.5">
                                                        <div>
                                                            <div className="text-xs font-bold text-white">实时预览</div>
                                                            <div className="text-[10px] text-gray-500">与 OBS 使用相同页面和参数</div>
                                                        </div>
                                                        <div className="flex items-center gap-1">
                                                            {(['checker', 'dark', 'light'] as const).map(background => (
                                                                <button key={background} onClick={() => setOverlayPreviewBackground(background)} className={`rounded-md px-2 py-1 text-[10px] ${overlayPreviewBackground === background ? 'bg-cyan-500/20 text-cyan-200' : 'text-gray-500 hover:bg-white/5 hover:text-gray-300'}`}>
                                                                    {background === 'checker' ? '透明' : background === 'dark' ? '深色' : '浅色'}
                                                                </button>
                                                            ))}
                                                            <button onClick={() => setOverlayPreviewNonce(value => value + 1)} className="rounded-md px-2 py-1 text-[10px] text-gray-400 hover:bg-white/5 hover:text-white">刷新</button>
                                                        </div>
                                                    </div>
                                                    <div className="relative h-[420px] overflow-hidden transition-colors" style={overlayPreviewStyle}>
                                                        {config.externalApi?.httpEnabled ? (
                                                            <iframe
                                                                key={`${overlayMods?.activeId || 'loading'}-${overlayPreviewNonce}`}
                                                                title="Mod UI 实时预览"
                                                                src={`${modObsUrl}?preview=${overlayPreviewNonce}`}
                                                                className="h-full w-full border-0 pointer-events-none"
                                                            />
                                                        ) : (
                                                            <div className="grid h-full place-items-center p-6 text-center text-xs text-amber-300">开启只读 HTTP 后即可在这里预览 Mod UI</div>
                                                        )}
                                                    </div>
                                                </div>

                                                <div className="flex h-[474px] min-h-0 flex-col overflow-hidden rounded-2xl border border-white/10 bg-black/20">
                                                    <div className="flex items-start justify-between gap-2 border-b border-white/10 px-3 py-2.5">
                                                        <div className="min-w-0">
                                                            <div className="truncate text-xs font-bold text-white">{overlayMods?.active?.name || '当前 Mod UI'} 参数</div>
                                                            <div className="mt-0.5 text-[10px] leading-relaxed text-gray-500">每个 UI 独立缓存，切换或升级后继续保留。</div>
                                                        </div>
                                                        {activeOverlaySettings.length > 0 && overlayMods?.active && (
                                                            <button onClick={() => void resetOverlaySettings(overlayMods.active.id)} className="shrink-0 rounded-md border border-white/10 bg-white/5 px-2 py-1 text-[10px] text-gray-400 hover:text-white">恢复默认</button>
                                                        )}
                                                    </div>

                                                    <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3 custom-scrollbar">
                                                        {activeOverlaySettingGroups.map(([group, definitions]) => (
                                                            <div key={group} className="space-y-2">
                                                                <div className="px-1 text-[10px] font-bold uppercase tracking-wider text-cyan-300/80">{group}</div>
                                                                {definitions.map(definition => (
                                                                    <OverlaySettingControl
                                                                        key={definition.key}
                                                                        definition={definition}
                                                                        value={overlayMods?.active?.values?.[definition.key]}
                                                                        onChange={value => {
                                                                            if (overlayMods?.active) updateOverlaySetting(overlayMods.active.id, definition.key, value);
                                                                        }}
                                                                        onReset={() => {
                                                                            if (overlayMods?.active) updateOverlaySetting(overlayMods.active.id, definition.key, definition.default);
                                                                        }}
                                                                    />
                                                                ))}
                                                            </div>
                                                        ))}
                                                        {overlayMods && activeOverlaySettings.length === 0 && (
                                                            <div className="rounded-xl border border-dashed border-white/10 p-4 text-center text-xs leading-relaxed text-gray-500">
                                                                这个 Mod UI 尚未声明可调参数，仍可正常预览和使用。
                                                            </div>
                                                        )}
                                                        {!overlayMods && <div className="text-xs text-gray-500">正在读取 Mod UI 参数…</div>}
                                                    </div>
                                                </div>
                                            </div>
                                        </div>

                                        <div className="p-5 space-y-4">
                                            <div className="flex flex-wrap items-start justify-between gap-3">
                                                <div>
                                                    <div className="text-sm font-bold text-white">安装与切换 Mod UI</div>
                                                    <p className="mt-1 text-xs leading-relaxed text-gray-500">皮肤站支持一键安装；也可以继续使用 GitHub 地址或本地 ZIP。切换 UI 后，OBS 捕捉地址保持不变。</p>
                                                </div>
                                            </div>

                                            <div className="flex flex-wrap gap-2">
                                                <input
                                                    type="url"
                                                    value={overlayUrl}
                                                    onChange={event => setOverlayUrl(event.target.value)}
                                                    placeholder="粘贴 GitHub 仓库或 Mod UI 地址"
                                                    className="flex-[1_1_320px] min-w-0 bg-black/30 border border-white/10 rounded-lg px-3 py-2.5 text-sm text-white focus:border-violet-400 outline-none"
                                                />
                                                <button disabled={overlayBusy} onClick={installOverlayFromUrl} className="px-4 py-2.5 rounded-lg bg-violet-600 hover:bg-violet-500 disabled:opacity-50 text-white text-sm font-bold transition-colors">
                                                    {overlayBusy ? '处理中…' : '识别并安装'}
                                                </button>
                                                <button disabled={overlayBusy} onClick={() => overlayFileInputRef.current?.click()} className="px-4 py-2.5 rounded-lg bg-white/5 hover:bg-white/10 disabled:opacity-50 text-gray-200 text-sm font-bold border border-white/10 transition-colors">＋ 选择 ZIP</button>
                                                <input
                                                    ref={overlayFileInputRef}
                                                    type="file"
                                                    accept=".zip,application/zip"
                                                    hidden
                                                    onChange={event => {
                                                        const file = event.target.files?.[0];
                                                        if (file) void installOverlayZip(file);
                                                    }}
                                                />
                                            </div>

                                            <div
                                                onDragEnter={event => { event.preventDefault(); setOverlayDropActive(true); }}
                                                onDragOver={event => { event.preventDefault(); setOverlayDropActive(true); }}
                                                onDragLeave={event => { event.preventDefault(); setOverlayDropActive(false); }}
                                                onDrop={event => {
                                                    event.preventDefault();
                                                    setOverlayDropActive(false);
                                                    const file = event.dataTransfer.files?.[0];
                                                    if (file) void installOverlayZip(file);
                                                }}
                                                className={`rounded-xl border border-dashed px-4 py-3 text-center text-xs transition-colors ${overlayDropActive ? 'border-cyan-300 bg-cyan-400/10 text-cyan-200' : 'border-white/15 bg-black/15 text-gray-500'}`}
                                            >
                                                {overlayDropActive ? '松开即可安装 Mod UI ZIP' : '拖入 Mod UI ZIP 到这里安装'}
                                            </div>

                                            <div className="space-y-2">
                                                {(overlayMods?.overlays || []).map(overlay => (
                                                    <div key={overlay.id} className={`rounded-xl border p-3 flex items-center gap-3 ${overlay.active ? 'border-violet-400/35 bg-violet-500/10' : 'border-white/10 bg-black/15'}`}>
                                                        <div className={`w-9 h-9 rounded-lg grid place-items-center shrink-0 ${overlay.active ? 'bg-violet-500/25 text-violet-200' : 'bg-white/5 text-gray-500'}`}>◫</div>
                                                        <div className="min-w-0 flex-1">
                                                            <div className="flex items-center gap-2">
                                                                <span className="text-sm font-bold text-white truncate">{overlay.name}</span>
                                                                <span className="text-[10px] text-gray-500">v{overlay.version}</span>
                                                                {overlay.builtin && <span className="text-[10px] text-gray-500">内置</span>}
                                                                {(overlay.settings?.length || 0) > 0 && <span className="rounded bg-cyan-500/10 px-1.5 py-0.5 text-[9px] text-cyan-300">{overlay.settings.length} 项可调</span>}
                                                            </div>
                                                            <div className="text-[11px] text-gray-500 truncate mt-0.5">{overlay.description || `${overlay.author} · ${overlay.id}`}</div>
                                                        </div>
                                                        {overlay.active ? (
                                                            <span className="text-xs font-bold text-violet-300 px-3 py-1.5">使用中</span>
                                                        ) : (
                                                            <button disabled={overlayBusy} onClick={() => void activateOverlay(overlay.id)} className="text-xs font-bold text-cyan-300 px-3 py-1.5 rounded-lg bg-cyan-500/10 hover:bg-cyan-500/20 disabled:opacity-50">切换</button>
                                                        )}
                                                        {!overlay.builtin && (
                                                            <button disabled={overlayBusy} onClick={() => void removeOverlay(overlay.id)} title="删除这个 Mod UI" className="text-xs text-red-300/70 hover:text-red-300 px-2 py-1.5 disabled:opacity-50">删除</button>
                                                        )}
                                                    </div>
                                                ))}
                                                {!overlayMods && <div className="text-xs text-gray-500 py-2">正在读取已安装 Mod UI…</div>}
                                            </div>
                                        </div>
                                    </section>

                                    <section className="rounded-2xl border border-blue-400/20 bg-gradient-to-br from-blue-500/[0.07] to-white/[0.025] overflow-hidden">
                                        <div className="p-5 border-b border-white/10">
                                            <div className="flex flex-wrap items-center gap-2">
                                                <span className="text-xl">🧑‍💻</span>
                                                <h3 className="text-lg font-bold text-white">主播控制 UI</h3>
                                                <span className="rounded-full border border-blue-400/20 bg-blue-500/10 px-2 py-1 text-[10px] text-blue-300">主播自己使用</span>
                                            </div>
                                            <p className="mt-2 text-xs leading-relaxed text-gray-400">设置点歌机悬浮窗的点歌图片、标题栏、文字与背景。这里只影响主播操作窗口，不会改变 OBS 的 Mod UI。</p>
                                        </div>

                                        <div className="p-5 space-y-5">
                                            <div className="grid gap-4 lg:grid-cols-2">
                                                <div className="space-y-3 rounded-xl border border-white/10 bg-black/15 p-4">
                                                    <div className="text-xs font-bold text-blue-200">布局与标题栏</div>
                                                    <div className="flex items-center justify-between gap-4">
                                                        <div>
                                                            <div className="text-sm text-gray-200">极简待播队列</div>
                                                            <div className="text-[10px] text-gray-500">Mini 模式，缩小每首歌曲占用的高度</div>
                                                        </div>
                                                        <button aria-label="极简待播队列" onClick={() => updateControlTheme({ ...currentControlTheme, compactQueue: !currentControlTheme.compactQueue })} className={`w-10 h-6 rounded-full p-1 transition-colors shrink-0 ${currentControlTheme.compactQueue ? 'bg-blue-500' : 'bg-white/15'}`}><span className={`block w-4 h-4 rounded-full bg-white transition-transform ${currentControlTheme.compactQueue ? 'translate-x-4' : 'translate-x-0'}`}></span></button>
                                                    </div>
                                                    <div className="flex items-center justify-between gap-4">
                                                        <div className="text-sm text-gray-200">显示标题栏</div>
                                                        <button aria-label="显示标题栏" onClick={() => updateControlTheme({ ...currentControlTheme, showTitleBar: !currentControlTheme.showTitleBar })} className={`w-10 h-6 rounded-full p-1 transition-colors shrink-0 ${currentControlTheme.showTitleBar ? 'bg-blue-500' : 'bg-white/15'}`}><span className={`block w-4 h-4 rounded-full bg-white transition-transform ${currentControlTheme.showTitleBar ? 'translate-x-4' : 'translate-x-0'}`}></span></button>
                                                    </div>
                                                    {currentControlTheme.showTitleBar && (
                                                        <>
                                                            <div className="flex items-center justify-between gap-4">
                                                                <div className="text-sm text-gray-200">标题栏融入背景</div>
                                                                <button aria-label="标题栏融入背景" onClick={() => updateControlTheme({ ...currentControlTheme, syncTitleBarWithBg: !currentControlTheme.syncTitleBarWithBg })} className={`w-10 h-6 rounded-full p-1 transition-colors shrink-0 ${currentControlTheme.syncTitleBarWithBg ? 'bg-blue-500' : 'bg-white/15'}`}><span className={`block w-4 h-4 rounded-full bg-white transition-transform ${currentControlTheme.syncTitleBarWithBg ? 'translate-x-4' : 'translate-x-0'}`}></span></button>
                                                            </div>
                                                            {!currentControlTheme.syncTitleBarWithBg && (
                                                                <label className="flex items-center justify-between gap-4 text-sm text-gray-200">
                                                                    <span>标题栏背景色</span>
                                                                    <span className="flex items-center gap-2 text-[11px] font-mono text-gray-500"><span>{currentControlTheme.titleBarBgColor}</span><input aria-label="标题栏背景色" type="color" value={currentControlTheme.titleBarBgColor} onChange={event => updateControlTheme({ ...currentControlTheme, titleBarBgColor: event.target.value })} className="w-8 h-8 rounded cursor-pointer bg-transparent" /></span>
                                                                </label>
                                                            )}
                                                        </>
                                                    )}
                                                </div>

                                                <div className="space-y-3 rounded-xl border border-white/10 bg-black/15 p-4">
                                                    <div className="text-xs font-bold text-blue-200">颜色与透明度</div>
                                                    <label className="flex items-center justify-between gap-4 text-sm text-gray-200"><span>标题 / 高亮字</span><span className="flex items-center gap-2 text-[11px] font-mono text-gray-500"><span>{currentControlTheme.titleColor}</span><input aria-label="标题和高亮字颜色" type="color" value={currentControlTheme.titleColor} onChange={event => updateControlTheme({ ...currentControlTheme, titleColor: event.target.value })} className="w-8 h-8 rounded cursor-pointer bg-transparent" /></span></label>
                                                    <label className="flex items-center justify-between gap-4 text-sm text-gray-200"><span>主体文字</span><span className="flex items-center gap-2 text-[11px] font-mono text-gray-500"><span>{currentControlTheme.textColor}</span><input aria-label="主体文字颜色" type="color" value={currentControlTheme.textColor} onChange={event => updateControlTheme({ ...currentControlTheme, textColor: event.target.value })} className="w-8 h-8 rounded cursor-pointer bg-transparent" /></span></label>
                                                    <label className="flex items-center justify-between gap-4 text-sm text-gray-200"><span>次要文字</span><span className="flex items-center gap-2 text-[11px] font-mono text-gray-500"><span>{currentControlTheme.subTextColor}</span><input aria-label="次要文字颜色" type="color" value={currentControlTheme.subTextColor} onChange={event => updateControlTheme({ ...currentControlTheme, subTextColor: event.target.value })} className="w-8 h-8 rounded cursor-pointer bg-transparent" /></span></label>
                                                    <label className="flex items-center justify-between gap-4 text-sm text-gray-200"><span>全局背景色</span><span className="flex items-center gap-2 text-[11px] font-mono text-gray-500"><span>{currentControlTheme.bgColor}</span><input aria-label="全局背景色" type="color" value={currentControlTheme.bgColor} onChange={event => updateControlTheme({ ...currentControlTheme, bgColor: event.target.value })} className="w-8 h-8 rounded cursor-pointer bg-transparent" /></span></label>
                                                    <label className="block pt-1">
                                                        <span className="mb-2 flex items-center justify-between text-sm text-gray-200"><span>背景不透明度</span><span className="text-xs font-bold text-blue-300">{Math.round(currentControlTheme.bgOpacity * 100)}%</span></span>
                                                        <input aria-label="背景不透明度" type="range" min="0" max="1" step="0.05" value={currentControlTheme.bgOpacity} onChange={event => updateControlTheme({ ...currentControlTheme, bgOpacity: Number(event.target.value) })} className="w-full accent-blue-500" />
                                                    </label>
                                                </div>

                                                <div className="space-y-3 rounded-xl border border-blue-400/15 bg-blue-500/[0.04] p-4 lg:col-span-2">
                                                    <div className="text-xs font-bold text-blue-200">主播控制 UI · 歌曲图片</div>
                                                    <div className="grid items-center gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(220px,0.52fr)]">
                                                        <div>
                                                            <div className="text-sm text-gray-200">点歌歌曲显示图片</div>
                                                            <div className="mt-1 text-[10px] leading-relaxed text-gray-500">仅影响主播悬浮窗；主播歌单始终显示歌曲封面，OBS Mod UI 请在上方单独设置。</div>
                                                        </div>
                                                        <select
                                                            aria-label="主播控制 UI 点歌歌曲图片"
                                                            value={config.config.RequestedSongArtwork === 'song_cover' ? 'song_cover' : 'bili_avatar'}
                                                            onChange={event => setConfig({ ...config, config: { ...config.config, RequestedSongArtwork: event.target.value } })}
                                                            className="w-full cursor-pointer rounded-lg border border-blue-400/20 bg-black/30 p-2.5 text-sm text-white outline-none focus:border-blue-400"
                                                        >
                                                            <option value="bili_avatar">点歌人的 B 站头像（默认）</option>
                                                            <option value="song_cover">歌曲专辑封面</option>
                                                        </select>
                                                    </div>
                                                </div>
                                            </div>

                                            <div className="flex justify-end">
                                                <button onClick={() => {
                                                    updateControlTheme(defaultTheme);
                                                    setConfig((previous: any) => previous ? ({
                                                        ...previous,
                                                        config: { ...previous.config, RequestedSongArtwork: 'bili_avatar' }
                                                    }) : previous);
                                                    showAdminToast('✅ 已恢复主播控制 UI 默认外观');
                                                }} className="rounded-lg border border-white/10 bg-white/5 px-4 py-2 text-xs font-bold text-gray-300 hover:bg-white/10">恢复默认外观</button>
                                            </div>

                                            <details className="group rounded-xl border border-white/10 bg-white/[0.025]">
                                                <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-gray-400 hover:text-gray-200">
                                                    <span className="flex min-w-0 items-center gap-2">
                                                        <span className="text-sm font-bold">经典页面捕捉</span>
                                                        <span className="rounded-full border border-gray-500/20 bg-gray-500/10 px-2 py-1 text-[10px] text-gray-500">向前兼容</span>
                                                    </span>
                                                    <span className="shrink-0 text-[11px] text-gray-500">展开查看旧地址 ▾</span>
                                                </summary>
                                                <div className="border-t border-white/5 px-4 pb-4 pt-3">
                                                    <p className="mb-3 text-xs leading-relaxed text-gray-500">仅保留给已经配置好旧版 OBS 场景的用户。新建直播画面时，请优先使用上方的 Mod UI 浏览器捕捉。</p>
                                                    <div className="flex items-center gap-2 rounded-lg border border-white/5 bg-black/15 p-2">
                                                        <div className="min-w-0 flex-1 truncate font-mono text-sm text-gray-400 select-all">{classicObsUrl}</div>
                                                        <button onClick={() => { void navigator.clipboard.writeText(classicObsUrl); showAdminToast('✅ 已复制经典页面地址'); }} className="shrink-0 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs font-bold text-gray-300 hover:bg-white/10">复制旧地址</button>
                                                    </div>
                                                </div>
                                            </details>
                                        </div>
                                    </section>
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

                                    {/* FAQ CARD 1: 播放器无法控制 */}
                                    <div className="bg-white/5 p-6 rounded-xl border border-white/10 space-y-4 shadow-inner">
                                        <h3 className="text-md font-bold text-red-400 flex items-center gap-2 pb-2 border-b border-white/5">
                                            <span>🎵</span> 问题 1：当前播放器显示“未连接”或无法控制？
                                        </h3>

                                        <div className="space-y-4 text-sm leading-relaxed text-gray-300">
                                            <div>
                                                <strong className="text-white block mb-1">第一步：确认播放器已启动并显示主窗口</strong>
                                                <p className="text-xs text-gray-400 leading-relaxed">
                                                    v1.1.1 不再启动、结束或重启播放器。请先手动打开网易云、酷狗或 QQ 音乐；使用 Folia 时请启动 Stage API。再到 <button className="text-cyan-400 font-bold underline hover:text-cyan-300" onClick={() => setActiveTab('settings')}>基础设置</button> 选择对应方式并点击“重新连接”。
                                                </p>
                                            </div>

                                            <div className="border-t border-white/5 pt-3">
                                                <strong className="text-white block mb-1">第二步：查看播放器版本和运行日志</strong>
                                                <p className="text-xs text-gray-400 leading-relaxed">
                                                    网易云通过原生 IPC 连接；酷狗使用窗口消息与内部 IPC；QQ 使用单实例命令；Folia 使用本机 Stage API。播放器更新后若某项能力被拒绝，请把 <button className="text-cyan-400 font-bold underline hover:text-cyan-300" onClick={() => setActiveTab('logs')}>运行日志</button> 中的版本和错误信息发来。网易云不再需要调试端口。
                                                </p>
                                            </div>

                                            <div className="border-t border-white/5 pt-3">
                                                <strong className="text-white block mb-1">第三步：用调试页做主动测试</strong>
                                                <p className="text-xs text-gray-400 leading-relaxed">
                                                    前往 <button className="text-cyan-400 font-bold underline hover:text-cyan-300" onClick={() => setActiveTab('debug')}>调试测试</button> 搜索一首歌并登记下一首，或手动触发下一首。该操作会真实控制当前选中的播放器。
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
                                                        <strong className="text-white">美国/海外 IP 在 v1.1.1 中应该可以使用</strong>
                                                        新版已经加入海外网络兼容处理，不再把境外 IP 视为必然不可用。若当前线路仍触发 B站风控并反复断线，请先重新连接一次；仍不行时，再尝试规则/PAC 分流并让 B站直播域名直连，或临时关闭代理、切换国内节点。<br/>
                                                        <strong className="text-green-400">建议：</strong> 先保持当前美国 IP 直接测试，只有实际失败时才使用上述替代方法。
                                                    </li>
                                                    <li>
                                                        <strong className="text-white">重新建立游客或账号连接</strong>
                                                        游客模式无需扫码即可接收弹幕。请先前往 <button className="text-cyan-400 font-bold underline hover:text-cyan-300" onClick={() => setActiveTab('status')}>运行状态</button> 重新连接直播间；只有在你需要白名单、权限分级，或想刷新已有账号凭据时，才需要前往扫码登录页。
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
                                        <p className="text-xs text-gray-500 mb-8 leading-relaxed">此操作会使用当前选中播放器自己的搜索接口；Folia 使用 Stage 搜索接口，其余播放器使用各自适配器，并登记下一首守卫。</p>

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
                                        <div className="bg-cyan-500/10 p-4 rounded-xl border border-cyan-500/20 mb-6 text-sm text-cyan-100 flex items-start gap-3">
                                            <span>👤</span>
                                            <div>
                                                <div className="font-bold">游客模式已启用</div>
                                                <div className="text-xs text-gray-400 mt-1">无需扫码即可连接直播间和使用普通点歌。超级用户白名单与自定义权限控制需登录后才可设置。</div>
                                            </div>
                                        </div>
                                    )}

                                    {/* 播放器原生控制区域 */}
                                    <div ref={playerSetupRef} className="bg-white/5 p-6 rounded-xl border border-purple-500/40 space-y-5 mb-6 shadow-[0_0_15px_rgba(168,85,247,0.15)] relative overflow-hidden scroll-mt-4">
                                        <div className="absolute top-0 right-0 bg-purple-600 text-white text-xs px-3 py-1 rounded-bl-lg font-bold">v1.1 独立连接器</div>

                                        <div className="flex items-center justify-between gap-3 border-b border-white/10 pb-3">
                                            <h3 className="text-sm font-bold text-purple-400 uppercase tracking-widest">
                                                💻 播放器设置
                                            </h3>
                                            <span className="px-3 py-1.5 bg-green-500/10 text-green-300 text-[11px] rounded-lg font-bold border border-green-500/30">
                                                {connectorChecking ? '⏳ 正在同步版本' : '♨️ 同播放器版本自动更新'}
                                            </span>
                                        </div>

                                        {connectorStatusError && (
                                            <div className="bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2 text-[11px] text-red-300">
                                                连接器版本检查失败：{connectorStatusError}。已安装的连接器仍可继续使用；首次使用则需要网络恢复后自动下载安装。
                                            </div>
                                        )}

                                        {playerControlNotice && (
                                            <div className={`rounded-lg border px-4 py-3 text-xs ${playerAccessBlocked ? 'border-red-400/35 bg-red-500/10 text-red-100' : 'border-orange-400/35 bg-orange-500/10 text-orange-100'}`}>
                                                <div className={`font-bold ${playerAccessBlocked ? 'text-red-300' : 'text-orange-300'}`}>
                                                    {playerAccessBlocked
                                                        ? `${playerControlNotice.playerName}控制权限被 Windows 拒绝`
                                                        : `请升级${playerControlNotice.playerName}客户端`}
                                                </div>
                                                <div className="mt-1 leading-relaxed text-gray-300">
                                                    {playerControlNotice.kind === 'process-access'
                                                        ? '请先确认点歌机与播放器使用相同权限。若 360 的行为防护记录与失败时间吻合，可以临时暂停防护测试一次；确认恢复后立即重新开启，并将“嗷呜点歌机.exe 所在文件夹”和“%APPDATA%\\嗷呜点歌机\\player-connectors”加入信任区，然后完全重启点歌机与播放器。不建议长期关闭杀毒软件，也不要把整个下载目录或 AppData 加入白名单。'
                                                        : `当前 v${playerControlNotice.currentVersion} 已连接，但播放控制未生效；建议升级到已验证版本 v${playerUpgradeTargetVersion}，或连接器明确支持的更新版本。升级后完全退出并重新打开播放器，再点击下方“重新连接”。无需重复安装连接器。`}
                                                </div>
                                            </div>
                                        )}

                                        <div className="hidden md:grid grid-cols-12 gap-4 text-[11px] text-gray-500 font-bold uppercase tracking-wider pb-2 border-b border-white/5 mt-3">
                                            <div className="col-span-2">目标播放器</div>
                                            <div className="col-span-2">当前状态</div>
                                            <div className="col-span-3">连接器版本</div>
                                            <div className="col-span-2">控制方式</div>
                                            <div className="col-span-3 text-right">操作</div>
                                        </div>

                                        <div className="flex flex-col gap-3 mt-2">
                                            {playerOptions.map(player => {
                                                const selected = config.config.PlayerType === player.type;
                                                const connected = config.playerConnected ?? config.cdpConnected;
                                                const connecting = selected && config.playerConnecting === true;
                                                const connectorStatus =
                                                    connectorStatuses[player.connectorId];
                                                const reinstalling =
                                                    player.connectorId === connectorUpdating;
                                                const automaticallyUpdating =
                                                    connectorStatus?.updating === true;
                                                const controlBlocked = Boolean(
                                                    selected
                                                    && playerControlNotice?.playerKey === player.connectorId
                                                );
                                                const rowAccessBlocked = controlBlocked && playerAccessBlocked;
                                                return (
                                                    <div key={player.type} className={`grid grid-cols-1 md:grid-cols-12 gap-4 items-center bg-black/40 border ${selected ? 'border-purple-500/50 shadow-inner' : 'border-white/10'} rounded-lg p-3 transition-colors hover:bg-white/5`}>
                                                        <div className="md:col-span-2 flex items-center gap-3">
                                                            <button onClick={() => handleSetPlayerType(player.type)} className={`w-5 h-5 rounded-full border-2 flex items-center justify-center ${selected ? 'border-purple-500' : 'border-gray-500'}`}>
                                                                {selected && <div className="w-2.5 h-2.5 bg-purple-500 rounded-full" />}
                                                            </button>
                                                            <span className={`text-sm font-bold tracking-wide ${selected ? 'text-white' : 'text-gray-400'}`}>{player.name}</span>
                                                        </div>
                                                        <div className="md:col-span-2">
                                                            {selected ? (
                                                                <div className="space-y-1.5">
                                                                    <span className={`inline-flex text-[10px] px-2.5 py-1 rounded-full font-bold shadow-md ${rowAccessBlocked ? 'bg-red-500/20 text-red-300 border border-red-400/30' : controlBlocked ? 'bg-orange-500/20 text-orange-300 border border-orange-400/30' : connecting ? 'bg-yellow-500/20 text-yellow-300 border border-yellow-500/30' : connected ? 'bg-green-500/20 text-green-400 border border-green-500/30' : 'bg-red-500/20 text-red-400 border border-red-500/30'}`}>
                                                                        {rowAccessBlocked ? '🛡️ 已连接但权限受阻' : controlBlocked ? '⚠️ 已连接但版本不兼容' : connecting ? '⏳ 连接中' : connected ? '✅ 已连接' : '❌ 未连接'}
                                                                    </span>
                                                                    <div className="text-[10px] text-gray-400">
                                                                        播放器版本：
                                                                        <span className="font-mono text-gray-200">
                                                                            {connected && config.playerSnapshot?.version
                                                                                ? config.playerSnapshot.version
                                                                                : connecting
                                                                                    ? '正在检测'
                                                                                    : '未检测到'}
                                                                        </span>
                                                                    </div>
                                                                </div>
                                                            ) : (
                                                                <span className="text-[10px] px-2.5 py-1 rounded-full font-bold bg-gray-600/20 text-gray-500 border border-gray-500/30">未启用</span>
                                                            )}
                                                        </div>
                                                        <div className="md:col-span-3 min-w-0">
                                                            {connectorStatus ? (
                                                                    <div className="space-y-1">
                                                                        {connectorStatus.manualUpdateAvailable && (
                                                                            <div className="text-[10px] text-orange-300 font-bold">
                                                                                新播放器版本分支：仅手动更新
                                                                                <span className="block text-orange-200/70 font-normal mt-0.5">
                                                                                    支持播放器版本：{connectorStatus.supportedPlayerVersion || '清单未注明'}
                                                                                </span>
                                                                            </div>
                                                                        )}
                                                                        {connectorStatus.autoUpdateAvailable && connectorStatus.installed && (
                                                                            <div className="text-[10px] text-cyan-300 font-bold">
                                                                                同播放器版本补丁，将自动更新
                                                                            </div>
                                                                        )}
                                                                        <div className="text-[11px] text-gray-300">
                                                                            当前：
                                                                            <span className="font-mono text-white">
                                                                                {connectorStatus.installed
                                                                                    ? `独立 v${connectorStatus.currentVersion}`
                                                                                    : '未安装'}
                                                                            </span>
                                                                        </div>
                                                                        <div className="text-[10px] text-gray-500">
                                                                            网站最新：
                                                                            <span className="font-mono">
                                                                                {connectorStatus.latestVersion
                                                                                    ? `v${connectorStatus.latestVersion}`
                                                                                    : '未知'}
                                                                            </span>
                                                                        </div>
                                                                        <span
                                                                            title={connectorStatus.error || undefined}
                                                                            className={`inline-flex text-[9px] px-2 py-0.5 rounded-full border ${
                                                                                connectorStatus.updating
                                                                                    ? 'bg-yellow-500/10 text-yellow-300 border-yellow-500/30'
                                                                                    : connectorStatus.error
                                                                                    ? 'bg-red-500/10 text-red-300 border-red-500/30'
                                                                                    : !connectorStatus.compatible
                                                                                        ? 'bg-orange-500/10 text-orange-300 border-orange-500/30'
                                                                                        : connectorStatus.updateAvailable
                                                                                            ? 'bg-cyan-500/10 text-cyan-300 border-cyan-500/30'
                                                                                            : 'bg-green-500/10 text-green-300 border-green-500/30'
                                                                            }`}
                                                                        >
                                                                            {connectorStatus.updating
                                                                                ? connectorStatus.installed ? '后台更新中' : '自动安装中'
                                                                                : connectorStatus.error
                                                                                ? '检查失败'
                                                                                : !connectorStatus.compatible
                                                                                    ? `需要本体 v${connectorStatus.minimumCoreVersion}`
                                                                                    : connectorStatus.updateAvailable
                                                                                        ? connectorStatus.installed ? '有新版本可选' : '缺失时自动安装'
                                                                                        : '已是最新'}
                                                                        </span>
                                                                    </div>
                                                            ) : (
                                                                    <span className="text-[10px] text-gray-500">
                                                                        {connectorChecking ? '正在读取版本...' : '尚未检查版本'}
                                                                    </span>
                                                            )}
                                                        </div>
                                                        <div className="md:col-span-2">
                                                            <div className={`text-xs font-bold ${selected ? 'text-purple-300' : 'text-gray-600'}`}>{player.method}</div>
                                                            <div className="text-[10px] text-gray-500 mt-1">{player.detail}</div>
                                                        </div>
                                                        <div className="md:col-span-3 flex flex-wrap justify-end gap-2">
                                                            {connectorStatus?.updateAvailable && (
                                                                <button
                                                                    disabled={
                                                                        connectorUpdating !== null
                                                                        || connectorStatus.updating === true
                                                                        || connectorStatus.compatible === false
                                                                    }
                                                                    onClick={() => void handleConnectorUpdate(player.connectorId)}
                                                                    className="px-3 py-1.5 bg-cyan-700 hover:bg-cyan-600 text-white text-[11px] rounded-lg font-bold shadow transition-colors border border-cyan-400/40 disabled:opacity-30 disabled:cursor-not-allowed"
                                                                >
                                                                    {reinstalling
                                                                        ? '⏳ 更新中'
                                                                        : connectorStatus.manualUpdateAvailable
                                                                            ? '⚠️ 手动更新'
                                                                            : '⬆️ 立即更新'}
                                                                </button>
                                                            )}
                                                            <button
                                                                disabled={
                                                                    connectorUpdating !== null
                                                                    || connectorStatus?.updating === true
                                                                    || connectorStatus?.compatible === false
                                                                    || connectorStatus?.manualUpdateAvailable === true
                                                                }
                                                                onClick={() => void handleConnectorReinstall(player.connectorId)}
                                                                className="px-3 py-1.5 bg-amber-600 hover:bg-amber-500 text-white text-[11px] rounded-lg font-bold shadow transition-colors border border-amber-400/40 disabled:opacity-30 disabled:cursor-not-allowed"
                                                            >
                                                                {reinstalling
                                                                    ? '⏳ 重新安装中'
                                                                    : automaticallyUpdating
                                                                        ? '⏳ 自动更新中'
                                                                        : '🛠️ 重新安装'}
                                                            </button>
                                                            <button
                                                                disabled={
                                                                    !selected
                                                                    || connecting
                                                                    || connectorUpdating !== null
                                                                    || connectorStatus?.updating === true
                                                                }
                                                                onClick={handleReconnectPlayer}
                                                                className="px-3 py-1.5 bg-purple-600 hover:bg-purple-500 text-white text-[11px] rounded-lg font-bold shadow transition-colors border border-purple-400/50 disabled:opacity-30 disabled:cursor-not-allowed"
                                                            >
                                                                {connecting ? '⏳ 连接中' : '🔄 重新连接'}
                                                            </button>
                                                        </div>
                                                    </div>
                                                );
                                            })}
                                        </div>

                                        {config.config.PlayerType === 'Folia' && (
                                            <div className="bg-pink-500/5 border border-pink-500/20 rounded-lg p-4">
                                                <label className="block text-xs text-pink-300 font-bold mb-2">Folia Stage Token</label>
                                                <input
                                                    type="password"
                                                    value={config.config.FoliaToken || ''}
                                                    onChange={e => setConfig({
                                                        ...config,
                                                        config: {
                                                            ...config.config,
                                                            FoliaToken: e.target.value
                                                        }
                                                    })}
                                                    placeholder={
                                                        config.config.FoliaTokenConfigured
                                                            ? '已配置；输入新 Token 可替换'
                                                            : 'Bearer Token...'
                                                    }
                                                    className="w-full bg-black/40 border border-white/10 rounded-lg p-2.5 text-sm text-white outline-none focus:border-pink-500"
                                                />
                                                <p className="text-[10px] text-gray-500 mt-2">
                                                    Token 仅保存在本机配置中，并只通过本地进程环境交给 Folia 连接器。保存后点击上方“重新连接”，连接本机 32107 端口的 Stage API。
                                                </p>
                                            </div>
                                        )}

                                        <div className="text-xs text-gray-500 mt-2 italic flex gap-2 leading-relaxed">
                                            <span className="shrink-0">💡</span>
                                            <span>
                                                本体会自动补齐缺少的连接器，并每 30 分钟检查新版本。同一播放器兼容分支只提高第三位的补丁会自动更新；第二位提高代表播放器兼容版本变化，只会提示并等待手动确认。跨分支手动更新前会显示目标连接器支持的播放器版本。“重新安装”只用于当前兼容分支的手动修复。
                                            </span>
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

                                    <div className="bg-white/5 p-6 rounded-xl border border-pink-500/20 space-y-5 mb-6">
                                        <div className="border-b border-white/10 pb-3">
                                            <h3 className="text-sm font-bold text-pink-400 uppercase tracking-widest">🎁 礼物点歌次数</h3>
                                            <p className="text-xs text-gray-500 mt-2 leading-relaxed">
                                                可为每档观众指定礼物。每送出 1 个匹配礼物增加 1 次点歌，连续赠送 10 个就增加 10 次；只有歌曲成功加入队列或进入播放后才扣除 1 次。名称和 ID 任一匹配即可，两项都留空表示该档无需礼物。
                                            </p>
                                            <p className="text-xs text-pink-300/70 mt-1.5">
                                                点歌次数仅在本次点歌机运行期间保留；超级用户不受此限制。
                                            </p>
                                        </div>
                                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                            {GIFT_REQUEST_TIER_OPTIONS.map(tier => {
                                                const requirement = config.config.GiftRequestRequirements?.[tier.key] || {
                                                    giftName: '',
                                                    giftId: ''
                                                };
                                                return (
                                                    <div key={tier.key} className="bg-black/25 border border-white/5 rounded-xl p-4 space-y-3">
                                                        <div className={`text-sm font-bold ${tier.accent}`}>{tier.label}</div>
                                                        <div>
                                                            <label className="block text-[11px] text-gray-500 mb-1.5">礼物名称</label>
                                                            <input
                                                                type="text"
                                                                maxLength={80}
                                                                value={requirement.giftName || ''}
                                                                onChange={event => updateGiftRequestRequirement(
                                                                    tier.key,
                                                                    'giftName',
                                                                    event.target.value
                                                                )}
                                                                placeholder="留空表示不按名称限制"
                                                                className={`w-full border rounded-lg p-2.5 text-sm outline-none ${tier.inputClass}`}
                                                            />
                                                        </div>
                                                        <div>
                                                            <label className="block text-[11px] text-gray-500 mb-1.5">礼物 ID（可选）</label>
                                                            <input
                                                                type="text"
                                                                inputMode="numeric"
                                                                maxLength={80}
                                                                value={requirement.giftId || ''}
                                                                onChange={event => updateGiftRequestRequirement(
                                                                    tier.key,
                                                                    'giftId',
                                                                    event.target.value
                                                                )}
                                                                placeholder="可填更稳定的数字 ID"
                                                                className={`w-full border rounded-lg p-2.5 text-sm outline-none ${tier.inputClass}`}
                                                            />
                                                        </div>
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    </div>

                                    <div className="bg-white/5 p-6 rounded-xl border border-white/10 space-y-5 mb-6">
                                        <h3 className="text-sm font-bold text-blue-400 uppercase tracking-widest border-b border-white/10 pb-3">⚙️ 常规参数</h3>
                                        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                                            <div>
                                                <label className="block text-xs text-gray-400 mb-2">空闲时点歌行为</label>
                                                <select
                                                    value={config.config.IdleWaitNext === false ? 'false' : 'true'}
                                                    onChange={e => setConfig({...config, config: {...config.config, IdleWaitNext: e.target.value === 'true'}})}
                                                    className="w-full bg-black/30 border border-white/10 rounded-lg p-2.5 text-md text-white focus:border-blue-500 outline-none cursor-pointer"
                                                >
                                                    <option value="true">登记播放器下一首守卫（等当前播完）</option>
                                                    <option value="false">立即强行切歌播放</option>
                                                </select>
                                            </div>

                                            <div>
                                                <label className="block text-xs text-gray-400 mb-2">点歌全部播完后</label>
                                                <select
                                                    value={config.config.PauseAfterRequests === true ? 'pause' : 'continue'}
                                                    onChange={e => setConfig({...config, config: {...config.config, PauseAfterRequests: e.target.value === 'pause'}})}
                                                    className="w-full bg-black/30 border border-white/10 rounded-lg p-2.5 text-md text-white focus:border-blue-500 outline-none cursor-pointer"
                                                >
                                                    <option value="continue">继续播放主播歌单（默认）</option>
                                                    <option
                                                        value="pause"
                                                        disabled={config.playerSnapshot?.capabilities?.pause === false}
                                                    >
                                                        最后一首点歌结束后暂停播放器
                                                    </option>
                                                </select>
                                                {config.playerSnapshot?.capabilities?.pause === false && (
                                                    <span className="text-xs text-yellow-400 block mt-1.5">
                                                        当前播放器连接器无法保证明确暂停，将继续播放主播歌单。
                                                    </span>
                                                )}
                                            </div>

                                            <div className="flex flex-col justify-center pt-3">
                                                <div className="flex justify-between items-center gap-4 bg-black/30 border border-white/10 rounded-lg p-3">
                                                    <div>
                                                        <label className="block text-sm text-white font-medium">显示播放器当前歌曲</label>
                                                        <span className="text-xs text-gray-500 block mt-1">没有点歌时，以淡蓝色卡片显示主播歌单歌曲</span>
                                                    </div>
                                                    <button onClick={() => setConfig({...config, config: {...config.config, ShowPlayerCurrentTrack: !config.config.ShowPlayerCurrentTrack}})} className={`w-10 h-6 rounded-full p-1 transition-colors shrink-0 ${config.config.ShowPlayerCurrentTrack ? 'bg-blue-600' : 'bg-gray-600'}`}>
                                                        <div className={`w-4 h-4 rounded-full bg-white transition-transform ${config.config.ShowPlayerCurrentTrack ? 'translate-x-4' : 'translate-x-0'}`}></div>
                                                    </button>
                                                </div>
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

                                    <div className="bg-white/5 p-6 rounded-xl border border-cyan-500/20 space-y-5 mb-6">
                                        <div className="border-b border-white/10 pb-3">
                                            <h3 className="text-sm font-bold text-cyan-400 uppercase tracking-widest">🔌 外部只读接口</h3>
                                            <p className="text-xs text-gray-500 mt-2">供 OBS 插件或其他工具读取当前歌曲与待播队列，仅监听本机 127.0.0.1。</p>
                                        </div>
                                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                            <div className="flex justify-between items-center bg-black/30 border border-white/10 rounded-lg p-3">
                                                <div>
                                                    <label className="block text-sm text-white font-medium">HTTP API</label>
                                                    <span className="text-xs text-gray-500">GET /api/v1/state</span>
                                                </div>
                                                <button onClick={() => setConfig({...config, config: {...config.config, ExternalHttpEnabled: !config.config.ExternalHttpEnabled}})} className={`w-10 h-6 rounded-full p-1 transition-colors ${config.config.ExternalHttpEnabled ? 'bg-cyan-600' : 'bg-gray-600'}`}>
                                                    <div className={`w-4 h-4 rounded-full bg-white transition-transform ${config.config.ExternalHttpEnabled ? 'translate-x-4' : 'translate-x-0'}`}></div>
                                                </button>
                                            </div>
                                            <div className="flex justify-between items-center bg-black/30 border border-white/10 rounded-lg p-3">
                                                <div>
                                                    <label className="block text-sm text-white font-medium">WebSocket 推送</label>
                                                    <span className="text-xs text-gray-500">状态变化时推送 /ws</span>
                                                </div>
                                                <button onClick={() => setConfig({...config, config: {...config.config, ExternalWebSocketEnabled: !config.config.ExternalWebSocketEnabled}})} className={`w-10 h-6 rounded-full p-1 transition-colors ${config.config.ExternalWebSocketEnabled ? 'bg-cyan-600' : 'bg-gray-600'}`}>
                                                    <div className={`w-4 h-4 rounded-full bg-white transition-transform ${config.config.ExternalWebSocketEnabled ? 'translate-x-4' : 'translate-x-0'}`}></div>
                                                </button>
                                            </div>
                                        </div>
                                        <div>
                                            <label className="block text-xs text-gray-400 mb-2">本地监听端口</label>
                                            <input
                                                type="number"
                                                min="1024"
                                                max="65535"
                                                value={config.config.ExternalApiPort || 5556}
                                                onChange={e => setConfig({...config, config: {...config.config, ExternalApiPort: parseInt(e.target.value) || 5556}})}
                                                className="w-32 bg-black/30 border border-white/10 rounded-lg p-2.5 text-sm text-white focus:border-cyan-500 outline-none"
                                            />
                                            <div className="text-xs text-gray-500 mt-2 font-mono break-all">
                                                HTTP: http://127.0.0.1:{config.config.ExternalApiPort || 5556}/api/v1/state<br/>
                                                WebSocket: ws://127.0.0.1:{config.config.ExternalApiPort || 5556}/ws<br/>
                                                OBS 示例: http://127.0.0.1:{config.config.ExternalApiPort || 5556}/overlay/
                                            </div>
                                        </div>
                                    </div>

                                    <div className={`bg-white/5 p-6 rounded-xl border border-white/10 space-y-5 mb-6 relative ${!config.biliLogin ? 'opacity-50' : ''}`}>
                                        <h3 className="text-sm font-bold text-yellow-400 uppercase tracking-widest border-b border-white/10 pb-3">👑 超级用户白名单</h3>
                                        <p className="text-sm text-gray-500">在下方名单中的 B站用户名，将完全无视冷却时间和任何点歌、切歌权限限制。</p>
                                        {!config.biliLogin && <div className="text-xs text-yellow-300 bg-yellow-500/10 border border-yellow-500/20 rounded-lg p-3">游客模式下不可用，请先扫码登录。</div>}

                                        <div className="flex gap-3">
                                            <input
                                                disabled={!config.biliLogin}
                                                type="text"
                                                value={superUserInput}
                                                onChange={e => setSuperUserInput(e.target.value)}
                                                onKeyDown={e => e.key === 'Enter' && addSuperUser()}
                                                className="flex-1 bg-black/30 border border-white/10 rounded-lg p-2.5 text-md text-white focus:border-blue-500 outline-none"
                                                placeholder="输入需要特权的 B站完整用户名..."
                                            />
                                            <button disabled={!config.biliLogin} onClick={addSuperUser} className="px-6 py-2.5 bg-yellow-600 hover:bg-yellow-500 text-white text-md rounded-lg font-bold transition-colors disabled:cursor-not-allowed">添加</button>
                                        </div>

                                        <div className="flex flex-wrap gap-3 mt-3">
                                            {!(config.config.SuperUsers?.length > 0) ? (
                                                <span className="text-sm text-gray-600 italic">暂无超级用户</span>
                                            ) : (
                                                config.config.SuperUsers.map((su: string) => (
                                                    <div key={su} className="bg-white/10 border border-white/20 text-white px-3 py-1.5 rounded-lg text-sm flex items-center gap-2">
                                                        <span>{su}</span>
                                                        <button disabled={!config.biliLogin} onClick={() => removeSuperUser(su)} className="text-red-400 hover:text-red-300 font-bold ml-1 disabled:cursor-not-allowed">✕</button>
                                                    </div>
                                                ))
                                            )}
                                        </div>
                                    </div>

                                    <div ref={permissionSetupRef} className={`bg-white/5 p-6 rounded-xl border border-white/10 scroll-mt-4 ${!config.biliLogin ? 'opacity-50' : ''}`}>
                                        <h3 className="text-sm font-bold text-green-400 uppercase tracking-widest border-b border-white/10 pb-3 mb-5">🛡️ 弹幕指令权限控制</h3>
                                        {!config.biliLogin && <div className="text-xs text-yellow-300 bg-yellow-500/10 border border-yellow-500/20 rounded-lg p-3 mb-5">游客模式固定使用基础权限，以下自定义设置暂不可用。</div>}

                                        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                                            {permTypes.map(pt => {
                                                const pData = config.config[pt.key] || { AllowManager: true, MinGuardType: (pt.key === 'ForceControlPermission' ? -1 : 0), MinMedalLevel: 0 };

                                                return (
                                                    <div key={pt.key} className="bg-black/40 border border-white/5 p-4 rounded-xl flex flex-col gap-4">
                                                        <div className="font-bold text-white text-md border-b border-white/5 pb-2">{pt.label}</div>

                                                        <div className="flex justify-between items-center">
                                                            <span className="text-sm text-gray-300">允许房管无视限制</span>
                                                            <button disabled={!config.biliLogin} onClick={() => updatePermission(pt.key, 'AllowManager', !pData.AllowManager)} className={`w-10 h-6 rounded-full p-1 transition-colors disabled:cursor-not-allowed ${pData.AllowManager ? 'bg-green-600' : 'bg-gray-600'}`}>
                                                                <div className={`w-4 h-4 rounded-full bg-white transition-transform ${pData.AllowManager ? 'translate-x-4' : 'translate-x-0'}`}></div>
                                                            </button>
                                                        </div>

                                                        <div>
                                                            <label className="block text-xs text-gray-500 mb-1.5">最低航海舰队要求</label>
                                                            <select
                                                                disabled={!config.biliLogin}
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
                                                                disabled={!config.biliLogin}
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

                            {activeTab === 'feedback' && (
                                <div className="animate-slide-in-right pb-10 space-y-6">
                                    <div>
                                        <h2 className="text-2xl font-bold text-white mb-2">问题反馈</h2>
                                        <p className="text-sm text-gray-400 leading-relaxed">
                                            在这里提交软件问题、播放器兼容性或功能建议。版本和连接器状态会在你确认后附带，登录 Cookie、二维码凭据、用户白名单和房间号不会上传。
                                        </p>
                                    </div>

                                    <div className="rounded-xl border border-violet-400/20 bg-violet-500/[0.06] p-5 space-y-4">
                                        <div className="flex flex-wrap items-start justify-between gap-3">
                                            <div>
                                                <div className="flex items-center gap-2 font-bold text-violet-200">
                                                    <span>📮</span>
                                                    <span>我提交过的反馈</span>
                                                    {feedbackUnreadCount > 0 && (
                                                        <span className="rounded-full bg-red-500/20 px-2 py-0.5 text-[10px] text-red-300 ring-1 ring-red-400/30">
                                                            {feedbackUnreadCount} 条新回复
                                                        </span>
                                                    )}
                                                </div>
                                                <div className="mt-1 text-xs leading-relaxed text-gray-500">
                                                    编号、标题和公开回复暂存在本机，不保存问题描述、联系方式或诊断信息。
                                                </div>
                                            </div>
                                            <div className="flex gap-2">
                                                <button
                                                    type="button"
                                                    disabled={feedbackHistoryRefreshing || feedbackHistory.length === 0}
                                                    onClick={() => void refreshFeedbackHistory(true)}
                                                    className="rounded-lg border border-violet-400/25 bg-violet-500/10 px-3 py-2 text-xs font-bold text-violet-200 transition hover:bg-violet-500/20 disabled:opacity-40"
                                                >
                                                    {feedbackHistoryRefreshing ? '刷新中…' : '刷新回复'}
                                                </button>
                                                {feedbackHistory.length > 0 && (
                                                    <button
                                                        type="button"
                                                        onClick={() => {
                                                            if (window.confirm('只清除这台电脑保存的反馈历史吗？服务器上的反馈不会删除。')) {
                                                                persistFeedbackHistory([]);
                                                            }
                                                        }}
                                                        className="rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs text-gray-400 transition hover:bg-white/10 hover:text-white"
                                                    >
                                                        清除本地记录
                                                    </button>
                                                )}
                                            </div>
                                        </div>

                                        {feedbackHistory.length === 0 ? (
                                            <div className="rounded-lg border border-dashed border-white/10 bg-black/15 px-4 py-5 text-center text-xs text-gray-500">
                                                在点歌机里成功提交反馈后，会自动保存问题编号并在这里检查回复。
                                            </div>
                                        ) : (
                                            <div className="max-h-96 space-y-2 overflow-y-auto pr-1 custom-scrollbar">
                                                {feedbackHistory.map(item => (
                                                    <details
                                                        key={item.id}
                                                        onToggle={event => {
                                                            if (event.currentTarget.open && item.unreadReply) {
                                                                markFeedbackHistoryItemRead(item.id);
                                                            }
                                                        }}
                                                        className={`group rounded-lg border bg-black/20 ${item.unreadReply ? 'border-red-400/35' : 'border-white/10'}`}
                                                    >
                                                        <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-3 [&::-webkit-details-marker]:hidden">
                                                            <span className={`h-2 w-2 shrink-0 rounded-full ${item.unreadReply ? 'bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.8)]' : item.reply ? 'bg-green-400' : 'bg-gray-600'}`}></span>
                                                            <span className="min-w-0 flex-1">
                                                                <span className="block truncate text-sm font-bold text-gray-100">{item.title}</span>
                                                                <span className="mt-0.5 block truncate text-[10px] text-gray-500">
                                                                    {item.id} · {formatFeedbackTime(item.submittedAt)}
                                                                </span>
                                                            </span>
                                                            <span className="shrink-0 rounded-full border border-cyan-400/20 bg-cyan-500/10 px-2 py-1 text-[10px] text-cyan-300">
                                                                {FEEDBACK_STATUS_LABELS[item.status] || item.status}
                                                            </span>
                                                            <span className="shrink-0 text-xs text-gray-500 transition-transform group-open:rotate-90">›</span>
                                                        </summary>
                                                        <div className="space-y-3 border-t border-white/[0.06] px-4 py-3">
                                                            {item.reply ? (
                                                                <div className="whitespace-pre-wrap rounded-lg border border-green-400/20 bg-green-500/[0.08] p-3 text-xs leading-relaxed text-green-100">
                                                                    <div className="mb-1 font-bold text-green-400">处理回复</div>
                                                                    {item.reply}
                                                                </div>
                                                            ) : (
                                                                <div className="text-xs text-gray-500">暂时还没有公开回复，可以稍后刷新查看。</div>
                                                            )}
                                                            <div className="flex flex-wrap items-center justify-between gap-3 text-[10px] text-gray-600">
                                                                <span>{item.lastCheckedAt ? `上次查询：${formatFeedbackTime(item.lastCheckedAt)}` : '尚未查询处理进度'}</span>
                                                                <a href={item.trackingUrl} target="_blank" rel="noreferrer" className="font-bold text-cyan-400 hover:text-cyan-300">在网页查看 ↗</a>
                                                            </div>
                                                        </div>
                                                    </details>
                                                ))}
                                            </div>
                                        )}
                                    </div>

                                    <div className="bg-white/5 p-6 rounded-xl border border-white/10 space-y-5">
                                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                            <div>
                                                <label className="block text-xs text-gray-400 mb-2">反馈类型</label>
                                                <select value={feedbackForm.category} onChange={event => setFeedbackForm(previous => ({...previous, category: event.target.value}))} className="w-full bg-black/40 border border-white/10 rounded-lg p-3 text-sm text-white outline-none">
                                                    <option value="bug">软件问题</option>
                                                    <option value="connector">连接器问题</option>
                                                    <option value="compatibility">播放器兼容性</option>
                                                    <option value="feature">功能建议</option>
                                                    <option value="other">其他</option>
                                                </select>
                                            </div>
                                            <div>
                                                <label className="block text-xs text-gray-400 mb-2">影响程度</label>
                                                <select value={feedbackForm.priority} onChange={event => setFeedbackForm(previous => ({...previous, priority: event.target.value}))} className="w-full bg-black/40 border border-white/10 rounded-lg p-3 text-sm text-white outline-none">
                                                    <option value="normal">一般</option>
                                                    <option value="high">严重影响使用</option>
                                                    <option value="critical">完全无法使用</option>
                                                    <option value="low">轻微</option>
                                                </select>
                                            </div>
                                        </div>

                                        <div>
                                            <label className="block text-xs text-gray-400 mb-2">标题</label>
                                            <input value={feedbackForm.title} maxLength={120} onChange={event => setFeedbackForm(previous => ({...previous, title: event.target.value}))} placeholder="例如：网易云更新后无法插入下一首" className="w-full bg-black/40 border border-white/10 rounded-lg p-3 text-sm text-white outline-none focus:border-blue-500/70" />
                                        </div>
                                        <div>
                                            <label className="block text-xs text-gray-400 mb-2">详细描述</label>
                                            <textarea value={feedbackForm.description} maxLength={8000} onChange={event => setFeedbackForm(previous => ({...previous, description: event.target.value}))} placeholder="请写清复现步骤、预期结果和实际结果" className="w-full min-h-40 bg-black/40 border border-white/10 rounded-lg p-3 text-sm text-white outline-none focus:border-blue-500/70 resize-y" />
                                        </div>
                                        <div>
                                            <label className="block text-xs text-gray-400 mb-2">联系方式（可选）</label>
                                            <input value={feedbackForm.contact} maxLength={200} onChange={event => setFeedbackForm(previous => ({...previous, contact: event.target.value}))} placeholder="邮箱、GitHub 或其他联系方式" className="w-full bg-black/40 border border-white/10 rounded-lg p-3 text-sm text-white outline-none" />
                                        </div>
                                    </div>

                                    <div className="bg-cyan-500/5 p-5 rounded-xl border border-cyan-500/20 space-y-4">
                                        <div className="flex items-center justify-between gap-4">
                                            <div>
                                                <div className="font-bold text-cyan-300">诊断信息</div>
                                                <div className="text-xs text-gray-400 mt-1">包含本体、系统、播放器与四个连接器版本，以及队列数量和连接状态。</div>
                                            </div>
                                            <button onClick={() => setFeedbackIncludeDiagnostics(previous => !previous)} className={`w-11 h-6 rounded-full p-1 transition-colors shrink-0 ${feedbackIncludeDiagnostics ? 'bg-cyan-600' : 'bg-gray-600'}`}>
                                                <div className={`w-4 h-4 rounded-full bg-white transition-transform ${feedbackIncludeDiagnostics ? 'translate-x-5' : 'translate-x-0'}`}></div>
                                            </button>
                                        </div>
                                        <label className={`flex items-center gap-3 text-sm ${feedbackIncludeDiagnostics ? 'text-gray-300' : 'text-gray-600'}`}>
                                            <input type="checkbox" disabled={!feedbackIncludeDiagnostics} checked={feedbackIncludeLogs} onChange={event => setFeedbackIncludeLogs(event.target.checked)} className="w-4 h-4" />
                                            同时附带最近 80 条运行日志（令牌、Cookie 等字段会自动隐藏）
                                        </label>
                                        {feedbackIncludeDiagnostics && (
                                            <details className="bg-black/30 rounded-lg border border-white/5">
                                                <summary className="cursor-pointer px-4 py-3 text-xs text-cyan-300 font-bold">
                                                    {feedbackLoading ? '正在刷新诊断…' : '预览将要提交的诊断信息'}
                                                </summary>
                                                <pre className="px-4 pb-4 text-[11px] leading-relaxed text-gray-400 overflow-auto max-h-72 whitespace-pre-wrap break-all">
                                                    {JSON.stringify(feedbackDiagnostics?.diagnostics || {}, null, 2)}
                                                </pre>
                                            </details>
                                        )}
                                    </div>

                                    {feedbackResult && (
                                        <div className="bg-green-500/10 border border-green-500/30 rounded-xl p-5 text-sm text-green-200">
                                            <div className="font-bold text-green-400 mb-1">反馈提交成功：{feedbackResult.id}</div>
                                            <div className="text-xs text-gray-400 mb-3">请保存编号；处理进度与公开回复可以随时查询。</div>
                                            <a href={feedbackResult.trackingUrl} target="_blank" rel="noreferrer" className="inline-block px-4 py-2 rounded-lg bg-green-600/30 border border-green-500/40 hover:bg-green-600/40">打开反馈进度页</a>
                                        </div>
                                    )}

                                    <div className="flex flex-wrap gap-3">
                                        <button disabled={feedbackSubmitting || feedbackLoading} onClick={handleFeedbackSubmit} className="px-6 py-3 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-xl text-sm font-bold transition-colors">
                                            {feedbackSubmitting ? '正在提交…' : '提交反馈'}
                                        </button>
                                        <a href="https://app.enkianss.us/feedback" target="_blank" rel="noreferrer" className="px-6 py-3 bg-white/5 hover:bg-white/10 border border-white/10 text-gray-300 rounded-xl text-sm font-bold transition-colors">
                                            使用网页提交
                                        </a>
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
                                            <div className="mb-6 w-full bg-cyan-500/10 border border-cyan-500/30 p-4 rounded-xl text-cyan-200 font-medium text-sm leading-relaxed">
                                                当前为游客模式，可直接使用普通点歌。扫码登录是可选项，用于启用超级用户白名单和自定义权限控制。
                                            </div>
                                        )}

                                        {qrState.base64 ? (
                                            <div className="bg-white p-3 rounded-2xl shadow-2xl mb-6"><img src={qrState.base64} alt="Bilibili Login QR" className="w-48 h-48" /></div>
                                        ) : (
                                            <div className="w-48 h-48 bg-black/30 rounded-2xl mb-6 flex items-center justify-center text-6xl border border-white/5">📱</div>
                                        )}

                                        <h3 className="text-md text-white font-bold mb-5">{qrState.message}</h3>
                                        <div className={`grid gap-3 w-full ${config.biliLogin ? 'grid-cols-2' : 'grid-cols-1'}`}>
                                            <button onClick={startQrLogin} disabled={qrState.loading} className="px-5 py-3 bg-[#fb7299] hover:bg-[#ff85a8] text-white text-sm rounded-xl font-bold shadow-lg disabled:opacity-50 transition-colors w-full">
                                                {config.biliLogin ? '扫码更换账号' : (qrState.loading ? '正在获取...' : '点击获取登录二维码')}
                                            </button>
                                            {config.biliLogin && (
                                                <button onClick={logoutBili} className="px-5 py-3 bg-red-600/20 hover:bg-red-600/35 border border-red-500/40 text-red-300 text-sm rounded-xl font-bold shadow-lg transition-colors w-full">
                                                    退出当前账号
                                                </button>
                                            )}
                                        </div>

                                        <p className="text-xs text-gray-500 mt-4 leading-relaxed">
                                            登录凭据仅保存在本地。需要白名单或权限分级时，扫码登录<strong className="text-pink-400">任意普通B站账号</strong>即可，不要求必须是主播账号。
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
                                                    <span>🚀 {updateDownloadStatus?.message || '正在下载更新'}</span>
                                                    <span>{Math.floor(downloadProgress)}%</span>
                                                </div>
                                                <div className="w-full bg-black/50 h-3 rounded-full overflow-hidden">
                                                    <div
                                                        className="bg-green-500 h-full transition-all duration-300 ease-out"
                                                        style={{ width: `${downloadProgress}%` }}
                                                    ></div>
                                                </div>
                                                <div className="text-xs text-green-400/70 mt-3 text-center">这里显示安装器返回的真实下载进度；完成后程序将自动重启</div>
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

const App: React.FC = () => {
    const params = new URLSearchParams(window.location.search);
    const isAdmin = params.get('admin') === 'true';

    if (isAdmin) {
        return (
            <>
                <GlobalStyles />
                <div style={{ background: '#0d1117', minHeight: '100vh' }}>
                    <AdminWidget />
                </div>
            </>
        );
    }

    return (
        <>
            <GlobalStyles />
            <OverlayWidget
                onToggleAdmin={() => {
                    if (isElectron) electronAPI?.openAdmin();
                }}
                onOpenAppearance={() => {
                    if (isElectron) electronAPI?.openAdmin('appearance');
                }}
            />
        </>
    );
};

export default App;
