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
    const [isCdpConnected, setIsCdpConnected] = useState<boolean>(true); // ⭐ 新增：挂件自身的 CDP 连接状态感知
    const [accepting, setAccepting] = useState<boolean>(true);
    const [playing, setPlaying] = useState<boolean>(true);

    const [rejects, setRejects] = useState<any[]>([]);
    const [, setPrevQueue] = useState<SongInfo[]>([]);
    const [newItemsIds, setNewItemsIds] = useState<Set<string>>(new Set());

    const [dragInfo, setDragInfo] = useState<DragInfo | null>(null);
    const [showSettings, setShowSettings] = useState<boolean>(false);

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

                // ⭐ 捕获最新注入状态
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
        if (!isElectron) return;
        try {
            await fetch('http://localhost:5555/api/queue/action', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action, ...payload })
            });
        } catch(err) { console.error("操作失败", err); } // ⭐ 修复 TS6133
    };

    const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>, type: 'current' | 'queue', index: number, item: SongInfo) => {
        if (!isElectron) return;
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
        if (!isElectron) return;
        e?.stopPropagation?.();
        try {
            await fetch('http://localhost:5555/api/state/toggle', { method: 'POST' });
            setAccepting(!accepting);
        } catch(err) { console.error(err); } // ⭐ 修复 TS6133
    };

    const togglePlaying = async (e?: React.MouseEvent) => {
        if (!isElectron) return;
        e?.stopPropagation?.();
        try {
            await fetch('http://localhost:5555/api/state/toggle_play', { method: 'POST' });
            setPlaying(!playing);
        } catch(err) { console.error(err); } // ⭐ 修复 TS6133
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
                                className={`flex items-center justify-center w-5 h-5 rounded-full transition-colors ${isElectron ? 'pointer-events-auto cursor-pointer no-drag' : 'pointer-events-none'} ${playing ? (isElectron ? 'bg-green-500/20 text-green-400 hover:bg-green-500/40' : 'bg-green-500/20 text-green-400') : (isElectron ? 'bg-red-500/20 text-red-400 hover:bg-red-500/40' : 'bg-red-500/20 text-red-400')}`}
                                title={isElectron ? (playing ? '点击暂停自动播放' : '点击开启自动播放') : undefined}
                            >
                                <span className="text-[10px] leading-none">{playing ? '🟢' : '🔴'}</span>
                            </button>
                            <h1 className="font-bold text-[15px] tracking-wide pointer-events-none whitespace-nowrap shrink-0" style={{ color: theme.titleColor }}>直播点歌机</h1>
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
                            className={`${isElectron ? 'no-drag cursor-move' : ''} current-zone glass-card rounded-xl p-4 flex items-center gap-4 relative overflow-hidden shrink-0 transition-opacity ${dragInfo?.type === 'current' ? 'opacity-30' : ''}`}
                            style={{ touchAction: 'none' }}
                            onPointerDown={isElectron ? (e) => handlePointerDown(e, 'current', -1, data.current as SongInfo) : undefined}
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
                                    {/* ⭐ 未注入时的红色警告提示 */}
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
                                className={`flex items-center justify-center w-5 h-5 rounded-full transition-colors ${isElectron ? 'no-drag pointer-events-auto cursor-pointer' : 'pointer-events-none'} ${accepting ? (isElectron ? 'bg-green-500/20 text-green-400 hover:bg-green-500/40' : 'bg-green-500/20 text-green-400') : (isElectron ? 'bg-red-500/20 text-red-400 hover:bg-red-500/40' : 'bg-red-500/20 text-red-400')}`}
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
                                    onPointerDown={isElectron ? (e) => handlePointerDown(e, 'queue', index, song) : undefined}
                                    className={`${isElectron ? 'no-drag cursor-move' : ''} queue-item glass-card rounded-lg flex items-center gap-3 transition-all hover:bg-white/10 relative group/item ${isNew ? 'animate-slide-in' : ''} ${dragInfo?.type === 'queue' && dragInfo.index === index ? 'opacity-30' : ''} ${theme.compactQueue ? 'p-1.5' : 'p-2.5'}`}
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

const AdminWidget: React.FC<AdminWidgetProps> = ({ onClose: _onClose }) => {
    const [config, setConfig] = useState<any>(null);
    const [activeTab, setActiveTab] = useState<string>('settings');

    const [updateInfo, setUpdateInfo] = useState<UpdateInfo>({ checking: false, info: null });
    const [qrState, setQrState] = useState<QrState>({ loading: false, base64: '', message: '' });
    const [roomIdInput, setRoomIdInput] = useState<string>('');
    const [sysLogs, setSysLogs] = useState<SysLog[]>([]);
    const logsEndRef = useRef<HTMLDivElement>(null);

    const [superUserInput, setSuperUserInput] = useState<string>('');
    const [debugInput, setDebugInput] = useState<string>('');

    const [adminToast, setAdminToast] = useState<string>('');
    const showAdminToast = (msg: string) => {
        setAdminToast(msg);
        setTimeout(() => setAdminToast(''), 3000);
    };

    const activeTabRef = useRef<string>(activeTab);
    useEffect(() => { activeTabRef.current = activeTab; }, [activeTab]);

    const isInitialConfigLoad = useRef(true);
    const lastConfigString = useRef('');

    useEffect(() => {
        const fetchConfig = async () => {
            try {
                const res = await fetch('http://localhost:5555/api/config');
                const json = await res.json();

                setConfig((prev: any) => {
                    // ⭐ 核心修复：即使用户停留在设置页面（避免重置输入内容），也能无缝实时提取并合并后端的 cdpConnected 最新状态！
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

            } catch { } // 修复 TS6133
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
            }).catch(() => {
                // Ignore passively
            });
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

    useEffect(() => {
        if (activeTab !== 'logs') return;
        const fetchLogs = async () => {
            try {
                const res = await fetch('http://localhost:5555/api/logs');
                const json = await res.json();
                setSysLogs(json);
            } catch {}
        };
        fetchLogs();
        const timer = setInterval(fetchLogs, 1000);
        return () => clearInterval(timer);
    }, [activeTab]);

    useEffect(() => {
        if (activeTab === 'logs' && logsEndRef.current) {
            logsEndRef.current.scrollIntoView({ behavior: 'smooth' });
        }
    }, [sysLogs, activeTab]);

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
            if(res.ok) showAdminToast("✅ 已发送注入指令，请查看运行日志！");
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
        await fetch('http://localhost:5555/api/update/apply', { method: 'POST' });
        showAdminToast("正在后台下载更新，请稍候，程序将自动重启...");
    };

    const startQrLogin = async () => {
        setQrState(prev => ({ ...prev, loading: true, base64: '' }));
        await fetch('http://localhost:5555/api/bili/qrstart', { method: 'POST' });
    };

    const toggleAccepting = async () => {
        try {
            await fetch('http://localhost:5555/api/state/toggle', { method: 'POST' });
            setConfig((prev: any) => ({...prev, accepting: !prev.accepting}));
        } catch(err) { console.error(err); } // 修复 TS6133
    };

    const togglePlaying = async () => {
        try {
            await fetch('http://localhost:5555/api/state/toggle_play', { method: 'POST' });
            setConfig((prev: any) => ({...prev, playing: !prev.playing}));
        } catch(err) { console.error(err); } // 修复 TS6133
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
                showAdminToast("✅ 搜索并插入成功！请前往网易云播放列表查看。");
            } else {
                showAdminToast("❌ 操作失败。可能是没搜到歌曲，请查看运行日志。");
            }
        } catch(err: any) { showAdminToast("❌ 请求后端失败：" + err.message); }
    };

    const handleDebugPlayNext = async () => {
        try {
            const res = await fetch('http://localhost:5555/api/debug/play_next', { method: 'POST' });
            const json = await res.json();
            if(json.success) showAdminToast("✅ 切歌指令已发送！");
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
                                    <h2 className="text-2xl font-bold text-white mb-2">后端实时日志 (Log)</h2>
                                    <div className="flex-1 bg-[#090b0f] rounded-xl border border-white/10 p-4 font-mono text-[13px] overflow-y-auto custom-scrollbar flex flex-col gap-2 shadow-inner">
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
                                        <div ref={logsEndRef} />
                                    </div>
                                </div>
                            )}

                            {activeTab === 'debug' && (
                                <div className="space-y-6 animate-slide-in-right flex flex-col h-full">
                                    <h2 className="text-2xl font-bold text-white mb-2">CDP 调试与测试</h2>

                                    <div className="bg-white/5 p-6 rounded-xl border border-white/10 shadow-inner">
                                        <h3 className="text-sm font-bold text-purple-400 mb-4 uppercase tracking-wider">🛠️ 测试一：搜索并加入网易云下一首</h3>
                                        <div className="flex gap-3 mb-3">
                                            <input
                                                type="text"
                                                value={debugInput}
                                                onChange={e => setDebugInput(e.target.value)}
                                                className="flex-1 bg-black/30 border border-white/10 rounded-lg p-3 text-sm text-white outline-none focus:border-purple-500"
                                                placeholder="输入要搜索的歌曲名称"
                                                onKeyDown={e => e.key === 'Enter' && handleDebugInsert()}
                                            />
                                            <button onClick={handleDebugInsert} className="px-6 py-3 bg-purple-600 hover:bg-purple-500 text-white text-sm rounded-lg font-bold transition-colors shadow-lg">发送到下一首</button>
                                        </div>
                                        <p className="text-xs text-gray-500 mb-8 leading-relaxed">此操作将调用后端的网易云接口搜索，提取歌曲ID后通过 JS `addToPlayList` 注入到网易云。你可以用它来测试底层注入是否正常工作。</p>

                                        <h3 className="text-sm font-bold text-blue-400 mb-4 uppercase tracking-wider">🛠️ 测试二：网易云原生切歌指令</h3>
                                        <button onClick={handleDebugPlayNext} className="w-full px-6 py-4 bg-blue-600 hover:bg-blue-500 text-white text-sm rounded-lg font-bold transition-colors shadow-lg flex justify-center items-center gap-2">
                                            ⏭️ 立即触发播放下一首 (playNext)
                                        </button>
                                        <p className="text-xs text-gray-500 mt-3 text-center leading-relaxed">发送纯净的 `playNext` 指令给网易云，用于测试 CDP 注入环境与控制权是否有效连接。</p>
                                    </div>
                                </div>
                            )}

                            {activeTab === 'settings' && (
                                <div className="animate-slide-in-right pb-10">
                                    <h2 className="text-2xl font-bold text-white mb-6">基础设置</h2>

                                    <div className="bg-white/5 p-6 rounded-xl border border-purple-500/40 space-y-5 mb-6 shadow-[0_0_15px_rgba(168,85,247,0.15)] relative overflow-hidden">
                                        <div className="absolute top-0 right-0 bg-purple-600 text-white text-xs px-3 py-1 rounded-bl-lg font-bold">新特性</div>

                                        <h3 className="text-sm font-bold text-purple-400 uppercase tracking-widest border-b border-white/10 pb-3">
                                            <span>💻 播放器注入控制</span>
                                        </h3>

                                        <div className="hidden md:grid grid-cols-12 gap-4 text-[11px] text-gray-500 font-bold uppercase tracking-wider pb-2 border-b border-white/5 mt-3">
                                            <div className="col-span-3">目标播放器</div>
                                            <div className="col-span-2">当前状态</div>
                                            <div className="col-span-4">注入配置 (端口)</div>
                                            <div className="col-span-3 text-right">操作</div>
                                        </div>

                                        <div className="flex flex-col gap-3 mt-2">
                                            <div className="grid grid-cols-1 md:grid-cols-12 gap-4 items-center bg-black/40 border border-white/10 rounded-lg p-3 transition-colors hover:bg-white/5">
                                                <div className="col-span-3 flex items-center gap-3">
                                                    <button onClick={() => setConfig({...config, config: {...config.config, EnableCDP: !config.config.EnableCDP}})} className={`w-10 h-5 rounded-full p-1 transition-colors shrink-0 ${config.config.EnableCDP ? 'bg-purple-600' : 'bg-gray-600'}`}>
                                                        <div className={`w-3 h-3 rounded-full bg-white transition-transform ${config.config.EnableCDP ? 'translate-x-5' : 'translate-x-0'}`}></div>
                                                    </button>
                                                    <span className="text-sm text-white font-bold tracking-wide">网易云音乐</span>
                                                </div>
                                                <div className="col-span-2">
                                                    <span className={`text-[10px] px-2.5 py-1 rounded-full font-bold shadow-md ${config.cdpConnected ? 'bg-green-500/20 text-green-400 border border-green-500/30' : 'bg-red-500/20 text-red-400 border border-red-500/30'}`}>
                                                        {config.cdpConnected ? '✅ 已注入' : '❌ 未连接'}
                                                    </span>
                                                </div>
                                                <div className="col-span-4 flex items-center gap-2">
                                                    <span className="text-xs text-gray-400">端口号:</span>
                                                    <input type="number" className="w-20 bg-black/50 border border-white/10 rounded text-xs text-white p-1.5 focus:border-purple-500 outline-none text-center" value={config.config.CdpPort || 9222} onChange={e => setConfig({...config, config: {...config.config, CdpPort: parseInt(e.target.value)}})} />
                                                </div>
                                                <div className="col-span-3 flex justify-end">
                                                    <button onClick={handleRestartNCM} className="px-4 py-1.5 bg-purple-600 hover:bg-purple-500 text-white text-xs rounded-lg font-bold shadow transition-colors border border-purple-400/50">
                                                        🔌 重新注入
                                                    </button>
                                                </div>
                                            </div>

                                            <div className="grid grid-cols-1 md:grid-cols-12 gap-4 items-center bg-black/20 border border-white/5 rounded-lg p-3 opacity-50 cursor-not-allowed grayscale">
                                                <div className="col-span-3 flex items-center gap-3">
                                                    <button disabled className="w-10 h-5 rounded-full p-1 bg-gray-700 shrink-0">
                                                        <div className="w-3 h-3 rounded-full bg-gray-400"></div>
                                                    </button>
                                                    <span className="text-sm text-gray-400 font-bold tracking-wide">QQ 音乐</span>
                                                </div>
                                                <div className="col-span-2">
                                                    <span className="text-[10px] px-2.5 py-1 rounded-full font-bold bg-gray-600/20 text-gray-500 border border-gray-500/30">
                                                        即将支持
                                                    </span>
                                                </div>
                                                <div className="col-span-4 flex items-center gap-2">
                                                    <span className="text-xs text-gray-600">端口号:</span>
                                                    <input disabled type="number" className="w-20 bg-black/20 border border-white/5 rounded text-xs text-gray-500 p-1.5 text-center" value={9223} />
                                                </div>
                                                <div className="col-span-3 flex justify-end">
                                                    <button disabled className="px-4 py-1.5 bg-gray-700/50 text-gray-400 text-xs rounded-lg font-bold border border-gray-600/50">
                                                        敬请期待
                                                    </button>
                                                </div>
                                            </div>

                                            <div className="grid grid-cols-1 md:grid-cols-12 gap-4 items-center bg-black/20 border border-white/5 rounded-lg p-3 opacity-50 cursor-not-allowed grayscale">
                                                <div className="col-span-3 flex items-center gap-3">
                                                    <button disabled className="w-10 h-5 rounded-full p-1 bg-gray-700 shrink-0">
                                                        <div className="w-3 h-3 rounded-full bg-gray-400"></div>
                                                    </button>
                                                    <span className="text-sm text-gray-400 font-bold tracking-wide">酷狗音乐</span>
                                                </div>
                                                <div className="col-span-2">
                                                    <span className="text-[10px] px-2.5 py-1 rounded-full font-bold bg-gray-600/20 text-gray-500 border border-gray-500/30">
                                                        即将支持
                                                    </span>
                                                </div>
                                                <div className="col-span-4 flex items-center gap-2">
                                                    <span className="text-xs text-gray-600">端口号:</span>
                                                    <input disabled type="number" className="w-20 bg-black/20 border border-white/5 rounded text-xs text-gray-500 p-1.5 text-center" value={9224} />
                                                </div>
                                                <div className="col-span-3 flex justify-end">
                                                    <button disabled className="px-4 py-1.5 bg-gray-700/50 text-gray-400 text-xs rounded-lg font-bold border border-gray-600/50">
                                                        敬请期待
                                                    </button>
                                                </div>
                                            </div>
                                        </div>

                                        <div className="text-xs text-gray-500 mt-2 italic flex gap-2 leading-relaxed">
                                            <span className="shrink-0">💡</span>
                                            <span>开启对应播放器的注入后，点歌机将通过底层接口直接操控播放器，实现静默切歌、强行插入等高级功能。</span>
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
                                                    <option value="true">加入网易云下一首 (等当前播完)</option>
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

                                        {updateInfo.info?.hasUpdate ? (
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