import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import {
  openPromise,
  type Entry
} from 'yauzl';

const DEFAULT_MAX_ENTRIES = 20_000;
const DEFAULT_MAX_UNCOMPRESSED_BYTES = 2 * 1024 * 1024 * 1024;
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

export interface SafeZipExtractOptions {
  maxEntries?: number;
  maxUncompressedBytes?: number;
  onEntry?: (entry: Entry) => void | Promise<void>;
}

export function normalizeZipEntryPath(fileName: string): string {
  const normalized = fileName.replace(/\\/g, '/');
  const withoutTrailingSlash = normalized.endsWith('/')
    ? normalized.slice(0, -1)
    : normalized;
  if (
    !withoutTrailingSlash
    || withoutTrailingSlash.includes('\0')
    || normalized.startsWith('/')
    || /^[A-Za-z]:/.test(normalized)
  ) {
    throw new Error(`ZIP 包含不安全路径：${fileName}`);
  }

  const segments = withoutTrailingSlash.split('/');
  if (segments.some(segment => (
    !segment
    || segment === '.'
    || segment === '..'
    || segment.includes(':')
    || /[. ]$/.test(segment)
    || WINDOWS_RESERVED_NAME.test(segment)
  ))) {
    throw new Error(`ZIP 包含不安全路径：${fileName}`);
  }
  return segments.join(path.sep);
}

function isSymbolicLinkOrReparsePoint(entry: Entry): boolean {
  const unixType = (entry.externalFileAttributes >>> 16) & 0o170000;
  const dosAttributes = entry.externalFileAttributes & 0xffff;
  return unixType === 0o120000 || (dosAttributes & 0x0400) !== 0;
}

export async function extractZipSafely(
  archivePath: string,
  destinationDirectory: string,
  options: SafeZipExtractOptions = {}
): Promise<void> {
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const maxUncompressedBytes = options.maxUncompressedBytes
    ?? DEFAULT_MAX_UNCOMPRESSED_BYTES;
  if (
    !Number.isSafeInteger(maxEntries)
    || maxEntries <= 0
    || !Number.isSafeInteger(maxUncompressedBytes)
    || maxUncompressedBytes <= 0
  ) {
    throw new Error('ZIP 解压限制无效');
  }

  const destinationRoot = path.resolve(destinationDirectory);
  await fs.promises.mkdir(destinationRoot, { recursive: true });
  const zip = await openPromise(archivePath, {
    autoClose: false,
    lazyEntries: true,
    decodeStrings: true,
    validateEntrySizes: true,
    strictFileNames: true
  });
  let entryCount = 0;
  let uncompressedBytes = 0;
  try {
    for await (const entry of zip.eachEntry()) {
      entryCount += 1;
      if (entryCount > maxEntries) {
        throw new Error(`ZIP 文件数超过 ${maxEntries} 个限制`);
      }
      if (
        !Number.isSafeInteger(entry.uncompressedSize)
        || entry.uncompressedSize < 0
      ) {
        throw new Error('ZIP 包含无效文件大小');
      }
      uncompressedBytes += entry.uncompressedSize;
      if (uncompressedBytes > maxUncompressedBytes) {
        throw new Error('ZIP 解压后大小超过安全限制');
      }
      if (
        entry.isEncrypted()
        || !entry.canDecodeFileData()
        || isSymbolicLinkOrReparsePoint(entry)
      ) {
        throw new Error('ZIP 不允许加密文件、符号链接或重解析点');
      }

      const relativePath = normalizeZipEntryPath(entry.fileName);
      const targetPath = path.resolve(destinationRoot, relativePath);
      if (!targetPath.startsWith(`${destinationRoot}${path.sep}`)) {
        throw new Error(`ZIP 包含不安全路径：${entry.fileName}`);
      }
      await options.onEntry?.(entry);

      if (entry.fileName.endsWith('/')) {
        await fs.promises.mkdir(targetPath, { recursive: true });
        continue;
      }

      await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
      const input = await zip.openReadStreamPromise(entry);
      try {
        await pipeline(input, fs.createWriteStream(targetPath, {
          flags: 'wx',
          mode: 0o600
        }));
      } catch (error) {
        await fs.promises.rm(targetPath, { force: true });
        throw error;
      }
    }
  } finally {
    if (zip.isOpen) zip.close();
  }
}
