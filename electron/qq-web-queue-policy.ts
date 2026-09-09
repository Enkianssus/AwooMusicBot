/**
 * The Web connector owns its logical-next transition. Anchor independence
 * alone does not grant that ownership, and older connectors retain host policy.
 */
export function ownsQqLogicalNext(
  playerKey: string,
  snapshot: { ownsLogicalNext?: boolean } | null | undefined
): boolean {
  return playerKey === 'qqmusic' && snapshot?.ownsLogicalNext === true;
}
