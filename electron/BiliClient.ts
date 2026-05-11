import WebSocket from 'ws';
import zlib from 'zlib';

// 定义用户接口，提供强类型支持
export interface BiliUser {
    uid: string;
    name: string;
    isManager: boolean;
}

export class BiliClient {
    private ws: WebSocket | null = null;
    private roomId: number;
    private realRoomId: number = 0;
    private token: string = '';
    private heartbeatTimer: NodeJS.Timeout | null = null;

    // 回调事件钩子 (供 main.ts 挂载)
    public onDanmaku: (user: BiliUser, msg: string) => void = () => {};
    public onConnected: () => void = () => {};
    public onDisconnected: (reason: string) => void = () => {};

    constructor(roomId: number) {
        this.roomId = roomId;
    }

    /**
     * 连接到指定的直播间
     */
    public async connect(): Promise<void> {
        try {
            console.log(`[BiliClient] 正在获取直播间 ${this.roomId} 的真实房间号...`);

            // 1. 获取真实房间号
            const initRes = await fetch(`https://api.live.bilibili.com/room/v1/Room/room_init?id=${this.roomId}`);
            const initData = await initRes.json();
            if (initData.code !== 0) throw new Error(initData.msg);
            this.realRoomId = initData.data.room_id;

            // 2. 获取弹幕服务器 Token
            const danmuRes = await fetch(`https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo?id=${this.realRoomId}&type=0`);
            const danmuData = await danmuRes.json();
            this.token = danmuData.data.token;

            // 3. 建立 WebSocket 连接
            this.ws = new WebSocket('wss://broadcastlv.chat.bilibili.com/sub');

            this.ws.on('open', () => {
                this.sendAuth();
            });

            this.ws.on('message', (data: Buffer) => {
                this.parsePacket(data);
            });

            this.ws.on('close', () => {
                this.stopHeartbeat();
                this.onDisconnected('连接已关闭');
            });

            this.ws.on('error', (err) => {
                console.error('[BiliClient] WebSocket Error:', err);
                this.onDisconnected(err.message);
            });

        } catch (error: any) {
            console.error('[BiliClient] 连接失败:', error);
            this.onDisconnected(error.message || '未知网络错误');
        }
    }

    /**
     * 手动断开连接
     */
    public disconnect() {
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
    }

    /**
     * 发送进房认证包 (Opcode: 7)
     */
    private sendAuth() {
        const authObj = {
            uid: 0, // 如果有真实的 Bili 账号 Cookie，这里可以替换为真实 UID 以获取更高权限
            roomid: this.realRoomId,
            protover: 3,
            platform: 'web',
            type: 2,
            key: this.token
        };
        this.ws?.send(this.makePacket(JSON.stringify(authObj), 7));
    }

    /**
     * 开启心跳循环 (Opcode: 2，每 30 秒一次)
     */
    private startHeartbeat() {
        this.stopHeartbeat();
        this.heartbeatTimer = setInterval(() => {
            if (this.ws?.readyState === WebSocket.OPEN) {
                this.ws.send(this.makePacket('[object Object]', 2));
            }
        }, 30000);
    }

    private stopHeartbeat() {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
    }

    /**
     * 封包处理工具：将负载打包为 Bilibili WebSocket 协议格式
     */
    private makePacket(payload: string, op: number): Buffer {
        const payloadBuf = Buffer.from(payload);
        const buf = Buffer.alloc(16 + payloadBuf.length);
        buf.writeUInt32BE(buf.length, 0); // 封包总大小
        buf.writeUInt16BE(16, 4);         // 头部大小 (固定16)
        buf.writeUInt16BE(1, 6);          // 协议版本
        buf.writeUInt32BE(op, 8);         // 操作码 (Opcode)
        buf.writeUInt32BE(1, 12);         // sequence固定为1
        payloadBuf.copy(buf, 16);
        return buf;
    }

    /**
     * 解包处理工具：解析收到的二进制流
     */
    private parsePacket(buffer: Buffer) {
        let offset = 0;
        while (offset < buffer.length) {
            const packetLen = buffer.readUInt32BE(offset);
            const ver = buffer.readUInt16BE(offset + 6);
            const op = buffer.readUInt32BE(offset + 8);
            const payload = buffer.subarray(offset + 16, offset + packetLen);

            switch (op) {
                case 8: // 进房认证回复
                    this.onConnected();
                    this.startHeartbeat();
                    break;
                case 3: // 心跳回复 (包含了当前人气值，暂不需要处理)
                    break;
                case 5: // 业务消息 (弹幕、醒目留言、礼物等)
                    if (ver === 3) {
                        // 版本3表示负载使用了 Brotli 压缩
                        try {
                            const decompressed = zlib.brotliDecompressSync(payload);
                            this.parsePacket(decompressed); // 递归解析解压后的包
                        } catch (e) {
                            console.error('[BiliClient] Brotli 解压失败', e);
                        }
                    } else {
                        // 普通 JSON 消息
                        try {
                            const data = JSON.parse(payload.toString('utf-8'));
                            this.handleMessage(data);
                        } catch (e) {
                            // 忽略无法解析的脏数据
                        }
                    }
                    break;
            }
            offset += packetLen; // 步进到下一个包
        }
    }

    /**
     * 处理具体的业务消息逻辑
     */
    private handleMessage(data: any) {
        const cmd = data?.cmd || '';

        // 使用 startsWith 是因为某些弹幕 cmd 可能带有后缀，如 DANMU_MSG:4:0:2:2:2:0
        if (cmd.startsWith('DANMU_MSG')) {
            const info = data.info;
            if (!info || info.length < 3) return;

            const msg: string = info[1];
            const userBase = info[2];

            // 构建安全的 User 对象
            const uid = String(userBase[0]);
            const name = userBase[1];
            const isManager = userBase[2] === 1;

            const user: BiliUser = { uid, name, isManager };

            // 抛出回调给外部处理
            this.onDanmaku(user, msg);
        }
    }
}