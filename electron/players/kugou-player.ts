import type { PlayerBridgeClient } from '../player-bridge-client';
import { NativePlayerBackend } from './native-player';

export class KugouPlayerBackend extends NativePlayerBackend {
  constructor(bridge: PlayerBridgeClient) {
    super('kugou', '酷狗音乐', bridge);
  }
}
