import {
  PlayerBridgeClient,
  type PlayerBridgeEvent
} from '../player-bridge-client';
import {
  tracksHaveDifferentStableIds,
  tracksRepresentSameSong
} from '../queue-head-policy';
import {
  type ConnectorUpdateResult,
  type ConnectorUpdateStatus,
  type NativeConnectorId
} from '../connector-updater';
import { FoliaPlayerBackend } from './folia-player';
import { KugouPlayerBackend } from './kugou-player';
import { NeteasePlayerBackend } from './netease-player';
import { QQMusicPlayerBackend } from './qqmusic-player';
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

export class PlayerManager {
  private readonly bridge: PlayerBridgeClient;
  private readonly backends: Record<PlayerKey, PlayerBackend>;
  private selectionGeneration = 0;
  private probeGeneration: number | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private lastObservedTrackKey: string | null = null;
  private lastObservedTrack: PlayerTrack | null = null;
  private missingTrackObservationCount = 0;
  private observationEpoch = 0;
  private observationTail: Promise<void> = Promise.resolve();
  private operationTail: Promise<void> = Promise.resolve();
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
    this.selectionGeneration++;
    this.stopPolling();
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
      this.setState(false, false, null);
      this.options.log(
        `❌ 播放器重连失败: ${error?.message || error}`,
        'Red'
      );
      return false;
    }
  }

  async getConnectorStatuses(
    forceRefresh = false
  ): Promise<ConnectorUpdateStatus[]> {
    return this.bridge.getConnectorStatuses(forceRefresh);
  }

  async isConnectorInstalled(
    connectorId: NativeConnectorId
  ): Promise<boolean> {
    return this.bridge.isConnectorInstalled(connectorId);
  }

  async updateConnector(
    connectorId: NativeConnectorId,
    allowPlayerVersionChange = false
  ): Promise<ConnectorUpdateResult & { reconnected?: boolean }> {
    // Download and verify in the background while normal commands continue.
    const result = await this.bridge.updateConnector(
      connectorId,
      allowPlayerVersionChange
    );
    if (
      result.success
      && result.updated
      && this.selectedKey === connectorId
    ) {
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

  async reinstallConnector(
    connectorId: NativeConnectorId
  ): Promise<ConnectorUpdateResult & { reconnected?: boolean }> {
    let release!: () => void;
    const previous = this.operationTail;
    this.operationTail = new Promise<void>(resolve => {
      release = resolve;
    });
    await previous;

    const selected = this.selectedKey === connectorId;
    try {
      if (selected) {
        this.selectionGeneration++;
        this.stopPolling();
        this.resetObservedTrack();
        this.backends[connectorId].deactivate();
        await this.bridge.stop();
        this.setState(false, true, null);
      }

      const result = await this.bridge.reinstallConnector(connectorId);
      if (selected) {
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
    } finally {
      release();
    }
  }

  async connectSelected(): Promise<boolean> {
    const generation = ++this.selectionGeneration;
    this.observationEpoch++;
    this.stopPolling();
    this.setState(false, true, null);

    const selectedKey = this.selectedKey;
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
      const result = await backend.execute(
        command,
        song ? toPlayerTrack(song) : undefined
      );
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

    this.probeGeneration = generation;
    try {
      if (!this.bridge.running) {
        await this.bridge.start(selectedKey);
      }
      const snapshot = await backend.probe();
      if (generation !== this.selectionGeneration
          || selectedKey !== this.selectedKey) {
        return;
      }
      this.acceptSnapshot(selectedKey, snapshot, true);
    } catch (error: any) {
      if (generation !== this.selectionGeneration) return;
      if (this.state.connected || this.state.connecting) {
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

  private handleBridgeEvent(event: PlayerBridgeEvent): void {
    if (event.player !== this.selectedKey) return;
    if (event.event === 'connectorExit') {
      this.options.log(
        `⚠️ ${PLAYER_LABELS[event.player]} 连接器已退出: ${event.error || '未知原因'}`,
        'Yellow'
      );
      this.observationEpoch++;
      this.resetObservedTrack();
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
