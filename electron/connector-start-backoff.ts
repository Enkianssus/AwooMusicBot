/** Wait before each retry of a connector that failed to start; the last entry is the cap. */
export const CONNECTOR_START_BACKOFF_MS: readonly number[] = [1000, 2000, 5000, 15000, 30000];

export interface ConnectorStartFailure {
  delayMs: number;
  /** The first failure after a success or reset. */
  firstInStreak: boolean;
  /** The failure whose delay first reaches the cap. */
  firstAtCap: boolean;
}

export interface ConnectorStartBackoff {
  canAttempt(now: number): boolean;
  recordFailure(now: number): ConnectorStartFailure;
  recordSuccess(): void;
  reset(): void;
  readonly failures: number;
}

export function createStartBackoff(): ConnectorStartBackoff {
  let failures = 0;
  let nextAttemptAt = 0;
  const clear = () => {
    failures = 0;
    nextAttemptAt = 0;
  };

  return {
    canAttempt: now => now >= nextAttemptAt,
    recordFailure(now) {
      failures++;
      const steps = CONNECTOR_START_BACKOFF_MS.length;
      const delayMs = CONNECTOR_START_BACKOFF_MS[Math.min(failures, steps) - 1];
      nextAttemptAt = now + delayMs;
      return {
        delayMs,
        firstInStreak: failures === 1,
        firstAtCap: failures === steps
      };
    },
    recordSuccess: clear,
    reset: clear,
    get failures() {
      return failures;
    }
  };
}
