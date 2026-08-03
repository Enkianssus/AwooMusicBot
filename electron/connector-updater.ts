import { app, net } from 'electron';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import extract from 'extract-zip';
import { downloadBufferWithRanges } from './connector-download';
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

export type NativeConnectorId =
  | 'netease'
  | 'kugou'
  | 'qqmusic'
  | 'folia';

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
  updating: boolean;
  checkedAt: string;
  error: string | null;
}

export interface ConnectorUpdateResult {
  success: boolean;
  updated: boolean;
  message: string;
  status: ConnectorUpdateStatus;
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

interface ConnectorCatalogEntry extends ConnectorPackageEntry {
  id: NativeConnectorId;
  version: string;
  protocolVersion: number;
  minimumCoreVersion: string;
  testedPlayerVersion?: string;
  playerVersionPolicy?: string;
  runtime?: DotnetRuntimeRid;
  frameworkDependent?: FrameworkDependentConnectorPackage;
}

interface ConnectorCatalog {
  schemaVersion: number;
  publicKeyId: string;
  connectors: Partial<Record<NativeConnectorId, ConnectorCatalogEntry>>;
}

interface ActiveConnector {
  id: NativeConnectorId;
  version: string;
  executable: string;
  deployment?: 'self-contained' | 'framework-dependent';
  runtimeRid?: DotnetRuntimeRid;
  runtimeRoot?: string;
  activatedAt: string;
}

type ConnectorPackageActivation = Pick<
  ActiveConnector,
  'deployment' | 'runtimeRid' | 'runtimeRoot'
>;

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
}

interface QQMusicProfileCatalog {
  schemaVersion: number;
  publicKeyId: string;
  profiles: {
    qqmusic: QQMusicProfileCatalogEntry | null;
  };
}

interface ActiveQQMusicProfiles {
  version: string;
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
const CATALOG_URL =
  'https://app.enkianss.us/connectors/v1/catalog.json';
const QQMUSIC_PROFILE_CATALOG_URL =
  'https://app.enkianss.us/connectors/v1/profiles/qqmusic/catalog.json';
const CATALOG_TTL_MS = 5 * 60 * 1000;
const PROTOCOL_VERSION = 1;
const CONNECTOR_VERSION_PATTERN = /^\d+(?:\.\d+){2,4}$/;
const PUBLIC_KEY_ID = 'bilincm-connectors-2026-01';
const RELEASE_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEApFy/TMxhGKlxzOS2b1gjvQxnvFhjefK0sbxsCXFS2uc=
-----END PUBLIC KEY-----
`;

const EXECUTABLE_NAMES: Record<NativeConnectorId, string> = {
  netease: 'BiliNCM.Connector.Netease.exe',
  kugou: 'BiliNCM.Connector.Kugou.exe',
  qqmusic: 'BiliNCM.Connector.QQMusic.exe',
  folia: 'BiliNCM.Connector.Folia.exe'
};

export class ConnectorUpdater {
  private catalog: ConnectorCatalog | null = null;
  private catalogFetchedAt = 0;
  private readonly updates = new Map<
    NativeConnectorId,
    Promise<ConnectorUpdateResult>
  >();
  private readonly validatedExecutables = new Set<string>();
  private qqMusicProfileUpdate: Promise<string | null> | null = null;
  private privateDotnetRuntime: PrivateDotnetRuntimeManager | null = null;

  constructor(
    private readonly onLog: (message: string) => void
  ) {}

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
    const active = await this.readActive(connectorId);
    if (active) {
      const installed = active.executable;
      const resolved = path.resolve(installed);
      if (!this.validatedExecutables.has(resolved)) {
        try {
          await validateConnectorExecutable(
            installed,
            connectorId,
            active.version,
            await this.getLaunchEnvironment(connectorId)
          );
          this.validatedExecutables.add(resolved);
        } catch (error: unknown) {
          this.onLog(
            `[连接器] ${CONNECTOR_NAMES[connectorId]}现有连接器健康检查失败，`
            + `正在自动重新安装：${getErrorMessage(error)}`
          );
          const repaired = await this.reinstall(connectorId);
          if (!repaired.success) {
            throw new Error(repaired.message);
          }
          const repairedExecutable = await this.resolve(connectorId);
          if (!repairedExecutable) {
            throw new Error(
              `${CONNECTOR_NAMES[connectorId]}连接器修复后未找到可执行文件`
            );
          }
          this.validatedExecutables.add(path.resolve(repairedExecutable));
          return repairedExecutable;
        }
      }
      return installed;
    }

    this.onLog(
      `[连接器] 首次使用 ${CONNECTOR_NAMES[connectorId]}，`
      + '正在自动下载安装独立连接器'
    );
    const result = await this.update(connectorId);
    if (!result.success) {
      throw new Error(result.message);
    }

    const executable = await this.resolve(connectorId);
    if (!executable) {
      throw new Error(
        `${CONNECTOR_NAMES[connectorId]}连接器安装后未找到可执行文件`
      );
    }
    this.validatedExecutables.add(path.resolve(executable));
    return executable;
  }

  async getStatuses(
    forceRefresh = false
  ): Promise<ConnectorUpdateStatus[]> {
    const checkedAt = new Date().toISOString();
    const activeConnectors = await Promise.all(
      CONNECTOR_IDS.map(id => this.readActive(id))
    );

    let catalog: ConnectorCatalog;
    try {
      catalog = await this.fetchCatalog(forceRefresh);
    } catch (error: unknown) {
      const message = getErrorMessage(error);
      return CONNECTOR_IDS.map((id, index) =>
        this.makeStatus(
          id,
          activeConnectors[index],
          null,
          checkedAt,
          message
        )
      );
    }

    return CONNECTOR_IDS.map((id, index) => {
      const entry = catalog.connectors[id] || null;
      try {
        if (!entry) {
          throw new Error(`更新清单缺少 ${id} 连接器`);
        }
        this.validateEntry(id, entry);
        return this.makeStatus(
          id,
          activeConnectors[index],
          entry,
          checkedAt,
          null
        );
      } catch (error: unknown) {
        return this.makeStatus(
          id,
          activeConnectors[index],
          null,
          checkedAt,
          getErrorMessage(error)
        );
      }
    });
  }

  async update(
    connectorId: NativeConnectorId,
    allowPlayerVersionChange = false
  ): Promise<ConnectorUpdateResult> {
    return this.runUpdate(
      connectorId,
      false,
      allowPlayerVersionChange
    );
  }

  async reinstall(
    connectorId: NativeConnectorId
  ): Promise<ConnectorUpdateResult> {
    return this.runUpdate(connectorId, true, false);
  }

  private async runUpdate(
    connectorId: NativeConnectorId,
    forceReinstall: boolean,
    allowPlayerVersionChange: boolean
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

    const update = this.updateInternal(
      connectorId,
      forceReinstall,
      allowPlayerVersionChange
    )
      .finally(() => {
        if (this.updates.get(connectorId) === update) {
          this.updates.delete(connectorId);
        }
      });
    this.updates.set(connectorId, update);
    return update;
  }

  private async updateInternal(
    connectorId: NativeConnectorId,
    forceReinstall: boolean,
    allowPlayerVersionChange: boolean
  ): Promise<ConnectorUpdateResult> {
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

    const entry = this.catalog?.connectors[connectorId];
    if (!entry) {
      return {
        success: false,
        updated: false,
        message: '更新清单中没有找到连接器',
        status
      };
    }

    try {
      await this.install(connectorId, entry, forceReinstall);
      const refreshedStatus = this.makeStatus(
        connectorId,
        await this.readActive(connectorId),
        entry,
        new Date().toISOString(),
        null
      );
      this.onLog(
        `[连接器更新] 已${forceReinstall ? '重新安装' : '安装'} `
        + `${connectorId} ${entry.version}`
      );
      return {
        success: true,
        updated: true,
        message: forceReinstall
          ? `${refreshedStatus.name}连接器 ${entry.version} 已重新安装`
          : `${refreshedStatus.name}连接器已更新到 ${entry.version}`,
        status: refreshedStatus
      };
    } catch (error: unknown) {
      const message = getErrorMessage(error);
      this.onLog(
        `[连接器更新] ${connectorId} 安装失败：${message}`
      );
      return {
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
      updating: this.updates.has(connectorId),
      checkedAt,
      error
    };
  }

  private async fetchCatalog(
    forceRefresh = false
  ): Promise<ConnectorCatalog> {
    if (
      !forceRefresh
      && this.catalog
      && Date.now() - this.catalogFetchedAt < CATALOG_TTL_MS
    ) {
      return this.catalog;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch(CATALOG_URL, {
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

      const catalog = await response.json() as ConnectorCatalog;
      if (
        catalog.schemaVersion !== 1
        || catalog.publicKeyId !== PUBLIC_KEY_ID
        || !catalog.connectors
      ) {
        throw new Error('连接器更新清单格式或签名密钥标识不兼容');
      }

      this.catalog = catalog;
      this.catalogFetchedAt = Date.now();
      return catalog;
    } finally {
      clearTimeout(timeout);
    }
  }

  private validateEntry(
    connectorId: NativeConnectorId,
    entry: ConnectorCatalogEntry
  ): void {
    if (
      entry.id !== connectorId
      || entry.protocolVersion !== PROTOCOL_VERSION
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
      || entry.asset !== `bilincm-connector-${connectorId}-${entry.version}-${entry.runtime || 'win-x86'}.zip`
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
      || framework.asset !== `bilincm-connector-${connectorId}-${entry.version}-${runtimeRid}-framework-dependent.zip`
      || path.basename(new URL(framework.downloadUrl).pathname) !== framework.asset
    )) {
      throw new Error(
        `${connectorId} framework-dependent 连接器清单字段无效`
      );
    }
  }

  private async install(
    connectorId: NativeConnectorId,
    entry: ConnectorCatalogEntry,
    forceReinstall = false
  ): Promise<string> {
    const framework = entry.frameworkDependent;
    if (framework) {
      try {
        const runtimeRoot = await this.getPrivateDotnetRuntime().ensure(
          framework.runtime,
          framework.runtimeChannel
        );
        return await this.installPackage(
          connectorId,
          entry,
          framework,
          {
            deployment: 'framework-dependent',
            runtimeRid: framework.runtime,
            runtimeRoot
          },
          forceReinstall
        );
      } catch (error: unknown) {
        this.onLog(
          `[连接器更新] ${connectorId} 小体积包或私有 .NET Runtime 安装失败，`
          + `自动回退完整包：${getErrorMessage(error)}`
        );
      }
    }

    return this.installPackage(
      connectorId,
      entry,
      entry,
      { deployment: 'self-contained' },
      forceReinstall
    );
  }

  private async installPackage(
    connectorId: NativeConnectorId,
    entry: ConnectorCatalogEntry,
    packageEntry: ConnectorPackageEntry,
    activation: ConnectorPackageActivation,
    forceReinstall = false
  ): Promise<string> {
    const connectorRoot = this.getConnectorRoot(connectorId);
    const versionDirectory = path.join(connectorRoot, entry.version);
    const executableName = EXECUTABLE_NAMES[connectorId];
    const executable = path.join(versionDirectory, executableName);

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
      && await isFile(executable)
    );
    if (canReuse) {
      await validateConnectorExecutable(
        executable,
        connectorId,
        entry.version,
        activation.runtimeRid && activation.runtimeRoot
          ? buildPrivateDotnetEnvironment(
            activation.runtimeRid,
            activation.runtimeRoot
          )
          : {}
      );
      await this.writeActive(connectorId, {
        id: connectorId,
        version: entry.version,
        executable,
        ...activation,
        activatedAt: new Date().toISOString()
      });
      return executable;
    }

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

    try {
      const archive = await downloadBufferWithRanges({
        url: packageEntry.downloadUrl,
        expectedSize: packageEntry.size,
        fetchImpl: (input, init) => net.fetch(input, init),
        onProgress: progress => {
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
      });

      if (archive.length !== packageEntry.size) {
        throw new Error(
          `文件大小不匹配：${archive.length}/${packageEntry.size}`
        );
      }

      const digest = crypto
        .createHash('sha256')
        .update(archive)
        .digest('hex');
      if (
        !crypto.timingSafeEqual(
          Buffer.from(digest, 'hex'),
          Buffer.from(packageEntry.sha256, 'hex')
        )
      ) {
        throw new Error('SHA-256 校验失败');
      }

      const signature = Buffer.from(packageEntry.signature, 'base64');
      if (
        !crypto.verify(
          null,
          archive,
          RELEASE_PUBLIC_KEY,
          signature
        )
      ) {
        throw new Error('Ed25519 签名校验失败');
      }

      await fs.promises.writeFile(archivePath, archive, {
        flag: 'wx'
      });
      await extract(archivePath, { dir: stagingDirectory });

      const stagedExecutable = path.join(
        stagingDirectory,
        executableName
      );
      if (!await isFile(stagedExecutable)) {
        throw new Error(`发布包缺少 ${executableName}`);
      }
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

      if (await pathExists(versionDirectory)) {
        await fs.promises.rename(versionDirectory, backupDirectory);
        movedPreviousDirectory = true;
      }
      await fs.promises.rename(stagingDirectory, versionDirectory);
      installedNewDirectory = true;
      await this.writeActive(connectorId, {
        id: connectorId,
        version: entry.version,
        executable,
        ...activation,
        activatedAt: new Date().toISOString()
      });
      if (movedPreviousDirectory) {
        await removeInside(connectorRoot, backupDirectory);
        movedPreviousDirectory = false;
      }
      return executable;
    } catch (error) {
      if (installedNewDirectory && await pathExists(versionDirectory)) {
        await removeInside(connectorRoot, versionDirectory);
      }
      if (movedPreviousDirectory && await pathExists(backupDirectory)) {
        await fs.promises.rename(backupDirectory, versionDirectory);
        movedPreviousDirectory = false;
      }
      throw error;
    } finally {
      if (await pathExists(archivePath)) {
        await fs.promises.rm(archivePath, { force: true });
      }
      if (await pathExists(stagingDirectory)) {
        await removeInside(connectorRoot, stagingDirectory);
      }
      if (!movedPreviousDirectory && await pathExists(backupDirectory)) {
        await removeInside(connectorRoot, backupDirectory);
      }
    }
  }

  private async ensureQQMusicProfiles(): Promise<string | null> {
    if (this.qqMusicProfileUpdate) return this.qqMusicProfileUpdate;
    const update = this.ensureQQMusicProfilesInternal().finally(() => {
      if (this.qqMusicProfileUpdate === update) {
        this.qqMusicProfileUpdate = null;
      }
    });
    this.qqMusicProfileUpdate = update;
    return update;
  }

  private async ensureQQMusicProfilesInternal(): Promise<string | null> {
    const active = await this.readActiveQQMusicProfiles();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    let catalog: QQMusicProfileCatalog;
    try {
      const response = await fetch(QQMUSIC_PROFILE_CATALOG_URL, {
        method: 'GET',
        cache: 'no-store',
        signal: controller.signal,
        headers: { Accept: 'application/json' }
      });
      if (!response.ok) throw new Error(`画像清单 HTTP ${response.status}`);
      catalog = await response.json() as QQMusicProfileCatalog;
    } finally {
      clearTimeout(timeout);
    }

    const entry = catalog.profiles?.qqmusic;
    if (
      catalog.schemaVersion !== 1
      || catalog.publicKeyId !== PUBLIC_KEY_ID
      || !entry
      || entry.id !== 'qqmusic'
      || entry.schemaVersion !== 1
      || !/^\d+\.\d+\.\d+$/.test(entry.version)
      || !Number.isSafeInteger(entry.size)
      || entry.size <= 0
      || !/^[a-f0-9]{64}$/i.test(entry.sha256)
      || !entry.signature
      || entry.asset !== `bilincm-qqmusic-profiles-${entry.version}.zip`
      || !entry.downloadUrl.startsWith(
        'https://app.enkianss.us/connectors/v1/profiles/qqmusic/download/'
      )
      || path.basename(new URL(entry.downloadUrl).pathname) !== entry.asset
    ) {
      throw new Error('QQ 音乐画像更新清单无效');
    }

    if (active && compareVersions(active.version, entry.version) >= 0) {
      return active.directory;
    }

    const profileRoot = this.getQQMusicProfileRoot();
    const versionDirectory = path.join(profileRoot, entry.version);
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
        const response = await fetch(entry.downloadUrl, {
          method: 'GET',
          cache: 'no-store',
          signal: downloadController.signal
        });
        if (!response.ok) throw new Error(`画像下载 HTTP ${response.status}`);
        archive = Buffer.from(await response.arrayBuffer());
      } finally {
        clearTimeout(downloadTimeout);
      }
      if (archive.length !== entry.size) {
        throw new Error(`画像大小不匹配：${archive.length}/${entry.size}`);
      }
      const digest = crypto.createHash('sha256').update(archive).digest('hex');
      if (!crypto.timingSafeEqual(
        Buffer.from(digest, 'hex'),
        Buffer.from(entry.sha256, 'hex')
      )) {
        throw new Error('QQ 画像 SHA-256 校验失败');
      }
      if (!crypto.verify(
        null,
        archive,
        RELEASE_PUBLIC_KEY,
        Buffer.from(entry.signature, 'base64')
      )) {
        throw new Error('QQ 画像 Ed25519 签名校验失败');
      }

      await fs.promises.writeFile(archivePath, archive, { flag: 'wx' });
      await extract(archivePath, { dir: stagingDirectory });
      const profileFiles = (await fs.promises.readdir(stagingDirectory))
        .filter(file => /^\d+\.\d+\.json$/i.test(file));
      if (profileFiles.length === 0) {
        throw new Error('QQ 画像包没有版本画像 JSON');
      }
      for (const file of profileFiles) {
        const document = JSON.parse(await fs.promises.readFile(
          path.join(stagingDirectory, file),
          'utf8'
        ));
        if (
          document.schemaVersion !== 1
          || !/^\d+\.\d+$/.test(String(document.fileVersion || ''))
          || !/^[a-f0-9]{64}$/i.test(String(document.clientSha256 || ''))
          || !/^[a-f0-9]{64}$/i.test(String(document.commonSha256 || ''))
        ) {
          throw new Error(`QQ 画像文件无效：${file}`);
        }
      }

      if (await pathExists(versionDirectory)) {
        await removeInside(profileRoot, versionDirectory);
      }
      await fs.promises.rename(stagingDirectory, versionDirectory);
      await this.writeActiveQQMusicProfiles({
        version: entry.version,
        directory: versionDirectory,
        activatedAt: new Date().toISOString()
      });
      this.onLog(`[QQ 画像] 已更新到 ${entry.version}`);
      return versionDirectory;
    } finally {
      await fs.promises.rm(archivePath, { force: true });
      if (await pathExists(stagingDirectory)) {
        await removeInside(profileRoot, stagingDirectory);
      }
    }
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
    await fs.promises.writeFile(
      temporaryPath,
      `${JSON.stringify(active, null, 2)}\n`,
      'utf8'
    );
    await fs.promises.rm(activePath, { force: true });
    await fs.promises.rename(temporaryPath, activePath);
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
      if (
        active.id !== connectorId
        || !CONNECTOR_VERSION_PATTERN.test(active.version)
      ) {
        return null;
      }

      const expected = path.join(
        this.getConnectorRoot(connectorId),
        active.version,
        EXECUTABLE_NAMES[connectorId]
      );
      if (
        path.resolve(active.executable) !== path.resolve(expected)
        || !await isFile(expected)
      ) {
        return null;
      }

      const deployment = active.deployment || 'self-contained';
      let runtimeRoot: string | undefined;
      let runtimeRid: DotnetRuntimeRid | undefined;
      if (deployment === 'framework-dependent') {
        if (
          !active.runtimeRoot
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
        ...active,
        executable: expected,
        deployment,
        runtimeRid,
        runtimeRoot
      };
    } catch {
      return null;
    }
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
    const backupPath = `${activePath}.${process.pid}.${nonce}.bak`;
    await fs.promises.writeFile(
      temporaryPath,
      `${JSON.stringify(active, null, 2)}\n`,
      { encoding: 'utf8', flag: 'w' }
    );
    let movedPrevious = false;
    let activatedNew = false;
    let preserveBackup = false;
    try {
      if (await pathExists(activePath)) {
        await fs.promises.rename(activePath, backupPath);
        movedPrevious = true;
      }
      await fs.promises.rename(temporaryPath, activePath);
      activatedNew = true;
      if (movedPrevious) {
        await fs.promises.rm(backupPath, { force: true });
        movedPrevious = false;
      }
    } catch (error) {
      if (activatedNew) {
        await fs.promises.rm(activePath, { force: true });
      }
      if (movedPrevious && await pathExists(backupPath)) {
        try {
          await fs.promises.rename(backupPath, activePath);
          movedPrevious = false;
        } catch (restoreError) {
          preserveBackup = true;
          throw new Error(
            `连接器激活失败且 active.json 自动恢复失败：`
            + `${getErrorMessage(error)}；`
            + `${getErrorMessage(restoreError)}；`
            + `备份保留于 ${backupPath}`
          );
        }
      }
      throw error;
    } finally {
      await fs.promises.rm(temporaryPath, { force: true });
      if (!preserveBackup) {
        await fs.promises.rm(backupPath, { force: true });
      }
    }
  }

  private getConnectorRoot(
    connectorId: NativeConnectorId
  ): string {
    const configuredRoot =
      process.env.BILINCM_CONNECTOR_ROOT?.trim();
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

async function validateConnectorExecutable(
  executable: string,
  connectorId: NativeConnectorId,
  expectedVersion?: string,
  launchEnvironment: Record<string, string> = {}
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
    let shutdownTimer: NodeJS.Timeout | null = null;

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (shutdownTimer) clearTimeout(shutdownTimer);
      if (error) {
        if (child.exitCode === null && !child.killed) child.kill();
        reject(error);
      } else {
        resolve();
      }
    };

    const timeout = setTimeout(() => {
      finish(new Error(
        `${connectorId} 连接器启动健康检查超时`
        + (stderr ? `：${stderr.slice(-300)}` : '')
      ));
    }, 6000);

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
            || result?.protocolVersion !== PROTOCOL_VERSION
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
  const parentPath = `${path.resolve(parent)}${path.sep}`;
  const targetPath = path.resolve(target);
  if (!targetPath.startsWith(parentPath)) {
    throw new Error(`拒绝删除连接器目录外路径：${targetPath}`);
  }
  await fs.promises.rm(targetPath, {
    recursive: true,
    force: true
  });
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
