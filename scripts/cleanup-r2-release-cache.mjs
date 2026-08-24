import { fileURLToPath } from 'node:url';
import path from 'node:path';

const CACHE_PREFIX = 'github-release-v1/';
const CACHE_BUCKET = 'awoo-download-cache';
const CACHE_REPOSITORY = 'Enkianssus/AwooMusicBot';
const API_BASE = 'https://api.cloudflare.com/client/v4';

function parseArguments(argv) {
  const values = { expectedKeys: [] };
  const valueOptions = new Set([
    '--account-id',
    '--bucket',
    '--repository',
    '--current-tag',
    '--tag-prefix',
    '--version-parts'
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === '--expected-key') {
      values.expectedKeys.push(argv[++index] || '');
      continue;
    }
    if (valueOptions.has(option)) {
      values[option.slice(2).replaceAll('-', '_')] = argv[++index] || '';
      continue;
    }
    if (option === '--dry-run') {
      values.dryRun = true;
      continue;
    }
    throw new Error(`Unknown option: ${option}`);
  }
  return values;
}

function isSafeAssetKey(value) {
  return Boolean(value)
    && !value.includes('/')
    && !value.includes('\\')
    && value !== '.'
    && value !== '..'
    && !value.includes('..');
}

function parseVersionTag(tag, tagPrefix, versionParts) {
  if (!tag.startsWith(tagPrefix)) return null;
  const suffix = tag.slice(tagPrefix.length);
  if (!new RegExp(`^\\d+(?:\\.\\d+){${versionParts - 1}}$`).test(suffix)) {
    return null;
  }
  const parts = suffix.split('.').map(value => Number(value));
  return parts.every(value => Number.isSafeInteger(value) && value >= 0)
    ? parts
    : null;
}

function compareVersions(left, right) {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1;
  }
  return 0;
}

function validateScope(scope) {
  const accountId = String(scope.accountId || '');
  const bucket = String(scope.bucket || CACHE_BUCKET);
  const repository = String(scope.repository || '');
  const currentTag = String(scope.currentTag || '');
  const tagPrefix = String(scope.tagPrefix || '');
  const versionParts = Number(scope.versionParts);
  const expectedKeys = [...new Set((scope.expectedKeys || []).map(String))];
  if (!/^[a-f0-9]{32}$/i.test(accountId)) {
    throw new Error('A valid 32-character Cloudflare account ID is required.');
  }
  if (bucket !== CACHE_BUCKET || repository !== CACHE_REPOSITORY) {
    throw new Error('Refusing to operate outside the AwooMusicBot R2 scope.');
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(tagPrefix)) {
    throw new Error(`Invalid tag family prefix: ${tagPrefix}`);
  }
  if (!Number.isInteger(versionParts) || versionParts < 1 || versionParts > 16) {
    throw new Error(`Invalid release version component count: ${scope.versionParts}`);
  }
  if (!parseVersionTag(currentTag, tagPrefix, versionParts)) {
    throw new Error(`Invalid current release tag: ${currentTag}`);
  }
  if (expectedKeys.length === 0) {
    throw new Error('At least one successfully uploaded expected key is required.');
  }
  const releasePrefix = `${CACHE_PREFIX}github.com/${repository}/releases/download/`;
  for (const key of expectedKeys) {
    const asset = key.slice(`${releasePrefix}${currentTag}/`.length);
    if (!key.startsWith(`${releasePrefix}${currentTag}/`) || !isSafeAssetKey(asset)) {
      throw new Error(`Expected key is outside the current release scope: ${key}`);
    }
  }
  return {
    accountId,
    bucket,
    repository,
    currentTag,
    tagPrefix,
    versionParts,
    expectedKeys,
    releasePrefix,
    dryRun: Boolean(scope.dryRun),
    apiBase: API_BASE
  };
}

function selectKeysToDelete(scope, keys) {
  const normalized = validateScope(scope);
  const validVersions = new Map();
  const candidates = [];
  for (const key of new Set(keys.map(String))) {
    if (!key.startsWith(normalized.releasePrefix)) continue;
    const relative = key.slice(normalized.releasePrefix.length);
    const separator = relative.indexOf('/');
    if (separator <= 0) continue;
    const tag = relative.slice(0, separator);
    const asset = relative.slice(separator + 1);
    const version = parseVersionTag(tag, normalized.tagPrefix, normalized.versionParts);
    if (!version) continue;
    if (!validVersions.has(tag)) validVersions.set(tag, version);
    if (isSafeAssetKey(asset)) candidates.push({ key, version });
  }
  const newestVersion = [...validVersions.values()].reduce(
    (newest, version) => !newest || compareVersions(version, newest) > 0 ? version : newest,
    null
  );
  if (!newestVersion) return [];
  const currentVersion = parseVersionTag(
    normalized.currentTag,
    normalized.tagPrefix,
    normalized.versionParts
  );
  const cutoffVersion = compareVersions(newestVersion, currentVersion) > 0
    ? currentVersion
    : newestVersion;
  return candidates
    .filter(candidate => compareVersions(candidate.version, cutoffVersion) < 0)
    .map(candidate => candidate.key)
    .sort();
}

function apiUrl(scope, suffix, query = {}) {
  const url = new URL(
    `${scope.apiBase}/accounts/${encodeURIComponent(scope.accountId)}`
      + `/r2/buckets/${encodeURIComponent(scope.bucket)}${suffix}`
  );
  for (const [key, value] of Object.entries(query)) {
    if (value) url.searchParams.set(key, value);
  }
  return url;
}

function requestHeaders(token) {
  return { Authorization: `Bearer ${token}`, Accept: 'application/json' };
}

async function readJsonResponse(response, operation) {
  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error(`${operation} returned non-JSON HTTP ${response.status}.`);
  }
  if (!response.ok || body?.success !== true) {
    const details = Array.isArray(body?.errors)
      ? body.errors.map(error => error.message || JSON.stringify(error)).join('; ')
      : `HTTP ${response.status}`;
    throw new Error(`${operation} failed: ${details}`);
  }
  return body;
}

async function listKeys(scope, token, fetchImpl = fetch) {
  const keys = [];
  let cursor = '';
  do {
    const response = await fetchImpl(
      apiUrl(scope, '/objects', {
        prefix: scope.releasePrefix,
        per_page: '1000',
        cursor
      }),
      { headers: requestHeaders(token) }
    );
    const body = await readJsonResponse(response, 'R2 object list');
    for (const object of Array.isArray(body.result) ? body.result : []) {
      if (typeof object?.key === 'string') keys.push(object.key);
    }
    if (!body.result_info?.is_truncated) {
      cursor = '';
      break;
    }
    const nextCursor = String(body.result_info.cursor || '');
    if (!nextCursor || nextCursor === cursor) {
      throw new Error('R2 object list was truncated without a usable cursor.');
    }
    cursor = nextCursor;
  } while (cursor);
  return [...new Set(keys)];
}

async function cleanupR2ReleaseCache(scope, token, fetchImpl = fetch) {
  const normalized = validateScope(scope);
  const listedKeys = await listKeys(normalized, token, fetchImpl);
  const listedSet = new Set(listedKeys);
  const missingKeys = normalized.expectedKeys.filter(key => !listedSet.has(key));
  if (missingKeys.length > 0) {
    throw new Error(`Refusing cleanup because uploaded assets are missing: ${missingKeys.join(', ')}`);
  }
  const candidates = selectKeysToDelete(normalized, listedKeys);
  if (normalized.dryRun) return { deleted: [], candidates };
  const deleted = [];
  for (const key of candidates) {
    const encodedKey = key.split('/').map(segment => encodeURIComponent(segment)).join('/');
    const response = await fetchImpl(apiUrl(normalized, `/objects/${encodedKey}`), {
      method: 'DELETE',
      headers: requestHeaders(token)
    });
    await readJsonResponse(response, `R2 object delete ${key}`);
    deleted.push(key);
    console.log(`Deleted old R2 object ${key}`);
  }
  return { deleted, candidates };
}

export { cleanupR2ReleaseCache, selectKeysToDelete, validateScope };

async function main() {
  const values = parseArguments(process.argv.slice(2));
  const token = process.env.CLOUDFLARE_API_TOKEN
    || process.env.ENKIANSSUS_CLOUDFLARE_API_TOKEN;
  if (!token) throw new Error('CLOUDFLARE_API_TOKEN is required for R2 cleanup.');
  await cleanupR2ReleaseCache({
    accountId: values.account_id || process.env.CLOUDFLARE_ACCOUNT_ID,
    bucket: values.bucket || CACHE_BUCKET,
    repository: values.repository || CACHE_REPOSITORY,
    currentTag: values.current_tag,
    tagPrefix: values.tag_prefix,
    versionParts: values.version_parts,
    expectedKeys: values.expectedKeys,
    dryRun: values.dryRun
  }, token);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}
