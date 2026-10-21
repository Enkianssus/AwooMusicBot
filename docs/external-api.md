# 本机只读接口（OBS 浏览器捕捉）

嗷呜点歌机提供一个只读的本机接口，方便第三方开发者制作自己的网页前端，并把网页作为 OBS 的“浏览器”来源显示。接口只提供当前播放、点歌队列、点歌提示和两个业务开关的状态，不提供任何控制命令。

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

请求地址必须使用 `127.0.0.1` 或 `localhost` 加设置中的端口（即 `Host` 请求头为 `127.0.0.1:5556` 或 `localhost:5556`）。通过其他主机名访问，例如指向本机的自定义域名，HTTP 和 WebSocket 都会返回 `403`，以防 DNS 重绑定。

| 方法与路径 | 用途 | 响应 |
| --- | --- | --- |
| `GET /health` | 检查接口是否运行 | `{ "ok": true, "schemaVersion": 1, "version": "..." }` |
| `GET /api/v1/state` | 获取完整快照，推荐作为页面初始化接口 | `ExternalApiState`（见下文） |
| `GET /api/v1/current` | 只获取当前播放和播放器/业务状态 | `schemaVersion`、`appVersion`、`timestamp`、`player`、`current`、`currentIsRequested`、`service` |
| `GET /api/v1/queue` | 只获取点歌队列、点歌提示和队列播放状态 | `schemaVersion`、`appVersion`、`timestamp`、`queue`、`queueLength`、`requestNotifications`、`service` |

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

客户端应忽略不认识的消息类型，并在连接关闭时重连。WebSocket 是只读的，没有控制消息：客户端发送任何消息，服务器都会以关闭码 `1008` 断开连接；单帧最大 4 KiB，超出时连接会被立即断开。服务器每 30 秒发送一次 ping，到下一轮仍未回应 pong 的连接会被断开；浏览器会自动回应 ping，页面无需处理。

## `ExternalApiState` 完整示例

下面的示例展示了 `schemaVersion: 1` 的完整结构。实际歌曲、用户和播放器信息会随运行时变化；没有当前歌曲时 `current` 为 `null`。

```json
{
  "schemaVersion": 1,
  "appVersion": "1.1.6",
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
    "dynamicCoverUrl": "https://mvod.itunes.apple.com/itunes-assets/example/cover.m3u8",
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
      "dynamicCoverUrl": "",
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
  },
  "requestNotifications": [
    {
      "id": "mdv8k2xa-12",
      "kind": "success",
      "action": "request",
      "title": "下一首歌曲",
      "message": "点歌成功，已加入待播队列",
      "requestedBy": "观众B",
      "createdAt": 1785729598000,
      "expiresAt": 1785729604000
    }
  ]
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
| `requestNotifications` | array | 最近的点歌、撤回和主播移出提示，最多 20 条。旧版本可能不提供，按空数组处理。完整快照、WebSocket 和 `/api/v1/queue` 均包含此字段。 |

### 队列旁的点歌提示

`requestNotifications` 中每条提示包含以下字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 同一次请求的稳定标识；等待变为结果时更新该条提示。 |
| `kind` | `waiting` / `success` / `cancelled` / `error` | 等待处理、点歌成功、歌曲已移出待播队列、请求失败。 |
| `action` | `request` / `cancel` / `remove` | 提示对应的操作：观众点歌、观众撤回、主播把歌曲移出待播队列。`kind: "cancelled"` 配合 `cancel` 表示观众撤回成功，配合 `remove` 表示主播移除；`kind: "error"` 配合 `request` 或 `cancel` 区分点歌失败与撤回失败。旧版本没有此字段，缺失时按 `request` 处理；以后可能增加取值，不认识的值也按 `request` 处理。 |
| `title` | string | 点歌在搜索前为关键词，成功后为实际歌名；未填写歌名时为“未填写歌名”。不带歌名的撤回在完成前为“最近一首点歌”，成功后为实际撤回的歌名。主播移除时为被移除的歌名。 |
| `message` | string | 等待说明、操作结果或失败原因，仅供展示，不要用它判断操作类型。 |
| `requestedBy` | string | 发起操作的观众昵称；`action` 为 `remove` 时为“主播”。 |
| `createdAt` | number | 最近一次更新的 Unix 时间，单位毫秒。 |
| `expiresAt` | number | 提示失效的 Unix 时间，单位毫秒。结果保留 6 秒，等待状态最多保留 120 秒。 |

`action` 是 `schemaVersion: 1` 内的新增字段，旧页面忽略它即可继续工作。页面应按 `id` 更新提示，并在 `expiresAt` 到期时主动移除，即使没有新快照也应消失；提示也可能在到期前从列表中消失（例如暂停点歌期间被合并的等待提示），此时以最新快照为准。可用快照 `timestamp` 校准时钟；重复快照和重连不得重置到期时间。建议最多同时显示两条，歌名和原因都通过 `textContent` 渲染。

`success` 在歌曲加入待播队列（或播放器确认开始播放）后立即发布，不等待播放器同步，也不承诺播放器已开始播放：立即播放未确认但歌曲已保留队首时，`message` 会说明正在等待播放；当前 QQ 音乐版本暂不支持自动插入时，`message` 会说明歌曲已保留在待播队列、等待主播处理。暂停点歌期间，失败提示每 10 秒最多出现一条。只有直播间弹幕会产生提示，本机测试点歌接口和诊断面板不会。不要通过队列增减猜测点歌或撤回结果，因为自动切歌也会改变队列。

歌曲对象字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 平台歌曲或分享标识；不要假设一定是数字。 |
| `title` | string | 歌曲名。 |
| `artist` | string | 歌手名。 |
| `album` | string | 专辑名，可能为空。 |
| `coverUrl` | string | 封面地址，可能为空；页面加载失败时应使用占位图。 |
| `dynamicCoverUrl` | string | 当前歌曲匹配到的 Apple Music 动态封面视频（HLS `.m3u8` 或 MP4）。“外观 → 动态封面”默认开启，先返回普通封面，再异步提供动态地址；歌曲持续播放约 2 秒后才开始查询，快速切过的歌曲不会查询。关闭、未匹配到、查询失败或队列歌曲时为空。旧版本可能不提供，按空字符串处理。 |
| `requestedBy` | string | 点歌人昵称，非点歌歌曲时可能为空。 |
| `requestedByUid` | string | 点歌人 UID，可能为空。 |
| `requestedByAvatar` | string | 点歌人头像地址，可能为空。 |
| `guardLevel` | number | 点歌人身份等级；没有该信息时为 `0`。 |

动态封面只丰富当前曲目，不预加载队列。页面应先显示 `coverUrl`，收到 `dynamicCoverUrl` 后加载静音循环视频，等视频可播放后替换；任何网络、格式或自动播放错误都保留普通封面。HLS 可使用 Hls.js；内置 OBS 展示页从本机 `/overlay/vendor/hls.min.js` 加载依赖。切歌或地址清空时应销毁播放器并释放视频资源。素材来自 Apple Music 网页匹配，部分歌曲没有动态素材；不影响音乐播放器和点歌队列。

`/overlay/vendor/hls.min.js` 是点歌机内置的 hls.js 浏览器构建，Mod UI 也可以直接加载。它带有 `ETag` 和 `Cache-Control: no-cache`：浏览器每次都会校验，文件未变化时只返回 `304`。另有带版本号的别名 `/overlay/vendor/hls-<版本>.min.js`（例如 `hls-1.7.3.min.js`，版本号与内置 hls.js 一致），内容永不变化，可长期缓存（`Cache-Control: public, max-age=31536000, immutable`）；点歌机升级内置 hls.js 后，旧版本号的地址会返回 `404`。需要始终可用的地址时，请使用不带版本号的路径。

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
3. **本机任何网页都能读取。** 只读接口返回 `Access-Control-Allow-Origin: *`，WebSocket 也不校验来源，因此这台电脑上打开的任何网页（包括普通网站）都能读取当前播放、点歌队列和点歌人昵称、头像。接口只接受 `127.0.0.1` 和 `localhost` 主机名，监听地址固定为 `127.0.0.1`，局域网和公网无法直接访问。不要通过路由器端口映射、反向代理或公共隧道暴露未认证的接口。
4. **只读不代表可信。** 页面应把昵称、歌名、专辑和 URL 当作不可信数据处理；使用 `textContent`、属性赋值和 URL 校验，避免直接插入 HTML 或执行脚本。
5. **连接可随时中断。** 点歌机关闭外部接口、修改端口或退出时，HTTP 会失败、WebSocket 会关闭；页面应显示离线状态并自动重试。
