import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import fs from 'fs';
import {
  ConnectorUpdater,
  type ConnectorRollbackResult,
  type ConnectorUpdateOptions,
  type ConnectorUpdateResult,
  type ConnectorUpdateStatus,
  type NativeConnectorId,
  type QQMusicProfileRefreshResult
} from './connector-updater';
import { ConnectorLifecycleGate } from './connector-lifecycle-gate';
import {
  createJsonlLineBuffer,
  type JsonlInvalidReason,
  type JsonlLineBuffer
} from './jsonl-line-buffer';
import {
  mergeSnapshotCapabilities,
  rejectUnsupportedQqCommand
} from './qq-native-compatibility-policy';

const CONNECTOR_SHUTDOWN_DRAIN_TIMEOUT_MS = 25_000;
const CONNECTOR_FORCE_EXIT_TIMEOUT_MS = 2_000;
// A cold framework-dependent connector can spend several seconds under
// antivirus scanning before it answers its first ping.
const FIRST_PING_TIMEOUT_MS = 15_000;
const SUBSCRIBE_TIMEOUT_MS = 5_000;
const INVALID_OUTPUT_LOG_INTERVAL_MS = 10_000;
const INVALID_OUTPUT_PREVIEW_CHARS = 200;
const STDERR_LINE_MAX_CHARS = 2_000;
const SNAPSHOT_EVENTS_FEATURE = 'snapshot-events-v1';

const INVALID_OUTPUT_LABELS: Record<JsonlInvalidReason, string> = {
  'invalid-json': '非 JSON',
  'not-object': '非对象',
  'handler-error': '处理失败'
};

export interface PlayerBridgeClientOptions {
  /** Overrides the handshake ping timeout, for tests. */
  firstPingTimeoutMs?: number;
}

export interface PlayerTrack {
  id: string;
  title: string;
  artist: string;
  album: string;
  nativeData?: string;
  coverUrl?: string;
}

export interface PlayerCapabilities {
  search: boolean;
  playSelected: boolean;
  previous: boolean;
  pause: boolean;
  resume: boolean;
  toggle: boolean;
  next: boolean;
  insertNext: boolean;
  insertNextLevel: string;
}

export type NextGuardState =
  | 'none'
  | 'armed'
  | 'waitingLateTarget'
  | 'completed'
  | 'terminalFailure'
  | 'expired';

export interface PlayerSnapshot {
  connected: boolean;
  player: string;
  processId?: number | null;
  version: string;
  status: string;
  current?: PlayerTrack | null;
  next?: PlayerTrack | null;
  nextSource?: string;
  nextObservation?: 'unknown' | 'track' | 'empty' | null;
  nextGuardState?: NextGuardState | null;
  /** Stable positive id for one connector guard cycle. */
  nextGuardId?: number | null;
  /** QQ reports true only after the native playlist playback cursor exists. */
  playbackAnchorReady?: boolean;
  /** Only explicit false opts into an anchor-independent connector backend. */
  requiresPlaybackAnchor?: boolean;
  /** The connector owns logical-next handoff, not host track-change correction. */
  ownsLogicalNext?: boolean;
  /** A busy QQ Web probe supplied historical data, not a new observation. */
  observationDeferred?: boolean;
  observedAt: string;
  capabilities?: PlayerCapabilities | null;
  /** Native queue support for the detected player build, independent of connection. */
  compatibilityFailureCode?: string | null;
}

export interface PlayerOperationResult {
  outcome: string;
  message: string;
  snapshot?: PlayerSnapshot | null;
  failureCode?: string | null;
}

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
}

interface BridgeEnvelope {
  id: string;
  ok: boolean;
  result?: any;
  error?: string | null;
}

export interface PlayerBridgeEvent {
  type: 'event';
  event: 'snapshot' | 'connectorExit';
  player: NativeConnectorId;
  sequence: number;
  snapshot?: PlayerSnapshot | null;
  error?: string;
}

export class PlayerBridgeClient {
  private process: ChildProcessWithoutNullStreams | null = null;
  private activePlayer: NativeConnectorId | null = null;
  private activeCapabilities: PlayerCapabilities | null = null;
  private latestSnapshot: PlayerSnapshot | null = null;
  private activeFeatures = new Set<string>();
  private pending = new Map<string, PendingRequest>();
  private requestSequence = 0;
  private stdoutLines: JsonlLineBuffer | null = null;
  private invalidOutputLoggedAt = 0;
  private stopping = false;
  private startPromise: Promise<void> | null = null;
  private lifecycleGeneration = 0;
  private readonly lifecycleGate = new ConnectorLifecycleGate();
  private readonly updater: ConnectorUpdater;
  private readonly firstPingTimeoutMs: number;

  constructor(
    private readonly onLog: (message: string) => void,
    private readonly getFoliaToken: () => string = () => '',
    private readonly onEvent: (event: PlayerBridgeEvent) => void = () => {},
    options: PlayerBridgeClientOptions = {}
  ) {
    this.updater = new ConnectorUpdater(onLog);
    this.firstPingTimeoutMs = options.firstPingTimeoutMs ?? FIRST_PING_TIMEOUT_MS;
  }

  get running(): boolean {
    return Boolean(this.process && !this.process.killed);
  }

  get supportsSnapshotEvents(): boolean {
    return this.activeFeatures.has(SNAPSHOT_EVENTS_FEATURE);
  }

  async start(player: NativeConnectorId): Promise<void> {
    await this.lifecycleGate.waitForStop();
    let inFlight = this.startPromise;
    while (inFlight) {
      try {
        await inFlight;
      } catch {
        // This caller gets its own connection attempt after the prior start
        // has completely unwound.
      }
      await this.lifecycleGate.waitForStop();
      inFlight = this.startPromise;
    }

    if (this.running && this.activePlayer === player) return;
    if (this.running) {
      await this.stop();
      return this.start(player);
    }
    const generation = this.lifecycleGeneration;
    const start = this.startInternal(player, generation)
      .finally(() => {
        if (this.startPromise === start) {
          this.startPromise = null;
        }
      });
    this.startPromise = start;
    return start;
  }

  private async startInternal(
    player: NativeConnectorId,
    generation: number
  ): Promise<void> {
    if (this.running && this.activePlayer === player) return;

    const executable = await this.resolveExecutable(player);
    if (generation !== this.lifecycleGeneration) {
      throw new Error('连接器启动已取消');
    }
    if (!fs.existsSync(executable)) {
      throw new Error(`播放器桥不存在: ${executable}`);
    }

    this.stopping = false;
    this.activeCapabilities = null;
    this.latestSnapshot = null;
    this.activeFeatures.clear();
    const connectorEnvironment =
      await this.updater.getLaunchEnvironment(player);
    if (generation !== this.lifecycleGeneration || this.stopping) {
      throw new Error('连接器启动已取消');
    }
    const child = spawn(executable, [], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...connectorEnvironment,
        BILINCM_FOLIA_TOKEN:
          player === 'folia' ? this.getFoliaToken().trim() : ''
      }
    });
    this.process = child;
    this.activePlayer = player;
    // Until its handshake completes, this child's exit or broken pipe is
    // reported only through the rejected start(); the caller's retry policy
    // logs it once instead of once per attempt.
    let ready = false;

    try {
      const flushStderr = this.logStderrLines(child);
      this.stdoutLines = createJsonlLineBuffer({
        onMessage: message => this.consumeMessage(message),
        onInvalid: (line, reason) => this.reportInvalidOutput(
          INVALID_OUTPUT_LABELS[reason],
          line
        ),
        onOverflow: droppedChars => this.reportInvalidOutput(
          `单行过长，已丢弃 ${droppedChars} 个字符`
        )
      });
      child.stdout.setEncoding('utf8');
      child.stdout.on(
        'data',
        (chunk: string) => this.consumeStdout(child, chunk)
      );
      let stdinErrorLogged = false;
      child.stdin.on('error', (error: Error) => {
        // request() already rejects the failed write; this listener keeps a
        // broken pipe from becoming an uncaught exception.
        if (stdinErrorLogged || !ready || this.process !== child) return;
        stdinErrorLogged = true;
        this.onLog(`[播放器桥] 写入连接器失败：${error.message}`);
      });
      child.on('error', error => this.handleExit(child, error, ready));
      child.on('exit', (code, signal) => {
        flushStderr();
        if (this.process !== child) return;
        if (!this.stopping && ready) {
          this.onLog(`[播放器桥] 已退出 (code=${code}, signal=${signal || 'none'})`);
        }
        this.handleExit(
          child,
          new Error(`播放器桥已退出 (code=${code})`),
          ready
        );
      });

      const ping = await this.request(
        { action: 'ping' },
        this.firstPingTimeoutMs
      );
      if (generation !== this.lifecycleGeneration || this.stopping) {
        throw new Error('连接器启动已取消');
      }
      if (
        ping?.connectorId
        && (
          ping.connectorId !== player
          || ping.protocolVersion !== 1
        )
      ) {
        await this.stop();
        throw new Error(
          `连接器协议不匹配: ${ping.connectorId}/`
          + `${ping.protocolVersion}`
        );
      }
      const features = new Set<string>(
        Array.isArray(ping?.features)
          ? ping.features.filter((feature: unknown): feature is string =>
            typeof feature === 'string'
          )
          : []
      );
      // Events are advertised only once the connector confirmed the
      // subscription; until then the manager keeps polling.
      const offersSnapshotEvents = features.delete(SNAPSHOT_EVENTS_FEATURE);
      this.activeCapabilities = ping?.capabilities || null;
      this.activeFeatures = features;
      const subscribed = offersSnapshotEvents
        && await this.subscribeSnapshotEvents(child);
      if (generation !== this.lifecycleGeneration || this.stopping) {
        throw new Error('连接器启动已取消');
      }
      if (subscribed) {
        this.activeFeatures.add(SNAPSHOT_EVENTS_FEATURE);
      } else if (offersSnapshotEvents) {
        this.onLog('[播放器桥] 实时事件订阅不可用，已回退到状态轮询');
      }
      ready = true;
    } catch (error) {
      // A connector that failed its handshake is never reused, so the next
      // start() spawns and handshakes afresh. A stop() in progress owns the
      // child and drains it instead.
      if (this.process === child && !this.stopping) {
        this.discardChild(child);
      }
      throw error;
    }
  }

  /** A failed subscription leaves a working connector in polling mode. */
  private async subscribeSnapshotEvents(
    child: ChildProcessWithoutNullStreams
  ): Promise<boolean> {
    try {
      const subscription = await this.request(
        {
          action: 'subscribe',
          eventProtocolVersion: 1
        },
        SUBSCRIBE_TIMEOUT_MS
      );
      return subscription?.subscribed === true;
    } catch (error) {
      // The connector itself went away, which fails the start.
      if (this.process !== child) throw error;
      return false;
    }
  }

  /**
   * Logs connector stderr per complete line, each capped in length. The
   * returned flush logs a tail without a newline once the child exits.
   */
  private logStderrLines(child: ChildProcessWithoutNullStreams): () => void {
    let pending = '';
    // The rest of an over-long line is skipped up to its newline.
    let skipping = false;
    const log = (text: string) => {
      const message = text.trim();
      if (!message) return;
      const capped = message.length > STDERR_LINE_MAX_CHARS
        ? `${message.slice(0, STDERR_LINE_MAX_CHARS)}…`
        : message;
      this.onLog(`[播放器桥] ${capped}`);
    };
    const flush = () => {
      if (!skipping) log(pending);
      pending = '';
      skipping = false;
    };
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      const lines = `${pending}${chunk}`.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) {
        if (!skipping) log(line);
        skipping = false;
      }
      if (pending.length > STDERR_LINE_MAX_CHARS) {
        if (!skipping) log(pending);
        pending = '';
        skipping = true;
      }
    });
    child.stderr.on('end', flush);
    return flush;
  }

  async restart(player: NativeConnectorId): Promise<void> {
    await this.stop();
    await this.start(player);
  }

  async getConnectorStatuses(
    forceRefresh = false,
    connectorId?: NativeConnectorId
  ): Promise<ConnectorUpdateStatus[]> {
    return this.updater.getStatuses(forceRefresh, connectorId);
  }

  async isConnectorInstalled(
    connectorId: NativeConnectorId
  ): Promise<boolean> {
    return this.updater.isInstalled(connectorId);
  }

  /**
   * The running connector keeps serving commands during and after the
   * install: a new version gets its own directory, and active.json only
   * decides what the next start launches.
   */
  async updateConnector(
    connectorId: NativeConnectorId,
    allowPlayerVersionChange = false,
    options: ConnectorUpdateOptions = {}
  ): Promise<ConnectorUpdateResult> {
    return this.updater.update(
      connectorId,
      allowPlayerVersionChange,
      options
    );
  }

  async reinstallConnector(
    connectorId: NativeConnectorId
  ): Promise<ConnectorUpdateResult> {
    return this.updater.reinstall(connectorId);
  }

  /**
   * Reverts to the version the last update replaced. The executable being
   * replaced is stopped first, including a start that is still in flight;
   * the caller reconnects afterwards.
   */
  async rollbackConnector(
    connectorId: NativeConnectorId
  ): Promise<ConnectorRollbackResult> {
    if (this.activePlayer === connectorId || this.startPromise) {
      await this.stop();
    }
    return this.updater.rollbackToPrevious(connectorId);
  }

  /** Only QQ Music has downloadable compatibility profiles. */
  async refreshConnectorProfiles(
    connectorId: NativeConnectorId
  ): Promise<QQMusicProfileRefreshResult> {
    if (connectorId !== 'qqmusic') return { changed: false, version: null };
    return this.updater.refreshQQMusicProfiles();
  }

  async stop(): Promise<void> {
    if (this.lifecycleGate.stopping) {
      return this.lifecycleGate.waitForStop();
    }
    this.lifecycleGeneration++;
    const child = this.process;
    if (!child) return;

    const stoppingPlayer = this.activePlayer;
    this.stopping = true;
    return this.lifecycleGate.runStop(async () => {
      const shutdownStartedAt = Date.now();
      let shutdownError: unknown = null;
      try {
        try {
          await this.request(
            { action: 'shutdown' },
            CONNECTOR_SHUTDOWN_DRAIN_TIMEOUT_MS
          );
        } catch (error) {
          shutdownError = error;
        }

        const remainingDrainMs = Math.max(
          0,
          CONNECTOR_SHUTDOWN_DRAIN_TIMEOUT_MS
            - (Date.now() - shutdownStartedAt)
        );
        if (!await this.waitForExit(child, remainingDrainMs)) {
          const detail = shutdownError instanceof Error
            ? `（${shutdownError.message}）`
            : '';
          this.onLog(
            `[播放器桥] ${stoppingPlayer || '当前'}连接器在 `
            + `${CONNECTOR_SHUTDOWN_DRAIN_TIMEOUT_MS / 1000} 秒内未完成清理，`
            + `正在强制结束${detail}。若随后控制异常，请完全退出并重启播放器。`
          );
          child.kill();
          if (!await this.waitForExit(child, CONNECTOR_FORCE_EXIT_TIMEOUT_MS)) {
            this.onLog(
              `[播放器桥] ${stoppingPlayer || '当前'}连接器强制结束后仍未退出`
            );
          }
        } else if (shutdownError instanceof Error) {
          this.onLog(
            `[播放器桥] ${stoppingPlayer || '当前'}连接器已退出，`
            + `但未收到完整清理确认：${shutdownError.message}`
          );
        }
      } finally {
        if (this.process === child) {
          this.releaseChild();
          this.rejectAll(new Error('播放器桥已停止'));
        }
      }
    });
  }

  async probe(player: NativeConnectorId): Promise<PlayerSnapshot> {
    await this.start(player);
    const snapshot = await this.request(
      { action: 'probe', player },
      8000
    );
    return this.acceptSnapshot(snapshot);
  }

  async search(
    player: NativeConnectorId,
    query: string
  ): Promise<PlayerTrack[]> {
    await this.start(player);
    return this.request({ action: 'search', player, query }, 18000);
  }

  /** A diagnostic probe must never start, install, or switch a connector. */
  async searchConnected(player: NativeConnectorId, query: string): Promise<PlayerTrack[]> {
    if (!this.running || this.activePlayer !== player || this.startPromise || this.stopping) {
      throw new Error('播放器连接已变化，请连接完成后重新检查');
    }
    return this.request({ action: 'search', player, query }, 18000);
  }

  async execute(
    player: NativeConnectorId,
    command: string,
    track?: PlayerTrack
  ): Promise<PlayerOperationResult> {
    await this.start(player);
    const rejected = rejectUnsupportedQqCommand(player, command, this.latestSnapshot);
    if (rejected) return rejected;
    const result = await this.request(
      { action: 'execute', player, command, track },
      23000
    );
    return result?.snapshot
      ? { ...result, snapshot: this.acceptSnapshot(result.snapshot) }
      : result;
  }

  private acceptSnapshot(snapshot: PlayerSnapshot): PlayerSnapshot {
    const normalized = mergeSnapshotCapabilities(snapshot, this.activeCapabilities);
    this.activeCapabilities = normalized.capabilities ?? null;
    this.latestSnapshot = normalized;
    return normalized;
  }

  private async resolveExecutable(
    player: NativeConnectorId
  ): Promise<string> {
    return this.updater.ensureInstalled(player);
  }

  private request(payload: Record<string, unknown>, timeoutMs: number): Promise<any> {
    const child = this.process;
    if (!child || child.killed || !child.stdin.writable) {
      return Promise.reject(new Error('播放器桥未运行'));
    }

    const id = `${Date.now()}-${++this.requestSequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`播放器桥请求超时: ${String(payload.action)}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });

      child.stdin.write(`${JSON.stringify({ id, ...payload })}\n`, error => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  private consumeStdout(
    child: ChildProcessWithoutNullStreams,
    chunk: string
  ): void {
    if (this.process !== child) return;
    this.stdoutLines?.push(chunk);
  }

  /**
   * Handles one complete stdout line outside the per-child stream buffer,
   * with the same validation. Protocol tests feed connector lines through it.
   */
  consumeLine(line: string): void {
    const text = line.trim();
    if (!text) return;
    let message: unknown;
    try {
      message = JSON.parse(text);
    } catch {
      this.reportInvalidOutput(INVALID_OUTPUT_LABELS['invalid-json'], text);
      return;
    }
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      this.reportInvalidOutput(INVALID_OUTPUT_LABELS['not-object'], text);
      return;
    }
    this.consumeMessage(message as Record<string, unknown>);
  }

  private consumeMessage(message: Record<string, unknown>): void {
    const envelope = message as unknown as BridgeEnvelope | PlayerBridgeEvent;
    if ('type' in envelope && envelope.type === 'event') {
      if (envelope.player !== this.activePlayer) return;
      try {
        this.onEvent({
          ...envelope,
          snapshot: envelope.snapshot
            ? this.acceptSnapshot(envelope.snapshot)
            : envelope.snapshot
        });
      } catch (error: any) {
        this.onLog(
          `[播放器桥] 实时事件处理失败: ${error?.message || error}`
        );
      }
      return;
    }

    if (!('id' in envelope)) return;

    const pending = this.pending.get(envelope.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(envelope.id);

    if (envelope.ok) pending.resolve(envelope.result);
    else pending.reject(new Error(envelope.error || '播放器桥请求失败'));
  }

  /** Non-protocol stdout is ignored and logged at most once per interval. */
  private reportInvalidOutput(reason: string, line = ''): void {
    const now = Date.now();
    if (now - this.invalidOutputLoggedAt < INVALID_OUTPUT_LOG_INTERVAL_MS) {
      return;
    }
    this.invalidOutputLoggedAt = now;
    const preview = line.length > INVALID_OUTPUT_PREVIEW_CHARS
      ? `${line.slice(0, INVALID_OUTPUT_PREVIEW_CHARS)}…`
      : line;
    this.onLog(
      `[播放器桥] 忽略无效输出（${reason}）${preview ? `：${preview}` : ''}`
    );
  }

  /** Forgets the active connector process and everything learned from it. */
  private releaseChild(): void {
    this.process = null;
    this.activePlayer = null;
    this.activeCapabilities = null;
    this.latestSnapshot = null;
    this.activeFeatures.clear();
    this.stdoutLines?.reset();
    this.stdoutLines = null;
  }

  private discardChild(child: ChildProcessWithoutNullStreams): void {
    // Release first: kill() can emit 'error' synchronously, and handleExit
    // must then find the child already inactive.
    this.releaseChild();
    this.rejectAll(new Error('连接器启动失败'));
    child.kill();
  }

  private handleExit(
    child: ChildProcessWithoutNullStreams,
    error: Error,
    notifyExit: boolean
  ): void {
    if (this.process !== child) return;
    const exitedPlayer = this.activePlayer;
    this.releaseChild();
    this.rejectAll(error);
    if (notifyExit && !this.stopping && exitedPlayer) {
      this.onEvent({
        type: 'event',
        event: 'connectorExit',
        player: exitedPlayer,
        sequence: 0,
        snapshot: null,
        error: error.message
      });
    }
  }

  private waitForExit(
    child: ChildProcessWithoutNullStreams,
    timeoutMs: number
  ): Promise<boolean> {
    if (child.exitCode !== null || child.signalCode !== null) {
      return Promise.resolve(true);
    }

    return new Promise(resolve => {
      let settled = false;
      const finish = (exited: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.off('exit', onExit);
        resolve(exited);
      };
      const onExit = () => finish(true);
      const timer = setTimeout(() => finish(false), timeoutMs);
      child.once('exit', onExit);
    });
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
