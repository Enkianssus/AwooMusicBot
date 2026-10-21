import type { DiagnosticCheck, DanmakuReceptionTest } from '../src/diagnostics-types';
import type { BiliRoomConnectionStatus } from './bili-room-connection-policy';
import type { ConnectorUpdateStatus } from './connector-updater';
import type { PlayerSnapshot } from './player-bridge-client';

export interface DiagnosticInputs {
  room: {
    enabled: boolean;
    status: BiliRoomConnectionStatus;
    message: string;
    requestedRoomId: number;
    realRoomId: number;
  };
  loginReady: boolean;
  accepting: boolean;
  queuePlaybackEnabled: boolean;
  playerKey: string;
  playerConnected: boolean;
  playerConnecting: boolean;
  snapshot: PlayerSnapshot | null;
  connector: ConnectorUpdateStatus | null;
  connectorError: string;
  search: { status: 'pass' | 'error' | 'unknown'; message: string };
  ordinaryPermission: { allowed: boolean; reason?: string };
  giftRequirement: string;
  cooldownSeconds: number;
  pendingCommands: number;
  receptionCount: number;
  lastDanmakuAt: number | null;
}

function connectorCheck(input: DiagnosticInputs): DiagnosticCheck {
  const check: DiagnosticCheck = {
    id: 'connector-update',
    title: '连接器版本与更新',
    status: 'unknown',
    message: '尚未取得有效的连接器更新目录，无法判断是否为最新版本。',
    advice: '检查网络后重新运行诊断，或到设置中的连接器管理查看详情。'
  };
  const status = input.connector;
  const error = input.connectorError.trim() || status?.error?.trim();
  if (error) return { ...check, message: `连接器更新检查失败：${error}。当前版本是否最新尚未验证。` };
  if (!status || !status.latestVersion || !status.checkedAt) return check;
  if (status.id !== input.playerKey) {
    return { ...check, message: '更新信息属于其他播放器，当前播放器的连接器版本尚未验证。' };
  }
  if (status.updating) {
    return { ...check, status: 'warning', message: '连接器正在更新，请等待完成后重新检查。', advice: '更新期间不要重复发起更新或重连。' };
  }
  if (!status.compatible) {
    return {
      ...check,
      status: 'error',
      message: `最新连接器 ${status.latestVersion} 需要更新点歌机${status.minimumCoreVersion ? `至 ${status.minimumCoreVersion} 或更高版本` : ''}。`,
      advice: '先更新点歌机，再检查连接器；核心版本兼容不代表本机播放器版本匹配。'
    };
  }
  if (status.manualUpdateAvailable) {
    return {
      ...check,
      status: 'warning',
      message: `发现连接器 ${status.latestVersion}，涉及播放器版本分支变更，需要手动确认。`,
      advice: `到设置中的连接器管理核对播放器版本并手动确认更新${status.supportedPlayerVersion ? `；支持的播放器版本：${status.supportedPlayerVersion}` : ''}。`
    };
  }
  if (!status.installed || status.autoUpdateAvailable) {
    return {
      ...check,
      status: 'warning',
      message: !status.installed
        ? `尚未安装连接器，可安装 ${status.latestVersion}。`
        : `发现可更新的连接器：${status.currentVersion || '未知版本'} → ${status.latestVersion}。`,
      advice: '可使用自动修复安装或更新连接器；更新完成后重新检查播放器连接。核心版本兼容不代表播放器版本已经匹配。',
      repair: 'update-connector'
    };
  }
  if (status.updateAvailable) {
    return {
      ...check,
      status: 'warning',
      message: `发现连接器 ${status.latestVersion}，但无法确认是否允许自动更新。`,
      advice: '到设置中的连接器管理核对更新要求后手动处理。'
    };
  }
  if (!status.currentVersion) return { ...check, message: '无法读取已安装连接器版本，尚不能判断是否需要更新。' };
  return {
    ...check,
    status: 'pass',
    message: `已安装 ${status.currentVersion}；本次目录未发现可用更新（目录版本 ${status.latestVersion}）。`,
    advice: '此结果只确认目录更新状态与核心版本兼容；播放器是否可用还需结合连接、搜索和实际播放测试。'
  };
}

/** Reports evidence separately: authentication, receiving, searching and playing are different checks. */
export function buildDiagnosticChecks(input: DiagnosticInputs): DiagnosticCheck[] {
  const roomConnected = input.room.enabled && input.room.status === 'connected';
  const roomId = input.room.realRoomId || input.room.requestedRoomId;
  const checks: DiagnosticCheck[] = [{
    id: 'login',
    title: '哔哩哔哩登录',
    status: input.loginReady ? 'pass' : 'warning',
    message: input.loginReady ? '已读取哔哩哔哩登录信息。' : '当前使用游客模式，可以接收普通点歌和撤回指令。',
    advice: input.loginReady ? '登录信息存在不等于服务器已验证，弹幕连接结果见下一项。' : '房管、舰队等依赖用户身份的操作需要登录；普通点歌的可用性请结合弹幕接收与点歌规则检查。'
  }];
  if (!input.room.enabled) {
    checks.push({ id: 'room-connection', title: '直播间弹幕连接', status: 'warning', message: '弹幕连接已关闭。', advice: '到控制台填写直播间号并手动连接。' });
  } else if (roomConnected) {
    checks.push({ id: 'room-connection', title: '直播间弹幕连接', status: 'pass', message: `直播间 ${roomId} 的弹幕连接已通过服务器认证。`, advice: '连接认证成功仍需通过真实弹幕确认消息接收。' });
  } else if (input.room.status === 'connecting') {
    checks.push({ id: 'room-connection', title: '直播间弹幕连接', status: 'warning', message: input.room.message || '正在连接或重连弹幕服务器。', advice: '等待连接完成后重新检查。' });
  } else {
    checks.push({
      id: 'room-connection', title: '直播间弹幕连接', status: 'error',
      message: input.room.message || '尚未建立弹幕连接。',
      advice: '检查直播间号、登录状态和网络；连接失败时可使用自动修复重连。',
      ...(input.room.status === 'error' ? { repair: 'reconnect-room' as const } : {})
    });
  }
  const observed = roomConnected && input.receptionCount > 0 && input.lastDanmakuAt !== null;
  checks.push({
    id: 'danmaku-reception', title: '真实弹幕接收', status: observed ? 'pass' : 'unknown',
    message: observed ? `本次连接已收到 ${input.receptionCount} 条真实弹幕。` : '本次连接尚未验证真实弹幕接收；连接认证成功不能替代接收测试。',
    advice: '启动接收测试后，在对应直播间发送界面提示的测试短语。只有收到该真实弹幕才会通过。'
  });
  checks.push({
    id: 'request-accepting', title: '接单开关', status: input.accepting ? 'pass' : 'warning',
    message: input.accepting ? '已开启接单。' : '接单已关闭，观众的点歌指令不会进入队列。',
    ...(!input.accepting ? { advice: '需要接收点歌时，请在控制台手动开启接单。' } : {})
  }, {
    id: 'request-permission', title: '普通观众点歌权限', status: input.ordinaryPermission.allowed ? 'pass' : 'warning',
    message: input.ordinaryPermission.allowed ? '当前权限规则允许普通观众点歌。' : `当前规则限制普通观众点歌${input.ordinaryPermission.reason ? `：${input.ordinaryPermission.reason}` : '。'}`,
    advice: '实际结果还会受用户身份、礼物额度和点歌冷却等规则影响；诊断不会修改权限。'
  }, {
    id: 'gift-requirement', title: '礼物点歌要求', status: input.giftRequirement ? 'warning' : 'pass',
    message: input.giftRequirement ? `当前点歌需要满足礼物要求：${input.giftRequirement}` : '当前没有额外的礼物点歌要求。',
    ...(input.giftRequirement ? { advice: '未满足礼物条件的普通观众无法直接点歌；请使用符合条件的账号测试，或自行调整点歌规则。' } : {})
  }, {
    id: 'request-cooldown', title: '点歌冷却', status: input.cooldownSeconds > 0 ? 'warning' : 'pass',
    message: input.cooldownSeconds > 0 ? `已设置 ${input.cooldownSeconds} 秒点歌冷却，连续测试可能被拒绝。` : '未设置点歌冷却。',
    ...(input.cooldownSeconds > 0 ? { advice: '等待冷却结束后重试；诊断不会清空用户冷却。' } : {})
  }, {
    id: 'command-queue', title: '待处理点歌指令', status: input.pendingCommands > 0 ? 'warning' : 'pass',
    message: input.pendingCommands > 0 ? `当前有 ${input.pendingCommands} 条指令等待处理，点歌结果可能延迟。` : '当前没有待处理的点歌指令。'
  }, {
    id: 'queue-playback', title: '队列播放开关', status: input.queuePlaybackEnabled ? 'pass' : 'warning',
    message: input.queuePlaybackEnabled ? '已开启队列播放。' : '队列播放已暂停，成功点歌也不会自动播放队列。',
    ...(!input.queuePlaybackEnabled ? { advice: '需要自动播放时，请在控制台手动开启队列播放。' } : {})
  });
  const playerReady = input.playerConnected && input.snapshot?.connected !== false;
  checks.push({
    id: 'player-connection', title: '播放器连接',
    status: playerReady ? 'pass' : input.playerConnecting ? 'warning' : 'error',
    message: playerReady ? `已连接播放器${input.snapshot?.version ? `（${input.snapshot.version}）` : ''}。` : input.playerConnecting ? '正在连接播放器。' : '播放器尚未连接，暂时无法完成点歌播放。',
    ...(!playerReady ? {
      advice: input.playerConnecting ? '等待连接完成后重新检查。' : '先启动选中的播放器并完成登录，再使用自动修复重连。',
      ...(!input.playerConnecting ? { repair: 'reconnect-player' as const } : {})
    } : {})
  });
  const capabilities = playerReady ? input.snapshot?.capabilities : null;
  checks.push({
    id: 'player-capabilities', title: '点歌控制能力',
    status: !capabilities ? 'unknown' : !capabilities.search || !capabilities.playSelected ? 'error' : 'pass',
    message: !capabilities ? '尚未取得播放器的搜索和指定歌曲播放能力。' : !capabilities.search || !capabilities.playSelected ? `当前连接器不支持${!capabilities.search ? '歌曲搜索' : ''}${!capabilities.search && !capabilities.playSelected ? '和' : ''}${!capabilities.playSelected ? '指定歌曲播放' : ''}。` : '连接器声明支持搜索与指定歌曲播放，仍需实际测试验证。',
    advice: '能力声明不代表本机播放成功；请结合搜索测试和真实点歌结果判断。'
  }, {
    id: 'song-search', title: '歌曲搜索测试', status: input.search.status,
    message: input.search.message || '尚未完成歌曲搜索测试。',
    advice: input.search.status === 'pass' ? '搜索成功只验证搜索链路，不代表指令入队或音频播放成功。' : '确认播放器已连接且网络可用后重新检查。'
  }, {
    id: 'playback-verification', title: '实际点歌与播放', status: 'unknown',
    message: '尚未验证真实点歌入队及音频播放；自动检查不会切换当前歌曲。',
    advice: input.playerKey === 'qqmusic' && input.snapshot?.requiresPlaybackAnchor !== false && input.snapshot?.playbackAnchorReady === false
      ? 'QQ 音乐尚未建立播放锚点，请先在播放器中播放一首歌曲，再从直播间发送正常点歌指令并确认入队与实际出声。'
      : '在直播间用符合当前权限和礼物规则的账号发送正常点歌指令，确认队列出现该歌曲并实际出声。'
  }, connectorCheck(input));
  return checks;
}

const RECEPTION_TEST_DURATION_MS = 60_000;

function idleReception(): DanmakuReceptionTest {
  return { status: 'idle', phrase: '', roomId: 0, startedAt: 0, expiresAt: 0, receivedAt: null };
}

/** Accepts only real, current-session DANMU_MSG callbacks supplied by the room client. */
export class DanmakuReceptionTracker {
  private session = -1;
  private roomId = 0;
  private count = 0;
  private lastDanmakuAt: number | null = null;
  private state = idleReception();

  resetSession(session: number, roomId: number): void {
    if (this.state.status !== 'idle') this.state = { ...this.state, status: 'cancelled', receivedAt: null };
    this.session = session;
    this.roomId = roomId;
    this.count = 0;
    this.lastDanmakuAt = null;
  }

  observe(session: number, roomId: number, message: string, now = Date.now()): void {
    if (session !== this.session || roomId !== this.roomId || roomId <= 0 || !message.trim() || !Number.isFinite(now)) return;
    this.count += 1;
    this.lastDanmakuAt = Math.max(this.lastDanmakuAt ?? now, now);
    this.expire(now);
    if (this.state.status === 'waiting' && now >= this.state.startedAt && message.trim() === this.state.phrase) {
      this.state = { ...this.state, status: 'received', receivedAt: now };
    }
  }

  start(session: number, roomId: number, phrase: string, now = Date.now()): DanmakuReceptionTest {
    const next: DanmakuReceptionTest = {
      status: 'waiting', phrase: phrase.trim(), roomId, startedAt: now,
      expiresAt: now + RECEPTION_TEST_DURATION_MS, receivedAt: null
    };
    if (session !== this.session || roomId !== this.roomId || roomId <= 0 || !next.phrase || !Number.isFinite(now)) {
      return { ...next, status: 'cancelled' };
    }
    this.state = next;
    return { ...this.state };
  }

  cancel(): void {
    if (this.state.status === 'waiting') this.state = { ...this.state, status: 'cancelled' };
  }

  getState(now = Date.now()): DanmakuReceptionTest {
    this.expire(now);
    return { ...this.state };
  }

  get observation(): { count: number; lastDanmakuAt: number | null } {
    return { count: this.count, lastDanmakuAt: this.lastDanmakuAt };
  }

  private expire(now: number): void {
    if (this.state.status === 'waiting' && now >= this.state.expiresAt) {
      this.state = { ...this.state, status: 'timeout' };
    }
  }
}
