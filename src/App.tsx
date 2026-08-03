import React, { useState, useEffect, useRef, useCallback } from 'react';

// ==========================================
// 0. 环境检测
// ==========================================
const isElectron = new URLSearchParams(window.location.search).get('mode') === 'electron';

const electronAPI = isElectron ? window.electronAPI : undefined;

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

interface QrState {
    loading: boolean;
    base64: string;
    message: string;
}

type NativeConnectorId = 'netease' | 'kugou' | 'qqmusic' | 'folia';

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
    const [data, setData] = useState<{ current: SongInfo | null; currentIsRequested: boolean; playerPausedAfterRequests: boolean; requestedSongArtwork: RequestedSongArtwork; queue: SongInfo[]; status: string }>({ current: null, currentIsRequested: false, playerPausedAfterRequests: false, requestedSongArtwork: 'bili_avatar', queue: [], status: '' });
    const [isConnected, setIsConnected] = useState<boolean>(true);
    const [isCdpConnected, setIsCdpConnected] = useState<boolean>(true);
    const [accepting, setAccepting] = useState<boolean>(true);
    const [playing, setPlaying] = useState<boolean>(true);

    const [rejects, setRejects] = useState<any[]>([]);
    const [, setPrevQueue] = useState<SongInfo[]>([]);
    const [newItemsIds, setNewItemsIds] = useState<Set<string>>(new Set());

    const [dragInfo, setDragInfo] = useState<DragInfo | null>(null);
    const [showSettings, setShowSettings] = useState<boolean>(false);
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
        const isFirstTime = localStorage.getItem('bili-first-launch') === null;
        if (isFirstTime && isElectron) {
            localStorage.setItem('bili-first-launch', 'false');
            setTimeout(() => {
                triggerToast("🎉 欢迎使用！已自动为您打开控制面板。如果您关闭了它，可随时点击右上角的 ⚙️ 按钮呼出！");
                electronAPI?.openAdmin();
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
        if (isElectron) electronAPI?.closeWindow();
        else { fetch('http://localhost:5555/api/exit', { method: 'POST' }); window.close(); }
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

                        <div className="flex items-center relative h-6 flex-1 justify-end min-w-0">
                            <div
                                className={`absolute right-0 text-xs font-medium max-w-[150px] truncate pointer-events-none transition-all duration-150 ${isElectron && titleBarActionsOpen ? '-translate-x-[118px] opacity-50' : ''} ${getStatusAnimation(data.status)}`}
                                style={{ color: !isConnected ? theme.subTextColor : getStatusColor(data.status) }}
                            >
                                {!isConnected ? '等待后端...' : (data.status || '点歌就绪')}
                            </div>

                            {isElectron && (
                                <div
                                    onMouseEnter={() => setTitleBarActionsOpen(true)}
                                    onMouseLeave={() => setTitleBarActionsOpen(false)}
                                    className={`no-drag absolute right-0 top-1/2 -translate-y-1/2 h-8 overflow-hidden z-20 transition-[width] duration-150 ease-out ${titleBarActionsOpen ? 'w-[116px]' : 'w-8'}`}
                                >
                                    <div className={`ml-auto flex h-full w-[112px] items-center justify-end gap-2 transition-all duration-150 ${titleBarActionsOpen ? 'translate-x-0 opacity-100' : 'translate-x-2 opacity-0 pointer-events-none'}`}>
                                        <button onMouseDown={e => e.stopPropagation()} onClick={onToggleAdmin} className="no-drag text-white/60 hover:text-white transition-colors cursor-pointer text-sm" title="控制面板">⚙️</button>
                                        <button onMouseDown={e => e.stopPropagation()} onClick={() => setShowSettings(!showSettings)} className="no-drag text-white/60 hover:text-white transition-colors cursor-pointer text-sm" title="外观设置">🎨</button>
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

const AdminWidget: React.FC = () => {
    const [config, setConfig] = useState<any>(null);
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

    const showAdminToast = useCallback((msg: string) => {
        setAdminToast(msg);
        setTimeout(() => setAdminToast(''), 3000);
    }, []);

    const loadConnectorStatuses = useCallback(async (forceRefresh = false) => {
        setConnectorChecking(true);
        setConnectorStatusError('');
        try {
            const suffix = forceRefresh ? '?refresh=1' : '';
            const response = await fetch(
                `http://localhost:5555/api/connectors/status${suffix}`
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

    const activeTabRef = useRef<string>(activeTab);
    useEffect(() => { activeTabRef.current = activeTab; }, [activeTab]);

    useEffect(() => {
        if (activeTab !== 'settings') return;
        void loadConnectorStatuses(false);
        const timer = setInterval(
            () => void loadConnectorStatuses(false),
            10_000
        );
        return () => clearInterval(timer);
    }, [activeTab, loadConnectorStatuses]);

    const isInitialConfigLoad = useRef(true);
    const lastConfigString = useRef('');

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
            fetch('http://localhost:5555/api/config', {
                method: 'POST',
                headers: {'Content-Type':'application/json'},
                body: JSON.stringify({ sysConfig: config.config })
            }).then(res => {
                if (res.ok) showAdminToast("✅ 基础设置已自动保存！");
            }).catch(() => {});
        }, 800);

        return () => clearTimeout(timer);
    }, [config, showAdminToast]);

    useEffect(() => {
        if (activeTab !== 'login') return;
        const fetchQr = async () => {
            try {
                const res = await fetch('http://localhost:5555/api/bili/qrstatus');
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
            const res = await fetch('http://localhost:5555/api/room', {
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
                    'http://localhost:5555/api/config'
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
            const res = await fetch('http://localhost:5555/api/sys/reconnect_player', { method: 'POST' });
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
                'http://localhost:5555/api/connectors/update',
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
                if (!selectedConnected) {
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
                    ? '⚠️ 连接器已更新，后台正在等待播放器连接。'
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
                'http://localhost:5555/api/connectors/reinstall',
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
                if (!selectedConnected) {
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
                showAdminToast('✅ 连接器重新安装完成，正在切换并连接播放器...');
                await handleSetPlayerType(playerTypeByConnector[connectorId]);
            } else {
                showAdminToast(
                    selectedConnected
                        ? `✅ ${result.status?.name || '播放器'}连接器已重新安装并自动连接！`
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

    const loadFeedbackDiagnostics = useCallback(async (includeLogs = false) => {
        setFeedbackLoading(true);
        try {
            const response = await fetch(
                'http://localhost:5555/api/feedback/diagnostics'
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
    }, [
        activeTab,
        feedbackIncludeLogs,
        loadFeedbackDiagnostics
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

        setFeedbackSubmitting(true);
        setFeedbackResult(null);
        try {
            const response = await fetch(
                'http://localhost:5555/api/feedback/submit',
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
            const res = await fetch('http://localhost:5555/api/bili/logout', { method: 'POST' });
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

    const handleSetPlayerType = async (type: string) => {
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
            const res = await fetch('http://localhost:5555/api/config', {
                method: 'POST',
                headers: {'Content-Type':'application/json'},
                body: JSON.stringify({ sysConfig: nextSysConfig })
            });
            const json = await res.json();
            const connected = json.playerConnected === true
                || await waitForPlayerConnection();
            setConfig((prev: any) => prev ? ({
                ...prev,
                playerConnected: connected,
                cdpConnected: connected,
                playerConnecting: connected
                    ? false
                    : json.playerConnecting === true
            }) : prev);
            if (connected) showAdminToast("✅ 已切换并自动连接播放器！");
            else showAdminToast("⚠️ 已切换播放器，后台正在等待连接。");
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
                        { id: 'feedback', icon: '💬', label: '问题反馈' },
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
                                    <div className="bg-white/5 p-6 rounded-xl border border-purple-500/40 space-y-5 mb-6 shadow-[0_0_15px_rgba(168,85,247,0.15)] relative overflow-hidden">
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
                                                                    <span className={`inline-flex text-[10px] px-2.5 py-1 rounded-full font-bold shadow-md ${connecting ? 'bg-yellow-500/20 text-yellow-300 border border-yellow-500/30' : connected ? 'bg-green-500/20 text-green-400 border border-green-500/30' : 'bg-red-500/20 text-red-400 border border-red-500/30'}`}>
                                                                        {connecting ? '⏳ 连接中' : connected ? '✅ 已连接' : '❌ 未连接'}
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

                                            <div>
                                                <label className="block text-xs text-gray-400 mb-2">点歌图片显示</label>
                                                <select
                                                    value={config.config.RequestedSongArtwork === 'song_cover' ? 'song_cover' : 'bili_avatar'}
                                                    onChange={e => setConfig({...config, config: {...config.config, RequestedSongArtwork: e.target.value}})}
                                                    className="w-full bg-black/30 border border-white/10 rounded-lg p-2.5 text-md text-white focus:border-blue-500 outline-none cursor-pointer"
                                                >
                                                    <option value="bili_avatar">B站点歌人头像（默认）</option>
                                                    <option value="song_cover">播放器歌曲封面</option>
                                                </select>
                                                <span className="text-xs text-gray-500 block mt-1.5">主播歌单始终显示歌曲封面</span>
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

                                    <div className={`bg-white/5 p-6 rounded-xl border border-white/10 ${!config.biliLogin ? 'opacity-50' : ''}`}>
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
            <OverlayWidget onToggleAdmin={() => {
                if (isElectron) electronAPI?.openAdmin();
            }}/>
        </>
    );
};

export default App;
