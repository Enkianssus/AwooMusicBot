import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { downloadBufferWithRanges } from './connector-download.ts';
import { extractZipSafely } from './safe-zip.ts';

export type DotnetRuntimeRid = 'win-x86' | 'win-x64';

export type PrivateDotnetFetch = (
  input: string,
  init?: RequestInit
) => Promise<Response>;

export interface DotnetRuntimeArtifact {
  channel: string;
  version: string;
  rid: DotnetRuntimeRid;
  url: string;
  sha512: string;
  name: string;
}

interface RuntimeReleaseFile {
  name?: unknown;
  rid?: unknown;
  url?: unknown;
  hash?: unknown;
  sha512?: unknown;
}

interface RuntimeRelease {
  'release-version'?: unknown;
  runtime?: {
    version?: unknown;
    files?: unknown;
  };
}

interface RuntimeMarker {
  schemaVersion: 1;
  channel: string;
  rid: DotnetRuntimeRid;
  version: string;
  sha512: string;
}

interface RuntimeDownloadSize {
  size: number;
}

const DOTNET_RUNTIME_HOSTS = new Set([
  'builds.dotnet.microsoft.com',
  'download.visualstudio.microsoft.com'
]);
const RUNTIME_VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/;
const CHANNEL_PATTERN = /^(\d+)\.(\d+)$/;
const MARKER_NAME = '.awoo-dotnet-runtime.json';
const DEFAULT_CHANNEL = '8.0';
const MIN_RUNTIME_ARCHIVE_SIZE = 1024 * 1024;

/**
 * Select and validate the runtime archive advertised by the official
 * release-metadata document.
 *
 * The .NET metadata format places `latest-runtime` at the channel root and
 * stores the matching archive in the release's `runtime.files` array. A
 * small fallback for a top-level `runtime` object is retained because this
 * makes the selector useful with reduced metadata fixtures as well.
 */
export function selectDotnetRuntimeArtifact(
  metadata: unknown,
  rid: DotnetRuntimeRid,
  channel = DEFAULT_CHANNEL
): DotnetRuntimeArtifact {
  assertRid(rid);
  assertChannel(channel);
  if (!isRecord(metadata)) {
    throw new Error(' .NET Runtime 发布元数据无效');
  }

  const metadataChannel = metadata['channel-version'];
  if (metadataChannel !== undefined && metadataChannel !== channel) {
    throw new Error(`.NET Runtime 频道不匹配：${String(metadataChannel)}`);
  }

  const latestRuntimeVersion = readLatestRuntimeVersion(metadata);
  if (!latestRuntimeVersion || !isRuntimeVersionForChannel(latestRuntimeVersion, channel)) {
    throw new Error(`.NET Runtime 最新版本无效：${String(latestRuntimeVersion || '')}`);
  }

  let runtime: {
    version?: unknown;
    files?: unknown;
  } | undefined;
  const releases = metadata.releases;
  if (Array.isArray(releases)) {
    const release = releases.find(item => (
      isRecord(item)
      && item['release-version'] === latestRuntimeVersion
    )) as RuntimeRelease | undefined;
    if (release?.runtime) runtime = release.runtime;
  }
  if (!runtime && isRecord(metadata.runtime)) {
    runtime = metadata.runtime;
  }
  if (!runtime || runtime.version !== latestRuntimeVersion) {
    throw new Error('.NET Runtime 最新版本缺少匹配的 runtime 信息');
  }

  const files = runtime.files;
  if (!Array.isArray(files)) {
    throw new Error('.NET Runtime 发布包列表无效');
  }
  const file = files.find(item => (
    isRecord(item)
    && item.rid === rid
    && typeof item.name === 'string'
    && item.name.toLowerCase().endsWith('.zip')
  )) as RuntimeReleaseFile | undefined;
  if (!file) {
    throw new Error(`.NET Runtime 未找到 ${rid} 发布包`);
  }

  const name = readString(file.name, '发布包名称');
  const url = validateRuntimeUrl(file.url);
  const sha512 = validateSha512(file.hash ?? file.sha512);
  if (file.rid !== rid) {
    throw new Error(`.NET Runtime RID 不匹配：${String(file.rid)}`);
  }
  if (!name.toLowerCase().endsWith('.zip')) {
    throw new Error('.NET Runtime 发布包必须为 zip');
  }

  return {
    channel,
    version: latestRuntimeVersion,
    rid,
    url,
    sha512,
    name
  };
}

/**
 * Build the environment used when launching a framework-dependent connector.
 * Keeping multilevel lookup disabled prevents the connector from silently
 * consuming a machine-wide .NET installation.
 */
export function buildPrivateDotnetEnvironment(
  rid: DotnetRuntimeRid,
  root: string
): Record<string, string> {
  assertRid(rid);
  const resolvedRoot = path.resolve(root);
  const environment: Record<string, string> = {
    DOTNET_ROOT: resolvedRoot,
    DOTNET_MULTILEVEL_LOOKUP: '0'
  };
  if (rid === 'win-x86') {
    environment.DOTNET_ROOT_X86 = resolvedRoot;
  } else {
    environment.DOTNET_ROOT_X64 = resolvedRoot;
  }
  return environment;
}

export interface PrivateDotnetRuntimeOptions {
  rootDirectory: string;
  fetchImpl?: PrivateDotnetFetch;
  onLog?: (message: string) => void;
}

export function readDotnetDownloadSize(
  status: number,
  headers: Headers
): number | null {
  const ranged = parseContentRange(headers.get('content-range'));
  if (ranged) return ranged.total;
  return status === 200
    ? parseContentLength(headers.get('content-length'))
    : null;
}

export class PrivateDotnetRuntimeManager {
  private readonly inFlight = new Map<string, Promise<string>>();
  private readonly rootDirectory: string;
  private readonly fetchImpl: PrivateDotnetFetch;
  private readonly onLog: (message: string) => void;

  constructor(options: PrivateDotnetRuntimeOptions) {
    this.rootDirectory = options.rootDirectory;
    this.fetchImpl = options.fetchImpl || fetch;
    this.onLog = options.onLog || (() => undefined);
  }

  ensure(
    runtimeRid: DotnetRuntimeRid,
    channel = DEFAULT_CHANNEL
  ): Promise<string> {
    assertRid(runtimeRid);
    assertChannel(channel);
    const key = `${runtimeRid}:${channel}`;
    const existing = this.inFlight.get(key);
    if (existing) return existing;

    const promise = this.ensureInternal(runtimeRid, channel);
    this.inFlight.set(key, promise);
    const clearInFlight = () => {
      if (this.inFlight.get(key) === promise) this.inFlight.delete(key);
    };
    void promise.then(clearInFlight, clearInFlight);
    return promise;
  }

  private async ensureInternal(
    runtimeRid: DotnetRuntimeRid,
    channel: string
  ): Promise<string> {
    const ridRoot = path.resolve(this.rootDirectory, runtimeRid);
    await fs.promises.mkdir(ridRoot, { recursive: true });

    const cached = await findVerifiedRuntime(ridRoot, runtimeRid, channel);
    if (cached) {
      this.onLog(`[.NET Runtime] 复用 ${runtimeRid}/${path.basename(cached)}`);
      return cached;
    }

    const metadataUrl =
      `https://builds.dotnet.microsoft.com/dotnet/release-metadata/${channel}/releases.json`;
    const metadataResponse = await this.fetchWithRetry(metadataUrl, {
      method: 'GET',
      cache: 'no-store'
    }, '.NET Runtime 元数据');
    const metadata = await metadataResponse.json() as unknown;
    const artifact = selectDotnetRuntimeArtifact(metadata, runtimeRid, channel);
    const downloadSize = await this.resolveDownloadSize(artifact.url);
    const archive = await downloadBufferWithRanges({
      url: artifact.url,
      expectedSize: downloadSize.size,
      fetchImpl: this.fetchImpl,
      onProgress: progress => {
        this.onLog(
          `[.NET Runtime] ${runtimeRid} 下载进度 ${progress.percent}% `
          + `(${progress.received}/${progress.total})`
        );
      }
    });
    if (archive.length !== downloadSize.size) {
      throw new Error(`.NET Runtime 文件大小不匹配：${archive.length}/${downloadSize.size}`);
    }
    verifySha512(archive, artifact.sha512);

    const nonce = crypto.randomBytes(8).toString('hex');
    const archivePath = path.join(
      ridRoot,
      `.download-${channel}-${nonce}.zip`
    );
    const stagingDirectory = path.join(
      ridRoot,
      `.staging-${channel}-${nonce}`
    );
    const versionDirectory = path.join(ridRoot, artifact.version);
    try {
      await fs.promises.writeFile(archivePath, archive, { flag: 'wx' });
      await extractZipSafely(archivePath, stagingDirectory);
      await verifyRuntimeDirectory(stagingDirectory, artifact.version);
      const marker: RuntimeMarker = {
        schemaVersion: 1,
        channel,
        rid: runtimeRid,
        version: artifact.version,
        sha512: artifact.sha512
      };
      await fs.promises.writeFile(
        path.join(stagingDirectory, MARKER_NAME),
        JSON.stringify(marker, null, 2),
        'utf8'
      );

      if (await isDirectory(versionDirectory)) {
        const existing = await verifyExistingRuntime(
          versionDirectory,
          runtimeRid,
          channel,
          artifact.version
        );
        if (existing) return existing;
        await removePath(versionDirectory);
      }
      await fs.promises.rename(stagingDirectory, versionDirectory);
      return versionDirectory;
    } finally {
      await removePath(archivePath);
      await removePath(stagingDirectory);
    }
  }

  private async resolveDownloadSize(url: string): Promise<RuntimeDownloadSize> {
    try {
      const head = await this.fetchImpl(url, {
        method: 'HEAD',
        cache: 'no-store'
      });
      if (head.ok) {
        const responseSize = readDotnetDownloadSize(
          head.status,
          head.headers
        );
        if (responseSize && responseSize >= MIN_RUNTIME_ARCHIVE_SIZE) {
          return { size: responseSize };
        }
      }
    } catch {
      // Some CDNs reject HEAD; the one-byte range probe below is equivalent.
    }

    const rangeResponse = await this.fetchWithRetry(url, {
      method: 'GET',
      cache: 'no-store',
      headers: { Range: 'bytes=0-0' }
    }, '.NET Runtime 文件大小探测');
    if (rangeResponse.status !== 206) {
      throw new Error(`.NET Runtime 无法获取文件大小：HTTP ${rangeResponse.status}`);
    }
    const contentRange = parseContentRange(
      rangeResponse.headers.get('content-range')
    );
    if (!contentRange || contentRange.start !== 0) {
      throw new Error(
        `.NET Runtime Content-Range 无效：${rangeResponse.headers.get('content-range') || '缺失'}`
      );
    }
    return { size: contentRange.total };
  }

  private async fetchWithRetry(
    url: string,
    init: RequestInit,
    label: string
  ): Promise<Response> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const response = await this.fetchImpl(url, init);
        if (response.ok) return response;
        lastError = new Error(`HTTP ${response.status}`);
      } catch (error: unknown) {
        lastError = error;
      }
      if (attempt < 3) {
        await new Promise(resolve => setTimeout(resolve, attempt * 500));
      }
    }
    const message = lastError instanceof Error
      ? lastError.message
      : String(lastError);
    throw new Error(`${label}失败：${message}`);
  }
}

function readLatestRuntimeVersion(metadata: Record<string, unknown>): string | null {
  const latest = metadata['latest-runtime'];
  if (typeof latest === 'string') return latest;
  if (isRecord(latest) && typeof latest.version === 'string') {
    return latest.version;
  }
  return null;
}

function validateRuntimeUrl(value: unknown): string {
  if (typeof value !== 'string' || !value) {
    throw new Error('.NET Runtime 发布包 URL 无效');
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('.NET Runtime 发布包 URL 无效');
  }
  if (
    parsed.protocol !== 'https:'
    || parsed.port
    || !DOTNET_RUNTIME_HOSTS.has(parsed.hostname.toLowerCase())
  ) {
    throw new Error(`.NET Runtime 发布包 URL 主机不受信任：${parsed.hostname}`);
  }
  if (!parsed.pathname.toLowerCase().endsWith('.zip')) {
    throw new Error('.NET Runtime 发布包 URL 必须指向 zip');
  }
  return value;
}

function validateSha512(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{128}$/i.test(value)) {
    throw new Error('.NET Runtime SHA-512 校验值无效');
  }
  return value.toLowerCase();
}

function verifySha512(archive: Buffer, expected: string): void {
  const actual = crypto.createHash('sha512').update(archive).digest();
  const expectedBuffer = Buffer.from(expected, 'hex');
  if (
    actual.length !== expectedBuffer.length
    || !crypto.timingSafeEqual(actual, expectedBuffer)
  ) {
    throw new Error('.NET Runtime SHA-512 校验失败');
  }
}

async function findVerifiedRuntime(
  ridRoot: string,
  rid: DotnetRuntimeRid,
  channel: string
): Promise<string | null> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(ridRoot, { withFileTypes: true });
  } catch {
    return null;
  }
  const candidates = entries
    .filter(entry => entry.isDirectory() && RUNTIME_VERSION_PATTERN.test(entry.name))
    .sort((a, b) => compareRuntimeVersions(b.name, a.name));
  for (const candidate of candidates) {
    const directory = path.join(ridRoot, candidate.name);
    if (await verifyExistingRuntime(directory, rid, channel, candidate.name)) {
      return directory;
    }
  }
  return null;
}

async function verifyExistingRuntime(
  directory: string,
  rid: DotnetRuntimeRid,
  channel: string,
  version: string
): Promise<string | null> {
  try {
    const marker = JSON.parse(
      await fs.promises.readFile(path.join(directory, MARKER_NAME), 'utf8')
    ) as Partial<RuntimeMarker>;
    if (
      marker.schemaVersion !== 1
      || marker.channel !== channel
      || marker.rid !== rid
      || marker.version !== version
      || !/^[a-f0-9]{128}$/i.test(String(marker.sha512 || ''))
    ) {
      return null;
    }
    await verifyRuntimeDirectory(directory, version);
    return directory;
  } catch {
    return null;
  }
}

async function verifyRuntimeDirectory(
  directory: string,
  version: string
): Promise<void> {
  if (!RUNTIME_VERSION_PATTERN.test(version)) {
    throw new Error(`.NET Runtime 版本无效：${version}`);
  }
  const dotnetExecutable = path.join(directory, 'dotnet.exe');
  const coreclr = path.join(
    directory,
    'shared',
    'Microsoft.NETCore.App',
    version,
    'coreclr.dll'
  );
  if (!await isFile(dotnetExecutable)) {
    throw new Error('私有 .NET Runtime 缺少 dotnet.exe');
  }
  if (!await isFile(coreclr)) {
    throw new Error(`私有 .NET Runtime 缺少 coreclr.dll（${version}）`);
  }
}

function parseContentLength(value: string | null): number | null {
  if (!value || !/^\d+$/.test(value.trim())) return null;
  const size = Number(value);
  return Number.isSafeInteger(size) && size > 0 ? size : null;
}

function parseContentRange(value: string | null): {
  start: number;
  end: number;
  total: number;
} | null {
  const match = String(value || '').match(/^bytes\s+(\d+)-(\d+)\/(\d+)$/i);
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = Number(match[3]);
  if (
    !Number.isSafeInteger(start)
    || !Number.isSafeInteger(end)
    || !Number.isSafeInteger(total)
    || total <= 0
  ) {
    return null;
  }
  return { start, end, total };
}

function assertRid(value: string): asserts value is DotnetRuntimeRid {
  if (value !== 'win-x86' && value !== 'win-x64') {
    throw new Error(`不支持的 .NET Runtime RID：${value}`);
  }
}

function assertChannel(value: string): void {
  if (!CHANNEL_PATTERN.test(value)) {
    throw new Error(`不支持的 .NET Runtime 频道：${value}`);
  }
}

function isRuntimeVersionForChannel(version: string, channel: string): boolean {
  const match = version.match(RUNTIME_VERSION_PATTERN);
  return Boolean(match && `${match[1]}.${match[2]}` === channel);
}

function compareRuntimeVersions(left: string, right: string): number {
  const leftParts = left.split('.').map(Number);
  const rightParts = right.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) {
      return leftParts[index] - rightParts[index];
    }
  }
  return 0;
}

function readString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`.NET Runtime ${label}无效`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function isFile(filePath: string): Promise<boolean> {
  try {
    return (await fs.promises.stat(filePath)).isFile();
  } catch {
    return false;
  }
}

async function isDirectory(directory: string): Promise<boolean> {
  try {
    return (await fs.promises.stat(directory)).isDirectory();
  } catch {
    return false;
  }
}

async function removePath(target: string): Promise<void> {
  try {
    await fs.promises.rm(target, { recursive: true, force: true });
  } catch {
    // Cleanup is best effort; the primary install error is more useful to the
    // caller than a failed removal of an already-gone staging path.
  }
}
