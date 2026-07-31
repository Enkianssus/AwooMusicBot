import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import http from 'http';
import fs from 'fs';
import os from 'os';
import zlib from 'zlib';
import { execSync } from 'child_process';
import { createRequire } from 'module';
import { WebSocket, WebSocketServer } from 'ws';
import QRCode from 'qrcode';
import {
  planQueueHeadMutation,
  queueSongIdentity
} from './queue-head-policy';
import {
  getNeteaseSongCover
} from './players/netease-player';
import { PlayerManager } from './players/player-manager';
import type { NativeConnectorId } from './connector-updater';
import {
  sanitizeFeedbackLog,
  submitFeedback
} from './feedback-service';
import {
  isSuccessfulPlayerResult,
  PLAYER_LABELS,
  playerKeyFromConfig,
  type PlayerKey,
  type PlayerOperationResult,
  type PlayerSnapshot
} from './players/types';

// ⭐ 动态引入 Velopack 规避静态打包分析
const customRequire = createRequire(import.meta.url);
const { UpdateManager } = customRequire('velopack');

// 1.1 起产品更名为 Awoo MusicBot。继续沿用旧用户数据目录，确保从
// BiliNCM 1.0.x 升级时保留登录信息、播放器选择和连接器安装状态。
if (process.platform === 'win32') {
  app.setPath(
    'userData',
    path.join(app.getPath('appData'), '嗷呜点歌机')
  );
}

// 强制修复 Windows 终端 of UTF-8 中文乱码问题
try {
  if (process.platform === 'win32') {
    execSync('chcp 65001');
  }
} catch { /* 忽略 */ }

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const INTERNAL_HTTP_PORT = Number(process.env['BILINCM_INTERNAL_PORT']) || 5555;
const DEFAULT_FETCH_TIMEOUT_MS = 10_000;

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
let statusClearTimer: NodeJS.Timeout | null = null;
let isPlayerConnected: boolean = false;

function setGlobalStatus(msg: string) {
  currentStatusMessage = msg;
  if (statusClearTimer) clearTimeout(statusClearTimer);
  statusClearTimer = setTimeout(() => {
    currentStatusMessage = '点歌就绪';
  }, 4000);
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

process.on('uncaughtException', (err) => {
  writeLog(`❌ [主进程致命错误]: ${err.message}`, 'Red');
});

process.on('unhandledRejection', (reason) => {
  if (String(reason).includes('could not be cloned')) return;
  writeLog(`⚠️ [未捕获的 Promise 异常]: ${reason}`, 'Yellow');
});

let overlayWindow: BrowserWindow | null = null;
let adminWindow: BrowserWindow | null = null;

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
    frame: false, transparent: true, hasShadow: false,
    backgroundColor: '#00000000', alwaysOnTop: true,
    resizable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.mjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  });
  loadWindow(overlayWindow, 'mode=electron');
  overlayWindow.on('closed', () => { overlayWindow = null; app.quit(); });
}

function createAdminWindow() {
  if (adminWindow && !adminWindow.isDestroyed()) {
    if (adminWindow.isMinimized()) adminWindow.restore();
    adminWindow.focus(); return;
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
  loadWindow(adminWindow, 'admin=true');
  adminWindow.on('closed', () => { adminWindow = null; });
}

ipcMain.on('open-admin', () => createAdminWindow());
ipcMain.on('close-window', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) { if (win === overlayWindow) app.quit(); else win.close(); }
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
      appConfig.widgetStyle = { theme: null, pos: { x: 50, y: 50 }, size: { w: resizedBounds.width, h: resizedBounds.height }, timestamp: Date.now() };
    } else {
      appConfig.widgetStyle.size = { w: resizedBounds.width, h: resizedBounds.height };
      appConfig.widgetStyle.timestamp = Date.now();
    }
    saveConfig();
  }
});

const CONFIG_PATH = path.join(app.getPath('userData'), 'bili_bot_config.json');

let appConfig: any = {
  roomId: 0,
  myRoomId: 0,
  biliCookie: '',
  biliUid: 0,
  widgetStyle: null,
  sysConfig: {
    PlayerType: 'NCM',
    FoliaToken: '',
    Cooldowns: { Normal: 0, Captain: 0, Admiral: 0, Governor: 0 },
    IdleWaitNext: true,
    ShowPlayerCurrentTrack: false,
    PauseAfterRequests: false,
    RequestedSongArtwork: 'bili_avatar',
    ShowAllDanmaku: false,
    SuperUsers: [],
    ExternalHttpEnabled: false,
    ExternalWebSocketEnabled: false,
    ExternalApiPort: 5556
  }
};

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const saved = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
      appConfig = { ...appConfig, ...saved };

      if (!appConfig.sysConfig) {
        appConfig.sysConfig = { PlayerType: 'NCM', FoliaToken: '', Cooldowns: { Normal: 0, Captain: 0, Admiral: 0, Governor: 0 }, IdleWaitNext: true, ShowPlayerCurrentTrack: false, PauseAfterRequests: false, RequestedSongArtwork: 'bili_avatar', ShowAllDanmaku: false, SuperUsers: appConfig.superUsers || [], ExternalHttpEnabled: false, ExternalWebSocketEnabled: false, ExternalApiPort: 5556 };
      }
      if (!['NCM', 'Kugou', 'QQMusic', 'Folia'].includes(appConfig.sysConfig.PlayerType)) appConfig.sysConfig.PlayerType = 'NCM';
      if (appConfig.sysConfig.FoliaToken === undefined) appConfig.sysConfig.FoliaToken = '';
      if (appConfig.sysConfig.ShowPlayerCurrentTrack === undefined) appConfig.sysConfig.ShowPlayerCurrentTrack = false;
      if (appConfig.sysConfig.PauseAfterRequests === undefined) appConfig.sysConfig.PauseAfterRequests = false;
      if (!['bili_avatar', 'song_cover'].includes(appConfig.sysConfig.RequestedSongArtwork)) appConfig.sysConfig.RequestedSongArtwork = 'bili_avatar';
      if (appConfig.sysConfig.ExternalHttpEnabled === undefined) appConfig.sysConfig.ExternalHttpEnabled = false;
      if (appConfig.sysConfig.ExternalWebSocketEnabled === undefined) appConfig.sysConfig.ExternalWebSocketEnabled = false;
      const apiPort = Number(appConfig.sysConfig.ExternalApiPort);
      appConfig.sysConfig.ExternalApiPort = (
        Number.isInteger(apiPort)
        && apiPort >= 1024
        && apiPort <= 65535
        && apiPort !== INTERNAL_HTTP_PORT
      ) ? apiPort : 5556;
      delete appConfig.sysConfig.EnableCDP;
      delete appConfig.sysConfig.CdpPort;
      delete appConfig.sysConfig.NcmExePath;

      if (appConfig.sysConfig.CooldownMinutes !== undefined && !appConfig.sysConfig.Cooldowns) {
        const oldSecs = appConfig.sysConfig.CooldownMinutes * 60;
        appConfig.sysConfig.Cooldowns = { Normal: oldSecs, Captain: oldSecs, Admiral: oldSecs, Governor: oldSecs };
        delete appConfig.sysConfig.CooldownMinutes;
      }

      biliCookie = appConfig.biliCookie || '';
      biliUid = appConfig.biliUid || 0;
      writeLog(`✅ 已加载本地配置，当前缓存的直播间为: ${appConfig.roomId}`, 'Green');
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
let registeredNextGuardKey = '';
let queueHeadNeedsGuardOnlyAfterCurrentChange = false;
const cancelledNativeNextKeys = new Set<string>();
let nextGuardOperationTail: Promise<void> = Promise.resolve();

function getSelectedPlayerKey(): PlayerKey {
  return playerKeyFromConfig(appConfig.sysConfig?.PlayerType);
}

function getSelectedPlayerLabel(): string {
  return PLAYER_LABELS[getSelectedPlayerKey()];
}

const playerManager = new PlayerManager({
  getSelectedKey: getSelectedPlayerKey,
  getFoliaToken: () =>
    String(appConfig.sysConfig?.FoliaToken || '').trim(),
  log: writeLog,
  setStatus: setGlobalStatus,
  onStateChanged: state => {
    isPlayerConnected = state.connected;
    playerConnecting = state.connecting;
    activePlayerSnapshot = state.snapshot;
    if (!state.connected) {
      registeredNextGuardKey = '';
      queueHeadNeedsGuardOnlyAfterCurrentChange = false;
    }
  },
  onTrackChanged: async (track, observation) => {
    if (!track) {
      await syncTrackChangeLogic('', '播放停止', null, '无');
      return;
    }
    await syncTrackChangeLogic(
      String(track.id || `${track.title}|${track.artist}`),
      track.title,
      null,
      observation.nextDescription,
      track.artist || '',
      observation.coverUrl || ''
    );
  },
  onTrackUpdated: (track, observation) => {
    updatePlayerCurrentTrack(
      String(track.id || `${track.title}|${track.artist}`),
      track.title,
      track.artist || '',
      observation.coverUrl || ''
    );
  }
});

const userCooldowns = new Map<string, number>();
let recentRejects: { id: number, user: any, reason: string }[] = [];

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

function logoutBiliAccount() {
  qrLoginAttemptId++;
  stopBiliQrPolling();
  isQrLoggingIn = false;
  qrCodeBase64 = '';
  qrLoginStatus = '已退出登录，可重新扫码绑定账号';

  if (currentBiliWs) {
    const ws = currentBiliWs;
    currentBiliWs = null;
    try { ws.close(); } catch {}
  }
  if (biliPingTimer) {
    clearInterval(biliPingTimer);
    biliPingTimer = null;
  }

  biliCookie = '';
  biliUid = 0;
  currentUserInfo = createEmptyBiliUserInfo();
  saveConfig();
  writeLog('[Bilibili] 已退出登录并清除本地账号凭据', 'Green');
  if (appConfig.roomId) {
    void connectToLiveRoom(appConfig.roomId).then(connected => {
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

async function connectToLiveRoom(shortRoomId: number): Promise<boolean> {
  try {
    const headers: any = { "User-Agent": "Mozilla/5.0", "Referer": `https://live.bilibili.com/${shortRoomId}` };
    if (biliCookie) headers["Cookie"] = biliCookie;

    const initRes = await fetchWithTimeout(`https://api.live.bilibili.com/room/v1/Room/room_init?id=${shortRoomId}`, { headers });
    const initData: any = await initRes.json();
    if (initData.code !== 0) {
      writeLog(`[Bilibili] 房间初始化失败，code=${initData.code}`, 'Yellow');
      return false;
    }

    const realRoomId = initData.data?.room_id || shortRoomId;
    const danmuRes = await fetchWithTimeout(`https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo?id=${realRoomId}&type=0`, { headers });
    let danmuData: any = await danmuRes.json();

    if (JSON.stringify(danmuData).includes("-352") || danmuData.code !== 0) {
      writeLog(`[Bilibili] 新版弹幕接口不可用，code=${danmuData.code}，尝试兼容接口`, 'Yellow');
      const fallbackRes = await fetchWithTimeout(`https://api.live.bilibili.com/room/v1/Danmu/getConf?room_id=${realRoomId}&platform=pc&player=web`, { headers });
      danmuData = await fallbackRes.json();
    }

    const token = danmuData.data?.token || "";
    if (danmuData.code !== 0 || !token) {
      writeLog(`[Bilibili] 无法获取弹幕鉴权信息，code=${danmuData.code}`, 'Red');
      return false;
    }

    const endpoints = getBiliDanmuEndpoints(danmuData);
    if (endpoints.length === 0) {
      writeLog('[Bilibili] 接口未返回可用的弹幕节点', 'Red');
      return false;
    }

    let finalBuvid = "999E9060-EA3F-0F79-7BDC-A14879D11DCB95434infoc";
    const b3Match = biliCookie.match(/buvid3=([^;]+)/);
    if (b3Match) finalBuvid = b3Match[1];

    appConfig.roomId = shortRoomId;
    saveConfig();

    startBiliWebSocket(
      { uid: biliUid || 0, roomid: realRoomId, protover: 3, buvid: finalBuvid, support_ack: true, type: 2, key: token },
      endpoints
    );
    return true;
  } catch (err: any) {
    writeLog(`[Bilibili] 连接直播间失败：${err?.message || err}`, 'Red');
    return false;
  }
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

function startBiliWebSocket(authObj: any, endpoints: BiliDanmuEndpoint[], endpointIndex: number = 0) {
  if (currentBiliWs) {
    const previousWs = currentBiliWs;
    currentBiliWs = null;
    try { previousWs.close(); } catch {}
  }
  if (biliPingTimer) {
    clearInterval(biliPingTimer);
    biliPingTimer = null;
  }

  const WebSocketClient = getWebSocketClient();
  if (!WebSocketClient || endpoints.length === 0) return;

  const isNodeWs = typeof WebSocketClient.prototype?.on === 'function';
  const wsOptions = isNodeWs ? { headers: { "User-Agent": "Mozilla/5.0" } } : undefined;
  const normalizedIndex = endpointIndex % endpoints.length;
  const endpoint = endpoints[normalizedIndex];

  writeLog(`[Bilibili] 正在连接弹幕节点 ${endpoint.host}:${endpoint.port}`, 'Gray');
  const ws = new WebSocketClient(endpoint.url, wsOptions);
  currentBiliWs = ws;
  let authenticated = false;
  let reconnectScheduled = false;

  const scheduleReconnect = (reason: string) => {
    if (reconnectScheduled || currentBiliWs !== ws) return;
    reconnectScheduled = true;
    clearTimeout(connectionTimer);
    if (biliPingTimer) {
      clearInterval(biliPingTimer);
      biliPingTimer = null;
    }
    writeLog(`[Bilibili] 节点 ${endpoint.host} ${reason}，切换下一个节点`, 'Yellow');
    setTimeout(() => {
      if (currentBiliWs === ws) startBiliWebSocket(authObj, endpoints, normalizedIndex + 1);
    }, 1500);
  };

  const connectionTimer = setTimeout(() => {
    scheduleReconnect(authenticated ? '连接中断' : '连接或鉴权超时');
    try {
      if (typeof ws.terminate === 'function') ws.terminate();
      else ws.close();
    } catch {}
  }, 10000);

  const onOpen = () => {
    if (currentBiliWs !== ws) return;
    const authPayload = Buffer.from(JSON.stringify(authObj), 'utf-8');
    const packet = Buffer.alloc(16 + authPayload.length);
    packet.writeInt32BE(packet.length, 0); packet.writeInt16BE(16, 4); packet.writeInt16BE(1, 6); packet.writeInt32BE(7, 8); packet.writeInt32BE(1, 12);
    authPayload.copy(packet, 16); ws.send(packet);
  };

  const onMessage = async (data: any) => {
    if (currentBiliWs !== ws) return;
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
          try { ws.close(); } catch {}
          return;
        }

        authenticated = true;
        clearTimeout(connectionTimer);
        writeLog(`✅ [Bilibili] 弹幕节点已鉴权：${endpoint.host}`, 'Green');
        biliPingTimer = setInterval(() => {
          if (currentBiliWs === ws && ws.readyState === 1) {
            const hb = Buffer.alloc(31);
            hb.writeInt32BE(hb.length, 0); hb.writeInt16BE(16, 4); hb.writeInt16BE(1, 6); hb.writeInt32BE(2, 8); hb.writeInt32BE(1, 12);
            Buffer.from("[object Object]", "utf-8").copy(hb, 16); ws.send(hb);
          }
        }, 30000);
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

  if (typeof ws.on === 'function') { ws.on('open', onOpen); ws.on('message', onMessage); ws.on('close', onClose); ws.on('error', onError); }
  else { ws.onopen = onOpen; ws.onmessage = (e: any) => onMessage(e.data); ws.onclose = onClose; ws.onerror = onError; }
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
  if (appConfig.sysConfig?.SuperUsers?.includes(user.uname) || appConfig.sysConfig?.SuperUsers?.includes(user.uid)) return { allowed: true };
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

function handleRawDanmaku(doc: any) {
  const cmd = doc.cmd || "";
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
  const normalizedId = String(songId || '');
  if (!normalizedId) return '';
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
  const knownCoverUrl = coverUrl || songCoverCache.get(normalizedId) || '';
  if (knownCoverUrl) cacheSongCover(normalizedId, knownCoverUrl);

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

async function syncTrackChangeLogic(currId: string, currName: string, nextId: string | null, nextName: string, currArtist: string = '', currCoverUrl: string = ''): Promise<void> {
  playerPausedAfterRequests = false;
  updatePlayerCurrentTrack(currId, currName, currArtist, currCoverUrl);
  writeLog(`[状态同步] 🎵 播放器切歌信号: ${currName} (${currId}) | 下一首预告: ${nextName}`, 'Magenta');
  let stateChanged = false;

  const cancelledKey = getQueueSongIdentity({
    Id: currId,
    PlayerKey: getSelectedPlayerKey()
  });
  if (currId && cancelledNativeNextKeys.delete(cancelledKey)) {
    registeredNextGuardKey = '';
    writeLog(
      `[队首撤回兜底] 已撤回的预插歌曲开始播放，立即跳过: ${currName}`,
      'Yellow'
    );
    await requestPlayerNext();
    return;
  }

  if (!isPlaying) {
    if (targetQueue.length > 0 && currId === targetQueue[0]?.Id) {
      writeLog(`[状态同步] 处于暂停状态，自动跳过待播曲目以防消耗: ${targetQueue[0]?.SongName}`, 'Yellow');
      await requestPlayerNext();
    } else {
      if (currentPlayingSong) { currentPlayingSong = null; stateChanged = true; }
    }
  }
  else {
    if (currentPlayingSong && currId !== currentPlayingSong?.Id) {
      const checkSkipForce = skipForcePlayOnce;
      skipForcePlayOnce = false;

      if (targetQueue.length > 0 && currId === targetQueue[0]?.Id) {
        writeLog(`[状态同步] 自然衔接到队首: ${targetQueue[0]?.SongName}`, 'Green');
        registeredNextGuardKey = '';
        currentPlayingSong = targetQueue.shift();
        stateChanged = true;
      } else if (targetQueue.length > 0) {
        if (checkSkipForce && targetQueue[0]?.Id === currentPlayingSong?.Id) {
          writeLog(`[状态同步] 退回操作触发: 放行原生曲目，点播曲延后: ${targetQueue[0]?.SongName}`, 'DarkGray');
          await guardNextSong(targetQueue[0]);
          currentPlayingSong = null;
          stateChanged = true;
        } else {
          writeLog(`[状态同步] 捕捉到切歌信号！强制拉起待播列表首曲: ${targetQueue[0]?.SongName}`, 'Magenta');
          const queuedSong = targetQueue[0];
          if (await playSongNow(queuedSong)) {
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
      && currId === currentPlayingSong?.Id
      && currId === targetQueue[0]?.Id
    ) {
      registeredNextGuardKey = '';
      targetQueue.shift();
      stateChanged = true;
    } else if (!currentPlayingSong && targetQueue.length > 0) {
      if (currId === targetQueue[0]?.Id) {
        registeredNextGuardKey = '';
        currentPlayingSong = targetQueue.shift();
        stateChanged = true;
      } else {
        writeLog(`[兜底纠正] 实际切歌与待播队首不符，立即切到: ${targetQueue[0]?.SongName}`, 'Magenta');
        const queuedSong = targetQueue[0];
        if (await playSongNow(queuedSong)) {
          stateChanged = true;
        }
      }
    }

    if (stateChanged) setGlobalStatus(currentPlayingSong ? `[播放] ${currentPlayingSong?.SongName}` : '点歌就绪');

    if (isPlaying && targetQueue.length > 0 && currentPlayingSong && currId === currentPlayingSong?.Id) {
      if (String(nextId) !== String(targetQueue[0]?.Id)) {
        writeLog(`[队首推进] 当前点歌已开始播放，只登记新的本地队首: ${targetQueue[0]?.SongName}`, 'DarkGray');
        if (queueHeadNeedsGuardOnlyAfterCurrentChange) {
          queueHeadNeedsGuardOnlyAfterCurrentChange = false;
          await armNextGuardOnly(targetQueue[0]);
        } else {
          await guardNextSong(targetQueue[0]);
        }
      }
    }
  }
}

// 播放器连接与控制实现位于 electron/players。
// main.ts 只保留业务队列与界面的调用入口。
const CONNECTOR_MAINTENANCE_INTERVAL_MS = 30 * 60 * 1000;
let connectorMaintenanceTimer: NodeJS.Timeout | null = null;
let connectorMaintenanceRunning = false;

function getSelectedNativeConnector(): NativeConnectorId {
  return getSelectedPlayerKey();
}

async function connectWithConnectorMaintenanceStatus(
  connect: () => Promise<boolean>
): Promise<boolean> {
  const connectorId = getSelectedNativeConnector();
  let ownedStatus = '';
  if (
    connectorId
    && !await playerManager.isConnectorInstalled(connectorId)
  ) {
    ownedStatus =
      `正在更新${PLAYER_LABELS[connectorId]}播放器连接器`;
    connectorMaintenanceStatus = ownedStatus;
    writeLog(`[连接器] ${ownedStatus}`, 'Cyan');
  }

  try {
    const connected = await connect();
    if (connected) {
      return true;
    }

    const statuses = await playerManager.getConnectorStatuses(true);
    const status = statuses.find(item => item.id === connectorId);
    if (
      status?.installed
      && status.compatible
      && status.updateAvailable
      && !status.updating
    ) {
      const recoveryStatus =
        `正在升级${PLAYER_LABELS[connectorId]}连接器并重试连接`;
      connectorMaintenanceStatus = recoveryStatus;
      writeLog(
        `[连接器兼容恢复] 当前连接失败，尝试从 `
        + `${status.currentVersion} 升级到 ${status.latestVersion}`,
        'Cyan'
      );
      const result = await playerManager.updateConnector(connectorId);
      writeLog(
        `[连接器兼容恢复] ${result.message}`,
        result.success ? 'Green' : 'Yellow'
      );
      return result.success && result.reconnected === true;
    }
    return false;
  } finally {
    if (connectorMaintenanceStatus === ownedStatus) {
      connectorMaintenanceStatus = '';
    }
  }
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
      if (
        status.updating
        || status.installed
      ) {
        if (status.updateAvailable) {
          writeLog(
            `[连接器热更新] ${status.name} 有新版本 `
            + `${status.latestVersion}；当前已安装版本仍可用，暂不自动替换。`,
            'DarkGray'
          );
        }
        continue;
      }

      const selected = getSelectedNativeConnector() === status.id;
      const ownedStatus = selected && !status.installed
        ? `正在更新${status.name}播放器连接器`
        : '';
      if (ownedStatus) {
        connectorMaintenanceStatus = ownedStatus;
      }

      try {
        const result = await playerManager.updateConnector(status.id);
        writeLog(
          `[连接器热更新] ${result.message}`,
          result.success ? 'Green' : 'Yellow'
        );
      } finally {
        if (
          ownedStatus
          && connectorMaintenanceStatus === ownedStatus
        ) {
          connectorMaintenanceStatus = '';
        }
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

async function reconnectPlayerBridge(): Promise<boolean> {
  updatePlayerCurrentTrack('', '');
  return await connectWithConnectorMaintenanceStatus(
    () => playerManager.reconnect()
  );
}

async function startPlayerRadar(): Promise<boolean> {
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
  return await playerManager.execute(
    command as Parameters<PlayerManager['execute']>[0],
    song
  );
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

async function guardNextSong(
  songInfo: any
): Promise<boolean> {
  return serializeNextGuardOperation(async () => {
    if (!songInfo) return false;
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
      writeLog(`✅ 已登记下一首守卫: ${songInfo.SongName}`, 'DarkGray');
      return true;
    }
    if (registeredNextGuardKey === guardKey) {
      registeredNextGuardKey = '';
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
      writeLog(
        `🛡️ 队首已变化，只更新兜底目标且未再次插入播放器队列: ${songInfo.SongName}`,
        'DarkGray'
      );
      return true;
    }

    registeredNextGuardKey = '';
    writeLog(
      `[队首守卫] 连接器未能只更新兜底目标，将由主程序在切歌后纠正: ${songInfo.SongName}`,
      'Yellow'
    );
    return false;
  });
}

function rememberCancelledNativeNext(songInfo: any): void {
  if (!songInfo) return;
  cancelledNativeNextKeys.add(getQueueSongIdentity(songInfo));
  while (cancelledNativeNextKeys.size > 64) {
    const oldest = cancelledNativeNextKeys.values().next().value;
    if (typeof oldest !== 'string') break;
    cancelledNativeNextKeys.delete(oldest);
  }
}

async function reconcileQueueHeadAfterMutation(
  previousHead: any,
  context: string
): Promise<void> {
  const nextHead = targetQueue[0] || null;
  const hadRegisteredNext = Boolean(registeredNextGuardKey);
  const action = planQueueHeadMutation({
    previousHeadIdentity: getQueueSongIdentity(previousHead),
    nextHeadIdentity: getQueueSongIdentity(nextHead),
    hadRegisteredNext,
    isPlaying
  });
  if (action === 'none') return;

  registeredNextGuardKey = '';
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

async function playSongNow(songInfo: any): Promise<boolean> {
  if (!songInfo) return false;
  playerPausedAfterRequests = false;
  const previousCurrentPlayingSong = currentPlayingSong;
  const hadRegisteredNativeNext = Boolean(registeredNextGuardKey);
  queueHeadNeedsGuardOnlyAfterCurrentChange = hadRegisteredNativeNext;
  registeredNextGuardKey = '';
  currentPlayingSong = songInfo;
  const result = await executePlayerCommand('PlaySelected', songInfo);
  if (!isSuccessfulPlayerResult(result)) {
    if (isObservedSong(songInfo)) return true;
    currentPlayingSong = previousCurrentPlayingSong;
    queueHeadNeedsGuardOnlyAfterCurrentChange = false;
    if (hadRegisteredNativeNext && targetQueue[0]) {
      await armNextGuardOnly(targetQueue[0]);
    }
    return false;
  }
  if (String(result?.outcome).toLowerCase() === 'indeterminate') {
    if (isObservedSong(songInfo)) return true;
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
  if (!songInfo || !playerCurrentTrack) return false;
  const expectedId = String(songInfo.Id || '').trim();
  const observedId = String(playerCurrentTrack.Id || '').trim();
  if (expectedId && observedId && expectedId === observedId) return true;
  const normalize = (value: unknown) =>
    String(value || '').replace(/\s+/g, '').toLowerCase();
  return (
    normalize(songInfo.SongName) === normalize(playerCurrentTrack.SongName)
    && (
      !songInfo.ArtistName
      || !playerCurrentTrack.ArtistName
      || normalize(songInfo.ArtistName)
        === normalize(playerCurrentTrack.ArtistName)
    )
  );
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
async function tryRequestSong(
  user: any,
  keyword: string,
  mode: 'normal' | 'top' | 'interrupt' | 'play_now' = 'normal'
): Promise<void> {
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
      return;
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
    cancelledNativeNextKeys.delete(getQueueSongIdentity(newSong));

    if (mode === 'interrupt') {
      if (currentPlayingSong) targetQueue.unshift(currentPlayingSong);
      setGlobalStatus(`⚡ 插队: ${newSong.SongName}`);
      if (!await playSongNow(newSong)) targetQueue.unshift(newSong);
      return;
    }

    if (mode === 'play_now') {
      setGlobalStatus(`▶️ 立即: ${newSong.SongName}`);
      if (!await playSongNow(newSong)) targetQueue.unshift(newSong);
      return;
    }

    const previousHead = targetQueue[0] || null;
    if (mode === 'top') {
      targetQueue.unshift(newSong);
      setGlobalStatus(`⬆️ 置顶: ${newSong.SongName}`);
    } else {
      targetQueue.push(newSong);
      setGlobalStatus(`✅ 点歌: ${newSong.SongName}`);
    }

    if (mode === 'top' && previousHead) {
      await reconcileQueueHeadAfterMutation(previousHead, '置顶点歌');
    } else if (!previousHead && isPlaying) {
      if (
        appConfig.sysConfig?.IdleWaitNext === false
        && !currentPlayingSong
      ) {
        const first = targetQueue[0];
        if (first) await playSongNow(first);
      } else {
        await guardNextSong(targetQueue[0]);
      }
    }
  } catch (err: any) {
    writeLog(`[点歌搜索] ${getSelectedPlayerLabel()} 搜索异常: ${err?.message || err}`, 'Red');
    setGlobalStatus('❌ 搜索或播放器通信异常');
    await addReject(user, '搜索或播放器通信异常');
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

    const isSuperUser = isBiliLoginReady()
      && (appConfig.sysConfig?.SuperUsers?.includes(user.uname)
        || appConfig.sysConfig?.SuperUsers?.includes(user.uid));
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
      userCooldowns.set(user.uid, Date.now());
      await tryRequestSong(user, keyword, mode);
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
          if (appConfig.roomId) void connectToLiveRoom(appConfig.roomId);
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

function sanitizeExternalSong(song: any): any {
  if (!song) return null;
  return {
    id: String(song.Id || ''),
    title: song.SongName || '',
    artist: song.ArtistName || '',
    album: song.Album || '',
    coverUrl: song.CoverUrl || '',
    requestedBy: song.OrderedBy || '',
    requestedByUid: String(song.OrderedByUid || ''),
    requestedByAvatar: song.OrderedByAvatar || '',
    guardLevel: Number(song.GuardLevel || 0)
  };
}

function buildExternalState() {
  return {
    schemaVersion: 1,
    appVersion: app.getVersion(),
    timestamp: new Date().toISOString(),
    player: {
      key: getSelectedPlayerKey(),
      name: getSelectedPlayerLabel(),
      connected: isPlayerConnected,
      connecting: playerConnecting,
      processId: activePlayerSnapshot?.processId ?? null,
      version: activePlayerSnapshot?.version || '',
      status: activePlayerSnapshot?.status || ''
    },
    current: sanitizeExternalSong(currentPlayingSong || playerCurrentTrack),
    currentIsRequested: Boolean(currentPlayingSong),
    queue: targetQueue.map(sanitizeExternalSong),
    accepting: isAccepting,
    playing: isPlaying,
    pausedAfterRequests: playerPausedAfterRequests,
    commandQueue: {
      pending: danmakuCommandQueue.length,
      processing: processingDanmakuCommand
    }
  };
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
      capabilities: activePlayerSnapshot?.capabilities || null
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
  return (
    Number.isInteger(value)
    && value >= 1024
    && value <= 65535
    && value !== INTERNAL_HTTP_PORT
  ) ? value : 5556;
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
  const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
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
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    if (url.pathname === '/health') {
      res.end(JSON.stringify({ ok: true, version: app.getVersion() }));
      return;
    }

    const state = buildExternalState();
    if (url.pathname === '/api/v1/state') {
      res.end(JSON.stringify(state));
      return;
    }
    if (url.pathname === '/api/v1/current') {
      res.end(JSON.stringify({
        timestamp: state.timestamp,
        player: state.player,
        current: state.current,
        currentIsRequested: state.currentIsRequested
      }));
      return;
    }
    if (url.pathname === '/api/v1/queue') {
      res.end(JSON.stringify({
        timestamp: state.timestamp,
        queue: state.queue
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
function startBackendServer() {
  const server = http.createServer(async (req, res) => {
    try {
      const origin = req.headers.origin;
      if (!isAllowedInternalOrigin(origin)) {
        res.writeHead(403);
        res.end('Forbidden origin');
        return;
      }
      if (origin) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
      }
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    const url = new URL(req.url || '/', `http://${req.headers.host}`);

    if (url.pathname === '/data') {
      const showPlayerCurrentTrack = appConfig.sysConfig?.ShowPlayerCurrentTrack === true;
      const displayCurrent = currentPlayingSong || (showPlayerCurrentTrack ? playerCurrentTrack : null);
      const requestedSongArtwork = appConfig.sysConfig?.RequestedSongArtwork === 'song_cover' ? 'song_cover' : 'bili_avatar';
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ current: displayCurrent, currentIsRequested: !!currentPlayingSong, playerPausedAfterRequests, requestedSongArtwork, queue: targetQueue, status: connectorMaintenanceStatus || currentStatusMessage, accepting: isAccepting, playing: isPlaying, uiConfig: appConfig.widgetStyle, rejects: recentRejects, cdpConnected: isPlayerConnected, playerConnected: isPlayerConnected, playerConnecting, commandQueue: { pending: danmakuCommandQueue.length, processing: processingDanmakuCommand } }));
      return;
    }

    if (url.pathname === '/api/config') {
      if (req.method === 'POST') {
        const body = await readJsonRequest(req);
        const previousPlayerType = appConfig.sysConfig?.PlayerType;
        const previousExternalSettings = JSON.stringify({
          http: appConfig.sysConfig?.ExternalHttpEnabled === true,
          ws: appConfig.sysConfig?.ExternalWebSocketEnabled === true,
          port: getExternalApiPort()
        });
        if (body.roomId !== undefined) appConfig.roomId = body.roomId;
        if (body.widgetStyle !== undefined) appConfig.widgetStyle = body.widgetStyle;
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
        appConfig.sysConfig.ExternalApiPort = getExternalApiPort();
        delete appConfig.sysConfig.EnableCDP;
        delete appConfig.sysConfig.CdpPort;
        delete appConfig.sysConfig.NcmExePath;
        saveConfig();

        if (previousPlayerType !== appConfig.sysConfig.PlayerType) {
          targetQueue = [];
          currentPlayingSong = null;
          playerPausedAfterRequests = false;
          isPlayerConnected = false;
          playerConnecting = true;
          activePlayerSnapshot = null;
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
          playerConnecting
        }));
        return;
      }
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({
        roomId: appConfig.roomId,
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
        connectorMaintenanceStatus,
        commandQueue: { pending: danmakuCommandQueue.length, processing: processingDanmakuCommand },
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
      if (doc.roomId) {
        const success = await connectToLiveRoom(doc.roomId);
        res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify({ success })); return;
      }
      res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify({ success: false })); return;
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
      url.pathname === '/api/feedback/submit'
      && req.method === 'POST'
    ) {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      try {
        const body = await readJsonRequest(req);
        const includeDiagnostics = body.includeDiagnostics !== false;
        const context = await buildFeedbackContext(
          includeDiagnostics && body.includeLogs === true
        );
        const result = await submitFeedback({
          category: String(body.category || 'bug'),
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
        const result = await playerManager.updateConnector(connectorId);
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

        const result = await playerManager.reinstallConnector(connectorId);
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
      try {
        const um = new UpdateManager('https://app.enkianss.us/update/awoo');
        const updateInfo = await um.checkForUpdatesAsync();
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        if (updateInfo) res.end(JSON.stringify({ hasUpdate: true, version: updateInfo.TargetFullRelease.Version }));
        else res.end(JSON.stringify({ hasUpdate: false }));
      } catch (err: any) { res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify({ error: `无法连接更新服务器` })); }
      return;
    }

    if (url.pathname === '/api/update/apply' && req.method === 'POST') {
      res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify({ success: true }));
      try {
        const um = new UpdateManager('https://app.enkianss.us/update/awoo');
        const updateInfo = await um.checkForUpdatesAsync();
        if (updateInfo) {
          setGlobalStatus(`🚀 下载更新中...`);
          await um.downloadUpdateAsync(updateInfo, (progress: number) => { if (progress % 20 === 0) writeLog(`[更新] 下载进度: ${progress}%`, 'DarkGray'); });
          um.waitExitThenApplyUpdate(updateInfo, false, true); app.quit();
        }
      } catch { setGlobalStatus(`❌ 更新失败`); }
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

  server.listen(INTERNAL_HTTP_PORT, '127.0.0.1', () => {
    writeLog(
      `✅ 内部 API 及静态网页服务已启动于 http://127.0.0.1:${INTERNAL_HTTP_PORT}`,
      'Green'
    );
  });
}

// ==========================================
// 程序启动入口
// ==========================================
app.whenReady().then(() => {
  writeLog('=== Awoo MusicBot 内部日志已连接 ===', 'Cyan');
  loadConfig();
  void startPlayerBridge();
  connectorMaintenanceTimer = setInterval(
    () => void maintainPlayerConnectors(true),
    CONNECTOR_MAINTENANCE_INTERVAL_MS
  );
  createOverlayWindow();

  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createOverlayWindow(); });
  startBackendServer();
  void restartExternalApiServer();
  if (biliCookie) updateCurrentUserInfo();
  if (appConfig.roomId) connectToLiveRoom(appConfig.roomId);
});

app.on('before-quit', () => {
  if (connectorMaintenanceTimer) {
    clearInterval(connectorMaintenanceTimer);
    connectorMaintenanceTimer = null;
  }
  void playerManager.stop();
  void stopExternalApiServer();
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
