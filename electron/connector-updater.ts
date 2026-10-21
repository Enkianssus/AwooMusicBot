import { app, net } from 'electron';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { extractZipSafely } from './safe-zip.ts';
import {
  downloadBufferWithRanges,
  downloadWholeBufferWithRetries
} from './connector-download';
import {
  buildPrivateDotnetEnvironment,
  PrivateDotnetRuntimeManager,
  type DotnetRuntimeRid
} from './private-dotnet-runtime';
import {
  canAutoUpdateConnector,
  classifyConnectorUpdate,
  requiresManualConnectorUpdate,
  type ConnectorUpdateKind
} from './connector-version-policy';
import {
  AWOO_CONNECTOR_EXECUTABLE_NAMES,
  connectorAssetNames,
  connectorExecutableNames,
  isRecognizedConnectorAssetName,
  isRecognizedQQMusicProfileAssetName
} from './connector-branding-policy';
import {
  isTransientNeteaseFileLock,
  NeteaseProcessControlError,
  NeteaseUpdateProcessController,
  type NeteaseUpdateProcessSession
} from './netease-update-process';
import { buildConnectorGitHubReleaseUrl } from './connector-release-url';
import { shouldRunAutomaticConnectorMaintenance } from './dev-user-data-policy';
import { inspectPlayerProcess } from './player-process-inspector';
import {
  canUseCachedQqProfiles,
  selectQqProfileEntry,
  validateQqProfileDocument,
  verifyQqProfileArchive
} from './qq-profile-policy';
import {
  reportCompletedConnectorUpdate,
  updateInstallationGuard
} from './update-announcements';
import {
  createFailureMemo,
  createProgressLogThrottle,
  createReinstallCircuitBreaker,
  describeAutomaticReinstallBlocker,
  isConnectorDownloadError,
  type FailureMemo,
  type ReinstallCircuitBreaker
} from './connector-install-policy.ts';
import {
  removeStaleEntries,
  renameWithRetry,
  rmWithRetry
} from './fs-retry.ts';
// The stable endpoints live in connector-catalog-policy.ts: the updater reads
// only https://app.enkianss.us/connectors/v2/catalog.json and installs packages
// from https://app.enkianss.us/connectors/v2/download/. It never falls back to
// the frozen https://app.enkianss.us/connectors/v1/catalog.json.
import {
  assertV2Catalog,
  CATALOG_URL,
  CONNECTOR_PROTOCOL_VERSION,
  CONNECTOR_VERSION_PATTERN,
  describeNetworkError,
  describeStaleCatalog,
  PUBLIC_KEY_ID,
  RELEASE_PUBLIC_KEY,
  validateV2ConnectorEntry,
  verifyConnectorArchive
} from './connector-catalog-policy.ts';

export type NativeConnectorId =
  | 'netease'
  | 'kugou'
  | 'qqmusic'
  | 'folia';

export type ConnectorUpdatePhase =
  | 'runtime'
  | 'download'
  | 'verify'
  | 'install'
  | 'restart';

export interface ConnectorUpdateProgress {
  phase: ConnectorUpdatePhase;
  /** Whole percent of the current phase, or null when it is not measurable. */
  percent: number | null;
  updatedAt: string;
}

export interface ConnectorUpdateStatus {
  id: NativeConnectorId;
  name: string;
  installed: boolean;
  currentVersion: string | null;
  latestVersion: string | null;
  minimumCoreVersion: string | null;
  compatible: boolean;
  updateAvailable: boolean;
  autoUpdateAvailable: boolean;
  manualUpdateAvailable: boolean;
  updateKind: ConnectorUpdateKind;
  supportedPlayerVersion: string | null;
  /** Raw catalog metadata used by the one-shot player-branch repair policy. */
  playerVersionPolicy?: string | null;
  testedPlayerVersion?: string | null;
  updating: boolean;
  /** The step of the running install; null while `updating` is false. */
  progress?: ConnectorUpdateProgress | null;
  /**
   * The catalog could not be refreshed, so the versions come from the last
   * catalog this process fetched. Installs never use a stale catalog.
   */
  stale?: boolean;
  staleMessage?: string;
  /**
   * The latest version was rolled back on this computer and is not installed
   * automatically until the catalog advances or the user updates manually.
   */
  quarantined?: boolean;
  checkedAt: string;
  error: string | null;
}

export interface ConnectorRollbackResult {
  success: boolean;
  /** The version that is active after a successful rollback. */
  version?: string;
  message: string;
}

export interface QQMusicProfileRefreshResult {
  /** Another verified profile directory is active; a restart applies it. */
  changed: boolean;
  /** The active downloaded profile version; null means the built-in profiles. */
  version: string | null;
}

export interface ConnectorUpdateResult {
  success: boolean;
  updated: boolean;
  message: string;
  status: ConnectorUpdateStatus;
  /**
   * An automatic update stopped before anything was replaced because the
   * player was in use. Not a failure: nothing changed and a later attempt
   * applies it. Only set together with `success: false`.
   */
  deferred?: boolean;
  neteasePlayerWasRunning?: boolean;
  neteasePlayerRestarted?: boolean;
  neteasePlayerRestartError?: string | null;
}

export interface ConnectorUpdateOptions {
  /**
   * Background maintenance rather than a request of the user. An automatic
   * update never closes a running NetEase: it is deferred instead.
   */
  automatic?: boolean;
}

interface ConnectorPackageEntry {
  asset: string;
  size: number;
  sha256: string;
  signature: string;
  downloadUrl: string;
}

interface FrameworkDependentConnectorPackage extends ConnectorPackageEntry {
  runtime: DotnetRuntimeRid;
  runtimeChannel: '8.0';
}

interface V2ConnectorPackage extends FrameworkDependentConnectorPackage {
  deployment: 'framework-dependent';
}

interface ConnectorCatalogEntryMetadata {
  id: NativeConnectorId;
  version: string;
  protocolVersion: number;
  minimumCoreVersion: string;
  testedPlayerVersion?: string;
  playerVersionPolicy?: string;
  runtime?: DotnetRuntimeRid;
}

/**
 * The v1 catalog shape is kept here so an already installed connector can be
 * understood when older catalog data is encountered during a repair.  New
 * 1.1.10 clients never fetch this catalog anymore.
 */
interface LegacyConnectorCatalogEntry extends ConnectorCatalogEntryMetadata,
  ConnectorPackageEntry {
  frameworkDependent?: FrameworkDependentConnectorPackage;
  awooPackage?: ConnectorPackageEntry;
  awooFrameworkDependent?: FrameworkDependentConnectorPackage;
}

/**
 * v2 deliberately contains only the signed Awoo framework-dependent package.
 * Self-contained and legacy package fields are absent by contract.
 */
interface SmallOnlyConnectorCatalogEntry extends Omit<
  ConnectorCatalogEntryMetadata,
  'runtime'
> {
  package: V2ConnectorPackage;
}

type ConnectorCatalogEntry =
  | LegacyConnectorCatalogEntry
  | SmallOnlyConnectorCatalogEntry;

interface ConnectorCatalog {
  schemaVersion: 1 | 2;
  publicKeyId: string;
  connectors: Partial<Record<NativeConnectorId, ConnectorCatalogEntry>>;
}

interface FrameworkPackageFields {
  package?: V2ConnectorPackage;
  awooFrameworkDependent?: FrameworkDependentConnectorPackage;
  frameworkDependent?: FrameworkDependentConnectorPackage;
}

/**
 * Select the small framework-dependent package used for a new installation.
 *
 * The v2 `package` field is preferred.  The Awoo and legacy fields are
 * intentionally retained as read-only compatibility paths for v1-shaped
 * catalog data.  Full self-contained packages are not a valid new-install
 * fallback.
 */
export function selectFrameworkDependentConnectorPackage(
  entry: FrameworkPackageFields
): FrameworkDependentConnectorPackage | null {
  return entry.package
    || entry.awooFrameworkDependent
    || entry.frameworkDependent
    || null;
}

interface ActiveConnector {
  id: NativeConnectorId;
  version: string;
  executable: string;
  deployment?: 'self-contained' | 'framework-dependent';
  runtimeRid?: DotnetRuntimeRid;
  runtimeRoot?: string;
  activatedAt: string;
  /**
   * The version this activation replaced, kept for a rollback. Additive:
   * cores before 1.2.6 ignore it. A previous entry never has its own.
   */
  previous?: PreviousConnector;
}

type PreviousConnector = Pick<
  ActiveConnector,
  'version' | 'executable' | 'deployment' | 'runtimeRid' | 'runtimeRoot'
>;

/** A recorded version whose files passed the active.json path checks. */
type ResolvedConnector = Required<
  Pick<ActiveConnector, 'version' | 'executable' | 'deployment'>
> & Pick<ActiveConnector, 'runtimeRid' | 'runtimeRoot'>;

type ConnectorPackageActivation = Pick<
  ActiveConnector,
  'deployment' | 'runtimeRid' | 'runtimeRoot'
>;

/** One rolled-back version in `<connectorRoot>/quarantine.json`. */
interface ConnectorQuarantineEntry {
  connectorId: NativeConnectorId;
  version: string;
  at: string;
}

interface QQMusicProfileResolution {
  connectorVersion: string;
  directory: string | null;
  failed: boolean;
  error: unknown;
  expiresAt: number;
}

type BeforeConnectorReplace = () => Promise<void>;

/**
 * Stops an automatic install before anything is replaced. It passes through
 * the installer unchanged and becomes a deferred result, never a failure.
 */
class ConnectorUpdateDeferral extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConnectorUpdateDeferral';
  }
}

interface QQMusicProfileCatalogEntry {
  id: 'qqmusic';
  version: string;
  schemaVersion: number;
  minimumConnectorVersion: string;
  asset: string;
  size: number;
  sha256: string;
  signature: string;
  downloadUrl: string;
  awooPackage?: ConnectorPackageEntry;
}

interface QQMusicProfileCatalog {
  schemaVersion: number;
  publicKeyId: string;
  profiles: {
    qqmusic: QQMusicProfileCatalogEntry | null;
    qqmusicV2?: QQMusicProfileCatalogEntry | null;
  };
}

interface ActiveQQMusicProfiles {
  version: string;
  schemaVersion?: number;
  minimumConnectorVersion?: string;
  directory: string;
  activatedAt: string;
}

const CONNECTOR_IDS: NativeConnectorId[] = [
  'netease',
  'kugou',
  'qqmusic',
  'folia'
];
const CONNECTOR_NAMES: Record<NativeConnectorId, string> = {
  netease: '网易云音乐',
  kugou: '酷狗音乐',
  qqmusic: 'QQ 音乐',
  folia: 'Folia'
};
const QQMUSIC_PROFILE_CATALOG_URL =
  'https://app.enkianss.us/connectors/v1/profiles/qqmusic/catalog.json';
const CATALOG_TTL_MS = 5 * 60 * 1000;
const CATALOG_TIMEOUT_MS = 10 * 1000;
/** The settings page polls; unforced checks repeat a failure this long. */
const CATALOG_FAILURE_TTL_MS = 45 * 1000;
/** Validation and launch of one connector start share one profile check. */
const QQMUSIC_PROFILE_MEMO_TTL_MS = 30 * 60 * 1000;
const QQMUSIC_PROFILE_FAILURE_TTL_MS = 45 * 1000;
const CONNECTOR_HEALTH_CHECK_TIMEOUT_MS = 6000;
/** A cold start or an antivirus scan can exceed the normal limit once. */
const CONNECTOR_HEALTH_CHECK_RETRY_TIMEOUT_MS = 15000;
const CONNECTOR_EXIT_WAIT_MS = 2000;
const FIRST_INSTALL_FAILURE_TTL_MS = 60 * 1000;
const UPDATE_LOCK_POLL_MS = 500;
const UPDATE_LOCK_WAIT_MS = 60 * 1000;
const INSTALL_DEBRIS_PREFIXES = ['.download-', '.staging-', '.backup-'];
const INSTALL_DEBRIS_MAX_AGE_MS = 60 * 60 * 1000;

// Process-wide installer state. The policies are created on first use so that
// loading this module runs no imported code; tests load it with stub imports.
let reinstallCircuitBreaker: ReinstallCircuitBreaker | null = null;
let firstInstallFailures: FailureMemo | null = null;
/** One debris sweep per connector root; installs wait for their root. */
const installDebrisSweeps = new Map<string, Promise<void>>();

function getReinstallCircuitBreaker(): ReinstallCircuitBreaker {
  if (!reinstallCircuitBreaker) {
    reinstallCircuitBreaker = createReinstallCircuitBreaker();
  }
  return reinstallCircuitBreaker;
}

function getFirstInstallFailures(): FailureMemo {
  if (!firstInstallFailures) {
    firstInstallFailures = createFailureMemo(FIRST_INSTALL_FAILURE_TTL_MS);
  }
  return firstInstallFailures;
}

export class ConnectorUpdater {
  private readonly onLog: (message: string) => void;
  /** The last catalog that was fetched and passed the v2 gate. */
  private catalog: ConnectorCatalog | null = null;
  private catalogFetchedAt = 0;
  /** Concurrent checks share the request that is already running. */
  private catalogRequest: Promise<ConnectorCatalog> | null = null;
  private catalogFailure: { error: Error; expiresAt: number } | null = null;
  private readonly updates = new Map<
    NativeConnectorId,
    Promise<ConnectorUpdateResult>
  >();
  /** The current step of each running install. */
  private readonly progress = new Map<
    NativeConnectorId,
    ConnectorUpdateProgress
  >();
  /** Rolled-back versions, loaded from quarantine.json on first use. */
  private readonly quarantine = new Map<
    NativeConnectorId,
    ConnectorQuarantineEntry[]
  >();
  private readonly validatedExecutables = new Set<string>();
  private qqMusicProfileUpdate: Promise<string | null> | null = null;
  /** The last profile resolution, shared by the checks of one start. */
  private qqMusicProfileMemo: QQMusicProfileResolution | null = null;
  private privateDotnetRuntime: PrivateDotnetRuntimeManager | null = null;
  private readonly neteaseProcessController: NeteaseUpdateProcessController;

  constructor(
    onLog: (message: string) => void,
    neteaseProcessController?: NeteaseUpdateProcessController
  ) {
    this.onLog = onLog;
    this.neteaseProcessController = neteaseProcessController
      || new NeteaseUpdateProcessController({ onLog });
  }

  async resolve(connectorId: NativeConnectorId): Promise<string | null> {
    return (await this.readActive(connectorId))?.executable || null;
  }

  async isInstalled(connectorId: NativeConnectorId): Promise<boolean> {
    return Boolean(await this.readActive(connectorId));
  }

  async getLaunchEnvironment(
    connectorId: NativeConnectorId
  ): Promise<Record<string, string>> {
    const active = await this.readActive(connectorId);
    const environment = active?.deployment === 'framework-dependent'
      && active.runtimeRid
      && active.runtimeRoot
      ? buildPrivateDotnetEnvironment(active.runtimeRid, active.runtimeRoot)
      : {};
    if (connectorId !== 'qqmusic') return environment;
    if (!shouldRunAutomaticConnectorMaintenance(
      process.env['AWOO_DEV_USER_DATA_DIR']?.trim() || null
    )) return { ...environment, BILINCM_QQMUSIC_PROFILE_DIR: '' };
    try {
      const directory = await this.ensureQQMusicProfiles();
      return directory
        ? { ...environment, BILINCM_QQMUSIC_PROFILE_DIR: directory }
        : environment;
    } catch (error: unknown) {
      this.onLog(
        `[QQ 画像] 在线画像更新失败，继续使用连接器内置画像：`
        + getErrorMessage(error)
      );
      return environment;
    }
  }

  private getPrivateDotnetRuntime(): PrivateDotnetRuntimeManager {
    if (!this.privateDotnetRuntime) {
      this.privateDotnetRuntime = new PrivateDotnetRuntimeManager({
        rootDirectory: this.getPrivateDotnetRuntimeRoot(),
        fetchImpl: (input, init) => net.fetch(input, init),
        onLog: message => this.onLog(message)
      });
    }
    return this.privateDotnetRuntime;
  }

  private getPrivateDotnetRuntimeRoot(): string {
    return path.join(app.getPath('userData'), 'dotnet-runtimes');
  }

  async ensureInstalled(
    connectorId: NativeConnectorId
  ): Promise<string> {
    const allowAutomaticMaintenance = shouldRunAutomaticConnectorMaintenance(
      process.env['AWOO_DEV_USER_DATA_DIR']?.trim() || null
    );
    const active = await this.readActive(connectorId);
    if (active) {
      const installed = active.executable;
      const resolved = path.resolve(installed);
      if (!this.validatedExecutables.has(resolved)) {
        const launchEnvironment = await this.getLaunchEnvironment(connectorId);
        try {
          await validateConnectorExecutable(
            installed,
            connectorId,
            active.version,
            launchEnvironment
          );
          this.validatedExecutables.add(resolved);
        } catch (error: unknown) {
          if (!allowAutomaticMaintenance) {
            throw new Error(
              `[隔离开发] ${CONNECTOR_NAMES[connectorId]}连接器健康检查失败，`
              + `已禁止自动重装；请手动修复本地连接器：${getErrorMessage(error)}`
            );
          }
          return this.recoverUnhealthyConnector(
            connectorId,
            active,
            launchEnvironment,
            error
          );
        }
      }
      return installed;
    }

    if (!allowAutomaticMaintenance) {
      throw new Error(
        `[隔离开发] 缺少可用的 ${CONNECTOR_NAMES[connectorId]}本地连接器，`
        + '已禁止自动下载安装；请显式安装或配置本地连接器后重试。'
      );
    }
    return this.installMissingConnector(connectorId);
  }

  /**
   * A failed health check is not proof of a broken install. Retry once with
   * a longer limit, launch the existing connector when a reinstall would be
   * refused anyway, and cap automatic reinstalls so a blocked executable
   * cannot turn connection retries into a download loop.
   */
  private async recoverUnhealthyConnector(
    connectorId: NativeConnectorId,
    active: ActiveConnector,
    launchEnvironment: Record<string, string>,
    firstError: unknown
  ): Promise<string> {
    const name = CONNECTOR_NAMES[connectorId];
    let healthError: unknown;
    try {
      await validateConnectorExecutable(
        active.executable,
        connectorId,
        active.version,
        launchEnvironment,
        CONNECTOR_HEALTH_CHECK_RETRY_TIMEOUT_MS
      );
      this.validatedExecutables.add(path.resolve(active.executable));
      this.onLog(
        `[连接器] ${name}连接器首次健康检查未通过，重试后已通过：`
        + getErrorMessage(firstError)
      );
      return active.executable;
    } catch (error: unknown) {
      healthError = error;
    }

    let blocker: string | null;
    try {
      const [status] = await this.getStatuses(false, connectorId);
      // A reinstall installs the catalog's latest version, so it needs a
      // fresh catalog and must not bring back a rolled-back version.
      blocker = status?.stale
        ? status.staleMessage || '更新检查失败'
        : status?.quarantined
          ? `最新版本 ${status.latestVersion} 已回退并暂停自动安装`
          : describeAutomaticReinstallBlocker(status);
    } catch (error: unknown) {
      blocker = `更新检查失败：${getErrorMessage(error)}`;
    }
    if (blocker) {
      // The bridge still spawns and pings the connector, which is the real
      // health check; a reinstall would be refused here anyway.
      this.onLog(
        `[连接器] ${name}健康检查未通过，但当前无法安全重装（${blocker}），`
        + `将直接尝试启动现有连接器：${getErrorMessage(healthError)}`
      );
      return active.executable;
    }

    const breaker = getReinstallCircuitBreaker();
    const breakerKey = `${connectorId}@${active.version}`;
    const now = Date.now();
    if (!breaker.allow(breakerKey, now)) {
      this.onLog(
        `[连接器] ${name}现有连接器健康检查失败，自动重装次数已达上限：`
        + getErrorMessage(healthError)
      );
      throw new Error(
        `${name}连接器可能被安全软件拦截或已损坏，已暂停自动重装；`
        + '请检查安全软件后在播放器设置中手动“重新安装”'
      );
    }
    breaker.record(breakerKey, now);
    this.onLog(
      `[连接器] ${name}现有连接器健康检查失败，`
      + `正在自动重新安装：${getErrorMessage(healthError)}`
    );
    const repaired = await this.runUpdateWhenAvailable(connectorId, true, false);
    if (!repaired.success) {
      throw new Error(repaired.message);
    }
    const repairedExecutable = await this.resolve(connectorId);
    if (!repairedExecutable) {
      throw new Error(`${name}连接器修复后未找到可执行文件`);
    }
    this.validatedExecutables.add(path.resolve(repairedExecutable));
    return repairedExecutable;
  }

  private async installMissingConnector(
    connectorId: NativeConnectorId
  ): Promise<string> {
    const name = CONNECTOR_NAMES[connectorId];
    const failures = getFirstInstallFailures();
    // The connection poll retries within a second. Repeat a recent failure
    // instead of fetching the catalog and downloading again on every tick.
    const recentFailure = failures.get(connectorId, Date.now());
    if (recentFailure) throw recentFailure;

    this.onLog(`[连接器] 首次使用 ${name}，正在自动下载安装独立连接器`);
    try {
      const result = await this.runUpdateWhenAvailable(
        connectorId,
        false,
        false
      );
      if (!result.success) {
        throw new Error(result.message);
      }
      const executable = await this.resolve(connectorId);
      if (!executable) {
        throw new Error(`${name}连接器安装后未找到可执行文件`);
      }
      failures.clear(connectorId);
      this.validatedExecutables.add(path.resolve(executable));
      return executable;
    } catch (error: unknown) {
      failures.set(
        connectorId,
        error instanceof Error ? error : new Error(getErrorMessage(error)),
        Date.now()
      );
      throw error;
    }
  }

  async getStatuses(
    forceRefresh = false,
    connectorId?: NativeConnectorId
  ): Promise<ConnectorUpdateStatus[]> {
    const checkedAt = new Date().toISOString();
    const connectorIds = connectorId ? [connectorId] : CONNECTOR_IDS;
    void this.sweepInstallDebris(connectorIds);
    const [activeConnectors] = await Promise.all([
      Promise.all(connectorIds.map(id => this.readActive(id))),
      Promise.all(connectorIds.map(id => this.loadQuarantine(id)))
    ]);

    let catalog: ConnectorCatalog;
    let staleMessage: string | null = null;
    try {
      catalog = await this.fetchCatalog(forceRefresh);
    } catch (error: unknown) {
      const message = getErrorMessage(error);
      // Only a status display falls back to the last good catalog. Forced
      // checks precede installs, which must never act on stale data.
      const lastGood = forceRefresh ? null : this.catalog;
      if (!lastGood) {
        return connectorIds.map((id, index) =>
          this.makeStatus(
            id,
            activeConnectors[index],
            null,
            checkedAt,
            message
          )
        );
      }
      catalog = lastGood;
      staleMessage = describeStaleCatalog(
        message,
        this.catalogFetchedAt,
        Date.now()
      );
    }

    return connectorIds.map((id, index) => {
      const entry = catalog.connectors[id] || null;
      let status: ConnectorUpdateStatus;
      try {
        if (!entry) {
          throw new Error(`更新清单缺少 ${id} 连接器`);
        }
        if (catalog.schemaVersion === 2) {
          this.validateV2Entry(id, entry);
        } else {
          // Keep the v1 validator for repair tooling and old cached data, but
          // do not fetch v1 as a fallback from the 1.1.10 updater.
          this.validateEntry(id, entry as LegacyConnectorCatalogEntry);
        }
        status = this.makeStatus(
          id,
          activeConnectors[index],
          entry,
          checkedAt,
          null
        );
      } catch (error: unknown) {
        status = this.makeStatus(
          id,
          activeConnectors[index],
          null,
          checkedAt,
          getErrorMessage(error)
        );
      }
      return staleMessage === null
        ? status
        : { ...status, stale: true, staleMessage };
    });
  }

  async update(
    connectorId: NativeConnectorId,
    allowPlayerVersionChange = false,
    options: ConnectorUpdateOptions = {}
  ): Promise<ConnectorUpdateResult> {
    // Confirming a player-branch change is an explicit user decision, which
    // also overrides an earlier rollback of this connector.
    return this.runUpdate(
      connectorId,
      false,
      allowPlayerVersionChange,
      allowPlayerVersionChange,
      options.automatic === true
    );
  }

  async reinstall(
    connectorId: NativeConnectorId
  ): Promise<ConnectorUpdateResult> {
    return this.runUpdate(connectorId, true, false, true);
  }

  /**
   * Reverts to the version the last activation replaced and pauses automatic
   * installs of the reverted version. The caller stops the running connector
   * first. Installs never delete a version directory, so the previous files
   * are normally still on disk; they are re-checked before activation.
   */
  async rollbackToPrevious(
    connectorId: NativeConnectorId
  ): Promise<ConnectorRollbackResult> {
    const name = CONNECTOR_NAMES[connectorId];
    const releaseUpdateLock = updateInstallationGuard.acquire(connectorId);
    if (!releaseUpdateLock) {
      return { success: false, message: '另一项更新正在进行，请完成后重试' };
    }
    try {
      const active = await this.readActive(connectorId);
      if (!active) {
        return { success: false, message: `${name}连接器未安装，无法回退` };
      }
      const recorded = active.previous;
      if (!recorded || recorded.version === active.version) {
        return {
          success: false,
          message: `${name}连接器没有可回退的上一版本`
        };
      }
      const target = await this.prepareRollbackTarget(connectorId, recorded);
      await this.writeActive(connectorId, {
        id: connectorId,
        version: target.version,
        executable: target.executable,
        deployment: target.deployment,
        runtimeRid: target.runtimeRid,
        runtimeRoot: target.runtimeRoot,
        activatedAt: new Date().toISOString()
      });
      this.validatedExecutables.add(path.resolve(target.executable));
      try {
        await this.addQuarantine(connectorId, active.version);
      } catch (error: unknown) {
        this.onLog(
          `[连接器] ${name}连接器 ${active.version} 的暂停记录保存失败，`
          + `本次运行期间仍不会自动安装该版本：${getErrorMessage(error)}`
        );
      }
      this.onLog(
        `[连接器] ${name}连接器已从 ${active.version} 回退到 `
        + `${target.version}，已暂停 ${active.version} 的自动更新`
      );
      return {
        success: true,
        version: target.version,
        message: `${name}连接器已回退到 ${target.version}`
      };
    } catch (error: unknown) {
      const message = getErrorMessage(error);
      this.onLog(`[连接器] ${name}连接器回退失败：${message}`);
      return { success: false, message: `${name}连接器回退失败：${message}` };
    } finally {
      releaseUpdateLock();
    }
  }

  /**
   * Whether a rollback paused automatic installs of `version`. Reflects
   * quarantine.json once getStatuses() has read this connector.
   */
  isQuarantined(
    connectorId: NativeConnectorId,
    version: string | null | undefined
  ): boolean {
    return Boolean(version)
      && (this.quarantine.get(connectorId) || [])
        .some(entry => entry.version === version);
  }

  /**
   * Checks the QQ Music profile catalog now, bypassing the result remembered
   * for launches. `changed` is true when a verified profile directory other
   * than the one last handed to a launch is now active, so restarting the
   * connector applies it. A failed check is logged and reports no change;
   * it never rejects for a network problem.
   */
  async refreshQQMusicProfiles(): Promise<QQMusicProfileRefreshResult> {
    if (!shouldRunAutomaticConnectorMaintenance(
      process.env['AWOO_DEV_USER_DATA_DIR']?.trim() || null
    )) return { changed: false, version: null };
    const previous = this.qqMusicProfileMemo?.directory ?? null;
    let directory: string | null = null;
    try {
      directory = await this.ensureQQMusicProfiles(true);
    } catch (error: unknown) {
      this.onLog(
        '[QQ 画像] 刷新在线画像失败，继续使用连接器内置画像：'
        + getErrorMessage(error)
      );
    }
    return {
      changed: directory !== null
        && (!previous || path.resolve(previous) !== path.resolve(directory)),
      version: directory ? path.basename(directory) : null
    };
  }

  /**
   * Installs on the connection path wait briefly while another connector
   * holds the shared update lock, instead of failing the connection. A core
   * update keeps the lock until the app restarts, so it still fails fast,
   * as do the user-facing update() and reinstall().
   */
  private async runUpdateWhenAvailable(
    connectorId: NativeConnectorId,
    forceReinstall: boolean,
    allowPlayerVersionChange: boolean
  ): Promise<ConnectorUpdateResult> {
    const deadline = Date.now() + UPDATE_LOCK_WAIT_MS;
    let waitLogged = false;
    for (;;) {
      const holder = updateInstallationGuard.componentId;
      // runUpdate() joins an install of this same connector that is already
      // running, so only another connector's lock is worth waiting for.
      if (
        !holder
        || holder === 'core'
        || holder === connectorId
        || Date.now() >= deadline
      ) break;
      if (!waitLogged) {
        waitLogged = true;
        this.onLog(
          `[连接器] ${CONNECTOR_NAMES[holder]}连接器正在更新，`
          + `完成后继续处理${CONNECTOR_NAMES[connectorId]}连接器`
        );
      }
      await delay(UPDATE_LOCK_POLL_MS);
    }
    return this.runUpdate(
      connectorId,
      forceReinstall,
      allowPlayerVersionChange
    );
  }

  private async runUpdate(
    connectorId: NativeConnectorId,
    forceReinstall: boolean,
    allowPlayerVersionChange: boolean,
    explicitRequest = false,
    automatic = false
  ): Promise<ConnectorUpdateResult> {
    const existingUpdate = this.updates.get(connectorId);
    if (existingUpdate) {
      return existingUpdate.then(result => ({
        ...result,
        updated: false,
        message: result.success
          ? `${CONNECTOR_NAMES[connectorId]}连接器安装任务已完成`
          : result.message
      }));
    }

    const releaseUpdateLock = updateInstallationGuard.acquire(connectorId);
    if (!releaseUpdateLock) {
      throw new Error('另一项更新正在进行，请完成后重试');
    }
    const update = this.updateInternal(
      connectorId,
      forceReinstall,
      allowPlayerVersionChange,
      explicitRequest,
      automatic
    )
      .finally(() => {
        releaseUpdateLock();
        if (this.updates.get(connectorId) === update) {
          this.updates.delete(connectorId);
          this.progress.delete(connectorId);
        }
      });
    this.updates.set(connectorId, update);
    return update;
  }

  private async updateInternal(
    connectorId: NativeConnectorId,
    forceReinstall: boolean,
    allowPlayerVersionChange: boolean,
    explicitRequest = false,
    automatic = false
  ): Promise<ConnectorUpdateResult> {
    if (explicitRequest) {
      await this.clearQuarantine(connectorId);
    }
    const statuses = await this.getStatuses(true);
    const status = statuses.find(item => item.id === connectorId)!;
    if (status.error) {
      return {
        success: false,
        updated: false,
        message: `检查失败：${status.error}`,
        status
      };
    }
    if (!status.compatible) {
      return {
        success: false,
        updated: false,
        message:
          `连接器 ${status.latestVersion} 要求嗷呜点歌机 `
          + `${status.minimumCoreVersion} 或更高版本`,
        status
      };
    }
    if (
      status.manualUpdateAvailable
      && !allowPlayerVersionChange
    ) {
      return {
        success: false,
        updated: false,
        message:
          `${status.name}连接器 ${status.latestVersion} 属于新的播放器版本分支，`
          + `支持的播放器版本：${status.supportedPlayerVersion || '未注明'}。`
          + '请在播放器设置中手动确认更新。',
        status
      };
    }
    if (
      status.installed
      && !status.updateAvailable
      && !forceReinstall
    ) {
      return {
        success: true,
        updated: false,
        message: `${status.name}连接器已经是最新版本 ${status.currentVersion}`,
        status
      };
    }
    // Only the user brings back a version that was rolled back here; an
    // explicit update or reinstall has already lifted the pause.
    if (
      status.quarantined
      && status.installed
      && !forceReinstall
      && !allowPlayerVersionChange
    ) {
      return {
        success: false,
        updated: false,
        message:
          `${status.name}连接器 ${status.latestVersion} 已在本机回退并暂停自动更新；`
          + '如需安装，请在播放器设置中手动更新。',
        status
      };
    }

    const entry = this.catalog?.connectors[connectorId];
    if (!entry) {
      return {
        success: false,
        updated: false,
        message: '更新清单中没有找到连接器',
        status
      };
    }

    const neteaseMaintenance: {
      prepared: boolean;
      session: NeteaseUpdateProcessSession | null;
    } = {
      prepared: false,
      session: null
    };
    // NetEase only has to close when it may hold the bridge DLL of an earlier
    // connector. A first install brings no bridge NetEase could have loaded,
    // and every version installs into its own directory. Files on disk
    // decide, not readActive(): a version whose active.json no longer
    // resolves may still be loaded in NetEase.
    const replacesActiveNeteaseConnector = connectorId === 'netease'
      && await this.hasInstalledConnectorFiles(connectorId);
    const beforeReplace: BeforeConnectorReplace | undefined =
      replacesActiveNeteaseConnector
        ? async () => {
            if (neteaseMaintenance.prepared) return;
            if (automatic) {
              // Planning saw NetEase closed, but the streamer may have opened
              // it during the download. An automatic update never closes it;
              // it stops here, before anything is replaced or activated.
              if (await this.isNeteasePlayerRunning()) {
                throw new ConnectorUpdateDeferral(
                  '网易云正在运行，连接器更新将在网易云关闭后自动应用'
                );
              }
              neteaseMaintenance.prepared = true;
              neteaseMaintenance.session = {
                wasRunning: false,
                executablePath: null,
                processIds: []
              };
              return;
            }
            neteaseMaintenance.prepared = true;
            try {
              neteaseMaintenance.session = await this.neteaseProcessController
                .stopForConnectorUpdate();
            } catch (error: unknown) {
              neteaseMaintenance.prepared = false;
              throw error;
            }
          }
        : undefined;

    let result: ConnectorUpdateResult;
    try {
      await this.install(
        connectorId,
        entry,
        forceReinstall,
        beforeReplace
      );
      const activeAfterInstall = await this.readActive(connectorId);
      const refreshedStatus = this.makeStatus(
        connectorId,
        activeAfterInstall,
        entry,
        new Date().toISOString(),
        null
      );
      // install() health-checked these exact files before activating them,
      // so the reconnect that follows an update need not spawn them again.
      if (
        activeAfterInstall?.executable
        && activeAfterInstall.version === entry.version
      ) {
        this.validatedExecutables.add(
          path.resolve(activeAfterInstall.executable)
        );
      }
      // install() has completed hash/signature verification, the executable
      // health check and active.json activation before this notification.
      if (refreshedStatus.currentVersion === entry.version) {
        try {
          await reportCompletedConnectorUpdate(
            connectorId,
            `${refreshedStatus.name}连接器`,
            status.currentVersion,
            entry.version
          );
        } catch (error: unknown) {
          // Notification persistence must not turn a completed installation
          // into a failed installation or provoke another reinstall.
          this.onLog(`[连接器更新] 更新完成通知保存失败：${getErrorMessage(error)}`);
        }
      }
      this.onLog(
        `[连接器更新] 已${forceReinstall ? '重新安装' : '安装'} `
        + `${connectorId} ${entry.version}`
      );
      result = {
        success: true,
        updated: true,
        message: forceReinstall
          ? `${refreshedStatus.name}连接器 ${entry.version} 已重新安装`
          : `${refreshedStatus.name}连接器已更新到 ${entry.version}`,
        status: refreshedStatus
      };
    } catch (error: unknown) {
      if (error instanceof ConnectorUpdateDeferral) {
        // Not a failure: the install stopped before replacing anything and
        // its download was cleaned up, so the status carries no error.
        this.onLog(
          `[连接器更新] ${connectorId} ${entry.version} 暂缓安装：${error.message}`
        );
        result = {
          success: false,
          updated: false,
          deferred: true,
          message: error.message,
          status
        };
      } else {
        const message = getErrorMessage(error);
        this.onLog(
          `[连接器更新] ${connectorId} 安装失败：${message}`
        );
        result = {
          success: false,
          updated: false,
          message: `安装失败：${message}`,
          status: {
            ...status,
            error: message
          }
        };
      }
    }

    if (neteaseMaintenance.prepared && neteaseMaintenance.session) {
      result = {
        ...result,
        neteasePlayerWasRunning: neteaseMaintenance.session.wasRunning
      };
    }

    if (neteaseMaintenance.session?.wasRunning) {
      this.reportProgress(connectorId, 'restart');
      try {
        await this.neteaseProcessController
          .restartAfterConnectorUpdate(neteaseMaintenance.session);
        result = {
          ...result,
          message: `${result.message}；已自动重新启动网易云音乐`,
          neteasePlayerRestarted: true,
          neteasePlayerRestartError: null
        };
      } catch (error: unknown) {
        const message = getErrorMessage(error);
        this.onLog(`[网易云连接器更新] 自动重启失败：${message}`);
        result = {
          ...result,
          message: `${result.message}；网易云自动重启失败，请手动打开：${message}`,
          neteasePlayerRestarted: false,
          neteasePlayerRestartError: message
        };
      }
    }
    return result;
  }

  private makeStatus(
    connectorId: NativeConnectorId,
    active: ActiveConnector | null,
    entry: ConnectorCatalogEntry | null,
    checkedAt: string,
    error: string | null
  ): ConnectorUpdateStatus {
    const compatible = Boolean(
      entry
      && compareVersions(
        app.getVersion(),
        entry.minimumCoreVersion
      ) >= 0
    );
    const updateKind = classifyConnectorUpdate(
      active?.version || null,
      entry?.version || null,
      connectorId
    );
    const updateAvailable = Boolean(
      entry
      && compatible
      && updateKind !== 'none'
    );
    // A rolled-back version stays available, but only as a manual update.
    const quarantined = Boolean(
      entry && this.isQuarantined(connectorId, entry.version)
    );
    const updating = this.updates.has(connectorId);
    return {
      id: connectorId,
      name: CONNECTOR_NAMES[connectorId],
      installed: Boolean(active),
      currentVersion: active?.version || null,
      latestVersion: entry?.version || null,
      minimumCoreVersion: entry?.minimumCoreVersion || null,
      compatible,
      updateAvailable,
      autoUpdateAvailable: updateAvailable
        && !quarantined
        && canAutoUpdateConnector(
          active?.version || null,
          entry?.version || null,
          connectorId
        ),
      manualUpdateAvailable: updateAvailable
        && requiresManualConnectorUpdate(
          active?.version || null,
          entry?.version || null,
          connectorId
        ),
      updateKind,
      supportedPlayerVersion:
        entry?.testedPlayerVersion
        || entry?.playerVersionPolicy
        || null,
      playerVersionPolicy: entry?.playerVersionPolicy || null,
      testedPlayerVersion: entry?.testedPlayerVersion || null,
      updating,
      progress: updating ? this.progress.get(connectorId) || null : null,
      quarantined,
      checkedAt,
      error
    };
  }

  private reportProgress(
    connectorId: NativeConnectorId,
    phase: ConnectorUpdatePhase,
    percent: number | null = null
  ): void {
    this.progress.set(connectorId, {
      phase,
      percent,
      updatedAt: new Date().toISOString()
    });
  }

  private async fetchCatalog(
    forceRefresh = false
  ): Promise<ConnectorCatalog> {
    const now = Date.now();
    if (
      !forceRefresh
      && this.catalog
      && now - this.catalogFetchedAt < CATALOG_TTL_MS
    ) {
      return this.catalog;
    }
    if (this.catalogRequest) return this.catalogRequest;
    // A polling status display repeats a recent failure instead of waiting
    // for the network again; forced checks always make a new request.
    if (
      !forceRefresh
      && this.catalogFailure
      && now < this.catalogFailure.expiresAt
    ) {
      throw this.catalogFailure.error;
    }

    const request = this.requestCatalog().then(
      catalog => {
        this.catalog = catalog;
        this.catalogFetchedAt = Date.now();
        this.catalogFailure = null;
        return catalog;
      },
      (error: unknown) => {
        const failure = new Error(describeNetworkError(error));
        this.catalogFailure = {
          error: failure,
          expiresAt: Date.now() + CATALOG_FAILURE_TTL_MS
        };
        throw failure;
      }
    );
    this.catalogRequest = request;
    const settle = () => {
      if (this.catalogRequest === request) this.catalogRequest = null;
    };
    request.then(settle, settle);
    return request;
  }

  private async requestCatalog(): Promise<ConnectorCatalog> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CATALOG_TIMEOUT_MS);
    try {
      // Chromium's network stack applies the system proxy and PAC script,
      // like the package downloads; it also honours `cache: 'no-store'`.
      const response = await net.fetch(CATALOG_URL, {
        method: 'GET',
        cache: 'no-store',
        signal: controller.signal,
        headers: {
          Accept: 'application/json'
        }
      });
      if (!response.ok) {
        throw new Error(`清单 HTTP ${response.status}`);
      }

      let catalog: unknown;
      try {
        catalog = await response.json();
      } catch (error: unknown) {
        if (controller.signal.aborted) throw error;
        // Typically a captive portal or proxy page answered instead.
        throw new Error('更新清单内容无法解析，可能被代理或网络登录页拦截');
      }
      assertV2Catalog(catalog);
      // Entries are validated one by one when statuses are built.
      return catalog as unknown as ConnectorCatalog;
    } finally {
      clearTimeout(timeout);
    }
  }

  private validateEntry(
    connectorId: NativeConnectorId,
    entry: LegacyConnectorCatalogEntry
  ): void {
    if (
      entry.id !== connectorId
      || entry.protocolVersion !== CONNECTOR_PROTOCOL_VERSION
      || !CONNECTOR_VERSION_PATTERN.test(entry.version)
      || !/^\d+\.\d+\.\d+$/.test(entry.minimumCoreVersion)
      || !(
        entry.testedPlayerVersion?.trim()
        || entry.playerVersionPolicy?.trim()
      )
      || !Number.isSafeInteger(entry.size)
      || entry.size <= 0
      || !/^[a-f0-9]{64}$/i.test(entry.sha256)
      || !entry.signature
      || !entry.downloadUrl.startsWith(
        'https://app.enkianss.us/connectors/v1/download/'
      )
      || path.basename(entry.asset) !== entry.asset
      || !['win-x86', 'win-x64'].includes(
        entry.runtime || 'win-x86'
      )
      || !isRecognizedConnectorAssetName(
        entry.asset,
        connectorId,
        entry.version,
        entry.runtime || 'win-x86'
      )
      || path.basename(new URL(entry.downloadUrl).pathname) !== entry.asset
    ) {
      throw new Error(`${connectorId} 连接器清单字段无效`);
    }

    const framework = entry.frameworkDependent;
    const runtimeRid = entry.runtime || 'win-x86';
    if (framework && (
      framework.runtime !== runtimeRid
      || framework.runtimeChannel !== '8.0'
      || !Number.isSafeInteger(framework.size)
      || framework.size <= 0
      || !/^[a-f0-9]{64}$/i.test(framework.sha256)
      || !framework.signature
      || !framework.downloadUrl.startsWith(
        'https://app.enkianss.us/connectors/v1/download/'
      )
      || path.basename(framework.asset) !== framework.asset
      || !isRecognizedConnectorAssetName(
        framework.asset,
        connectorId,
        entry.version,
        runtimeRid,
        true
      )
      || path.basename(new URL(framework.downloadUrl).pathname) !== framework.asset
    )) {
      throw new Error(
        `${connectorId} framework-dependent 连接器清单字段无效`
      );
    }

    const awooPackage = entry.awooPackage;
    if (awooPackage && (
      !Number.isSafeInteger(awooPackage.size)
      || awooPackage.size <= 0
      || !/^[a-f0-9]{64}$/i.test(awooPackage.sha256)
      || !awooPackage.signature
      || !awooPackage.downloadUrl.startsWith(
        'https://app.enkianss.us/connectors/v1/download/'
      )
      || path.basename(awooPackage.asset) !== awooPackage.asset
      || awooPackage.asset !== connectorAssetNames(
        connectorId,
        entry.version,
        runtimeRid
      )[0]
      || path.basename(new URL(awooPackage.downloadUrl).pathname)
        !== awooPackage.asset
    )) {
      throw new Error(`${connectorId} Awoo 完整连接器清单字段无效`);
    }

    const awooFramework = entry.awooFrameworkDependent;
    if (awooFramework && (
      awooFramework.runtime !== runtimeRid
      || awooFramework.runtimeChannel !== '8.0'
      || !Number.isSafeInteger(awooFramework.size)
      || awooFramework.size <= 0
      || !/^[a-f0-9]{64}$/i.test(awooFramework.sha256)
      || !awooFramework.signature
      || !awooFramework.downloadUrl.startsWith(
        'https://app.enkianss.us/connectors/v1/download/'
      )
      || path.basename(awooFramework.asset) !== awooFramework.asset
      || awooFramework.asset !== connectorAssetNames(
        connectorId,
        entry.version,
        runtimeRid,
        true
      )[0]
      || path.basename(new URL(awooFramework.downloadUrl).pathname)
        !== awooFramework.asset
    )) {
      throw new Error(
        `${connectorId} Awoo framework-dependent 连接器清单字段无效`
      );
    }
  }

  private validateV2Entry(
    connectorId: NativeConnectorId,
    entry: ConnectorCatalogEntry
  ): asserts entry is SmallOnlyConnectorCatalogEntry {
    validateV2ConnectorEntry(connectorId, entry);
  }

  private async install(
    connectorId: NativeConnectorId,
    entry: ConnectorCatalogEntry,
    forceReinstall = false,
    beforeReplace?: BeforeConnectorReplace
  ): Promise<string> {
    const framework = selectFrameworkDependentConnectorPackage(entry);
    const v2Package = 'package' in entry
      ? entry.package
      : undefined;
    if (!framework || !v2Package || framework !== v2Package) {
      throw new Error(
        `${CONNECTOR_NAMES[connectorId]}更新清单缺少 Framework-dependent 小包，`
        + '已拒绝下载 SelfContained 完整包；v2 清单只接受 package '
        + 'framework-dependent 包'
      );
    }

    try {
      // The runtime manager reports no progress of its own; an already
      // installed runtime passes this step at once.
      this.reportProgress(connectorId, 'runtime');
      const runtimeRoot = await this.getPrivateDotnetRuntime().ensure(
        framework.runtime,
        framework.runtimeChannel
      );
      const activation: ConnectorPackageActivation = {
        deployment: 'framework-dependent',
        runtimeRid: framework.runtime,
        runtimeRoot
      };
      try {
        return await this.installPackage(
          connectorId,
          entry,
          framework,
          activation,
          forceReinstall,
          beforeReplace
        );
      } catch (proxyError: unknown) {
        // Only a failed or corrupted download is worth repeating from GitHub.
        // Health-check, extraction, file system and activation errors would
        // recur with the identical signed package, so they surface at once.
        if (!isConnectorDownloadError(proxyError)) {
          throw proxyError;
        }
        const directPackage: ConnectorPackageEntry = {
          ...framework,
          downloadUrl: buildConnectorGitHubReleaseUrl(
            connectorId,
            entry.version,
            framework.asset
          )
        };
        this.onLog(
          `[连接器更新] ${connectorId} 本站小体积包下载失败，`
          + `尝试 GitHub Release 签名资产地址：${getErrorMessage(proxyError)}`
        );
        try {
          return await this.installPackage(
            connectorId,
            entry,
            directPackage,
            activation,
            forceReinstall,
            beforeReplace,
            true
          );
        } catch (directError: unknown) {
          if (
            directError instanceof ConnectorUpdateDeferral
            || directError instanceof NeteaseProcessControlError
          ) {
            throw directError;
          }
          throw new Error(
            `本站小体积包安装失败：${getErrorMessage(proxyError)}；`
            + `GitHub 签名小体积包安装失败：${getErrorMessage(directError)}`
          );
        }
      }
    } catch (error: unknown) {
      if (
        error instanceof ConnectorUpdateDeferral
        || error instanceof NeteaseProcessControlError
      ) {
        throw error;
      }
      const message = getErrorMessage(error);
      this.onLog(
        `[连接器更新] ${connectorId} 小体积包或私有 .NET Runtime 安装失败，`
        + `未回退完整包：${message}`
      );
      throw new Error(
        `${CONNECTOR_NAMES[connectorId]}连接器 Framework-dependent 更新失败，`
        + `未下载 SelfContained 完整包：${message}`
      );
    }
  }

  private async installPackage(
    connectorId: NativeConnectorId,
    entry: ConnectorCatalogEntry,
    packageEntry: ConnectorPackageEntry,
    activation: ConnectorPackageActivation,
    forceReinstall = false,
    beforeReplace?: BeforeConnectorReplace,
    wholeFileDownload = false
  ): Promise<string> {
    const connectorRoot = this.getConnectorRoot(connectorId);
    const versionDirectory = path.join(connectorRoot, entry.version);
    const preferredExecutableName =
      AWOO_CONNECTOR_EXECUTABLE_NAMES[connectorId];

    const currentActive = await this.readActive(connectorId);
    const currentDeployment = currentActive?.deployment || 'self-contained';
    const requestedDeployment = activation.deployment || 'self-contained';
    const canReuse = Boolean(
      !forceReinstall
      && currentActive?.version === entry.version
      && currentDeployment === requestedDeployment
      && (
        requestedDeployment !== 'framework-dependent'
        || (
          currentActive?.runtimeRid === activation.runtimeRid
          && currentActive?.runtimeRoot
          && activation.runtimeRoot
          && path.resolve(currentActive.runtimeRoot)
            === path.resolve(activation.runtimeRoot)
          )
      )
      && currentActive?.executable
      && await isFile(currentActive.executable)
    );
    if (canReuse && currentActive) {
      this.reportProgress(connectorId, 'install');
      await validateConnectorExecutable(
        currentActive.executable,
        connectorId,
        entry.version,
        activation.runtimeRid && activation.runtimeRoot
          ? buildPrivateDotnetEnvironment(
            activation.runtimeRid,
            activation.runtimeRoot
          )
          : {}
      );
      const previous = await selectPreviousConnector(
        currentActive,
        entry.version
      );
      await this.writeActive(connectorId, {
        id: connectorId,
        version: entry.version,
        executable: currentActive.executable,
        ...activation,
        activatedAt: new Date().toISOString(),
        ...(previous ? { previous } : {})
      });
      return currentActive.executable;
    }

    // A crash may have left debris in this root; let its one-time sweep
    // finish before new staging paths appear next to it.
    await installDebrisSweeps.get(path.resolve(connectorRoot));
    await fs.promises.mkdir(connectorRoot, { recursive: true });
    const nonce = crypto.randomBytes(8).toString('hex');
    const archivePath = path.join(
      connectorRoot,
      `.download-${entry.version}-${nonce}.zip`
    );
    const stagingDirectory = path.join(
      connectorRoot,
      `.staging-${entry.version}-${nonce}`
    );
    const backupDirectory = path.join(
      connectorRoot,
      `.backup-${entry.version}-${nonce}`
    );
    let installedNewDirectory = false;
    let movedPreviousDirectory = false;
    let preserveBackup = false;
    const shouldLogProgress = createProgressLogThrottle();

    try {
      this.reportProgress(connectorId, 'download', 0);
      const downloadOptions: Parameters<
        typeof downloadBufferWithRanges
      >[0] = {
        url: packageEntry.downloadUrl,
        expectedSize: packageEntry.size,
        fetchImpl: (input, init) => net.fetch(input, init),
        onProgress: progress => {
          this.reportProgress(connectorId, 'download', progress.percent);
          if (!shouldLogProgress(progress.percent, Date.now())) return;
          this.onLog(
            `[连接器更新] ${connectorId} 下载进度 ${progress.percent}% `
            + `(${progress.received}/${progress.total})`
          );
        },
        onRetry: retry => {
          this.onLog(
            `[连接器更新] ${connectorId} 分块 ${retry.start}-${retry.end} `
            + `下载中断，第 ${retry.attempt}/${retry.maxAttempts} 次重试：`
            + retry.error
          );
        }
      };
      const archive = wholeFileDownload
        ? await downloadWholeBufferWithRetries(downloadOptions)
        : await downloadBufferWithRanges(downloadOptions);

      // Size, SHA-256 and the Ed25519 release signature, in that order.
      this.reportProgress(connectorId, 'verify');
      verifyConnectorArchive(archive, packageEntry);

      this.reportProgress(connectorId, 'install');
      await fs.promises.writeFile(archivePath, archive, {
        flag: 'wx'
      });
      await extractZipSafely(archivePath, stagingDirectory);

      let stagedExecutableName = '';
      for (const candidate of connectorExecutableNames(connectorId)) {
        if (await isFile(path.join(stagingDirectory, candidate))) {
          stagedExecutableName = candidate;
          break;
        }
      }
      if (!stagedExecutableName) {
        throw new Error(`发布包缺少 ${preferredExecutableName}`);
      }
      const stagedExecutable = path.join(
        stagingDirectory,
        stagedExecutableName
      );
      await validateConnectorExecutable(
        stagedExecutable,
        connectorId,
        entry.version,
        activation.runtimeRid && activation.runtimeRoot
          ? buildPrivateDotnetEnvironment(
            activation.runtimeRid,
            activation.runtimeRoot
          )
          : {}
      );

      await beforeReplace?.();
      if (connectorId === 'netease') {
        await this.cleanupStaleNeteaseBackups(connectorRoot);
      }

      // The health-check child, the extractor or antivirus software can hold
      // these directories for a moment, so both renames retry Windows locks.
      if (await pathExists(versionDirectory)) {
        await renameWithRetry(versionDirectory, backupDirectory);
        movedPreviousDirectory = true;
      }
      await renameWithRetry(stagingDirectory, versionDirectory);
      installedNewDirectory = true;
      const executable = path.join(
        versionDirectory,
        stagedExecutableName
      );
      const previous = await selectPreviousConnector(
        currentActive,
        entry.version
      );
      await this.writeActive(connectorId, {
        id: connectorId,
        version: entry.version,
        executable,
        ...activation,
        activatedAt: new Date().toISOString(),
        ...(previous ? { previous } : {})
      });
      // active.json now names the new directory. Removing the old copy is
      // cleanup only: a locked backup is kept for a later sweep and never
      // rolls back the activated install.
      if (movedPreviousDirectory) {
        movedPreviousDirectory = false;
        try {
          await removeInsideWithRetry(connectorRoot, backupDirectory);
        } catch (error: unknown) {
          preserveBackup = true;
          this.onLog(
            connectorId === 'netease' && isTransientNeteaseFileLock(error)
              ? '[网易云连接器更新] 新连接器已安装；旧备份仍被短暂占用，'
                + '已保留并将在下次安装时清理'
              : `[连接器更新] ${connectorId} 新连接器已安装；旧版本备份暂时`
                + `无法删除，已保留并将在之后自动清理：${getErrorMessage(error)}`
          );
        }
      }
      return executable;
    } catch (error) {
      // Only an install that never activated reaches this point. Rollback is
      // best-effort and must not replace the original error.
      let versionDirectoryFree = true;
      if (installedNewDirectory) {
        try {
          await removeInsideWithRetry(connectorRoot, versionDirectory);
        } catch (cleanupError: unknown) {
          versionDirectoryFree = false;
          this.onLog(
            `[连接器更新] ${connectorId} 回滚时无法删除未激活的新版本目录：`
            + getErrorMessage(cleanupError)
          );
        }
      }
      if (movedPreviousDirectory && versionDirectoryFree) {
        try {
          await renameWithRetry(backupDirectory, versionDirectory);
          movedPreviousDirectory = false;
        } catch (restoreError: unknown) {
          this.onLog(
            `[连接器更新] ${connectorId} 回滚时无法恢复原版本目录：`
            + getErrorMessage(restoreError)
          );
        }
      }
      if (movedPreviousDirectory) {
        this.onLog(
          `[连接器更新] ${connectorId} 原版本目录已保留于 ${backupDirectory}`
        );
      }
      throw error;
    } finally {
      await this.removeInstallLeftover(connectorId, connectorRoot, archivePath);
      await this.removeInstallLeftover(
        connectorId,
        connectorRoot,
        stagingDirectory
      );
      if (!movedPreviousDirectory && !preserveBackup) {
        await this.removeInstallLeftover(
          connectorId,
          connectorRoot,
          backupDirectory
        );
      }
    }
  }

  /** Cleanup never replaces an install result; the next sweep retries it. */
  private async removeInstallLeftover(
    connectorId: NativeConnectorId,
    connectorRoot: string,
    target: string
  ): Promise<void> {
    try {
      await removeInsideWithRetry(connectorRoot, target);
    } catch (error: unknown) {
      this.onLog(
        `[连接器更新] ${connectorId} 临时文件 ${path.basename(target)} `
        + `清理失败，将在之后自动清理：${getErrorMessage(error)}`
      );
    }
  }

  /**
   * Remove crash leftovers once per process and connector root. Installs
   * wait for the sweep of their root, so it never races a running install.
   */
  private async sweepInstallDebris(
    connectorIds: readonly NativeConnectorId[]
  ): Promise<void> {
    try {
      for (const connectorId of connectorIds) {
        const connectorRoot = path.resolve(this.getConnectorRoot(connectorId));
        if (installDebrisSweeps.has(connectorRoot)) continue;
        installDebrisSweeps.set(
          connectorRoot,
          this.removeStaleInstallDebris(connectorId, connectorRoot)
        );
      }
      void this.getPrivateDotnetRuntime().sweepStaleDebris();
    } catch {
      // Status checks never depend on this opportunistic cleanup.
    }
  }

  private async removeStaleInstallDebris(
    connectorId: NativeConnectorId,
    connectorRoot: string
  ): Promise<void> {
    try {
      const { removed, failed } = await removeStaleEntries(connectorRoot, {
        prefixes: INSTALL_DEBRIS_PREFIXES,
        maxAgeMs: INSTALL_DEBRIS_MAX_AGE_MS
      });
      if (removed.length > 0) {
        this.onLog(
          `[连接器] 已清理 ${connectorId} 连接器 ${removed.length} 个`
          + '中断安装留下的临时文件'
        );
      }
      if (failed.length > 0) {
        this.onLog(
          `[连接器] ${connectorId} 连接器有 ${failed.length} 个过期临时文件`
          + '暂时无法删除，将在下次启动时重试'
        );
      }
    } catch (error: unknown) {
      this.onLog(
        `[连接器] 清理 ${connectorId} 连接器临时文件失败：`
        + getErrorMessage(error)
      );
    }
  }

  private async cleanupStaleNeteaseBackups(
    connectorRoot: string
  ): Promise<void> {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(connectorRoot, {
        withFileTypes: true
      });
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return;
      throw error;
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith('.backup-')) {
        continue;
      }
      const backupPath = path.join(connectorRoot, entry.name);
      try {
        await removeInsideWithRetry(connectorRoot, backupPath);
        this.onLog('[网易云连接器更新] 已清理上次保留的旧连接器备份');
      } catch (error: unknown) {
        if (!isTransientNeteaseFileLock(error)) throw error;
        this.onLog(
          '[网易云连接器更新] 上次的旧备份仍被占用，继续保留等待下次清理'
        );
      }
    }
  }

  /**
   * The same check that planned the automatic update, repeated right before
   * replacement. A failed process query counts as running, so an automatic
   * update never replaces a bridge that a NetEase it cannot see may hold.
   */
  private async isNeteasePlayerRunning(): Promise<boolean> {
    const processInfo = await inspectPlayerProcess('netease');
    return processInfo.running || !processInfo.querySucceeded;
  }

  private async ensureQQMusicProfiles(
    forceRefresh = false
  ): Promise<string | null> {
    const connectorVersion = (await this.readActive('qqmusic'))?.version || '';
    const memo = this.qqMusicProfileMemo;
    if (
      !forceRefresh
      && memo
      && memo.connectorVersion === connectorVersion
      && Date.now() < memo.expiresAt
    ) {
      if (memo.failed) throw memo.error;
      return memo.directory;
    }
    if (this.qqMusicProfileUpdate) return this.qqMusicProfileUpdate;
    const update = this.ensureQQMusicProfilesInternal().then(
      directory => {
        this.qqMusicProfileMemo = {
          connectorVersion,
          directory,
          failed: false,
          error: null,
          expiresAt: Date.now() + QQMUSIC_PROFILE_MEMO_TTL_MS
        };
        return directory;
      },
      (error: unknown) => {
        // Validation and launch of one start then wait for the network once.
        this.qqMusicProfileMemo = {
          connectorVersion,
          directory: null,
          failed: true,
          error,
          expiresAt: Date.now() + QQMUSIC_PROFILE_FAILURE_TTL_MS
        };
        throw error;
      }
    ).finally(() => {
      if (this.qqMusicProfileUpdate === update) {
        this.qqMusicProfileUpdate = null;
      }
    });
    this.qqMusicProfileUpdate = update;
    return update;
  }

  private async ensureQQMusicProfilesInternal(): Promise<string | null> {
    const active = await this.readActiveQQMusicProfiles();
    const connector = await this.readActive('qqmusic');
    const connectorVersion = connector?.version || '';
    try {
      return await this.updateQQMusicProfiles(active, connectorVersion);
    } catch (error: unknown) {
      // Whatever failed (the catalog, an entry, or downloading and verifying
      // a newer package), the profile verified earlier remains usable.
      return this.useCachedQQMusicProfiles(active, connectorVersion, error);
    }
  }

  private async useCachedQQMusicProfiles(
    active: ActiveQQMusicProfiles | null,
    connectorVersion: string,
    failure: unknown
  ): Promise<string> {
    const reason = describeNetworkError(failure);
    if (!active) throw new Error(reason);
    let cached: string | null;
    try {
      cached = await this.validateCachedQQMusicProfiles(active, connectorVersion);
    } catch (cacheError: unknown) {
      throw new Error(
        `${reason}；缓存画像 ${active.version} 不可用：${getErrorMessage(cacheError)}`
      );
    }
    if (!cached) throw new Error(reason);
    this.onLog(`[QQ 画像] 在线画像更新失败，已校验并继续使用缓存画像 ${active.version}：${reason}`);
    return cached;
  }

  private async updateQQMusicProfiles(
    active: ActiveQQMusicProfiles | null,
    connectorVersion: string
  ): Promise<string | null> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    let catalog: QQMusicProfileCatalog | null;
    try {
      // Chromium's network stack applies the system proxy and PAC script.
      const response = await net.fetch(QQMUSIC_PROFILE_CATALOG_URL, {
        method: 'GET',
        cache: 'no-store',
        signal: controller.signal,
        headers: { Accept: 'application/json' }
      });
      if (!response.ok) throw new Error(`画像清单 HTTP ${response.status}`);
      catalog = await response.json() as QQMusicProfileCatalog | null;
    } finally {
      clearTimeout(timeout);
    }

    if (catalog?.schemaVersion !== 1 || catalog.publicKeyId !== PUBLIC_KEY_ID) {
      throw new Error('QQ 音乐画像更新清单无效');
    }
    const entry = selectQqProfileEntry(
      catalog.profiles?.qqmusic, catalog.profiles?.qqmusicV2, connectorVersion
    );
    if (!entry) return null;
    if (
      entry.id !== 'qqmusic'
      || (entry.schemaVersion !== 1 && entry.schemaVersion !== 2)
      || !/^\d+\.\d+\.\d+$/.test(entry.version)
      || !Number.isSafeInteger(entry.size)
      || entry.size <= 0
      || typeof entry.sha256 !== 'string'
      || !/^[a-f0-9]{64}$/i.test(entry.sha256)
      || !entry.signature
      || !isRecognizedQQMusicProfileAssetName(
        entry.asset,
        entry.version
      )
      || typeof entry.downloadUrl !== 'string'
      || !entry.downloadUrl.startsWith(
        'https://app.enkianss.us/connectors/v1/profiles/qqmusic/download/'
      )
      || path.basename(new URL(entry.downloadUrl).pathname) !== entry.asset
    ) {
      throw new Error('QQ 音乐画像更新清单无效');
    }

    const awooPackage = entry.awooPackage;
    if (awooPackage && (
      !Number.isSafeInteger(awooPackage.size)
      || awooPackage.size <= 0
      || typeof awooPackage.sha256 !== 'string'
      || !/^[a-f0-9]{64}$/i.test(awooPackage.sha256)
      || !awooPackage.signature
      || awooPackage.asset !== `awoo-qqmusic-profiles-${entry.version}.zip`
      || typeof awooPackage.downloadUrl !== 'string'
      || !awooPackage.downloadUrl.startsWith(
        'https://app.enkianss.us/connectors/v1/profiles/qqmusic/download/'
      )
      || path.basename(new URL(awooPackage.downloadUrl).pathname)
        !== awooPackage.asset
    )) {
      throw new Error('QQ 音乐 Awoo 画像更新清单无效');
    }

    if (active && (active.schemaVersion ?? 1) === entry.schemaVersion
        && compareVersions(active.version, entry.version) >= 0) {
      try {
        const cached = await this.validateCachedQQMusicProfiles(active, connectorVersion);
        if (cached) return cached;
      } catch (error: unknown) {
        // A damaged cache is replaced by a verified download of the entry.
        this.onLog(`[QQ 画像] 缓存画像 ${active.version} 校验失败，重新下载：${getErrorMessage(error)}`);
      }
    }

    const profileRoot = this.getQQMusicProfileRoot();
    const versionDirectory = path.join(profileRoot, entry.version);
    const packageEntry = entry.awooPackage || entry;
    const nonce = crypto.randomBytes(8).toString('hex');
    const archivePath = path.join(profileRoot, `.download-${nonce}.zip`);
    const stagingDirectory = path.join(profileRoot, `.staging-${nonce}`);
    await fs.promises.mkdir(profileRoot, { recursive: true });
    try {
      const downloadController = new AbortController();
      const downloadTimeout = setTimeout(
        () => downloadController.abort(),
        60000
      );
      let archive: Buffer;
      try {
        const response = await net.fetch(packageEntry.downloadUrl, {
          method: 'GET',
          cache: 'no-store',
          signal: downloadController.signal
        });
        if (!response.ok) throw new Error(`画像下载 HTTP ${response.status}`);
        archive = Buffer.from(await response.arrayBuffer());
      } finally {
        clearTimeout(downloadTimeout);
      }
      verifyQqProfileArchive(archive, packageEntry, RELEASE_PUBLIC_KEY);

      await fs.promises.writeFile(archivePath, archive, { flag: 'wx' });
      await extractZipSafely(archivePath, stagingDirectory, {
        maxEntries: 100,
        maxUncompressedBytes: 4 * 1024 * 1024
      });
      const profileFiles = (await fs.promises.readdir(stagingDirectory))
        .filter(file => /\.json$/i.test(file));
      if (profileFiles.length === 0) {
        throw new Error('QQ 画像包没有版本画像 JSON');
      }
      for (const file of profileFiles) {
        const document = JSON.parse(await fs.promises.readFile(
          path.join(stagingDirectory, file),
          'utf8'
        ));
        validateQqProfileDocument(document, file, entry.schemaVersion);
      }

      if (await pathExists(versionDirectory)) {
        await removeInside(profileRoot, versionDirectory);
      }
      await fs.promises.rename(stagingDirectory, versionDirectory);
      await this.writeActiveQQMusicProfiles({
        version: entry.version,
        schemaVersion: entry.schemaVersion,
        minimumConnectorVersion: entry.minimumConnectorVersion,
        directory: versionDirectory,
        activatedAt: new Date().toISOString()
      });
      this.onLog(`[QQ 画像] 已更新到 ${entry.version}`);
      return versionDirectory;
    } finally {
      // Cleanup is best-effort and must not replace the profile result.
      try {
        await fs.promises.rm(archivePath, { force: true });
        if (await pathExists(stagingDirectory)) {
          await removeInside(profileRoot, stagingDirectory);
        }
      } catch (error: unknown) {
        this.onLog(`[QQ 画像] 临时文件清理失败：${getErrorMessage(error)}`);
      }
    }
  }

  private async validateCachedQQMusicProfiles(
    active: ActiveQQMusicProfiles,
    connectorVersion: string
  ): Promise<string | null> {
    if (!canUseCachedQqProfiles(active, connectorVersion)) return null;
    const root = await fs.promises.realpath(this.getQQMusicProfileRoot());
    const directory = await fs.promises.realpath(active.directory);
    const expected = path.join(root, active.version);
    if (path.resolve(directory) !== path.resolve(expected)) {
      throw new Error('QQ 缓存画像目录越界或指向其他版本');
    }
    const entries = (await fs.promises.readdir(directory, { withFileTypes: true }))
      .filter(file => /\.json$/i.test(file.name));
    if (entries.length === 0) throw new Error('QQ 缓存画像没有版本画像 JSON');
    for (const file of entries) {
      if (!file.isFile() || file.isSymbolicLink()) throw new Error('QQ 缓存画像必须是普通 JSON 文件');
      const document = JSON.parse(await fs.promises.readFile(path.join(directory, file.name), 'utf8'));
      validateQqProfileDocument(document, file.name, active.schemaVersion ?? 1);
    }
    return active.directory;
  }

  private async readActiveQQMusicProfiles(): Promise<ActiveQQMusicProfiles | null> {
    const activePath = path.join(this.getQQMusicProfileRoot(), 'active.json');
    try {
      const active = JSON.parse(
        await fs.promises.readFile(activePath, 'utf8')
      ) as ActiveQQMusicProfiles;
      const expected = path.join(
        this.getQQMusicProfileRoot(),
        active.version
      );
      return /^\d+\.\d+\.\d+$/.test(active.version)
        && path.resolve(active.directory) === path.resolve(expected)
        && await pathExists(expected)
          ? { ...active, directory: expected }
          : null;
    } catch {
      return null;
    }
  }

  private async writeActiveQQMusicProfiles(
    active: ActiveQQMusicProfiles
  ): Promise<void> {
    const root = this.getQQMusicProfileRoot();
    await fs.promises.mkdir(root, { recursive: true });
    const activePath = path.join(root, 'active.json');
    const temporaryPath = `${activePath}.${process.pid}.tmp`;
    try {
      await fs.promises.writeFile(
        temporaryPath,
        `${JSON.stringify(active, null, 2)}\n`,
        'utf8'
      );
      // One rename replaces the previous file, so there is no moment without
      // an active.json.
      await renameWithRetry(temporaryPath, activePath);
    } catch (error) {
      await rmWithRetry(temporaryPath).catch(() => undefined);
      throw error;
    }
  }

  private getQQMusicProfileRoot(): string {
    return path.join(this.getConnectorRoot('qqmusic'), 'profiles');
  }

  private async readActive(
    connectorId: NativeConnectorId
  ): Promise<ActiveConnector | null> {
    const activePath = path.join(
      this.getConnectorRoot(connectorId),
      'active.json'
    );
    try {
      const active = JSON.parse(
        await fs.promises.readFile(activePath, 'utf8')
      ) as ActiveConnector;
      if (active.id !== connectorId) return null;
      const resolved = await this.resolveConnectorRecord(connectorId, active);
      return resolved ? { ...active, ...resolved } : null;
    } catch {
      return null;
    }
  }

  /**
   * Raw evidence of an earlier installation: an active.json or any version
   * directory, whether or not readActive() still accepts them. A version
   * whose executable, runtime or active.json is damaged no longer reads as
   * installed, yet its NetEase bridge may still be loaded.
   */
  private async hasInstalledConnectorFiles(
    connectorId: NativeConnectorId
  ): Promise<boolean> {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(this.getConnectorRoot(connectorId), {
        withFileTypes: true
      });
    } catch (error: unknown) {
      // Only a missing root proves a first install.
      return (error as NodeJS.ErrnoException)?.code !== 'ENOENT';
    }
    return entries.some(entry => entry.name === 'active.json'
      || (entry.isDirectory() && CONNECTOR_VERSION_PATTERN.test(entry.name)));
  }

  /**
   * Accepts a recorded version (active.json or its `previous` entry) only
   * when its executable lies in this connector's own version directory and
   * a framework-dependent build names a private runtime that exists.
   */
  private async resolveConnectorRecord(
    connectorId: NativeConnectorId,
    active: PreviousConnector | null | undefined
  ): Promise<ResolvedConnector | null> {
    if (
      typeof active?.version !== 'string'
      || !CONNECTOR_VERSION_PATTERN.test(active.version)
      || typeof active.executable !== 'string'
    ) {
      return null;
    }

    const versionDirectory = path.join(
      this.getConnectorRoot(connectorId),
      active.version
    );
    const activeExecutable = path.resolve(active.executable);
    const expected = connectorExecutableNames(connectorId)
      .map(name => path.join(versionDirectory, name))
      .find(candidate => path.resolve(candidate) === activeExecutable);
    if (!expected || !await isFile(expected)) {
      return null;
    }

    const deployment = active.deployment || 'self-contained';
    let runtimeRoot: string | undefined;
    let runtimeRid: DotnetRuntimeRid | undefined;
    if (deployment === 'framework-dependent') {
      if (
        typeof active.runtimeRoot !== 'string'
        || !active.runtimeRoot
        || (
          active.runtimeRid !== 'win-x86'
          && active.runtimeRid !== 'win-x64'
        )
      ) {
        return null;
      }
      runtimeRid = active.runtimeRid;
      runtimeRoot = path.resolve(active.runtimeRoot);
      const expectedRuntimeParent = path.resolve(
        this.getPrivateDotnetRuntimeRoot(),
        runtimeRid
      );
      if (
        !isPathInside(expectedRuntimeParent, runtimeRoot)
        || !await isFile(path.join(runtimeRoot, 'dotnet.exe'))
      ) {
        return null;
      }
    } else if (deployment !== 'self-contained') {
      return null;
    }
    return {
      version: active.version,
      executable: expected,
      deployment,
      runtimeRid,
      runtimeRoot
    };
  }

  /**
   * The previous version must still pass the active.json checks and answer
   * a health check before it replaces the current one.
   */
  private async prepareRollbackTarget(
    connectorId: NativeConnectorId,
    previous: PreviousConnector
  ): Promise<ResolvedConnector> {
    const target = await this.resolveConnectorRecord(connectorId, previous);
    if (!target) {
      throw new Error('上一版本的文件已不完整');
    }
    await validateConnectorExecutable(
      target.executable,
      connectorId,
      target.version,
      target.runtimeRid && target.runtimeRoot
        ? buildPrivateDotnetEnvironment(target.runtimeRid, target.runtimeRoot)
        : {},
      CONNECTOR_HEALTH_CHECK_RETRY_TIMEOUT_MS
    );
    return target;
  }

  private async loadQuarantine(
    connectorId: NativeConnectorId
  ): Promise<ConnectorQuarantineEntry[]> {
    const loaded = this.quarantine.get(connectorId);
    if (loaded) return loaded;
    const entries = await this.readQuarantine(connectorId);
    // A rollback may have recorded an entry while the file was read.
    if (!this.quarantine.has(connectorId)) {
      this.quarantine.set(connectorId, entries);
    }
    return this.quarantine.get(connectorId) || entries;
  }

  private async addQuarantine(
    connectorId: NativeConnectorId,
    version: string
  ): Promise<void> {
    const entries = [
      ...(await this.loadQuarantine(connectorId))
        .filter(entry => entry.version !== version),
      { connectorId, version, at: new Date().toISOString() }
    ];
    // Memory first: this process honours the rollback even if the write fails.
    this.quarantine.set(connectorId, entries);
    await this.writeQuarantine(connectorId, entries);
  }

  private async clearQuarantine(
    connectorId: NativeConnectorId
  ): Promise<void> {
    const entries = await this.loadQuarantine(connectorId);
    if (entries.length === 0) return;
    this.quarantine.set(connectorId, []);
    try {
      await this.writeQuarantine(connectorId, []);
      this.onLog(
        `[连接器] 已恢复${CONNECTOR_NAMES[connectorId]}连接器 `
        + `${entries.map(entry => entry.version).join('、')} 的自动更新`
      );
    } catch (error: unknown) {
      this.onLog(
        `[连接器] ${CONNECTOR_NAMES[connectorId]}连接器的暂停记录清除失败：`
        + getErrorMessage(error)
      );
    }
  }

  private async readQuarantine(
    connectorId: NativeConnectorId
  ): Promise<ConnectorQuarantineEntry[]> {
    try {
      return parseQuarantineEntries(
        JSON.parse(await fs.promises.readFile(
          this.getQuarantinePath(connectorId),
          'utf8'
        )),
        connectorId
      );
    } catch {
      // A missing or unreadable file pauses nothing.
      return [];
    }
  }

  private async writeQuarantine(
    connectorId: NativeConnectorId,
    entries: readonly ConnectorQuarantineEntry[]
  ): Promise<void> {
    const quarantinePath = this.getQuarantinePath(connectorId);
    if (entries.length === 0) {
      await rmWithRetry(quarantinePath);
      return;
    }
    await fs.promises.mkdir(path.dirname(quarantinePath), { recursive: true });
    const nonce = crypto.randomBytes(8).toString('hex');
    const temporaryPath = `${quarantinePath}.${process.pid}.${nonce}.tmp`;
    try {
      await fs.promises.writeFile(
        temporaryPath,
        `${JSON.stringify({ entries }, null, 2)}\n`,
        'utf8'
      );
      await renameWithRetry(temporaryPath, quarantinePath);
    } catch (error) {
      await rmWithRetry(temporaryPath).catch(() => undefined);
      throw error;
    }
  }

  private getQuarantinePath(connectorId: NativeConnectorId): string {
    return path.join(this.getConnectorRoot(connectorId), 'quarantine.json');
  }

  private async writeActive(
    connectorId: NativeConnectorId,
    active: ActiveConnector
  ): Promise<void> {
    const connectorRoot = this.getConnectorRoot(connectorId);
    await fs.promises.mkdir(connectorRoot, { recursive: true });
    const activePath = path.join(connectorRoot, 'active.json');
    const nonce = crypto.randomBytes(8).toString('hex');
    const temporaryPath = `${activePath}.${process.pid}.${nonce}.tmp`;
    try {
      await fs.promises.writeFile(
        temporaryPath,
        `${JSON.stringify(active, null, 2)}\n`,
        { encoding: 'utf8', flag: 'w' }
      );
      // rename replaces the destination in a single step (MoveFileEx with
      // MOVEFILE_REPLACE_EXISTING on Windows), so a crash leaves either the
      // previous or the new active.json, never neither.
      await renameWithRetry(temporaryPath, activePath);
    } catch (error) {
      await rmWithRetry(temporaryPath).catch(() => undefined);
      throw error;
    }
  }

  private getConnectorRoot(
    connectorId: NativeConnectorId
  ): string {
    // Isolation must not inherit a production connector directory from the
    // launching shell, including during an explicitly requested manual update.
    const configuredRoot = shouldRunAutomaticConnectorMaintenance(
      process.env['AWOO_DEV_USER_DATA_DIR']?.trim() || null
    ) ? process.env.BILINCM_CONNECTOR_ROOT?.trim() : undefined;
    const root = configuredRoot
      ? path.resolve(configuredRoot)
      : path.join(app.getPath('userData'), 'player-connectors');
    return path.join(root, connectorId);
  }
}

async function isFile(filePath: string): Promise<boolean> {
  try {
    return (await fs.promises.stat(filePath)).isFile();
  } catch {
    return false;
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.promises.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * The version an activation replaces, recorded in active.json for a later
 * rollback. Re-activating the same version keeps the record it already had.
 * Only a version whose executable is still on disk is recorded, and the
 * record never carries a previous entry of its own.
 */
async function selectPreviousConnector(
  current: ActiveConnector | null,
  nextVersion: string
): Promise<PreviousConnector | undefined> {
  const candidate = current?.version === nextVersion
    ? current.previous
    : current;
  if (
    !candidate
    || typeof candidate.version !== 'string'
    || !CONNECTOR_VERSION_PATTERN.test(candidate.version)
    || candidate.version === nextVersion
    || typeof candidate.executable !== 'string'
    || !await isFile(candidate.executable)
  ) {
    return undefined;
  }
  return {
    version: candidate.version,
    executable: candidate.executable,
    deployment: candidate.deployment || 'self-contained',
    ...(candidate.runtimeRid ? { runtimeRid: candidate.runtimeRid } : {}),
    ...(candidate.runtimeRoot ? { runtimeRoot: candidate.runtimeRoot } : {})
  };
}

function parseQuarantineEntries(
  document: unknown,
  connectorId: NativeConnectorId
): ConnectorQuarantineEntry[] {
  const entries = (document as { entries?: unknown } | null)?.entries;
  if (!Array.isArray(entries)) return [];
  return entries
    .filter((entry: Partial<ConnectorQuarantineEntry> | null) =>
      entry?.connectorId === connectorId
      && typeof entry.version === 'string'
      && CONNECTOR_VERSION_PATTERN.test(entry.version)
      && typeof entry.at === 'string')
    .map((entry: ConnectorQuarantineEntry) => ({
      connectorId,
      version: entry.version,
      at: entry.at
    }));
}

async function validateConnectorExecutable(
  executable: string,
  connectorId: NativeConnectorId,
  expectedVersion?: string,
  launchEnvironment: Record<string, string> = {},
  timeoutMs = CONNECTOR_HEALTH_CHECK_TIMEOUT_MS
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const requestId = `health-${process.pid}-${Date.now()}`;
    const shutdownId = `${requestId}-shutdown`;
    const child = spawn(executable, [], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...launchEnvironment,
        BILINCM_FOLIA_TOKEN: ''
      }
    });
    let buffer = '';
    let stderr = '';
    let validated = false;
    let settled = false;
    let exited = false;
    let shutdownTimer: NodeJS.Timeout | null = null;

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (shutdownTimer) clearTimeout(shutdownTimer);
      const settle = () => (error ? reject(error) : resolve());
      if (exited || child.pid === undefined) {
        settle();
        return;
      }
      // Windows keeps the executable and its directory locked until the
      // process is gone; wait briefly so the caller's rename can succeed.
      const exitTimer = setTimeout(settle, CONNECTOR_EXIT_WAIT_MS);
      child.once('exit', () => {
        clearTimeout(exitTimer);
        settle();
      });
      if (!child.killed) child.kill();
    };

    const timeout = setTimeout(() => {
      finish(new Error(
        `${connectorId} 连接器启动健康检查超时`
        + (stderr ? `：${stderr.slice(-300)}` : '')
      ));
    }, timeoutMs);

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-2000);
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');
        if (!line) continue;
        try {
          const envelope = JSON.parse(line);
          if (envelope.id !== requestId) continue;
          const result = envelope.result;
          if (
            !envelope.ok
            || result?.protocolVersion !== CONNECTOR_PROTOCOL_VERSION
            || result?.connectorId !== connectorId
            || (
              expectedVersion
              && result?.connectorVersion !== expectedVersion
            )
          ) {
            finish(new Error(
              `${connectorId} 连接器健康检查协议或版本不匹配`
            ));
            return;
          }

          validated = true;
          child.stdin.write(`${JSON.stringify({
            id: shutdownId,
            action: 'shutdown'
          })}\n`);
          shutdownTimer = setTimeout(() => {
            if (child.exitCode === null && !child.killed) child.kill();
            finish();
          }, 1500);
        } catch {
          // Connectors are expected to keep stdout protocol-only. Ignore an
          // unrelated line and continue waiting for the matching envelope.
        }
      }
    });
    child.once('error', error => finish(error));
    child.once('exit', code => {
      exited = true;
      if (validated) {
        finish();
      } else {
        finish(new Error(
          `${connectorId} 连接器健康检查前退出（code=${code}）`
          + (stderr ? `：${stderr.slice(-300)}` : '')
        ));
      }
    });
    child.stdin.write(`${JSON.stringify({
      id: requestId,
      action: 'ping'
    })}\n`);
  });
}

async function removeInside(
  parent: string,
  target: string
): Promise<void> {
  await fs.promises.rm(resolveInside(parent, target), {
    recursive: true,
    force: true
  });
}

/** Installer variant that retries transient Windows file locks. */
async function removeInsideWithRetry(
  parent: string,
  target: string
): Promise<void> {
  await rmWithRetry(resolveInside(parent, target));
}

function resolveInside(parent: string, target: string): string {
  const parentPath = `${path.resolve(parent)}${path.sep}`;
  const targetPath = path.resolve(target);
  if (!targetPath.startsWith(parentPath)) {
    throw new Error(`拒绝删除连接器目录外路径：${targetPath}`);
  }
  return targetPath;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function isPathInside(parent: string, target: string): boolean {
  const normalize = (value: string) => process.platform === 'win32'
    ? value.toLowerCase()
    : value;
  const parentPath = normalize(`${path.resolve(parent)}${path.sep}`);
  return normalize(path.resolve(target)).startsWith(parentPath);
}

function compareVersions(left: string, right: string): number {
  const normalize = (value: string) =>
    value
      .split(/[+-]/, 1)[0]
      .split('.')
      .map(part => Number.parseInt(part, 10) || 0);
  const a = normalize(left);
  const b = normalize(right);
  for (
    let index = 0;
    index < Math.max(a.length, b.length);
    index++
  ) {
    const difference = (a[index] || 0) - (b[index] || 0);
    if (difference !== 0) {
      return difference > 0 ? 1 : -1;
    }
  }
  return 0;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
