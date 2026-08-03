# 本机只读接口（OBS 浏览器捕捉）

嗷呜点歌机提供一个只读的本机接口，方便第三方开发者制作自己的网页前端，并把网页作为 OBS 的“浏览器”来源显示。接口只提供当前播放、点歌队列和两个业务开关的状态，不提供任何控制命令。

## 开启与地址

在点歌机“基础设置 → 外部只读接口”中分别开启 HTTP API 和 WebSocket。默认监听地址是 `127.0.0.1`，默认端口是 `5556`；端口可以在设置中修改。

OBS 浏览器来源可以直接填写内置展示页地址：

```text
http://127.0.0.1:5556/overlay/
```

如果使用自建页面，只要让页面运行在同一台电脑上，并请求下面的 API 即可。端口不是默认值时，把地址中的 `5556` 换成设置中的端口。

接口只绑定回环地址。即使电脑接入局域网，其他设备也不能直接访问这组接口；想在另一台电脑上显示时，需要自行部署一个经过身份验证的安全中继，不要直接把端口转发到公网。

## HTTP 接口

所有 HTTP 接口均为 `GET`。服务器也接受 `OPTIONS` 预检请求（返回 `204`），以便本地网页跨源读取；不接受 `POST`、`PUT`、`PATCH` 或 `DELETE`。响应为 UTF-8 JSON，并带有 `Cache-Control: no-store`。

| 方法与路径 | 用途 | 响应 |
| --- | --- | --- |
| `GET /health` | 检查接口是否运行 | `{ "ok": true, "schemaVersion": 1, "version": "..." }` |
| `GET /api/v1/state` | 获取完整快照，推荐作为页面初始化接口 | `ExternalApiState`（见下文） |
| `GET /api/v1/current` | 只获取当前播放和播放器/业务状态 | `schemaVersion`、`appVersion`、`timestamp`、`player`、`current`、`currentIsRequested`、`service` |
| `GET /api/v1/queue` | 只获取点歌队列和队列播放状态 | `schemaVersion`、`appVersion`、`timestamp`、`queue`、`queueLength`、`service` |

没有启用 HTTP 时，HTTP 请求不会返回数据。未知路径返回 `404`；客户端不要把 `404` 当作“队列为空”。

## WebSocket 推送

地址为：

```text
ws://127.0.0.1:5556/ws
```

连接建立后会立即收到一条完整快照。播放、队列或状态发生变化时，服务器再次推送；没有变化时不会因为时间戳变化而持续刷屏。每条消息的外层格式固定为：

```json
{
  "type": "state",
  "data": { "schemaVersion": 1, "...": "完整状态快照" }
}
```

客户端应忽略不认识的消息类型，并在连接关闭时重连。WebSocket 没有控制消息，客户端不应向服务器发送控制指令。

## `ExternalApiState` 完整示例

下面的示例展示了 `schemaVersion: 1` 的完整结构。实际歌曲、用户和播放器信息会随运行时变化；没有当前歌曲时 `current` 为 `null`。

```json
{
  "schemaVersion": 1,
  "appVersion": "1.1.3",
  "timestamp": "2026-08-03T04:00:00.000Z",
  "player": {
    "key": "NCM",
    "name": "网易云音乐",
    "connected": true,
    "connecting": false,
    "processId": 18240,
    "version": "3.1.37.205354.5",
    "status": "正在播放"
  },
  "current": {
    "id": "1403356922",
    "title": "Shelter",
    "artist": "Porter Robinson / Madeon",
    "album": "Shelter",
    "coverUrl": "https://example.invalid/cover.jpg",
    "requestedBy": "观众A",
    "requestedByUid": "10001",
    "requestedByAvatar": "https://example.invalid/avatar.jpg",
    "guardLevel": 0
  },
  "currentIsRequested": true,
  "queue": [
    {
      "id": "17154574",
      "title": "下一首歌曲",
      "artist": "示例歌手",
      "album": "示例专辑",
      "coverUrl": "https://example.invalid/queue-cover.jpg",
      "requestedBy": "观众B",
      "requestedByUid": "10002",
      "requestedByAvatar": "",
      "guardLevel": 1
    }
  ],
  "queueLength": 1,
  "service": {
    "requestIntake": {
      "enabled": true,
      "state": "accepting"
    },
    "queuePlayback": {
      "enabled": true,
      "state": "running"
    }
  },
  "accepting": true,
  "playing": true,
  "pausedAfterRequests": false,
  "commandQueue": {
    "pending": 0,
    "processing": false
  }
}
```

### 字段说明

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `schemaVersion` | `1` | 状态协议版本。当前为 `1`。 |
| `appVersion` | string | 点歌机应用版本。 |
| `timestamp` | ISO 8601 string | 该快照生成时间（UTC）。 |
| `player` | object | 当前选择的音乐播放器连接器。`connected` 是连接状态，`connecting` 是连接中的状态；`processId`、`version`、`status` 可能为空或为 `null`。 |
| `current` | `object` or `null` | 当前展示的歌曲。歌曲对象只包含文档中的字段。 |
| `currentIsRequested` | boolean | `true` 表示当前歌曲来自点歌队列；`false` 表示播放器自身的当前歌曲或没有歌曲。 |
| `queue` | array | 按实际代播顺序排列的点歌队列。数组中的歌曲使用与 `current` 相同的字段。 |
| `queueLength` | number | `queue.length`；页面可以用它显示“队列中 N 首”。 |
| `service.requestIntake.enabled` | boolean | 是否接收新的点歌请求。 |
| `service.requestIntake.state` | `accepting` or `paused` | 上一字段的展示用字符串。`paused` 表示暂停点歌，不影响当前播放。 |
| `service.queuePlayback.enabled` | boolean | 是否自动代播点歌队列。 |
| `service.queuePlayback.state` | `running` or `paused` | 上一字段的展示用字符串。`paused` 表示暂停代播点歌队列，不等同于音乐播放器真实的暂停键。 |
| `accepting` | boolean | 旧版兼容字段，等同于 `service.requestIntake.enabled`。新页面优先使用嵌套字段。 |
| `playing` | boolean | 旧版兼容字段，等同于 `service.queuePlayback.enabled`。它表示点歌队列自动播放开关，不表示播放器当前是否真的在播放。 |
| `pausedAfterRequests` | boolean | 点歌队列播完后是否处于“按设置自动暂停”的状态。它与 `queuePlayback.state` 是不同维度。 |
| `commandQueue.pending` | number | 点歌机内部待处理弹幕命令数，仅用于诊断或展示。 |
| `commandQueue.processing` | boolean | 是否正在处理一条内部弹幕命令。 |

歌曲对象字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 平台歌曲或分享标识；不要假设一定是数字。 |
| `title` | string | 歌曲名。 |
| `artist` | string | 歌手名。 |
| `album` | string | 专辑名，可能为空。 |
| `coverUrl` | string | 封面地址，可能为空；页面加载失败时应使用占位图。 |
| `requestedBy` | string | 点歌人昵称，非点歌歌曲时可能为空。 |
| `requestedByUid` | string | 点歌人 UID，可能为空。 |
| `requestedByAvatar` | string | 点歌人头像地址，可能为空。 |
| `guardLevel` | number | 点歌人身份等级；没有该信息时为 `0`。 |

`/api/v1/current` 和 `/api/v1/queue` 只是完整快照的稳定子集。需要同时渲染当前歌曲、队列和两个开关时，建议使用 `/api/v1/state` 或 WebSocket 的 `data`，避免多个请求在切歌瞬间读到不同时间点。

## 浏览器页面的 WS + HTTP 兜底

下面是一个不包含控制按钮的最小伪代码。实际项目应当把歌曲字段通过 `textContent` 写入 DOM，而不是把用户输入拼接到 `innerHTML`。

```js
const api = 'http://127.0.0.1:5556';
const wsUrl = api.replace(/^http/, 'ws') + '/ws';
let retry = 0;
let socket;

function render(state) {
  if (!state || state.schemaVersion !== 1) return;
  // current === null 时显示“暂无播放”
  // state.queue.slice(0, 5) 渲染前五首队列歌曲
  // state.service.requestIntake.state 渲染“接单中/已暂停”
  // state.service.queuePlayback.state 渲染“代播中/已暂停”
}

async function fallbackHttp() {
  const response = await fetch(`${api}/api/v1/state`, { cache: 'no-store' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  render(await response.json());
}

function connect() {
  socket = new WebSocket(wsUrl);
  socket.onopen = () => { retry = 0; };
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.type === 'state') render(message.data);
  };
  socket.onclose = async () => {
    // WS 不可用时先用 HTTP 展示，稍后再尝试 WS。
    try { await fallbackHttp(); } catch (_) { /* 页面显示离线状态 */ }
    const delay = Math.min(30_000, 1_000 * 2 ** retry++);
    setTimeout(connect, delay);
  };
  socket.onerror = () => socket.close();
}

connect();
```

页面只需要展示数据，不要实现“暂停”“接单”“清空队列”等按钮，也不要向 `/ws` 发送命令。若需要周期性 HTTP 兜底，可在 WS 断开期间每 3～5 秒调用一次 `/api/v1/state`，连接恢复后停止轮询。

## 兼容性与安全约定

1. **只依赖已文档化字段。** 服务器可能增加字段；客户端应忽略未知字段，并对缺失的可选字符串使用空值和占位图。
2. **按 `schemaVersion` 处理结构变化。** 同一主版本只做向后兼容的新增；遇到不支持的版本时显示“协议版本不兼容”，不要猜测字段含义。未来发生破坏性变化会递增 `schemaVersion`，并提供新的版本路径或迁移说明。
3. **传输范围是本机。** CORS 允许本地网页和 OBS 读取，但监听地址仍固定为 `127.0.0.1`。不要通过路由器端口映射、反向代理或公共隧道暴露未认证的接口。
4. **只读不代表可信。** 页面应把昵称、歌名、专辑和 URL 当作不可信数据处理；使用 `textContent`、属性赋值和 URL 校验，避免直接插入 HTML 或执行脚本。
5. **连接可随时中断。** 点歌机关闭外部接口、修改端口或退出时，HTTP 会失败、WebSocket 会关闭；页面应显示离线状态并自动重试。
