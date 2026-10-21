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
  /**
   * This connector version was rolled back on this computer. It is offered
   * only as a manual retry, and `notes` start with QUARANTINED_CONNECTOR_NOTE.
   */
  quarantined?: boolean;
  supportedPlayerVersion?: string;
  /** Full package size of a core update, when the feed reports it. */
  sizeBytes?: number;
}

export interface UpdateReceipt {
  id: string;
  componentId: UpdateComponentId;
  name: string;
  version: string;
  previousVersion: string;
  completedAt: string;
}

/** Identifies the process that handed a core update to Velopack. */
export interface PendingCoreMarker {
  startedAt?: string;
  pid?: number;
}

interface PendingCoreUpdate extends PendingCoreMarker {
  previousVersion: string;
  targetVersion: string;
}

export interface PendingCoreFailure {
  previousVersion: string;
  targetVersion: string;
}

export type PendingCoreInspection =
  | { failed: false }
  | ({ failed: true } & PendingCoreFailure);

interface ReceiptState {
  schemaVersion: 1;
  pendingCore: PendingCoreUpdate | null;
  receipts: UpdateReceipt[];
}

const VERSION_PATTERN = /^\d+(?:\.\d+){2,4}$/;
const COMPONENT_IDS: readonly unknown[] = ['core', 'netease', 'kugou', 'qqmusic', 'folia'];
const MAX_STATE_BYTES = 1024 * 1024;
const MAX_NOTES_BYTES = 192 * 1024;
const RELEASE_NOTES_RETRY_MS = 10 * 60_000;
const ANNOUNCEMENT_TTL_MS = 5 * 60_000;
const ERROR_RETRY_DELAYS_MS = [30_000, 60_000, 120_000, 300_000];
const MIN_REFRESH_INTERVAL_MS = 10_000;
export const MAX_RELEASE_NOTES_LENGTH = 6000;
export const RELEASE_NOTES_UNAVAILABLE = '暂未提供此版本的更新说明。';
export const RELEASE_NOTES_TEMPORARILY_UNAVAILABLE = '更新说明暂时无法获取，可点击“完整更新说明”查看。';
export const CONNECTOR_CATALOG_UNAVAILABLE = '连接器更新清单暂时无法获取';
/** Leads the notes of a connector version that was rolled back on this computer. */
export const QUARANTINED_CONNECTOR_NOTE =
  '该版本在本机无法连接播放器，已自动回退并暂停自动更新；如需重试，请手动更新。';

/** Update versions are purely numeric; SemVer prerelease tags are not update targets. */
export function isUpdateVersion(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 60 && VERSION_PATTERN.test(value);
}

export function compareUpdateVersions(left: string, right: string): number {
  if (!isUpdateVersion(left) || !isUpdateVersion(right)) return 0;
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const difference = (a[index] || 0) - (b[index] || 0);
    if (difference) return Math.sign(difference);
  }
  return 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 50 && Number.isFinite(Date.parse(value));
}

function isProcessId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isReceipt(value: unknown): value is UpdateReceipt {
  return isRecord(value)
    && typeof value.id === 'string' && value.id.length <= 100
    && COMPONENT_IDS.includes(value.componentId)
    && typeof value.name === 'string' && value.name.length <= 100
    && isUpdateVersion(value.version)
    && isUpdateVersion(value.previousVersion)
    && isTimestamp(value.completedAt);
}

function pendingCoreFrom(value: unknown): PendingCoreUpdate | null {
  if (!isRecord(value)) return null;
  const { previousVersion, targetVersion, startedAt, pid } = value;
  if (!isUpdateVersion(previousVersion) || !isUpdateVersion(targetVersion)) return null;
  if (startedAt !== undefined && !isTimestamp(startedAt)) return null;
  if (pid !== undefined && !isProcessId(pid)) return null;
  return {
    previousVersion, targetVersion,
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(pid !== undefined ? { pid } : {})
  };
}

function emptyState(): ReceiptState {
  return { schemaVersion: 1, pendingCore: null, receipts: [] };
}

/** Receipts are serialized independently of user preferences, including in dev isolation. */
export class UpdateReceiptStore {
  private readonly filePath: string;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(directory: string) {
    this.filePath = path.join(directory, 'update-announcements.json');
  }

  /**
   * Damaged, oversized or future-schema state is moved aside and replaced by
   * an empty state: self-update is the user's recovery path and must not
   * depend on this file. Individually invalid entries are dropped.
   */
  private async read(): Promise<ReceiptState> {
    let text: string | null = null;
    try {
      const stat = await fs.promises.stat(this.filePath);
      if (stat.size <= MAX_STATE_BYTES) text = await fs.promises.readFile(this.filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyState();
      throw error;
    }
    let state: unknown = null;
    try {
      if (text !== null) state = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
    } catch { /* Quarantined below. */ }
    if (!isRecord(state) || state.schemaVersion !== 1 || !Array.isArray(state.receipts)) {
      await this.quarantine();
      return emptyState();
    }
    return {
      schemaVersion: 1,
      pendingCore: pendingCoreFrom(state.pendingCore),
      receipts: state.receipts.filter(isReceipt)
    };
  }

  /** Keeps the unreadable file for diagnosis without replacing an earlier copy. */
  private async quarantine(): Promise<void> {
    const base = `${this.filePath}.corrupt-${Date.now()}`;
    for (let attempt = 0; attempt < 10; attempt++) {
      const target = attempt ? `${base}-${attempt}` : base;
      const taken = await fs.promises.lstat(target).then(
        () => true,
        error => (error as NodeJS.ErrnoException).code !== 'ENOENT'
      );
      if (taken) continue;
      // Best effort: a locked file still reads as empty state and is retried next time.
      await fs.promises.rename(this.filePath, target).catch(() => undefined);
      return;
    }
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

  prepareCoreUpdate(
    previousVersion: string,
    targetVersion: string,
    marker: PendingCoreMarker = {}
  ): Promise<void> {
    return this.serialize(async () => {
      if (compareUpdateVersions(targetVersion, previousVersion) <= 0) {
        throw new Error('更新目标版本必须高于当前版本');
      }
      const pendingCore = pendingCoreFrom({
        previousVersion, targetVersion,
        startedAt: marker.startedAt ?? new Date().toISOString(),
        pid: marker.pid ?? process.pid
      });
      if (!pendingCore) throw new Error('更新进度标记无效');
      const state = await this.read();
      state.pendingCore = pendingCore;
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

  /**
   * A marker written by another process while still at the old version means
   * that Velopack never applied the update. The same process is still applying.
   */
  inspectPendingCore(currentVersion: string, currentPid: number): Promise<PendingCoreInspection> {
    return this.serialize<PendingCoreInspection>(async () => {
      const pending = (await this.read()).pendingCore;
      if (!pending || pending.pid === currentPid || !isUpdateVersion(currentVersion)
        || compareUpdateVersions(currentVersion, pending.previousVersion) !== 0) {
        return { failed: false };
      }
      return { failed: true, previousVersion: pending.previousVersion, targetVersion: pending.targetVersion };
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

  /**
   * Withdraws unacknowledged receipts that announce `version` of a component,
   * for example after that version was rolled back. Receipts of other
   * versions stay. Resolves how many receipts were dropped.
   */
  discardReceipt(componentId: UpdateComponentId, version: string): Promise<number> {
    return this.serialize(async () => {
      const state = await this.read();
      // Exact match: an invalid version must never match every receipt.
      const retained = state.receipts.filter(receipt =>
        receipt.componentId !== componentId || receipt.version !== version);
      const discarded = state.receipts.length - retained.length;
      if (discarded === 0) return 0;
      state.receipts = retained;
      await this.write(state);
      return discarded;
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
  if (!COMPONENT_IDS.includes(id) || !isUpdateVersion(version)) {
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

interface ReleaseNotesResult {
  notes: string;
  /** Only an actual release body is final; every fallback may change later. */
  found: boolean;
}

function missingReleaseNotes(temporary: boolean): ReleaseNotesResult {
  return { notes: temporary ? RELEASE_NOTES_TEMPORARILY_UNAVAILABLE : RELEASE_NOTES_UNAVAILABLE, found: false };
}

async function loadReleaseNotes(
  id: UpdateComponentId,
  version: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 7000
): Promise<ReleaseNotesResult> {
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
    // Rate limits and server errors say nothing about whether notes exist.
    if (!response.ok) {
      return missingReleaseNotes([403, 408, 429].includes(response.status) || response.status >= 500);
    }
    if (!response.body) return missingReleaseNotes(true);
    if (Number(response.headers.get('content-length')) > MAX_NOTES_BYTES) return missingReleaseNotes(false);
    reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    let result = await reader.read();
    while (!result.done) {
      size += result.value.byteLength;
      if (size > MAX_NOTES_BYTES) return missingReleaseNotes(false);
      chunks.push(result.value);
      result = await reader.read();
    }
    const release: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!isRecord(release) || release.tag_name !== location.tag
      || release.draft === true || release.prerelease === true) {
      return missingReleaseNotes(false);
    }
    const notes = normalizeReleaseNotes(release.body);
    return notes ? { notes, found: true } : missingReleaseNotes(false);
  } catch {
    // Offline, timed out, interrupted, or a proxy page instead of the API.
    return missingReleaseNotes(true);
  } finally {
    clearTimeout(timeout);
    await reader?.cancel().catch(() => undefined);
  }
}

/** The body is displayed as text; HTML from a release is never executed. */
export async function fetchReleaseNotes(
  id: UpdateComponentId,
  version: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 7000
): Promise<string> {
  return (await loadReleaseNotes(id, version, fetchImpl, timeoutMs)).notes;
}

interface CoreUpdateCandidate { version: string; notes?: string; sizeBytes?: number; }

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
  /** This process, used to tell an unfinished core update from one in progress. */
  processId?: number;
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

export interface UpdateLocalSnapshot {
  receipts: UpdateReceipt[];
  pendingFailure: PendingCoreFailure | null;
}

export class UpdateAnnouncementService {
  readonly sessionId = randomUUID();
  private readonly options: AnnouncementServiceOptions;
  private cached: { items: UpdateAnnouncement[]; errors: string[]; at: number } | null = null;
  private inFlight: { promise: Promise<void>; refresh: boolean } | null = null;
  private queuedRefresh: Promise<void> | null = null;
  private lastRefreshAt = Number.NEGATIVE_INFINITY;
  private errorStreak = 0;
  /** Invalidations that arrive while a check runs also apply to its result. */
  private invalidatedDuringCheck: Set<UpdateComponentId> | 'all' | null = null;
  private readonly releaseNotes = new Map<string, { notes: string; expiresAt: number }>();
  private readonly installedVersions = new Map<UpdateComponentId, string>();

  constructor(options: AnnouncementServiceOptions) { this.options = options; }

  noteInstalled(id: UpdateComponentId, version: string): void {
    this.installedVersions.set(id, version);
  }

  /**
   * Call after a connector rollback succeeded. The restored version counts as
   * installed, the cached candidate of the connector is dropped (a check from
   * before the rollback would offer the bad version as an ordinary update),
   * and the receipt announcing the bad version is withdrawn, so the next
   * launch does not report it as installed. The in-memory state changes even
   * when the receipt file cannot be written; that error is passed on.
   */
  async noteRolledBack(
    id: NativeConnectorId,
    badVersion: string,
    restoredVersion: string | null | undefined
  ): Promise<void> {
    if (isUpdateVersion(restoredVersion)) this.installedVersions.set(id, restoredVersion);
    else this.installedVersions.delete(id);
    this.invalidate(id);
    await this.options.store.discardReceipt(id, badVersion);
  }

  /** Receipts and an unfinished core update, read without any network access. */
  async getLocalSnapshot(): Promise<UpdateLocalSnapshot> {
    const { store, currentVersion } = this.options;
    await store.reconcileCoreVersion(currentVersion);
    const receipts = await store.list();
    const pending = await store.inspectPendingCore(currentVersion, this.options.processId ?? process.pid);
    return {
      receipts,
      pendingFailure: pending.failed
        ? { previousVersion: pending.previousVersion, targetVersion: pending.targetVersion }
        : null
    };
  }

  /** Drops the cached snapshot, or only one component's cached candidate. */
  invalidate(componentId?: UpdateComponentId): void {
    if (this.inFlight) {
      if (!componentId) this.invalidatedDuringCheck = 'all';
      else if (this.invalidatedDuringCheck !== 'all') {
        this.invalidatedDuringCheck = new Set([...(this.invalidatedDuringCheck || []), componentId]);
      }
    }
    if (!componentId) {
      this.cached = null;
    } else if (this.cached) {
      this.cached = { ...this.cached, items: this.cached.items.filter(item => item.id !== componentId) };
    }
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
    if (this.options.networkEnabled) await this.schedule(refresh);
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

  private clock(): number {
    return this.options.now?.() ?? Date.now();
  }

  private cacheTtl(): number {
    if (!this.cached?.errors.length) return ANNOUNCEMENT_TTL_MS;
    const step = Math.min(Math.max(this.errorStreak, 1), ERROR_RETRY_DELAYS_MS.length) - 1;
    return ERROR_RETRY_DELAYS_MS[step];
  }

  /** Joins, queues or starts the check this request needs, if any. */
  private schedule(refresh: boolean): Promise<void> | undefined {
    const now = this.clock();
    if (refresh) {
      if (this.inFlight?.refresh) return this.inFlight.promise;
      if (this.queuedRefresh) return this.queuedRefresh;
      // Within the minimum interval a refresh gets the cached or running result.
      if (now - this.lastRefreshAt >= MIN_REFRESH_INTERVAL_MS) {
        this.lastRefreshAt = now;
        return this.inFlight ? this.queueRefresh(this.inFlight.promise) : this.start(true);
      }
    }
    if (this.inFlight) return this.inFlight.promise;
    if (this.queuedRefresh) return this.queuedRefresh;
    if (!this.cached || now - this.cached.at >= this.cacheTtl()) return this.start(false);
    return undefined;
  }

  /** A regular check may have used the cached connector catalog, so a refresh runs after it. */
  private queueRefresh(running: Promise<void>): Promise<void> {
    const queued = running.catch(() => undefined).then(() => {
      this.queuedRefresh = null;
      return this.start(true);
    });
    this.queuedRefresh = queued;
    return queued;
  }

  private start(refresh: boolean): Promise<void> {
    this.invalidatedDuringCheck = null;
    const promise: Promise<void> = this.check(refresh).finally(() => {
      if (this.inFlight?.promise === promise) this.inFlight = null;
    });
    this.inFlight = { promise, refresh };
    return promise;
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
        canUpdate: true, manualUpdate: false,
        ...(typeof coreCandidate.sizeBytes === 'number' && Number.isFinite(coreCandidate.sizeBytes)
          && coreCandidate.sizeBytes > 0 ? { sizeBytes: coreCandidate.sizeBytes } : {}) });
    }
    // An unavailable catalog gives every connector the same error.
    const errorCounts = new Map<string, number>();
    for (const status of statuses) {
      if (status.error) errorCounts.set(status.error, (errorCounts.get(status.error) || 0) + 1);
    }
    for (const status of statuses) {
      if (status.error) {
        // A player that was never installed has nothing to update.
        if (status.installed) {
          errors.push((errorCounts.get(status.error) || 0) > 1
            ? CONNECTOR_CATALOG_UNAVAILABLE
            : `${status.name}更新检查失败，请稍后重试。`);
        }
        continue;
      }
      if (!status.installed || !status.currentVersion || !status.latestVersion
        || compareUpdateVersions(status.latestVersion, status.currentVersion) <= 0) continue;
      // A version rolled back on this computer is offered again only as a
      // manual retry, which never opens the dialog by itself; an explicit
      // update lifts the pause in the updater.
      const quarantined = status.quarantined === true;
      items.push({ id: status.id, name: `${status.name}连接器`, currentVersion: status.currentVersion,
        version: status.latestVersion, notes: '',
        notesUrl: releaseNotesLocation(status.id, status.latestVersion).notesUrl,
        canUpdate: status.compatible,
        ...(!status.compatible ? { blockedReason: `需要点歌机 ${status.minimumCoreVersion || '更高版本'} 或以上版本` } : {}),
        manualUpdate: status.manualUpdateAvailable || quarantined,
        ...(quarantined ? { quarantined: true } : {}),
        ...(status.supportedPlayerVersion ? { supportedPlayerVersion: status.supportedPlayerVersion } : {}) });
    }
    await Promise.all(items.map(async item => {
      if (!item.notes) item.notes = await this.releaseNotesFor(item);
      // The dialog always shows the notes; the cached release body stays as published.
      if (item.quarantined) item.notes = `**${QUARANTINED_CONNECTOR_NOTE}**\n\n${item.notes}`;
    }));
    const uniqueErrors = [...new Set(errors)];
    // Failures back off from 30 s to 5 min; a manual refresh restarts the sequence.
    this.errorStreak = uniqueErrors.length ? (refresh ? 1 : this.errorStreak + 1) : 0;
    const invalidated = this.invalidatedDuringCheck;
    this.invalidatedDuringCheck = null;
    this.cached = {
      items: invalidated instanceof Set ? items.filter(item => !invalidated.has(item.id)) : items,
      errors: uniqueErrors,
      at: invalidated === 'all' ? Number.NEGATIVE_INFINITY : this.clock()
    };
  }

  /** Published notes are kept for the process; fallbacks are retried after ten minutes. */
  private async releaseNotesFor(item: UpdateAnnouncement): Promise<string> {
    const { tag } = releaseNotesLocation(item.id, item.version);
    const cached = this.releaseNotes.get(tag);
    if (cached && cached.expiresAt > this.clock()) return cached.notes;
    const result = await loadReleaseNotes(item.id, item.version, this.options.fetchImpl);
    this.releaseNotes.set(tag, {
      notes: result.notes,
      expiresAt: result.found ? Number.POSITIVE_INFINITY : this.clock() + RELEASE_NOTES_RETRY_MS
    });
    return result.notes;
  }
}
