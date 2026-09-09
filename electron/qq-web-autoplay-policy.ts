export function shouldSuspendQqAutoplay(
  ownsLogicalNext: boolean,
  playbackEnabled: boolean
): boolean {
  return ownsLogicalNext && !playbackEnabled;
}

export function shouldDiscardQqGuardOperation(options: {
  ownsLogicalNext: boolean;
  playbackEnabled: boolean;
  generation: number;
  operationGeneration: number;
}): boolean {
  return options.ownsLogicalNext && (
    !options.playbackEnabled
    || options.generation !== options.operationGeneration
  );
}

export function isQqAutoplayCancellationConfirmed(
  result: { outcome?: unknown } | null | undefined
): boolean {
  return Boolean(result && ['applied', 'verified'].includes(
    String(result.outcome).toLowerCase()
  ));
}
