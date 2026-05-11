import http from 'http';
import WebSocket from 'ws';

export class NeteaseController {
    private port: number;

    constructor(port: number = 9222) {
        this.port = port;
    }

    /**
     * 1. 自动探测并获取网易云音乐的底层调试 WebSocket 隧道
     */
    private async getDebuggerUrl(): Promise<string> {
        return new Promise((resolve, reject) => {
            const req = http.get(`http://127.0.0.1:${this.port}/json`, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        const targets = JSON.parse(data);
                        // 寻找主页面 (优先匹配带有网易云特征的页面)
                        let target = targets.find((t: any) => t.type === 'page' && t.url.includes('music.163.com'));
                        if (!target) {
                            // 若找不到特征 URL，则默认选取第一个 page
                            target = targets.find((t: any) => t.type === 'page');
                        }

                        if (target && target.webSocketDebuggerUrl) {
                            resolve(target.webSocketDebuggerUrl);
                        } else {
                            reject(new Error('未在目标端口发现有效的网易云页面目标'));
                        }
                    } catch (e) {
                        reject(new Error('解析 CDP Target 失败: ' + String(e)));
                    }
                });
            });

            req.on('error', (err) => {
                reject(new Error(`连接 CDP 失败！请确认网易云已完全开启并携带 --remote-debugging-port=${this.port} 参数启动。(${err.message})`));
            });
        });
    }

    /**
     * 2. 底层通讯：将 JavaScript 代码强制注入网易云运行，并取回结果
     */
    public async evaluate(expression: string): Promise<any> {
        const wsUrl = await this.getDebuggerUrl();

        return new Promise((resolve, reject) => {
            const ws = new WebSocket(wsUrl);
            let resolved = false;

            ws.on('open', () => {
                const payload = {
                    id: 1,
                    method: 'Runtime.evaluate',
                    params: {
                        expression: expression,
                        returnByValue: true
                    }
                };
                ws.send(JSON.stringify(payload));
            });

            ws.on('message', (data) => {
                const response = JSON.parse(data.toString());
                if (response.id === 1) {
                    resolved = true;
                    ws.close();
                    if (response.result?.exceptionDetails) {
                        reject(new Error(response.result.exceptionDetails.exception.description));
                    } else {
                        resolve(response.result?.result?.value);
                    }
                }
            });

            ws.on('error', (err) => {
                if (!resolved) reject(err);
            });

            // 设立指令超时熔断保护
            setTimeout(() => {
                if (!resolved) {
                    ws.close();
                    reject(new Error('CDP 注入指令执行超时，网易云无响应'));
                }
            }, 3000);
        });
    }

    // ==========================================
    // 具体的业务注入指令
    // ==========================================

    /**
     * 静默执行下一首
     */
    public async playNext(): Promise<void> {
        // 利用网易云界面的原生按钮选择器进行切歌
        const script = `
            (function() {
                const nextBtn = document.querySelector('.prv[data-action="next"]') || document.querySelector('.btn-next');
                if (nextBtn) {
                    nextBtn.click();
                    return true;
                }
                return false;
            })();
        `;
        const result = await this.evaluate(script);
        if (!result) {
            throw new Error('指令已发送，但未能在网易云内找到下一首按钮（DOM层可能已更改）');
        }
    }

    /**
     * 插入特定歌曲到播放列表下一首
     */
    public async insertSong(keyword: string): Promise<void> {
        // 这里的代码会在网易云的执行上下文内运行！
        // TODO: 结合网易云云端 API 获取具体 SongID，然后利用 Redux 注入
        const script = `
            (function() {
                console.log("[点歌机核心] 收到插入请求，关键词:", "${keyword}");
                // 此处需补充特定版本的注入逻辑：
                // 例如早期版本使用: window.ctl.add(songId); 
                return true;
            })();
        `;
        await this.evaluate(script);
    }
}