/**
 * Process-local gate for the Velopack update lifecycle.
 *
 * Velopack is responsible for the one final restart.  The host only needs to
 * make the request and quit once; keeping that decision as a small pure state
 * machine makes duplicate HTTP requests and retry-after-failure behavior
 * deterministic without starting Electron in tests.
 */
export type AppUpdatePhase =
  | 'idle'
  | 'running'
  | 'applying'
  | 'exit-requested';

export type AppUpdateRequestDecision = 'start' | 'already-running';

export function planAppUpdateRequest(
  phase: AppUpdatePhase
): AppUpdateRequestDecision {
  return phase === 'idle' ? 'start' : 'already-running';
}

export function markAppUpdateStarted(): AppUpdatePhase {
  return 'running';
}

export function markAppUpdateApplying(): AppUpdatePhase {
  return 'applying';
}

export function markAppUpdateExitRequested(): AppUpdatePhase {
  return 'exit-requested';
}

/** A failed check/download or no-update result can be attempted again. */
export function markAppUpdateRetryable(): AppUpdatePhase {
  return 'idle';
}

/** Return true only for the first quit request in a process. */
export function shouldRequestAppQuit(
  exitRequested: boolean
): boolean {
  return !exitRequested;
}

/**
 * The packaged production app is single-instance by default.  The regular
 * Electron development runner and the `build:dev` output are intentionally
 * allowed to coexist with a production install; a copied dev build can opt
 * in explicitly with `--allow-multiple-instances` or the matching env flag.
 */
export function shouldAllowMultipleInstances(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  execPath: string,
  isPackaged: boolean
): boolean {
  if (argv.includes('--allow-multiple-instances')) return true;
  if (env['AWOO_ALLOW_MULTIPLE_INSTANCES'] === '1') return true;
  if (!isPackaged) return true;
  return /[\\/]dist_electron_dev(?:[_-][^\\/]+)?[\\/]/i.test(execPath);
}
