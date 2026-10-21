import {
  PlayerBridgeClient,
  type PlayerBridgeEvent
} from '../player-bridge-client';
import {
  tracksHaveDifferentStableIds,
  tracksRepresentSameSong
} from '../queue-head-policy';
import {
  type ConnectorRollbackResult,
  type ConnectorUpdateOptions,
  type ConnectorUpdateResult,
  type ConnectorUpdateStatus,
  type NativeConnectorId,
  type QQMusicProfileRefreshResult
} from '../connector-updater';
import { createStartBackoff } from '../connector-start-backoff';
import {
  inspectPlayerProcess,
  type PlayerProcessInfo
} from '../player-process-inspector';
import { FoliaPlayerBackend } from './folia-player';
import { KugouPlayerBackend } from './kugou-player';
import { NeteasePlayerBackend } from './netease-player';
import { QQMusicPlayerBackend } from './qqmusic-player';
import { rejectUnsupportedQqCommand } from '../qq-native-compatibility-policy';
import {
  isSuccessfulPlayerResult,
  PLAYER_LABELS,
  toPlayerTrack,
  type PlayerBackend,
  type PlayerCommand,
  type PlayerConnectionState,
  type PlayerKey,
  type PlayerOperationResult,
  type PlayerSnapshot,
  type PlayerSongInput,
  type PlayerTrack,
  type PlayerTrackObservation
} from './types';

interface PlayerManagerOptions {
  getSelectedKey: () => PlayerKey;
  getFoliaToken: () => string;
  log: (message: string, color?: string) => void;
  setStatus: (message: string) => void;
  onStateChanged: (state: PlayerConnectionState) => void;
  onTrackChanged: (
    track: PlayerTrack | null,
    observation: PlayerTrackObservation
  ) => Promise<void>;
  onTrackUpdated: (
    track: PlayerTrack,
    observation: PlayerTrackObservation
  ) => Promise<void>;
}

export interface PlayerConnectorUpdateOptions extends ConnectorUpdateOptions {
  /**
   * Asked once the update of the selected connector is installed and any
   * running command has finished. True keeps the running connector instead
   * of reconnecting, for example while a reconnect would drop the next-song
   * guard of requested playback; applyDeferredConnectorRestart() applies the
   * update later.
   */
  deferReconnectWhile?: () => boolean;
}

export type PlayerConnectorUpdateResult = ConnectorUpdateResult & {
  reconnected?: boolean;
  /** Installed, but the previous version keeps running until a restart. */
  reconnectDeferred?: boolean;
};

export type DeferredConnectorRestartResult =
  | { restarted: false }
  | { restarted: true; reconnected: boolean };

export class PlayerManager {
  private readonly bridge: PlayerBridgeClient;
  private readonly backends: Record<PlayerKey, PlayerBackend>;
  private selectionGeneration = 0;
  private probeGeneration: number | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private readonly startBackoff = createStartBackoff();
  private startBackoffKey: PlayerKey | null = null;
  private lastObservedTrackKey: string | null = null;
  private lastObservedTrack: PlayerTrack | null = null;
  private missingTrackObservationCount = 0;
  private observationEpoch = 0;
  private observationTail: Promise<void> = Promise.resolve();
  private operationTail: Promise<void> = Promise.resolve();
  /**
   * A connector whose update is installed while its previous version still
   * runs. Anything that ends that process clears it: the next start
   * launches the active version anyway.
   */
  private deferredRestart: NativeConnectorId | null = null;
  private state: PlayerConnectionState = {
    connected: false,
    connecting: false,
    snapshot: null
  };

  constructor(private readonly options: PlayerManagerOptions) {
    this.bridge = new PlayerBridgeClient(
      message => this.options.log(message, 'Yellow'),
      this.options.getFoliaToken,
      event => this.handleBridgeEvent(event)
    );
    this.backends = {
      netease: new NeteasePlayerBackend(this.bridge),
      kugou: new KugouPlayerBackend(this.bridge),
      qqmusic: new QQMusicPlayerBackend(this.bridge),
      folia: new FoliaPlayerBackend(this.bridge)
    };
  }

  get selectedKey(): PlayerKey {
    return this.options.getSelectedKey();
  }

  get selectedLabel(): string {
    return PLAYER_LABELS[this.selectedKey];
  }

  get connectionState(): PlayerConnectionState {
    return { ...this.state };
  }

  /**
   * The selected connector whose installed update waits for a restart while
   * its previous version still runs.
   */
  get deferredConnectorRestart(): NativeConnectorId | null {
    return this.deferredRestart !== null
      && this.deferredRestart === this.selectedKey
      && this.bridge.running
      ? this.deferredRestart
      : null;
  }

  async start(): Promise<boolean> {
    try {
      const connected = await this.connectSelected();
      if (this.backends[this.selectedKey].usesNativeBridge) {
        this.options.log(
          `✅ 播放器桥已启动，当前选择: ${this.selectedLabel}`,
          'Green'
        );
      }
      return connected;
    } catch (error: any) {
      this.setState(false, false, null);
      this.options.log(
        `❌ 播放器连接启动失败: ${error?.message || error}`,
        'Red'
      );
      return false;
    }
  }

  async reconnect(): Promise<boolean> {
    const generation = ++this.selectionGeneration;
    // The restart below launches the active version.
    this.deferredRestart = null;
    this.stopPolling();
    this.startBackoff.reset();
    this.resetObservedTrack();
    this.setState(false, true, null);
    try {
      if (this.backends[this.selectedKey].usesNativeBridge) {
        await this.bridge.restart(this.selectedKey);
        this.options.log(
          `✅ 播放器桥已重连，正在探测 ${this.selectedLabel}`,
          'Green'
        );
      }
      return await this.connectSelected();
    } catch (error: any) {
      // connectSelected() handles its own failures, so the restart failed.
      // A newer connect or switch owns the state by now.
      if (generation !== this.selectionGeneration) return false;
      this.setState(false, false, null);
      this.options.log(
        `❌ 播放器重连失败: ${error?.message || error}`,
        'Red'
      );
      // Without a poll nothing would start the connector again; the poll
      // retries it on the start backoff, like after a failed connect.
      if (
        this.backends[this.selectedKey].usesNativeBridge
        && !this.bridge.supportsSnapshotEvents
      ) {
        this.stopPolling();
        this.pollTimer = setInterval(
          () => void this.pollNativePlayer(generation),
          350
        );
      }
      return false;
    }
  }

  async getConnectorStatuses(
    forceRefresh = false,
    connectorId?: NativeConnectorId
  ): Promise<ConnectorUpdateStatus[]> {
    return this.bridge.getConnectorStatuses(forceRefresh, connectorId);
  }

  async isConnectorInstalled(
    connectorId: NativeConnectorId
  ): Promise<boolean> {
    return this.bridge.isConnectorInstalled(connectorId);
  }

  /**
   * Probe the actual desktop player independently of the connector process.
   * This is intentionally separate from connectionState: a connector can
   * fail before it has returned any snapshot, while the player is still
   * running and may have a newer file version.
   */
  async inspectSelectedPlayerProcess(): Promise<PlayerProcessInfo> {
    return await inspectPlayerProcess(this.selectedKey);
  }

  /**
   * Installs while normal commands continue on the running connector; the
   * new version lives in its own directory and only a restart launches it.
   * After an install of the selected connector it reconnects, unless
   * `deferReconnectWhile` says that would interrupt playback right now.
   */
  async updateConnector(
    connectorId: NativeConnectorId,
    allowPlayerVersionChange = false,
    options: PlayerConnectorUpdateOptions = {}
  ): Promise<PlayerConnectorUpdateResult> {
    // Download and verify in the background while normal commands continue.
    const result = await this.bridge.updateConnector(
      connectorId,
      allowPlayerVersionChange,
      { automatic: options.automatic === true }
    );
    if (
      result.success
      && result.updated
      && this.selectedKey === connectorId
    ) {
      // A freshly installed connector is retried at once, even while the
      // reconnect below waits for a running command.
      this.startBackoff.reset();
      let release!: () => void;
      const previous = this.operationTail;
      this.operationTail = new Promise<void>(resolve => {
        release = resolve;
      });
      await previous;
      try {
        if (this.selectedKey !== connectorId) {
          return result;
        }
        // Asked only now: requested playback may have started during the
        // download or the command that just finished. Nothing was stopped
        // for the install, so a running previous version keeps serving it.
        if (this.bridge.running && options.deferReconnectWhile?.() === true) {
          this.deferredRestart = connectorId;
          return {
            ...result,
            reconnectDeferred: true,
            message: `${result.message}，为避免打断当前播放，将在空闲时重新连接播放器以启用新版本`
          };
        }
        const reconnected = await this.reconnect();
        return {
          ...result,
          reconnected,
          message: reconnected
            ? `${result.message}，已自动重连播放器`
            : `${result.message}，后台正在等待播放器连接`
        };
      } finally {
        release();
      }
    }
    return result;
  }

  /**
   * Starts the installed version after an update that deferred its
   * reconnect, once any running command has finished; `deferWhile` is asked
   * again at that point. Restarts nothing when no restart is pending any
   * more: a reconnect, stop, player switch or connector exit already ended
   * the previous version.
   */
  async applyDeferredConnectorRestart(
    deferWhile?: () => boolean
  ): Promise<DeferredConnectorRestartResult> {
    if (this.deferredConnectorRestart === null) return { restarted: false };
    let release!: () => void;
    const previous = this.operationTail;
    this.operationTail = new Promise<void>(resolve => {
      release = resolve;
    });
    await previous;
    try {
      if (this.deferredConnectorRestart === null || deferWhile?.() === true) {
        return { restarted: false };
      }
      return { restarted: true, reconnected: await this.reconnect() };
    } finally {
      release();
    }
  }

  async reinstallConnector(
    connectorId: NativeConnectorId
  ): Promise<PlayerConnectorUpdateResult> {
    let release!: () => void;
    const previous = this.operationTail;
    this.operationTail = new Promise<void>(resolve => {
      release = resolve;
    });
    await previous;

    const selected = this.selectedKey === connectorId;
    // Set once the selected connector is being stopped. A reinstall that
    // fails from then on (the shared update lock is busy, for example) must
    // still bring the connector back: otherwise polling stays stopped and
    // the state stays "connecting" with nothing left to start it.
    let restoreOnFailure = false;
    try {
      if (selected) {
        restoreOnFailure = true;
        this.selectionGeneration++;
        this.deferredRestart = null;
        this.stopPolling();
        this.resetObservedTrack();
        this.backends[connectorId].deactivate();
        await this.bridge.stop();
        this.setState(false, true, null);
      }

      const result = await this.bridge.reinstallConnector(connectorId);
      if (selected) {
        restoreOnFailure = false;
        const reconnected = await this.reconnect();
        return {
          ...result,
          reconnected,
          message: result.success
            ? reconnected
              ? `${result.message}，已自动重连播放器`
              : `${result.message}，后台正在等待播放器连接`
            : `${result.message}；已恢复原连接器连接`
        };
      }
      return {
        ...result
      };
    } catch (error: unknown) {
      if (restoreOnFailure) {
        // reconnect() reports its own failure and leaves a retrying poll;
        // the caller still receives the reinstall error.
        await this.reconnect().catch(() => false);
      }
      throw error;
    } finally {
      release();
    }
  }

  /**
   * Reverts a connector to the version its last update replaced, after any
   * running command. The selected connector is stopped and stays
   * disconnected; the caller reconnects once the rollback has settled.
   */
  async rollbackConnector(
    connectorId: NativeConnectorId
  ): Promise<ConnectorRollbackResult> {
    let release!: () => void;
    const previous = this.operationTail;
    this.operationTail = new Promise<void>(resolve => {
      release = resolve;
    });
    await previous;

    try {
      if (this.selectedKey === connectorId) {
        this.selectionGeneration++;
        this.deferredRestart = null;
        this.stopPolling();
        this.resetObservedTrack();
        this.backends[connectorId].deactivate();
        this.setState(false, true, null);
      }
      // The bridge stops the connector before its files are switched back.
      return await this.bridge.rollbackConnector(connectorId);
    } finally {
      release();
    }
  }

  async refreshConnectorProfiles(
    connectorId: NativeConnectorId
  ): Promise<QQMusicProfileRefreshResult> {
    return this.bridge.refreshConnectorProfiles(connectorId);
  }

  async connectSelected(): Promise<boolean> {
    const generation = ++this.selectionGeneration;
    this.observationEpoch++;
    this.stopPolling();
    this.startBackoff.reset();
    this.setState(false, true, null);

    const selectedKey = this.selectedKey;
    // Starting another player stops the shared bridge process, so the
    // deferred connector launches its active version when selected again.
    if (this.deferredRestart !== selectedKey) this.deferredRestart = null;
    for (const [key, backend] of Object.entries(this.backends)) {
      if (key !== selectedKey) backend.deactivate();
    }

    const backend = this.backends[selectedKey];
    let snapshot: PlayerSnapshot | null = null;
    try {
      snapshot = await backend.activate();
      if (generation !== this.selectionGeneration
          || selectedKey !== this.selectedKey) {
        return false;
      }
      this.acceptSnapshot(
        selectedKey,
        snapshot,
        backend.usesNativeBridge
      );
      return snapshot.connected;
    } catch (error: any) {
      if (generation === this.selectionGeneration) {
        this.options.log(
          `❌ ${backend.label} 连接失败: ${error?.message || error}`,
          'Red'
        );
        this.setState(false, true, snapshot);
      }
      return false;
    } finally {
      if (generation === this.selectionGeneration) {
        this.setState(
          this.state.connected,
          false,
          this.state.snapshot
        );
        if (
          backend.usesNativeBridge
          && !this.bridge.supportsSnapshotEvents
        ) {
          this.pollTimer = setInterval(
            () => void this.pollNativePlayer(generation),
            350
          );
        } else if (this.bridge.supportsSnapshotEvents) {
          this.options.log(
            `✅ ${backend.label} 已启用连接器实时状态事件，不再进行 350ms 状态轮询`,
            'Green'
          );
        }
      }
    }
  }

  async search(query: string): Promise<PlayerTrack[]> {
    const requestedKey = this.selectedKey;
    const results = await this.backends[requestedKey].search(query);
    if (requestedKey !== this.selectedKey) {
      throw new Error('搜索期间播放器已切换，已丢弃旧播放器结果');
    }
    return results;
  }

  async searchConnected(query: string): Promise<PlayerTrack[]> {
    const requestedKey = this.selectedKey;
    const generation = this.selectionGeneration;
    if (!this.state.connected || this.state.connecting) {
      throw new Error('播放器尚未连接，无法测试歌曲搜索');
    }
    const results = await this.bridge.searchConnected(requestedKey, query);
    if (requestedKey !== this.selectedKey || generation !== this.selectionGeneration) {
      throw new Error('搜索期间播放器连接已变化，请重新检查');
    }
    return results;
  }

  async execute(
    command: PlayerCommand,
    song?: PlayerSongInput
  ): Promise<PlayerOperationResult | null> {
    const requestedKey = this.selectedKey;
    let release!: () => void;
    const previous = this.operationTail;
    this.operationTail = new Promise<void>(resolve => { release = resolve; });
    await previous;

    if (requestedKey !== this.selectedKey) {
      release();
      return {
        outcome: 'rejected',
        message: '等待执行期间播放器已切换，旧指令已取消',
        snapshot: this.state.snapshot
      };
    }

    const backend = this.backends[requestedKey];
    try {
      const rejected = rejectUnsupportedQqCommand(requestedKey, command, this.state.snapshot);
      if (rejected) return rejected;
      const result = await backend.execute(
        command,
        song ? toPlayerTrack(song) : undefined
      );
      if (result.snapshot && requestedKey === this.selectedKey) {
        // Command receipts carry compatibility changes just like probes/events.
        // Track advancement remains owned by independent observations.
        this.acceptSnapshot(requestedKey, result.snapshot, false);
      }
      if (!isSuccessfulPlayerResult(result)) {
        this.options.log(
          `⚠️ ${backend.label} ${command} 未生效: ${result.message}`,
          'Yellow'
        );
      }
      return result;
    } catch (error: any) {
      this.options.log(
        `❌ ${backend.label} ${command} 异常: ${error?.message || error}`,
        'Red'
      );
      return null;
    } finally {
      release();
    }
  }

  resetObservedTrack(): void {
    this.lastObservedTrackKey = null;
    this.lastObservedTrack = null;
    this.missingTrackObservationCount = 0;
  }

  async stop(): Promise<void> {
    this.selectionGeneration++;
    this.observationEpoch++;
    this.deferredRestart = null;
    this.stopPolling();
    for (const backend of Object.values(this.backends)) {
      backend.deactivate();
    }
    await this.bridge.stop();
    this.setState(false, false, null);
  }

  private async pollNativePlayer(generation: number): Promise<void> {
    if (generation !== this.selectionGeneration) return;
    const selectedKey = this.selectedKey;
    const backend = this.backends[selectedKey];
    if (!backend.usesNativeBridge
        || this.probeGeneration === generation) {
      return;
    }
    // A connector that failed to start waits out its backoff instead of being
    // respawned on every tick; a running bridge keeps the 350ms cadence.
    if (!this.bridge.running && !this.canAttemptStart(selectedKey)) return;

    this.probeGeneration = generation;
    let started = false;
    try {
      if (!this.bridge.running) {
        try {
          await this.bridge.start(selectedKey);
        } catch (error: any) {
          if (generation !== this.selectionGeneration) return;
          this.recordStartFailure(backend.label, error);
          this.setState(false, false, this.state.snapshot);
          return;
        }
        started = true;
      }
      const snapshot = await backend.probe();
      if (generation !== this.selectionGeneration
          || selectedKey !== this.selectedKey) {
        return;
      }
      this.startBackoff.recordSuccess();
      this.acceptSnapshot(selectedKey, snapshot, true);
    } catch (error: any) {
      if (generation !== this.selectionGeneration) return;
      if (started && !this.bridge.running) {
        // It exited before its first snapshot, so the streak continues.
        this.recordStartFailure(backend.label, error);
      } else if (this.state.connected || this.state.connecting) {
        this.options.log(
          `⚠️ 播放器状态探测失败: ${error?.message || error}`,
          'Yellow'
        );
      }
      this.setState(false, false, this.state.snapshot);
    } finally {
      if (this.probeGeneration === generation) {
        this.probeGeneration = null;
      }
    }
  }

  private canAttemptStart(key: PlayerKey): boolean {
    if (this.startBackoffKey !== key) {
      // A failure streak belongs to one connector; another starts fresh.
      this.startBackoffKey = key;
      this.startBackoff.reset();
    }
    return this.startBackoff.canAttempt(Date.now());
  }

  private recordStartFailure(label: string, error: any): void {
    const failure = this.startBackoff.recordFailure(Date.now());
    // Log once per streak and once more when the delay settles at its cap.
    if (failure.firstInStreak || failure.firstAtCap) {
      this.options.log(
        `⚠️ ${label} 连接器启动失败，将在 ${failure.delayMs / 1000} 秒后重试：`
        + `${error?.message || error}`,
        'Yellow'
      );
    }
  }

  private handleBridgeEvent(event: PlayerBridgeEvent): void {
    if (event.player !== this.selectedKey) return;
    if (event.event === 'connectorExit') {
      this.options.log(
        `⚠️ ${PLAYER_LABELS[event.player]} 连接器已退出: ${event.error || '未知原因'}`,
        'Yellow'
      );
      this.observationEpoch++;
      this.resetObservedTrack();
      // The next start launches the active version.
      if (this.deferredRestart === event.player) this.deferredRestart = null;
      this.setState(false, false, this.state.snapshot);
      return;
    }
    if (event.event !== 'snapshot' || !event.snapshot) return;
    this.acceptSnapshot(event.player, event.snapshot, true);
  }

  private acceptSnapshot(
    sourceKey: PlayerKey,
    snapshot: PlayerSnapshot,
    observeTrack: boolean
  ): void {
    if (sourceKey !== this.selectedKey) return;
    if (
      sourceKey === 'qqmusic'
      && snapshot.ownsLogicalNext === true
      && snapshot.observationDeferred === true
    ) {
      // A busy probe can arrive after the command's newer snapshot event. Keep
      // the accepted state and never interpret its historical Current/Next as
      // a track change or a reason to register another logical queue target.
      // During initial connection it may supply display-only status until a
      // real observation arrives; it must not drive queue actions even then.
      if (this.state.snapshot === null) {
        this.setState(snapshot.connected, this.state.connecting, snapshot);
      }
      return;
    }
    const wasConnected = this.state.connected;
    this.setState(snapshot.connected, this.state.connecting, snapshot);

    if (wasConnected !== snapshot.connected) {
      this.options.log(
        snapshot.connected
          ? `✅ 已连接 ${snapshot.player}`
            + `${snapshot.version ? ` ${snapshot.version}` : ''}`
          : `⚠️ ${PLAYER_LABELS[sourceKey]} 未连接`,
        snapshot.connected ? 'Green' : 'Yellow'
      );
    }

    if (observeTrack) {
      const nextTrack = snapshot.connected ? snapshot.next || null : null;
      const nextObservation = snapshot.nextObservation
        || (nextTrack
          ? 'track'
          : sourceKey === 'qqmusic'
            ? 'unknown'
            : 'legacy');
      this.queueObservation(sourceKey, {
        track: snapshot.connected ? snapshot.current || null : null,
        nextTrack,
        nextObservation,
        nextGuardState: snapshot.nextGuardState || 'none',
        nextGuardId: Number.isSafeInteger(snapshot.nextGuardId)
          && Number(snapshot.nextGuardId) > 0
          ? Number(snapshot.nextGuardId)
          : 0,
        playbackAnchorReady: snapshot.playbackAnchorReady === true,
        coverUrl: snapshot.current?.coverUrl || '',
        nextDescription: snapshot.next?.title
          ? `${snapshot.next.title}${snapshot.next.artist ? ` - ${snapshot.next.artist}` : ''}`
          : '由下一首守卫管理'
      });
    }
  }

  private queueObservation(
    sourceKey: PlayerKey,
    observation: PlayerTrackObservation
  ): void {
    const selectionGeneration = this.selectionGeneration;
    const observationEpoch = this.observationEpoch;
    this.observationTail = this.observationTail
      .then(async () => {
        if (
          sourceKey !== this.selectedKey
          || selectionGeneration !== this.selectionGeneration
          || observationEpoch !== this.observationEpoch
          || !this.state.connected
        ) return;
        const track = observation.track;
        if (!track?.title) {
          this.missingTrackObservationCount++;
          // Native player metadata can briefly disappear while its cache and
          // window title are being rewritten. Do not turn a single empty poll
          // into a fake stop/start sequence because it can hide the real track
          // transition that advances the request queue.
          if (this.missingTrackObservationCount < 3) return;
          if (this.lastObservedTrackKey) {
            await this.options.onTrackChanged(null, observation);
            this.lastObservedTrackKey = null;
            this.lastObservedTrack = null;
          }
          return;
        }

        this.missingTrackObservationCount = 0;

        const observedKey = this.getTrackKey(track);
        if (
          observedKey !== this.lastObservedTrackKey
          && (
            tracksHaveDifferentStableIds(this.lastObservedTrack, track)
            || !tracksRepresentSameSong(this.lastObservedTrack, track)
          )
        ) {
          await this.options.onTrackChanged(track, observation);
          this.lastObservedTrackKey = observedKey;
          this.lastObservedTrack = track;
        } else {
          await this.options.onTrackUpdated(track, observation);
          this.lastObservedTrackKey = observedKey;
          this.lastObservedTrack = track;
        }
      })
      .catch((error: any) => {
        this.options.log(
          `⚠️ 播放器状态同步失败: ${error?.message || error}`,
          'Yellow'
        );
      });
  }

  private getTrackKey(track: PlayerTrack): string {
    return String(track.id || `${track.title}|${track.artist}`);
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private setState(
    connected: boolean,
    connecting: boolean,
    snapshot: PlayerSnapshot | null
  ): void {
    this.state = { connected, connecting, snapshot };
    this.options.onStateChanged(this.connectionState);
  }
}
