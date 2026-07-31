import {
  PlayerBridgeClient,
  type PlayerOperationResult,
  type PlayerSnapshot,
  type PlayerTrack
} from '../player-bridge-client';
import type {
  PlayerBackend,
  PlayerCommand,
  PlayerKey
} from './types';

export abstract class NativePlayerBackend implements PlayerBackend {
  readonly usesNativeBridge = true;

  protected constructor(
    readonly key: PlayerKey,
    readonly label: string,
    protected readonly bridge: PlayerBridgeClient
  ) {}

  async activate(): Promise<PlayerSnapshot> {
    return await this.probe();
  }

  deactivate(): void {
    // The four native adapters share one hidden bridge process. Switching
    // players only changes which adapter is probed; the process stays alive.
  }

  async probe(): Promise<PlayerSnapshot> {
    return await this.bridge.probe(this.key);
  }

  async search(query: string): Promise<PlayerTrack[]> {
    return await this.bridge.search(this.key, query);
  }

  async execute(
    command: PlayerCommand,
    track?: PlayerTrack
  ): Promise<PlayerOperationResult> {
    return await this.bridge.execute(this.key, command, track);
  }
}
