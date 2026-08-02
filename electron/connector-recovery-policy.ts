export interface ConnectorRecoveryContext {
  connectorProbeResponded: boolean;
  installed: boolean;
  compatible: boolean;
  updateAvailable: boolean;
  updating: boolean;
}

/**
 * A disconnected player is not evidence that its connector is incompatible.
 * Auto-upgrade only when the connector itself failed before returning a probe
 * snapshot; otherwise keep the working connector and let normal polling wait
 * for the player process.
 */
export function shouldAutoUpgradeConnectorAfterFailure(
  context: ConnectorRecoveryContext
): boolean {
  return !context.connectorProbeResponded
    && context.installed
    && context.compatible
    && context.updateAvailable
    && !context.updating;
}
