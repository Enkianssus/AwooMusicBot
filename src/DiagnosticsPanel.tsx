import { useCallback, useEffect, useRef, useState } from 'react';
import { internalApiUrl } from './internal-api';
import { UiIcon } from './ui-icons';
import type { DiagnosticRepair, DiagnosticStatus, DiagnosticsState } from './diagnostics-types';
import './diagnostics.css';

interface DiagnosticsPanelProps {
    onNavigate: (tab: 'status' | 'settings' | 'login' | 'update' | 'logs') => void;
}

const statusLabels: Record<DiagnosticStatus, string> = {
    pass: '通过', warning: '需要留意', error: '发现问题', unknown: '尚未验证'
};
const statusSymbols: Record<DiagnosticStatus, string> = {
    pass: '✓', warning: '!', error: '×', unknown: '?'
};
const repairLabels: Record<DiagnosticRepair, string> = {
    'reconnect-room': '重新连接已启用的直播间',
    'reconnect-player': '重新连接当前播放器',
    'update-connector': '安装或更新当前兼容分支的连接器'
};

class RequestRejectedError extends Error {}

async function requestJson(path: string, body?: object, timeoutMs = 20_000): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(internalApiUrl(path), {
            ...(body ? {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
            } : {}),
            signal: controller.signal
        });
        const result = await response.json() as Record<string, unknown>;
        if (result.success === false) {
            throw new RequestRejectedError(typeof result.message === 'string' ? result.message : '服务明确返回操作失败，请查看运行日志。');
        }
        if (!response.ok || result.success !== true) {
            throw new Error(typeof result.message === 'string' ? result.message : '诊断服务请求失败，请查看运行日志。');
        }
        return result;
    } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') throw new Error('服务响应超时，暂时无法取得结果。');
        throw error;
    } finally {
        window.clearTimeout(timeout);
    }
}

async function requestState(path = '/api/diagnostics', body?: object): Promise<DiagnosticsState> {
    const result = await requestJson(path, body);
    if (typeof result.busy !== 'boolean' || !result.reception || !Array.isArray(result.repairResults)
        || (result.report !== null && (!result.report || !Array.isArray((result.report as { checks?: unknown }).checks)))) {
        throw new Error('诊断服务返回了不完整的结果，无法判断是否正常。');
    }
    return result as unknown as DiagnosticsState;
}

// React StrictMode remounts effects; both mounts share this one startup request.
let startupRequest: Promise<DiagnosticsState> | null = null;
function startDiagnostics(): Promise<DiagnosticsState> {
    if (!startupRequest) {
        startupRequest = requestState()
            .then(state => state.busy ? state : requestState('/api/diagnostics/run', {}))
            .finally(() => { startupRequest = null; });
    }
    return startupRequest;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : '无法连接诊断服务，请检查点歌机是否仍在运行。';
}

function formatTime(value: number): string {
    return value > 0 ? new Date(value).toLocaleString('zh-CN') : '尚未检查';
}

export default function DiagnosticsPanel({ onNavigate }: DiagnosticsPanelProps) {
    const [state, setState] = useState<DiagnosticsState | null>(null);
    const [initializing, setInitializing] = useState(true);
    const [pending, setPending] = useState('');
    const [networkError, setNetworkError] = useState('');
    const [keyword, setKeyword] = useState('Shelter');
    const [songKeyword, setSongKeyword] = useState('晴天');
    const [songMode, setSongMode] = useState<'normal' | 'play_now'>('normal');
    const [songConsent, setSongConsent] = useState(false);
    const [songResult, setSongResult] = useState<{ success: boolean; unknown: boolean; confirmed: boolean; immediate: boolean; message: string } | null>(null);
    const [now, setNow] = useState(Date.now());
    const mountedRef = useRef(false);
    const operationRef = useRef(false);
    const pollingRef = useRef(false);
    const requestRevisionRef = useRef(0);
    const failedActionRef = useRef(false);

    useEffect(() => {
        let disposed = false;
        mountedRef.current = true;
        void startDiagnostics().then(result => {
            if (!disposed) { setState(result); failedActionRef.current = false; setNetworkError(''); }
        }).catch(error => {
            if (!disposed) { failedActionRef.current = true; setNetworkError(errorMessage(error)); }
        }).finally(() => {
            if (!disposed) setInitializing(false);
        });
        return () => { disposed = true; mountedRef.current = false; };
    }, []);

    useEffect(() => {
        if (initializing) return;
        let disposed = false;
        const timer = window.setInterval(() => {
            if (pollingRef.current || operationRef.current) return;
            pollingRef.current = true;
            const revision = requestRevisionRef.current;
            void requestState().then(result => {
                if (!disposed && revision === requestRevisionRef.current) {
                    setState(result);
                    if (!failedActionRef.current) setNetworkError('');
                }
            }).catch(error => {
                if (!disposed && revision === requestRevisionRef.current) setNetworkError(errorMessage(error));
            }).finally(() => { pollingRef.current = false; });
        }, 1500);
        return () => { disposed = true; window.clearInterval(timer); };
    }, [initializing]);

    useEffect(() => {
        if (state?.reception.status !== 'waiting') return;
        setNow(Date.now());
        const timer = window.setInterval(() => setNow(Date.now()), 1000);
        return () => window.clearInterval(timer);
    }, [state?.reception.status, state?.reception.expiresAt]);

    const runAction = useCallback(async (action: 'run' | 'repair' | 'reception', body: object = {}) => {
        if (operationRef.current) return;
        operationRef.current = true;
        requestRevisionRef.current += 1;
        setPending(action);
        setNetworkError('');
        try {
            const result = await requestState(`/api/diagnostics/${action}`, body);
            if (mountedRef.current) { setState(result); failedActionRef.current = false; }
        } catch (error) {
            if (mountedRef.current) { failedActionRef.current = true; setNetworkError(errorMessage(error)); }
        } finally {
            operationRef.current = false;
            if (mountedRef.current) setPending('');
        }
    }, []);

    const testSongRequest = async () => {
        if (operationRef.current || !songConsent || !songKeyword.trim()) return;
        operationRef.current = true;
        requestRevisionRef.current += 1;
        setPending('song');
        setSongResult(null);
        setSongConsent(false);
        try {
            const result = await requestJson('/api/test/request-song', {
                keyword: songKeyword.trim(), mode: songMode, requestedBy: '诊断测试'
            }, 120_000);
            if (mountedRef.current) {
                setSongResult({
                    success: true,
                    unknown: false,
                    confirmed: result.playbackConfirmed === true,
                    immediate: songMode === 'play_now',
                    message: typeof result.message === 'string' ? result.message : '测试歌曲已提交。'
                });
            }
        } catch (error) {
            if (mountedRef.current) setSongResult({ success: false, unknown: !(error instanceof RequestRejectedError), confirmed: false, immediate: songMode === 'play_now', message: errorMessage(error) });
        } finally {
            operationRef.current = false;
            if (mountedRef.current) setPending('');
        }
    };

    const checks = state?.report?.checks || [];
    const repairs = [...new Set(checks.flatMap(check => check.repair ? [check.repair] : []))];
    const busy = initializing || Boolean(pending) || state?.busy === true;
    const reception = state?.reception;
    const receptionWaiting = reception?.status === 'waiting';
    const remainingSeconds = Math.max(0, Math.ceil(((reception?.expiresAt || 0) - now) / 1000));
    const hasServiceError = Boolean(networkError || state?.error);
    const allPassed = checks.length > 0 && checks.every(check => check.status === 'pass');
    const reportTitle = busy ? '正在检查，请稍候'
        : hasServiceError ? '检查未完成，请查看错误信息'
            : !state?.report ? '等待检查结果'
                : allPassed ? '本次检查项均已通过'
                    : '检查完成，请按提示处理';

    return (
        <div className="diagnostics-panel animate-slide-in-right">
            <section className="diagnostics-card diagnostics-overview" aria-labelledby="diagnostics-overview-title">
                <div className="diagnostics-heading">
                    <div>
                        <h2 id="diagnostics-overview-title"><UiIcon name="shield" /> 自动检查与修复</h2>
                        <p>检查弹幕连接、点歌条件、歌曲搜索和连接器更新。检查本身不会添加歌曲或切换播放。</p>
                    </div>
                    <button className="diagnostics-primary" disabled={busy || receptionWaiting} aria-busy={busy} onClick={() => void runAction('run', { keyword: keyword.trim() || undefined })}>
                        <UiIcon name="update" /> {busy ? '正在检查…' : '重新检查'}
                    </button>
                </div>
                <label className="diagnostics-field" htmlFor="diagnostics-search-keyword">
                    <span>搜索检查关键词（选填）</span>
                    <input id="diagnostics-search-keyword" value={keyword} maxLength={200} onChange={event => setKeyword(event.target.value)} placeholder="留空使用默认测试歌曲，仅搜索不入队" disabled={busy} />
                </label>
                <div className="diagnostics-summary" role="status" aria-live="polite">
                    <strong>{reportTitle}</strong>
                    {state?.busy && state.phase && <span>{state.phase}</span>}
                    {state?.report && <span>{state.report.playerLabel} · 房间 {state.report.roomId || '未配置'} · {formatTime(state.report.checkedAt)}</span>}
                    {checks.length > 0 && (
                        <div className="diagnostics-counts">
                            {(Object.keys(statusLabels) as DiagnosticStatus[]).map(status => (
                                <span key={status} className={`diagnostics-badge diagnostics-${status}`}>{statusLabels[status]} {checks.filter(check => check.status === status).length}</span>
                            ))}
                        </div>
                    )}
                </div>
                {networkError && <div className="diagnostics-notice diagnostics-error" role="alert"><strong>诊断服务请求失败</strong><p>{networkError}</p>{state?.report && <p>下面保留的是上一次结果，不能据此确认当前状态。</p>}</div>}
                {state?.error && <div className="diagnostics-notice diagnostics-error" role="alert"><strong>检查或修复失败</strong><p>{state.error}</p></div>}
            </section>

            {checks.length > 0 && (
                <section className="diagnostics-checks" aria-label="检查结果" aria-busy={busy}>
                    {checks.map(check => (
                        <article key={check.id} className={`diagnostics-card diagnostics-check diagnostics-${check.status}`}>
                            <span className="diagnostics-check-symbol" aria-hidden="true">{statusSymbols[check.status]}</span>
                            <div>
                                <div className="diagnostics-check-title"><h3>{check.title}</h3><span className={`diagnostics-badge diagnostics-${check.status}`}>{statusLabels[check.status]}</span></div>
                                <p>{check.message}</p>
                                {check.advice && <p className="diagnostics-advice">建议：{check.advice}</p>}
                            </div>
                        </article>
                    ))}
                </section>
            )}

            <section className="diagnostics-card" aria-labelledby="diagnostics-repair-title">
                <h3 id="diagnostics-repair-title"><UiIcon name="settings" /> 修复可自动处理的问题</h3>
                {repairs.length > 0 ? <ul className="diagnostics-repair-list">{repairs.map(action => <li key={action}>{repairLabels[action]}</li>)}</ul>
                    : <p>{state?.report ? '本次没有可自动执行的修复。请根据检查建议调整设置或完成实测。' : '检查完成后会在这里列出可执行的修复。'}</p>}
                <p className="diagnostics-fine-print">只处理上方列出的项目。连接器安装或更新可能短暂重连、重启播放器；不会跨播放器兼容分支更新，也不会自动开启已关闭的直播间连接或接单。修复后会重新检查。</p>
                <button className="diagnostics-primary" disabled={busy || receptionWaiting || !repairs.length || hasServiceError} onClick={() => void runAction('repair')}>
                    {pending === 'repair' || state?.busy && state.phase.includes('修复') ? '正在修复…' : '执行上述修复并复查'}
                </button>
                {Boolean(state?.repairResults.length) && <div className="diagnostics-repair-results" role="status">{state?.repairResults.map((result, index) => <div key={`${result.action}-${index}`} className={`diagnostics-notice diagnostics-${result.success ? 'pass' : 'error'}`}><strong>{result.success ? '✓ 已执行' : '× 修复失败'} · {repairLabels[result.action]}</strong><p>{result.message}</p></div>)}</div>}
                <div className="diagnostics-links" aria-label="相关设置">
                    <button onClick={() => onNavigate('status')}>直播间与接单设置 <UiIcon name="arrow" /></button>
                    <button onClick={() => onNavigate('settings')}>播放器与连接器设置 <UiIcon name="arrow" /></button>
                    <button onClick={() => onNavigate('login')}>登录设置 <UiIcon name="arrow" /></button>
                    <button onClick={() => onNavigate('update')}>点歌机版本升级 <UiIcon name="arrow" /></button>
                    <button onClick={() => onNavigate('logs')}>查看运行日志 <UiIcon name="arrow" /></button>
                </div>
            </section>

            <section className="diagnostics-card" aria-labelledby="diagnostics-reception-title">
                <h3 id="diagnostics-reception-title"><UiIcon name="radio" /> 实测弹幕接收</h3>
                <p>连接成功不等于实际收到弹幕。开始测试后，请在当前 B 站直播间手动发送指定短语；点歌机会等待 60 秒。</p>
                {receptionWaiting && reception && <div className="diagnostics-reception-prompt" role="status"><span>请在房间 <strong>{reception.roomId}</strong> 发送以下完整内容：</span><code>{reception.phrase}</code><span>{remainingSeconds > 0 ? `剩余 ${remainingSeconds} 秒` : '等待测试结束…'} · 请保持空格和文字完全一致</span></div>}
                {reception?.status === 'received' && <div className="diagnostics-notice diagnostics-pass" role="status"><strong>✓ 已收到测试弹幕，真实接收链路已验证</strong><p>房间 {reception.roomId} · {formatTime(reception.receivedAt || 0)}</p></div>}
                {reception?.status === 'timeout' && <div className="diagnostics-notice diagnostics-warning" role="status"><strong>60 秒内没有收到指定弹幕</strong><p>这不一定是连接故障。请确认发送到了正确房间、短语完全一致，必要时重新连接后重试。</p></div>}
                {reception?.status === 'cancelled' && <p role="status">上次弹幕测试已结束，尚未验证接收。</p>}
                <button disabled={busy} onClick={() => void runAction('reception', { action: receptionWaiting ? 'stop' : 'start' })}>
                    {receptionWaiting ? '停止等待' : '开始 60 秒弹幕测试'}
                </button>
            </section>

            <details className="diagnostics-card diagnostics-song-test">
                <summary><UiIcon name="music" /> 实际点歌测试（会加入队列）</summary>
                <p>此测试使用当前播放器实际搜索并提交点歌，会把歌曲加入队列，并可能开始播放。“立即播放”还会尝试切换当前歌曲。它绕过弹幕权限，不能验证观众的权限、冷却时间或完整弹幕点歌流程。</p>
                <label className="diagnostics-field" htmlFor="diagnostics-song-keyword"><span>要测试的歌曲</span><input id="diagnostics-song-keyword" value={songKeyword} maxLength={200} onChange={event => { setSongKeyword(event.target.value); setSongConsent(false); }} placeholder="输入歌曲名或歌曲 ID" disabled={busy} /></label>
                <label className="diagnostics-field" htmlFor="diagnostics-song-mode"><span>测试方式</span><select id="diagnostics-song-mode" value={songMode} onChange={event => { setSongMode(event.target.value === 'play_now' ? 'play_now' : 'normal'); setSongConsent(false); }} disabled={busy}><option value="normal">加入待播队列（默认）</option><option value="play_now">立即播放（会切换当前歌曲）</option></select></label>
                <label className="diagnostics-consent"><input type="checkbox" checked={songConsent} onChange={event => setSongConsent(event.target.checked)} disabled={busy} /><span>{songMode === 'play_now' ? '我确认把测试歌曲置于队首，并允许立即切换当前歌曲进行播放测试。' : '我确认将这首歌加入队列，并允许它按当前点歌设置开始播放。'}</span></label>
                <button className="diagnostics-primary" disabled={busy || receptionWaiting || !songConsent || !songKeyword.trim()} onClick={() => void testSongRequest()}>{pending === 'song' ? '正在提交测试歌曲…' : '确认并实际点歌'}</button>
                {songResult && (
                    <div className={`diagnostics-notice diagnostics-${songResult.unknown ? 'warning' : !songResult.success ? 'error' : songResult.confirmed ? 'pass' : 'warning'}`} role="status">
                        <strong>{songResult.unknown ? '结果未确认，可能已经入队或播放' : !songResult.success ? '测试失败' : songResult.confirmed ? '✓ 播放器已确认切换' : songResult.immediate ? '已保留队首，尚未确认播放' : '已成功入队，尚未验证播放'}</strong>
                        <p>{songResult.message}</p>
                        {songResult.unknown && <p>网络中断或等待超时不会取消后台点歌。请先查看当前队列和播放器，勿重复提交。</p>}
                        {songResult.confirmed && <p>播放器已确认切换，仍请确认实际出声。</p>}
                        {songResult.success && !songResult.confirmed && <p>{songResult.immediate ? '播放器尚未确认播放，歌曲仍保留在队首。请检查播放器状态和运行日志，避免重复提交。' : '请等待队列播放并确认播放器实际发声；入队成功不代表已确认播放成功。'}</p>}
                    </div>
                )}
            </details>
        </div>
    );
}
