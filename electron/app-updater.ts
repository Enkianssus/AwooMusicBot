/**
 * Core self-update through Velopack.
 *
 * The native update manager, receipt store, lock and host callbacks are
 * injected so this state machine runs under node --test without Electron.
 * One operation owns the shared installation lock from the first check until
 * Velopack takes over the final restart.  Checks are bounded and a download
 * that stops reporting progress is abandoned, so a hung native call can no
 * longer block connector updates until the app restarts.
 */
import {
  markAppUpdateApplying,
  markAppUpdateExitRequested,
  markAppUpdateRetryable,
  markAppUpdateStarted,
  planAppUpdateRequest,
  type AppUpdatePhase
} from './app-update-policy.ts';
import {
  compareUpdateVersions,
  isUpdateVersion,
  type PendingCoreMarker
} from './update-announcements.ts';

export const APP_UPDATE_FEED_URL = 'https://app.enkianss.us/update/awoo';
export const APP_UPDATE_CHECK_TIMEOUT_MESSAGE = '检查更新超时，请检查网络后重试';
// The abandoned native download may still hold Velopack's update lock.
export const APP_UPDATE_STALL_MESSAGE =
  '下载长时间无进度，请检查网络后重试（如提示更新正在进行，请重启点歌机后再试）';

export type AppUpdateState =
  | 'idle'
  | 'checking'
  | 'downloading'
  | 'applying'
  | 'no-update'
  | 'error';

export type AppUpdateOutcome = 'no-update' | 'error';

export interface AppUpdateStatus {
  state: AppUpdateState;
  progress: number | null;
  version: string | null;
  message: string;
  sizeBytes?: number | null;
  updatedAt: string;
}

/** The parts of a Velopack UpdateInfo that the updater reads. */
export interface AppUpdateInfo {
  TargetFullRelease?: { Version?: unknown; Size?: unknown } | null;
}

export interface AppUpdateManager<Info extends AppUpdateInfo = AppUpdateInfo> {
  checkForUpdatesAsync(): Promise<Info | null>;
  downloadUpdateAsync(info: Info, progress: (percent: number) => void): Promise<void>;
  // Property syntax keeps this module at a single apply call site.
  waitExitThenApplyUpdate: (info: Info, silent: boolean, restart: boolean) => void;
}

export type AppUpdateManagerConstructor<Info extends AppUpdateInfo = AppUpdateInfo> =
  new (feedUrl: string) => AppUpdateManager<Info>;

export function createAppUpdateManager<Info extends AppUpdateInfo = AppUpdateInfo>(
  UpdateManagerCtor: AppUpdateManagerConstructor<Info>,
  feedUrl = APP_UPDATE_FEED_URL
): AppUpdateManager<Info> {
  return new UpdateManagerCtor(feedUrl);
}

export interface AppUpdateTimers {
  setTimer(callback: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

const systemTimers: AppUpdateTimers = {
  setTimer: (callback, ms) => setTimeout(callback, ms),
  clearTimer: handle => clearTimeout(handle as ReturnType<typeof setTimeout>)
};

/** Rejects with `message` unless `promise` settles within `ms`; a late result is ignored. */
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
  timers: AppUpdateTimers = systemTimers
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = timers.setTimer(() => reject(new Error(message)), ms);
    Promise.resolve(promise).then(value => {
      timers.clearTimer(timer);
      resolve(value);
    }, (error: unknown) => {
      timers.clearTimer(timer);
      reject(error);
    });
  });
}

export interface AppUpdateReceiptStore {
  list(): Promise<unknown>;
  prepareCoreUpdate(previousVersion: string, targetVersion: string, marker: PendingCoreMarker): Promise<void>;
  clearPendingCoreUpdate(): Promise<void>;
}

export interface AppUpdateGuard {
  acquire(componentId: 'core'): (() => void) | null;
}

export interface AppUpdaterOptions<Info extends AppUpdateInfo = AppUpdateInfo> {
  createManager: () => AppUpdateManager<Info>;
  receiptStore: AppUpdateReceiptStore;
  guard: AppUpdateGuard;
  requestQuit: () => unknown;
  log: (message: string, color: string) => void;
  setGlobalStatus: (message: string) => void;
  getVersion: () => string;
  now?: () => number;
  setTimer?: AppUpdateTimers['setTimer'];
  clearTimer?: AppUpdateTimers['clearTimer'];
  /** Bound for each feed query; 15 s by default. */
  checkTimeoutMs?: number;
  /** A download whose progress value stays unchanged this long is abandoned; 2 min by default, 0 disables. */
  stallTimeoutMs?: number;
  /** Called after the lock is released; not called once the restart is handed over. */
  onFinished?: (outcome: AppUpdateOutcome) => void;
}

/** Raised by the download watchdog; its message is shown as is. */
class AppUpdateStallError extends Error {}

function targetVersion(info: AppUpdateInfo): string | null {
  return String(info.TargetFullRelease?.Version || '') || null;
}

function targetSize(info: AppUpdateInfo): number | null {
  const size = info.TargetFullRelease?.Size;
  return typeof size === 'number' && Number.isFinite(size) && size >= 0 ? size : null;
}

export class AppUpdater<Info extends AppUpdateInfo = AppUpdateInfo> {
  private readonly options: AppUpdaterOptions<Info>;
  private readonly timers: AppUpdateTimers;
  private readonly checkTimeoutMs: number;
  private readonly stallTimeoutMs: number;
  private currentPhase: AppUpdatePhase = 'idle';
  private operation: Promise<void> | null = null;
  /** Advanced per attempt and on a stall so late native callbacks cannot act. */
  private generation = 0;
  private status: AppUpdateStatus;

  constructor(options: AppUpdaterOptions<Info>) {
    this.options = options;
    this.timers = {
      setTimer: options.setTimer ?? systemTimers.setTimer,
      clearTimer: options.clearTimer ?? systemTimers.clearTimer
    };
    this.checkTimeoutMs = options.checkTimeoutMs ?? 15_000;
    this.stallTimeoutMs = options.stallTimeoutMs ?? 120_000;
    this.status = {
      state: 'idle', progress: null, version: null, message: '', sizeBytes: null,
      updatedAt: this.timestamp()
    };
  }

  get phase(): AppUpdatePhase {
    return this.currentPhase;
  }

  getStatus(): AppUpdateStatus {
    return { ...this.status };
  }

  /** A bounded feed query; it never downloads and does not take the lock. */
  async check(): Promise<{ hasUpdate: boolean; version?: string }> {
    const manager = this.options.createManager();
    const info = await withTimeout(
      manager.checkForUpdatesAsync(), this.checkTimeoutMs, APP_UPDATE_CHECK_TIMEOUT_MESSAGE, this.timers
    );
    if (!info) return { hasUpdate: false };
    const version = targetVersion(info);
    return version ? { hasUpdate: true, version } : { hasUpdate: true };
  }

  start(): boolean {
    if (
      this.operation
      || planAppUpdateRequest(this.currentPhase) === 'already-running'
    ) {
      return false;
    }
    const releaseUpdateLock = this.options.guard.acquire('core');
    if (!releaseUpdateLock) return false;
    const generation = ++this.generation;
    this.currentPhase = markAppUpdateStarted();
    let outcome: AppUpdateOutcome | null = null;
    const operation: Promise<void> = this.run(generation)
      .then(result => { outcome = result; })
      .finally(() => {
        // Once Velopack owns the final restart, keep both gates closed until this
        // old process has actually exited. Failed/no-update attempts are retryable.
        if (this.currentPhase === 'exit-requested') return;
        if (this.operation === operation) this.operation = null;
        releaseUpdateLock();
        if (outcome) this.notifyFinished(outcome);
      });
    this.operation = operation;
    return true;
  }

  private async run(generation: number): Promise<AppUpdateOutcome | null> {
    let pendingSaved = false;
    try {
      this.setStatus({
        state: 'checking', progress: 0, version: null, message: '正在确认更新版本', sizeBytes: null
      });
      const manager = this.options.createManager();
      const info = await withTimeout(
        manager.checkForUpdatesAsync(), this.checkTimeoutMs, APP_UPDATE_CHECK_TIMEOUT_MESSAGE, this.timers
      );
      if (!info) {
        this.currentPhase = markAppUpdateRetryable();
        this.setStatus({
          state: 'no-update', progress: null, version: null, message: '当前已经是最新版本', sizeBytes: null
        });
        return 'no-update';
      }

      const version = targetVersion(info);
      if (!version) throw new Error('更新包缺少版本号');
      // Refuse what the receipt store would reject before spending a full download.
      if (!isUpdateVersion(version)) throw new Error(`更新目标版本格式无效：${version}`);
      if (compareUpdateVersions(version, this.options.getVersion()) <= 0) {
        throw new Error('更新目标版本必须高于当前版本');
      }
      await this.options.receiptStore.list();

      const sizeBytes = targetSize(info);
      this.setStatus({ state: 'downloading', progress: 0, version, message: '正在下载更新', sizeBytes });
      this.options.setGlobalStatus('🚀 下载更新中...');
      await this.download(manager, info, version, sizeBytes, generation);
      await this.options.receiptStore.prepareCoreUpdate(this.options.getVersion(), version, {
        startedAt: this.timestamp(),
        pid: process.pid
      });
      pendingSaved = true;
      this.setStatus({
        state: 'applying', progress: 100, version, message: '下载完成，正在重启安装', sizeBytes
      });
      this.currentPhase = markAppUpdateApplying();
      manager.waitExitThenApplyUpdate(info, false, true);
      // Velopack owns the one final restart.  Keep the phase latched after
      // this point so duplicate requests cannot start another updater.
      this.currentPhase = markAppUpdateExitRequested();
      this.options.requestQuit();
      return null;
    } catch (error: unknown) {
      if (pendingSaved) {
        await this.options.receiptStore.clearPendingCoreUpdate().catch(() => undefined);
      }
      this.currentPhase = markAppUpdateRetryable();
      const message = error instanceof Error ? error.message : String(error);
      this.setStatus({
        state: 'error', progress: null, version: null, sizeBytes: null,
        message: error instanceof AppUpdateStallError ? message : `更新失败：${message}`
      });
      this.options.setGlobalStatus('❌ 更新失败');
      this.options.log(`[更新] ${message}`, 'Red');
      return 'error';
    }
  }

  /**
   * Settles on completion, failure or stall, whichever comes first.  After a
   * stall the native task may still report progress or finish; neither can
   * reach the receipt store or the apply step.
   */
  private download(
    manager: AppUpdateManager<Info>,
    info: Info,
    version: string,
    sizeBytes: number | null,
    generation: number
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let watchdog: unknown = null;
      let lastValue = 0;
      let lastLoggedBucket = -1;
      const disarm = () => {
        if (watchdog !== null) this.timers.clearTimer(watchdog);
        watchdog = null;
      };
      const arm = () => {
        disarm();
        if (!Number.isFinite(this.stallTimeoutMs) || this.stallTimeoutMs <= 0) return;
        watchdog = this.timers.setTimer(() => {
          watchdog = null;
          if (settled) return;
          settled = true;
          this.generation++;
          reject(new AppUpdateStallError(APP_UPDATE_STALL_MESSAGE));
        }, this.stallTimeoutMs);
      };
      const settle = (error?: unknown) => {
        if (settled) return;
        settled = true;
        disarm();
        if (error === undefined) resolve();
        else reject(error);
      };
      const onProgress = (rawProgress: number) => {
        if (settled || generation !== this.generation) return;
        const value = Number(rawProgress);
        const progress = Math.max(0, Math.min(100, Math.floor(value || 0)));
        this.setStatus({ state: 'downloading', progress, version, message: '正在下载更新', sizeBytes });
        const bucket = Math.floor(progress / 10);
        if (bucket > lastLoggedBucket) {
          lastLoggedBucket = bucket;
          this.options.log(`[更新] 真实下载进度: ${progress}%`, 'DarkGray');
        }
        if (Number.isFinite(value) && value !== lastValue) {
          lastValue = value;
          arm();
        }
      };
      arm();
      let native: Promise<void>;
      try {
        native = Promise.resolve(manager.downloadUpdateAsync(info, onProgress));
      } catch (error: unknown) {
        native = Promise.reject(error);
      }
      native.then(() => settle(), (error: unknown) => settle(error ?? new Error('下载失败')));
    });
  }

  private notifyFinished(outcome: AppUpdateOutcome): void {
    try {
      this.options.onFinished?.(outcome);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.options.log(`[更新] 更新结果通知失败：${message}`, 'Yellow');
    }
  }

  private setStatus(next: Omit<AppUpdateStatus, 'updatedAt'>): void {
    this.status = { ...next, updatedAt: this.timestamp() };
  }

  private timestamp(): string {
    return new Date(this.options.now?.() ?? Date.now()).toISOString();
  }
}
