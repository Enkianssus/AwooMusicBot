import { execFile } from 'node:child_process';
import path from 'node:path';
import type { NativeConnectorId } from './connector-updater';

const PLAYER_PROCESS_NAMES: Partial<Record<NativeConnectorId, string>> = {
  netease: 'cloudmusic',
  kugou: 'KuGou',
  qqmusic: 'QQMusic'
};

const PROCESS_QUERY_MAX_BUFFER = 128 * 1024;
const PROCESS_QUERY_TIMEOUT_MS = 8_000;

function getPowerShellPath(): string {
  const systemRoot = typeof process.env?.SystemRoot === 'string'
    && process.env.SystemRoot.trim()
    ? process.env.SystemRoot
    : typeof process.env?.windir === 'string' && process.env.windir.trim()
      ? process.env.windir
      : 'C:\\Windows';
  return path.join(
    systemRoot,
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  );
}

export interface PlayerProcessInfo {
  running: boolean;
  processId: number | null;
  version: string | null;
  executablePath: string | null;
  querySucceeded: boolean;
}

export interface PlayerProcessCommandRunner {
  (script: string): Promise<string>;
}

function emptyProcessInfo(querySucceeded: boolean): PlayerProcessInfo {
  return {
    running: false,
    processId: null,
    version: null,
    executablePath: null,
    querySucceeded
  };
}

function normalizeProcessId(value: unknown): number | null {
  const number = typeof value === 'number'
    ? value
    : typeof value === 'string' && /^\d+$/.test(value.trim())
      ? Number(value.trim())
      : NaN;
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function normalizeText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text || null;
}

/**
 * Parse the compact JSON emitted by the Windows process query. Keeping this
 * separate from the command runner makes the process/version decision fully
 * testable without touching a user's running players.
 */
export function parsePlayerProcessOutput(
  output: string
): PlayerProcessInfo {
  const text = String(output || '').replace(/^\uFEFF/, '').trim();
  if (!text) return emptyProcessInfo(true);

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return emptyProcessInfo(false);
  }

  const rows = Array.isArray(raw) ? raw : [raw];
  const process = rows.find(row => {
    if (!row || typeof row !== 'object') return false;
    return normalizeProcessId(
      (row as Record<string, unknown>).processId
    ) !== null;
  });
  if (!process || typeof process !== 'object') {
    return emptyProcessInfo(true);
  }

  const record = process as Record<string, unknown>;
  return {
    running: true,
    processId: normalizeProcessId(record.processId),
    version: normalizeText(record.version),
    executablePath: normalizeText(record.path),
    querySucceeded: true
  };
}

function buildProcessQueryScript(processName: string): string {
  // The process name comes exclusively from PLAYER_PROCESS_NAMES above; it is
  // never derived from user input.
  return [
    "$ErrorActionPreference = 'SilentlyContinue'",
    // Prevent a localized console encoding or a UTF-8 BOM from corrupting the
    // compact JSON consumed by parsePlayerProcessOutput.
    '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)',
    `$items = @(Get-Process -Name '${processName}' `
      + '-ErrorAction SilentlyContinue | ForEach-Object {',
    '  $path = $null; $version = $null;',
    '  try { $path = $_.Path } catch {}',
    '  if (-not $path) { try { $path = $_.MainModule.FileName } catch {} }',
    '  if ($path) { try { $version = '
      + '[Diagnostics.FileVersionInfo]::GetVersionInfo($path).FileVersion '
      + '} catch {} }',
    '  [PSCustomObject]@{ processId = $_.Id; path = $path; version = $version }',
    '});',
    "if ($items.Count -eq 0) { '[]' } else { $items | ConvertTo-Json -Compress }"
  ].join('\n');
}

const runPowerShellQuery: PlayerProcessCommandRunner = script => (
  new Promise((resolve, reject) => {
    execFile(
      getPowerShellPath(),
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        script
      ],
      {
        windowsHide: true,
        encoding: 'utf8',
        timeout: PROCESS_QUERY_TIMEOUT_MS,
        maxBuffer: PROCESS_QUERY_MAX_BUFFER
      },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(stdout);
      }
    );
  })
);

export async function inspectPlayerProcess(
  connectorId: NativeConnectorId,
  runQuery: PlayerProcessCommandRunner = runPowerShellQuery
): Promise<PlayerProcessInfo> {
  const processName = PLAYER_PROCESS_NAMES[connectorId];
  if (!processName || process.platform !== 'win32') {
    return emptyProcessInfo(false);
  }

  try {
    return parsePlayerProcessOutput(
      await runQuery(buildProcessQueryScript(processName))
    );
  } catch {
    return emptyProcessInfo(false);
  }
}
