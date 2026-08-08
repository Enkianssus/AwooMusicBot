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
      "label": "专辑封面旋转",
      "group": "封面",
      "type": "toggle",
      "default": false
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

包只能包含 HTML、CSS、JavaScript、JSON、字体和常见图片资源。入口脚本需要是独立文件；宿主的内容安全策略不会执行内联脚本。页面运行在沙箱 iframe 中，只应调用外部只读 API。

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

参考实现位于 [AwooMusicBot-Overlay-Default](https://github.com/Enkianssus/AwooMusicBot-Overlay-Default)。
