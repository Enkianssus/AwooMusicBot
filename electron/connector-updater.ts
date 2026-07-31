import { app } from 'electron';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import extract from 'extract-zip';

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

interface ConnectorCatalogEntry {
  id: NativeConnectorId;
  version: string;
  protocolVersion: number;
  minimumCoreVersion: string;
  runtime?: 'win-x86' | 'win-x64';
  asset: string;
  size: number;
  sha256: string;
  signature: string;
  downloadUrl: string;
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
const CATALOG_TTL_MS = 5 * 60 * 1000;
const PROTOCOL_VERSION = 1;
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

  constructor(
    private readonly onLog: (message: string) => void
  ) {}

  async resolve(connectorId: NativeConnectorId): Promise<string | null> {
    return (await this.readActive(connectorId))?.executable || null;
  }

  async isInstalled(connectorId: NativeConnectorId): Promise<boolean> {
    return Boolean(await this.readActive(connectorId));
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
            active.version
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
    connectorId: NativeConnectorId
  ): Promise<ConnectorUpdateResult> {
    return this.runUpdate(connectorId, false);
  }

  async reinstall(
    connectorId: NativeConnectorId
  ): Promise<ConnectorUpdateResult> {
    return this.runUpdate(connectorId, true);
  }

  private async runUpdate(
    connectorId: NativeConnectorId,
    forceReinstall: boolean
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

    const update = this.updateInternal(connectorId, forceReinstall)
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
    forceReinstall: boolean
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
    return {
      id: connectorId,
      name: CONNECTOR_NAMES[connectorId],
      installed: Boolean(active),
      currentVersion: active?.version || null,
      latestVersion: entry?.version || null,
      minimumCoreVersion: entry?.minimumCoreVersion || null,
      compatible,
      updateAvailable: Boolean(
        entry
        && compatible
        && (
          !active
          || compareVersions(active.version, entry.version) < 0
        )
      ),
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
      || !/^\d+\.\d+\.\d+$/.test(entry.version)
      || !/^\d+\.\d+\.\d+$/.test(entry.minimumCoreVersion)
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
  }

  private async install(
    connectorId: NativeConnectorId,
    entry: ConnectorCatalogEntry,
    forceReinstall = false
  ): Promise<string> {
    const connectorRoot = this.getConnectorRoot(connectorId);
    const versionDirectory = path.join(connectorRoot, entry.version);
    const executableName = EXECUTABLE_NAMES[connectorId];
    const executable = path.join(versionDirectory, executableName);

    if (!forceReinstall && await isFile(executable)) {
      await validateConnectorExecutable(
        executable,
        connectorId,
        entry.version
      );
      await this.writeActive(connectorId, {
        id: connectorId,
        version: entry.version,
        executable,
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
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 120000);
      let archive: Buffer;
      try {
        const response = await fetch(entry.downloadUrl, {
          method: 'GET',
          cache: 'no-store',
          signal: controller.signal
        });
        if (!response.ok) {
          throw new Error(`下载 HTTP ${response.status}`);
        }
        archive = Buffer.from(await response.arrayBuffer());
      } finally {
        clearTimeout(timeout);
      }

      if (archive.length !== entry.size) {
        throw new Error(
          `文件大小不匹配：${archive.length}/${entry.size}`
        );
      }

      const digest = crypto
        .createHash('sha256')
        .update(archive)
        .digest('hex');
      if (
        !crypto.timingSafeEqual(
          Buffer.from(digest, 'hex'),
          Buffer.from(entry.sha256, 'hex')
        )
      ) {
        throw new Error('SHA-256 校验失败');
      }

      const signature = Buffer.from(entry.signature, 'base64');
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
        entry.version
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
        || !/^\d+\.\d+\.\d+$/.test(active.version)
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
      return {
        ...active,
        executable: expected
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
  expectedVersion?: string
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const requestId = `health-${process.pid}-${Date.now()}`;
    const shutdownId = `${requestId}-shutdown`;
    const child = spawn(executable, [], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
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
