import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export interface NeteaseProcessInfo {
  processId: number;
  parentProcessId: number;
  executablePath: string;
  commandLine: string;
}

export interface NeteaseUpdateProcessSession {
  wasRunning: boolean;
  executablePath: string | null;
  processIds: number[];
}

export interface NeteaseProcessRuntime {
  listProcesses(): Promise<NeteaseProcessInfo[]>;
  closeProcessTrees(processIds: number[], force: boolean): Promise<void>;
  launch(executablePath: string): Promise<void>;
  fileExists(filePath: string): boolean;
  wait(milliseconds: number): Promise<void>;
}

interface NeteaseUpdateProcessControllerOptions {
  runtime?: NeteaseProcessRuntime;
  onLog?: (message: string) => void;
  gracefulTimeoutMs?: number;
  forceTimeoutMs?: number;
  restartTimeoutMs?: number;
  pollIntervalMs?: number;
}

export class NeteaseProcessControlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NeteaseProcessControlError';
  }
}

export function isTransientNeteaseFileLock(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = String((error as NodeJS.ErrnoException).code || '')
    .toUpperCase();
  return ['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY'].includes(code);
}

export function parseNeteaseProcessList(
  serialized: string
): NeteaseProcessInfo[] {
  const source = serialized.replace(/^\uFEFF/, '').trim();
  if (!source) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new NeteaseProcessControlError(
      '网易云进程检测返回了无法识别的数据'
    );
  }

  const items = Array.isArray(parsed) ? parsed : [parsed];
  return items.flatMap(item => {
    if (!item || typeof item !== 'object') return [];
    const value = item as Record<string, unknown>;
    const processId = Number(value.processId);
    const parentProcessId = Number(value.parentProcessId);
    if (!Number.isSafeInteger(processId) || processId <= 0) return [];
    return [{
      processId,
      parentProcessId: Number.isSafeInteger(parentProcessId)
        ? parentProcessId
        : 0,
      executablePath: typeof value.executablePath === 'string'
        ? value.executablePath.trim()
        : '',
      commandLine: typeof value.commandLine === 'string'
        ? value.commandLine
        : ''
    }];
  });
}

export function selectNeteaseRootProcessIds(
  processes: NeteaseProcessInfo[]
): number[] {
  const processIds = new Set(processes.map(item => item.processId));
  const roots = processes
    .filter(item => !processIds.has(item.parentProcessId))
    .map(item => item.processId);
  return [...new Set(
    roots.length > 0
      ? roots
      : processes.map(item => item.processId)
  )];
}

export function selectNeteaseRestartExecutable(
  processes: NeteaseProcessInfo[],
  fileExists: (filePath: string) => boolean = fs.existsSync
): string | null {
  const rootIds = new Set(selectNeteaseRootProcessIds(processes));
  const candidates = [...processes].sort((left, right) => {
    const leftRoot = rootIds.has(left.processId) ? 0 : 1;
    const rightRoot = rootIds.has(right.processId) ? 0 : 1;
    if (leftRoot !== rightRoot) return leftRoot - rightRoot;
    const leftChild = /(?:^|\s)--type=/i.test(left.commandLine) ? 1 : 0;
    const rightChild = /(?:^|\s)--type=/i.test(right.commandLine) ? 1 : 0;
    return leftChild - rightChild;
  });

  for (const candidate of candidates) {
    const executablePath = candidate.executablePath;
    if (
      executablePath
      && path.win32.basename(executablePath).toLowerCase()
        === 'cloudmusic.exe'
      && fileExists(executablePath)
    ) {
      return executablePath;
    }
  }
  return null;
}

export class NeteaseUpdateProcessController {
  private readonly runtime: NeteaseProcessRuntime;
  private readonly onLog: (message: string) => void;
  private readonly gracefulTimeoutMs: number;
  private readonly forceTimeoutMs: number;
  private readonly restartTimeoutMs: number;
  private readonly pollIntervalMs: number;

  constructor(options: NeteaseUpdateProcessControllerOptions = {}) {
    this.runtime = options.runtime || new WindowsNeteaseProcessRuntime();
    this.onLog = options.onLog || (() => {});
    this.gracefulTimeoutMs = options.gracefulTimeoutMs ?? 5000;
    this.forceTimeoutMs = options.forceTimeoutMs ?? 5000;
    this.restartTimeoutMs = options.restartTimeoutMs ?? 10000;
    this.pollIntervalMs = Math.max(50, options.pollIntervalMs ?? 250);
  }

  async stopForConnectorUpdate(): Promise<NeteaseUpdateProcessSession> {
    let processes: NeteaseProcessInfo[];
    try {
      processes = await this.runtime.listProcesses();
    } catch (error: unknown) {
      throw new NeteaseProcessControlError(
        `无法检测网易云进程：${getErrorMessage(error)}`
      );
    }
    if (processes.length === 0) {
      return {
        wasRunning: false,
        executablePath: null,
        processIds: []
      };
    }

    const executablePath = selectNeteaseRestartExecutable(
      processes,
      filePath => this.runtime.fileExists(filePath)
    );
    if (!executablePath) {
      throw new NeteaseProcessControlError(
        '检测到网易云正在运行，但无法读取其程序路径；'
        + '请手动完全退出网易云后再更新连接器'
      );
    }

    const originalProcessIds = processes.map(item => item.processId);
    this.onLog(
      '[网易云连接器更新] 检测到网易云正在运行，'
      + '安装前将临时关闭播放器以释放 CEF 桥 DLL'
    );
    try {
      await this.runtime.closeProcessTrees(
        selectNeteaseRootProcessIds(processes),
        false
      );
      processes = await this.waitForPresence(false, this.gracefulTimeoutMs);

      if (processes.length > 0) {
        this.onLog(
          '[网易云连接器更新] 网易云仍在后台运行，正在结束残留进程'
        );
        await this.runtime.closeProcessTrees(
          selectNeteaseRootProcessIds(processes),
          true
        );
        processes = await this.waitForPresence(false, this.forceTimeoutMs);
      }

      if (processes.length > 0) {
        throw new NeteaseProcessControlError(
          '网易云仍在运行，可能与点歌机权限不同或被安全软件保护；'
          + '请手动完全退出网易云后重试'
        );
      }
    } catch (error: unknown) {
      await this.restoreAfterPreparationFailure(executablePath);
      if (error instanceof NeteaseProcessControlError) throw error;
      throw new NeteaseProcessControlError(
        `关闭网易云失败：${getErrorMessage(error)}`
      );
    }

    this.onLog('[网易云连接器更新] 网易云已退出，可以安全替换连接器');
    return {
      wasRunning: true,
      executablePath,
      processIds: originalProcessIds
    };
  }

  async restartAfterConnectorUpdate(
    session: NeteaseUpdateProcessSession
  ): Promise<boolean> {
    if (!session.wasRunning || !session.executablePath) return false;

    let running: NeteaseProcessInfo[];
    try {
      running = await this.runtime.listProcesses();
    } catch (error: unknown) {
      throw new NeteaseProcessControlError(
        `无法确认网易云是否已经恢复：${getErrorMessage(error)}`
      );
    }
    if (running.length === 0) {
      try {
        await this.runtime.launch(session.executablePath);
      } catch (error: unknown) {
        throw new NeteaseProcessControlError(
          `无法重新启动网易云：${getErrorMessage(error)}`
        );
      }
      running = await this.waitForPresence(true, this.restartTimeoutMs);
    }

    if (running.length === 0) {
      throw new NeteaseProcessControlError(
        '未检测到重新启动的网易云，请手动打开播放器'
      );
    }
    this.onLog('[网易云连接器更新] 已自动重新启动网易云音乐');
    return true;
  }

  private async waitForPresence(
    expectedRunning: boolean,
    timeoutMs: number
  ): Promise<NeteaseProcessInfo[]> {
    let elapsed = 0;
    for (;;) {
      const processes = await this.runtime.listProcesses();
      if ((processes.length > 0) === expectedRunning) return processes;
      if (elapsed >= timeoutMs) return processes;
      const waitMs = Math.min(this.pollIntervalMs, timeoutMs - elapsed);
      await this.runtime.wait(waitMs);
      elapsed += waitMs;
    }
  }

  private async restoreAfterPreparationFailure(
    executablePath: string
  ): Promise<void> {
    try {
      const running = await this.runtime.listProcesses();
      if (running.length > 0) return;
    } catch {
      // If inspection itself failed after shutdown, launching the single-
      // instance player is safer than silently leaving it closed.
    }
    try {
      await this.runtime.launch(executablePath);
      this.onLog(
        '[网易云连接器更新] 安装准备失败，已尝试恢复网易云音乐'
      );
    } catch (error: unknown) {
      this.onLog(
        '[网易云连接器更新] 安装准备失败且播放器恢复失败：'
        + getErrorMessage(error)
      );
    }
  }
}

class WindowsNeteaseProcessRuntime implements NeteaseProcessRuntime {
  async listProcesses(): Promise<NeteaseProcessInfo[]> {
    if (process.platform !== 'win32') return [];
    const systemRoot = process.env.SystemRoot || 'C:\\Windows';
    const powershell = path.join(
      systemRoot,
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe'
    );
    const script = [
      "$ErrorActionPreference='Stop'",
      '[Console]::OutputEncoding = '
        + 'New-Object System.Text.UTF8Encoding($false)',
      '$items = @(Get-CimInstance Win32_Process '
        + '-Filter "Name = \'cloudmusic.exe\'" | ForEach-Object { '
        + '[pscustomobject]@{ processId = [int]$_.ProcessId; '
        + 'parentProcessId = [int]$_.ParentProcessId; '
        + 'executablePath = [string]$_.ExecutablePath; '
        + 'commandLine = [string]$_.CommandLine } })',
      'ConvertTo-Json -InputObject $items -Compress'
    ].join('; ');
    const result = await executeFileText(
      powershell,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
      8000
    );
    return parseNeteaseProcessList(result.stdout);
  }

  async closeProcessTrees(
    processIds: number[],
    force: boolean
  ): Promise<void> {
    if (process.platform !== 'win32') return;
    const systemRoot = process.env.SystemRoot || 'C:\\Windows';
    const taskkill = path.join(systemRoot, 'System32', 'taskkill.exe');
    await Promise.all(processIds.map(async processId => {
      const args = ['/PID', String(processId), '/T'];
      if (force) args.push('/F');
      try {
        await executeFileText(taskkill, args, 8000);
      } catch {
        // A process can disappear between discovery and taskkill. The caller
        // verifies the complete process list after every close attempt.
      }
    }));
  }

  async launch(executablePath: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(executablePath, [], {
        cwd: path.dirname(executablePath),
        detached: true,
        stdio: 'ignore'
      });
      child.once('error', reject);
      child.once('spawn', () => {
        child.unref();
        resolve();
      });
    });
  }

  fileExists(filePath: string): boolean {
    return fs.existsSync(filePath);
  }

  async wait(milliseconds: number): Promise<void> {
    await new Promise<void>(resolve => setTimeout(resolve, milliseconds));
  }
}

function executeFileText(
  executable: string,
  args: string[],
  timeout: number
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      args,
      {
        encoding: 'utf8',
        windowsHide: true,
        timeout,
        maxBuffer: 1024 * 1024
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(
            String(stderr || stdout || error.message).trim()
          ));
          return;
        }
        resolve({ stdout, stderr });
      }
    );
  });
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
