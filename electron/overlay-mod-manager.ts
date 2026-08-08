import { createHash, randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import extract from 'extract-zip';

export const OVERLAY_PACKAGE_SCHEMA_VERSION = 1;
export const OFFICIAL_OVERLAY_REPOSITORY =
  'https://github.com/Enkianssus/AwooMusicBot-Overlay-Default';
export const OFFICIAL_OVERLAY_DESCRIPTOR_PROXY =
  'https://app.enkianss.us/mods/v1/official/manifest.json';
export const MAX_OVERLAY_ARCHIVE_BYTES = 20 * 1024 * 1024;
const SKIN_MARKETPLACE_DOWNLOAD_TIMEOUT_MS = 60_000;
export const MAX_OVERLAY_EXTRACTED_BYTES = 64 * 1024 * 1024;
export const MAX_OVERLAY_FILES = 300;
export const MAX_OVERLAY_SETTINGS = 32;

const OVERLAY_ID_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const OVERLAY_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const OVERLAY_SETTING_KEY_PATTERN = /^[a-z][A-Za-z0-9]*(?:[._-][A-Za-z0-9]+)*$/;
const OVERLAY_CSS_VARIABLE_PATTERN = /^--[a-z][a-z0-9-]*$/;
const OVERLAY_CSS_UNIT_PATTERN = /^(?:px|rem|em|%|deg|s|ms|vh|vw)?$/;
const ALLOWED_FILE_EXTENSIONS = new Set([
  '.css',
  '.gif',
  '.htm',
  '.html',
  '.ico',
  '.jpeg',
  '.jpg',
  '.js',
  '.json',
  '.map',
  '.mjs',
  '.otf',
  '.png',
  '.svg',
  '.ttf',
  '.txt',
  '.webp',
  '.woff',
  '.woff2'
]);

export const BUILTIN_OVERLAY_SETTINGS: OverlaySettingDefinition[] = [
  {
    key: 'accentColor',
    label: '强调色',
    description: '标题、标签和高亮元素使用的颜色。',
    group: '颜色',
    type: 'color',
    default: '#c6a3ff',
    cssVariable: '--accent',
    cssUnit: ''
  },
  {
    key: 'textColor',
    label: '主要文字颜色',
    description: '歌曲名称等主要文字使用的颜色。',
    group: '颜色',
    type: 'color',
    default: '#f8f8ff',
    cssVariable: '--text',
    cssUnit: ''
  },
  {
    key: 'panelOpacity',
    label: '面板不透明度',
    description: '调整卡片背景的透明程度。',
    group: '外观',
    type: 'range',
    default: 0.94,
    cssVariable: '--panel-opacity',
    cssUnit: '',
    min: 0.2,
    max: 1,
    step: 0.02
  },
  {
    key: 'scale',
    label: '整体缩放',
    description: '缩放整个组件，不改变 OBS 浏览器源尺寸。',
    group: '布局',
    type: 'range',
    default: 1,
    cssVariable: '--widget-scale',
    cssUnit: '',
    min: 0.65,
    max: 1.5,
    step: 0.05
  },
  {
    key: 'maxQueue',
    label: '最多显示歌曲',
    description: '控制待播队列中最多显示多少首歌曲。',
    group: '布局',
    type: 'range',
    default: 3,
    cssVariable: '--awoo-max-queue',
    cssUnit: '',
    min: 1,
    max: 10,
    step: 1
  },
  {
    key: 'coverRotation',
    label: '专辑封面旋转',
    description: '播放歌曲时让专辑封面像唱片一样缓慢旋转。',
    group: '专辑封面',
    type: 'toggle',
    default: false,
    cssVariable: '--awoo-cover-rotation',
    cssUnit: ''
  },
  {
    key: 'coverRotationSpeed',
    label: '封面旋转一圈',
    description: '数值越大，专辑封面旋转得越慢。',
    group: '专辑封面',
    type: 'range',
    default: 18,
    cssVariable: '--cover-spin-duration',
    cssUnit: 's',
    min: 4,
    max: 60,
    step: 1
  }
];

export type OverlaySettingValue = string | number | boolean;

export interface OverlaySettingOption {
  label: string;
  value: string;
}

export interface OverlaySettingDefinition {
  key: string;
  label: string;
  description: string;
  group: string;
  type: 'color' | 'range' | 'toggle' | 'select' | 'text';
  default: OverlaySettingValue;
  cssVariable: string;
  cssUnit: string;
  min?: number;
  max?: number;
  step?: number;
  maxLength?: number;
  placeholder?: string;
  options?: OverlaySettingOption[];
}

export type OverlaySettingValues = Record<string, OverlaySettingValue>;

export interface OverlayPackageManifest {
  schemaVersion: 1;
  id: string;
  name: string;
  version: string;
  entry: string;
  author: string;
  description: string;
  homepage: string;
  minAppVersion: string;
  settings: OverlaySettingDefinition[];
}

export interface OverlayReleaseDescriptor {
  schemaVersion: 1;
  packageType: 'awoo-overlay';
  id: string;
  name: string;
  version: string;
  package: {
    url: string;
    size: number;
    sha256: string;
  };
}

interface InstalledOverlayRecord extends OverlayPackageManifest {
  installedAt: string;
  source: string;
}

interface OverlayRegistry {
  schemaVersion: 1;
  activeId: string;
  overlays: InstalledOverlayRecord[];
  settings: Record<string, OverlaySettingValues>;
}

export interface PublicOverlayRecord extends InstalledOverlayRecord {
  active: boolean;
  builtin: boolean;
  values: OverlaySettingValues;
}

export interface PublicOverlayState {
  schemaVersion: 1;
  activeId: string;
  active: PublicOverlayRecord;
  overlays: PublicOverlayRecord[];
  officialRepository: string;
  officialDescriptorProxy: string;
  limits: {
    archiveBytes: number;
    extractedBytes: number;
    files: number;
  };
}

export interface OverlayAsset {
  filePath: string;
  contentType: string;
  revision: string;
}

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
  timeoutMs?: number
) => Promise<Response>;

function cleanText(value: unknown, maximumLength: number): string {
  return typeof value === 'string'
    ? value.trim().slice(0, maximumLength)
    : '';
}

function defaultCssVariable(key: string): string {
  return `--awoo-${key.replace(/[._]/g, '-').replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()}`;
}

export function validateOverlaySettingDefinitions(
  value: unknown
): OverlaySettingDefinition[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error('Mod UI settings 必须是数组');
  }
  if (value.length > MAX_OVERLAY_SETTINGS) {
    throw new Error(`Mod UI 可调参数不能超过 ${MAX_OVERLAY_SETTINGS} 个`);
  }
  const keys = new Set<string>();
  return value.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`Mod UI 第 ${index + 1} 个参数定义无效`);
    }
    const raw = item as Record<string, unknown>;
    const key = cleanText(raw.key, 60);
    const label = cleanText(raw.label, 80);
    const type = cleanText(raw.type, 20) as OverlaySettingDefinition['type'];
    const cssVariable = cleanText(raw.cssVariable, 64) || defaultCssVariable(key);
    const cssUnit = cleanText(raw.cssUnit, 8).toLowerCase();
    if (!OVERLAY_SETTING_KEY_PATTERN.test(key)) {
      throw new Error(`Mod UI 参数 key 无效：${key || index + 1}`);
    }
    if (keys.has(key)) throw new Error(`Mod UI 参数 key 重复：${key}`);
    keys.add(key);
    if (!label) throw new Error(`Mod UI 参数 ${key} 缺少名称`);
    if (!['color', 'range', 'toggle', 'select', 'text'].includes(type)) {
      throw new Error(`Mod UI 参数 ${key} 的类型不受支持`);
    }
    if (!OVERLAY_CSS_VARIABLE_PATTERN.test(cssVariable)) {
      throw new Error(`Mod UI 参数 ${key} 的 CSS 变量名无效`);
    }
    if (!OVERLAY_CSS_UNIT_PATTERN.test(cssUnit)) {
      throw new Error(`Mod UI 参数 ${key} 的 CSS 单位不受支持`);
    }

    const base = {
      key,
      label,
      description: cleanText(raw.description, 240),
      group: cleanText(raw.group, 60) || '常规',
      type,
      cssVariable,
      cssUnit
    };
    if (type === 'color') {
      const defaultValue = cleanText(raw.default, 16).toLowerCase();
      if (!/^#[0-9a-f]{6}$/.test(defaultValue)) {
        throw new Error(`Mod UI 颜色参数 ${key} 的默认值必须是 #RRGGBB`);
      }
      return { ...base, type, default: defaultValue };
    }
    if (type === 'toggle') {
      if (typeof raw.default !== 'boolean') {
        throw new Error(`Mod UI 开关参数 ${key} 的默认值必须是布尔值`);
      }
      return { ...base, type, default: raw.default };
    }
    if (type === 'range') {
      const minimum = Number(raw.min);
      const maximum = Number(raw.max);
      const step = Number(raw.step);
      const defaultValue = Number(raw.default);
      if (
        !Number.isFinite(minimum)
        || !Number.isFinite(maximum)
        || !Number.isFinite(step)
        || !Number.isFinite(defaultValue)
        || maximum <= minimum
        || step <= 0
        || defaultValue < minimum
        || defaultValue > maximum
      ) {
        throw new Error(`Mod UI 滑杆参数 ${key} 的范围或默认值无效`);
      }
      return {
        ...base,
        type,
        default: defaultValue,
        min: minimum,
        max: maximum,
        step
      };
    }
    if (type === 'select') {
      if (!Array.isArray(raw.options) || raw.options.length < 1 || raw.options.length > 30) {
        throw new Error(`Mod UI 选项参数 ${key} 需要 1 至 30 个选项`);
      }
      const optionValues = new Set<string>();
      const options = raw.options.map((option, optionIndex) => {
        if (!option || typeof option !== 'object' || Array.isArray(option)) {
          throw new Error(`Mod UI 参数 ${key} 的第 ${optionIndex + 1} 个选项无效`);
        }
        const optionRaw = option as Record<string, unknown>;
        const optionLabel = cleanText(optionRaw.label, 80);
        const optionValue = cleanText(optionRaw.value, 80);
        if (!optionLabel || !optionValue || optionValues.has(optionValue)) {
          throw new Error(`Mod UI 参数 ${key} 包含空白或重复选项`);
        }
        optionValues.add(optionValue);
        return { label: optionLabel, value: optionValue };
      });
      const defaultValue = cleanText(raw.default, 80);
      if (!optionValues.has(defaultValue)) {
        throw new Error(`Mod UI 选项参数 ${key} 的默认值不在选项中`);
      }
      return { ...base, type, default: defaultValue, options };
    }

    const maxLength = Math.min(200, Math.max(1, Number.parseInt(String(raw.maxLength || 80), 10) || 80));
    const defaultValue = typeof raw.default === 'string'
      ? raw.default.slice(0, maxLength)
      : '';
    return {
      ...base,
      type: 'text',
      default: defaultValue,
      maxLength,
      placeholder: cleanText(raw.placeholder, 120)
    };
  });
}

export function normalizeOverlaySettingValues(
  definitions: OverlaySettingDefinition[],
  value: unknown,
  strict = false
): OverlaySettingValues {
  const raw = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const definitionsByKey = new Map(definitions.map(definition => [definition.key, definition]));
  if (strict) {
    for (const key of Object.keys(raw)) {
      if (!definitionsByKey.has(key)) {
        throw new Error(`Mod UI 不支持参数：${key}`);
      }
    }
  }
  const normalized: OverlaySettingValues = {};
  for (const definition of definitions) {
    const candidate = Object.prototype.hasOwnProperty.call(raw, definition.key)
      ? raw[definition.key]
      : definition.default;
    let valid = false;
    let nextValue: OverlaySettingValue = definition.default;
    if (definition.type === 'color') {
      valid = typeof candidate === 'string' && /^#[0-9a-fA-F]{6}$/.test(candidate);
      if (valid) nextValue = String(candidate).toLowerCase();
    } else if (definition.type === 'toggle') {
      valid = typeof candidate === 'boolean';
      if (valid) nextValue = candidate as boolean;
    } else if (definition.type === 'range') {
      const numeric = typeof candidate === 'number' ? candidate : Number.NaN;
      valid = Number.isFinite(numeric)
        && numeric >= Number(definition.min)
        && numeric <= Number(definition.max);
      if (valid) nextValue = numeric;
    } else if (definition.type === 'select') {
      valid = typeof candidate === 'string'
        && Boolean(definition.options?.some(option => option.value === candidate));
      if (valid) nextValue = candidate as string;
    } else {
      valid = typeof candidate === 'string' && candidate.length <= (definition.maxLength || 80);
      if (valid) nextValue = candidate as string;
    }
    if (!valid && strict) {
      throw new Error(`Mod UI 参数 ${definition.label} 的值无效`);
    }
    normalized[definition.key] = nextValue;
  }
  return normalized;
}

function isSafeRelativePath(value: string): boolean {
  if (!value || value.includes('\0') || value.includes('\\')) return false;
  if (value.startsWith('/') || /^[A-Za-z]:/.test(value)) return false;
  const parts = value.split('/');
  return parts.every(part => Boolean(part) && part !== '.' && part !== '..');
}

function compareVersions(left: string, right: string): number {
  const parse = (value: string) => value
    .split(/[+-]/, 1)[0]
    .split('.')
    .map(part => Number.parseInt(part, 10) || 0);
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] || 0) - (b[index] || 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

export function validateOverlayManifest(
  value: unknown,
  currentAppVersion: string
): OverlayPackageManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('overlay.json 必须是 JSON 对象');
  }
  const raw = value as Record<string, unknown>;
  const id = cleanText(raw.id, 80).toLowerCase();
  const name = cleanText(raw.name, 80);
  const version = cleanText(raw.version, 40);
  const entry = cleanText(raw.entry, 180);
  const minAppVersion = cleanText(raw.minAppVersion, 40) || '1.1.5';
  if (raw.schemaVersion !== OVERLAY_PACKAGE_SCHEMA_VERSION) {
    throw new Error('Mod UI 清单版本不受支持');
  }
  if (!OVERLAY_ID_PATTERN.test(id)) {
    throw new Error('Mod UI id 只能使用小写字母、数字、点、横线和下划线');
  }
  if (!name) throw new Error('Mod UI 缺少名称');
  if (!OVERLAY_VERSION_PATTERN.test(version)) {
    throw new Error('Mod UI 版本必须使用语义化版本号');
  }
  if (!OVERLAY_VERSION_PATTERN.test(minAppVersion)) {
    throw new Error('Mod UI 的 minAppVersion 无效');
  }
  if (compareVersions(currentAppVersion, minAppVersion) < 0) {
    throw new Error(`此 Mod UI 需要嗷呜点歌机 ${minAppVersion} 或更高版本`);
  }
  if (!isSafeRelativePath(entry) || !/\.html?$/i.test(entry)) {
    throw new Error('Mod UI 入口必须是包内的 HTML 文件');
  }
  return {
    schemaVersion: 1,
    id,
    name,
    version,
    entry,
    author: cleanText(raw.author, 80) || '未知作者',
    description: cleanText(raw.description, 300),
    homepage: cleanText(raw.homepage, 300),
    minAppVersion,
    settings: validateOverlaySettingDefinitions(raw.settings)
  };
}

export function validateOverlayDescriptor(
  value: unknown
): OverlayReleaseDescriptor {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Mod UI 发布清单必须是 JSON 对象');
  }
  const raw = value as Record<string, unknown>;
  const packageValue = raw.package;
  if (
    raw.schemaVersion !== OVERLAY_PACKAGE_SCHEMA_VERSION
    || raw.packageType !== 'awoo-overlay'
    || !packageValue
    || typeof packageValue !== 'object'
    || Array.isArray(packageValue)
  ) {
    throw new Error('Mod UI 发布清单格式不兼容');
  }
  const id = cleanText(raw.id, 80).toLowerCase();
  const name = cleanText(raw.name, 80);
  const version = cleanText(raw.version, 40);
  const packageRecord = packageValue as Record<string, unknown>;
  const packageUrl = cleanText(packageRecord.url, 600);
  const size = Number(packageRecord.size);
  const sha256 = cleanText(packageRecord.sha256, 64).toLowerCase();
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(packageUrl);
  } catch {
    throw new Error('Mod UI 下载地址无效');
  }
  if (
    !OVERLAY_ID_PATTERN.test(id)
    || !name
    || !OVERLAY_VERSION_PATTERN.test(version)
    || parsedUrl.protocol !== 'https:'
    || !Number.isSafeInteger(size)
    || size <= 0
    || size > MAX_OVERLAY_ARCHIVE_BYTES
    || !/^[a-f0-9]{64}$/.test(sha256)
  ) {
    throw new Error('Mod UI 发布清单字段无效');
  }
  return {
    schemaVersion: 1,
    packageType: 'awoo-overlay',
    id,
    name,
    version,
    package: { url: parsedUrl.toString(), size, sha256 }
  };
}

export function resolveOverlayDescriptorUrl(input: string): string {
  const trimmed = input.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error('请输入完整的 HTTPS GitHub 仓库或发布清单网址');
  }
  if (url.protocol !== 'https:') {
    throw new Error('Mod UI 只允许通过 HTTPS 安装');
  }
  const githubMatch = url.toString().match(
    /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i
  );
  if (githubMatch) {
    const repository = `${githubMatch[1]}/${githubMatch[2]}`;
    if (repository.toLowerCase() === 'enkianssus/awoomusicbot-overlay-default') {
      return OFFICIAL_OVERLAY_DESCRIPTOR_PROXY;
    }
    return `https://github.com/${repository}/releases/latest/download/awoo-overlay.json`;
  }
  return url.toString();
}

function contentTypeFor(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case '.html':
    case '.htm': return 'text/html; charset=utf-8';
    case '.css': return 'text/css; charset=utf-8';
    case '.js':
    case '.mjs': return 'text/javascript; charset=utf-8';
    case '.json':
    case '.map': return 'application/json; charset=utf-8';
    case '.svg': return 'image/svg+xml';
    case '.png': return 'image/png';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.gif': return 'image/gif';
    case '.webp': return 'image/webp';
    case '.ico': return 'image/x-icon';
    case '.woff': return 'font/woff';
    case '.woff2': return 'font/woff2';
    case '.ttf': return 'font/ttf';
    case '.otf': return 'font/otf';
    default: return 'application/octet-stream';
  }
}

async function readLimitedResponse(
  response: Response,
  maximumBytes: number
): Promise<Buffer> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw new Error(`下载文件超过 ${Math.round(maximumBytes / 1024 / 1024)} MiB 限制`);
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let result = await reader.read();
  while (!result.done) {
    total += result.value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel();
      throw new Error(`下载文件超过 ${Math.round(maximumBytes / 1024 / 1024)} MiB 限制`);
    }
    chunks.push(result.value);
    result = await reader.read();
  }
  return Buffer.concat(chunks.map(chunk => Buffer.from(chunk)), total);
}

export class OverlayModManager {
  private readonly registryPath: string;
  private readonly rootDirectory: string;
  private readonly bundledOverlayDirectory: string;
  private readonly currentAppVersion: string;
  private readonly fetcher: FetchLike;

  constructor(
    rootDirectory: string,
    bundledOverlayDirectory: string,
    currentAppVersion: string,
    fetcher: FetchLike = fetch
  ) {
    this.rootDirectory = rootDirectory;
    this.bundledOverlayDirectory = bundledOverlayDirectory;
    this.currentAppVersion = currentAppVersion;
    this.fetcher = fetcher;
    this.registryPath = path.join(rootDirectory, 'registry.json');
  }

  async getPublicState(): Promise<PublicOverlayState> {
    const registry = await this.readRegistry();
    const builtin = this.getBuiltinRecord(
      registry.activeId === 'builtin',
      registry.settings.builtin
    );
    const installed = registry.overlays.map(record => ({
      ...record,
      active: registry.activeId === record.id,
      builtin: false,
      settings: Array.isArray(record.settings) ? record.settings : [],
      values: normalizeOverlaySettingValues(
        Array.isArray(record.settings) ? record.settings : [],
        registry.settings[record.id]
      )
    }));
    const overlays = [builtin, ...installed];
    const active = overlays.find(record => record.active) || builtin;
    return {
      schemaVersion: 1,
      activeId: active.id,
      active,
      overlays,
      officialRepository: OFFICIAL_OVERLAY_REPOSITORY,
      officialDescriptorProxy: OFFICIAL_OVERLAY_DESCRIPTOR_PROXY,
      limits: {
        archiveBytes: MAX_OVERLAY_ARCHIVE_BYTES,
        extractedBytes: MAX_OVERLAY_EXTRACTED_BYTES,
        files: MAX_OVERLAY_FILES
      }
    };
  }

  async installFromUrl(input: string): Promise<PublicOverlayState> {
    const descriptorUrl = resolveOverlayDescriptorUrl(input);
    const descriptorResponse = await this.fetcher(descriptorUrl, {
      method: 'GET',
      cache: 'no-store',
      headers: {
        Accept: 'application/json',
        'User-Agent': 'AwooMusicBot-OverlayInstaller/1.0'
      }
    });
    if (!descriptorResponse.ok) {
      throw new Error(`读取 Mod UI 发布清单失败：HTTP ${descriptorResponse.status}`);
    }
    const descriptorBytes = await readLimitedResponse(
      descriptorResponse,
      256 * 1024
    );
    const descriptor = validateOverlayDescriptor(
      JSON.parse(descriptorBytes.toString('utf8'))
    );
    const packageResponse = await this.fetcher(descriptor.package.url, {
      method: 'GET',
      cache: 'no-store',
      headers: {
        Accept: 'application/zip, application/octet-stream',
        'User-Agent': 'AwooMusicBot-OverlayInstaller/1.0'
      }
    });
    if (!packageResponse.ok) {
      throw new Error(`下载 Mod UI 失败：HTTP ${packageResponse.status}`);
    }
    const archive = await readLimitedResponse(
      packageResponse,
      MAX_OVERLAY_ARCHIVE_BYTES
    );
    if (archive.length !== descriptor.package.size) {
      throw new Error('Mod UI ZIP 大小与发布清单不一致');
    }
    const digest = createHash('sha256').update(archive).digest('hex');
    if (digest !== descriptor.package.sha256) {
      throw new Error('Mod UI ZIP 的 SHA-256 校验失败');
    }
    await this.installArchive(
      archive,
      descriptorUrl,
      { id: descriptor.id, version: descriptor.version }
    );
    return this.getPublicState();
  }

  async installArchiveFromUrl(input: string): Promise<PublicOverlayState> {
    let archiveUrl: URL;
    try {
      archiveUrl = new URL(input);
    } catch {
      throw new Error('Mod UI ZIP 下载地址无效');
    }
    const isLocalDevelopment = (
      archiveUrl.protocol === 'http:'
      && (archiveUrl.hostname === '127.0.0.1' || archiveUrl.hostname === 'localhost')
    );
    if (archiveUrl.protocol !== 'https:' && !isLocalDevelopment) {
      throw new Error('Mod UI ZIP 只允许通过 HTTPS 下载');
    }
    if (archiveUrl.username || archiveUrl.password || archiveUrl.hash) {
      throw new Error('Mod UI ZIP 下载地址无效');
    }
    const packageResponse = await this.fetcher(
      archiveUrl,
      {
        method: 'GET',
        cache: 'no-store',
        headers: {
          Accept: 'application/zip, application/octet-stream',
          'User-Agent': 'AwooMusicBot-SkinMarketplace/1.0'
        }
      },
      SKIN_MARKETPLACE_DOWNLOAD_TIMEOUT_MS
    );
    if (!packageResponse.ok) {
      throw new Error(`从皮肤站下载 Mod UI 失败：HTTP ${packageResponse.status}`);
    }
    if (packageResponse.url) {
      const finalUrl = new URL(packageResponse.url);
      if (finalUrl.origin !== archiveUrl.origin) {
        throw new Error('皮肤站下载地址发生了不受信任的跳转');
      }
    }
    const archive = await readLimitedResponse(
      packageResponse,
      MAX_OVERLAY_ARCHIVE_BYTES
    );
    const installed = await this.installArchive(
      archive,
      `skin-marketplace:${archiveUrl.toString()}`
    );
    const state = await this.getPublicState();
    if (state.active.id !== installed.id) {
      throw new Error('Mod UI 已安装，但未能切换为当前 UI');
    }
    return state;
  }

  async installArchive(
    archive: Buffer,
    source = 'local-zip',
    expected?: { id: string; version: string }
  ): Promise<InstalledOverlayRecord> {
    if (archive.length <= 0 || archive.length > MAX_OVERLAY_ARCHIVE_BYTES) {
      throw new Error('Mod UI ZIP 为空或超过 20 MiB 限制');
    }
    await fs.promises.mkdir(this.rootDirectory, { recursive: true });
    const operationId = randomUUID();
    const stagingDirectory = path.join(
      this.rootDirectory,
      `.install-${operationId}`
    );
    const archivePath = path.join(stagingDirectory, 'overlay.zip');
    const extractedDirectory = path.join(stagingDirectory, 'content');
    let archiveFiles = 0;
    let archiveBytes = 0;
    try {
      await fs.promises.mkdir(extractedDirectory, { recursive: true });
      await fs.promises.writeFile(archivePath, archive);
      await extract(archivePath, {
        dir: extractedDirectory,
        onEntry: entry => {
          const entryName = entry.fileName.replace(/\\/g, '/');
          const isDirectory = entryName.endsWith('/');
          const safeName = isDirectory
            ? entryName.slice(0, -1)
            : entryName;
          if (safeName && !isSafeRelativePath(safeName)) {
            throw new Error(`ZIP 包含不安全路径：${entry.fileName}`);
          }
          const unixType = (entry.externalFileAttributes >>> 16) & 0o170000;
          if (unixType === 0o120000 || (entry.generalPurposeBitFlag & 1) !== 0) {
            throw new Error('Mod UI ZIP 不允许符号链接或加密文件');
          }
          if (!isDirectory) {
            archiveFiles += 1;
            archiveBytes += entry.uncompressedSize;
            if (archiveFiles > MAX_OVERLAY_FILES) {
              throw new Error(`Mod UI 文件数超过 ${MAX_OVERLAY_FILES} 个限制`);
            }
            if (archiveBytes > MAX_OVERLAY_EXTRACTED_BYTES) {
              throw new Error('Mod UI 解压后超过 64 MiB 限制');
            }
            const extension = path.extname(safeName).toLowerCase();
            if (!ALLOWED_FILE_EXTENSIONS.has(extension)) {
              throw new Error(`Mod UI 包含不允许的文件类型：${extension || '无扩展名'}`);
            }
          }
        }
      });

      const manifestPath = path.join(extractedDirectory, 'overlay.json');
      const manifest = validateOverlayManifest(
        JSON.parse(await fs.promises.readFile(manifestPath, 'utf8')),
        this.currentAppVersion
      );
      if (
        expected
        && (manifest.id !== expected.id || manifest.version !== expected.version)
      ) {
        throw new Error('Mod UI ZIP 与发布清单的 id 或版本不一致');
      }
      await this.validateExtractedTree(extractedDirectory, manifest.entry);
      const finalDirectory = this.getInstalledDirectory(
        manifest.id,
        manifest.version
      );
      const backupDirectory = `${finalDirectory}.backup-${operationId}`;
      await fs.promises.mkdir(path.dirname(finalDirectory), { recursive: true });
      if (await this.pathExists(finalDirectory)) {
        await fs.promises.rename(finalDirectory, backupDirectory);
      }
      try {
        await fs.promises.rename(extractedDirectory, finalDirectory);
        if (await this.pathExists(backupDirectory)) {
          await fs.promises.rm(backupDirectory, { recursive: true, force: true });
        }
      } catch (error) {
        if (await this.pathExists(backupDirectory)) {
          await fs.promises.rename(backupDirectory, finalDirectory);
        }
        throw error;
      }

      const record: InstalledOverlayRecord = {
        ...manifest,
        installedAt: new Date().toISOString(),
        source: cleanText(source, 600) || 'local-zip'
      };
      const registry = await this.readRegistry();
      registry.overlays = registry.overlays.filter(item => item.id !== record.id);
      registry.overlays.push(record);
      registry.activeId = record.id;
      await this.writeRegistry(registry);
      return record;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
        throw new Error('ZIP 根目录缺少 overlay.json 或入口文件');
      }
      throw error;
    } finally {
      await fs.promises.rm(stagingDirectory, { recursive: true, force: true });
    }
  }

  async activate(id: string): Promise<PublicOverlayState> {
    const normalizedId = cleanText(id, 80).toLowerCase();
    const registry = await this.readRegistry();
    if (
      normalizedId !== 'builtin'
      && !registry.overlays.some(record => record.id === normalizedId)
    ) {
      throw new Error('找不到要启用的 Mod UI');
    }
    registry.activeId = normalizedId;
    await this.writeRegistry(registry);
    return this.getPublicState();
  }

  async updateSettings(
    id: string,
    values: unknown,
    reset = false
  ): Promise<PublicOverlayState> {
    const normalizedId = cleanText(id, 80).toLowerCase();
    const registry = await this.readRegistry();
    const record = normalizedId === 'builtin'
      ? this.getBuiltinRecord(registry.activeId === 'builtin', registry.settings.builtin)
      : registry.overlays.find(item => item.id === normalizedId);
    if (!record) throw new Error('找不到要设置的 Mod UI');
    const definitions = Array.isArray(record.settings) ? record.settings : [];
    if (definitions.length === 0) {
      throw new Error('这个 Mod UI 没有声明可调参数');
    }
    if (reset) {
      registry.settings[normalizedId] = normalizeOverlaySettingValues(definitions, {});
    } else {
      if (!values || typeof values !== 'object' || Array.isArray(values)) {
        throw new Error('Mod UI 参数必须是 JSON 对象');
      }
      const current = normalizeOverlaySettingValues(
        definitions,
        registry.settings[normalizedId]
      );
      registry.settings[normalizedId] = normalizeOverlaySettingValues(
        definitions,
        { ...current, ...(values as Record<string, unknown>) },
        true
      );
    }
    await this.writeRegistry(registry);
    return this.getPublicState();
  }

  async remove(id: string): Promise<PublicOverlayState> {
    const normalizedId = cleanText(id, 80).toLowerCase();
    if (normalizedId === 'builtin') {
      throw new Error('内置 UI 不能删除');
    }
    const registry = await this.readRegistry();
    const record = registry.overlays.find(item => item.id === normalizedId);
    if (!record) throw new Error('找不到要删除的 Mod UI');
    if (registry.activeId === normalizedId) registry.activeId = 'builtin';
    registry.overlays = registry.overlays.filter(item => item.id !== normalizedId);
    await this.writeRegistry(registry);
    const overlayDirectory = path.join(this.rootDirectory, normalizedId);
    if (this.isInsideRoot(overlayDirectory)) {
      await fs.promises.rm(overlayDirectory, { recursive: true, force: true });
    }
    return this.getPublicState();
  }

  async resolveActiveAsset(relativePath: string): Promise<OverlayAsset | null> {
    const registry = await this.readRegistry();
    const record = registry.overlays.find(item => item.id === registry.activeId);
    const root = record
      ? this.getInstalledDirectory(record.id, record.version)
      : this.bundledOverlayDirectory;
    const entry = record?.entry || 'index.html';
    const requested = relativePath.replace(/^\/+/, '') || entry;
    if (!isSafeRelativePath(requested)) return null;
    const resolved = path.resolve(root, ...requested.split('/'));
    const rootWithSeparator = `${path.resolve(root)}${path.sep}`;
    if (!resolved.startsWith(rootWithSeparator)) return null;
    try {
      const stat = await fs.promises.stat(resolved);
      if (!stat.isFile()) return null;
    } catch {
      return null;
    }
    const revision = record
      ? `${record.id}@${record.version}:${record.installedAt}`
      : `builtin@${this.currentAppVersion}`;
    return {
      filePath: resolved,
      contentType: contentTypeFor(resolved),
      revision
    };
  }

  private async validateExtractedTree(
    directory: string,
    entry: string
  ): Promise<void> {
    const pending = [directory];
    let files = 0;
    let bytes = 0;
    while (pending.length > 0) {
      const current = pending.pop();
      if (!current) continue;
      const children = await fs.promises.readdir(current, { withFileTypes: true });
      for (const child of children) {
        const childPath = path.join(current, child.name);
        const stat = await fs.promises.lstat(childPath);
        if (stat.isSymbolicLink()) throw new Error('Mod UI 不能包含符号链接');
        if (stat.isDirectory()) {
          pending.push(childPath);
          continue;
        }
        if (!stat.isFile()) throw new Error('Mod UI 只能包含普通文件');
        files += 1;
        bytes += stat.size;
        if (files > MAX_OVERLAY_FILES || bytes > MAX_OVERLAY_EXTRACTED_BYTES) {
          throw new Error('Mod UI 解压内容超过安全限制');
        }
        if (!ALLOWED_FILE_EXTENSIONS.has(path.extname(child.name).toLowerCase())) {
          throw new Error(`Mod UI 包含不允许的文件：${child.name}`);
        }
      }
    }
    const entryPath = path.resolve(directory, ...entry.split('/'));
    const stat = await fs.promises.stat(entryPath);
    if (!stat.isFile()) throw new Error('Mod UI 入口文件不存在');
  }

  private getBuiltinRecord(
    active: boolean,
    storedValues?: OverlaySettingValues
  ): PublicOverlayRecord {
    return {
      schemaVersion: 1,
      id: 'builtin',
      name: '内置 UI',
      version: this.currentAppVersion,
      entry: 'index.html',
      author: 'Enkianssus',
      description: '随点歌机提供的透明 OBS 组件，任何 Mod 异常时都可切回。',
      homepage: OFFICIAL_OVERLAY_REPOSITORY,
      minAppVersion: this.currentAppVersion,
      installedAt: '',
      source: 'bundled',
      active,
      builtin: true,
      settings: BUILTIN_OVERLAY_SETTINGS,
      values: normalizeOverlaySettingValues(BUILTIN_OVERLAY_SETTINGS, storedValues)
    };
  }

  private getInstalledDirectory(id: string, version: string): string {
    const directory = path.join(this.rootDirectory, id, version);
    if (!this.isInsideRoot(directory)) throw new Error('Mod UI 安装路径无效');
    return directory;
  }

  private isInsideRoot(candidate: string): boolean {
    const root = `${path.resolve(this.rootDirectory)}${path.sep}`;
    return path.resolve(candidate).startsWith(root);
  }

  private async pathExists(candidate: string): Promise<boolean> {
    try {
      await fs.promises.access(candidate);
      return true;
    } catch {
      return false;
    }
  }

  private async readRegistry(): Promise<OverlayRegistry> {
    try {
      const parsed = JSON.parse(
        await fs.promises.readFile(this.registryPath, 'utf8')
      ) as Partial<OverlayRegistry>;
      const overlays = Array.isArray(parsed.overlays)
        ? parsed.overlays.flatMap(record => {
            if (
              !record
              || !OVERLAY_ID_PATTERN.test(String(record.id || ''))
              || !OVERLAY_VERSION_PATTERN.test(String(record.version || ''))
            ) return [];
            try {
              return [{
                ...record,
                settings: validateOverlaySettingDefinitions(record.settings)
              } as InstalledOverlayRecord];
            } catch {
              return [];
            }
          })
        : [];
      const activeId = String(parsed.activeId || 'builtin');
      const storedSettings: Record<string, OverlaySettingValues> = {};
      if (parsed.settings && typeof parsed.settings === 'object' && !Array.isArray(parsed.settings)) {
        for (const [overlayId, rawValues] of Object.entries(parsed.settings).slice(0, 100)) {
          if (
            overlayId !== 'builtin'
            && !OVERLAY_ID_PATTERN.test(overlayId)
          ) continue;
          if (!rawValues || typeof rawValues !== 'object' || Array.isArray(rawValues)) continue;
          const safeValues: OverlaySettingValues = {};
          for (const [key, rawValue] of Object.entries(rawValues).slice(0, MAX_OVERLAY_SETTINGS)) {
            if (!OVERLAY_SETTING_KEY_PATTERN.test(key)) continue;
            if (typeof rawValue === 'boolean') safeValues[key] = rawValue;
            else if (typeof rawValue === 'number' && Number.isFinite(rawValue)) safeValues[key] = rawValue;
            else if (typeof rawValue === 'string') safeValues[key] = rawValue.slice(0, 200);
          }
          storedSettings[overlayId] = safeValues;
        }
      }
      return {
        schemaVersion: 1,
        activeId: activeId === 'builtin'
          || overlays.some(record => record.id === activeId)
          ? activeId
          : 'builtin',
        overlays,
        settings: storedSettings
      };
    } catch {
      return { schemaVersion: 1, activeId: 'builtin', overlays: [], settings: {} };
    }
  }

  private async writeRegistry(registry: OverlayRegistry): Promise<void> {
    await fs.promises.mkdir(this.rootDirectory, { recursive: true });
    const temporaryPath = `${this.registryPath}.${randomUUID()}.tmp`;
    await fs.promises.writeFile(
      temporaryPath,
      JSON.stringify(registry, null, 2),
      'utf8'
    );
    await fs.promises.rename(temporaryPath, this.registryPath);
  }
}
