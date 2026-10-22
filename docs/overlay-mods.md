# Mod UI 开发与发布

嗷呜点歌机 1.1.6 起支持安装纯静态 OBS Mod UI，并可在“外观设置”中实时预览和保存每个 UI 自己的参数。OBS 始终使用点歌机“运行状态”中显示的 `/overlay/` 地址；安装或切换主题不会改变这个地址。

## ZIP 结构

ZIP 根目录必须包含：

```text
overlay.json
index.html
styles.css
app.js
```

`overlay.json` 示例：

```json
{
  "schemaVersion": 1,
  "id": "com.example.my-overlay",
  "name": "我的 OBS 组件",
  "version": "1.0.0",
  "entry": "index.html",
  "author": "Example",
  "description": "透明的当前歌曲与待播队列组件",
  "homepage": "https://github.com/example/my-overlay",
  "minAppVersion": "1.1.6"
}
```

`settings` 可选；旧 Mod 不声明时仍会照常安装和运行。声明后，点歌机会自动生成实时参数面板，并按 Mod `id` 独立缓存用户设置：

```json
{
  "settings": [
    {
      "key": "accentColor",
      "label": "强调色",
      "group": "颜色",
      "type": "color",
      "default": "#c6a3ff",
      "cssVariable": "--accent"
    },
    {
      "key": "panelOpacity",
      "label": "面板不透明度",
      "group": "外观",
      "type": "range",
      "default": 0.94,
      "min": 0.2,
      "max": 1,
      "step": 0.02,
      "cssVariable": "--panel-opacity"
    },
    {
      "key": "coverRotation",
      "label": "当前图片旋转",
      "group": "图片动画",
      "type": "toggle",
      "default": false
    },
    {
      "key": "artworkSource",
      "label": "Mod UI 当前歌曲图片",
      "group": "Mod UI 歌曲图片",
      "type": "select",
      "default": "album_cover",
      "options": [
        { "label": "专辑封面（默认）", "value": "album_cover" },
        { "label": "点歌人头像", "value": "requester_avatar" }
      ]
    }
  ]
}
```

支持的控件类型：

- `color`：颜色选择器，默认值必须是 `#RRGGBB`。
- `range`：滑杆与精确数字输入，需要 `min`、`max`、`step` 和数值默认值。
- `toggle`：开关，默认值为布尔值。
- `select`：下拉选择，需要 `{ "label", "value" }` 组成的 `options`。
- `text`：短文本，可使用 `maxLength` 和 `placeholder`。

每项参数都会自动写入它的 `cssVariable`；没有填写时会根据 `key` 生成 `--awoo-*` 变量。数值参数可用受限的 `cssUnit`：`px`、`rem`、`em`、`%`、`deg`、`s`、`ms`、`vh` 或 `vw`。同时根元素会得到形如 `data-awoo-setting-cover-rotation="true"` 的属性，纯 CSS Mod 无需编写额外设置代码。

颜色预设也可以只用 CSS 完成。内置 UI 的“颜色主题”是一个 `select` 参数，样式表按 `html[data-awoo-setting-theme="blue-light"] .widget { … }` 重新定义配色变量。颜色参数的变量以内联样式写在 `<html>` 上，所以预设要定义在 `.widget` 这类子元素上才能覆盖它们；未选预设时，`<html>` 上的取色值照常生效。

需要用 JavaScript 响应参数时，可以监听宿主自动注入的事件：

```js
window.addEventListener('awoo-overlay-settings', event => {
  const values = event.detail.values;
  console.log(values.coverRotation);
});

// 也可以在任意时刻读取或订阅。
const current = window.AwooOverlay?.getSettings() || {};
const unsubscribe = window.AwooOverlay?.subscribe(detail => {
  console.log(detail.values);
});
```

参数调整会同步到点歌机内预览和 OBS，不改变浏览器捕捉地址。Mod 切换、重启和兼容更新都会保留各自设置；用户也可以单独恢复某个 Mod 的默认值。

包只能包含 HTML、CSS、JavaScript、JSON、字体和常见图片资源。入口脚本需要是独立文件；宿主的内容安全策略不会执行内联脚本。页面运行在沙箱 iframe 中，只应调用外部只读 API，具体限制见下文“Mod 网络与 CSP”。

## GitHub 仓库识别

在 GitHub Release 中同时上传固定名称的两个资产：

- `awoo-overlay.zip`
- `awoo-overlay.json`

发布清单格式：

```json
{
  "schemaVersion": 1,
  "packageType": "awoo-overlay",
  "id": "com.example.my-overlay",
  "name": "我的 OBS 组件",
  "version": "1.0.0",
  "package": {
    "url": "https://github.com/example/my-overlay/releases/download/v1.0.0/awoo-overlay.zip",
    "size": 12345,
    "sha256": "64 位小写 SHA-256"
  }
}
```

用户输入仓库首页时，点歌机会读取 `releases/latest/download/awoo-overlay.json`。官方示例仓库会优先走 `app.enkianss.us` 代理；社区仓库直接读取 GitHub Release，无法访问 GitHub 时仍可下载 ZIP 后拖入安装。

## 读取状态

- `GET /api/v1/state`：完整只读快照。
- `GET /api/v1/current`：当前歌曲。
- `GET /api/v1/queue`：待播队列。
- `WebSocket /ws`：状态变化推送，消息为 `{ "type": "state", "data": ... }`。

## Mod 网络与 CSP

Mod 页面运行在 `sandbox="allow-scripts"` 的 iframe 中，请求来源为 `null`。宿主为 Mod 内容附加以下内容安全策略（CSP）：

| 指令 | 允许 | 对 Mod 的影响 |
| --- | --- | --- |
| `script-src` | `'self'` | 只能加载包内脚本和 `/overlay/vendor/` 下的依赖；内联脚本和 `eval` 不会执行。 |
| `style-src` | `'self' 'unsafe-inline'` | 可使用包内样式表、`<style>` 和行内样式。 |
| `connect-src` | `http://127.0.0.1:*`、`ws://127.0.0.1:*`、`http://localhost:*`、`ws://localhost:*`、`https://*.itunes.apple.com`、`https://*.mzstatic.com` | `fetch` 和 WebSocket 只能访问本机回环地址和 Apple 动态封面域名，不能请求其他网站。 |
| `media-src` | `blob:`、`https://*.itunes.apple.com`、`https://*.mzstatic.com` | `<video>` 只能播放 Apple 动态封面，或 Hls.js 生成的 `blob:` 地址。 |
| `img-src` | `http:`、`https:`、`data:`、`blob:` | 封面和头像可以直接使用接口返回的地址。 |
| `font-src` | `'self' data:` | 字体需要放进 ZIP，或以 `data:` 内联。 |
| `object-src`、`base-uri` | `'none'` | 不能嵌入插件；`<base>` 标签无效，请使用相对入口 HTML 的路径。 |

### 只读接口

Mod 只能使用外部只读接口，也就是 `/overlay/` 页面所在的端口（默认 `5556`）。用页面自身的 `location.port` 拼接 `http://127.0.0.1:端口/api/v1/state` 和 `ws://127.0.0.1:端口/ws`，用户改过端口时也能正常工作。点歌机窗口使用的内部管理接口（默认 `5555`）会拒绝来自 Mod 的请求；它的路径和字段也不属于公开协议，可能随版本变化。

### 动态封面

歌曲对象的 `dynamicCoverUrl` 是 Apple Music 动态封面（HLS `.m3u8` 或 MP4），只有 `current` 可能有值。动态封面关闭、未匹配到或查询失败时为空字符串，队列歌曲始终为空。请先显示 `coverUrl`，收到动态地址后再加载静音循环视频，等视频能播放时再替换；任何错误都保留静态封面。

播放 HLS 需要 Hls.js。宿主在同源路径提供随点歌机附带的版本，Mod 无需自行打包：

- `/overlay/vendor/hls.min.js`：固定地址，始终对应当前附带的版本，推荐 Mod 使用。
- `/overlay/vendor/hls-<版本号>.min.js`（例如 `hls-1.7.3.min.js`）：带版本号的别名，内容不会变化，可长期缓存；只提供当前附带的版本，点歌机升级 Hls.js 后旧文件名不再可用。

Hls.js 约 600 KB，建议在第一次收到 `.m3u8` 地址时再插入 `<script src="/overlay/vendor/hls.min.js">`，脚本加载完成前保留静态封面。内置 UI 就是这样加载的。

### 点歌提示

`requestNotifications` 是队列旁的短时提示。用 `kind` 区分状态，用 `action` 区分是谁做了什么：

| `kind` | `action` | 内置 UI 显示 |
| --- | --- | --- |
| `waiting` | `request` 或 `cancel` | 待处理 |
| `success` | `request` | 点歌成功 |
| `error` | `request` | 点歌失败 |
| `error` | `cancel` | 撤回失败 |
| `cancelled` | `cancel` | 撤回成功 |
| `cancelled` | `remove` | 主播已移出 |

`action` 为 `remove` 时，`requestedBy` 固定为“主播”，不要显示成观众撤回。缺少 `action` 或遇到不认识的值时按 `request` 处理，不要根据 `message` 文本判断操作类型。请按 `id` 更新同一张卡片，在 `expiresAt` 到期时主动移除，并避免遮挡待播歌曲。完整字段见 [本机只读接口](external-api.md)。

参考实现位于 [AwooMusicBot-Overlay-Default](https://github.com/Enkianssus/AwooMusicBot-Overlay-Default)。
