import { app, BrowserWindow, dialog, ipcMain, session, shell } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import http from 'http';
import fs from 'fs';
import os from 'os';
import zlib from 'zlib';
import { randomBytes } from 'crypto';
import { createRequire } from 'module';
import { WebSocket, WebSocketServer } from 'ws';
import QRCode from 'qrcode';
import {
  planImmediatePlaybackCommand,
  planManagedActionTimeout,
  planObservedNextAction,
  planQueueHeadMutation,
  queueSongIdentity,
  shouldDeferManagedTrackObservation,
  shouldPreserveGuardAfterImmediate,
  tracksRepresentSameSong
} from './queue-head-policy';
import type { NextObservation } from './queue-head-policy';
import {
  markAppUpdateApplying,
  markAppUpdateExitRequested,
  markAppUpdateRetryable,
  markAppUpdateStarted,
  planAppUpdateRequest,
  shouldAllowMultipleInstances,
  shouldRequestAppQuit,
  type AppUpdatePhase
} from './app-update-policy';
import {
  CONNECTOR_AUTO_REPAIR_MESSAGES,
  planConnectorAutoRepair
} from './connector-auto-repair-policy';
import {
  isLoopbackRemoteAddress,
  normalizeLocalSongKeyword,
  normalizeLocalSongRequestMode
} from './local-test-api-policy';
import type { LocalSongRequestMode } from './local-test-api-policy';
import {
  getNeteaseSongCover
} from './players/netease-player';
import { PlayerManager } from './players/player-manager';
import type { NativeConnectorId } from './connector-updater';
import {
  getFeedbackStatus,
  sanitizeFeedbackLog,
  submitFeedback
} from './feedback-service';
import {
  checkFeedbackSubmissionEvidence,
  isTechnicalFeedbackCategory
} from '../src/feedback-submission-policy';
import { buildExternalApiState } from './external-api-state';
import {
  addGiftRequestCredits,
  canRequestWithGiftCredits,
  consumeGiftRequestCredit,
  createEmptyGiftRequestRequirements,
  describeGiftRequestRequirement,
  giftRequestTierFromGuardLevel,
  giftRequestTierLabel,
  matchesGiftRequestRequirement,
  normalizeLearnedGifts,
  normalizeGiftRequestRequirements,
  parseBilibiliGiftCreditEvent,
  rememberLearnedGift,
  type BilibiliGiftCreditEvent,
  type GiftRequestRequirement,
  type LearnedGift
} from './gift-request-credit-policy';
import {
  MAX_OVERLAY_ARCHIVE_BYTES,
  OverlayModManager
} from './overlay-mod-manager';
import {
  isAllowedSkinMarketplaceOrigin,
  validateSkinMarketplaceDownloadUrl
} from './skin-marketplace-policy';
import { shouldShowWelcomeHint } from './welcome-hint-policy';
import {
  buildPlayerProcessAccessHint,
  buildPlayerUpgradeHint,
  isUpgradeSensitivePlayerCommand,
  type PlayerProcessAccessHint,
  type PlayerUpgradeHint
} from './player-upgrade-hint-policy';
import {
  isQqPlaybackAnchorMissing,
  planQqDeferredPlaybackAction,
  planQqAnchorObservation,
  shouldDeferQqQueueHeadUntilAnchor,
  shouldSkipDuplicateQqAnchorInsert,
  shouldSuppressQqQueueHeadPlayNow
} from './qq-playback-anchor-policy';
import {
  DEFAULT_OVERLAY_ALWAYS_ON_TOP,
  normalizeOverlayAlwaysOnTop
} from './overlay-window-policy';
import {
  fetchBiliDanmuInfoWithFallback
} from './bili-wbi';
import {
  BILI_ROOM_CONNECTION_MESSAGES,
  createBiliRoomConnectionState,
  reduceBiliRoomConnectionState,
  type BiliRoomConnectionEvent,
  type BiliRoomConnectionState
} from './bili-room-connection-policy';
import {
  isSuccessfulPlayerResult,
  PLAYER_LABELS,
  playerKeyFromConfig,
  type PlayerKey,
  type PlayerOperationResult,
  type PlayerSnapshot
} from './players/types';
import {
  buildLocalApiOrigin,
  DEFAULT_EXTERNAL_API_PORT,
  DEFAULT_INTERNAL_API_PORT,
  listenLoopbackWithFallback,
  MAX_LOCAL_API_PORT,
  MIN_LOCAL_API_PORT,
  normalizeLocalApiPort
} from './internal-api-port';
// ⭐ 动态引入 Velopack 规避静态打包分析
const customRequire = createRequire(import.meta.url);
const { UpdateManager } = customRequire('velopack');

let applicationQuitRequested = false;

function requestApplicationQuit(): boolean {
  if (!shouldRequestAppQuit(applicationQuitRequested)) return false;
  applicationQuitRequested = true;
  app.quit();
  return true;
}

// 1.1 起底层包名与仓库改为 Awoo MusicBot；面向用户仍使用“嗷呜点歌机”。
// 继续沿用旧用户数据目录，确保升级时保留登录信息、播放器选择和连接器安装状态。
if (process.platform === 'win32') {
  app.setPath(
    'userData',
    path.join(app.getPath('appData'), '嗷呜点歌机')
  );
}

// Production builds share one user-data directory and must have only one
// updater owner.  The regular Electron runner and build:dev output are
// explicitly exempt so a development build can be tested beside production;
// copied dev builds can also opt in with --allow-multiple-instances (or
// AWOO_ALLOW_MULTIPLE_INSTANCES=1).
const allowMultipleInstances = shouldAllowMultipleInstances(
  process.argv,
  process.env,
  process.execPath,
  app.isPackaged
);
const hasSingleInstanceLock = allowMultipleInstances
  || app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) requestApplicationQuit();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ENV_INTERNAL_API_PORT = normalizeLocalApiPort(
  process.env['AWOO_INTERNAL_API_PORT'] || process.env['BILINCM_INTERNAL_PORT'],
  DEFAULT_INTERNAL_API_PORT
);
const DEFAULT_FETCH_TIMEOUT_MS = 10_000;
const INTERNAL_API_BROWSER_TOKEN = randomBytes(32).toString('base64url');
let requestedInternalApiPort = ENV_INTERNAL_API_PORT;
let configuredInternalApiPort = ENV_INTERNAL_API_PORT;
let actualInternalApiPort: number | null = null;
let internalApiServer: http.Server | null = null;
let internalApiFallbackReason: 'conflict' | 'reserved' | null = null;
let overlayModManager: OverlayModManager | null = null;
let skinMarketplaceInstallInProgress = false;

function getOverlayModManager(): OverlayModManager {
  if (!overlayModManager) {
    overlayModManager = new OverlayModManager(
      path.join(app.getPath('userData'), 'overlay-mods'),
      path.join(app.getAppPath(), 'examples', 'obs-overlay'),
      app.getVersion(),
      fetchWithTimeout
    );
  }
  return overlayModManager;
}

async function fetchWithTimeout(
  input: string | URL | Request,
  init: RequestInit = {},
  timeoutMs = DEFAULT_FETCH_TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const abortFromCaller = () => controller.abort();
  init.signal?.addEventListener('abort', abortFromCaller, { once: true });
  try {
    return await fetch(input, {
      ...init,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
    init.signal?.removeEventListener('abort', abortFromCaller);
  }
}

// ==========================================
// 全局日志系统
// ==========================================
interface SysLog {
  Time: string;
  Color: string;
  Message: string;
}

const sysLogs: SysLog[] = [];
let currentStatusMessage: string = '点歌就绪';
let connectorMaintenanceStatus = '';
let connectorMaintenanceStatusOwner = 0;
let connectorMaintenanceStatusSequence = 0;
let statusClearTimer: NodeJS.Timeout | null = null;
let isPlayerConnected: boolean = false;
let playerConnectionRecoverySuppressed = 0;
let playerConnectionRecoverySuppressionEpoch = 0;

async function withPlayerConnectionRecoverySuppressed<T>(
  operation: () => Promise<T>
): Promise<T> {
  playerConnectionRecoverySuppressed++;
  playerConnectionRecoverySuppressionEpoch++;
  try {
    return await operation();
  } finally {
    playerConnectionRecoverySuppressed = Math.max(
      0,
      playerConnectionRecoverySuppressed - 1
    );
    playerConnectionRecoverySuppressionEpoch++;
  }
}

type AppUpdateDownloadState =
  | 'idle'
  | 'checking'
  | 'downloading'
  | 'applying'
  | 'no-update'
  | 'error';

interface AppUpdateDownloadStatus {
  state: AppUpdateDownloadState;
  progress: number | null;
  version: string | null;
  message: string;
  updatedAt: string;
}

let appUpdateDownloadStatus: AppUpdateDownloadStatus = {
  state: 'idle',
  progress: null,
  version: null,
  message: '',
  updatedAt: new Date().toISOString()
};
let appUpdatePhase: AppUpdatePhase = 'idle';
let appUpdateOperation: Promise<void> | null = null;

function setAppUpdateDownloadStatus(
  patch: Partial<Omit<AppUpdateDownloadStatus, 'updatedAt'>>
): void {
  appUpdateDownloadStatus = {
    ...appUpdateDownloadStatus,
    ...patch,
    updatedAt: new Date().toISOString()
  };
}

function setGlobalStatus(msg: string) {
  currentStatusMessage = msg;
  if (statusClearTimer) clearTimeout(statusClearTimer);
  statusClearTimer = setTimeout(() => {
    currentStatusMessage = '点歌就绪';
  }, 4000);
}

function claimConnectorMaintenanceStatus(message: string): number {
  const owner = ++connectorMaintenanceStatusSequence;
  connectorMaintenanceStatusOwner = owner;
  connectorMaintenanceStatus = message;
  return owner;
}

function releaseConnectorMaintenanceStatus(owner: number): void {
  if (!owner || connectorMaintenanceStatusOwner !== owner) return;
  connectorMaintenanceStatusOwner = 0;
  connectorMaintenanceStatus = '';
}

function writeLog(message: string, color: string = 'Gray') {
  console.log(`[${color}] ${message}`);
  sysLogs.push({
    Time: new Date().toLocaleTimeString(),
    Color: color,
    Message: message
  });
  if (sysLogs.length > 100) sysLogs.shift();
}

function startAppUpdateOperation(): boolean {
  if (
    appUpdateOperation
    || planAppUpdateRequest(appUpdatePhase) === 'already-running'
  ) {
    return false;
  }
  appUpdatePhase = markAppUpdateStarted();
  appUpdateOperation = (async () => {
    try {
      setAppUpdateDownloadStatus({
        state: 'checking',
        progress: 0,
        version: null,
        message: '正在确认更新版本'
      });
      const updateManager = new UpdateManager(
        'https://app.enkianss.us/update/awoo'
      );
      const updateInfo = await updateManager.checkForUpdatesAsync();
      if (!updateInfo) {
        appUpdatePhase = markAppUpdateRetryable();
        setAppUpdateDownloadStatus({
          state: 'no-update',
          progress: null,
          version: null,
          message: '当前已经是最新版本'
        });
        return;
      }

      const version = String(
        updateInfo.TargetFullRelease?.Version || ''
      ) || null;
      let lastLoggedBucket = -1;
      setAppUpdateDownloadStatus({
        state: 'downloading',
        progress: 0,
        version,
        message: '正在下载更新'
      });
      setGlobalStatus('🚀 下载更新中...');
      await updateManager.downloadUpdateAsync(
        updateInfo,
        (rawProgress: number) => {
          const progress = Math.max(
            0,
            Math.min(100, Math.floor(Number(rawProgress) || 0))
          );
          setAppUpdateDownloadStatus({
            state: 'downloading',
            progress,
            version,
            message: '正在下载更新'
          });
          const bucket = Math.floor(progress / 10);
          if (bucket > lastLoggedBucket) {
            lastLoggedBucket = bucket;
            writeLog(`[更新] 真实下载进度: ${progress}%`, 'DarkGray');
          }
        }
      );
      setAppUpdateDownloadStatus({
        state: 'applying',
        progress: 100,
        version,
        message: '下载完成，正在重启安装'
      });
      appUpdatePhase = markAppUpdateApplying();
      updateManager.waitExitThenApplyUpdate(updateInfo, false, true);
      // Velopack owns the one final restart.  Keep the phase latched after
      // this point so duplicate HTTP requests cannot start another updater.
      appUpdatePhase = markAppUpdateExitRequested();
      requestApplicationQuit();
    } catch (error: unknown) {
      appUpdatePhase = markAppUpdateRetryable();
      const message = error instanceof Error
        ? error.message
        : String(error);
      setAppUpdateDownloadStatus({
        state: 'error',
        progress: null,
        version: null,
        message: `更新失败：${message}`
      });
      setGlobalStatus('❌ 更新失败');
      writeLog(`[更新] ${message}`, 'Red');
    }
  })().finally(() => {
    // Once Velopack owns the final restart, keep both gates closed until this
    // old process has actually exited. Failed/no-update attempts are retryable.
    if (appUpdatePhase !== 'exit-requested') {
      appUpdateOperation = null;
    }
  });
  return true;
}

process.on('uncaughtException', (err) => {
  writeLog(`❌ [主进程致命错误]: ${err.message}`, 'Red');
});

process.on('unhandledRejection', (reason) => {
  if (String(reason).includes('could not be cloned')) return;
  writeLog(`⚠️ [未捕获的 Promise 异常]: ${reason}`, 'Yellow');
});

let overlayWindow: BrowserWindow | null = null;
let adminWindow: BrowserWindow | null = null;
let overlayAlwaysOnTop = DEFAULT_OVERLAY_ALWAYS_ON_TOP;

function getOverlayAlwaysOnTop(): boolean {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    try {
      overlayAlwaysOnTop = overlayWindow.isAlwaysOnTop();
    } catch {
      // Keep the last known preference if Electron cannot query the window.
    }
  }
  return overlayAlwaysOnTop;
}

function syncOverlayAlwaysOnTop(): boolean {
  const preferredState = normalizeOverlayAlwaysOnTop(overlayAlwaysOnTop);
  overlayAlwaysOnTop = preferredState;
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    try {
      overlayWindow.setAlwaysOnTop(preferredState);
      overlayAlwaysOnTop = overlayWindow.isAlwaysOnTop();
    } catch {
      // Keep the preference stable if the native window is being torn down.
    }
  }
  return overlayAlwaysOnTop;
}

function setAdminWindowTopmost(enabled: boolean): void {
  if (!adminWindow || adminWindow.isDestroyed()) return;
  try {
    adminWindow.setAlwaysOnTop(enabled);
  } catch {
    // Ignore teardown races while the control panel is closing.
  }
}

function setOverlayAlwaysOnTop(value: unknown): boolean {
  const previousState = getOverlayAlwaysOnTop();
  const requestedState = normalizeOverlayAlwaysOnTop(value);
  let actualState = requestedState;

  if (overlayWindow && !overlayWindow.isDestroyed()) {
    try {
      overlayWindow.setAlwaysOnTop(requestedState);
      actualState = overlayWindow.isAlwaysOnTop();
    } catch {
      actualState = previousState;
    }
  }

  overlayAlwaysOnTop = actualState;
  if (!appConfig.widgetStyle || typeof appConfig.widgetStyle !== 'object' || Array.isArray(appConfig.widgetStyle)) {
    appConfig.widgetStyle = {};
  }
  appConfig.widgetStyle.alwaysOnTop = actualState;
  saveConfig();
  return actualState;
}

function presentAdminWindow() {
  if (!adminWindow || adminWindow.isDestroyed()) return;
  syncOverlayAlwaysOnTop();
  if (adminWindow.isMinimized()) adminWindow.restore();
  // Keep the control panel usable while it has focus without changing the
  // user's persisted pin preference for the request overlay.
  setAdminWindowTopmost(true);
  adminWindow.show();
  adminWindow.moveTop();
  adminWindow.focus();
}

function focusExistingWindow(): void {
  if (adminWindow && !adminWindow.isDestroyed()) {
    presentAdminWindow();
    return;
  }
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    if (overlayWindow.isMinimized()) overlayWindow.restore();
    overlayWindow.show();
    syncOverlayAlwaysOnTop();
    overlayWindow.moveTop();
    overlayWindow.focus();
    return;
  }
  if (app.isReady()) createOverlayWindow();
}

if (hasSingleInstanceLock && !allowMultipleInstances) {
  app.on('second-instance', () => {
    focusExistingWindow();
  });
}

function getDevUrl(): string | undefined {
  return process.env['VITE_DEV_SERVER_URL'] || process.env['ELECTRON_RENDERER_URL'];
}

function parseQuery(qs: string): Record<string, string> {
  const result: Record<string, string> = {};
  qs.split('&').forEach(pair => {
    const [k, v] = pair.split('=');
    if (k) result[k] = v ?? 'true';
  });
  return result;
}

function loadWindow(win: BrowserWindow, queryParams: string) {
  const devUrl = getDevUrl();
  if (devUrl) {
    const sep = devUrl.includes('?') ? '&' : '?';
    win.loadURL(`${devUrl}${sep}${queryParams}`);
  } else {
    const indexPath = path.join(__dirname, '../dist/index.html');
    win.loadFile(indexPath, { query: parseQuery(queryParams) }).catch(() => {
      win.loadFile(path.join(__dirname, '../renderer/index.html'), { query: parseQuery(queryParams) });
    });
  }
}

const DEFAULT_OVERLAY_SIZE = { width: 400, height: 580 };
const MIN_OVERLAY_SIZE = { width: 280, height: 380 };

function normalizeWindowDimension(value: unknown, fallback: number, minimum: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(minimum, Math.round(value))
    : fallback;
}

function getSavedOverlaySize() {
  const savedSize = appConfig.widgetStyle?.size;
  return {
    width: normalizeWindowDimension(savedSize?.w, DEFAULT_OVERLAY_SIZE.width, MIN_OVERLAY_SIZE.width),
    height: normalizeWindowDimension(savedSize?.h, DEFAULT_OVERLAY_SIZE.height, MIN_OVERLAY_SIZE.height)
  };
}

function createOverlayWindow() {
  const { width, height } = getSavedOverlaySize();
  overlayWindow = new BrowserWindow({
    width, height, minWidth: MIN_OVERLAY_SIZE.width, minHeight: MIN_OVERLAY_SIZE.height,
    show: false,
    frame: false, transparent: true, hasShadow: false,
    backgroundColor: '#00000000', alwaysOnTop: overlayAlwaysOnTop,
    resizable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.mjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  });
  syncOverlayAlwaysOnTop();
  const initialWindow = overlayWindow;
  initialWindow.once('ready-to-show', () => {
    if (!initialWindow.isDestroyed()) initialWindow.show();
  });
  loadWindow(overlayWindow, 'mode=electron');
  overlayWindow.on('closed', () => { overlayWindow = null; requestApplicationQuit(); });
}

function createAdminWindow(initialTab?: unknown) {
  const tab = initialTab === 'appearance' ? 'appearance' : '';
  if (adminWindow && !adminWindow.isDestroyed()) {
    presentAdminWindow();
    if (tab) adminWindow.webContents.send('admin-navigate', tab);
    return;
  }
  adminWindow = new BrowserWindow({
    width: 900, height: 640, minWidth: 600, minHeight: 420,
    autoHideMenuBar: true, titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#0d1117', symbolColor: '#ffffff' },
    backgroundColor: '#0d1117', resizable: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.mjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  });
  adminWindow.once('ready-to-show', () => {
    presentAdminWindow();
  });
  loadWindow(adminWindow, `admin=true${tab ? `&tab=${tab}` : ''}`);
  adminWindow.on('focus', () => setAdminWindowTopmost(true));
  adminWindow.on('blur', () => setAdminWindowTopmost(false));
  adminWindow.on('minimize', () => {
    setAdminWindowTopmost(false);
    syncOverlayAlwaysOnTop();
  });
  adminWindow.on('restore', presentAdminWindow);
  adminWindow.on('closed', () => {
    setAdminWindowTopmost(false);
    adminWindow = null;
    syncOverlayAlwaysOnTop();
  });
}

function getInternalApiOrigin(): string {
  return actualInternalApiPort === null
    ? ''
    : buildLocalApiOrigin(actualInternalApiPort);
}

function getInternalApiInfo() {
  return {
    requestedPort: requestedInternalApiPort,
    configuredPort: configuredInternalApiPort,
    actualPort: actualInternalApiPort,
    origin: getInternalApiOrigin(),
    fallback: actualInternalApiPort !== null
      && actualInternalApiPort !== requestedInternalApiPort,
    fallbackReason: internalApiFallbackReason,
    restartRequired: configuredInternalApiPort !== requestedInternalApiPort
  };
}

function isActualInternalApiOrigin(origin: string | undefined): boolean {
  if (!origin || actualInternalApiPort === null) return false;
  try {
    const parsed = new URL(origin);
    const port = Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80));
    return parsed.protocol === 'http:'
      && (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost')
      && port === actualInternalApiPort;
  } catch {
    return false;
  }
}

ipcMain.on('get-internal-api-origin', event => {
  event.returnValue = getInternalApiOrigin();
});

ipcMain.on('get-overlay-always-on-top', event => {
  event.returnValue = getOverlayAlwaysOnTop();
});

ipcMain.on('set-overlay-always-on-top', (event, value) => {
  const senderWindow = BrowserWindow.fromWebContents(event.sender);
  if (senderWindow !== overlayWindow) {
    event.returnValue = getOverlayAlwaysOnTop();
    return;
  }
  event.returnValue = setOverlayAlwaysOnTop(value);
});

ipcMain.on('open-admin', (_event, tab) => createAdminWindow(tab));
ipcMain.handle('open-external', async (_event, value) => {
  let target: URL;
  try {
    target = new URL(String(value || ''));
  } catch {
    throw new Error('外部链接无效');
  }
  if (!isAllowedSkinMarketplaceOrigin(target.origin)) {
    throw new Error('只允许打开官方嗷呜皮肤站');
  }
  await shell.openExternal(target.toString());
});
ipcMain.on('close-window', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) { if (win === overlayWindow) requestApplicationQuit(); else win.close(); }
});
ipcMain.on('minimize-window', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) { win.minimize(); }
});
ipcMain.on('overlay-resize', (event, w, h) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win && win === overlayWindow) {
    const currentBounds = win.getBounds();
    const width = normalizeWindowDimension(w, currentBounds.width, MIN_OVERLAY_SIZE.width);
    const height = normalizeWindowDimension(h, currentBounds.height, MIN_OVERLAY_SIZE.height);
    win.setBounds({ width, height });

    const resizedBounds = win.getBounds();
    if (!appConfig.widgetStyle || typeof appConfig.widgetStyle !== 'object') {
      appConfig.widgetStyle = { theme: null, pos: { x: 50, y: 50 }, size: { w: resizedBounds.width, h: resizedBounds.height }, timestamp: Date.now(), alwaysOnTop: overlayAlwaysOnTop };
    } else {
      appConfig.widgetStyle.size = { w: resizedBounds.width, h: resizedBounds.height };
      appConfig.widgetStyle.timestamp = Date.now();
      appConfig.widgetStyle.alwaysOnTop = overlayAlwaysOnTop;
    }
    saveConfig();
  }
});

const CONFIG_PATH = path.join(app.getPath('userData'), 'bili_bot_config.json');
const CONFIG_EXISTED_AT_STARTUP = fs.existsSync(CONFIG_PATH);
const WELCOME_HINT_SENTINEL_PATH = path.join(
  app.getPath('userData'),
  'welcome-hint-shown-v1'
);

let appConfig: any = {
  roomId: 0,
  roomConnectionEnabled: false,
  myRoomId: 0,
  biliCookie: '',
  biliUid: 0,
  learnedGifts: [],
  widgetStyle: null,
  sysConfig: {
    PlayerType: 'NCM',
    FoliaToken: '',
    Cooldowns: { Normal: 0, Captain: 0, Admiral: 0, Governor: 0 },
    GiftRequestRequirements: createEmptyGiftRequestRequirements(),
    IdleWaitNext: true,
    ShowPlayerCurrentTrack: true,
    PauseAfterRequests: false,
    RequestedSongArtwork: 'bili_avatar',
    ShowAllDanmaku: false,
    SuperUsers: [],
    ExternalHttpEnabled: false,
    ExternalWebSocketEnabled: false,
    ExternalApiPort: DEFAULT_EXTERNAL_API_PORT,
    InternalApiPort: ENV_INTERNAL_API_PORT
  }
};

let biliRoomState: BiliRoomConnectionState = createBiliRoomConnectionState();

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const saved = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
      appConfig = { ...appConfig, ...saved };

      // Older configs had no explicit connection switch. Preserve their
      // previous behaviour only when a room was already configured; a user
      // who has explicitly disconnected in a newer config stays disconnected
      // across restarts.
      const hasRoomConnectionEnabled = Boolean(
        saved
        && Object.prototype.hasOwnProperty.call(
          saved,
          'roomConnectionEnabled'
        )
      );
      appConfig.roomConnectionEnabled = hasRoomConnectionEnabled
        ? saved.roomConnectionEnabled === true
        : Number(appConfig.roomId) > 0;
      biliRoomState = createBiliRoomConnectionState(appConfig.roomId);

      if (!appConfig.widgetStyle || typeof appConfig.widgetStyle !== 'object' || Array.isArray(appConfig.widgetStyle)) {
        appConfig.widgetStyle = {};
      }
      overlayAlwaysOnTop = normalizeOverlayAlwaysOnTop(appConfig.widgetStyle.alwaysOnTop);
      appConfig.widgetStyle.alwaysOnTop = overlayAlwaysOnTop;

      if (!appConfig.sysConfig) {
        appConfig.sysConfig = { PlayerType: 'NCM', FoliaToken: '', Cooldowns: { Normal: 0, Captain: 0, Admiral: 0, Governor: 0 }, GiftRequestRequirements: createEmptyGiftRequestRequirements(), IdleWaitNext: true, ShowPlayerCurrentTrack: true, PauseAfterRequests: false, RequestedSongArtwork: 'bili_avatar', ShowAllDanmaku: false, SuperUsers: appConfig.superUsers || [], ExternalHttpEnabled: false, ExternalWebSocketEnabled: false, ExternalApiPort: DEFAULT_EXTERNAL_API_PORT, InternalApiPort: ENV_INTERNAL_API_PORT };
      }
      if (!['NCM', 'Kugou', 'QQMusic', 'Folia'].includes(appConfig.sysConfig.PlayerType)) appConfig.sysConfig.PlayerType = 'NCM';
      if (appConfig.sysConfig.FoliaToken === undefined) appConfig.sysConfig.FoliaToken = '';
      if (appConfig.sysConfig.ShowPlayerCurrentTrack === undefined) appConfig.sysConfig.ShowPlayerCurrentTrack = true;
      if (appConfig.sysConfig.PauseAfterRequests === undefined) appConfig.sysConfig.PauseAfterRequests = false;
      if (!['bili_avatar', 'song_cover'].includes(appConfig.sysConfig.RequestedSongArtwork)) appConfig.sysConfig.RequestedSongArtwork = 'bili_avatar';
      if (appConfig.sysConfig.ExternalHttpEnabled === undefined) appConfig.sysConfig.ExternalHttpEnabled = false;
      if (appConfig.sysConfig.ExternalWebSocketEnabled === undefined) appConfig.sysConfig.ExternalWebSocketEnabled = false;
      appConfig.sysConfig.InternalApiPort = normalizeLocalApiPort(
        appConfig.sysConfig.InternalApiPort,
        ENV_INTERNAL_API_PORT
      );
      configuredInternalApiPort = appConfig.sysConfig.InternalApiPort;
      requestedInternalApiPort = configuredInternalApiPort;
      const apiPort = Number(appConfig.sysConfig.ExternalApiPort);
      appConfig.sysConfig.ExternalApiPort = (
        Number.isInteger(apiPort)
        && apiPort >= 1024
        && apiPort <= 65535
      ) ? apiPort : DEFAULT_EXTERNAL_API_PORT;
      delete appConfig.sysConfig.EnableCDP;
      delete appConfig.sysConfig.CdpPort;
      delete appConfig.sysConfig.NcmExePath;

      if (appConfig.sysConfig.CooldownMinutes !== undefined && !appConfig.sysConfig.Cooldowns) {
        const oldSecs = appConfig.sysConfig.CooldownMinutes * 60;
        appConfig.sysConfig.Cooldowns = { Normal: oldSecs, Captain: oldSecs, Admiral: oldSecs, Governor: oldSecs };
        delete appConfig.sysConfig.CooldownMinutes;
      }
      appConfig.sysConfig.GiftRequestRequirements =
        normalizeGiftRequestRequirements(
          appConfig.sysConfig.GiftRequestRequirements
        );
      appConfig.learnedGifts = normalizeLearnedGifts(
        appConfig.learnedGifts
      );

      biliCookie = appConfig.biliCookie || '';
      biliUid = appConfig.biliUid || 0;
      writeLog(`✅ 已加载本地配置，当前缓存的直播间为: ${appConfig.roomId}`, 'Green');
      if (!hasRoomConnectionEnabled) saveConfig();
    }
  } catch { writeLog('加载配置失败', 'Red'); }
}

function saveConfig() {
  try {
    appConfig.biliCookie = biliCookie;
    appConfig.biliUid = biliUid;
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(appConfig, null, 2));
  } catch { writeLog('保存配置失败', 'Red'); }
}

let isAccepting = true;
let isPlaying = true;
let skipForcePlayOnce = false;
let biliCookie = "";
let biliUid = 0;

function createEmptyBiliUserInfo() {
  return { uid: 0, uname: '', face: '', level: 0, myRoomId: 0, followerCount: 0, guardCount: 0, fanClubCount: 0 };
}

ipcMain.handle('claim-welcome-hint', (_event, legacyHintWasShown) => {
  const alreadyShown = fs.existsSync(WELCOME_HINT_SENTINEL_PATH);
  const shouldShow = shouldShowWelcomeHint({
    alreadyShown,
    configExistedAtStartup: CONFIG_EXISTED_AT_STARTUP,
    legacyHintWasShown: legacyHintWasShown === true
  });

  if (!alreadyShown) {
    try {
      fs.writeFileSync(WELCOME_HINT_SENTINEL_PATH, 'shown\n', { flag: 'wx' });
    } catch (error: any) {
      if (error?.code !== 'EEXIST') {
        writeLog('[界面] 无法保存首次欢迎提示状态', 'Yellow');
      }
    }
  }
  return shouldShow;
});

let currentUserInfo: any = createEmptyBiliUserInfo();

function isBiliLoginReady(): boolean {
  return Boolean(biliCookie && biliUid > 0 && currentUserInfo.uid === biliUid);
}

let qrCodeBase64 = "";
let qrLoginStatus = "等待获取二维码...";
let isQrLoggingIn = false;
let qrPollTimer: NodeJS.Timeout | null = null;
let qrLoginAttemptId = 0;

let targetQueue: any[] = [];
let currentPlayingSong: any = null;
let playerCurrentTrack: any = null;
let playerPausedAfterRequests = false;
let isPausingAfterRequests = false;
let lastQueueActionTime = 0; // 全局队列操作防抖冷却时间
let activePlayerSnapshot: PlayerSnapshot | null = null;
let playerConnecting = false;
type PlayerControlHint = PlayerUpgradeHint | PlayerProcessAccessHint;
type PlayerControlNotice = PlayerControlHint & { detectedAt: string };
let playerControlNotice: PlayerControlNotice | null = null;
let registeredNextGuardKey = '';
let registeredNextGuardSongIdentity = '';
let queueHeadNeedsGuardOnlyAfterCurrentChange = false;
let deferredQqInsertIdentity = '';
let qqDeferredInsertRetryAttempted = false;
let qqDeferredInsertRetryInFlight = false;
const cancelledNativeNextSongs = new Map<string, any>();
let nextGuardOperationTail: Promise<void> = Promise.resolve();
let managedPlayerActionSequence = 0;
let localTestRequestSequence = 0;
let localTestRequestTail: Promise<void> = Promise.resolve();

interface ManagedPlayerAction {
  id: number;
  kind: 'play-now' | 'interrupt';
  target: any;
  command: 'PlaySelected' | 'InterruptSelected';
  startedAt: number;
  expiresAt: number;
  inFlight: boolean;
  targetObserved: boolean;
  previousCurrentPlayingSong: any;
}

let activeManagedPlayerAction: ManagedPlayerAction | null = null;

function getSelectedPlayerKey(): PlayerKey {
  return playerKeyFromConfig(appConfig.sysConfig?.PlayerType);
}

function getSelectedPlayerLabel(): string {
  return PLAYER_LABELS[getSelectedPlayerKey()];
}

function shouldDeferQqQueueHeadForMissingAnchor(
  playbackAnchorReady = activePlayerSnapshot?.playbackAnchorReady === true
): boolean {
  return shouldDeferQqQueueHeadUntilAnchor({
    playerKey: getSelectedPlayerKey(),
    playbackAnchorReady: playbackAnchorReady === true
  });
}

const playerManager = new PlayerManager({
  getSelectedKey: getSelectedPlayerKey,
  getFoliaToken: () =>
    String(appConfig.sysConfig?.FoliaToken || '').trim(),
  log: writeLog,
  setStatus: setGlobalStatus,
  onStateChanged: state => {
    const wasConnected = isPlayerConnected;
    isPlayerConnected = state.connected;
    playerConnecting = state.connecting;
    activePlayerSnapshot = state.snapshot;
    if (
      playerControlNotice
      && (
        !state.connected
        || getSelectedPlayerKey() !== playerControlNotice.playerKey
        || (
          state.snapshot?.version
          && state.snapshot.version !== playerControlNotice.currentVersion
        )
        || (
          state.snapshot?.processId
          && playerControlNotice.processId
          && state.snapshot.processId !== playerControlNotice.processId
        )
      )
    ) {
      playerControlNotice = null;
    }
    if (!state.connected) {
      clearDeferredQqInsert();
      registeredNextGuardKey = '';
      registeredNextGuardSongIdentity = '';
      queueHeadNeedsGuardOnlyAfterCurrentChange = false;
      activeManagedPlayerAction = null;
      cancelledNativeNextSongs.clear();
    }
    if (
      wasConnected
      && !state.connected
      && !state.connecting
      && !applicationQuitRequested
      && playerConnectionRecoverySuppressed === 0
    ) {
      // A connector can exit after a successful initial probe. Defer the
      // recovery until the state callback unwinds; the one-shot coordinator
      // below then prevents a 350ms poll/event burst from starting parallel
      // upgrades or reconnect loops.
      const suppressionEpoch = playerConnectionRecoverySuppressionEpoch;
      queueMicrotask(() => {
        if (
          applicationQuitRequested
          || playerConnectionRecoverySuppressed > 0
          || suppressionEpoch !== playerConnectionRecoverySuppressionEpoch
        ) return;
        void recoverPlayerConnectionAfterFailure();
      });
    }
  },
  onTrackChanged: async (track, observation) => {
    if (!track) {
      await syncTrackChangeLogic(
        '',
        '播放停止',
        null,
        '无',
        '',
        '',
        null,
        'legacy',
        observation.playbackAnchorReady === true
      );
      return;
    }
    await syncTrackChangeLogic(
      String(track.id || `${track.title}|${track.artist}`),
      track.title,
      observation.nextTrack
        ? String(
            observation.nextTrack.id
            || `${observation.nextTrack.title}|${observation.nextTrack.artist}`
          )
        : null,
      observation.nextDescription,
      track.artist || '',
      observation.coverUrl || '',
      observation.nextTrack || null,
      observation.nextObservation,
      observation.playbackAnchorReady === true
    );
  },
  onTrackUpdated: async (track, observation) => {
    updatePlayerCurrentTrack(
      String(track.id || `${track.title}|${track.artist}`),
      track.title,
      track.artist || '',
      observation.coverUrl || ''
    );
    await retryDeferredQqInsertAfterObservation(
      observation.playbackAnchorReady === true
    );
    const managedAction = activeManagedPlayerAction;
    if (managedAction && tracksRepresentSameSong(managedAction.target, track)) {
      managedAction.targetObserved = true;
      if (queueHeadNeedsGuardOnlyAfterCurrentChange && targetQueue[0]) {
        queueHeadNeedsGuardOnlyAfterCurrentChange = false;
        void armNextGuardOnly(targetQueue[0]);
      }
      if (!managedAction.inFlight
          && activeManagedPlayerAction?.id === managedAction.id) {
        activeManagedPlayerAction = null;
      }
    }
  }
});

const userCooldowns = new Map<string, number>();
const giftRequestCredits = new Map<string, number>();
const recentGiftEvents = new Map<string, number>();
const GIFT_LEARNING_DURATION_MS = 60_000;
const MAX_GIFT_LEARNING_SESSION_ITEMS = 20;
let giftLearningStartedAt = 0;
let giftLearningExpiresAt = 0;
let giftLearningCaptured: LearnedGift[] = [];
let giftLibrarySaveTimer: NodeJS.Timeout | null = null;
let recentRejects: { id: number, user: any, reason: string }[] = [];

function isGiftLearningActive(now = Date.now()): boolean {
  return giftLearningExpiresAt > now;
}

function getGiftLearningState(now = Date.now()) {
  return {
    active: isGiftLearningActive(now),
    startedAt: giftLearningStartedAt || null,
    expiresAt: giftLearningExpiresAt || null,
    capturedGifts: normalizeLearnedGifts(
      giftLearningCaptured,
      MAX_GIFT_LEARNING_SESSION_ITEMS
    ),
    knownGifts: normalizeLearnedGifts(appConfig.learnedGifts)
  };
}

function scheduleGiftLibrarySave(): void {
  if (giftLibrarySaveTimer) clearTimeout(giftLibrarySaveTimer);
  giftLibrarySaveTimer = setTimeout(() => {
    giftLibrarySaveTimer = null;
    saveConfig();
  }, 300);
}

function startGiftLearning(): void {
  const now = Date.now();
  giftLearningStartedAt = now;
  giftLearningExpiresAt = now + GIFT_LEARNING_DURATION_MS;
  giftLearningCaptured = [];
  writeLog('[礼物学习] 已开始监听直播间礼物，持续 60 秒', 'Magenta');
  setGlobalStatus('🎁 正在监听直播间礼物…');
}

function stopGiftLearning(): void {
  giftLearningExpiresAt = 0;
  writeLog('[礼物学习] 已停止监听直播间礼物', 'DarkGray');
}

function clearLearnedGiftLibrary(): void {
  if (giftLibrarySaveTimer) {
    clearTimeout(giftLibrarySaveTimer);
    giftLibrarySaveTimer = null;
  }
  appConfig.learnedGifts = [];
  giftLearningCaptured = [];
  saveConfig();
  writeLog('[礼物学习] 已清空本地礼物缓存', 'DarkGray');
}

function captureGiftForLearning(event: BilibiliGiftCreditEvent): void {
  if (!isGiftLearningActive()) return;
  const hadGift = giftLearningCaptured.some(item => (
    event.giftId
      ? item.giftId === event.giftId
      : !item.giftId
        && item.giftName.toLocaleLowerCase('zh-CN')
          === event.giftName.toLocaleLowerCase('zh-CN')
  ));
  const seenAt = Date.now();
  giftLearningCaptured = rememberLearnedGift(
    giftLearningCaptured,
    event,
    seenAt,
    MAX_GIFT_LEARNING_SESSION_ITEMS
  );
  appConfig.learnedGifts = rememberLearnedGift(
    appConfig.learnedGifts,
    event,
    seenAt
  );
  scheduleGiftLibrarySave();

  const displayGift = event.giftName || `ID ${event.giftId}`;
  if (!hadGift) {
    writeLog(
      `[礼物学习] 已捕获 ${displayGift}${event.giftId ? `（ID ${event.giftId}）` : ''}`,
      'Magenta'
    );
  }
  setGlobalStatus(`🎁 已捕获 ${displayGift}`);
}

function isConfiguredSuperUser(user: any): boolean {
  if (!isBiliLoginReady()) return false;
  const configured = Array.isArray(appConfig.sysConfig?.SuperUsers)
    ? appConfig.sysConfig.SuperUsers.map((value: unknown) => String(value))
    : [];
  return configured.includes(String(user?.uname || ''))
    || configured.includes(String(user?.uid || ''));
}

function getGiftRequirementForGuardLevel(guardLevel: unknown): {
  tier: ReturnType<typeof giftRequestTierFromGuardLevel>;
  requirement: GiftRequestRequirement;
} {
  const tier = giftRequestTierFromGuardLevel(guardLevel);
  const requirements = normalizeGiftRequestRequirements(
    appConfig.sysConfig?.GiftRequestRequirements
  );
  return { tier, requirement: requirements[tier] };
}

function claimGiftEvent(event: BilibiliGiftCreditEvent): boolean {
  if (!event.eventId) return true;
  const key = `${event.uid}|${event.eventId}`;
  const now = Date.now();
  const previous = recentGiftEvents.get(key) || 0;
  if (now - previous < 15 * 60_000) return false;
  recentGiftEvents.set(key, now);
  for (const [storedKey, timestamp] of recentGiftEvents) {
    if (now - timestamp > 15 * 60_000) recentGiftEvents.delete(storedKey);
  }
  while (recentGiftEvents.size > 1_000) {
    const oldest = recentGiftEvents.keys().next().value;
    if (typeof oldest !== 'string') break;
    recentGiftEvents.delete(oldest);
  }
  return true;
}

async function addReject(user: any, reason: string) {
  const avatarUrl = user.avatar || await getBiliAvatar(user.uid);
  const rejectItem = { id: Date.now() + Math.random(), user: { ...user, avatar: avatarUrl }, reason };
  recentRejects.push(rejectItem);
  if (recentRejects.length > 5) recentRejects.shift();
  setTimeout(() => { recentRejects = recentRejects.filter(r => r.id !== rejectItem.id); }, 5000);
}

// ==========================================
// B站原生 WebSocket 解析
// ==========================================
let currentBiliWs: any = null;
let biliPingTimer: NodeJS.Timeout | null = null;
let biliReconnectTimer: NodeJS.Timeout | null = null;
let biliConnectionTimer: NodeJS.Timeout | null = null;
let biliRoomSession = 0;
let biliConnectionAttempt: {
  session: number;
  resolve: (connected: boolean) => void;
} | null = null;

function dispatchBiliRoomConnectionEvent(
  event: BiliRoomConnectionEvent
): void {
  biliRoomState = reduceBiliRoomConnectionState(biliRoomState, event);
}

function getBiliRoomConnectionInfo() {
  return {
    requestedRoomId: biliRoomState.requestedRoomId,
    realRoomId: biliRoomState.realRoomId,
    status: biliRoomState.status,
    message: biliRoomState.message,
    enabled: appConfig.roomConnectionEnabled === true
  };
}

function clearBiliConnectionTimers(): void {
  if (biliReconnectTimer) {
    clearTimeout(biliReconnectTimer);
    biliReconnectTimer = null;
  }
  if (biliConnectionTimer) {
    clearTimeout(biliConnectionTimer);
    biliConnectionTimer = null;
  }
}

function clearBiliPingTimer(): void {
  if (biliPingTimer) {
    clearInterval(biliPingTimer);
    biliPingTimer = null;
  }
}

function closeCurrentBiliWebSocket(): void {
  const ws = currentBiliWs;
  currentBiliWs = null;
  if (!ws) return;
  try {
    if (typeof ws.terminate === 'function') ws.terminate();
    else ws.close();
  } catch {}
}

function finishBiliConnectionAttempt(
  session: number,
  connected: boolean
): void {
  if (!biliConnectionAttempt || biliConnectionAttempt.session !== session) {
    return;
  }
  const resolve = biliConnectionAttempt.resolve;
  biliConnectionAttempt = null;
  resolve(connected);
}

/**
 * Stop the current socket and invalidate every delayed callback belonging to
 * it. The room identifiers stay visible in the status card; a new connect
 * request will clear the resolved ID before resolving the next room.
 */
function invalidateBiliRoomTransport(): number {
  const previousSession = biliRoomSession;
  const session = ++biliRoomSession;
  finishBiliConnectionAttempt(previousSession, false);
  clearBiliConnectionTimers();
  clearBiliPingTimer();
  closeCurrentBiliWebSocket();
  dispatchBiliRoomConnectionEvent({
    type: 'disconnect-requested',
    session,
    requestedRoomId: Number(appConfig.roomId) || 0
  });
  return session;
}

function disconnectFromLiveRoom(): void {
  appConfig.roomConnectionEnabled = false;
  invalidateBiliRoomTransport();
  saveConfig();
  setGlobalStatus(BILI_ROOM_CONNECTION_MESSAGES.disconnected);
  writeLog('[Bilibili] 已断开直播间连接，已停止自动重连', 'DarkGray');
}

function logoutBiliAccount() {
  qrLoginAttemptId++;
  stopBiliQrPolling();
  isQrLoggingIn = false;
  qrCodeBase64 = '';
  qrLoginStatus = '已退出登录，可重新扫码绑定账号';

  invalidateBiliRoomTransport();

  biliCookie = '';
  biliUid = 0;
  currentUserInfo = createEmptyBiliUserInfo();
  saveConfig();
  writeLog('[Bilibili] 已退出登录并清除本地账号凭据', 'Green');
  if (appConfig.roomConnectionEnabled === true && appConfig.roomId) {
    void connectToLiveRoom(appConfig.roomId, { enable: false }).then(connected => {
      writeLog(
        connected
          ? '[Bilibili] 已自动切换为游客弹幕连接'
          : '[Bilibili] 游客弹幕自动重连失败，请手动重试',
        connected ? 'Green' : 'Yellow'
      );
    });
  }
}

interface BiliDanmuEndpoint {
  host: string;
  port: number;
  url: string;
}

function getBiliDanmuEndpoints(danmuData: any): BiliDanmuEndpoint[] {
  const data = danmuData?.data || {};
  const rawHosts = [
    ...(Array.isArray(data.host_list) ? data.host_list : []),
    ...(Array.isArray(data.host_server_list) ? data.host_server_list : [])
  ];
  const endpoints: BiliDanmuEndpoint[] = [];
  const seen = new Set<string>();

  for (const item of rawHosts) {
    const host = typeof item?.host === 'string' ? item.host.trim() : '';
    const rawPort = Number(item?.wss_port);
    const port = Number.isInteger(rawPort) && rawPort > 0 && rawPort <= 65535 ? rawPort : 443;
    if (!host || !/^[a-z0-9.-]+$/i.test(host)) continue;

    const key = `${host}:${port}`;
    if (seen.has(key)) continue;
    seen.add(key);
    endpoints.push({ host, port, url: `wss://${host}${port === 443 ? '' : `:${port}`}/sub` });
  }

  const fallbackHost = 'broadcastlv.chat.bilibili.com';
  const fallbackKey = `${fallbackHost}:443`;
  if (!seen.has(fallbackKey)) {
    endpoints.push({ host: fallbackHost, port: 443, url: `wss://${fallbackHost}/sub` });
  }
  return endpoints;
}

interface ConnectToLiveRoomOptions {
  enable?: boolean;
}

function isBiliRoomSessionCurrent(session: number): boolean {
  return session === biliRoomSession
    && appConfig.roomConnectionEnabled === true;
}

function failBiliRoomConnection(session: number, message: string): void {
  if (session !== biliRoomSession) return;
  clearBiliConnectionTimers();
  clearBiliPingTimer();
  finishBiliConnectionAttempt(session, false);
  dispatchBiliRoomConnectionEvent({
    type: 'connection-failed',
    session,
    message: message.trim() || BILI_ROOM_CONNECTION_MESSAGES.failed
  });
}

async function connectToLiveRoom(
  shortRoomId: number,
  options: ConnectToLiveRoomOptions = {}
): Promise<boolean> {
  const normalizedRoomId = Number(shortRoomId);
  if (!Number.isSafeInteger(normalizedRoomId) || normalizedRoomId <= 0) {
    setGlobalStatus('请输入正确的房间号');
    return false;
  }

  if (options.enable === true) appConfig.roomConnectionEnabled = true;
  if (appConfig.roomConnectionEnabled !== true) return false;

  invalidateBiliRoomTransport();
  const session = ++biliRoomSession;
  appConfig.roomId = normalizedRoomId;
  dispatchBiliRoomConnectionEvent({
    type: 'connect-requested',
    session,
    requestedRoomId: normalizedRoomId
  });
  saveConfig();

  const connection = new Promise<boolean>(resolve => {
    biliConnectionAttempt = { session, resolve };
  });

  void (async () => {
    try {
      const headers: Record<string, string> = {
        "User-Agent": "Mozilla/5.0",
        "Referer": `https://live.bilibili.com/${normalizedRoomId}`,
        "Accept": "application/json, text/plain, */*"
      };
      if (biliCookie) headers["Cookie"] = biliCookie;

      const initRes = await fetchWithTimeout(
        `https://api.live.bilibili.com/room/v1/Room/room_init?id=${normalizedRoomId}`,
        { headers }
      );
      const initData: any = await initRes.json();
      if (!isBiliRoomSessionCurrent(session)) return;
      if (initData.code !== 0) {
        writeLog(`[Bilibili] 房间初始化失败，code=${initData.code}`, 'Yellow');
        failBiliRoomConnection(session, '连接失败：房间号无效或不可用');
        return;
      }

      const realRoomId = Number(initData.data?.room_id) || normalizedRoomId;
      dispatchBiliRoomConnectionEvent({
        type: 'room-resolved',
        session,
        realRoomId
      });
      const danmuData = await fetchBiliDanmuInfoWithFallback(
        fetchWithTimeout,
        realRoomId,
        {
          headers,
          onWbiFailure: message => writeLog(
            `[Bilibili] WBI 弹幕鉴权不可用（${message}），尝试兼容接口`,
            'Yellow'
          )
        }
      ) as any;
      if (!isBiliRoomSessionCurrent(session)) return;

      const token = danmuData.data?.token || "";
      if (danmuData.code !== 0 || !token) {
        writeLog(`[Bilibili] 无法获取弹幕鉴权信息，code=${danmuData.code}`, 'Red');
        failBiliRoomConnection(session, '连接失败：无法取得弹幕鉴权');
        return;
      }

      const endpoints = getBiliDanmuEndpoints(danmuData);
      if (endpoints.length === 0) {
        writeLog('[Bilibili] 接口未返回可用的弹幕节点', 'Red');
        failBiliRoomConnection(session, '连接失败：没有可用的弹幕节点');
        return;
      }

      let finalBuvid = "999E9060-EA3F-0F79-7BDC-A14879D11DCB95434infoc";
      const b3Match = biliCookie.match(/buvid3=([^;]+)/);
      if (b3Match) finalBuvid = b3Match[1];

      startBiliWebSocket(
        {
          uid: biliUid || 0,
          roomid: realRoomId,
          protover: 3,
          buvid: finalBuvid,
          support_ack: true,
          type: 2,
          key: token
        },
        endpoints,
        0,
        session,
        0,
        realRoomId
      );
    } catch (err: any) {
      if (!isBiliRoomSessionCurrent(session)) return;
      const message = err?.message || String(err);
      writeLog(`[Bilibili] 连接直播间失败：${message}`, 'Red');
      failBiliRoomConnection(session, `连接失败：${message}`);
    }
  })();

  return await connection;
}

function readBiliAuthReply(buffer: Buffer): { code: number, message?: string } | null {
  let offset = 0;
  while (offset + 16 <= buffer.length) {
    const packetLen = buffer.readInt32BE(offset);
    const headerLen = buffer.readInt16BE(offset + 4);
    const op = buffer.readInt32BE(offset + 8);
    if (packetLen < 16 || offset + packetLen > buffer.length) break;

    if (op === 8) {
      try {
        const reply = JSON.parse(buffer.subarray(offset + headerLen, offset + packetLen).toString('utf-8'));
        return { code: Number(reply?.code), message: reply?.message };
      } catch {
        return { code: -1, message: 'invalid auth reply' };
      }
    }
    offset += packetLen;
  }
  return null;
}

function startBiliWebSocket(
  authObj: any,
  endpoints: BiliDanmuEndpoint[],
  endpointIndex = 0,
  session = biliRoomSession,
  endpointAttempt = 0,
  realRoomId = Number(authObj?.roomid) || 0
): void {
  if (!isBiliRoomSessionCurrent(session) || endpoints.length === 0) return;

  clearBiliConnectionTimers();
  clearBiliPingTimer();
  closeCurrentBiliWebSocket();
  dispatchBiliRoomConnectionEvent({
    type: 'socket-reconnecting',
    session,
    message: BILI_ROOM_CONNECTION_MESSAGES.connecting
  });

  const WebSocketClient = getWebSocketClient();
  if (!WebSocketClient) {
    failBiliRoomConnection(session, '连接失败：系统不支持 WebSocket');
    return;
  }

  const isNodeWs = typeof WebSocketClient.prototype?.on === 'function';
  const wsOptions = isNodeWs
    ? { headers: { "User-Agent": "Mozilla/5.0" } }
    : undefined;
  const normalizedIndex = endpointIndex % endpoints.length;
  const endpoint = endpoints[normalizedIndex];

  writeLog(`[Bilibili] 正在连接弹幕节点 ${endpoint.host}:${endpoint.port}`, 'Gray');
  let ws: any;
  try {
    ws = new WebSocketClient(endpoint.url, wsOptions);
  } catch (error: any) {
    writeLog(
      `[Bilibili] 节点 ${endpoint.host} 创建失败：${error?.message || error}`,
      'Yellow'
    );
    dispatchBiliRoomConnectionEvent({
      type: 'socket-reconnecting',
      session,
      message: BILI_ROOM_CONNECTION_MESSAGES.connecting
    });
    if (endpointAttempt + 1 < endpoints.length) {
      biliReconnectTimer = setTimeout(() => {
        biliReconnectTimer = null;
        startBiliWebSocket(
          authObj,
          endpoints,
          normalizedIndex + 1,
          session,
          endpointAttempt + 1,
          realRoomId
        );
      }, 1500);
    } else {
      failBiliRoomConnection(session, BILI_ROOM_CONNECTION_MESSAGES.failed);
    }
    return;
  }

  currentBiliWs = ws;
  let authenticated = false;
  let reconnectScheduled = false;

  const scheduleReconnect = (reason: string) => {
    if (
      reconnectScheduled
      || currentBiliWs !== ws
      || !isBiliRoomSessionCurrent(session)
    ) return;
    reconnectScheduled = true;
    if (biliConnectionTimer) {
      clearTimeout(biliConnectionTimer);
      biliConnectionTimer = null;
    }
    clearBiliPingTimer();
    currentBiliWs = null;
    try {
      if (typeof ws.terminate === 'function') ws.terminate();
      else ws.close();
    } catch {}
    const nextAttempt = endpointAttempt + 1;
    const hasNextEndpoint = nextAttempt < endpoints.length;
    writeLog(
      `[Bilibili] 节点 ${endpoint.host} ${reason}，`
        + (hasNextEndpoint ? '切换下一个节点' : '本轮节点均不可用'),
      'Yellow'
    );
    dispatchBiliRoomConnectionEvent({
      type: 'socket-reconnecting',
      session,
      message: BILI_ROOM_CONNECTION_MESSAGES.connecting
    });
    biliReconnectTimer = setTimeout(() => {
      biliReconnectTimer = null;
      if (!isBiliRoomSessionCurrent(session)) return;
      if (hasNextEndpoint) {
        startBiliWebSocket(
          authObj,
          endpoints,
          normalizedIndex + 1,
          session,
          nextAttempt,
          realRoomId
        );
        return;
      }

      // Only op=8/code=0 can complete the initial promise. If every node
      // failed before authentication, expose an error but keep a slow,
      // session-guarded retry while the user remains connected.
      failBiliRoomConnection(session, BILI_ROOM_CONNECTION_MESSAGES.failed);
      if (!isBiliRoomSessionCurrent(session)) return;
      biliReconnectTimer = setTimeout(() => {
        biliReconnectTimer = null;
        if (isBiliRoomSessionCurrent(session)) {
          startBiliWebSocket(authObj, endpoints, 0, session, 0, realRoomId);
        }
      }, 5000);
    }, hasNextEndpoint ? 1500 : 1500);
  };

  biliConnectionTimer = setTimeout(() => {
    if (authenticated) scheduleReconnect('连接中断');
    else scheduleReconnect('连接或鉴权超时');
  }, 10_000);

  const onOpen = () => {
    if (currentBiliWs !== ws || !isBiliRoomSessionCurrent(session)) return;
    const authPayload = Buffer.from(JSON.stringify(authObj), 'utf-8');
    const packet = Buffer.alloc(16 + authPayload.length);
    packet.writeInt32BE(packet.length, 0);
    packet.writeInt16BE(16, 4);
    packet.writeInt16BE(1, 6);
    packet.writeInt32BE(7, 8);
    packet.writeInt32BE(1, 12);
    authPayload.copy(packet, 16);
    ws.send(packet);
  };

  const onMessage = async (data: any) => {
    if (currentBiliWs !== ws || !isBiliRoomSessionCurrent(session)) return;
    let buffer: Buffer;
    if (Buffer.isBuffer(data)) buffer = data;
    else if (data instanceof ArrayBuffer) buffer = Buffer.from(data);
    else if (typeof Blob !== 'undefined' && data instanceof Blob) buffer = Buffer.from(await data.arrayBuffer());
    else buffer = Buffer.from(data);

    if (!authenticated) {
      const authReply = readBiliAuthReply(buffer);
      if (authReply) {
        if (authReply.code !== 0) {
          scheduleReconnect(`鉴权失败 code=${authReply.code}`);
          return;
        }

        authenticated = true;
        if (biliConnectionTimer) {
          clearTimeout(biliConnectionTimer);
          biliConnectionTimer = null;
        }
        dispatchBiliRoomConnectionEvent({
          type: 'websocket-authenticated',
          session,
          realRoomId
        });
        finishBiliConnectionAttempt(session, true);
        writeLog(`✅ [Bilibili] 弹幕节点已鉴权：${endpoint.host}`, 'Green');
        biliPingTimer = setInterval(() => {
          if (currentBiliWs === ws && ws.readyState === 1) {
            const hb = Buffer.alloc(31);
            hb.writeInt32BE(hb.length, 0);
            hb.writeInt16BE(16, 4);
            hb.writeInt16BE(1, 6);
            hb.writeInt32BE(2, 8);
            hb.writeInt32BE(1, 12);
            Buffer.from("[object Object]", "utf-8").copy(hb, 16);
            ws.send(hb);
          }
        }, 30000);
        setGlobalStatus('弹幕已连接');
        writeLog('✅ [Bilibili] 直播间已连接，弹幕监控启动！', 'Green');
      }
    }
    parseBiliPacket(buffer);
  };

  const onClose = () => scheduleReconnect(authenticated ? '连接断开' : '连接失败');
  const onError = (err?: any) => {
    const message = err?.message || err?.code || '网络错误';
    writeLog(`[Bilibili] 节点 ${endpoint.host} 错误：${message}`, 'Yellow');
    scheduleReconnect('连接错误');
  };

  if (typeof ws.on === 'function') {
    ws.on('open', onOpen);
    ws.on('message', onMessage);
    ws.on('close', onClose);
    ws.on('error', onError);
  } else {
    ws.onopen = onOpen;
    ws.onmessage = (e: any) => onMessage(e.data);
    ws.onclose = onClose;
    ws.onerror = onError;
  }
}

function parseBiliPacket(buffer: Buffer) {
  let offset = 0;
  while (offset < buffer.length) {
    if (buffer.length - offset < 16) break;
    const packetLen = buffer.readInt32BE(offset);
    const headerLen = buffer.readInt16BE(offset + 4);
    const protoVer = buffer.readInt16BE(offset + 6);
    const op = buffer.readInt32BE(offset + 8);

    if (packetLen < 16 || offset + packetLen > buffer.length) break;
    const payload = buffer.subarray(offset + headerLen, offset + packetLen);

    if (op === 5) {
      if (protoVer === 3) { try { parseBiliPacket(zlib.brotliDecompressSync(payload)); } catch {} }
      else if (protoVer === 2) { try { parseBiliPacket(zlib.unzipSync(payload)); } catch {} }
      else { try { handleRawDanmaku(JSON.parse(payload.toString('utf-8'))); } catch {} }
    }
    offset += packetLen;
  }
}

function checkPermission(user: any, permKey: string): { allowed: boolean, reason?: string } {
  if (!isBiliLoginReady()) {
    if (
      permKey === 'OrderPermission'
      || permKey === 'CancelPermission'
    ) {
      return { allowed: true };
    }
    return {
      allowed: false,
      reason: '游客模式仅开放普通点歌和撤回自己的歌曲，请先扫码登录使用控制指令'
    };
  }
  if (isConfiguredSuperUser(user)) return { allowed: true };
  const defaultGuardType = permKey === 'ForceControlPermission' ? -1 : 0;
  const perm = appConfig.sysConfig?.[permKey] || { AllowManager: true, MinGuardType: defaultGuardType, MinMedalLevel: 0 };
  if (perm.MinGuardType === -1) {
    if (perm.AllowManager && user.isManager) return { allowed: true };
    return { allowed: false, reason: "仅限房管及以上操作" };
  }
  if (perm.AllowManager && user.isManager) return { allowed: true };
  if (perm.MinGuardType > 0) {
    if (user.guardLevel === 0 || user.guardLevel > perm.MinGuardType) {
      const guardNames = ['无', '总督', '提督', '舰长'];
      return { allowed: false, reason: `需要 ${guardNames[perm.MinGuardType]} 及以上舰队` };
    }
  }
  if (perm.MinMedalLevel > 0 && user.medalLevel < perm.MinMedalLevel) return { allowed: false, reason: `需要粉丝牌 ${perm.MinMedalLevel} 级` };
  return { allowed: true };
}

interface QueuedDanmakuCommand {
  user: any;
  message: string;
  enqueuedAt: number;
}

const MAX_DANMAKU_COMMAND_QUEUE = 200;
const MAX_DANMAKU_COMMAND_AGE_MS = 90_000;
const danmakuCommandQueue: QueuedDanmakuCommand[] = [];
const recentDanmakuCommands = new Map<string, number>();
let processingDanmakuCommand = false;

function enqueueDanmakuCommand(user: any, message: string): void {
  const normalized = String(message || '').trim();
  if (!normalized) return;

  const now = Date.now();
  const fingerprint = `${user.uid}|${normalized}`;
  const previous = recentDanmakuCommands.get(fingerprint) || 0;
  if (now - previous < 800) {
    writeLog(`[指令队列] 已忽略 800ms 内重复指令: ${normalized}`, 'DarkGray');
    return;
  }
  recentDanmakuCommands.set(fingerprint, now);
  if (recentDanmakuCommands.size > 500) {
    for (const [key, timestamp] of recentDanmakuCommands) {
      if (now - timestamp > 60_000) recentDanmakuCommands.delete(key);
    }
    while (recentDanmakuCommands.size > 500) {
      const oldest = recentDanmakuCommands.keys().next().value;
      if (typeof oldest !== 'string') break;
      recentDanmakuCommands.delete(oldest);
    }
  }

  if (danmakuCommandQueue.length >= MAX_DANMAKU_COMMAND_QUEUE) {
    writeLog(`[指令队列] 队列已满，已丢弃来自 ${user.uname || user.uid} 的指令`, 'Red');
    return;
  }

  danmakuCommandQueue.push({ user, message: normalized, enqueuedAt: now });
  void processDanmakuCommandQueue();
}

async function processDanmakuCommandQueue(): Promise<void> {
  if (processingDanmakuCommand) return;
  processingDanmakuCommand = true;
  try {
    while (danmakuCommandQueue.length > 0) {
      const item = danmakuCommandQueue.shift();
      if (!item) continue;
      if (Date.now() - item.enqueuedAt > MAX_DANMAKU_COMMAND_AGE_MS) {
        writeLog(
          `[指令队列] 已丢弃等待超过 90 秒的过期指令：${item.message}`,
          'Yellow'
        );
        continue;
      }
      try {
        await handleDanmaku(item.user, item.message);
      } catch (err: any) {
        writeLog(`[指令队列] 处理失败: ${err?.message || err}`, 'Red');
      }
    }
  } finally {
    processingDanmakuCommand = false;
    if (danmakuCommandQueue.length > 0) void processDanmakuCommandQueue();
  }
}

function handleGiftEvent(doc: any): void {
  if (appConfig.sysConfig?.ShowAllDanmaku) {
    writeLog(`[RAW礼物数据] ${JSON.stringify(doc)}`, 'DarkGray');
  }
  const event = parseBilibiliGiftCreditEvent(doc);
  if (!event) return;
  if (!claimGiftEvent(event)) {
    writeLog('[礼物点歌] 已忽略重复礼物事件', 'DarkGray');
    return;
  }

  captureGiftForLearning(event);

  const { tier, requirement } = getGiftRequirementForGuardLevel(
    event.guardLevel
  );
  if (!matchesGiftRequestRequirement(requirement, event)) return;

  const previous = giftRequestCredits.get(event.uid) || 0;
  const next = addGiftRequestCredits(previous, event.quantity);
  giftRequestCredits.set(event.uid, next);
  const displayGift = event.giftName || `ID ${event.giftId}`;
  writeLog(
    `[礼物点歌][${giftRequestTierLabel(tier)}] ${event.userName} 赠送 ${displayGift} ×${event.quantity}，新增 ${next - previous} 次点歌，当前剩余 ${next} 次`,
    'Magenta'
  );
  setGlobalStatus(`🎁 ${event.userName} 获得 ${next - previous} 次点歌`);
}

function handleRawDanmaku(doc: any) {
  const cmd = doc.cmd || "";
  if (cmd === 'SEND_GIFT') {
    handleGiftEvent(doc);
    return;
  }
  if (cmd.startsWith("DANMU_MSG")) {
    if (appConfig.sysConfig?.ShowAllDanmaku) writeLog(`[RAW原始数据] ${JSON.stringify(doc)}`, 'DarkGray');
    const info = doc.info;
    const msg = info[1].trim();
    const userBase = info[2];
    const rawUid = typeof userBase[0] === 'number' ? userBase[0].toString() : String(userBase[0]).replace(/"/g, '');
    const uname = userBase[1] || `游客${rawUid.slice(-6)}`;
    const isManager = userBase[2] === 1;
    const medalLevel = info[3]?.[0] || 0;
    const guardLevel = info[7] ? parseInt(info[7]) : 0;

    let avatarUrl = '';
    try { if (info[0][15]?.user?.base?.face) avatarUrl = info[0][15].user.base.face; } catch {}
    enqueueDanmakuCommand({ uid: rawUid, name: uname, uname, avatar: avatarUrl, isManager, medalLevel, guardLevel }, msg);
  }
}

// ==========================================
// 播放器状态核心同步逻辑（四播放器连接器共享）
// ==========================================
const songCoverCache = new Map<string, string>();

function cacheSongCover(songId: string, coverUrl: string): void {
  if (!songId || !coverUrl) return;
  songCoverCache.delete(songId);
  songCoverCache.set(songId, coverUrl);
  while (songCoverCache.size > 512) {
    const oldest = songCoverCache.keys().next().value;
    if (typeof oldest !== 'string') break;
    songCoverCache.delete(oldest);
  }
}

async function getNcmSongCover(songId: string): Promise<string> {
  const normalizedId = String(songId || '').trim();
  if (!/^\d+$/.test(normalizedId)) return '';
  if (songCoverCache.has(normalizedId)) return songCoverCache.get(normalizedId) || '';

  const coverUrl = await getNeteaseSongCover(normalizedId);
  if (coverUrl) cacheSongCover(normalizedId, coverUrl);
  return coverUrl;
}

function updatePlayerCurrentTrack(trackId: string, songName: string, artistName: string = '', coverUrl: string = '') {
  if (!trackId) {
    playerCurrentTrack = null;
    return;
  }

  const normalizedId = String(trackId);
  const requestedCoverUrl = currentPlayingSong
    && (
      String(currentPlayingSong.Id || '') === normalizedId
      || tracksRepresentSameSong(currentPlayingSong, {
        id: normalizedId,
        title: songName,
        artist: artistName
      })
    )
    ? String(currentPlayingSong.CoverUrl || '')
    : '';
  const knownCoverUrl = coverUrl
    || requestedCoverUrl
    || songCoverCache.get(normalizedId)
    || '';
  if (knownCoverUrl) cacheSongCover(normalizedId, knownCoverUrl);
  if (knownCoverUrl && currentPlayingSong && (
    String(currentPlayingSong.Id || '') === normalizedId
    || tracksRepresentSameSong(currentPlayingSong, {
      id: normalizedId,
      title: songName,
      artist: artistName
    })
  )) {
    currentPlayingSong = {
      ...currentPlayingSong,
      CoverUrl: knownCoverUrl
    };
  }

  playerCurrentTrack = {
    Id: normalizedId,
    SongName: songName || '未知歌曲',
    ArtistName: artistName || '未知歌手',
    OrderedByUid: '',
    OrderedByAvatar: '',
    CoverUrl: knownCoverUrl,
    OrderedBy: '主播歌单'
  };

  if (!knownCoverUrl && getSelectedPlayerKey() === 'netease') {
    void getNcmSongCover(normalizedId).then(resolvedCoverUrl => {
      if (resolvedCoverUrl && playerCurrentTrack?.Id === normalizedId && !playerCurrentTrack.CoverUrl) {
        playerCurrentTrack = { ...playerCurrentTrack, CoverUrl: resolvedCoverUrl };
      }
    });
  }
}

type QqDeferredObservationResult =
  | 'none'
  | 'takeover-success'
  | 'takeover-failed';

async function takeOverDeferredQqHeadNow(
  songInfo: any
): Promise<QqDeferredObservationResult> {
  const deferredIdentity = deferredQqInsertIdentity;
  if (
    !deferredIdentity
    || getQueueSongIdentity(songInfo) !== deferredIdentity
  ) {
    clearDeferredQqInsert();
    return 'none';
  }

  // Mark the one-shot transition before entering the managed playback
  // transaction. playSongNow clears deferred state at its entry point, so
  // the failure path below explicitly restores it while the queue head is
  // still the same request.
  qqDeferredInsertRetryAttempted = true;
  qqDeferredInsertRetryInFlight = true;
  writeLog(
    `[队首守卫] QQ 音乐首次播放已建立锚点，立即接管待播队首: ${songInfo.SongName}`,
    'Yellow'
  );

  const playbackConfirmed = await playSongNow(songInfo, 'play-now');
  qqDeferredInsertRetryInFlight = false;
  if (playbackConfirmed) {
    clearDeferredQqInsert();
    writeLog(
      `✅ QQ 音乐已通过精确选歌接管待播队首: ${songInfo.SongName}`,
      'Green'
    );
    setGlobalStatus(`[播放] ${songInfo.SongName}`);
    return 'takeover-success';
  }

  if (getQueueSongIdentity(targetQueue[0]) === deferredIdentity) {
    // Keep the request at the head, but never issue another automatic
    // takeover for this anchor/session. A reconnect, player switch, or queue
    // mutation clears/replaces this identity through the existing lifecycle.
    deferredQqInsertIdentity = deferredIdentity;
    qqDeferredInsertRetryAttempted = true;
    qqDeferredInsertRetryInFlight = false;
    writeLog(
      `[队首守卫] QQ 音乐首次播放后接管失败，已保留队首且不再重复尝试: ${songInfo.SongName}`,
      'Yellow'
    );
    setGlobalStatus('QQ 音乐首次播放后接管失败，请检查播放器');
  } else {
    clearDeferredQqInsert();
  }
  return 'takeover-failed';
}

async function retryDeferredQqInsertAfterObservation(
  playbackAnchorReady: boolean
): Promise<QqDeferredObservationResult> {
  const queueHead = targetQueue[0];
  if (!queueHead) return 'none';

  const deferredOptions = {
    playerKey: getSelectedPlayerKey(),
    playbackAnchorReady: playbackAnchorReady === true,
    deferredIdentity: deferredQqInsertIdentity,
    queueHeadIdentity: getQueueSongIdentity(queueHead),
    retryAttempted: qqDeferredInsertRetryAttempted,
    retryInFlight: qqDeferredInsertRetryInFlight
  };
  const deferredAction = planQqAnchorObservation(deferredOptions);
  if (deferredAction === 'clear') {
    clearDeferredQqInsert();
    return 'none';
  } else if (
    planQqDeferredPlaybackAction(deferredOptions) === 'takeover-now'
    && !isObservedSong(queueHead)
  ) {
    return await takeOverDeferredQqHeadNow(queueHead);
  } else if (isObservedSong(queueHead)) {
    // The deferred item is already the current track; consume it through
    // the normal observation path instead of inserting it after itself.
    clearDeferredQqInsert();
  }
  return 'none';
}

async function syncTrackChangeLogic(currId: string, currName: string, nextId: string | null, nextName: string, currArtist: string = '', currCoverUrl: string = '', observedNextTrack: any = null, nextObservation: NextObservation = 'legacy', playbackAnchorReady = false): Promise<void> {
  playerPausedAfterRequests = false;
  updatePlayerCurrentTrack(currId, currName, currArtist, currCoverUrl);
  writeLog(
    `[状态同步] 🎵 播放器切歌信号: ${currName} (${currId}) | `
    + `下一首预告: ${nextName}${nextId ? ` (${nextId})` : ''}`,
    'Magenta'
  );

  // QQ Music cannot insert relative to a playlist cursor until its first
  // real current track is observed. The same entry point is also used by
  // same-song snapshot updates when only playbackAnchorReady changes.
  const deferredObservationResult =
    await retryDeferredQqInsertAfterObservation(playbackAnchorReady);
  if (deferredObservationResult === 'takeover-success') {
    // The verified PlaySelected transaction owns this observation.  Do not
    // let the manual/native track that established the anchor fall through to
    // the normal no-current-song fallback, which would issue PlaySelected
    // again.
    return;
  }

  const managedAction = activeManagedPlayerAction;
  if (managedAction && Date.now() > managedAction.expiresAt) {
    expireManagedAction(managedAction);
  } else if (managedAction) {
    const observed = {
      id: currId,
      title: currName,
      artist: currArtist
    };
    if (shouldDeferManagedTrackObservation(managedAction.target, observed)) {
      writeLog(
        `[动作归因] 忽略点歌机动作 #${managedAction.id} 的中间切歌: `
        + `${currName}；等待最终目标 ${managedAction.target?.SongName}`,
        'DarkGray'
      );
      return;
    }
    managedAction.targetObserved = true;
    writeLog(
      `[动作归因] 点歌机动作 #${managedAction.id} 已确认最终目标: ${currName}`,
      'DarkGray'
    );
  }
  let stateChanged = false;

  const cancelledEntry = [...cancelledNativeNextSongs.entries()]
    .find(([, song]) => isObservedSong(song));
  if (currId && cancelledEntry) {
    cancelledNativeNextSongs.delete(cancelledEntry[0]);
    registeredNextGuardKey = '';
    registeredNextGuardSongIdentity = '';
    writeLog(
      `[队首撤回兜底] 已撤回的预插歌曲开始播放，立即跳过: ${currName}`,
      'Yellow'
    );
    await requestPlayerNext();
    return;
  }

  if (!isPlaying) {
    if (targetQueue.length > 0 && isObservedSong(targetQueue[0])) {
      writeLog(`[状态同步] 处于暂停状态，自动跳过待播曲目以防消耗: ${targetQueue[0]?.SongName}`, 'Yellow');
      await requestPlayerNext();
    } else {
      if (currentPlayingSong) { currentPlayingSong = null; stateChanged = true; }
    }
  }
  else {
    if (currentPlayingSong && !isObservedSong(currentPlayingSong)) {
      const checkSkipForce = skipForcePlayOnce;
      skipForcePlayOnce = false;

      if (targetQueue.length > 0 && isObservedSong(targetQueue[0])) {
        writeLog(`[状态同步] 自然衔接到队首: ${targetQueue[0]?.SongName}`, 'Green');
        registeredNextGuardKey = '';
        registeredNextGuardSongIdentity = '';
        queueHeadNeedsGuardOnlyAfterCurrentChange = false;
        currentPlayingSong = targetQueue.shift();
        stateChanged = true;
      } else if (targetQueue.length > 0) {
        if (checkSkipForce && targetQueue[0]?.Id === currentPlayingSong?.Id) {
          writeLog(`[状态同步] 退回操作触发: 放行原生曲目，点播曲延后: ${targetQueue[0]?.SongName}`, 'DarkGray');
          await guardNextSong(targetQueue[0], playbackAnchorReady);
          currentPlayingSong = null;
          stateChanged = true;
        } else {
          writeLog(`[状态同步] 捕捉到切歌信号！强制拉起待播列表首曲: ${targetQueue[0]?.SongName}`, 'Magenta');
          const queuedSong = targetQueue[0];
          const deferForMissingAnchor = shouldDeferQqQueueHeadForMissingAnchor(
            playbackAnchorReady
          );
          const queuedPlaybackConfirmed = deferForMissingAnchor
            ? await guardNextSong(queuedSong, playbackAnchorReady)
            : await playSongNow(queuedSong);
          if (queuedPlaybackConfirmed && !deferForMissingAnchor) {
            stateChanged = true;
          }
        }
      } else {
        writeLog(`[状态同步] 点播列表已空，放行主播歌单曲目`, 'DarkGray');
        currentPlayingSong = null;
        queueHeadNeedsGuardOnlyAfterCurrentChange = false;
        stateChanged = true;
        if (appConfig.sysConfig?.PauseAfterRequests === true && currId) {
          await pauseActivePlayerAfterRequests();
        }
      }
    } else if (
      currentPlayingSong
      && isObservedSong(currentPlayingSong)
      && isObservedSong(targetQueue[0])
    ) {
      registeredNextGuardKey = '';
      registeredNextGuardSongIdentity = '';
      queueHeadNeedsGuardOnlyAfterCurrentChange = false;
      targetQueue.shift();
      stateChanged = true;
    } else if (!currentPlayingSong && targetQueue.length > 0) {
      if (isObservedSong(targetQueue[0])) {
        registeredNextGuardKey = '';
        registeredNextGuardSongIdentity = '';
        queueHeadNeedsGuardOnlyAfterCurrentChange = false;
        currentPlayingSong = targetQueue.shift();
        stateChanged = true;
      } else if (shouldDeferQqQueueHeadForMissingAnchor(playbackAnchorReady)) {
        // QQ cannot safely use PlaySelected before its native playback cursor
        // exists. Keep the request local; guardNextSong records the defer and
        // the next ready observation performs the one InsertNext retry.
        await guardNextSong(targetQueue[0], playbackAnchorReady);
      } else {
        const shouldKeepDeferredQqHead = shouldSuppressQqQueueHeadPlayNow({
          playerKey: getSelectedPlayerKey(),
          queueHeadIdentity: getQueueSongIdentity(targetQueue[0]),
          deferredIdentity: deferredQqInsertIdentity,
          playbackAnchorReady: playbackAnchorReady === true,
          retryAttempted: qqDeferredInsertRetryAttempted,
          retryInFlight: qqDeferredInsertRetryInFlight
        });
        const queueHeadAlreadyGuarded = registeredNextGuardSongIdentity
          === getQueueSongIdentity(targetQueue[0]);
        if (shouldKeepDeferredQqHead || queueHeadAlreadyGuarded) {
          // Keep an already inserted/deferred request local instead of
          // starting it immediately as a fallback.
          setGlobalStatus(
            shouldKeepDeferredQqHead
              ? qqDeferredInsertRetryAttempted
                ? 'QQ 音乐插入下一首失败，请在基础设置重连后重试'
                : '等待 QQ 音乐首次播放后插入下一首'
              : `下一首已就绪: ${targetQueue[0]?.SongName}`
          );
        } else {
          writeLog(`[兜底纠正] 实际切歌与待播队首不符，立即切到: ${targetQueue[0]?.SongName}`, 'Magenta');
          const queuedSong = targetQueue[0];
          if (await playSongNow(queuedSong)) {
            stateChanged = true;
          }
        }
      }
    }

    if (stateChanged) setGlobalStatus(currentPlayingSong ? `[播放] ${currentPlayingSong?.SongName}` : '点歌就绪');

    if (isPlaying && targetQueue.length > 0 && currentPlayingSong && isObservedSong(currentPlayingSong)) {
      const nextAction = planObservedNextAction({
        expected: targetQueue[0],
        observedNext: observedNextTrack,
        nextObservation,
        preserveInsertedHead: queueHeadNeedsGuardOnlyAfterCurrentChange,
        expectedAlreadyGuarded:
          registeredNextGuardSongIdentity
            === getQueueSongIdentity(targetQueue[0])
      });
      if (nextAction !== 'none') {
        writeLog(
          nextAction === 'arm-only'
            ? `[队首推进] 立即播放前已插入队首，只重新绑定守卫: ${targetQueue[0]?.SongName}`
            : observedNextTrack
            ? `[队首推进] 播放器实际下一首“${nextName}”与代播队首不符，重新插入: ${targetQueue[0]?.SongName}`
            : `[队首推进] 播放器确认下一首缺失，登记代播队首守卫: ${targetQueue[0]?.SongName}`,
          nextAction === 'insert' && observedNextTrack ? 'Yellow' : 'DarkGray'
        );
        queueHeadNeedsGuardOnlyAfterCurrentChange = false;
        if (nextAction === 'arm-only') {
          await armNextGuardOnly(targetQueue[0]);
        } else {
          await guardNextSong(targetQueue[0], playbackAnchorReady);
        }
      }
    }
  }

  if (
    managedAction
    && managedAction.targetObserved
    && !managedAction.inFlight
    && activeManagedPlayerAction?.id === managedAction.id
  ) {
    activeManagedPlayerAction = null;
  }
}

// 播放器连接与控制实现位于 electron/players。
// main.ts 只保留业务队列与界面的调用入口。
const CONNECTOR_MAINTENANCE_INTERVAL_MS = 30 * 60 * 1000;
let connectorMaintenanceTimer: NodeJS.Timeout | null = null;
let connectorMaintenanceRunning = false;
let connectorAutoRepairInFlight: Promise<boolean> | null = null;
let connectorAutoRepairAttemptKey = '';
let connectorConnectionRecoveryInFlight: Promise<boolean> | null = null;
let startupBackgroundServicesStarted = false;
const STARTUP_BACKGROUND_FALLBACK_MS = 2_000;

function getSelectedNativeConnector(): NativeConnectorId {
  return getSelectedPlayerKey();
}

function getConnectorAutoRepairAttemptKey(
  connectorId: NativeConnectorId,
  processId: number | null,
  version: string | null
): string {
  return [
    connectorId,
    processId || 'unknown-process',
    version?.trim() || 'unknown-version'
  ].join('|');
}

async function runConnectorAutoRepair(
  connectorId: NativeConnectorId
): Promise<boolean> {
  if (connectorAutoRepairInFlight) {
    return await connectorAutoRepairInFlight;
  }

  const operation = (async (): Promise<boolean> => {
    if (connectorId === 'folia') {
      setGlobalStatus(CONNECTOR_AUTO_REPAIR_MESSAGES.failed);
      return false;
    }

    let processInfo;
    try {
      processInfo = await playerManager.inspectSelectedPlayerProcess();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      writeLog(`[连接器兼容恢复] 播放器进程探测失败：${message}`, 'Yellow');
      setGlobalStatus(CONNECTOR_AUTO_REPAIR_MESSAGES.failed);
      return false;
    }
    if (!processInfo.querySucceeded) {
      writeLog(
        `[连接器兼容恢复] 无法确认${PLAYER_LABELS[connectorId]}播放器进程，`
        + '暂不自动更换连接器。',
        'Yellow'
      );
      setGlobalStatus(CONNECTOR_AUTO_REPAIR_MESSAGES.failed);
      return false;
    }

    if (!processInfo.running) {
      connectorAutoRepairAttemptKey = '';
      writeLog(
        `[连接器兼容恢复] 未发现${PLAYER_LABELS[connectorId]}播放器，`
        + '不会自动升级连接器。',
        'DarkGray'
      );
      setGlobalStatus(CONNECTOR_AUTO_REPAIR_MESSAGES.playerNotRunning);
      return false;
    }

    const attemptKey = getConnectorAutoRepairAttemptKey(
      connectorId,
      processInfo.processId,
      processInfo.version
    );
    const attempted = connectorAutoRepairAttemptKey === attemptKey;
    if (!attempted) {
      // Mark the process session before fetching the catalog. Any subsequent
      // failure/event burst for this same player can therefore not re-enter
      // the upgrade path.
      connectorAutoRepairAttemptKey = attemptKey;
    }

    let statuses;
    try {
      statuses = await playerManager.getConnectorStatuses(true);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      writeLog(`[连接器兼容恢复] 刷新连接器清单失败：${message}`, 'Yellow');
      setGlobalStatus(CONNECTOR_AUTO_REPAIR_MESSAGES.failed);
      return false;
    }
    const status = statuses.find(item => item.id === connectorId);
    const plan = planConnectorAutoRepair({
      connectorId,
      playerRunning: processInfo.running,
      playerVersion: processInfo.version,
      connectorInstalled: status?.installed === true,
      connectorCurrentVersion: status?.currentVersion,
      connectorLatestVersion: status?.latestVersion,
      connectorSupportedPlayerVersion: status?.supportedPlayerVersion,
      connectorPlayerVersionPolicy: status?.playerVersionPolicy,
      connectorTestedPlayerVersion: status?.testedPlayerVersion,
      connectorCompatible: status?.compatible === true,
      connectorUpdateAvailable: status?.updateAvailable === true,
      connectorAutoUpdateAvailable: status?.autoUpdateAvailable === true,
      connectorManualUpdateAvailable: status?.manualUpdateAvailable === true,
      connectorUpdateKind: status?.updateKind,
      connectorUpdating: status?.updating === true,
      catalogError: status?.error || (!status ? '未找到连接器状态' : null),
      attempted
    });

    if (plan.action !== 'upgrade') {
      if (plan.action === 'missing-connector') {
        writeLog(
          `[连接器兼容恢复] ${PLAYER_LABELS[connectorId]} ${processInfo.version}`
          + ' 没有匹配当前播放器版本的可用连接器。',
          'Yellow'
        );
      } else if (plan.action === 'failed') {
        writeLog(
          `[连接器兼容恢复] ${PLAYER_LABELS[connectorId]} 自动修复未执行：`
          + `${plan.reason}。`,
          'DarkGray'
        );
      }
      setGlobalStatus(plan.message);
      return false;
    }

    const statusOwner = claimConnectorMaintenanceStatus(plan.message);
    try {
      writeLog(
        `[连接器兼容恢复] ${PLAYER_LABELS[connectorId]} ${processInfo.version}`
        + ` 匹配清单，尝试从 ${status?.currentVersion || '未安装'}`
        + ` 升级到 ${status?.latestVersion || '未知'}。`,
        'Cyan'
      );
      const result = await withPlayerConnectionRecoverySuppressed(
        () => playerManager.updateConnector(
          connectorId,
          plan.allowPlayerVersionChange
        )
      );
      writeLog(
        `[连接器兼容恢复] ${result.message}`,
        result.success ? 'Green' : 'Yellow'
      );
      const reconnected = result.success && result.reconnected === true;
      if (reconnected) {
        connectorAutoRepairAttemptKey = '';
        setGlobalStatus(result.message);
        return true;
      }
      setGlobalStatus(CONNECTOR_AUTO_REPAIR_MESSAGES.failed);
      return false;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      writeLog(`[连接器兼容恢复] 自动修复失败：${message}`, 'Yellow');
      setGlobalStatus(CONNECTOR_AUTO_REPAIR_MESSAGES.failed);
      return false;
    } finally {
      releaseConnectorMaintenanceStatus(statusOwner);
    }
  })();
  const tracked = operation.finally(() => {
    if (connectorAutoRepairInFlight === tracked) {
      connectorAutoRepairInFlight = null;
    }
  });
  connectorAutoRepairInFlight = tracked;
  return await tracked;
}

async function connectWithConnectorMaintenanceStatus(
  connect: () => Promise<boolean>
): Promise<boolean> {
  if (connectorConnectionRecoveryInFlight) {
    return await connectorConnectionRecoveryInFlight;
  }

  const operation = (async (): Promise<boolean> => {
    const connectorId = getSelectedNativeConnector();
    let statusOwner = 0;
    if (
      connectorId
      && !await playerManager.isConnectorInstalled(connectorId)
    ) {
      const ownedStatus =
        `正在更新${PLAYER_LABELS[connectorId]}播放器连接器`;
      statusOwner = claimConnectorMaintenanceStatus(ownedStatus);
      writeLog(`[连接器] ${ownedStatus}`, 'Cyan');
    }

    try {
      const connected = await withPlayerConnectionRecoverySuppressed(connect);
      if (connected) {
        connectorAutoRepairAttemptKey = '';
        return true;
      }
      return await runConnectorAutoRepair(connectorId);
    } finally {
      releaseConnectorMaintenanceStatus(statusOwner);
    }
  })();
  const tracked = operation.finally(() => {
    if (connectorConnectionRecoveryInFlight === tracked) {
      connectorConnectionRecoveryInFlight = null;
    }
  });
  connectorConnectionRecoveryInFlight = tracked;
  return await tracked;
}

async function recoverPlayerConnectionAfterFailure(): Promise<void> {
  if (applicationQuitRequested || connectorConnectionRecoveryInFlight) return;
  await connectWithConnectorMaintenanceStatus(
    () => playerManager.reconnect()
  );
}

async function maintainPlayerConnectors(
  forceRefresh = false
): Promise<void> {
  if (connectorMaintenanceRunning) return;
  connectorMaintenanceRunning = true;
  try {
    const statuses = await playerManager.getConnectorStatuses(forceRefresh);
    for (const status of statuses) {
      if (status.error) {
        writeLog(
          `[连接器热更新] ${status.name}检查失败：${status.error}`,
          'Yellow'
        );
        continue;
      }
      if (!status.compatible) {
        writeLog(
          `[连接器热更新] ${status.name}最新版本要求本体 `
          + `${status.minimumCoreVersion}`,
          'Yellow'
        );
        continue;
      }
      if (status.updating) {
        continue;
      }
      if (status.installed && !status.autoUpdateAvailable) {
        if (status.manualUpdateAvailable) {
          writeLog(
            `[连接器热更新] ${status.name} 有新的播放器版本分支 `
            + `${status.latestVersion}，支持播放器版本 `
            + `${status.supportedPlayerVersion || '未注明'}；`
            + '不会自动更新，可在播放器设置中手动确认。',
            'Yellow'
          );
        } else if (status.updateAvailable) {
          writeLog(
            `[连接器热更新] ${status.name} 有不可自动应用的更新 `
            + `${status.latestVersion}，已保留当前版本。`,
            'DarkGray'
          );
        }
        continue;
      }

      const selected = getSelectedNativeConnector() === status.id;
      const ownedStatus = selected && !status.installed
        ? `正在更新${status.name}播放器连接器`
        : '';
      const statusOwner = ownedStatus
        ? claimConnectorMaintenanceStatus(ownedStatus)
        : 0;

      try {
        const result = await withPlayerConnectionRecoverySuppressed(
          () => playerManager.updateConnector(status.id)
        );
        writeLog(
          `[连接器热更新] ${result.message}`,
          result.success ? 'Green' : 'Yellow'
        );
      } finally {
        releaseConnectorMaintenanceStatus(statusOwner);
      }
    }
  } catch (error: unknown) {
    const message = error instanceof Error
      ? error.message
      : String(error);
    writeLog(`[连接器热更新] 后台检查失败：${message}`, 'Yellow');
  } finally {
    connectorMaintenanceRunning = false;
  }
}

async function startPlayerBridge(): Promise<void> {
  await connectWithConnectorMaintenanceStatus(
    () => playerManager.start()
  );
  void maintainPlayerConnectors(true);
}

function startStartupBackgroundServices(): void {
  if (startupBackgroundServicesStarted) return;
  startupBackgroundServicesStarted = true;
  void startPlayerBridge();
  void restartExternalApiServer();
  if (biliCookie) updateCurrentUserInfo();
  if (appConfig.roomConnectionEnabled === true && appConfig.roomId) {
    void connectToLiveRoom(appConfig.roomId, { enable: false });
  }
}

function scheduleStartupBackgroundServices(win: BrowserWindow): void {
  let scheduled = false;
  let fallbackTimer: NodeJS.Timeout | null = null;
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    if (fallbackTimer) clearTimeout(fallbackTimer);
    setImmediate(startStartupBackgroundServices);
  };
  // `ready-to-show` follows the renderer's first completed paint.  The
  // fallback keeps all non-visual services available even if a damaged local
  // renderer never reaches that event.
  win.once('ready-to-show', schedule);
  win.webContents.once('did-fail-load', schedule);
  fallbackTimer = setTimeout(schedule, STARTUP_BACKGROUND_FALLBACK_MS);
}

async function reconnectPlayerBridge(): Promise<boolean> {
  clearDeferredQqInsert();
  updatePlayerCurrentTrack('', '');
  return await connectWithConnectorMaintenanceStatus(
    () => playerManager.reconnect()
  );
}

async function startPlayerRadar(): Promise<boolean> {
  clearDeferredQqInsert();
  playerManager.resetObservedTrack();
  updatePlayerCurrentTrack('', '');
  return await connectWithConnectorMaintenanceStatus(
    () => playerManager.connectSelected()
  );
}

async function executePlayerCommand(
  command: string,
  song?: any
): Promise<PlayerOperationResult | null> {
  const playerKey = getSelectedPlayerKey();
  const result = await playerManager.execute(
    command as Parameters<PlayerManager['execute']>[0],
    song
  );
  const snapshot = result?.snapshot || activePlayerSnapshot;
  const hintInput = {
    playerKey,
    connected: Boolean(snapshot?.connected ?? isPlayerConnected),
    playerVersion: snapshot?.version || '',
    command,
    outcome: result?.outcome || 'error',
    processId: snapshot?.processId ?? null,
    failureCode: result?.failureCode,
    message: result?.message
  };
  const hint = buildPlayerProcessAccessHint(hintInput)
    || buildPlayerUpgradeHint(hintInput);
  if (hint) {
    const duplicate = Boolean(
      playerControlNotice
      && playerControlNotice.code === hint.code
      && playerControlNotice.playerKey === hint.playerKey
      && playerControlNotice.currentVersion === hint.currentVersion
      && playerControlNotice.blockedCommand === hint.blockedCommand
      && playerControlNotice.processId === hint.processId
    );
    playerControlNotice = {
      ...hint,
      detectedAt: new Date().toISOString()
    };
    if (!duplicate && hint.kind === 'upgrade') {
      writeLog(
        `[播放器兼容] ${hint.playerName} ${hint.currentVersion} 低于`
        + `当前已验证版本 ${hint.testedPlayerVersion}，且 `
        + `${hint.blockedCommand} 未生效。请升级播放器，完全退出并`
        + '重新打开后再连接。',
        'Yellow'
      );
    }
    if (!duplicate && hint.kind === 'process-access') {
      writeLog(
        `[播放器权限] Windows 拒绝了 ${hint.playerName} 的`
        + `${hint.operation}。请确认点歌机与播放器使用相同运行权限，`
        + '并检查 360、Windows 安全中心或其他安全软件的拦截记录。'
        + '确认是安全软件拦截后，请恢复防护并仅信任点歌机程序目录与'
        + '%APPDATA%\\嗷呜点歌机\\player-connectors。',
        'Yellow'
      );
    }
    setGlobalStatus(hint.kind === 'upgrade'
      ? `⚠️ ${hint.playerName}版本较旧，点歌控制未生效，请打开设置升级播放器`
      : `⚠️ ${hint.playerName}控制被 Windows 拒绝，请打开设置检查权限`);
  } else if (
    playerControlNotice?.playerKey === playerKey
    && isUpgradeSensitivePlayerCommand(command)
    && isSuccessfulPlayerResult(result)
  ) {
    playerControlNotice = null;
  }
  return result;
}

async function pauseActivePlayerAfterRequests(): Promise<void> {
  if (isPausingAfterRequests) return;
  if (activePlayerSnapshot?.capabilities?.pause === false) {
    writeLog(
      `[播放策略] ${getSelectedPlayerLabel()}连接器不支持明确暂停，`
      + '已保持主播歌单原状态，避免把 Toggle 误当 Pause',
      'Yellow'
    );
    setGlobalStatus('当前播放器不支持可靠的自动暂停');
    return;
  }
  isPausingAfterRequests = true;
  try {
    const result = await executePlayerCommand('Pause');
    if (isSuccessfulPlayerResult(result)) {
      playerPausedAfterRequests = true;
      writeLog('[播放策略] 最后一首点歌已结束，播放器已自动暂停', 'Green');
      setGlobalStatus('点歌已播完，播放器已暂停');
    }
  } finally {
    isPausingAfterRequests = false;
  }
}

async function requestPlayerNext(): Promise<boolean> {
  playerPausedAfterRequests = false;
  const result = await executePlayerCommand('Next');
  return isSuccessfulPlayerResult(result);
}

function getNextGuardKey(songInfo: any): string {
  const source = activePlayerSnapshot?.current;
  const sourceKey = String(
    source?.id
    || `${source?.title || playerCurrentTrack?.SongName || ''}|`
      + `${source?.artist || playerCurrentTrack?.ArtistName || ''}`
  );
  return [
    getSelectedPlayerKey(),
    sourceKey,
    songInfo?.PlayerKey || getSelectedPlayerKey(),
    songInfo?.Id || '',
    songInfo?.SongName || ''
  ].join('|');
}

function getQueueSongIdentity(songInfo: any): string {
  return queueSongIdentity(songInfo, getSelectedPlayerKey());
}

function clearDeferredQqInsert(): void {
  deferredQqInsertIdentity = '';
  qqDeferredInsertRetryAttempted = false;
  qqDeferredInsertRetryInFlight = false;
}

function deferQqInsert(songInfo: any): void {
  if (getSelectedPlayerKey() !== 'qqmusic' || !songInfo) return;
  const identity = getQueueSongIdentity(songInfo);
  if (!identity) return;
  if (deferredQqInsertIdentity !== identity) {
    deferredQqInsertIdentity = identity;
    qqDeferredInsertRetryAttempted = false;
    qqDeferredInsertRetryInFlight = false;
  }
  writeLog(
    `[队首守卫] QQ 音乐尚未播放过歌曲，已暂缓插入下一首: ${songInfo.SongName}`,
    'Yellow'
  );
  setGlobalStatus('等待 QQ 音乐首次播放后插入下一首');
}

function syncDeferredQqInsertWithQueueHead(): void {
  if (!deferredQqInsertIdentity) return;
  const headIdentity = getQueueSongIdentity(targetQueue[0]);
  if (headIdentity !== deferredQqInsertIdentity) {
    clearDeferredQqInsert();
  }
}

async function serializeNextGuardOperation<T>(
  operation: () => Promise<T>
): Promise<T> {
  let release!: () => void;
  const previous = nextGuardOperationTail;
  nextGuardOperationTail = new Promise<void>(resolve => {
    release = resolve;
  });
  await previous;
  try {
    return await operation();
  } finally {
    release();
  }
}

async function waitForManagedPlayerActionSettlement(): Promise<void> {
  const deadline = Date.now() + 12_500;
  while (activeManagedPlayerAction && Date.now() < deadline) {
    await new Promise<void>(resolve => setTimeout(resolve, 40));
  }
}

async function guardNextSong(
  songInfo: any,
  playbackAnchorReadyOverride?: boolean
): Promise<boolean> {
  return serializeNextGuardOperation(async () => {
    if (!songInfo) return false;
    const playbackAnchorReady = playbackAnchorReadyOverride === undefined
      ? activePlayerSnapshot?.playbackAnchorReady === true
      : playbackAnchorReadyOverride === true;
    const songIdentity = getQueueSongIdentity(songInfo);
    const deferredAction = planQqAnchorObservation({
      playerKey: getSelectedPlayerKey(),
      playbackAnchorReady,
      deferredIdentity: deferredQqInsertIdentity,
      queueHeadIdentity: songIdentity,
      retryAttempted: qqDeferredInsertRetryAttempted,
      retryInFlight: qqDeferredInsertRetryInFlight
    });
    if (deferredAction === 'clear') {
      clearDeferredQqInsert();
    } else if (
      deferredAction === 'none'
      && shouldSkipDuplicateQqAnchorInsert({
        playerKey: getSelectedPlayerKey(),
        songIdentity,
        deferredIdentity: deferredQqInsertIdentity,
        playbackAnchorReady,
        retryAttempted: qqDeferredInsertRetryAttempted,
        retryInFlight: qqDeferredInsertRetryInFlight
      })
    ) {
      setGlobalStatus(
        qqDeferredInsertRetryAttempted
          ? 'QQ 音乐插入下一首失败，请在基础设置重连后重试'
          : '等待 QQ 音乐首次播放后插入下一首'
      );
      return true;
    }
    if (
      shouldDeferQqQueueHeadForMissingAnchor(playbackAnchorReady)
      && deferredAction !== 'retry'
    ) {
      // Do not even send InsertNext to a cold QQ playlist. Older connectors
      // may not return the structured failure, so the host must keep this
      // request local until playbackAnchorReady is explicitly true.
      deferQqInsert(songInfo);
      return true;
    }
    if (deferredAction === 'retry') {
      // A ready snapshot is not itself the observation-owned takeover path.
      // Keep the deferred request local until the observation callback can
      // run the verified PlaySelected transaction exactly once.
      setGlobalStatus('等待 QQ 音乐首次播放后接管队首');
      return true;
    }
    if (queueHeadNeedsGuardOnlyAfterCurrentChange) {
      writeLog(
        `ℹ️ 正在等待立即播放目标真正开始，暂不提前插入后续队首: ${songInfo.SongName}`,
        'DarkGray'
      );
      return true;
    }
    const guardKey = getNextGuardKey(songInfo);
    if (registeredNextGuardKey === guardKey) {
      writeLog(
        `ℹ️ 队首下一首已经登记，跳过重复插入: ${songInfo.SongName}`,
        'DarkGray'
      );
      return true;
    }
    const result = await executePlayerCommand('InsertNext', songInfo);
    if (isSuccessfulPlayerResult(result)) {
      queueHeadNeedsGuardOnlyAfterCurrentChange = false;
      registeredNextGuardKey = guardKey;
      registeredNextGuardSongIdentity = getQueueSongIdentity(songInfo);
      writeLog(`✅ 已登记下一首守卫: ${songInfo.SongName}`, 'DarkGray');
      return true;
    }
    if (isQqPlaybackAnchorMissing({
      playerKey: getSelectedPlayerKey(),
      command: 'InsertNext',
      failureCode: result?.failureCode
    })) {
      deferQqInsert(songInfo);
      return true;
    }
    if (registeredNextGuardKey === guardKey) {
      registeredNextGuardKey = '';
      registeredNextGuardSongIdentity = '';
    }
    return false;
  });
}

async function armNextGuardOnly(songInfo: any): Promise<boolean> {
  return serializeNextGuardOperation(async () => {
    if (!songInfo) return false;
    const guardKey = getNextGuardKey(songInfo);
    const result = await executePlayerCommand('ArmNextGuard', songInfo);
    if (isSuccessfulPlayerResult(result)) {
      registeredNextGuardKey = guardKey;
      registeredNextGuardSongIdentity = getQueueSongIdentity(songInfo);
      writeLog(
        `🛡️ 队首已变化，只更新兜底目标且未再次插入播放器队列: ${songInfo.SongName}`,
        'DarkGray'
      );
      return true;
    }

    registeredNextGuardKey = '';
    registeredNextGuardSongIdentity = '';
    writeLog(
      `[队首守卫] 连接器未能只更新兜底目标，将由主程序在切歌后纠正: ${songInfo.SongName}`,
      'Yellow'
    );
    return false;
  });
}

function rememberCancelledNativeNext(songInfo: any): void {
  if (!songInfo) return;
  cancelledNativeNextSongs.set(getQueueSongIdentity(songInfo), songInfo);
  while (cancelledNativeNextSongs.size > 64) {
    const oldest = cancelledNativeNextSongs.keys().next().value;
    if (typeof oldest !== 'string') break;
    cancelledNativeNextSongs.delete(oldest);
  }
}

async function reconcileQueueHeadAfterMutation(
  previousHead: any,
  context: string
): Promise<void> {
  const nextHead = targetQueue[0] || null;
  syncDeferredQqInsertWithQueueHead();
  const hadRegisteredNext = Boolean(registeredNextGuardKey)
    && registeredNextGuardSongIdentity
      === getQueueSongIdentity(previousHead);
  const action = planQueueHeadMutation({
    previousHeadIdentity: getQueueSongIdentity(previousHead),
    nextHeadIdentity: getQueueSongIdentity(nextHead),
    hadRegisteredNext,
    isPlaying
  });
  if (action === 'none') return;

  registeredNextGuardKey = '';
  registeredNextGuardSongIdentity = '';
  if (action === 'insert') {
    await guardNextSong(nextHead);
    return;
  }

  if (action === 'cancel-native') {
    rememberCancelledNativeNext(previousHead);
    writeLog(
      `[${context}] 播放器中已预插的旧队首无法撤销；若它开始播放将立即跳过`,
      'Yellow'
    );
    return;
  }

  await armNextGuardOnly(nextHead);
}

async function playSongNow(
  songInfo: any,
  mode: 'play-now' | 'interrupt' = 'play-now'
): Promise<boolean> {
  if (!songInfo) return false;
  clearDeferredQqInsert();
  playerPausedAfterRequests = false;
  const operationState = await serializeNextGuardOperation(async () => {
    const previousCurrentPlayingSong = currentPlayingSong;
    const hadRegisteredNativeNext = Boolean(registeredNextGuardKey)
      && registeredNextGuardSongIdentity
        === getQueueSongIdentity(targetQueue[0]);
    const command = planImmediatePlaybackCommand({
      playerKey: getSelectedPlayerKey(),
      mode,
      hasCurrentSong: Boolean(previousCurrentPlayingSong)
    });
    queueHeadNeedsGuardOnlyAfterCurrentChange =
      shouldPreserveGuardAfterImmediate({
        command,
        hadRegisteredGuard: hadRegisteredNativeNext,
        hasDisplacedCurrentSong: Boolean(previousCurrentPlayingSong)
      });
    registeredNextGuardKey = '';
    registeredNextGuardSongIdentity = '';
    currentPlayingSong = songInfo;
    const managedAction: ManagedPlayerAction = {
      id: ++managedPlayerActionSequence,
      kind: mode,
      target: songInfo,
      command,
      startedAt: Date.now(),
      expiresAt: Date.now() + 12_000,
      inFlight: true,
      targetObserved: false,
      previousCurrentPlayingSong
    };
    activeManagedPlayerAction = managedAction;
    setTimeout(() => {
      if (
        activeManagedPlayerAction?.id === managedAction.id
        && Date.now() >= managedAction.expiresAt
      ) {
        expireManagedAction(managedAction);
      }
    }, Math.max(0, managedAction.expiresAt - Date.now() + 50));
    writeLog(
      `[动作归因] 开始点歌机动作 #${managedAction.id}: ${command} -> `
      + songInfo.SongName,
      'DarkGray'
    );
    const result = await executePlayerCommand(command, songInfo);
    managedAction.inFlight = false;
    if (
      managedAction.targetObserved
      && activeManagedPlayerAction?.id === managedAction.id
    ) {
      activeManagedPlayerAction = null;
    }
    return {
      previousCurrentPlayingSong,
      hadRegisteredNativeNext,
      result,
      managedAction
    };
  });
  const {
    previousCurrentPlayingSong,
    hadRegisteredNativeNext,
    result,
    managedAction
  } = operationState;

  if (!isSuccessfulPlayerResult(result)) {
    if (isObservedSong(songInfo)) return true;
    if (managedAction && activeManagedPlayerAction?.id === managedAction.id) {
      activeManagedPlayerAction = null;
    }
    currentPlayingSong = previousCurrentPlayingSong;
    queueHeadNeedsGuardOnlyAfterCurrentChange = false;
    if (hadRegisteredNativeNext && targetQueue[0]) {
      await armNextGuardOnly(targetQueue[0]);
    }
    return false;
  }
  if (String(result?.outcome).toLowerCase() === 'indeterminate') {
    if (isObservedSong(songInfo)) return true;
    if (managedAction && activeManagedPlayerAction?.id === managedAction.id) {
      activeManagedPlayerAction = null;
    }
    currentPlayingSong = previousCurrentPlayingSong;
    writeLog(
      `[立即播放] 命令已发出但播放器未确认目标，保留本地队首等待实际切歌: ${songInfo.SongName}`,
      'Yellow'
    );
    queueHeadNeedsGuardOnlyAfterCurrentChange = false;
    if (hadRegisteredNativeNext && targetQueue[0]) {
      await armNextGuardOnly(targetQueue[0]);
    }
    return false;
  }

  setGlobalStatus(`[播放] ${songInfo.SongName}`);
  return true;
}

function isObservedSong(songInfo: any): boolean {
  return tracksRepresentSameSong(songInfo, playerCurrentTrack);
}

function expireManagedAction(action: ManagedPlayerAction): void {
  if (activeManagedPlayerAction?.id !== action.id) return;

  const targetObserved = action.targetObserved
    || isObservedSong(action.target);
  const targetIdentity = getQueueSongIdentity(action.target);
  const targetStillCurrent = Boolean(currentPlayingSong)
    && getQueueSongIdentity(currentPlayingSong) === targetIdentity;
  const previousCurrentObserved = Boolean(action.previousCurrentPlayingSong)
    && isObservedSong(action.previousCurrentPlayingSong);
  const decision = planManagedActionTimeout({
    targetObserved,
    targetStillCurrent,
    previousCurrentObserved
  });

  if (decision !== 'keep-requested' && targetStillCurrent) {
    currentPlayingSong = decision === 'restore-previous'
      ? action.previousCurrentPlayingSong
      : null;
    queueHeadNeedsGuardOnlyAfterCurrentChange = false;
    writeLog(
      `[动作归因] 点歌机动作 #${action.id} 超时且未确认目标；`
      + (currentPlayingSong
        ? `已恢复上一首: ${currentPlayingSong.SongName}`
        : '已恢复播放器实际状态，不再标记为点歌播放。'),
      'Yellow'
    );
    setGlobalStatus(
      currentPlayingSong
        ? `[播放] ${currentPlayingSong.SongName}`
        : playerCurrentTrack
          ? `[播放器] ${playerCurrentTrack.SongName}`
          : '点歌目标未确认'
    );
  } else {
    writeLog(
      `[动作归因] 点歌机动作 #${action.id} 已超时；`
      + '后续切歌恢复按播放器端/用户操作处理。',
      'Yellow'
    );
  }

  activeManagedPlayerAction = null;
}

function getWebSocketClient() {
  return WebSocket;
}
// ==========================================
// 核心功能：获取 B站 头像与用户信息
// ==========================================
async function getBiliAvatar(uid: string): Promise<string> {
  try {
    const res = await fetchWithTimeout(`https://api.bilibili.com/x/web-interface/card?mid=${uid}`, { headers: { "User-Agent": "Mozilla/5.0", "Referer": "https://www.bilibili.com/" } }, 8_000);
    const data: any = await res.json();
    if (data.code === 0 && data.data?.card?.face) return data.data.card.face;
  } catch {}
  return `https://api.dicebear.com/7.x/identicon/svg?seed=${uid}`;
}

async function updateCurrentUserInfo(expectedCookie: string = biliCookie): Promise<boolean> {
  if (!expectedCookie) return false;
  const headers: any = { "User-Agent": "Mozilla/5.0", "Referer": "https://www.bilibili.com/", "Cookie": expectedCookie };

  try {
    const navRes = await fetchWithTimeout("https://api.bilibili.com/x/web-interface/nav", { headers });
    const navData: any = await navRes.json();
    if (navData.code !== 0 || navData.data?.isLogin !== true || !Number(navData.data?.mid)) {
      writeLog(`[Bilibili] 登录凭据校验失败 code=${navData.code ?? 'unknown'}`, 'Yellow');
      return false;
    }

    const d = navData.data;
    const nextUserInfo = createEmptyBiliUserInfo();
    nextUserInfo.uid = Number(d.mid) || 0;
    nextUserInfo.uname = d.uname || '';
    nextUserInfo.face = d.face || '';
    nextUserInfo.level = d.level_info?.current_level ?? 0;

    try {
      const roomRes = await fetchWithTimeout(`https://api.live.bilibili.com/room/v1/Room/getRoomInfoOld?mid=${nextUserInfo.uid}`, { headers });
      const roomData: any = await roomRes.json();
      if (roomData.code === 0 && Number(roomData.data?.roomid) > 0) nextUserInfo.myRoomId = Number(roomData.data.roomid);
    } catch { }

    try {
      const statRes = await fetchWithTimeout(`https://api.bilibili.com/x/relation/stat?vmid=${nextUserInfo.uid}`, { headers });
      const statData: any = await statRes.json();
      if (statData.code === 0 && statData.data?.follower !== undefined) nextUserInfo.followerCount = Number(statData.data.follower) || 0;
    } catch { }

    if (nextUserInfo.myRoomId > 0) {
      try {
        const guardRes = await fetchWithTimeout(`https://api.live.bilibili.com/xlive/app-room/v2/guardTab/topList?roomid=${nextUserInfo.myRoomId}&page=1&ruid=${nextUserInfo.uid}&page_size=1`, { headers });
        const guardData: any = await guardRes.json();
        if (guardData.code === 0 && guardData.data?.info?.num !== undefined) nextUserInfo.guardCount = Number(guardData.data.info.num) || 0;
      } catch { }

      try {
        const clubRes = await fetchWithTimeout(`https://api.live.bilibili.com/live_user/v1/Club/get_club_info?uid=${nextUserInfo.uid}`, { headers });
        const clubData: any = await clubRes.json();
        if (clubData.code === 0 && clubData.data && !Array.isArray(clubData.data) && clubData.data.fans_num !== undefined) nextUserInfo.fanClubCount = Number(clubData.data.fans_num) || 0;
      } catch { }
    }

    // 扫码、退出登录或更换账号可能在网络请求期间发生；过期请求不得覆盖较新的登录状态。
    if (biliCookie !== expectedCookie) return false;

    currentUserInfo = nextUserInfo;
    biliUid = nextUserInfo.uid;
    if (nextUserInfo.myRoomId > 0) {
      appConfig.myRoomId = nextUserInfo.myRoomId;
      if (!appConfig.roomId) {
        appConfig.roomId = nextUserInfo.myRoomId;
        writeLog(`>>> [账号] 检测到本账号直播间 ${nextUserInfo.myRoomId}，已自动设为监控房间。`, 'Cyan');
      }
    }
    saveConfig();
    return true;
  } catch (err: any) {
    writeLog(`[系统] 获取用户信息失败: ${err.message}`, 'Yellow');
    return false;
  }
}

// ==========================================
// B站弹幕点歌逻辑处理
// ==========================================
interface SongRequestResult {
  success: boolean;
  mode: LocalSongRequestMode;
  keyword: string;
  message: string;
  song?: any;
  queued?: boolean;
  playbackConfirmed?: boolean;
  guardRegistered?: boolean | null;
}

async function serializeLocalTestRequest<T>(
  operation: () => Promise<T>
): Promise<T> {
  let release!: () => void;
  const previous = localTestRequestTail;
  localTestRequestTail = new Promise<void>(resolve => {
    release = resolve;
  });
  await previous;
  try {
    return await operation();
  } finally {
    release();
  }
}

async function tryRequestSong(
  user: any,
  keyword: string,
  mode: LocalSongRequestMode = 'normal'
): Promise<SongRequestResult> {
  try {
    const normalizedKeyword = keyword.replace(/\s+/g, '');
    if (normalizedKeyword === '贞理的小曲' || normalizedKeyword === '真理的小曲') {
      keyword = 'missing you 具岛直子';
    }

    const playerKey = getSelectedPlayerKey();
    const track = (await playerManager.search(keyword))[0];

    if (!track) {
      setGlobalStatus(`❌ 未搜到: ${keyword}`);
      await addReject(user, `未搜到歌曲: ${keyword}`);
      return {
        success: false,
        mode,
        keyword,
        message: `未搜到歌曲: ${keyword}`
      };
    }

    const avatarUrl = user.avatar || await getBiliAvatar(user.uid);
    const coverUrl = track.coverUrl || (playerKey === 'netease'
      ? await getNcmSongCover(track.id)
      : '');
    const newSong = {
      Id: String(track.id),
      SongName: track.title,
      ArtistName: track.artist || '未知歌手',
      Album: track.album || '',
      NativeData: track.nativeData || '',
      PlayerKey: playerKey,
      OrderedBy: user.name || user.uname || `游客${String(user.uid).slice(-6)}`,
      OrderedByUid: user.uid,
      OrderedByAvatar: avatarUrl,
      CoverUrl: coverUrl,
      GuardLevel: user.guardLevel
    };
    cancelledNativeNextSongs.delete(getQueueSongIdentity(newSong));

    if (mode === 'interrupt') {
      await waitForManagedPlayerActionSettlement();
      if (currentPlayingSong) targetQueue.unshift(currentPlayingSong);
      setGlobalStatus(`⚡ 插队: ${newSong.SongName}`);
      const playbackConfirmed = await playSongNow(newSong, 'interrupt');
      if (!playbackConfirmed) targetQueue.unshift(newSong);
      return {
        success: true,
        mode,
        keyword,
        message: playbackConfirmed
          ? `已确认插队播放: ${newSong.SongName}`
          : `插队播放未确认，已保留到队首: ${newSong.SongName}`,
        song: newSong,
        queued: !playbackConfirmed,
        playbackConfirmed
      };
    }

    if (mode === 'play_now') {
      await waitForManagedPlayerActionSettlement();
      setGlobalStatus(`▶️ 立即: ${newSong.SongName}`);
      const playbackConfirmed = await playSongNow(newSong);
      if (!playbackConfirmed) targetQueue.unshift(newSong);
      return {
        success: true,
        mode,
        keyword,
        message: playbackConfirmed
          ? `已确认立即播放: ${newSong.SongName}`
          : `立即播放未确认，已保留到队首: ${newSong.SongName}`,
        song: newSong,
        queued: !playbackConfirmed,
        playbackConfirmed
      };
    }

    const previousHead = targetQueue[0] || null;
    if (mode === 'top') {
      targetQueue.unshift(newSong);
      setGlobalStatus(`⬆️ 置顶: ${newSong.SongName}`);
    } else {
      targetQueue.push(newSong);
      setGlobalStatus(`✅ 点歌: ${newSong.SongName}`);
    }

    let guardRegistered: boolean | null = null;
    if (mode === 'top' && previousHead) {
      await reconcileQueueHeadAfterMutation(previousHead, '置顶点歌');
    } else if (!previousHead && isPlaying) {
      if (
        appConfig.sysConfig?.IdleWaitNext === false
        && !currentPlayingSong
      ) {
        const first = targetQueue[0];
        if (first) {
          // A normal first request must not use PlaySelected while QQ has no
          // native playback cursor: that path can consume the playlist head.
          guardRegistered = shouldDeferQqQueueHeadForMissingAnchor()
            ? await guardNextSong(first)
            : await playSongNow(first);
        }
      } else {
        guardRegistered = await guardNextSong(targetQueue[0]);
      }
    }
    return {
      success: true,
      mode,
      keyword,
      message: mode === 'top'
        ? `已置顶: ${newSong.SongName}`
        : `已加入待播队列: ${newSong.SongName}`,
      song: newSong,
      queued: true,
      guardRegistered
    };
  } catch (err: any) {
    writeLog(`[点歌搜索] ${getSelectedPlayerLabel()} 搜索异常: ${err?.message || err}`, 'Red');
    setGlobalStatus('❌ 搜索或播放器通信异常');
    await addReject(user, '搜索或播放器通信异常');
    return {
      success: false,
      mode,
      keyword,
      message: err?.message || String(err)
    };
  }
}

async function handleDanmaku(user: any, msg: string): Promise<void> {
  if (msg.toLowerCase().includes('test') || msg.includes('测试')) writeLog(`[弹幕] 测试通信: ${msg}`, 'Cyan');

  const isOrder = msg.startsWith('点歌') || msg.startsWith('點歌');
  const isTopOrder = msg.startsWith('置顶点歌') || msg.startsWith('优先点歌');
  const isInterruptOrder = msg.startsWith('插队点歌');
  const isPlayNowOrder = msg.startsWith('立即点歌');
  const isCancel = msg.startsWith('撤回');
  const isSkip = msg === '切歌' || msg === '跳过';
  const isToggleAccept = (
    msg === '开始接单'
    || msg === '开启点歌'
    || msg === '停止接单'
    || msg === '关闭点歌'
  );

  if (!isAccepting && (isOrder || isTopOrder || isInterruptOrder || isPlayNowOrder || isCancel || isSkip)) return;

  if (isToggleAccept) {
    const permission = checkPermission(user, 'ToggleAcceptPermission');
    if (!permission.allowed) {
      await addReject(user, permission.reason || '权限不足');
      return;
    }
    isAccepting = msg === '开始接单' || msg === '开启点歌';
    setGlobalStatus(isAccepting ? '✅ 已开始接单' : '⏸️ 已停止接单');
    return;
  }

  if (isCancel) {
    const keyword = msg.replace(/^撤回/, '').trim();
    if (keyword) {
      const perm = checkPermission(user, 'ForceControlPermission');
      if (!perm.allowed) { await addReject(user, "权限不足: 需要强控权限"); return; }
      const idx = targetQueue.findIndex(s => s.SongName.includes(keyword) || s.ArtistName.includes(keyword));
      if (idx !== -1) {
        const previousHead = targetQueue[0] || null;
        const removed = targetQueue.splice(idx, 1)[0];
        if (idx === 0) {
          await reconcileQueueHeadAfterMutation(previousHead, '强行撤回');
        }
        setGlobalStatus(`🗑️ 强行撤回: ${removed.SongName}`);
      }
      else await addReject(user, "撤回失败: 未在队列中找到");
    } else {
      const perm = checkPermission(user, 'CancelPermission');
      if (!perm.allowed) { await addReject(user, perm.reason!); return; }
      let foundIdx = -1;
      for (let i = targetQueue.length - 1; i >= 0; i--) { if (targetQueue[i].OrderedByUid === user.uid) { foundIdx = i; break; } }
      if (foundIdx !== -1) {
        const previousHead = targetQueue[0] || null;
        const removed = targetQueue.splice(foundIdx, 1)[0];
        if (foundIdx === 0) {
          await reconcileQueueHeadAfterMutation(previousHead, '撤回点歌');
        }
        setGlobalStatus(`🗑️ 已撤回: ${removed.SongName}`);
      }
      else await addReject(user, "队列中没有你点的歌");
    }
    return;
  }

  if (isSkip) {
    const perm = checkPermission(user, 'SkipPermission');
    if (!perm.allowed) { await addReject(user, perm.reason!); return; }
    setGlobalStatus('⏭️ 已手动切歌');
    await requestPlayerNext();
    return;
  }

  if (isOrder || isTopOrder || isInterruptOrder || isPlayNowOrder) {
    let keyword = ''; let mode: 'normal' | 'top' | 'interrupt' | 'play_now' = 'normal';
    if (isPlayNowOrder) { keyword = msg.replace(/^立即点歌/, '').trim(); mode = 'play_now'; }
    else if (isInterruptOrder) { keyword = msg.replace(/^插队点歌/, '').trim(); mode = 'interrupt'; }
    else if (isTopOrder) { keyword = msg.replace(/^(置顶点歌|优先点歌)/, '').trim(); mode = 'top'; }
    else { keyword = msg.substring(2).trim(); }

    const isSuperUser = isConfiguredSuperUser(user);
    if (!isSuperUser) {
      const cds = appConfig.sysConfig?.Cooldowns || { Normal: 0, Captain: 0, Admiral: 0, Governor: 0 };
      let cdSeconds = cds.Normal;
      if (user.guardLevel === 3) cdSeconds = cds.Captain;
      if (user.guardLevel === 2) cdSeconds = cds.Admiral;
      if (user.guardLevel === 1) cdSeconds = cds.Governor;

      if (cdSeconds > 0) {
        const passed = (Date.now() - (userCooldowns.get(user.uid) || 0)) / 1000;
        if (passed < cdSeconds) { await addReject(user, `冷却中，需等待 ${Math.ceil(cdSeconds - passed)} 秒`); return; }
      }
    }

    if (mode === 'top') { const perm = checkPermission(user, 'PriorityPermission'); if (!perm.allowed) { await addReject(user, perm.reason!); return; } }
    else if (mode === 'interrupt' || mode === 'play_now') { const perm = checkPermission(user, 'ForceControlPermission'); if (!perm.allowed) { await addReject(user, perm.reason!); return; } }
    else { const perm = checkPermission(user, 'OrderPermission'); if (!perm.allowed) { await addReject(user, perm.reason!); return; } }

    if (keyword) {
      const uid = String(user.uid || '');
      const { tier, requirement } = getGiftRequirementForGuardLevel(
        user.guardLevel
      );
      const currentCredits = giftRequestCredits.get(uid) || 0;
      if (!canRequestWithGiftCredits(
        requirement,
        currentCredits,
        isSuperUser
      )) {
        await addReject(
          user,
          `${giftRequestTierLabel(tier)}点歌需要先赠送 ${describeGiftRequestRequirement(requirement)}；每赠送 1 个增加 1 次点歌`
        );
        return;
      }

      const result = await tryRequestSong(user, keyword, mode);
      if (result.success) {
        userCooldowns.set(uid, Date.now());
        const remainingCredits = consumeGiftRequestCredit(
          requirement,
          currentCredits,
          isSuperUser,
          true
        );
        if (remainingCredits !== currentCredits) {
          if (remainingCredits > 0) giftRequestCredits.set(uid, remainingCredits);
          else giftRequestCredits.delete(uid);
          writeLog(
            `[礼物点歌] ${user.uname || uid} 使用 1 次点歌，当前剩余 ${remainingCredits} 次`,
            'DarkGray'
          );
        }
      }
    }
  }
}

// ==========================================
// B站扫码登录核心逻辑
// ==========================================
const BILI_LOGIN_COOKIE_NAMES = ['DedeUserID', 'DedeUserID__ckMd5', 'SESSDATA', 'bili_jct', 'sid', 'buvid3', 'buvid4'];

function getCanonicalBiliCookieName(name: string): string | null {
  return BILI_LOGIN_COOKIE_NAMES.find(cookieName => cookieName.toLowerCase() === name.toLowerCase()) || null;
}

function collectBiliCookiesFromUrl(rawUrl: string, cookies: Map<string, string>, depth: number = 0) {
  if (!rawUrl || depth > 2) return;

  try {
    const parsedUrl = new URL(rawUrl, 'https://passport.bilibili.com/');
    const collectRawQuery = (rawQuery: string) => {
      for (const pair of rawQuery.replace(/^\?/, '').split('&')) {
        if (!pair) continue;
        const separatorIndex = pair.indexOf('=');
        const rawKey = separatorIndex >= 0 ? pair.slice(0, separatorIndex) : pair;
        const rawValue = separatorIndex >= 0 ? pair.slice(separatorIndex + 1) : '';
        let decodedKey = rawKey;
        try { decodedKey = decodeURIComponent(rawKey.replace(/\+/g, ' ')); } catch {}

        const cookieName = getCanonicalBiliCookieName(decodedKey);
        // Cookie 值必须保留 B站返回的百分号编码；URLSearchParams 会解码 SESSDATA，导致凭据失效。
        if (cookieName && rawValue) cookies.set(cookieName, rawValue);

        if (!cookieName && depth < 2 && /^(?:https?%3A|https?:)/i.test(rawValue)) {
          let nestedUrl = rawValue;
          try { nestedUrl = decodeURIComponent(rawValue); } catch {}
          collectBiliCookiesFromUrl(nestedUrl, cookies, depth + 1);
        }
      }
    };

    collectRawQuery(parsedUrl.search);

    const rawHash = parsedUrl.hash.replace(/^#/, '');
    if (rawHash) collectRawQuery(rawHash.includes('?') ? rawHash.slice(rawHash.indexOf('?')) : rawHash);
  } catch {}
}

function collectBiliCookiesFromResponse(response: Response, cookies: Map<string, string>) {
  const responseHeaders: any = response.headers;
  const setCookieHeaders: string[] = typeof responseHeaders.getSetCookie === 'function'
    ? responseHeaders.getSetCookie()
    : [response.headers.get('set-cookie') || ''];

  for (const setCookieHeader of setCookieHeaders) {
    if (!setCookieHeader) continue;
    for (const cookieName of BILI_LOGIN_COOKIE_NAMES) {
      const escapedName = cookieName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const match = setCookieHeader.match(new RegExp(`(?:^|[,;]\\s*)${escapedName}=([^;,\\s]+)`, 'i'));
      if (match?.[1]) cookies.set(cookieName, match[1]);
    }
  }
}

async function collectBiliCookiesFromLoginRedirect(loginUrl: string, headers: Record<string, string>, cookies: Map<string, string>) {
  let currentUrl = loginUrl;

  for (let redirectCount = 0; redirectCount < 5 && currentUrl; redirectCount++) {
    collectBiliCookiesFromUrl(currentUrl, cookies);

    let parsedUrl: URL;
    try { parsedUrl = new URL(currentUrl); } catch { return; }
    if (!['https:', 'http:'].includes(parsedUrl.protocol)) return;

    try {
      const response = await fetchWithTimeout(parsedUrl, { headers, redirect: 'manual' });
      collectBiliCookiesFromResponse(response, cookies);
      const location = response.headers.get('location');
      if (!location || response.status < 300 || response.status >= 400) return;
      currentUrl = new URL(location, parsedUrl).toString();
    } catch {
      return;
    }
  }
}

function serializeBiliLoginCookies(cookies: Map<string, string>): string {
  return BILI_LOGIN_COOKIE_NAMES
    .filter(cookieName => cookies.has(cookieName))
    .map(cookieName => `${cookieName}=${cookies.get(cookieName)}`)
    .join('; ');
}

function stopBiliQrPolling() {
  if (qrPollTimer) clearInterval(qrPollTimer);
  qrPollTimer = null;
}

async function startBiliQrLogin() {
  if (isQrLoggingIn) return;
  const attemptId = ++qrLoginAttemptId;
  isQrLoggingIn = true; qrCodeBase64 = ""; qrLoginStatus = "正在向 B站请求二维码...";

  try {
    const headers = { "User-Agent": "Mozilla/5.0" };
    const genRes = await fetchWithTimeout("https://passport.bilibili.com/x/passport-login/web/qrcode/generate", { headers });
    const genData: any = await genRes.json();
    if (!genData.data?.url) { qrLoginStatus = "错误：无法获取二维码"; isQrLoggingIn = false; return; }

    qrCodeBase64 = await QRCode.toDataURL(genData.data.url, {
      width: 256,
      margin: 2,
      errorCorrectionLevel: 'M'
    });
    qrLoginStatus = "请使用手机 B站 APP 扫码";

    stopBiliQrPolling();
    let pollCount = 0;
    let pollRequestInFlight = false;

    qrPollTimer = setInterval(async () => {
      if (attemptId !== qrLoginAttemptId || pollRequestInFlight) return;
      pollCount++;
      if (pollCount > 60) { stopBiliQrPolling(); qrLoginStatus = "二维码已失效，请重新发起"; isQrLoggingIn = false; return; }

      pollRequestInFlight = true;
      try {
        const pollRes = await fetchWithTimeout(`https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=${genData.data.qrcode_key}`, { headers });
        if (attemptId !== qrLoginAttemptId) return;
        const pollData: any = await pollRes.json();
        const code = pollData.data?.code;

        if (code === 86090) qrLoginStatus = "已扫码，请在手机上点击确认";
        else if (code === 86038) { stopBiliQrPolling(); qrLoginStatus = "二维码已失效，请重新发起"; isQrLoggingIn = false; }
        else if (code === 0) {
          stopBiliQrPolling();
          qrLoginStatus = "扫码成功！正在提取并校验身份凭证...";

          const loginCookies = new Map<string, string>();
          collectBiliCookiesFromResponse(pollRes, loginCookies);
          if (pollData.data?.url) {
            collectBiliCookiesFromUrl(pollData.data.url, loginCookies);
            await collectBiliCookiesFromLoginRedirect(pollData.data.url, headers, loginCookies);
          }
          if (attemptId !== qrLoginAttemptId) return;

          const candidateCookie = serializeBiliLoginCookies(loginCookies);
          const candidateUid = Number(loginCookies.get('DedeUserID')) || 0;
          if (!loginCookies.get('SESSDATA') || !candidateUid || !candidateCookie) {
            qrLoginStatus = "登录凭据提取失败，请重新获取二维码再试";
            isQrLoggingIn = false;
            writeLog(`[Bilibili] 扫码返回成功，但未取得完整登录凭据（已获取 ${loginCookies.size} 个 Cookie）`, 'Yellow');
            return;
          }

          const previousLogin = {
            cookie: biliCookie,
            uid: biliUid,
            userInfo: { ...currentUserInfo }
          };
          biliCookie = candidateCookie;
          biliUid = candidateUid;
          currentUserInfo = createEmptyBiliUserInfo();

          const loginVerified = await updateCurrentUserInfo();
          if (attemptId !== qrLoginAttemptId) return;
          if (!loginVerified) {
            biliCookie = previousLogin.cookie;
            biliUid = previousLogin.uid;
            currentUserInfo = previousLogin.userInfo;
            qrLoginStatus = "账号校验失败，未保存本次登录，请重新扫码";
            isQrLoggingIn = false;
            writeLog('[Bilibili] 扫码凭据未通过账号接口校验，已回滚原登录状态', 'Yellow');
            return;
          }

          qrCodeBase64 = '';
          qrLoginStatus = `登录成功：${currentUserInfo.uname || `UID ${biliUid}`}`;
          isQrLoggingIn = false;
          writeLog(`[Bilibili] 扫码登录成功：${currentUserInfo.uname} (${biliUid})`, 'Green');
          if (appConfig.roomConnectionEnabled === true && appConfig.roomId) {
            void connectToLiveRoom(appConfig.roomId, { enable: false });
          }
        }
      } catch (err: any) {
        writeLog(`[Bilibili] 扫码状态轮询异常: ${err?.message || err}`, 'Yellow');
      } finally {
        pollRequestInFlight = false;
      }
    }, 2000);
  } catch (err: any) {
    stopBiliQrPolling();
    qrLoginStatus = `错误: ${err.message}`;
    isQrLoggingIn = false;
  }
}

const MAX_INTERNAL_REQUEST_BODY_BYTES = 1024 * 1024;

function readBinaryRequest(
  req: http.IncomingMessage,
  maximumBytes: number
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declaredLength = Number(req.headers['content-length']);
    if (
      Number.isFinite(declaredLength)
      && declaredLength > maximumBytes
    ) {
      reject(new Error('上传的 ZIP 超过 20 MiB 限制'));
      req.resume();
      return;
    }

    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    req.on('data', chunk => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buffer.length;
      if (totalBytes > maximumBytes) {
        fail(new Error('上传的 ZIP 超过 20 MiB 限制'));
        return;
      }
      chunks.push(buffer);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks, totalBytes));
    });
    req.on('error', error => fail(error));
  });
}

function readRequestBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const declaredLength = Number(req.headers['content-length']);
    if (
      Number.isFinite(declaredLength)
      && declaredLength > MAX_INTERNAL_REQUEST_BODY_BYTES
    ) {
      reject(new Error('请求体超过 1 MiB 限制'));
      req.resume();
      return;
    }

    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let settled = false;

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    req.on('data', chunk => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buffer.length;
      if (totalBytes > MAX_INTERNAL_REQUEST_BODY_BYTES) {
        fail(new Error('请求体超过 1 MiB 限制'));
        return;
      }
      chunks.push(buffer);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', error => fail(error));
  });
}

async function readJsonRequest(
  req: http.IncomingMessage
): Promise<Record<string, any>> {
  const body = await readRequestBody(req);
  if (!body.trim()) return {};
  const parsed = JSON.parse(body);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('JSON 请求体必须是对象');
  }
  return parsed;
}

function getPublicSysConfig(): Record<string, any> {
  const config = { ...(appConfig.sysConfig || {}) };
  const foliaTokenConfigured = Boolean(String(config.FoliaToken || '').trim());
  delete config.FoliaToken;
  return {
    ...config,
    FoliaTokenConfigured: foliaTokenConfigured
  };
}

function isAllowedInternalOrigin(origin: string | undefined): boolean {
  if (!origin) return true;
  if (origin === 'null') return true;
  try {
    const parsed = new URL(origin);
    return (
      (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost')
      && (parsed.protocol === 'http:' || parsed.protocol === 'https:')
    );
  } catch {
    return false;
  }
}

function isTrustedInternalMutationRequest(
  req: http.IncomingMessage
): boolean {
  if (
    req.headers['x-awoo-internal-token']
    === INTERNAL_API_BROWSER_TOKEN
  ) {
    return true;
  }
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    const internalOrigin =
      `${parsed.protocol}//${parsed.hostname}:${parsed.port || (parsed.protocol === 'https:' ? '443' : '80')}`;
    if (isActualInternalApiOrigin(internalOrigin)) {
      return true;
    }
    const devUrl = getDevUrl();
    return Boolean(devUrl && new URL(devUrl).origin === parsed.origin);
  } catch {
    return false;
  }
}

function attachInternalApiTokenToAppSession(): void {
  session.defaultSession.webRequest.onBeforeSendHeaders(
    {
      urls: [
        'http://localhost/*',
        'http://127.0.0.1/*'
      ]
    },
    (details, callback) => {
      if (isActualInternalApiOrigin(details.url)) {
        details.requestHeaders['X-Awoo-Internal-Token'] =
          INTERNAL_API_BROWSER_TOKEN;
      }
      callback({ requestHeaders: details.requestHeaders });
    }
  );
}

function buildExternalState() {
  return buildExternalApiState({
    appVersion: app.getVersion(),
    player: {
      key: getSelectedPlayerKey(),
      name: getSelectedPlayerLabel(),
      connected: isPlayerConnected,
      connecting: playerConnecting,
      processId: activePlayerSnapshot?.processId ?? null,
      version: activePlayerSnapshot?.version || '',
      status: activePlayerSnapshot?.status || ''
    },
    currentSong: currentPlayingSong || playerCurrentTrack,
    currentIsRequested: Boolean(currentPlayingSong),
    queue: targetQueue,
    acceptingRequests: isAccepting,
    queuePlaybackEnabled: isPlaying,
    pausedAfterRequests: playerPausedAfterRequests,
    commandQueue: {
      pending: danmakuCommandQueue.length,
      processing: processingDanmakuCommand
    }
  });
}

const OBS_OVERLAY_HOST_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>嗷呜点歌机 Mod UI</title>
  <link rel="stylesheet" href="/overlay/host.css">
  <script src="/overlay/host.js" defer></script>
</head>
<body>
  <iframe id="awoo-overlay-frame" title="嗷呜点歌机 Mod UI" sandbox="allow-scripts"></iframe>
  <div id="awoo-overlay-status">正在载入 Mod UI…</div>
</body>
</html>`;

const OBS_OVERLAY_HOST_CSS = `
html,body,#awoo-overlay-frame{width:100%;height:100%;margin:0;background:transparent}
body{overflow:hidden}
#awoo-overlay-frame{display:block;border:0;opacity:0;transition:opacity .16s ease}
#awoo-overlay-frame[data-ready="true"]{opacity:1}
#awoo-overlay-status{position:fixed;left:16px;top:16px;padding:8px 11px;border:1px solid rgba(120,190,255,.35);border-radius:10px;background:rgba(12,24,40,.72);color:#bfe3ff;font:12px/1.4 system-ui,sans-serif}
#awoo-overlay-frame[data-ready="true"]+#awoo-overlay-status{display:none}
`;

const OBS_OVERLAY_HOST_JS = `
(function(){
  var frame=document.getElementById('awoo-overlay-frame');
  var status=document.getElementById('awoo-overlay-status');
  var revision='';
  var settingsRevision='';
  var activeState=null;
  function deliverSettings(){
    if(!activeState||!frame.contentWindow)return;
    frame.contentWindow.postMessage({
      type:'awoo-overlay-settings',
      overlayId:activeState.id||'builtin',
      definitions:Array.isArray(activeState.settings)?activeState.settings:[],
      values:activeState.values&&typeof activeState.values==='object'?activeState.values:{}
    },'*');
  }
  function refresh(){
    fetch('/api/v1/overlay',{cache:'no-store'}).then(function(response){
      if(!response.ok)throw new Error('HTTP '+response.status);
      return response.json();
    }).then(function(state){
      var active=state&&state.active?state.active:{};
      var next=[active.id||'builtin',active.version||'',active.installedAt||''].join('@');
      var nextSettings=JSON.stringify(active.values||{});
      activeState=active;
      if(next!==revision){
        revision=next;
        settingsRevision=nextSettings;
        frame.dataset.ready='false';
        status.textContent='正在载入 '+(active.name||'Mod UI')+'…';
        frame.src='/overlay/content/?revision='+encodeURIComponent(next);
        return;
      }
      if(nextSettings!==settingsRevision){
        settingsRevision=nextSettings;
      }
      // iframe 在刚完成导航或被 Electron 后台节流时可能错过单次消息。
      // 每轮补发当前参数，让预览与 OBS 最迟在下一次轮询恢复一致。
      deliverSettings();
    }).catch(function(error){
      status.textContent='Mod UI 无法载入：'+error.message;
    });
  }
  frame.addEventListener('load',function(){
    frame.dataset.ready='true';
    deliverSettings();
  });
  window.addEventListener('message',function(event){
    if(event.source===frame.contentWindow&&event.data&&event.data.type==='awoo-overlay-ready'){
      deliverSettings();
    }
  });
  refresh();
  window.setInterval(refresh,500);
}());
`;

const OBS_OVERLAY_RUNTIME_JS = `
(function(){
  'use strict';
  var current={overlayId:'',definitions:[],values:{}};
  var applied=[];
  var subscribers=[];
  function attributeName(key){
    return 'data-awoo-setting-'+String(key||'').replace(/([a-z0-9])([A-Z])/g,'$1-$2').replace(/[^A-Za-z0-9_-]/g,'-').toLowerCase();
  }
  function cssValue(definition,value){
    if(typeof value==='boolean')return value?'1':'0';
    return String(value)+(definition.cssUnit||'');
  }
  function apply(payload){
    var root=document.documentElement;
    applied.forEach(function(definition){
      if(definition.cssVariable)root.style.removeProperty(definition.cssVariable);
      root.removeAttribute(attributeName(definition.key));
    });
    var definitions=Array.isArray(payload.definitions)?payload.definitions:[];
    var values=payload.values&&typeof payload.values==='object'?payload.values:{};
    definitions.forEach(function(definition){
      if(!definition||typeof definition.key!=='string')return;
      var value=Object.prototype.hasOwnProperty.call(values,definition.key)?values[definition.key]:definition.default;
      if(typeof definition.cssVariable==='string'&&/^--[a-z][a-z0-9-]*$/.test(definition.cssVariable)){
        root.style.setProperty(definition.cssVariable,cssValue(definition,value));
      }
      root.setAttribute(attributeName(definition.key),String(value));
    });
    applied=definitions;
    current={overlayId:String(payload.overlayId||''),definitions:definitions,values:Object.assign({},values)};
    var detail={overlayId:current.overlayId,definitions:current.definitions,values:Object.assign({},current.values)};
    window.dispatchEvent(new CustomEvent('awoo-overlay-settings',{detail:detail}));
    subscribers.slice().forEach(function(callback){try{callback(detail);}catch(_error){}});
  }
  window.AwooOverlay={
    getSettings:function(){return Object.assign({},current.values);},
    subscribe:function(callback){
      if(typeof callback!=='function')return function(){};
      subscribers.push(callback);
      if(current.overlayId)callback({overlayId:current.overlayId,definitions:current.definitions,values:Object.assign({},current.values)});
      return function(){subscribers=subscribers.filter(function(item){return item!==callback;});};
    }
  };
  window.addEventListener('message',function(event){
    if(event.source!==window.parent||!event.data||event.data.type!=='awoo-overlay-settings')return;
    apply(event.data);
  });
  window.parent.postMessage({type:'awoo-overlay-ready'},'*');
}());
`;

function injectObsOverlayRuntime(content: Buffer): Buffer {
  const html = content.toString('utf8');
  if (html.includes('data-awoo-overlay-runtime')) return content;
  const runtimeTag = '<script src="/overlay/runtime.js" defer data-awoo-overlay-runtime></script>';
  const injected = /<head(?:\s[^>]*)?>/i.test(html)
    ? html.replace(/<head(?:\s[^>]*)?>/i, match => `${match}\n  ${runtimeTag}`)
    : `${runtimeTag}\n${html}`;
  return Buffer.from(injected, 'utf8');
}

async function serveObsOverlay(
  pathname: string,
  res: http.ServerResponse
): Promise<boolean> {
  try {
    if (pathname === '/overlay/' || pathname === '/overlay/index.html') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader(
        'Content-Security-Policy',
        "default-src 'self'; frame-src 'self'; style-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'"
      );
      res.end(OBS_OVERLAY_HOST_HTML);
      return true;
    }
    if (pathname === '/overlay/host.css') {
      res.setHeader('Content-Type', 'text/css; charset=utf-8');
      res.end(OBS_OVERLAY_HOST_CSS);
      return true;
    }
    if (pathname === '/overlay/host.js') {
      res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
      res.end(OBS_OVERLAY_HOST_JS);
      return true;
    }
    if (pathname === '/overlay/runtime.js') {
      res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
      res.end(OBS_OVERLAY_RUNTIME_JS);
      return true;
    }
    if (!pathname.startsWith('/overlay/content/')) return false;
    const relativePath = decodeURIComponent(
      pathname.slice('/overlay/content/'.length)
    );
    const asset = await getOverlayModManager().resolveActiveAsset(relativePath);
    if (!asset) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Mod UI asset not found');
      return true;
    }
    const rawContent = await fs.promises.readFile(asset.filePath);
    const content = asset.contentType.startsWith('text/html')
      ? injectObsOverlayRuntime(rawContent)
      : rawContent;
    res.setHeader('Content-Type', asset.contentType);
    res.setHeader('X-Awoo-Overlay-Revision', asset.revision);
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; connect-src http://127.0.0.1:* ws://127.0.0.1:* http://localhost:* ws://localhost:*; img-src http: https: data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; font-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'self' file: http://127.0.0.1:* http://localhost:*"
    );
    res.end(content);
  } catch (error: unknown) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(
      `OBS overlay unavailable: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  return true;
}

async function buildFeedbackContext(
  includeLogs = false
): Promise<Record<string, any>> {
  let connectorStatuses: Awaited<
    ReturnType<typeof playerManager.getConnectorStatuses>
  > = [];
  let connectorCheckError = '';
  try {
    connectorStatuses = await playerManager.getConnectorStatuses(false);
  } catch (error: unknown) {
    connectorCheckError = error instanceof Error
      ? error.message
      : String(error);
  }

  const selectedPlayer = getSelectedPlayerKey();
  const selectedConnector = connectorStatuses.find(
    connector => connector.id === selectedPlayer
  );
  const diagnostics: Record<string, unknown> = {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    runtime: {
      electron: process.versions.electron || '',
      chrome: process.versions.chrome || '',
      node: process.versions.node || ''
    },
    player: {
      key: selectedPlayer,
      label: getSelectedPlayerLabel(),
      connected: isPlayerConnected,
      connecting: playerConnecting,
      processId: activePlayerSnapshot?.processId ?? null,
      version: activePlayerSnapshot?.version || '',
      status: activePlayerSnapshot?.status || '',
      capabilities: activePlayerSnapshot?.capabilities || null,
      controlNotice: playerControlNotice,
      compatibilityNotice: playerControlNotice?.kind === 'upgrade'
        ? playerControlNotice
        : null
    },
    connectors: connectorStatuses.map(status => ({
      id: status.id,
      installed: status.installed,
      currentVersion: status.currentVersion,
      latestVersion: status.latestVersion,
      minimumCoreVersion: status.minimumCoreVersion,
      compatible: status.compatible,
      updateAvailable: status.updateAvailable,
      updating: status.updating,
      error: status.error
    })),
    connectorCheckError,
    queues: {
      requestedSongs: targetQueue.length,
      danmakuCommandsPending: danmakuCommandQueue.length,
      danmakuCommandProcessing: processingDanmakuCommand
    },
    service: {
      accepting: isAccepting,
      playbackEnabled: isPlaying,
      guestMode: !isBiliLoginReady(),
      externalHttpEnabled:
        appConfig.sysConfig?.ExternalHttpEnabled === true,
      externalWebSocketEnabled:
        appConfig.sysConfig?.ExternalWebSocketEnabled === true,
      externalApiRunning
    }
  };
  if (includeLogs) {
    diagnostics.recentLogs = sysLogs.slice(-80).map(log => ({
      time: log.Time,
      color: log.Color,
      message: sanitizeFeedbackLog(log.Message)
    }));
  }

  return {
    appVersion: app.getVersion(),
    coreVersion: app.getVersion(),
    platform: process.platform,
    architecture: process.arch,
    osVersion: `${os.type()} ${os.release()}`,
    selectedPlayer,
    playerVersion: activePlayerSnapshot?.version || '',
    connectorId: selectedPlayer,
    connectorVersion: selectedConnector?.currentVersion || '',
    latestConnectorVersion: selectedConnector?.latestVersion || '',
    connectionStatus: activePlayerSnapshot?.status
      || connectorMaintenanceStatus
      || currentStatusMessage,
    diagnostics
  };
}

let externalApiServer: http.Server | null = null;
let externalWebSocketServer: WebSocketServer | null = null;
let externalBroadcastTimer: NodeJS.Timeout | null = null;
let externalApiRunning = false;
let lastExternalStateFingerprint = '';

function getExternalApiPort(): number {
  const value = Number(appConfig.sysConfig?.ExternalApiPort);
  const configured = (
    Number.isInteger(value)
    && value >= 1024
    && value <= 65535
  ) ? value : DEFAULT_EXTERNAL_API_PORT;
  if (actualInternalApiPort === null || configured !== actualInternalApiPort) {
    return configured;
  }
  for (let offset = 1; offset <= MAX_LOCAL_API_PORT - MIN_LOCAL_API_PORT; offset += 1) {
    const candidate = MIN_LOCAL_API_PORT
      + ((configured - MIN_LOCAL_API_PORT + offset) % (MAX_LOCAL_API_PORT - MIN_LOCAL_API_PORT + 1));
    if (candidate !== actualInternalApiPort) return candidate;
  }
  return DEFAULT_EXTERNAL_API_PORT;
}

function stopExternalApiServer(): Promise<void> {
  if (externalBroadcastTimer) {
    clearInterval(externalBroadcastTimer);
    externalBroadcastTimer = null;
  }
  lastExternalStateFingerprint = '';
  externalApiRunning = false;
  externalWebSocketServer?.clients.forEach(client => client.close(1001, 'server restart'));
  externalWebSocketServer?.close();
  externalWebSocketServer = null;

  const server = externalApiServer;
  externalApiServer = null;
  if (!server) return Promise.resolve();
  return new Promise(resolve => server.close(() => resolve()));
}

async function restartExternalApiServer(): Promise<void> {
  await stopExternalApiServer();
  const httpEnabled = appConfig.sysConfig?.ExternalHttpEnabled === true;
  const webSocketEnabled = appConfig.sysConfig?.ExternalWebSocketEnabled === true;
  if (!httpEnabled && !webSocketEnabled) {
    writeLog('[外部接口] HTTP 与 WebSocket 均已关闭', 'DarkGray');
    return;
  }

  const port = getExternalApiPort();
  const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    if (!httpEnabled || req.method !== 'GET') {
      res.writeHead(404);
      res.end();
      return;
    }

    const url = new URL(req.url || '/', `http://${req.headers.host || `127.0.0.1:${port}`}`);
    if (url.pathname === '/overlay') {
      res.writeHead(302, { Location: `/overlay/${url.search}` });
      res.end();
      return;
    }
    if (await serveObsOverlay(url.pathname, res)) return;

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    if (url.pathname === '/health') {
      res.end(JSON.stringify({ ok: true, schemaVersion: 1, version: app.getVersion() }));
      return;
    }

    if (url.pathname === '/api/v1/overlay') {
      res.end(JSON.stringify(await getOverlayModManager().getPublicState()));
      return;
    }

    const state = buildExternalState();
    if (url.pathname === '/api/v1/state') {
      res.end(JSON.stringify(state));
      return;
    }
    if (url.pathname === '/api/v1/current') {
      res.end(JSON.stringify({
        schemaVersion: state.schemaVersion,
        appVersion: state.appVersion,
        timestamp: state.timestamp,
        player: state.player,
        current: state.current,
        currentIsRequested: state.currentIsRequested,
        service: state.service
      }));
      return;
    }
    if (url.pathname === '/api/v1/queue') {
      res.end(JSON.stringify({
        schemaVersion: state.schemaVersion,
        appVersion: state.appVersion,
        timestamp: state.timestamp,
        queue: state.queue,
        queueLength: state.queueLength,
        service: state.service
      }));
      return;
    }
    res.writeHead(404);
    res.end(JSON.stringify({ error: 'not_found' }));
  });

  const webSocketServer = new WebSocketServer({ noServer: true });
  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url || '/', `http://${request.headers.host || `127.0.0.1:${port}`}`);
    if (!webSocketEnabled || url.pathname !== '/ws') {
      socket.destroy();
      return;
    }
    webSocketServer.handleUpgrade(request, socket, head, client => {
      webSocketServer.emit('connection', client, request);
    });
  });
  webSocketServer.on('connection', client => {
    client.send(JSON.stringify({ type: 'state', data: buildExternalState() }));
  });

  externalApiServer = server;
  externalWebSocketServer = webSocketServer;
  server.on('error', (error: any) => {
    externalApiRunning = false;
    writeLog(`[外部接口] 启动失败: ${error?.message || error}`, 'Red');
  });
  server.listen(port, '127.0.0.1', () => {
    externalApiRunning = true;
    writeLog(
      `✅ 外部只读接口已启动: ${httpEnabled ? `HTTP http://127.0.0.1:${port}/api/v1/state` : ''}`
      + `${httpEnabled && webSocketEnabled ? ' | ' : ''}`
      + `${webSocketEnabled ? `WebSocket ws://127.0.0.1:${port}/ws` : ''}`,
      'Green'
    );
  });

  externalBroadcastTimer = setInterval(() => {
    if (!webSocketEnabled || webSocketServer.clients.size === 0) return;
    const state = buildExternalState();
    const fingerprint = JSON.stringify({ ...state, timestamp: undefined });
    if (fingerprint === lastExternalStateFingerprint) return;
    lastExternalStateFingerprint = fingerprint;
    const payload = JSON.stringify({ type: 'state', data: state });
    webSocketServer.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) client.send(payload);
    });
  }, 250);
}

// ==========================================
// 后端 API 与 静态网页托管服务
// ==========================================
async function startBackendServer(): Promise<void> {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', `http://${req.headers.host}`);
      const origin = req.headers.origin;
      const isSkinMarketplaceRoute =
        url.pathname === '/api/skin-marketplace/status'
        || url.pathname === '/api/skin-marketplace/install';
      const isTrustedSkinMarketplaceRequest = Boolean(
        isSkinMarketplaceRoute
        && isLoopbackRemoteAddress(req.socket.remoteAddress)
        && isAllowedSkinMarketplaceOrigin(origin)
      );
      if (!isAllowedInternalOrigin(origin) && !isTrustedSkinMarketplaceRequest) {
        res.writeHead(403);
        res.end('Forbidden origin');
        return;
      }
      if (origin) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
      }
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      res.setHeader(
        'Access-Control-Allow-Headers',
        'Content-Type, X-Awoo-File-Name, X-Awoo-Internal-Token'
      );
      if (
        isTrustedSkinMarketplaceRequest
        && req.headers['access-control-request-private-network'] === 'true'
      ) {
        res.setHeader('Access-Control-Allow-Private-Network', 'true');
      }
      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

      if (
        req.method !== 'GET'
        && req.method !== 'HEAD'
        && !isTrustedSkinMarketplaceRequest
        && !isTrustedInternalMutationRequest(req)
      ) {
        res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
          success: false,
          message: 'Mod UI 只能读取状态，不能调用点歌机控制接口'
        }));
        return;
      }

    if (url.pathname === '/api/skin-marketplace/status' && req.method === 'GET') {
      if (origin && !isTrustedSkinMarketplaceRequest) {
        res.writeHead(403);
        res.end(JSON.stringify({ success: false, message: '皮肤站来源不受信任' }));
        return;
      }
      const state = await getOverlayModManager().getPublicState();
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({
        success: true,
        appVersion: app.getVersion(),
        active: {
          id: state.active.id,
          name: state.active.name,
          version: state.active.version
        }
      }));
      return;
    }

    if (url.pathname === '/api/skin-marketplace/install' && req.method === 'POST') {
      if (!isTrustedSkinMarketplaceRequest) {
        res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: false, message: '只接受官方皮肤站的一键安装请求' }));
        return;
      }
      if (skinMarketplaceInstallInProgress) {
        res.writeHead(409, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: false, message: '另一个皮肤正在安装，请稍候' }));
        return;
      }
      skinMarketplaceInstallInProgress = true;
      try {
        const contentType = String(req.headers['content-type'] || '')
          .split(';', 1)[0]
          .trim()
          .toLowerCase();
        let state;
        if (
          contentType === 'application/zip'
          || contentType === 'application/octet-stream'
        ) {
          const archive = await readBinaryRequest(
            req,
            MAX_OVERLAY_ARCHIVE_BYTES
          );
          await getOverlayModManager().installArchive(
            archive,
            `skin-marketplace:${origin}`
          );
          state = await getOverlayModManager().getPublicState();
        } else {
          const body = await readJsonRequest(req);
          const downloadUrl = validateSkinMarketplaceDownloadUrl(
            body.downloadUrl,
            origin
          );
          state = await getOverlayModManager().installArchiveFromUrl(downloadUrl);
        }
        writeLog(`✅ [皮肤站] 已一键安装并启用 ${state.active.name} ${state.active.version}`, 'Green');
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({
          success: true,
          active: {
            id: state.active.id,
            name: state.active.name,
            version: state.active.version
          }
        }));
      } finally {
        skinMarketplaceInstallInProgress = false;
      }
      return;
    }

    if (url.pathname === '/data') {
      const showPlayerCurrentTrack = appConfig.sysConfig?.ShowPlayerCurrentTrack !== false;
      const displayCurrent = currentPlayingSong || (showPlayerCurrentTrack ? playerCurrentTrack : null);
      const requestedSongArtwork = appConfig.sysConfig?.RequestedSongArtwork === 'song_cover' ? 'song_cover' : 'bili_avatar';
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ current: displayCurrent, currentIsRequested: !!currentPlayingSong, playerPausedAfterRequests, requestedSongArtwork, queue: targetQueue, status: connectorMaintenanceStatus || currentStatusMessage, accepting: isAccepting, playing: isPlaying, uiConfig: appConfig.widgetStyle, rejects: recentRejects, cdpConnected: isPlayerConnected, playerConnected: isPlayerConnected, playerConnecting, roomConnection: getBiliRoomConnectionInfo(), commandQueue: { pending: danmakuCommandQueue.length, processing: processingDanmakuCommand } }));
      return;
    }

    if (url.pathname === '/api/overlays' && req.method === 'GET') {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({
        success: true,
        ...(await getOverlayModManager().getPublicState())
      }));
      return;
    }

    if (url.pathname === '/api/overlays/install-url' && req.method === 'POST') {
      const body = await readJsonRequest(req);
      const state = await getOverlayModManager().installFromUrl(
        String(body.url || '')
      );
      writeLog(`✅ [Mod UI] 已从网址安装并启用 ${state.active.name} ${state.active.version}`, 'Green');
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ success: true, ...state }));
      return;
    }

    if (url.pathname === '/api/overlays/install-zip' && req.method === 'POST') {
      const archive = await readBinaryRequest(req, MAX_OVERLAY_ARCHIVE_BYTES);
      const encodedName = String(req.headers['x-awoo-file-name'] || 'local-zip');
      let sourceName = encodedName;
      try {
        sourceName = decodeURIComponent(encodedName);
      } catch { /* 保留原始安全文本 */ }
      const installed = await getOverlayModManager().installArchive(
        archive,
        `local:${path.basename(sourceName).slice(0, 120)}`
      );
      const state = await getOverlayModManager().getPublicState();
      writeLog(`✅ [Mod UI] 已从 ZIP 安装并启用 ${installed.name} ${installed.version}`, 'Green');
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ success: true, ...state }));
      return;
    }

    if (url.pathname === '/api/overlays/activate' && req.method === 'POST') {
      const body = await readJsonRequest(req);
      const state = await getOverlayModManager().activate(String(body.id || ''));
      writeLog(`🎨 [Mod UI] 已切换到 ${state.active.name} ${state.active.version}`, 'Cyan');
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ success: true, ...state }));
      return;
    }

    if (url.pathname === '/api/overlays/settings' && req.method === 'POST') {
      const body = await readJsonRequest(req);
      const state = await getOverlayModManager().updateSettings(
        String(body.id || ''),
        body.values,
        body.reset === true
      );
      writeLog(`🎛️ [Mod UI] 已保存 ${state.activeId === String(body.id || '') ? state.active.name : String(body.id || '')} 的独立参数`, 'Cyan');
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ success: true, ...state }));
      return;
    }

    if (url.pathname === '/api/overlays/remove' && req.method === 'POST') {
      const body = await readJsonRequest(req);
      const state = await getOverlayModManager().remove(String(body.id || ''));
      writeLog(`🗑️ [Mod UI] 已删除 ${String(body.id || '')}`, 'DarkGray');
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ success: true, ...state }));
      return;
    }

    if (url.pathname === '/api/test/request-song') {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      if (!isLoopbackRemoteAddress(req.socket.remoteAddress)) {
        res.writeHead(403);
        res.end(JSON.stringify({
          success: false,
          message: '本地测试点歌接口仅允许回环地址访问'
        }));
        return;
      }
      if (req.method === 'GET') {
        res.end(JSON.stringify({
          success: true,
          localOnly: true,
          serialized: true,
          bypassesDanmakuChecks: true,
          endpoint: `${getInternalApiOrigin()}/api/test/request-song`,
          method: 'POST',
          body: {
            keyword: 'Shelter Porter Robinson Madeon',
            mode: 'normal'
          },
          modes: ['normal', 'top', 'interrupt', 'play_now'],
          aliases: {
            queue: 'normal',
            priority: 'top',
            insert: 'interrupt',
            immediate: 'play_now'
          }
        }));
        return;
      }
      if (req.method !== 'POST') {
        res.writeHead(405);
        res.end(JSON.stringify({
          success: false,
          message: '仅支持 GET 说明或 POST 点歌'
        }));
        return;
      }

      const body = await readJsonRequest(req);
      const keyword = normalizeLocalSongKeyword(body.keyword);
      const mode = normalizeLocalSongRequestMode(body.mode);
      if (!keyword || !mode) {
        res.writeHead(400);
        res.end(JSON.stringify({
          success: false,
          message: !keyword
            ? 'keyword 必须是 1 到 200 个字符的字符串'
            : 'mode 必须是 normal、top、interrupt 或 play_now'
        }));
        return;
      }

      const requestId = ++localTestRequestSequence;
      const startedAt = Date.now();
      const requestedBy = String(body.requestedBy || '本地测试 API')
        .trim()
        .slice(0, 40) || '本地测试 API';
      writeLog(
        `[本地测试 API] #${requestId} ${mode}: ${keyword}`,
        'Cyan'
      );
      const result = await serializeLocalTestRequest(
        () => tryRequestSong({
          uid: 'local-test-api',
          name: requestedBy,
          avatar: 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 64 64%22%3E%3Crect width=%2264%22 height=%2264%22 rx=%2216%22 fill=%22%236366f1%22/%3E%3Ctext x=%2232%22 y=%2241%22 text-anchor=%22middle%22 font-size=%2228%22 fill=%22white%22%3ET%3C/text%3E%3C/svg%3E',
          guardLevel: 0
        }, keyword, mode)
      );
      if (!result.success) {
        res.writeHead(422);
      }
      res.end(JSON.stringify({
        ...result,
        requestId,
        elapsedMs: Date.now() - startedAt,
        player: {
          key: getSelectedPlayerKey(),
          connected: isPlayerConnected
        },
        current: currentPlayingSong || playerCurrentTrack,
        queue: targetQueue
      }));
      return;
    }

    if (url.pathname === '/api/gifts/learning') {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      if (req.method === 'GET') {
        res.end(JSON.stringify({
          success: true,
          ...getGiftLearningState()
        }));
        return;
      }
      if (req.method === 'POST') {
        const body = await readJsonRequest(req);
        if (body.action === 'start') startGiftLearning();
        else if (body.action === 'stop') stopGiftLearning();
        else if (body.action === 'clear-cache') clearLearnedGiftLibrary();
        else {
          res.writeHead(400);
          res.end(JSON.stringify({
            success: false,
            message: '不支持的礼物学习操作'
          }));
          return;
        }
        res.end(JSON.stringify({
          success: true,
          ...getGiftLearningState()
        }));
        return;
      }
      res.writeHead(405);
      res.end(JSON.stringify({ success: false, message: '请求方法不受支持' }));
      return;
    }

    if (url.pathname === '/api/config') {
      if (req.method === 'POST') {
        const body = await readJsonRequest(req);
        const previousPlayerType = appConfig.sysConfig?.PlayerType;
        const previousInternalApiPort = configuredInternalApiPort;
        const previousExternalSettings = JSON.stringify({
          http: appConfig.sysConfig?.ExternalHttpEnabled === true,
          ws: appConfig.sysConfig?.ExternalWebSocketEnabled === true,
          port: getExternalApiPort()
        });
        if (body.roomId !== undefined) appConfig.roomId = body.roomId;
        if (body.roomConnectionEnabled === false) {
          disconnectFromLiveRoom();
        } else if (body.roomConnectionEnabled === true) {
          appConfig.roomConnectionEnabled = true;
        }
        if (body.widgetStyle !== undefined) {
          const incomingWidgetStyle = body.widgetStyle && typeof body.widgetStyle === 'object' && !Array.isArray(body.widgetStyle)
            ? body.widgetStyle
            : {};
          const existingWidgetStyle = appConfig.widgetStyle && typeof appConfig.widgetStyle === 'object' && !Array.isArray(appConfig.widgetStyle)
            ? appConfig.widgetStyle
            : {};
          appConfig.widgetStyle = {
            ...existingWidgetStyle,
            ...incomingWidgetStyle,
            // The pin button is the source of truth for the native window;
            // renderer theme/size saves must not reset it accidentally.
            alwaysOnTop: getOverlayAlwaysOnTop()
          };
        }
        if (body.sysConfig !== undefined) {
          const incomingConfig = { ...body.sysConfig };
          delete incomingConfig.FoliaTokenConfigured;
          appConfig.sysConfig = {
            ...appConfig.sysConfig,
            ...incomingConfig
          };
        }
        if (!['NCM', 'Kugou', 'QQMusic', 'Folia'].includes(appConfig.sysConfig?.PlayerType)) appConfig.sysConfig.PlayerType = 'NCM';
        if (appConfig.sysConfig.FoliaToken === undefined) appConfig.sysConfig.FoliaToken = '';
        appConfig.sysConfig.GiftRequestRequirements =
          normalizeGiftRequestRequirements(
            appConfig.sysConfig.GiftRequestRequirements
          );
        appConfig.sysConfig.InternalApiPort = normalizeLocalApiPort(
          appConfig.sysConfig.InternalApiPort,
          ENV_INTERNAL_API_PORT
        );
        configuredInternalApiPort = appConfig.sysConfig.InternalApiPort;
        appConfig.sysConfig.ExternalApiPort = getExternalApiPort();
        delete appConfig.sysConfig.EnableCDP;
        delete appConfig.sysConfig.CdpPort;
        delete appConfig.sysConfig.NcmExePath;
        saveConfig();
        if (configuredInternalApiPort !== previousInternalApiPort) {
          writeLog(
            `[内部 API] 已保存请求端口 ${configuredInternalApiPort}，重启点歌机后生效（当前启动请求 ${requestedInternalApiPort}，实际使用 ${actualInternalApiPort || '未启动'}）`,
            'Yellow'
          );
        }

        if (previousPlayerType !== appConfig.sysConfig.PlayerType) {
          clearDeferredQqInsert();
          targetQueue = [];
          currentPlayingSong = null;
          playerPausedAfterRequests = false;
          isPlayerConnected = false;
          playerConnecting = true;
          activePlayerSnapshot = null;
          playerControlNotice = null;
          playerManager.resetObservedTrack();
          updatePlayerCurrentTrack('', '');
          writeLog(`>>> [系统] 已切换到 ${getSelectedPlayerLabel()}，旧播放器的待播队列已清空`, 'Cyan');
          await startPlayerRadar();
        }

        const nextExternalSettings = JSON.stringify({
          http: appConfig.sysConfig?.ExternalHttpEnabled === true,
          ws: appConfig.sysConfig?.ExternalWebSocketEnabled === true,
          port: getExternalApiPort()
        });
        if (previousExternalSettings !== nextExternalSettings) {
          await restartExternalApiServer();
        }
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({
          success: true,
          playerConnected: isPlayerConnected,
          playerConnecting,
          internalApi: getInternalApiInfo()
        }));
        return;
      }
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({
        roomId: appConfig.roomId,
        requestedRoomId: biliRoomState.requestedRoomId,
        realRoomId: biliRoomState.realRoomId,
        roomConnectionStatus: biliRoomState.status,
        roomConnectionMessage: biliRoomState.message,
        roomConnectionEnabled: appConfig.roomConnectionEnabled === true,
        roomConnection: getBiliRoomConnectionInfo(),
        myRoomId: appConfig.myRoomId || 0,
        biliLogin: isBiliLoginReady(),
        guestMode: !isBiliLoginReady(),
        uid: biliUid,
        currentUser: currentUserInfo,
        version: app.getVersion(),
        accepting: isAccepting,
        playing: isPlaying,
        widgetStyle: appConfig.widgetStyle,
        cdpConnected: isPlayerConnected,
        playerConnected: isPlayerConnected,
        playerConnecting,
        playerSnapshot: activePlayerSnapshot,
        playerControlNotice,
        connectorMaintenanceStatus,
        giftLearning: getGiftLearningState(),
        commandQueue: { pending: danmakuCommandQueue.length, processing: processingDanmakuCommand },
        current: currentPlayingSong || playerCurrentTrack,
        currentIsRequested: Boolean(currentPlayingSong),
        playerPausedAfterRequests,
        internalApi: getInternalApiInfo(),
        externalApi: {
          running: externalApiRunning,
          httpEnabled: appConfig.sysConfig?.ExternalHttpEnabled === true,
          webSocketEnabled: appConfig.sysConfig?.ExternalWebSocketEnabled === true,
          port: getExternalApiPort()
        },
        config: getPublicSysConfig()
      }));
      return;
    }

    if (url.pathname === '/api/queue/action' && req.method === 'POST') {
      // 队列操作防抖锁定（后端防护）
      const now = Date.now();
      if (now - lastQueueActionTime < 500) {
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ success: false, message: '操作冷却中，请勿频繁点击' }));
        return;
      }
      lastQueueActionTime = now;

      const doc = await readJsonRequest(req);
      const { action, index } = doc;

      if (action === 'delete' && index >= 0 && index < targetQueue.length) {
        const previousHead = targetQueue[0] || null;
        targetQueue.splice(index, 1);
        if (index === 0) {
          await reconcileQueueHeadAfterMutation(previousHead, '删除队首');
        }
        setGlobalStatus('🗑️ 已移除曲目');
      }
      else if (action === 'top' && index >= 0 && index < targetQueue.length) {
        const previousHead = targetQueue[0] || null;
        const item = targetQueue.splice(index, 1)[0];
        if (item) {
          targetQueue.unshift(item);
          await reconcileQueueHeadAfterMutation(previousHead, '置顶队列');
          setGlobalStatus(`⬆️ 置顶: ${item.SongName}`);
        }
      } else if (action === 'play_now' && index >= 0 && index < targetQueue.length) {
        const item = targetQueue[index];
        if (item) {
          const played = await playSongNow(item);
          if (played && targetQueue[index] === item) {
            targetQueue.splice(index, 1);
          }
          setGlobalStatus(
            played
              ? `▶️ 强制播放: ${item.SongName}`
              : `⚠️ 强制播放未确认，已保留在队列: ${item.SongName}`
          );
        }
      } else if (action === 'skip_current') {
        await requestPlayerNext();
        setGlobalStatus('⏭️ 已切歌');
      } else if (action === 'reorder' && doc.from >= 0 && doc.from < targetQueue.length && doc.to >= 0 && doc.to < targetQueue.length) {
        const previousHead = targetQueue[0] || null;
        const item = targetQueue.splice(doc.from, 1)[0];
        if (item) {
          targetQueue.splice(doc.to, 0, item);
          await reconcileQueueHeadAfterMutation(previousHead, '重排队列');
          setGlobalStatus('🔄 列表已重排');
        }
      } else if (action === 'push_current_to_queue') {
        if (currentPlayingSong) {
          targetQueue.push(currentPlayingSong); skipForcePlayOnce = true; setGlobalStatus('🔙 已退回点歌列表末端');
          await requestPlayerNext();
        }
      }
      res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify({ success: true }));
      return;
    }

    if (url.pathname === '/api/room' && req.method === 'POST') {
      const doc = await readJsonRequest(req);
      const requestedRoomId = Number(doc.roomId);
      if (Number.isSafeInteger(requestedRoomId) && requestedRoomId > 0) {
        appConfig.roomConnectionEnabled = true;
        // The request is accepted as soon as the new session is created. The
        // UI polls /api/config and only shows connected after WebSocket op=8
        // returns code=0; HTTP token acquisition alone is never success.
        void connectToLiveRoom(requestedRoomId, { enable: true });
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({
          success: true,
          ...getBiliRoomConnectionInfo(),
          roomConnection: getBiliRoomConnectionInfo()
        }));
        return;
      }
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({
        success: false,
        ...getBiliRoomConnectionInfo(),
        roomConnection: getBiliRoomConnectionInfo(),
        message: '请输入正确的房间号'
      }));
      return;
    }

    if (
      (url.pathname === '/api/room/disconnect' && req.method === 'POST')
      || (url.pathname === '/api/room' && req.method === 'DELETE')
    ) {
      disconnectFromLiveRoom();
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({
        success: true,
        ...getBiliRoomConnectionInfo(),
        roomConnection: getBiliRoomConnectionInfo()
      }));
      return;
    }

    if (url.pathname === '/api/state/toggle' && req.method === 'POST') { isAccepting = !isAccepting; res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify({ success: true })); return; }
    if (url.pathname === '/api/state/toggle_play' && req.method === 'POST') {
      isPlaying = !isPlaying;
      if (isPlaying && targetQueue[0]) {
        await guardNextSong(targetQueue[0]);
      }
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ success: true, playing: isPlaying }));
      return;
    }

    if (url.pathname === '/api/debug/play_next' && req.method === 'POST') {
      playerPausedAfterRequests = false;
      const result = await executePlayerCommand('Next');
      const success = isSuccessfulPlayerResult(result);
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({
        success,
        outcome: result?.outcome || 'rejected',
        message: result?.message || '播放器未返回结果'
      }));
      return;
    }

    if ((url.pathname === '/api/sys/reconnect_player' || url.pathname === '/api/sys/restart_ncm') && req.method === 'POST') {
      const success = await reconnectPlayerBridge();
      res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify({ success })); return;
    }

    if (url.pathname === '/api/connectors/status' && req.method === 'GET') {
      try {
        const forceRefresh = url.searchParams.get('refresh') === '1';
        const connectors = await playerManager.getConnectorStatuses(forceRefresh);
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({
          success: true,
          connectors,
          checkedAt: new Date().toISOString()
        }));
      } catch (error: unknown) {
        const message = error instanceof Error
          ? error.message
          : String(error);
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({
          success: false,
          connectors: [],
          message
        }));
      }
      return;
    }

    if (
      url.pathname === '/api/feedback/diagnostics'
      && req.method === 'GET'
    ) {
      try {
        const context = await buildFeedbackContext(
          url.searchParams.get('logs') === '1'
        );
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ success: true, ...context }));
      } catch (error: unknown) {
        const message = error instanceof Error
          ? error.message
          : String(error);
        res.writeHead(500, {
          'Content-Type': 'application/json; charset=utf-8'
        });
        res.end(JSON.stringify({ success: false, message }));
      }
      return;
    }

    if (
      url.pathname === '/api/feedback/status'
      && req.method === 'GET'
    ) {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      const publicId = String(url.searchParams.get('id') || '')
        .trim()
        .toUpperCase();
      if (!/^[A-Z0-9][A-Z0-9-]{7,39}$/.test(publicId)) {
        res.writeHead(400);
        res.end(JSON.stringify({
          success: false,
          message: '问题编号格式无效'
        }));
        return;
      }
      try {
        const feedback = await getFeedbackStatus(publicId);
        res.end(JSON.stringify({ success: true, feedback }));
      } catch (error: unknown) {
        const message = error instanceof Error
          ? error.message
          : String(error);
        res.writeHead(502);
        res.end(JSON.stringify({ success: false, message }));
      }
      return;
    }

    if (
      url.pathname === '/api/feedback/submit'
      && req.method === 'POST'
    ) {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      try {
        const body = await readJsonRequest(req);
        const category = String(body.category || 'bug');
        const includeDiagnostics = body.includeDiagnostics !== false;
        const includeLogs = includeDiagnostics && body.includeLogs === true;
        const technicalFeedback = isTechnicalFeedbackCategory(category);
        const context = await buildFeedbackContext(includeLogs);
        const recentLogs = Array.isArray(context.diagnostics?.recentLogs)
          ? context.diagnostics.recentLogs
          : [];
        const evidenceCheck = checkFeedbackSubmissionEvidence({
          category,
          updatesRetried: body.updatesRetried === true,
          reproductionConfirmed: body.reproductionConfirmed === true,
          includeDiagnostics,
          includeLogs,
          diagnosticsLoaded: Boolean(context.diagnostics),
          logsCapturedAfterReproduction:
            body.reproductionConfirmed === true && recentLogs.length > 0
        });
        if (!evidenceCheck.allowed) {
          res.writeHead(400);
          res.end(JSON.stringify({
            success: false,
            message: evidenceCheck.message || '请先完成提交前检查'
          }));
          return;
        }
        if (technicalFeedback) {
          context.diagnostics.feedbackPreparation = {
            updatesRetried: true,
            reproducedInCurrentSession: true,
            attachedRecentLogCount: recentLogs.length
          };
        }
        const result = await submitFeedback({
          category,
          priority: String(body.priority || 'normal'),
          title: String(body.title || '').slice(0, 120),
          description: String(body.description || '').slice(0, 8000),
          contact: String(body.contact || '').slice(0, 200),
          appVersion: context.appVersion,
          coreVersion: context.coreVersion,
          platform: context.platform,
          architecture: context.architecture,
          osVersion: context.osVersion,
          selectedPlayer: context.selectedPlayer,
          playerVersion: context.playerVersion,
          connectorId: context.connectorId,
          connectorVersion: context.connectorVersion,
          latestConnectorVersion: context.latestConnectorVersion,
          connectionStatus: context.connectionStatus,
          diagnostics: includeDiagnostics
            ? context.diagnostics
            : {}
        });
        writeLog(
          `[问题反馈] 已提交 ${result.id}`,
          'Green'
        );
        res.end(JSON.stringify(result));
      } catch (error: unknown) {
        const message = error instanceof Error
          ? error.message
          : String(error);
        writeLog(`[问题反馈] 提交失败：${message}`, 'Yellow');
        res.writeHead(502);
        res.end(JSON.stringify({
          success: false,
          message
        }));
      }
      return;
    }

    if (url.pathname === '/api/connectors/update' && req.method === 'POST') {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      try {
        const body = await readJsonRequest(req);
        const connectorId = body.connectorId as NativeConnectorId;
        if (!['netease', 'kugou', 'qqmusic', 'folia'].includes(connectorId)) {
          res.writeHead(400);
          res.end(JSON.stringify({
            success: false,
            updated: false,
            message: '连接器标识无效'
          }));
          return;
        }

        setGlobalStatus(`正在更新${PLAYER_LABELS[connectorId]}连接器...`);
        const result = await withPlayerConnectionRecoverySuppressed(
          () => playerManager.updateConnector(connectorId, true)
        );
        setGlobalStatus(
          result.success
            ? `✅ ${result.message}`
            : `❌ ${result.message}`
        );
        writeLog(
          `[连接器更新] ${result.message}`,
          result.success ? 'Green' : 'Red'
        );
        res.end(JSON.stringify(result));
      } catch (error: unknown) {
        const message = error instanceof Error
          ? error.message
          : String(error);
        setGlobalStatus(`❌ 连接器更新失败：${message}`);
        res.end(JSON.stringify({
          success: false,
          updated: false,
          message
        }));
      }
      return;
    }

    if (url.pathname === '/api/connectors/reinstall' && req.method === 'POST') {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      try {
        const body = await readJsonRequest(req);
        const connectorId = body.connectorId as NativeConnectorId;
        if (!['netease', 'kugou', 'qqmusic', 'folia'].includes(connectorId)) {
          res.writeHead(400);
          res.end(JSON.stringify({
            success: false,
            updated: false,
            message: '连接器标识无效'
          }));
          return;
        }

        const result = await withPlayerConnectionRecoverySuppressed(
          () => playerManager.reinstallConnector(connectorId)
        );
        setGlobalStatus(
          result.success
            ? `✅ ${result.message}`
            : `❌ ${result.message}`
        );
        writeLog(
          `[连接器重装] ${result.message}`,
          result.success ? 'Green' : 'Red'
        );
        res.end(JSON.stringify(result));
      } catch (error: unknown) {
        const message = error instanceof Error
          ? error.message
          : String(error);
        res.end(JSON.stringify({
          success: false,
          updated: false,
          message
        }));
      }
      return;
    }

    if (url.pathname === '/api/update/check') {
      if (allowMultipleInstances) {
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({
          error: '多实例调试模式下已禁用自动更新，请使用正式安装版更新'
        }));
        return;
      }
      try {
        const um = new UpdateManager('https://app.enkianss.us/update/awoo');
        const updateInfo = await um.checkForUpdatesAsync();
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        if (updateInfo) res.end(JSON.stringify({ hasUpdate: true, version: updateInfo.TargetFullRelease.Version }));
        else res.end(JSON.stringify({ hasUpdate: false }));
      } catch (err: any) { res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify({ error: `无法连接更新服务器` })); }
      return;
    }

    if (url.pathname === '/api/update/status' && req.method === 'GET') {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({
        success: true,
        status: appUpdateDownloadStatus,
        phase: appUpdatePhase
      }));
      return;
    }

    if (url.pathname === '/api/update/apply' && req.method === 'POST') {
      if (allowMultipleInstances) {
        res.writeHead(409, {
          'Content-Type': 'application/json; charset=utf-8'
        });
        res.end(JSON.stringify({
          success: false,
          alreadyRunning: false,
          message: '多实例调试模式下不能启动自动更新，请在正式安装版中操作'
        }));
        return;
      }
      const started = startAppUpdateOperation();
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({
        success: true,
        alreadyRunning: !started,
        status: appUpdateDownloadStatus,
        phase: appUpdatePhase
      }));
      return;
    }

    if (url.pathname === '/api/debug/insert_next' && req.method === 'POST') {
      try {
        const { keyword } = await readJsonRequest(req);
        const playerKey = getSelectedPlayerKey();
        const track = (await playerManager.search(keyword))[0];

        if (track) {
          const success = await guardNextSong({
            Id: track.id,
            SongName: track.title,
            ArtistName: track.artist,
            Album: track.album,
            NativeData: track.nativeData || '',
            CoverUrl: track.coverUrl || '',
            PlayerKey: playerKey
          });
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.end(JSON.stringify({ success, track }));
        } else {
          res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify({ success: false, message: '未找到相关歌曲' }));
        }
      } catch (err: any) {
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ success: false, message: err?.message || String(err) }));
      }
      return;
    }

    if (url.pathname === '/api/bili/logout' && req.method === 'POST') { logoutBiliAccount(); res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify({ success: true })); return; }
    if (url.pathname === '/api/bili/qrstart' && req.method === 'POST') { startBiliQrLogin(); res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify({ success: true })); return; }
    if (url.pathname === '/api/bili/qrstatus') { res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify({ qrBase64: qrCodeBase64, status: qrLoginStatus, isLogin: isBiliLoginReady(), uid: biliUid, currentUser: currentUserInfo })); return; }
    if (url.pathname === '/api/logs') { res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(sysLogs)); return; }

    if (req.method === 'GET' && !url.pathname.startsWith('/api/') && url.pathname !== '/data') {
      const distPath = path.resolve(__dirname, '../dist');
      let requestedPath = 'index.html';
      try {
        requestedPath = url.pathname === '/'
          ? 'index.html'
          : decodeURIComponent(url.pathname).replace(/^[/\\]+/, '');
      } catch {
        requestedPath = 'index.html';
      }
      const candidatePath = path.resolve(distPath, requestedPath);
      let filePath = (
        candidatePath.startsWith(`${distPath}${path.sep}`)
        ? candidatePath
        : path.join(distPath, 'index.html')
      );
      if (!fs.existsSync(filePath)) filePath = path.join(distPath, 'index.html');
      try {
        if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
          const ext = path.extname(filePath);
          const mimeTypes: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json', '.woff': 'font/woff', '.woff2': 'font/woff2' };
          res.setHeader('Content-Type', mimeTypes[ext] || 'application/octet-stream'); res.writeHead(200); res.end(fs.readFileSync(filePath)); return;
        }
      } catch {}
    }
      res.writeHead(404); res.end();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      writeLog(`[内部 API] 请求失败：${message}`, 'Yellow');
      if (!res.headersSent) {
        res.writeHead(
          message.includes('1 MiB') ? 413 : 400,
          { 'Content-Type': 'application/json; charset=utf-8' }
        );
      }
      if (!res.writableEnded) {
        res.end(JSON.stringify({ success: false, message }));
      }
    }
  });

  internalApiServer = server;
  // 即使外部接口暂时关闭，也保留其配置端口，避免稍后开启时与内部服务冲突。
  const reservedPorts = [getExternalApiPort()];
  const result = await listenLoopbackWithFallback(
    server,
    requestedInternalApiPort,
    reservedPorts
  );
  requestedInternalApiPort = result.requestedPort;
  actualInternalApiPort = result.actualPort;
  internalApiFallbackReason = result.reason || null;
  server.on('error', (error: any) => {
    writeLog(`[内部 API] 运行中发生错误：${error?.message || error}`, 'Red');
  });
  if (result.fallback) {
    const reason = result.reason === 'reserved' ? '与外部只读接口端口冲突' : '请求端口已被占用';
    writeLog(
      `⚠️ 内部 API 请求端口 ${result.requestedPort}${reason}，已自动使用 ${result.actualPort}`,
      'Yellow'
    );
  }
  writeLog(
    `✅ 内部 API 及静态网页服务已启动于 ${getInternalApiOrigin()}`
      + (result.fallback ? `（请求端口 ${result.requestedPort}）` : ''),
    'Green'
  );
}

// ==========================================
// 程序启动入口
// ==========================================
if (hasSingleInstanceLock) app.whenReady().then(() => {
  writeLog('=== 嗷呜点歌机内部日志已连接 ===', 'Cyan');
  loadConfig();
  connectorMaintenanceTimer = setInterval(
    () => void maintainPlayerConnectors(true),
    CONNECTOR_MAINTENANCE_INTERVAL_MS
  );
  // 先开始监听本地接口，再加载悬浮窗，避免首次轮询撞上尚未启动的后端。
  void startBackendServer().then(() => {
    attachInternalApiTokenToAppSession();
    createOverlayWindow();
    if (overlayWindow) {
      // 先让透明悬浮窗完成首屏加载，再启动连接器、直播间和外部接口。
      // 这些后台任务会拉起 .NET 子进程并访问网络，冷启动时与 Chromium
      // 抢占磁盘和杀毒扫描资源会放大“点击后很久才出现窗口”的体感。
      scheduleStartupBackgroundServices(overlayWindow);
    } else {
      startStartupBackgroundServices();
    }
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createOverlayWindow(); });
  }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    writeLog(`❌ 内部 API 启动失败：${message}`, 'Red');
    dialog.showErrorBox(
      '嗷呜点歌机启动失败',
      `内部服务无法监听本机端口，控制面板不会继续运行。\n\n${message}`
    );
    requestApplicationQuit();
  });
});

app.on('before-quit', () => {
  applicationQuitRequested = true;
  if (giftLibrarySaveTimer) {
    clearTimeout(giftLibrarySaveTimer);
    giftLibrarySaveTimer = null;
    saveConfig();
  }
  if (connectorMaintenanceTimer) {
    clearInterval(connectorMaintenanceTimer);
    connectorMaintenanceTimer = null;
  }
  // Stop sockets and delayed reconnects without changing the persisted
  // connection preference; an enabled room may reconnect on the next launch.
  invalidateBiliRoomTransport();
  void withPlayerConnectionRecoverySuppressed(
    () => playerManager.stop()
  );
  const internalServer = internalApiServer;
  internalApiServer = null;
  actualInternalApiPort = null;
  if (internalServer?.listening) internalServer.close();
  void stopExternalApiServer();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') requestApplicationQuit();
});
