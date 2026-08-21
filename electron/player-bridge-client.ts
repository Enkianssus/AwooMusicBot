import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import fs from 'fs';
import {
  ConnectorUpdater,
  type ConnectorUpdateResult,
  type ConnectorUpdateStatus,
  type NativeConnectorId
} from './connector-updater';
import { ConnectorLifecycleGate } from './connector-lifecycle-gate';

const CONNECTOR_SHUTDOWN_DRAIN_TIMEOUT_MS = 25_000;
const CONNECTOR_FORCE_EXIT_TIMEOUT_MS = 2_000;

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
  observedAt: string;
  capabilities?: PlayerCapabilities | null;
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
  private activeFeatures = new Set<string>();
  private pending = new Map<string, PendingRequest>();
  private requestSequence = 0;
  private stdoutBuffer = '';
  private stopping = false;
  private startPromise: Promise<void> | null = null;
  private lifecycleGeneration = 0;
  private readonly lifecycleGate = new ConnectorLifecycleGate();
  private readonly updater: ConnectorUpdater;

  constructor(
    private readonly onLog: (message: string) => void,
    private readonly getFoliaToken: () => string = () => '',
    private readonly onEvent: (event: PlayerBridgeEvent) => void = () => {}
  ) {
    this.updater = new ConnectorUpdater(onLog);
  }

  get running(): boolean {
    return Boolean(this.process && !this.process.killed);
  }

  get supportsSnapshotEvents(): boolean {
    return this.activeFeatures.has('snapshot-events-v1');
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
    this.stdoutBuffer = '';
    this.activeCapabilities = null;
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

    child.stdout.setEncoding('utf8');
    child.stdout.on(
      'data',
      (chunk: string) => this.consumeStdout(child, chunk)
    );
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      const message = chunk.trim();
      if (message) this.onLog(`[播放器桥] ${message}`);
    });
    child.on('error', error => this.handleExit(child, error));
    child.on('exit', (code, signal) => {
      if (this.process !== child) return;
      if (!this.stopping) {
        this.onLog(`[播放器桥] 已退出 (code=${code}, signal=${signal || 'none'})`);
      }
      this.handleExit(
        child,
        new Error(`播放器桥已退出 (code=${code})`)
      );
    });

    const ping = await this.request({ action: 'ping' }, 5000);
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
    this.activeCapabilities = ping?.capabilities || null;
    this.activeFeatures = new Set(
      Array.isArray(ping?.features)
        ? ping.features.filter((feature: unknown): feature is string =>
          typeof feature === 'string'
        )
        : []
    );
    if (this.supportsSnapshotEvents) {
      const subscription = await this.request(
        {
          action: 'subscribe',
          eventProtocolVersion: 1
        },
        5000
      );
      if (!subscription?.subscribed) {
        this.activeFeatures.delete('snapshot-events-v1');
        this.onLog('[播放器桥] 实时事件订阅不可用，已回退到状态轮询');
      }
    }
    if (generation !== this.lifecycleGeneration || this.stopping) {
      throw new Error('连接器启动已取消');
    }
  }

  async restart(player: NativeConnectorId): Promise<void> {
    await this.stop();
    await this.start(player);
  }

  async getConnectorStatuses(
    forceRefresh = false
  ): Promise<ConnectorUpdateStatus[]> {
    return this.updater.getStatuses(forceRefresh);
  }

  async isConnectorInstalled(
    connectorId: NativeConnectorId
  ): Promise<boolean> {
    return this.updater.isInstalled(connectorId);
  }

  async updateConnector(
    connectorId: NativeConnectorId,
    allowPlayerVersionChange = false
  ): Promise<ConnectorUpdateResult> {
    return this.updater.update(
      connectorId,
      allowPlayerVersionChange
    );
  }

  async reinstallConnector(
    connectorId: NativeConnectorId
  ): Promise<ConnectorUpdateResult> {
    return this.updater.reinstall(connectorId);
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
          this.process = null;
          this.activePlayer = null;
          this.activeCapabilities = null;
          this.activeFeatures.clear();
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
    return {
      ...snapshot,
      capabilities: this.activeCapabilities
    };
  }

  async search(
    player: NativeConnectorId,
    query: string
  ): Promise<PlayerTrack[]> {
    await this.start(player);
    return this.request({ action: 'search', player, query }, 18000);
  }

  async execute(
    player: NativeConnectorId,
    command: string,
    track?: PlayerTrack
  ): Promise<PlayerOperationResult> {
    await this.start(player);
    return this.request(
      { action: 'execute', player, command, track },
      23000
    );
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
    this.stdoutBuffer += chunk;
    let newlineIndex = this.stdoutBuffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      if (line) this.consumeLine(line);
      newlineIndex = this.stdoutBuffer.indexOf('\n');
    }
  }

  private consumeLine(line: string): void {
    let envelope: BridgeEnvelope | PlayerBridgeEvent;
    try {
      envelope = JSON.parse(line);
    } catch {
      this.onLog(`[播放器桥] 非协议输出: ${line}`);
      return;
    }


    if ('type' in envelope && envelope.type === 'event') {
      if (envelope.player !== this.activePlayer) return;
      try {
        this.onEvent({
          ...envelope,
          snapshot: envelope.snapshot
            ? {
              ...envelope.snapshot,
              capabilities: this.activeCapabilities
            }
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

  private handleExit(
    child: ChildProcessWithoutNullStreams,
    error: Error
  ): void {
    if (this.process !== child) return;
    const exitedPlayer = this.activePlayer;
    this.process = null;
    this.activePlayer = null;
    this.activeCapabilities = null;
    this.activeFeatures.clear();
    this.rejectAll(error);
    if (!this.stopping && exitedPlayer) {
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
