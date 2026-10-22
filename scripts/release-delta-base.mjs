import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

// Velopack writes a delta package only when the previous full package and its
// feed already sit in the output directory. This script puts exactly that
// previous release of the same channel there before `vpk pack`, and afterwards
// removes every package that does not belong to the version being released.

const GITHUB_API = 'https://api.github.com';
const MAX_RELEASE_PAGES = 5;

function parseArguments(argv) {
  const [command, ...rest] = argv;
  const values = { command };
  const valueOptions = new Set([
    '--repository',
    '--current-tag',
    '--tag-prefix',
    '--min-version',
    '--pack-id',
    '--channel',
    '--version',
    '--output-dir'
  ]);
  for (let index = 0; index < rest.length; index += 1) {
    const option = rest[index];
    if (valueOptions.has(option)) {
      values[option.slice(2).replaceAll('-', '_')] = rest[++index] || '';
      continue;
    }
    if (option === '--strict') {
      values.strict = true;
      continue;
    }
    throw new Error(`Unknown option: ${option}`);
  }
  return values;
}

function parseVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(value || ''));
  if (!match) return null;
  const parts = match.slice(1).map(Number);
  return parts.every(Number.isSafeInteger) ? parts : null;
}

function parseVersionTag(tag, tagPrefix) {
  const text = String(tag || '');
  return text.startsWith(tagPrefix) ? parseVersion(text.slice(tagPrefix.length)) : null;
}

function compareVersions(left, right) {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1;
  }
  return 0;
}

function requireName(value, label) {
  const text = String(value || '');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(text)) throw new Error(`Invalid ${label}: ${text}`);
  return text;
}

function packageAssetName(packId, version, kind) {
  return `${packId}-${version}-${kind}.nupkg`;
}

function feedAssetName(channel) {
  return `releases.${channel}.json`;
}

function validateFetchOptions(options) {
  const repository = String(options.repository || '');
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repository)) {
    throw new Error(`Invalid repository: ${repository}`);
  }
  const tagPrefix = String(options.tagPrefix ?? 'v');
  const current = parseVersionTag(options.currentTag, tagPrefix);
  if (!current) throw new Error(`Invalid current release tag: ${options.currentTag}`);
  const minimum = parseVersion(options.minVersion || '0.0.0');
  if (!minimum) throw new Error(`Invalid minimum version: ${options.minVersion}`);
  if (!options.outputDir) throw new Error('An output directory is required.');
  return {
    repository,
    tagPrefix,
    current,
    minimum,
    packId: requireName(options.packId, 'package id'),
    channel: requireName(options.channel || 'win', 'channel'),
    outputDir: path.resolve(String(options.outputDir))
  };
}

/**
 * The newest published release of the same channel below the current version
 * that carries both the full package and the feed. Older channels share the
 * repository (1.0.x uses another package id), so they are excluded by version.
 */
function selectBaseRelease(releases, options) {
  const normalized = validateFetchOptions(options);
  let best = null;
  for (const release of Array.isArray(releases) ? releases : []) {
    if (!release || release.draft || release.prerelease) continue;
    const version = parseVersionTag(release.tag_name, normalized.tagPrefix);
    if (!version
      || compareVersions(version, normalized.minimum) < 0
      || compareVersions(version, normalized.current) >= 0) continue;
    const versionText = version.join('.');
    const assets = Array.isArray(release.assets) ? release.assets : [];
    const feed = assets.find(asset => asset?.name === feedAssetName(normalized.channel));
    const full = assets.find(asset => asset?.name === packageAssetName(normalized.packId, versionText, 'full'));
    if (!feed || !full) continue;
    if (!best || compareVersions(version, best.version) > 0) {
      best = { tag: String(release.tag_name), version, versionText, assets: [feed, full] };
    }
  }
  return best;
}

/** Packages of any other version that the base download left in the output directory. */
function selectFilesToPrune(fileNames, { packId, version }) {
  const id = requireName(packId, 'package id').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!parseVersion(version)) throw new Error(`Invalid release version: ${version}`);
  const pattern = new RegExp(`^${id}-(\\d+\\.\\d+\\.\\d+)-(full|delta)\\.nupkg$`, 'i');
  return fileNames
    .filter(name => {
      const match = pattern.exec(name);
      return Boolean(match) && match[1] !== version;
    })
    .sort();
}

function githubHeaders(token) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'awoo-musicbot-release',
    'X-GitHub-Api-Version': '2022-11-28'
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

async function listReleases(repository, token, fetchImpl) {
  const releases = [];
  for (let page = 1; page <= MAX_RELEASE_PAGES; page += 1) {
    const response = await fetchImpl(
      `${GITHUB_API}/repos/${repository}/releases?per_page=100&page=${page}`,
      { headers: githubHeaders(token) }
    );
    if (!response.ok) throw new Error(`GitHub release list failed with HTTP ${response.status}`);
    const batch = await response.json();
    if (!Array.isArray(batch)) throw new Error('GitHub release list returned an unexpected body.');
    releases.push(...batch);
    if (batch.length < 100) break;
  }
  return releases;
}

async function downloadAsset(asset, destination, fetchImpl) {
  const url = String(asset.browser_download_url || '');
  if (!/^https:\/\/github\.com\//.test(url)) throw new Error(`Unexpected download URL for ${asset.name}`);
  const response = await fetchImpl(url, { headers: { 'User-Agent': 'awoo-musicbot-release' } });
  if (!response.ok || !response.body) throw new Error(`Download of ${asset.name} failed with HTTP ${response.status}`);
  const temporary = `${destination}.download`;
  try {
    await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(temporary));
    const size = fs.statSync(temporary).size;
    if (Number.isSafeInteger(asset.size) && size !== asset.size) {
      throw new Error(`Download of ${asset.name} is incomplete (${size} of ${asset.size} bytes)`);
    }
    fs.renameSync(temporary, destination);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

async function fetchBaseRelease(options, { fetchImpl = fetch, token = '' } = {}) {
  const normalized = validateFetchOptions(options);
  const releases = await listReleases(normalized.repository, token, fetchImpl);
  const base = selectBaseRelease(releases, options);
  if (!base) return { base: null, files: [] };
  fs.mkdirSync(normalized.outputDir, { recursive: true });
  const files = [];
  try {
    for (const asset of base.assets) {
      const destination = path.join(normalized.outputDir, asset.name);
      await downloadAsset(asset, destination, fetchImpl);
      files.push(destination);
    }
  } catch (error) {
    // A half-prepared base would make vpk fail or diff against the wrong data.
    for (const file of files) fs.rmSync(file, { force: true });
    throw error;
  }
  return { base, files };
}

function pruneOutput(options) {
  const outputDir = path.resolve(String(options.outputDir || ''));
  const packId = requireName(options.packId, 'package id');
  const version = String(options.version || '');
  const names = fs.readdirSync(outputDir);
  const removed = selectFilesToPrune(names, { packId, version });
  for (const name of removed) fs.rmSync(path.join(outputDir, name), { force: true });
  const full = packageAssetName(packId, version, 'full');
  if (!fs.existsSync(path.join(outputDir, full))) {
    throw new Error(`The full package ${full} is missing after packing.`);
  }
  const delta = packageAssetName(packId, version, 'delta');
  return {
    removed,
    fullSize: fs.statSync(path.join(outputDir, full)).size,
    deltaSize: fs.existsSync(path.join(outputDir, delta)) ? fs.statSync(path.join(outputDir, delta)).size : null
  };
}

export {
  fetchBaseRelease,
  pruneOutput,
  selectBaseRelease,
  selectFilesToPrune
};

const megabytes = bytes => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

async function main() {
  const values = parseArguments(process.argv.slice(2));
  const options = {
    repository: values.repository,
    currentTag: values.current_tag,
    tagPrefix: values.tag_prefix,
    minVersion: values.min_version,
    packId: values.pack_id,
    channel: values.channel,
    version: values.version,
    outputDir: values.output_dir
  };
  if (values.command === 'fetch') {
    try {
      const { base } = await fetchBaseRelease(options, {
        token: process.env.GITHUB_TOKEN || process.env.GH_TOKEN || ''
      });
      if (base) console.log(`Delta base: ${base.tag} (${base.assets.map(asset => asset.name).join(', ')})`);
      else console.log('::warning::No previous release of this channel was found; packing the full package only.');
    } catch (error) {
      // Without a base, vpk still packs the full package; clients then download it in full.
      if (values.strict) throw error;
      console.log(`::warning::Previous release unavailable (${error.message || error}); packing the full package only.`);
    }
    return;
  }
  if (values.command === 'prune') {
    const result = pruneOutput(options);
    for (const name of result.removed) console.log(`Removed ${name} from the upload set`);
    console.log(`Full package: ${megabytes(result.fullSize)}`);
    if (result.deltaSize === null) {
      console.log('::warning::No delta package was produced; clients will download the full package.');
    } else {
      console.log(`Delta package: ${megabytes(result.deltaSize)}`);
    }
    return;
  }
  throw new Error('Usage: release-delta-base.mjs <fetch|prune> [options]');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}
