import { app, BrowserWindow, ipcMain, WebContents } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import http from 'http';
import fs from 'fs';
import zlib from 'zlib';
import { exec, execSync, spawn } from 'child_process';
import { promisify } from 'util';
import { createRequire } from 'module';

// ⭐ 动态引入 Velopack 规避静态打包分析
const customRequire = createRequire(import.meta.url);
const { UpdateManager } = customRequire('velopack');

// 强制修复 Windows 终端 of UTF-8 中文乱码问题
try {
  if (process.platform === 'win32') {
    execSync('chcp 65001');
  }
} catch { /* 忽略 */ }

const execAsync = promisify(exec);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
let statusClearTimer: NodeJS.Timeout | null = null;
let isCdpConnected: boolean = false;

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

// ⭐ 新增：智能获取国内 IP 伪装头部绕过版权与海外连接封锁
function getChinaBypassHeaders(): Record<string, string> {
  const chinaIPs = [
    "218.75.111.114",  // 浙江杭州 电信
    "111.206.176.1",   // 北京 联通
    "112.12.12.12",    // 浙江 移动
    "223.5.5.5"        // 阿里公共DNS
  ];
  const fakeIP = chinaIPs[Math.floor(Math.random() * chinaIPs.length)];
  return {
    "X-Real-IP": fakeIP,
    "X-Forwarded-For": fakeIP
  };
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

function beautifyAlerts(webContents: WebContents) {
  webContents.on('did-finish-load', () => {
    webContents.executeJavaScript(`
      if (!window._alertBeautified) {
        window._alertBeautified = true;
        window.alert = (msg) => {
          const div = document.createElement('div');
          div.innerHTML = \`
            <div style="position:fixed; top:24px; left:50%; transform:translateX(-50%); 
                        background:rgba(15, 23, 42, 0.85); color:#fff; padding:12px 24px; 
                        border-radius:12px; z-index:2147483647; font-size:14px; 
                        box-shadow:0 15px 40px rgba(0,0,0,0.5); backdrop-filter:blur(16px); 
                        border:1px solid rgba(255,255,255,0.15); font-weight: bold;
                        animation: __toastSlideDown 0.4s cubic-bezier(0.16, 1, 0.3, 1);">
              \${msg}
            </div>
            <style>
              @keyframes __toastSlideDown { from { opacity: 0; transform: translate(-50%, -20px) scale(0.95); } to { opacity: 1; transform: translate(-50%, 0) scale(1); } }
            </style>
          \`;
          document.body.appendChild(div);
          setTimeout(() => { 
            div.firstElementChild.style.opacity = '0'; 
            div.firstElementChild.style.transform = 'translate(-50%, -10px) scale(0.98)';
            div.firstElementChild.style.transition = 'all 0.3s ease'; 
            setTimeout(() => div.remove(), 300); 
          }, 3500);
        };
      }
    `);
  });
}

function loadWindow(win: BrowserWindow, queryParams: string) {
  beautifyAlerts(win.webContents);

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

function createOverlayWindow() {
  overlayWindow = new BrowserWindow({
    width: 400, height: 580, minWidth: 280, minHeight: 380,
    frame: false, transparent: true, hasShadow: false,
    backgroundColor: '#00000000', alwaysOnTop: true,
    resizable: false,
    webPreferences: { nodeIntegration: true, contextIsolation: false }
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
    webPreferences: { nodeIntegration: true, contextIsolation: false }
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
  if (win) {
    win.setBounds({ width: w, height: h });
    if (!appConfig.widgetStyle) {
      appConfig.widgetStyle = { theme: null, pos: { x: 50, y: 50 }, size: { w, h }, timestamp: Date.now() };
    } else {
      appConfig.widgetStyle.size = { w, h };
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
    EnableCDP: true,
    CdpPort: 9222,
    Cooldowns: { Normal: 0, Captain: 0, Admiral: 0, Governor: 0 },
    IdleWaitNext: true,
    ShowAllDanmaku: false,
    SuperUsers: [],
    NcmExePath: ""
  }
};

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const saved = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
      appConfig = { ...appConfig, ...saved };

      if (!appConfig.sysConfig) {
        appConfig.sysConfig = { PlayerType: 'NCM', FoliaToken: '', EnableCDP: true, CdpPort: 9222, Cooldowns: { Normal: 0, Captain: 0, Admiral: 0, Governor: 0 }, IdleWaitNext: true, ShowAllDanmaku: false, SuperUsers: appConfig.superUsers || [], NcmExePath: "" };
      }
      if (!appConfig.sysConfig.PlayerType) appConfig.sysConfig.PlayerType = appConfig.sysConfig.EnableCDP === false ? 'None' : 'NCM';
      if (appConfig.sysConfig.FoliaToken === undefined) appConfig.sysConfig.FoliaToken = '';

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

let currentUserInfo: any = { uid: 0, uname: '', face: '', level: 0, myRoomId: 0, followerCount: 0, guardCount: 0, fanClubCount: 0 };

let qrCodeBase64 = "";
let qrLoginStatus = "等待获取二维码...";
let isQrLoggingIn = false;
let qrPollTimer: NodeJS.Timeout | null = null;

let targetQueue: any[] = [];
let currentPlayingSong: any = null;
let lastTrackId: string | null = null;
let lastQueueActionTime = 0; // 全局队列操作防抖冷却时间

const userCooldowns = new Map<string, number>();
let recentRejects: { id: number, user: any, reason: string }[] = [];

interface CurrentLyricLine {
  index: number;
  time: number;
  text: string;
  translation: string;
}

interface CurrentLyricsPayload {
  trackId: string;
  songName: string;
  artistName: string;
  playedTime: number | null;
  duration: number | null;
  progress: number;
  current: CurrentLyricLine | null;
  previous: CurrentLyricLine | null;
  next: CurrentLyricLine | null;
  hasLyrics: boolean;
  isLoading: boolean;
  updatedAt: number;
}

interface ParsedLyricsLine {
  time: number;
  text: string;
}

interface TrackLyrics {
  trackId: string;
  lines: ParsedLyricsLine[];
  translatedLines: ParsedLyricsLine[];
  fetchedAt: number;
}

let currentLyrics: CurrentLyricsPayload | null = null;
let latestLyricsSnapshot: CurrentLyricsPayload | null = null;
const fetchedTrackLyrics = new Map<string, TrackLyrics>();
const fetchingTrackLyrics = new Map<string, Promise<void>>();
const failedTrackLyrics = new Map<string, string>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function readFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function readLyricLine(value: unknown): CurrentLyricLine | null {
  if (!isRecord(value)) return null;

  const index = readFiniteNumber(value.index);
  const time = readFiniteNumber(value.time);
  if (index === null || time === null) return null;

  return {
    index,
    time,
    text: readString(value.text),
    translation: readString(value.translation)
  };
}

function readLyricsPayload(value: unknown): CurrentLyricsPayload | null {
  if (!isRecord(value)) return null;

  const progress = readFiniteNumber(value.progress);
  const updatedAt = readFiniteNumber(value.updatedAt);
  if (progress === null || updatedAt === null) return null;

  return {
    trackId: readString(value.trackId),
    songName: readString(value.songName),
    artistName: readString(value.artistName),
    playedTime: readFiniteNumber(value.playedTime),
    duration: readFiniteNumber(value.duration),
    progress: Math.max(0, Math.min(1, progress)),
    current: readLyricLine(value.current),
    previous: readLyricLine(value.previous),
    next: readLyricLine(value.next),
    hasLyrics: value.hasLyrics === true,
    isLoading: value.isLoading === true,
    updatedAt
  };
}

function parseLrcTimestamp(tag: string): number | null {
  const match = tag.match(/^\[(\d+)[:.'](\d+)(?:[:.'](\d+))?\]$/);
  if (!match) return null;

  const minutes = Number.parseInt(match[1], 10);
  const seconds = Number.parseInt(match[2], 10);
  if (!Number.isFinite(minutes) || !Number.isFinite(seconds)) return null;

  let time = minutes * 60 + seconds;
  const frac = match[3];
  if (frac !== undefined) {
    const value = Number.parseInt(frac, 10);
    if (!Number.isFinite(value)) return null;
    time += frac.length <= 2 ? value / 100 : value / 1000;
  }
  return time;
}

function parseLrcLines(lrc: string): ParsedLyricsLine[] {
  const entries: ParsedLyricsLine[] = [];
  const tagPattern = /\[([^\]]*)\]/g;

  for (const raw of lrc.split('\n')) {
    const line = raw.trim();
    if (!line) continue;

    const times: number[] = [];
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    tagPattern.lastIndex = 0;

    while ((match = tagPattern.exec(line)) !== null && match.index === lastIndex) {
      const time = parseLrcTimestamp(match[0]);
      if (time !== null) times.push(time);
      lastIndex = tagPattern.lastIndex;
    }

    const text = line.slice(lastIndex).trim();
    if (times.length === 0 || !text) continue;
    for (const time of times) entries.push({ time, text });
  }

  return entries.sort((a, b) => a.time - b.time);
}

function readLyricText(value: unknown, key: string): string {
  if (!isRecord(value)) return '';
  const section = value[key];
  if (!isRecord(section)) return '';
  return readString(section.lyric);
}

async function fetchTrackLyrics(trackId: string): Promise<TrackLyrics> {
  const url = `https://music.163.com/api/song/lyric?os=pc&id=${encodeURIComponent(trackId)}&lv=-1&kv=-1&tv=-1`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0',
      'Referer': 'https://music.163.com/',
      'Cookie': 'os=pc; appver=2.9.8;',
      ...getChinaBypassHeaders()
    }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const body: unknown = await res.json();
  return {
    trackId,
    lines: parseLrcLines(readLyricText(body, 'lrc')),
    translatedLines: parseLrcLines(readLyricText(body, 'tlyric')),
    fetchedAt: Date.now()
  };
}

function findCurrentLyricIndex(lines: ParsedLyricsLine[], playedTime: number | null): number {
  if (playedTime === null) return -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (playedTime >= lines[i].time) return i;
  }
  return -1;
}

function findTranslation(translatedLines: ParsedLyricsLine[], time: number): string {
  let closest: ParsedLyricsLine | null = null;
  let closestDelta = Number.POSITIVE_INFINITY;

  for (const line of translatedLines) {
    const delta = Math.abs(line.time - time);
    if (delta < closestDelta) {
      closest = line;
      closestDelta = delta;
    }
  }

  return closest && closestDelta <= 0.5 ? closest.text : '';
}

function buildLyricLine(trackLyrics: TrackLyrics, index: number): CurrentLyricLine | null {
  const line = trackLyrics.lines[index];
  if (!line) return null;

  return {
    index,
    time: line.time,
    text: line.text,
    translation: findTranslation(trackLyrics.translatedLines, line.time)
  };
}

function composeCurrentLyrics(snapshot: CurrentLyricsPayload, trackLyrics: TrackLyrics): CurrentLyricsPayload {
  const currentIndex = findCurrentLyricIndex(trackLyrics.lines, snapshot.playedTime);
  const current = currentIndex >= 0 ? buildLyricLine(trackLyrics, currentIndex) : null;
  const previous = currentIndex > 0 ? buildLyricLine(trackLyrics, currentIndex - 1) : null;
  const next = currentIndex >= 0 && currentIndex + 1 < trackLyrics.lines.length ? buildLyricLine(trackLyrics, currentIndex + 1) : null;
  const progress = current && next && snapshot.playedTime !== null && next.time > current.time
    ? Math.max(0, Math.min(1, (snapshot.playedTime - current.time) / (next.time - current.time)))
    : 0;

  return {
    ...snapshot,
    progress,
    current,
    previous,
    next,
    hasLyrics: trackLyrics.lines.length > 0,
    isLoading: false,
    updatedAt: Date.now()
  };
}

function setLyricsLoading(snapshot: CurrentLyricsPayload): void {
  const failedReason = failedTrackLyrics.get(snapshot.trackId);
  currentLyrics = {
    ...snapshot,
    progress: 0,
    current: null,
    previous: null,
    next: null,
    hasLyrics: false,
    isLoading: !failedReason,
    updatedAt: Date.now()
  };
}

function refreshCurrentLyricsFromCache(): void {
  if (!latestLyricsSnapshot) return;

  const trackLyrics = fetchedTrackLyrics.get(latestLyricsSnapshot.trackId);
  if (trackLyrics) {
    currentLyrics = composeCurrentLyrics(latestLyricsSnapshot, trackLyrics);
    return;
  }
  setLyricsLoading(latestLyricsSnapshot);
}

function ensureTrackLyrics(trackId: string): void {
  if (!/^\d+$/.test(trackId)) return;
  if (fetchedTrackLyrics.has(trackId) || fetchingTrackLyrics.has(trackId) || failedTrackLyrics.has(trackId)) return;

  const task = fetchTrackLyrics(trackId)
    .then((lyrics) => {
      fetchedTrackLyrics.set(trackId, lyrics);
      if (latestLyricsSnapshot?.trackId === trackId) refreshCurrentLyricsFromCache();
    })
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      failedTrackLyrics.set(trackId, message);
      writeLog(`⚠️ [歌词] 获取网易云歌词失败: ${trackId} (${message})`, 'Yellow');
      if (latestLyricsSnapshot?.trackId === trackId) refreshCurrentLyricsFromCache();
    })
    .finally(() => {
      fetchingTrackLyrics.delete(trackId);
    });

  fetchingTrackLyrics.set(trackId, task);
}

function updateCurrentLyrics(snapshot: CurrentLyricsPayload | null): void {
  latestLyricsSnapshot = snapshot;
  if (!snapshot || !snapshot.trackId) {
    currentLyrics = snapshot;
    return;
  }

  ensureTrackLyrics(snapshot.trackId);
  refreshCurrentLyricsFromCache();
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

async function connectToLiveRoom(shortRoomId: number): Promise<boolean> {
  try {
    const headers: any = { "User-Agent": "Mozilla/5.0", "Referer": `https://live.bilibili.com/${shortRoomId}` };
    if (biliCookie) headers["Cookie"] = biliCookie;

    const initRes = await fetch(`https://api.live.bilibili.com/room/v1/Room/room_init?id=${shortRoomId}`, { headers });
    const initData: any = await initRes.json();
    if (initData.code !== 0) return false;

    const realRoomId = initData.data?.room_id || shortRoomId;
    let danmuRes = await fetch(`https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo?id=${realRoomId}&type=0`, { headers });
    let danmuData: any = await danmuRes.json();

    if (JSON.stringify(danmuData).includes("-352") || danmuData.code !== 0) {
      const fallbackRes = await fetch(`https://api.live.bilibili.com/room/v1/Danmu/getConf?room_id=${realRoomId}&platform=pc&player=web`, { headers });
      danmuData = await fallbackRes.json();
    }

    const token = danmuData.data?.token || "";
    let finalBuvid = "999E9060-EA3F-0F79-7BDC-A14879D11DCB95434infoc";
    const b3Match = biliCookie.match(/buvid3=([^;]+)/);
    if (b3Match) finalBuvid = b3Match[1];

    appConfig.roomId = shortRoomId;
    saveConfig();

    startBiliWebSocket({ uid: biliUid || 0, roomid: realRoomId, protover: 3, buvid: finalBuvid, support_ack: true, type: 2, key: token });
    return true;
  } catch { return false; }
}

function startBiliWebSocket(authObj: any) {
  if (currentBiliWs) { try { currentBiliWs.close(); } catch {} }
  if (biliPingTimer) clearInterval(biliPingTimer);

  const WebSocketClient = getWebSocketClient();
  if (!WebSocketClient) return;

  const isNodeWs = typeof WebSocketClient.prototype?.on === 'function';
  const wsOptions = isNodeWs ? { headers: { "User-Agent": "Mozilla/5.0" } } : undefined;

  const ws = new WebSocketClient("wss://broadcastlv.chat.bilibili.com/sub", wsOptions);
  currentBiliWs = ws;

  const onOpen = () => {
    writeLog("✅ 直播间已连接，弹幕监控启动！", 'Green');
    const authPayload = Buffer.from(JSON.stringify(authObj), 'utf-8');
    const packet = Buffer.alloc(16 + authPayload.length);
    packet.writeInt32BE(packet.length, 0); packet.writeInt16BE(16, 4); packet.writeInt16BE(1, 6); packet.writeInt32BE(7, 8); packet.writeInt32BE(1, 12);
    authPayload.copy(packet, 16); ws.send(packet);

    biliPingTimer = setInterval(() => {
      if (ws.readyState === 1) {
        const hb = Buffer.alloc(31);
        hb.writeInt32BE(hb.length, 0); hb.writeInt16BE(16, 4); hb.writeInt16BE(1, 6); hb.writeInt32BE(2, 8); hb.writeInt32BE(1, 12);
        Buffer.from("[object Object]", "utf-8").copy(hb, 16); ws.send(hb);
      }
    }, 30000);
  };

  const onMessage = async (data: any) => {
    let buffer: Buffer;
    if (Buffer.isBuffer(data)) buffer = data;
    else if (data instanceof ArrayBuffer) buffer = Buffer.from(data);
    else if (typeof Blob !== 'undefined' && data instanceof Blob) buffer = Buffer.from(await data.arrayBuffer());
    else buffer = Buffer.from(data);
    parseBiliPacket(buffer);
  };

  const onClose = () => { setTimeout(() => { if (currentBiliWs === ws) startBiliWebSocket(authObj); }, 5000); };

  if (typeof ws.on === 'function') { ws.on('open', onOpen); ws.on('message', onMessage); ws.on('close', onClose); ws.on('error', () => {}); }
  else { ws.onopen = onOpen; ws.onmessage = (e: any) => onMessage(e.data); ws.onclose = onClose; ws.onerror = () => {}; }
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

function handleRawDanmaku(doc: any) {
  const cmd = doc.cmd || "";
  if (cmd.startsWith("DANMU_MSG")) {
    if (appConfig.sysConfig?.ShowAllDanmaku) writeLog(`[RAW原始数据] ${JSON.stringify(doc)}`, 'DarkGray');
    const info = doc.info;
    const msg = info[1].trim();
    const userBase = info[2];
    const rawUid = typeof userBase[0] === 'number' ? userBase[0].toString() : String(userBase[0]).replace(/"/g, '');
    const uname = userBase[1];
    const isManager = userBase[2] === 1;
    const medalLevel = info[3]?.[0] || 0;
    const guardLevel = info[7] ? parseInt(info[7]) : 0;

    let avatarUrl = '';
    try { if (info[0][15]?.user?.base?.face) avatarUrl = info[0][15].user.base.face; } catch {}
    handleDanmaku({ uid: rawUid, name: uname, uname, avatar: avatarUrl, isManager, medalLevel, guardLevel }, msg);
  }
}

// ==========================================
// 播放器状态核心同步逻辑 (NCM/Folia 共享)
// ==========================================
function syncTrackChangeLogic(currId: string, currName: string, nextId: string | null, nextName: string) {
  writeLog(`[状态同步] 🎵 播放器切歌信号: ${currName} (${currId}) | 下一首预告: ${nextName}`, 'Magenta');
  let stateChanged = false;

  if (!isPlaying) {
    if (targetQueue.length > 0 && currId === targetQueue[0]?.Id) {
      writeLog(`[状态同步] 处于暂停状态，自动跳过待播曲目以防消耗: ${targetQueue[0]?.SongName}`, 'Yellow');
      playNextSong();
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
        currentPlayingSong = targetQueue.shift();
        stateChanged = true;
      } else if (targetQueue.length > 0) {
        if (checkSkipForce && targetQueue[0]?.Id === currentPlayingSong?.Id) {
          writeLog(`[状态同步] 退回操作触发: 放行原生曲目，点播曲延后: ${targetQueue[0]?.SongName}`, 'DarkGray');
          insertNextSongViaCDP(targetQueue[0]?.Id);
          currentPlayingSong = null;
          stateChanged = true;
        } else {
          writeLog(`[状态同步] 捕捉到切歌信号！强制拉起待播列表首曲: ${targetQueue[0]?.SongName}`, 'Magenta');
          forcePlaySongAsync(targetQueue[0]);
          currentPlayingSong = targetQueue.shift();
          stateChanged = true;
        }
      } else {
        writeLog(`[状态同步] 点播列表已空，放行原歌单曲目`, 'DarkGray');
        currentPlayingSong = null;
        stateChanged = true;
      }
    } else if (!currentPlayingSong && targetQueue.length > 0) {
      if (currId === targetQueue[0]?.Id) {
        currentPlayingSong = targetQueue.shift();
        stateChanged = true;
      } else {
        if (appConfig.sysConfig?.IdleWaitNext === false) {
          writeLog(`[状态同步] 捕捉到切歌信号！强制拉起待播列表首曲: ${targetQueue[0]?.SongName}`, 'Magenta');
          forcePlaySongAsync(targetQueue[0]);
          currentPlayingSong = targetQueue.shift();
          stateChanged = true;
        } else {
          writeLog(`[状态同步] 当前空闲且未匹配，为队首曲目重注下一首: ${targetQueue[0]?.SongName}`, 'DarkGray');
          insertNextSongViaCDP(targetQueue[0]?.Id);
        }
      }
    }

    if (stateChanged) setGlobalStatus(currentPlayingSong ? `[播放] ${currentPlayingSong?.SongName}` : '点歌就绪');

    if (appConfig.sysConfig?.PlayerType !== 'Folia' && isPlaying && targetQueue.length > 0 && currentPlayingSong && currId === currentPlayingSong?.Id) {
      if (String(nextId) !== String(targetQueue[0]?.Id)) {
        writeLog(`[保底纠正] 播放器下一首(${nextName})与点歌队列不符，立刻重新插入!`, 'Yellow');
        insertNextSongViaCDP(targetQueue[0]?.Id);
      }
    }
  }
}

const FOLIA_HTTP_PORT = 32107;

let isFoliaHandlingAction = false;

async function playNextSong(): Promise<boolean> {
  if (appConfig.sysConfig?.PlayerType === 'Folia') {
    if (isFoliaHandlingAction) {
      writeLog(`[防抖] 当前 Folia 正在执行强控连招，已忽略本次顺延切歌请求...`, 'Yellow');
      return false;
    }

    const token = appConfig.sysConfig?.FoliaToken?.trim();
    if (!token) return false;

    isFoliaHandlingAction = true;
    try {
      writeLog(`[切歌] 正在向 Folia 发送 next 控制指令...`, 'Cyan');
      const res = await fetch(`http://127.0.0.1:${FOLIA_HTTP_PORT}/stage/player/control`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'next' })
      });

      if (!res.ok) {
        writeLog(`[切歌] Folia 拒绝执行 next (状态码: ${res.status})，执行强力回退干预...`, 'Yellow');
        if (targetQueue.length > 0) {
          const nextSong = targetQueue.shift();
          if (nextSong) {
            writeLog(`[切歌] 强行拉起待播队列首曲: ${nextSong.SongName}`, 'Magenta');
            isFoliaHandlingAction = false;
            await forcePlaySongAsync(nextSong);
          }
        } else {
          await fetch(`http://127.0.0.1:${FOLIA_HTTP_PORT}/stage/player/control`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'pause' })
          });
          currentPlayingSong = null;
          setGlobalStatus('点歌就绪');
        }
      } else {
        writeLog(`[切歌] Folia next 指令成功接收`, 'Green');
      }
      return true;
    } catch (err: any) {
      writeLog(`[切歌] Folia 通信异常: ${err.message}`, 'Red');
      return false;
    } finally {
      isFoliaHandlingAction = false;
    }
  } else {
    return await sendCDPCommand(FiberStoreExtractJs + `;if(_ensureStore()){window._reduxStore.dispatch({type:'async:action/doAction',payload:{actionId:'playNext',data:{eventType:'click'}}});}`);
  }
}

async function insertNextSongViaCDP(songId: string) {
  if (!songId) return;
  if (appConfig.sysConfig?.PlayerType === 'Folia') {
    const token = appConfig.sysConfig?.FoliaToken?.trim();
    if (!token) return;
    try {
      const res = await fetch(`http://127.0.0.1:${FOLIA_HTTP_PORT}/stage/player/queue`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'insert-next', songId: Number(songId) })
      });
      if (res.ok) {
        const data = await res.json();
        writeLog(`✅ Folia 插队指令发送成功 (改变队列: ${data.changed}, 拦截去重: ${data.deduplicated})`, 'DarkGray');
      } else {
        writeLog(`❌ Folia 拒绝插队请求 (状态码: ${res.status})`, 'Red');
      }
    } catch(e: any) {
      writeLog(`❌ Folia 插队网络异常: ${e.message}`, 'Red');
    }
    return;
  }
  const script = FiberStoreExtractJs + `;if (_ensureStore()) { window._reduxStore.dispatch({ type: 'async:action/doAction', payload: { actionId: 'addToPlayList', data: { resource: { id: String(${songId}), duration: 0 }, resourceType: 'track', eventType: 'click' } } }); }`;
  await sendCDPCommand(script);
}

async function forcePlaySongAsync(songInfo: any) {
  if (!songInfo) return;

  if (appConfig.sysConfig?.PlayerType === 'Folia') {
    if (isFoliaHandlingAction) {
      writeLog(`[防抖] Folia 正在处理上一首的切歌连招，暂不接受新的强制播放: ${songInfo.SongName}。已将其退回队列首位等待自然衔接！`, 'Yellow');
      targetQueue.unshift(songInfo);
      return;
    }

    isFoliaHandlingAction = true;

    currentPlayingSong = songInfo;
    lastTrackId = songInfo.Id;

    const token = appConfig.sysConfig?.FoliaToken?.trim();
    if (!token) {
      isFoliaHandlingAction = false;
      return;
    }

    try {
      // 1. 无延迟无暂停，直接将歌曲插入到下一首
      const insertRes = await fetch(`http://127.0.0.1:${FOLIA_HTTP_PORT}/stage/player/queue`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'insert-next', songId: Number(songInfo.Id) })
      });

      if (!insertRes.ok) {
        writeLog(`❌ Folia 拒绝强制播放插队 (状态码: ${insertRes.status})`, 'Red');
      }

      // 2. 无延迟直接发送下一首控制指令
      await fetch(`http://127.0.0.1:${FOLIA_HTTP_PORT}/stage/player/control`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'next' })
      });

      // 3. 将后续的点歌继续预先注入
      if (isPlaying && targetQueue.length > 0 && targetQueue[0]?.Id) {
        writeLog(`[预加载] 强切连招完毕，自动将待播队列第一首(${targetQueue[0].SongName})插入下一首...`, 'Cyan');
        setTimeout(() => insertNextSongViaCDP(targetQueue[0].Id), 1500);
      }
    } catch (e: any) {
      writeLog(`❌ Folia 强制播放控制异常: ${e.message}`, 'Red');
    } finally {
      isFoliaHandlingAction = false;
    }
    return;
  }

  currentPlayingSong = songInfo;
  lastTrackId = songInfo.Id;

  const script = FiberStoreExtractJs + `;if (_ensureStore()) { window._reduxStore.dispatch({ type: 'async:action/doAction', payload: { actionId: 'play', data: { resource: { id: String(${songInfo.Id}) }, resourceType: 'track', eventType: 'dblclick' } } }); }`;
  await sendCDPCommand(script);
  if (isPlaying && targetQueue.length > 0 && targetQueue[0]?.Id) setTimeout(() => insertNextSongViaCDP(targetQueue[0].Id), 1500);
}

// ==========================================
// ⭐ Folia 官方 WebSocket 原生状态监听
// ==========================================
let foliaWs: any = null;
let foliaWsReconnectTimer: NodeJS.Timeout | null = null;
let foliaWsIntentionalClose = false;

async function startFoliaRadar() {
  if (foliaWs) {
    foliaWsIntentionalClose = true;
    try { foliaWs.close(); } catch {}
    foliaWs = null;
  }
  foliaWsIntentionalClose = false;

  if (foliaWsReconnectTimer) {
    clearTimeout(foliaWsReconnectTimer);
    foliaWsReconnectTimer = null;
  }

  if (appConfig.sysConfig?.PlayerType !== 'Folia') return;

  const token = appConfig.sysConfig?.FoliaToken?.trim();
  if (!token) {
    writeLog('⚠️ Folia Stage Token 未配置，WebSocket 雷达无法连接', 'Yellow');
    isCdpConnected = false;
    return;
  }

  writeLog(`>>> [系统] 正在连接 Folia 官方 WebSocket (端口固定: ${FOLIA_HTTP_PORT})...`, 'Cyan');

  const WebSocketClient = getWebSocketClient();
  if (!WebSocketClient) return;

  const wsUrl = `ws://127.0.0.1:${FOLIA_HTTP_PORT}/stage/player/ws?token=${encodeURIComponent(token)}`;
  const ws = new WebSocketClient(wsUrl);
  foliaWs = ws;
  foliaWsIntentionalClose = false;

  setupWsListeners(ws, {
    onOpen: () => {
      writeLog('✅ [雷达] 成功连接至 Folia 官方 WebSocket!', 'Green');
      isCdpConnected = true;
      setGlobalStatus('点歌就绪');
    },
    onMessage: (data: any) => {
      try {
        const payload = JSON.parse(typeof data === 'string' ? data : data.toString());
        const eventName = payload.event || payload.type;

        if (eventName === 'STATUS' || eventName === 'TRACK_CHANGED') {
          const track = payload.track || payload.current || payload.data?.track || (payload.id || payload.songId ? payload : null);
          const currentId = track?.id || track?.songId ? String(track.id || track.songId) : null;
          const songName = track?.title || track?.name || '未知曲目';

          if (currentId && currentId !== lastTrackId) {
            syncTrackChangeLogic(currentId, songName, null, '未知');
            lastTrackId = currentId;
          } else if (!currentId && lastTrackId && eventName === 'TRACK_CHANGED') {
            syncTrackChangeLogic('', '播放已停止', null, '无');
            lastTrackId = null;
          }
        }
      } catch (e) {}
    },
    onClose: () => {
      if (ws !== foliaWs) return;
      isCdpConnected = false;
      if (!foliaWsIntentionalClose) {
        writeLog('⚠️ [雷达] Folia WebSocket 意外断开，3秒后重连...', 'Yellow');
        if (appConfig.sysConfig?.PlayerType === 'Folia') {
          foliaWsReconnectTimer = setTimeout(startFoliaRadar, 3000);
        }
      }
    },
    onError: (err: any) => {
      if (ws !== foliaWs) return;
      if (!foliaWsIntentionalClose) {
        writeLog(`❌ [雷达] Folia WebSocket 错误: ${err?.message}`, 'Red');
      }
      isCdpConnected = false;
    }
  });
}

// ==========================================
// ⭐ 注册表深度寻轨定位器 (Windows 专享)
// ==========================================
function getCloudMusicPathFromRegistry(): Promise<string> {
  const regKeys = [
    'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\网易云音乐',
    'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\网易云音乐'
  ];

  return new Promise((resolve, reject) => {
    if (process.platform !== 'win32') {
      return reject(new Error('非 Windows 系统，跳过注册表寻轨'));
    }

    let index = 0;

    function tryNextKey() {
      if (index >= regKeys.length) {
        return reject(new Error('遍历了所有预设的注册表节点，未检测到网易云音乐安装信息'));
      }

      const currentKey = regKeys[index];
      writeLog(`[注册表DEBUG] 🔍 正在检索注册表节点: ${currentKey}`, 'DarkGray');
      const command = `reg query "${currentKey}" /v DisplayIcon`;

      exec(command, (error, stdout) => {
        if (error) {
          writeLog(`[注册表DEBUG] 📭 该节点下未查询到 DisplayIcon 项 (代码: ${error.code})`, 'DarkGray');
          index++;
          tryNextKey();
        } else {
          writeLog(`[注册表DEBUG] 📬 命中注册表项！正在解析原始字符串数据...`, 'Cyan');
          const lines = stdout.split('\n');
          for (let line of lines) {
            if (line.includes('DisplayIcon')) {
              // 按照 2 个或更多的空白字符对“键-类型-值”进行高精度切分
              const parts = line.trim().split(/\s{2,}/);
              if (parts.length >= 3) {
                let execPath = parts[2].trim();
                writeLog(`[注册表DEBUG] 🧬 提取到原始物理地址: ${execPath}`, 'DarkGray');

                // 深度清洗：剔除路径两侧可能包裹的双引号
                if (execPath.startsWith('"') && execPath.endsWith('"')) {
                  execPath = execPath.slice(1, -1);
                }

                // 深度清洗：剔除 Windows 注册表可能自带的图标索引后缀（如 C:\Netease\cloudmusic.exe,0）
                if (execPath.includes(',')) {
                  execPath = execPath.split(',')[0].trim();
                  writeLog(`[注册表DEBUG] 🧹 剔除图标索引后缀，清洗后执行路径为: ${execPath}`, 'DarkGray');
                }

                return resolve(execPath);
              }
            }
          }
          writeLog(`[注册表DEBUG] ⚠️ 该注册表节点虽然存在，但内部数据格式异常，无法解析出 DisplayIcon。`, 'Yellow');
          index++;
          tryNextKey();
        }
      });
    }

    tryNextKey();
  });
}

// ==========================================
// 网易云音乐 CDP 注入接管及自动寻路
// ==========================================
async function restartNCMWithDebugPort() {
  if (appConfig.sysConfig?.PlayerType === 'Folia') {
    writeLog('>>> [系统] 已切换至 Folia 模式，准备连接官方 WebSocket...', 'Cyan');
    isCdpConnected = false;
    setTimeout(startFoliaRadar, 1500);
    return;
  }

  let exePath = appConfig.sysConfig?.NcmExePath || '';
  isCdpConnected = false;

  // ⭐ 新增：如果本地没有保存任何网易云路径或路径被清除（即首次打开/未保存配置）
  if (!exePath) {
    writeLog(">>> [系统] 本地配置文件中未检测到网易云路径，启动自动寻轨机制...", "Cyan");
    try {
      const regPath = await getCloudMusicPathFromRegistry();
      if (regPath && fs.existsSync(regPath)) {
        exePath = regPath;
        if (!appConfig.sysConfig) appConfig.sysConfig = {};
        appConfig.sysConfig.NcmExePath = exePath;
        saveConfig();
        writeLog(`>>> [系统] 注册表寻路成功，已将网易云路径保存至本地配置: ${exePath}`, "Green");
      } else {
        writeLog(`⚠️ [系统] 注册表解析完成，但检测到该物理地址在硬盘上不存在: ${regPath}`, "Yellow");
      }
    } catch (regErr: any) {
      writeLog(`⚠️ [系统] 自动检索注册表失败: ${regErr.message}`, "Yellow");
    }
  }

  // 尝试获取当前正在后台静默运行的网易云路径进行备份与热更新
  let runningPath = '';
  try {
    const psCmd = `powershell -NoProfile -Command "$p=(Get-Process cloudmusic -ErrorAction SilentlyContinue | Select-Object -First 1).Path; if($p){[Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($p))}"`;
    const { stdout } = await execAsync(psCmd);
    const b64 = stdout.trim();
    if (b64) runningPath = Buffer.from(b64, 'base64').toString('utf8');
  } catch {}

  // 如果提取到了正在运行中的程序路径，且与已有配置不同，自动同步保存
  if (runningPath) {
    writeLog(`>>> [系统] 检测到当前正有运行中的网易云进程: ${runningPath}`, 'DarkGray');
    if (runningPath !== exePath) {
      exePath = runningPath;
      if (!appConfig.sysConfig) appConfig.sysConfig = {};
      appConfig.sysConfig.NcmExePath = exePath;
      saveConfig();
      writeLog(`>>> [系统] 运行状态与本地记录不一致，已将其自动修正并保存为: ${exePath}`, 'Green');
    }
  }

  try {
    await execAsync('taskkill /f /im cloudmusic.exe');
    writeLog('>>> [系统] 已强制杀掉当前网易云进程，准备进行调试端口热重启...', 'DarkGray');
  } catch {}

  await new Promise(resolve => setTimeout(resolve, 2000));
  const cdpPort = appConfig.sysConfig?.CdpPort || 9222;

  if (exePath && fs.existsSync(exePath)) {
    writeLog(`>>> [系统] 🚀 正在唤醒网易云音乐并注入调试端口 (${cdpPort})！物理路径: ${exePath}`, 'Green');
    try {
      const cwd = path.dirname(exePath);
      const ncmProcess = spawn(exePath, [`--remote-debugging-port=${cdpPort}`], { cwd, detached: true, stdio: 'ignore' });
      ncmProcess.unref();
    } catch (err: any) {
      writeLog(`❌ [错误] 启动网易云失败: ${err?.message || err}`, 'Red');
    }
  } else {
    writeLog('⚠️ [提示] 找不到网易云音乐安装路径，请检查注册表或手动启动客户端！', 'Yellow');
  }

  setTimeout(startCDPRadar, 2500);
}

const FiberStoreExtractJs = `
  function _ensureStore() {
    if (!window.__debug_store_log) window.__debug_store_log = [];
    try {
        if (window._reduxStore) return true;
        const rootEl = document.querySelector('#root');
        window.__debug_store_log.push('获取 #root: ' + !!rootEl);
        const root = window._fiberRoot || (rootEl && rootEl._reactRootContainer && rootEl._reactRootContainer._internalRoot);
        window.__debug_store_log.push('获取 FiberRoot: ' + !!root);
        if (!root) return false;
        let queue = [root.current || root];
        let visited = 0;
        while (queue.length > 0) {
          let node = queue.shift();
          if (!node) continue;
          visited++;
          if (visited > 20000) break;
          if (node.memoizedProps && node.memoizedProps.store) { window._reduxStore = node.memoizedProps.store; window.__debug_store_log.push('找到 Store (memoizedProps)'); return true; }
          if (node.stateNode && node.stateNode.store) { window._reduxStore = node.stateNode.store; window.__debug_store_log.push('找到 Store (stateNode)'); return true; }
          let child = node.child;
          while (child) { queue.push(child); child = child.sibling; }
        }
        window.__debug_store_log.push('寻找失败，遍历节点数: ' + visited);
        return false;
    } catch(err) {
        window.__debug_store_log.push('Store提取报错: ' + err.message);
        return false;
    }
  }
`;

function getWebSocketClient() {
  try { return require('ws'); } catch {
    if ((global as any).WebSocket) return (global as any).WebSocket;
    return null;
  }
}

function setupWsListeners(ws: any, handlers: { onOpen?: () => void, onMessage?: (data: any) => void, onError?: (err?: any) => void, onClose?: () => void }) {
  const isNative = typeof ws.on !== 'function';
  if (handlers.onOpen) { if (isNative) ws.onopen = handlers.onOpen; else ws.on('open', handlers.onOpen); }
  if (handlers.onMessage) { if (isNative) ws.onmessage = (e: any) => handlers.onMessage!(e.data); else ws.on('message', handlers.onMessage); }
  if (handlers.onError) { if (isNative) ws.onerror = (e: any) => handlers.onError!(e); else ws.on('error', handlers.onError); }
  if (handlers.onClose) { if (isNative) ws.onclose = handlers.onClose; else ws.on('close', handlers.onClose); }
}

async function sendCDPCommand(script: string): Promise<boolean> {
  try {
    const cdpPort = appConfig.sysConfig?.CdpPort || 9222;
    const res = await fetch(`http://127.0.0.1:${cdpPort}/json`);
    if (!res.ok) return false;
    const targets: any[] = await res.json();
    let wsUrl = targets.find(t => t.type === 'page' && (t.url.includes('orpheus') || t.url.includes('music.163.com')))?.webSocketDebuggerUrl
        || targets.find(t => t.type === 'page')?.webSocketDebuggerUrl;

    if (!wsUrl) return false;

    return new Promise((resolve) => {
      const WebSocketClient = getWebSocketClient();
      if (!WebSocketClient) return resolve(false);
      const ws = new WebSocketClient(wsUrl);
      let isResolved = false;

      setupWsListeners(ws, {
        onOpen: () => { ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: script, returnByValue: true, awaitPromise: true } })); },
        onMessage: (data: any) => { const parsed = JSON.parse(typeof data === 'string' ? data : data.toString()); if (parsed.id === 1) { isResolved = true; ws.close(); resolve(true); } },
        onError: () => { if (!isResolved) resolve(false); }
      });
      setTimeout(() => { if (!isResolved) { ws.close(); resolve(false); } }, 3000);
    });
  } catch { return false; }
}

async function startCDPRadar() {
  if (appConfig.sysConfig?.PlayerType === 'Folia') return;

  try {
    const cdpPort = appConfig.sysConfig?.CdpPort || 9222;
    const res = await fetch(`http://127.0.0.1:${cdpPort}/json`);
    const targets: any[] = await res.json();
    let wsUrl = targets.find(t => t.type === 'page' && (t.url.includes('orpheus') || t.url.includes('music.163.com')))?.webSocketDebuggerUrl
        || targets.find(t => t.type === 'page')?.webSocketDebuggerUrl;

    if (!wsUrl) {
      writeLog(`⏳ [雷达] 未找到网易云前端页面，1.5秒后重试...`, 'DarkGray');
      isCdpConnected = false;
      setTimeout(startCDPRadar, 1500);
      return;
    }

    const WebSocketClient = getWebSocketClient();
    if (!WebSocketClient) return;
    const ws = new WebSocketClient(wsUrl);
    let cmdId = 1;
    const send = (method: string, params: any) => { if (ws.readyState === 1) ws.send(JSON.stringify({ id: cmdId++, method, params })); };

    setupWsListeners(ws, {
      onOpen: () => {
        writeLog(`✅ [雷达] 已连入 WebSocket (${cdpPort})，正在注入 CDP 雷达脚本...`, 'Cyan');
        send('Runtime.enable', {});
        send('Runtime.addBinding', { name: '__ncmRadarCallback' });

        const radarScript = FiberStoreExtractJs + `
          ;(function initRadar() {
              const lyricsRadarVersion = 2;
              if (typeof window.__ncmRadarCallback !== 'function') { setTimeout(initRadar, 500); return; }
              window.__debug_store_log = []; 
              if (!_ensureStore()) { 
                  try { window.__ncmRadarCallback(JSON.stringify({ event: 'RADAR_INIT_RETRYING', reason: 'not_ready', debugLog: window.__debug_store_log.join(' | ') })); } catch {}
                  setTimeout(initRadar, 1500); return; 
              }
              if (window.__radarDeployed && window.__radarSubscribeAlive && window.__lyricsRadarVersion === lyricsRadarVersion && typeof window.__emitLyricsSnapshot === 'function') {
                  window.__emitLyricsSnapshot();
                  window.__ncmRadarCallback(JSON.stringify({ event: 'RADAR_ALREADY_DEPLOYED' }));
                  return;
              }
              window.__radarDeployed = true; window.__radarSubscribeAlive = true;
              window.__lyricsRadarVersion = lyricsRadarVersion;

              const extractSongInfo = (id, list) => {
                  if (!id) return null;
                  const song = list.find(item => String(item.id) === String(id));
                  if (!song) return null;
                  return { id: String(song.id), name: song.track?.name || '未知歌曲', artist: song.track?.artists?.map(a => a.name).join('/') || '未知歌手' };
              };

              const toFiniteNumber = (value) => {
                  const parsed = Number(value);
                  return Number.isFinite(parsed) ? parsed : null;
              };

              const getLineText = (line) => {
                  if (!line) return '';
                  return typeof line.lyric === 'string' ? line.lyric : '';
              };

              const getArtistName = (playing) => {
                  const artists = playing.curTrack?.artists || playing.resourceArtists || [];
                  if (Array.isArray(artists) && artists.length > 0) {
                      return artists.map(item => item?.name).filter(Boolean).join('/');
                  }
                  return '';
              };

              const normalizeLyricLine = (line, translationLine, index) => {
                  if (!line) return null;
                  const time = toFiniteNumber(line.time);
                  return { index, time: time ?? 0, text: getLineText(line), translation: getLineText(translationLine) };
              };

              const getPlayedTime = (playId) => new Promise((resolve) => {
                  if (!window.channel || typeof window.channel.call !== 'function') {
                      resolve(null);
                      return;
                  }

                  let finished = false;
                  const finish = (value) => {
                      if (finished) return;
                      finished = true;
                      resolve(value || null);
                  };

                  try {
                      window.channel.call('audioplayer.getPlayedTime', finish, playId ? [{ playId }] : []);
                      setTimeout(() => finish(null), 700);
                  } catch {
                      finish(null);
                  }
              });

              let lyricsInFlight = false;
              let lastLyricsSignature = '';
              const emitLyricsSnapshot = async () => {
                  if (lyricsInFlight) return;
                  lyricsInFlight = true;

                  try {
                      const snapshotState = window._reduxStore.getState();
                      const playing = snapshotState.playing || {};
                      const lyricState = snapshotState['async:lyric'] || {};
                      const lines = Array.isArray(lyricState.lyricLines) ? lyricState.lyricLines : [];
                      const translatedLines = Array.isArray(lyricState.tlyricLines) ? lyricState.tlyricLines : [];
                      const trackId = String(playing.resourceTrackId || playing.onlineResourceId || playing.playId || '');
                      const playId = playing.playId || trackId;
                      const playedResult = await getPlayedTime(playId);
                      const playedTime = toFiniteNumber(playedResult && (playedResult.playedTime ?? playedResult.playedAudioTime));
                      const adjustedTime = playedTime === null ? null : playedTime + (toFiniteNumber(lyricState.offset) || 0);

                      let currentIndex = -1;
                      if (adjustedTime !== null) {
                          for (let i = lines.length - 1; i >= 0; i--) {
                              const lineTime = toFiniteNumber(lines[i]?.time);
                              if (lineTime !== null && adjustedTime >= lineTime) {
                                  currentIndex = i;
                                  break;
                              }
                          }
                      }

                      if (currentIndex < 0) {
                          const fallbackIndex = toFiniteNumber(playing.playingLyricLineNumber);
                          if (fallbackIndex !== null && fallbackIndex >= 0 && fallbackIndex < lines.length) {
                              currentIndex = Math.floor(fallbackIndex);
                          }
                      }

                      const current = currentIndex >= 0 ? normalizeLyricLine(lines[currentIndex], translatedLines[currentIndex], currentIndex) : null;
                      const previous = currentIndex > 0 ? normalizeLyricLine(lines[currentIndex - 1], translatedLines[currentIndex - 1], currentIndex - 1) : null;
                      const next = currentIndex >= 0 && currentIndex + 1 < lines.length ? normalizeLyricLine(lines[currentIndex + 1], translatedLines[currentIndex + 1], currentIndex + 1) : null;
                      const progress = current && next && adjustedTime !== null && next.time > current.time
                          ? Math.max(0, Math.min(1, (adjustedTime - current.time) / (next.time - current.time)))
                          : 0;
                      const rawDuration = toFiniteNumber(playing.curTrack?.duration) || toFiniteNumber(playing.resourceDuration);
                      const duration = rawDuration === null ? null : rawDuration > 10000 ? rawDuration / 1000 : rawDuration;

                      const lyrics = {
                          trackId,
                          songName: playing.curTrack?.name || playing.resourceName || '',
                          artistName: getArtistName(playing),
                          playedTime,
                          duration,
                          progress,
                          current,
                          previous,
                          next,
                          hasLyrics: lines.length > 0,
                          isLoading: lines.length === 0 && Boolean(trackId),
                          updatedAt: Date.now()
                      };

                      const timeBucket = playedTime === null ? 'x' : String(Math.floor(playedTime * 2) / 2);
                      const signature = [trackId, currentIndex, current?.text || '', timeBucket, lines.length].join('|');
                      if (signature === lastLyricsSignature) return;
                      lastLyricsSignature = signature;
                      try { window.__ncmRadarCallback(JSON.stringify({ event: 'LYRICS_UPDATE', lyrics })); } catch {}
                  } catch {
                  } finally {
                      lyricsInFlight = false;
                  }
              };

              let state = window._reduxStore.getState();
              let localLastId = state.playing?.resourceTrackId || state.playing?.onlineResourceId;

              window.__emitLyricsSnapshot = emitLyricsSnapshot;
              if (window.__lyricsRadarTimer) clearInterval(window.__lyricsRadarTimer);
              window.__lyricsRadarTimer = setInterval(() => { window.__emitLyricsSnapshot(); }, 700);
              window.__ncmRadarCallback(JSON.stringify({ event: 'RADAR_INIT_OK', currentId: localLastId ? String(localLastId) : null }));
              window.__emitLyricsSnapshot();

              window._reduxStore.subscribe(() => {
                  try {
                      state = window._reduxStore.getState();
                      const currentTrackId = state.playing?.resourceTrackId || state.playing?.onlineResourceId;
                      const curList = state.playingList?.curPlayingList || [];

                      if (currentTrackId && currentTrackId !== localLastId) {
                          const prevSong = extractSongInfo(localLastId, curList);
                          const currentIndex = curList.findIndex(item => String(item.id) === String(currentTrackId));
                          let currSong = null; let nextSong = null;
                          if (currentIndex !== -1) {
                              currSong = extractSongInfo(currentTrackId, curList);
                              if (currentIndex + 1 < curList.length) nextSong = extractSongInfo(curList[currentIndex + 1].id, curList);
                          } else { currSong = { id: String(currentTrackId), name: '(列表外)', artist: '' }; }

                          try { window.__ncmRadarCallback(JSON.stringify({ event: 'TRACK_CHANGED', timestamp: Date.now(), previous: prevSong, current: currSong, next: nextSong })); } catch {}
                          localLastId = currentTrackId;
                      }
                      window.__emitLyricsSnapshot();
                  } catch { }
              });
          })();
        `;
        send('Runtime.evaluate', { expression: radarScript, returnByValue: true });
      },
      onMessage: (data: any) => {
        try {
          const msg = JSON.parse(typeof data === 'string' ? data : data.toString());
          if (msg.error) writeLog(`❌ [CDP 调用失败]: ${JSON.stringify(msg.error)}`, 'Red');
          if (msg.method === 'Runtime.bindingCalled' && msg.params.name === '__ncmRadarCallback') {
            const payload = JSON.parse(msg.params.payload);

            if (payload.event === 'RADAR_INIT_RETRYING') writeLog(`⏳ [挖树] 等待网易云 React 树加载...`, 'DarkGray');
            else if (payload.event === 'RADAR_INIT_OK') {
              writeLog(`✅ CDP 常驻雷达注入成功!`, 'Green');
              setGlobalStatus('点歌就绪');
              isCdpConnected = true;
            }
            else if (payload.event === 'RADAR_ALREADY_DEPLOYED') isCdpConnected = true;
            else if (payload.event === 'TRACK_CHANGED') {
              const currId = payload.current?.id;
              const currName = payload.current?.name;
              const nextId = payload.next?.id;
              const nextName = payload.next?.name || '无';

              if (currId && currId !== lastTrackId) {
                syncTrackChangeLogic(currId, currName, nextId, nextName);
                lastTrackId = currId;
              } else if (!currId && lastTrackId) {
                syncTrackChangeLogic('', '播放停止', null, '无');
                lastTrackId = null;
              }
            }
            else if (payload.event === 'LYRICS_UPDATE') {
              updateCurrentLyrics(readLyricsPayload(payload.lyrics));
            }
          }
        } catch (e: any) { writeLog(`❌ CDP 解析异常: ${e.message}`, 'Red'); }
      },
      onClose: () => {
        writeLog('⚠️ [雷达] CDP 连接断开，1.5秒后准备重连...', 'Yellow');
        setGlobalStatus('等待后端');
        isCdpConnected = false;
        setTimeout(startCDPRadar, 1500);
      },
      onError: (err: any) => {
        writeLog(`❌ [雷达] CDP WebSocket 出错: ${err?.message}`, 'Red');
        isCdpConnected = false;
      }
    });
  } catch (err: any) {
    writeLog(`⏳ [雷达] 等待网易云调试端口就绪... (${err.message})`, 'DarkGray');
    isCdpConnected = false;
    setTimeout(startCDPRadar, 1500);
  }
}

// ==========================================
// 核心功能：获取 B站 头像与用户信息
// ==========================================
async function getBiliAvatar(uid: string): Promise<string> {
  try {
    const res = await fetch(`https://api.bilibili.com/x/web-interface/card?mid=${uid}`, { headers: { "User-Agent": "Mozilla/5.0", "Referer": "https://www.bilibili.com/" } });
    const data: any = await res.json();
    if (data.code === 0 && data.data?.card?.face) return data.data.card.face;
  } catch {}
  return `https://api.dicebear.com/7.x/identicon/svg?seed=${uid}`;
}

async function updateCurrentUserInfo(): Promise<void> {
  if (!biliCookie) return;
  const headers: any = { "User-Agent": "Mozilla/5.0", "Referer": "https://www.bilibili.com/", "Cookie": biliCookie };

  try {
    const navRes = await fetch("https://api.bilibili.com/x/web-interface/nav", { headers });
    const navData: any = await navRes.json();
    if (navData.code !== 0) return;

    const d = navData.data;
    currentUserInfo.uid = Number(d.mid) || 0;
    currentUserInfo.uname = d.uname || '';
    currentUserInfo.face = d.face || '';
    currentUserInfo.level = d.level_info?.current_level ?? 0;
    biliUid = currentUserInfo.uid;
    currentUserInfo.myRoomId = 0;

    try {
      const roomRes = await fetch(`https://api.live.bilibili.com/room/v1/Room/getRoomInfoOld?mid=${currentUserInfo.uid}`, { headers });
      const roomData: any = await roomRes.json();
      if (roomData.code === 0 && Number(roomData.data?.roomid) > 0) currentUserInfo.myRoomId = Number(roomData.data.roomid);
    } catch { }

    try {
      const statRes = await fetch(`https://api.bilibili.com/x/relation/stat?vmid=${currentUserInfo.uid}`, { headers });
      const statData: any = await statRes.json();
      if (statData.code === 0 && statData.data?.follower !== undefined) currentUserInfo.followerCount = Number(statData.data.follower) || 0;
    } catch { }

    if (currentUserInfo.myRoomId > 0) {
      try {
        const guardRes = await fetch(`https://api.live.bilibili.com/xlive/app-room/v2/guardTab/topList?roomid=${currentUserInfo.myRoomId}&page=1&ruid=${currentUserInfo.uid}&page_size=1`, { headers });
        const guardData: any = await guardRes.json();
        if (guardData.code === 0 && guardData.data?.info?.num !== undefined) currentUserInfo.guardCount = Number(guardData.data.info.num) || 0;
      } catch { }

      try {
        const clubRes = await fetch(`https://api.live.bilibili.com/live_user/v1/Club/get_club_info?uid=${currentUserInfo.uid}`, { headers });
        const clubData: any = await clubRes.json();
        if (clubData.code === 0 && clubData.data && !Array.isArray(clubData.data) && clubData.data.fans_num !== undefined) currentUserInfo.fanClubCount = Number(clubData.data.fans_num) || 0;
      } catch { }
    }

    if (currentUserInfo.myRoomId > 0) {
      appConfig.myRoomId = currentUserInfo.myRoomId;
      if (!appConfig.roomId) {
        appConfig.roomId = currentUserInfo.myRoomId;
        writeLog(`>>> [账号] 检测到本账号直播间 ${currentUserInfo.myRoomId}，已自动设为监控房间。`, 'Cyan');
      }
    }
    saveConfig();
  } catch (err: any) { writeLog(`[系统] 获取用户信息失败: ${err.message}`, 'Yellow'); }
}

// ==========================================
// B站弹幕点歌逻辑处理
// ==========================================
async function tryRequestSong(user: any, keyword: string, mode: 'normal' | 'top' | 'interrupt' | 'play_now' = 'normal') {
  try {
    const normalizedKeyword = keyword.replace(/\s+/g, '');
    if (normalizedKeyword === '贞理的小曲' || normalizedKeyword === '真理的小曲') keyword = 'missing you 具岛直子';

    let playSongId = '';
    let displaySong: any = null;

    // 正则表达式匹配 id=
    const idMatch = keyword.match(/^id\s*=\s*(\d+)/i);

    if (appConfig.sysConfig?.PlayerType === 'Folia') {
      const token = appConfig.sysConfig?.FoliaToken?.trim();

      if (idMatch) {
        // ⭐ 命中 Folia ID 点歌：通过公开 API 获取歌曲名称及歌手（注入 IP 绕过）
        const songId = idMatch[1];
        playSongId = songId;
        displaySong = { name: `ID点歌: ${songId}`, artist: '未知歌手' };
        try {
          const res = await fetch(`https://music.163.com/api/song/detail/?id=${songId}&ids=%5B${songId}%5D`, {
            method: 'GET',
            headers: {
              'User-Agent': 'Mozilla/5.0',
              'Cookie': 'os=pc; appver=2.9.8;',
              ...getChinaBypassHeaders() // ⭐ 注入国内 IP
            }
          });
          if (res.ok) {
            const data = await res.json().catch(() => null);
            const songs = data?.songs || [];
            if (songs.length > 0) {
              displaySong = { name: songs[0].name, artist: songs[0].artists?.map((a: any) => a.name).join('/') || songs[0].ar?.map((a: any) => a.name).join('/') || '未知歌手' };
            }
          }
        } catch { /* 忽略网络异常，保留兜底数据 */ }
      } else {
        // 命中 Folia 歌名点歌：使用 Folia 官方 Search 接口
        const searchRes = await fetch(`http://127.0.0.1:${FOLIA_HTTP_PORT}/stage/player/search`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: keyword, limit: 1 })
        });
        if (!searchRes.ok) throw new Error(`HTTP ${searchRes.status}`);
        const searchData = await searchRes.json();
        const foliaSongs = searchData.songs || [];

        if (foliaSongs.length > 0) {
          const fsong = foliaSongs[0];
          playSongId = String(fsong.songId || fsong.id);

          let artistStr = '未知歌手';
          if (Array.isArray(fsong.artists)) {
            artistStr = fsong.artists.map((a: any) => typeof a === 'string' ? a : a.name).join('/');
          } else if (fsong.artist) {
            artistStr = fsong.artist;
          }

          displaySong = {
            name: fsong.title || fsong.name || keyword,
            artist: artistStr
          };
        }
      }
    } else {
      // 原有网易云点歌逻辑：带国内 IP 伪装注入
      if (idMatch) {
        const songId = idMatch[1];
        const res = await fetch(`https://music.163.com/api/song/detail/?id=${songId}&ids=%5B${songId}%5D`, {
          method: 'GET',
          headers: {
            'User-Agent': 'Mozilla/5.0',
            'Cookie': 'os=pc; appver=2.9.8;',
            ...getChinaBypassHeaders() // ⭐ 注入国内 IP
          }
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const songs = (await res.json()).songs || [];
        if (songs.length > 0) {
          playSongId = String(songs[0].id);
          displaySong = { name: songs[0].name, artist: songs[0].artists?.map((a: any) => a.name).join('/') || songs[0].ar?.map((a: any) => a.name).join('/') || '未知歌手' };
        }
      } else {
        const res = await fetch(`https://music.163.com/api/search/get/web`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': 'Mozilla/5.0',
            'Cookie': 'os=pc; appver=2.9.8;',
            ...getChinaBypassHeaders() // ⭐ 注入国内 IP
          },
          body: `s=${encodeURIComponent(keyword)}&type=1&limit=1`
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const songs = (await res.json()).result?.songs || [];
        if (songs.length > 0) {
          playSongId = String(songs[0].id);
          displaySong = { name: songs[0].name, artist: songs[0].artists?.map((a: any) => a.name).join('/') || songs[0].ar?.map((a: any) => a.name).join('/') || '未知歌手' };
        }
      }
    }

    if (playSongId && displaySong) {
      const avatarUrl = user.avatar || await getBiliAvatar(user.uid);
      const newSong = { Id: playSongId, SongName: displaySong.name, ArtistName: displaySong.artist, OrderedBy: user.name || user.uname, OrderedByUid: user.uid, OrderedByAvatar: avatarUrl, GuardLevel: user.guardLevel };

      if (mode === 'interrupt') {
        if (currentPlayingSong) targetQueue.unshift(currentPlayingSong);
        setGlobalStatus(`⚡ 插队: ${newSong.SongName}`); forcePlaySongAsync(newSong);
      }
      else if (mode === 'play_now') {
        setGlobalStatus(`▶️ 立即: ${newSong.SongName}`); forcePlaySongAsync(newSong);
      }
      else if (mode === 'top') {
        targetQueue.unshift(newSong); setGlobalStatus(`⬆️ 置顶: ${newSong.SongName}`);
        if (targetQueue.length === 1 && !currentPlayingSong && isPlaying) {
          if (appConfig.sysConfig?.IdleWaitNext === false) forcePlaySongAsync(targetQueue.shift());
          else await insertNextSongViaCDP(newSong.Id);
        }
      }
      else {
        targetQueue.push(newSong); setGlobalStatus(`✅ 点歌: ${newSong.SongName}`);
        if (targetQueue.length === 1 && !currentPlayingSong && isPlaying) {
          if (appConfig.sysConfig?.IdleWaitNext === false) forcePlaySongAsync(targetQueue.shift());
          else await insertNextSongViaCDP(newSong.Id);
        }
      }
    } else {
      setGlobalStatus(`❌ 未搜到: ${keyword}`); addReject(user, `未搜到歌曲: ${keyword}`);
    }
  } catch { setGlobalStatus('❌ 搜索网络异常'); addReject(user, '搜索网络异常'); }
}

function handleDanmaku(user: any, msg: string) {
  if (msg.toLowerCase().includes('test') || msg.includes('测试')) writeLog(`[弹幕] 测试通信: ${msg}`, 'Cyan');

  const isOrder = msg.startsWith('点歌') || msg.startsWith('點歌');
  const isTopOrder = msg.startsWith('置顶点歌') || msg.startsWith('优先点歌');
  const isInterruptOrder = msg.startsWith('插队点歌');
  const isPlayNowOrder = msg.startsWith('立即点歌');
  const isCancel = msg.startsWith('撤回');
  const isSkip = msg === '切歌' || msg === '跳过';

  if (!isAccepting && (isOrder || isTopOrder || isInterruptOrder || isPlayNowOrder || isCancel || isSkip)) return;

  if (isCancel) {
    const keyword = msg.replace(/^撤回/, '').trim();
    if (keyword) {
      const perm = checkPermission(user, 'ForceControlPermission');
      if (!perm.allowed) { addReject(user, "权限不足: 需要强控权限"); return; }
      const idx = targetQueue.findIndex(s => s.SongName.includes(keyword) || s.ArtistName.includes(keyword));
      if (idx !== -1) { const removed = targetQueue.splice(idx, 1)[0]; setGlobalStatus(`🗑️ 强行撤回: ${removed.SongName}`); }
      else addReject(user, "撤回失败: 未在队列中找到");
    } else {
      const perm = checkPermission(user, 'CancelPermission');
      if (!perm.allowed) { addReject(user, perm.reason!); return; }
      let foundIdx = -1;
      for (let i = targetQueue.length - 1; i >= 0; i--) { if (targetQueue[i].OrderedByUid === user.uid) { foundIdx = i; break; } }
      if (foundIdx !== -1) { const removed = targetQueue.splice(foundIdx, 1)[0]; setGlobalStatus(`🗑️ 已撤回: ${removed.SongName}`); }
      else addReject(user, "队列中没有你点的歌");
    }
    return;
  }

  if (isSkip) {
    const perm = checkPermission(user, 'SkipPermission');
    if (!perm.allowed) { addReject(user, perm.reason!); return; }
    setGlobalStatus('⏭️ 已手动切歌');
    playNextSong();
    return;
  }

  if (isOrder || isTopOrder || isInterruptOrder || isPlayNowOrder) {
    let keyword = ''; let mode: 'normal' | 'top' | 'interrupt' | 'play_now' = 'normal';
    if (isPlayNowOrder) { keyword = msg.replace(/^立即点歌/, '').trim(); mode = 'play_now'; }
    else if (isInterruptOrder) { keyword = msg.replace(/^插队点歌/, '').trim(); mode = 'interrupt'; }
    else if (isTopOrder) { keyword = msg.replace(/^(置顶点歌|优先点歌)/, '').trim(); mode = 'top'; }
    else { keyword = msg.substring(2).trim(); }

    const isSuperUser = appConfig.sysConfig?.SuperUsers?.includes(user.uname) || appConfig.sysConfig?.SuperUsers?.includes(user.uid);
    if (!isSuperUser) {
      const cds = appConfig.sysConfig?.Cooldowns || { Normal: 0, Captain: 0, Admiral: 0, Governor: 0 };
      let cdSeconds = cds.Normal;
      if (user.guardLevel === 3) cdSeconds = cds.Captain;
      if (user.guardLevel === 2) cdSeconds = cds.Admiral;
      if (user.guardLevel === 1) cdSeconds = cds.Governor;

      if (cdSeconds > 0) {
        const passed = (Date.now() - (userCooldowns.get(user.uid) || 0)) / 1000;
        if (passed < cdSeconds) { addReject(user, `冷却中，需等待 ${Math.ceil(cdSeconds - passed)} 秒`); return; }
      }
    }

    if (mode === 'top') { const perm = checkPermission(user, 'PriorityPermission'); if (!perm.allowed) { addReject(user, perm.reason!); return; } }
    else if (mode === 'interrupt' || mode === 'play_now') { const perm = checkPermission(user, 'ForceControlPermission'); if (!perm.allowed) { addReject(user, perm.reason!); return; } }
    else { const perm = checkPermission(user, 'OrderPermission'); if (!perm.allowed) { addReject(user, perm.reason!); return; } }

    if (keyword) { userCooldowns.set(user.uid, Date.now()); tryRequestSong(user, keyword, mode); }
  }
}

// ==========================================
// B站扫码登录核心逻辑
// ==========================================
async function startBiliQrLogin() {
  if (isQrLoggingIn) return;
  isQrLoggingIn = true; qrCodeBase64 = ""; qrLoginStatus = "正在向 B站请求二维码...";

  try {
    const headers = { "User-Agent": "Mozilla/5.0" };
    const genRes = await fetch("https://passport.bilibili.com/x/passport-login/web/qrcode/generate", { headers });
    const genData: any = await genRes.json();
    if (!genData.data?.url) { qrLoginStatus = "错误：无法获取二维码"; isQrLoggingIn = false; return; }

    const qrImgRes = await fetch(`https://api.qrserver.com/v1/create-qr-code/?size=256x256&data=${encodeURIComponent(genData.data.url)}`);
    qrCodeBase64 = "data:image/png;base64," + Buffer.from(await qrImgRes.arrayBuffer()).toString('base64');
    qrLoginStatus = "请使用手机 B站 APP 扫码";

    if (qrPollTimer) clearInterval(qrPollTimer);
    let pollCount = 0;

    qrPollTimer = setInterval(async () => {
      pollCount++;
      if (pollCount > 60) { clearInterval(qrPollTimer!); qrLoginStatus = "二维码已失效，请重新发起"; isQrLoggingIn = false; return; }

      try {
        const pollRes = await fetch(`https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=${genData.data.qrcode_key}`, { headers });
        const pollData: any = await pollRes.json();
        const code = pollData.data?.code;

        if (code === 86090) qrLoginStatus = "已扫码，请在手机上点击确认";
        else if (code === 86038) { clearInterval(qrPollTimer!); qrLoginStatus = "二维码已失效，请重新发起"; isQrLoggingIn = false; }
        else if (code === 0) {
          clearInterval(qrPollTimer!); qrLoginStatus = "扫码成功！正在提取身份凭证...";
          if (pollData.data?.url) {
            const params = new URLSearchParams(new URL(pollData.data.url).search);
            const cookies: string[] = []; let uid = 0;
            params.forEach((value, key) => {
              if (['DedeUserID', 'DedeUserID__ckMd5', 'SESSDATA', 'bili_jct'].includes(key)) cookies.push(`${key}=${value}`);
              if (key === 'DedeUserID') uid = parseInt(value, 10);
            });
            biliCookie = cookies.join('; '); biliUid = uid; saveConfig();
            await updateCurrentUserInfo();
            if (appConfig.roomId) connectToLiveRoom(appConfig.roomId);
          }
          qrLoginStatus = "登录完成，请前往连接直播间！"; isQrLoggingIn = false;
        }
      } catch { }
    }, 2000);
  } catch (err: any) { qrLoginStatus = `错误: ${err.message}`; isQrLoggingIn = false; }
}

function readRequestBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => { let body = ''; req.on('data', chunk => body += chunk.toString()); req.on('end', () => resolve(body)); req.on('error', err => reject(err)); });
}

// ==========================================
// 后端 API 与 静态网页托管服务
// ==========================================
function startBackendServer() {
  const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');
    if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

    const url = new URL(req.url || '/', `http://${req.headers.host}`);

    if (url.pathname === '/data') {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ current: currentPlayingSong, queue: targetQueue, status: currentStatusMessage, accepting: isAccepting, playing: isPlaying, uiConfig: appConfig.widgetStyle, rejects: recentRejects, cdpConnected: isCdpConnected }));
      return;
    }

    if (url.pathname === '/api/lyrics') {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ lyrics: currentLyrics, cdpConnected: isCdpConnected }));
      return;
    }

    if (url.pathname === '/api/config') {
      if (req.method === 'POST') {
        const body = JSON.parse(await readRequestBody(req));
        if (body.roomId !== undefined) appConfig.roomId = body.roomId;
        if (body.widgetStyle !== undefined) appConfig.widgetStyle = body.widgetStyle;
        if (body.sysConfig !== undefined) appConfig.sysConfig = { ...appConfig.sysConfig, ...body.sysConfig };
        saveConfig();
        res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify({ success: true }));
        return;
      }
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ roomId: appConfig.roomId, myRoomId: appConfig.myRoomId || 0, biliLogin: !!biliCookie, uid: biliUid, currentUser: currentUserInfo, version: app.getVersion(), accepting: isAccepting, playing: isPlaying, widgetStyle: appConfig.widgetStyle, cdpConnected: isCdpConnected, config: appConfig.sysConfig || { EnableCDP: true, CdpPort: 9222, ShowAllDanmaku: false, IdleWaitNext: true, SuperUsers: [], Cooldowns: { Normal: 0, Captain: 0, Admiral: 0, Governor: 0 } } }));
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

      const doc = JSON.parse(await readRequestBody(req));
      const { action, index } = doc;

      if (action === 'delete' && index >= 0 && index < targetQueue.length) { targetQueue.splice(index, 1); setGlobalStatus('🗑️ 已移除曲目'); }
      else if (action === 'top' && index >= 0 && index < targetQueue.length) {
        const item = targetQueue.splice(index, 1)[0];
        if (item) {
          targetQueue.unshift(item);
          if (isPlaying) insertNextSongViaCDP(item.Id);
          setGlobalStatus(`⬆️ 置顶: ${item.SongName}`);
        }
      } else if (action === 'play_now' && index >= 0 && index < targetQueue.length) {
        const item = targetQueue.splice(index, 1)[0];
        if (item) {
          forcePlaySongAsync(item);
          setGlobalStatus(`▶️ 强制播放: ${item.SongName}`);
        }
      } else if (action === 'skip_current') {
        playNextSong();
        setGlobalStatus('⏭️ 已切歌');
      } else if (action === 'reorder' && doc.from >= 0 && doc.from < targetQueue.length && doc.to >= 0 && doc.to < targetQueue.length) {
        const item = targetQueue.splice(doc.from, 1)[0];
        if (item) {
          targetQueue.splice(doc.to, 0, item);
          setGlobalStatus('🔄 列表已重排');
        }
      } else if (action === 'push_current_to_queue') {
        if (currentPlayingSong) {
          targetQueue.push(currentPlayingSong); skipForcePlayOnce = true; setGlobalStatus('🔙 已退回点歌列表末端');
          playNextSong();
        }
      }
      res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify({ success: true }));
      return;
    }

    if (url.pathname === '/api/room' && req.method === 'POST') {
      const doc = JSON.parse(await readRequestBody(req));
      if (doc.roomId) {
        const success = await connectToLiveRoom(doc.roomId);
        res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify({ success })); return;
      }
      res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify({ success: false })); return;
    }

    if (url.pathname === '/api/state/toggle' && req.method === 'POST') { isAccepting = !isAccepting; res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify({ success: true })); return; }
    if (url.pathname === '/api/state/toggle_play' && req.method === 'POST') { isPlaying = !isPlaying; res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify({ success: true })); return; }

    if (url.pathname === '/api/debug/play_next' && req.method === 'POST') {
      const success = await playNextSong();
      res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify({ success })); return;
    }

    if (url.pathname === '/api/sys/restart_ncm' && req.method === 'POST') {
      restartNCMWithDebugPort();
      res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify({ success: true })); return;
    }

    if (url.pathname === '/api/update/check') {
      try {
        const um = new UpdateManager('https://app.enkianss.us/update/bilincm');
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
        const um = new UpdateManager('https://app.enkianss.us/update/bilincm');
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
        const { keyword } = JSON.parse(await readRequestBody(req));
        let playSongId = '';

        const idMatch = keyword.match(/^id\s*=\s*(\d+)/i);

        if (appConfig.sysConfig?.PlayerType === 'Folia') {
          const token = appConfig.sysConfig?.FoliaToken?.trim();
          if (idMatch) {
            playSongId = String(idMatch[1]);
          } else {
            const searchRes = await fetch(`http://127.0.0.1:${FOLIA_HTTP_PORT}/stage/player/search`, {
              method: 'POST', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ query: keyword, limit: 1 })
            });
            const searchData = await searchRes.json();
            const foliaSongs = searchData.songs || [];
            if (foliaSongs.length > 0) playSongId = String(foliaSongs[0].songId || foliaSongs[0].id);
          }
        } else {
          if (idMatch) {
            playSongId = String(idMatch[1]);
          } else {
            const searchRes = await fetch(`https://music.163.com/api/search/get/web`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'User-Agent': 'Mozilla/5.0',
                'Cookie': 'os=pc; appver=2.9.8;',
                ...getChinaBypassHeaders() // ⭐ 注入国内 IP 伪装绕过
              },
              body: `s=${encodeURIComponent(keyword)}&type=1&limit=1`
            });
            const searchData: any = await searchRes.json();
            const songs = searchData.result?.songs || [];
            if (songs.length > 0) playSongId = String(songs[0].id);
          }
        }

        if (playSongId) {
          await insertNextSongViaCDP(playSongId);
          res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify({ success: true }));
        } else {
          res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify({ success: false, message: '未找到相关歌曲' }));
        }
      } catch { res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify({ success: false })); }
      return;
    }

    if (url.pathname === '/api/bili/qrstart' && req.method === 'POST') { startBiliQrLogin(); res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify({ success: true })); return; }
    if (url.pathname === '/api/bili/qrstatus') { res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify({ qrBase64: qrCodeBase64, status: qrLoginStatus, isLogin: !!biliCookie })); return; }
    if (url.pathname === '/api/logs') { res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(sysLogs)); return; }

    if (req.method === 'GET' && !url.pathname.startsWith('/api/') && url.pathname !== '/data') {
      const distPath = path.join(__dirname, '../dist');
      let filePath = path.join(distPath, url.pathname === '/' ? 'index.html' : url.pathname);
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
  });

  server.listen(5555, () => { writeLog('✅ 内部 API 及静态网页服务已启动于 http://localhost:5555', 'Green'); });
}

// ==========================================
// 程序启动入口
// ==========================================
app.whenReady().then(() => {
  writeLog('=== BiliNCM-Bot 内部日志已连接 ===', 'Cyan');
  loadConfig();
  restartNCMWithDebugPort();
  createOverlayWindow();

  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createOverlayWindow(); });
  startBackendServer();
  if (biliCookie) updateCurrentUserInfo();
  if (appConfig.roomId) connectToLiveRoom(appConfig.roomId);
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
