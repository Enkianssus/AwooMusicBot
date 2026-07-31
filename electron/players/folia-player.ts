import { PlayerBridgeClient } from '../player-bridge-client';
import { NativePlayerBackend } from './native-player';

export class FoliaPlayerBackend extends NativePlayerBackend {
  constructor(bridge: PlayerBridgeClient) {
    super('folia', 'Folia', bridge);
  }
}
