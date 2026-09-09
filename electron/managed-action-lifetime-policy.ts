/**
 * A Web selection is allowed to outlive the legacy 12-second attribution
 * window while its single bounded connector command is still in flight.
 * The bridge has a 23-second command timeout; this is a final 25-second cap,
 * not another dispatch, a receipt of playback, or an extension for old players.
 */
export function managedActionExpirationAt(action: {
  startedAt: number;
  expiresAt: number;
  inFlight: boolean;
  logicalNextOwnerAtDispatch: boolean;
}): number {
  return action.logicalNextOwnerAtDispatch && action.inFlight
    ? Math.max(action.expiresAt, action.startedAt + 25_000)
    : action.expiresAt;
}
