import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ConnectorUpdateStatus, NativeConnectorId } from './connector-updater';

export type UpdateComponentId = 'core' | NativeConnectorId;

export interface UpdateAnnouncement {
  id: UpdateComponentId;
  name: string;
  currentVersion: string | null;
  version: string;
  notes: string;
  notesUrl: string;
  canUpdate: boolean;
  blockedReason?: string;
  manualUpdate: boolean;
  supportedPlayerVersion?: string;
}

export interface UpdateReceipt {
  id: string;
  componentId: UpdateComponentId;
  name: string;
  version: string;
  previousVersion: string;
  completedAt: string;
}

interface PendingCoreUpdate {
  previousVersion: string;
  targetVersion: string;
}

interface ReceiptState {
  schemaVersion: 1;
  pendingCore: PendingCoreUpdate | null;
  receipts: UpdateReceipt[];
}

const VERSION_PATTERN = /^\d+(?:\.\d+){2,4}$/;
const COMPONENT_IDS = ['core', 'netease', 'kugou', 'qqmusic', 'folia'];
const MAX_STATE_BYTES = 1024 * 1024;
const MAX_NOTES_BYTES = 192 * 1024;
export const MAX_RELEASE_NOTES_LENGTH = 6000;
export const RELEASE_NOTES_UNAVAILABLE = '暂未提供此版本的更新说明。';

function isVersion(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 60 && VERSION_PATTERN.test(value);
}

export function compareUpdateVersions(left: string, right: string): number {
  if (!isVersion(left) || !isVersion(right)) return 0;
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const difference = (a[index] || 0) - (b[index] || 0);
    if (difference) return Math.sign(difference);
  }
  return 0;
}

/** Receipts are serialized independently of user preferences, including in dev isolation. */
export class UpdateReceiptStore {
  private readonly filePath: string;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(directory: string) {
    this.filePath = path.join(directory, 'update-announcements.json');
  }

  private async read(): Promise<ReceiptState> {
    let text: string;
    try {
      const stat = await fs.promises.stat(this.filePath);
      if (stat.size > MAX_STATE_BYTES) throw new Error('更新通知记录超过大小限制');
      text = await fs.promises.readFile(this.filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { schemaVersion: 1, pendingCore: null, receipts: [] };
      }
      throw error;
    }
    const state = JSON.parse(text) as ReceiptState;
    if (state.schemaVersion !== 1 || !Array.isArray(state.receipts)
      || state.receipts.some(receipt => !receipt
        || typeof receipt.id !== 'string' || receipt.id.length > 100
        || !COMPONENT_IDS.includes(receipt.componentId)
        || typeof receipt.name !== 'string' || receipt.name.length > 100
        || !isVersion(receipt.version)
        || !isVersion(receipt.previousVersion)
        || typeof receipt.completedAt !== 'string' || receipt.completedAt.length > 50
        || !Number.isFinite(Date.parse(receipt.completedAt)))
      || (state.pendingCore && (
        !isVersion(state.pendingCore.previousVersion)
        || !isVersion(state.pendingCore.targetVersion)))) {
      throw new Error('更新通知记录格式无效');
    }
    return state;
  }

  private async write(state: ReceiptState): Promise<void> {
    const serialized = `${JSON.stringify(state, null, 2)}\n`;
    if (Buffer.byteLength(serialized) > MAX_STATE_BYTES) {
      throw new Error('更新通知记录已满，请确认已有通知后重试');
    }
    await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await fs.promises.writeFile(temporary, serialized, { encoding: 'utf8', flag: 'wx' });
      await fs.promises.rename(temporary, this.filePath);
    } finally {
      await fs.promises.rm(temporary, { force: true });
    }
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.tail.then(operation);
    this.tail = next.catch(() => undefined);
    return next;
  }

  list(): Promise<UpdateReceipt[]> {
    return this.serialize(async () => (await this.read()).receipts);
  }

  prepareCoreUpdate(previousVersion: string, targetVersion: string): Promise<void> {
    return this.serialize(async () => {
      if (compareUpdateVersions(targetVersion, previousVersion) <= 0) {
        throw new Error('更新目标版本必须高于当前版本');
      }
      const state = await this.read();
      state.pendingCore = { previousVersion, targetVersion };
      await this.write(state);
    });
  }

  clearPendingCoreUpdate(): Promise<void> {
    return this.serialize(async () => {
      const state = await this.read();
      if (!state.pendingCore) return;
      state.pendingCore = null;
      await this.write(state);
    });
  }

  reconcileCoreVersion(currentVersion: string): Promise<void> {
    return this.serialize(async () => {
      const state = await this.read();
      const pending = state.pendingCore;
      if (!pending
        || compareUpdateVersions(currentVersion, pending.targetVersion) < 0
        || compareUpdateVersions(currentVersion, pending.previousVersion) <= 0) return;
      this.appendReceipt(state, 'core', '嗷呜点歌机', pending.previousVersion, currentVersion);
      state.pendingCore = null;
      await this.write(state);
    });
  }

  recordConnectorUpdate(
    componentId: NativeConnectorId,
    name: string,
    previousVersion: string | null,
    version: string
  ): Promise<UpdateReceipt | null> {
    return this.serialize(async () => {
      // First installations and same-version repairs are not successful upgrades.
      if (!previousVersion || compareUpdateVersions(version, previousVersion) <= 0) return null;
      const state = await this.read();
      const receipt = this.appendReceipt(state, componentId, name, previousVersion, version);
      if (receipt) await this.write(state);
      return receipt;
    });
  }

  private appendReceipt(
    state: ReceiptState,
    componentId: UpdateComponentId,
    name: string,
    previousVersion: string,
    version: string
  ): UpdateReceipt | null {
    if (state.receipts.some(item => item.componentId === componentId
      && item.version === version && item.previousVersion === previousVersion)) return null;
    const receipt: UpdateReceipt = {
      id: randomUUID(), componentId, name, previousVersion, version,
      completedAt: new Date().toISOString()
    };
    state.receipts.push(receipt);
    return receipt;
  }

  acknowledge(ids: string[]): Promise<void> {
    return this.serialize(async () => {
      const state = await this.read();
      const selected = new Set(ids);
      const retained = state.receipts.filter(receipt => !selected.has(receipt.id));
      if (retained.length === state.receipts.length) return;
      state.receipts = retained;
      await this.write(state);
    });
  }
}

/** One lock covers explicit updates, automatic maintenance, and the final core restart. */
export class UpdateInstallationGuard {
  private active: { componentId: UpdateComponentId; token: symbol } | null = null;

  get componentId(): UpdateComponentId | null { return this.active?.componentId || null; }

  acquire(componentId: UpdateComponentId): (() => void) | null {
    if (this.active) return null;
    const token = Symbol(componentId);
    this.active = { componentId, token };
    return () => { if (this.active?.token === token) this.active = null; };
  }
}

export const updateInstallationGuard = new UpdateInstallationGuard();

type ConnectorUpdateListener = (
  id: NativeConnectorId, name: string, previousVersion: string | null, version: string
) => Promise<void>;
let connectorUpdateListener: ConnectorUpdateListener | null = null;

export function setConnectorUpdateListener(listener: ConnectorUpdateListener): void {
  connectorUpdateListener = listener;
}

export async function reportCompletedConnectorUpdate(
  id: NativeConnectorId, name: string, previousVersion: string | null, version: string
): Promise<void> {
  await connectorUpdateListener?.(id, name, previousVersion, version);
}

export function releaseNotesLocation(id: UpdateComponentId, version: string) {
  if (!COMPONENT_IDS.includes(id) || !isVersion(version)) {
    throw new Error('更新版本无效');
  }
  const repository = id === 'core' ? 'Enkianssus/AwooMusicBot' : 'Enkianssus/awoo-connectors';
  const tag = id === 'core' ? `v${version}` : `${id}-v${version}`;
  return {
    tag,
    apiUrl: `https://api.github.com/repos/${repository}/releases/tags/${encodeURIComponent(tag)}`,
    notesUrl: `https://github.com/${repository}/releases/tag/${encodeURIComponent(tag)}`
  };
}

export function normalizeReleaseNotes(value: unknown): string {
  if (typeof value !== 'string') return '';
  return Array.from(value.replace(/\r\n/g, '\n'))
    .filter(character => character.charCodeAt(0) >= 32 || character === '\n' || character === '\t')
    .join('')
    .trim().slice(0, MAX_RELEASE_NOTES_LENGTH);
}

/** The body is displayed as text; HTML from a release is never executed. */
export async function fetchReleaseNotes(
  id: UpdateComponentId,
  version: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 7000
): Promise<string> {
  const location = releaseNotesLocation(id, version);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await fetchImpl(location.apiUrl, {
      signal: controller.signal,
      redirect: 'error',
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'AwooMusicBot-Update-Announcements' }
    });
    if (!response.ok || !response.body) return RELEASE_NOTES_UNAVAILABLE;
    if (Number(response.headers.get('content-length')) > MAX_NOTES_BYTES) return RELEASE_NOTES_UNAVAILABLE;
    reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    let result = await reader.read();
    while (!result.done) {
      size += result.value.byteLength;
      if (size > MAX_NOTES_BYTES) return RELEASE_NOTES_UNAVAILABLE;
      chunks.push(result.value);
      result = await reader.read();
    }
    const release = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (release.tag_name !== location.tag || release.draft === true || release.prerelease === true) {
      return RELEASE_NOTES_UNAVAILABLE;
    }
    return normalizeReleaseNotes(release.body) || RELEASE_NOTES_UNAVAILABLE;
  } catch {
    return RELEASE_NOTES_UNAVAILABLE;
  } finally {
    clearTimeout(timeout);
    await reader?.cancel().catch(() => undefined);
  }
}

interface CoreUpdateCandidate { version: string; notes?: string; }

interface AnnouncementServiceOptions {
  currentVersion: string;
  store: UpdateReceiptStore;
  checkCore: () => Promise<CoreUpdateCandidate | null>;
  getConnectorStatuses: (refresh: boolean) => Promise<ConnectorUpdateStatus[]>;
  fetchImpl?: typeof fetch;
  networkEnabled: boolean;
  coreEnabled: boolean;
  now?: () => number;
  checkTimeoutMs?: number;
}

async function boundedCheck<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('更新检查超时')), timeoutMs);
    })]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface UpdateAnnouncementResponse {
  success: true;
  sessionId: string;
  items: UpdateAnnouncement[];
  receipts: UpdateReceipt[];
  errors?: string[];
}

export class UpdateAnnouncementService {
  readonly sessionId = randomUUID();
  private readonly options: AnnouncementServiceOptions;
  private cached: { items: UpdateAnnouncement[]; errors: string[]; at: number } | null = null;
  private inFlight: Promise<void> | null = null;
  private readonly installedVersions = new Map<UpdateComponentId, string>();

  constructor(options: AnnouncementServiceOptions) { this.options = options; }

  noteInstalled(id: UpdateComponentId, version: string): void {
    this.installedVersions.set(id, version);
  }

  async get(refresh = false): Promise<UpdateAnnouncementResponse> {
    const errors: string[] = [];
    if (!this.options.networkEnabled) {
      errors.push('隔离开发模式已禁用在线更新检查。');
    } else if (!this.options.coreEnabled) {
      errors.push('多实例调试模式已禁用点歌机更新检查，请在正式安装版中操作。');
    }
    let receipts: UpdateReceipt[] = [];
    try {
      await this.options.store.reconcileCoreVersion(this.options.currentVersion);
      receipts = await this.options.store.list();
    } catch {
      errors.push('无法读取更新完成记录，请稍后重试。');
    }
    const now = this.options.now?.() ?? Date.now();
    const ttl = this.cached?.errors.length ? 30_000 : 5 * 60_000;
    if (this.options.networkEnabled && (refresh || !this.cached || now - this.cached.at >= ttl)) {
      if (!this.inFlight) {
        this.inFlight = this.check(refresh).finally(() => { this.inFlight = null; });
      }
      await this.inFlight;
    }
    // A maintenance activation may finish while release notes are in flight.
    try { receipts = await this.options.store.list(); } catch { /* Reported above. */ }
    const items = (this.cached?.items || []).filter(item => {
      // Historical unacknowledged receipts are not evidence of the currently
      // active version after a manual rollback or a new installation.
      const installed = this.installedVersions.get(item.id);
      return !installed || compareUpdateVersions(item.version, installed) > 0;
    });
    const allErrors = [...new Set([...errors, ...(this.cached?.errors || [])])];
    return { success: true, sessionId: this.sessionId, items, receipts,
      ...(allErrors.length ? { errors: allErrors } : {}) };
  }

  private async check(refresh: boolean): Promise<void> {
    const errors: string[] = [];
    const items: UpdateAnnouncement[] = [];
    const timeoutMs = this.options.checkTimeoutMs ?? 18_000;
    const core = this.options.coreEnabled
      ? boundedCheck(Promise.resolve().then(() => this.options.checkCore()), timeoutMs).catch(() => {
        errors.push('点歌机更新检查失败，请稍后重试。'); return null;
      })
      : Promise.resolve(null);
    const connectors = boundedCheck(
      Promise.resolve().then(() => this.options.getConnectorStatuses(refresh)), timeoutMs
    ).catch(() => {
      errors.push('连接器更新检查失败，请稍后重试。'); return [];
    });
    const [coreCandidate, statuses] = await Promise.all([core, connectors]);
    if (coreCandidate && compareUpdateVersions(coreCandidate.version, this.options.currentVersion) > 0) {
      items.push({ id: 'core', name: '嗷呜点歌机', currentVersion: this.options.currentVersion,
        version: coreCandidate.version, notes: normalizeReleaseNotes(coreCandidate.notes),
        notesUrl: releaseNotesLocation('core', coreCandidate.version).notesUrl,
        canUpdate: true, manualUpdate: false });
    }
    for (const status of statuses) {
      if (status.error) {
        errors.push(`${status.name}更新检查失败，请稍后重试。`);
        continue;
      }
      if (!status.installed || !status.currentVersion || !status.latestVersion
        || compareUpdateVersions(status.latestVersion, status.currentVersion) <= 0) continue;
      items.push({ id: status.id, name: `${status.name}连接器`, currentVersion: status.currentVersion,
        version: status.latestVersion, notes: '',
        notesUrl: releaseNotesLocation(status.id, status.latestVersion).notesUrl,
        canUpdate: status.compatible,
        ...(!status.compatible ? { blockedReason: `需要点歌机 ${status.minimumCoreVersion || '更高版本'} 或以上版本` } : {}),
        manualUpdate: status.manualUpdateAvailable,
        ...(status.supportedPlayerVersion ? { supportedPlayerVersion: status.supportedPlayerVersion } : {}) });
    }
    await Promise.all(items.map(async item => {
      if (!item.notes) item.notes = await fetchReleaseNotes(item.id, item.version, this.options.fetchImpl);
    }));
    this.cached = { items, errors, at: this.options.now?.() ?? Date.now() };
  }
}
