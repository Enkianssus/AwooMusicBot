# Kugou Control POC

独立于主项目的酷狗音乐控制实验，未修改 BiliNCM-TS 原有代码。

## 结论

当前酷狗 20 客户端是原生 C++ 宿主与 CEF/Chromium 渲染进程组成的混合程序，不是 Electron，也没有向 Windows 暴露可用的 `GlobalSystemMediaTransportControlsSession`。

本 POC 已找到酷狗自身使用的后台通信入口：

- 从酷狗主窗口标题实时读取歌手和歌曲名
- 主窗口标题暂时不可用时，从 `%APPDATA%\KuGou8\KuGou.ini` 回退读取
- 每 250ms 比较“歌手 + 歌名”，仅在歌曲变化时输出 `track-changed`
- 还原酷狗窗口标题的循环跑马灯，避免长歌名滚动时被误判成多次切歌
- 对完整“歌手 - 歌名”做精确元数据回查，输出稳定的 `audio_id` 和 `hash`；
  `LastPlayingSongItem` 只作为本地队列项显示，不再当歌曲 ID
- 直接向酷狗主窗口投递已注册的内部媒体命令，不激活酷狗、不移动鼠标、不产生键盘输入
- 从 `Local\KuGouDataExchange` 共享内存的 `0x0E` 偏移读取真正的
  `TaskListener` 消息窗口句柄
- 用 `WM_COPYDATA / dwData=20 / UTF-8 JSON / wParam=0` 实现在线搜索并立即播放
- 在线负载设置 `NoPlayAds=1`；普通投递被模态层阻塞时，自动执行
  `Stop(0x40D) → WM_COPYDATA/dwData=22` 恢复
- 用 `WM_COPYDATA / dwData=1 / UTF-16 路径` 实现本地音频文件播放
- 每 250ms 检查阻塞点歌的会员试听弹窗；严格匹配酷狗进程、弹窗比例和会员页颜色后，
  支持独立窗口和嵌入主窗口/CEF 子窗口两种形态
- 独立弹窗投递 `WM_CLOSE`；嵌入弹层把窗口内消息直接投给右上角关闭控件，
  并以 Escape 窗口消息回退，不移动物理鼠标、不激活酷狗
- 保留酷狗 `Alt+Left`、`Alt+F5`、`Alt+Right` 全局快捷键作为回退
- 保留前台搜索/点击代码作为兼容实验，但新的后台命令不再使用它

## 已验证功能

- `status`：读取当前歌曲
- `watch`：持续检测切歌信号
- `next`：下一首
- `previous`：上一首
- `toggle`：切换播放/暂停
- `search-play <关键词>`：搜索并播放首条结果
- `probe-next`：执行下一首并测量切歌检测延迟
- `direct-next` / `direct-previous` / `direct-toggle`：纯后台内部消息控制
- `inspect-ipc`：显示共享内存公布的 `TaskListener` IPC 接收窗口
- `close-vip-popup`：执行一次会员试听弹窗守卫扫描
- `popup-status`：只检测并报告当前弹窗状态，不执行关闭
- `background-search-play <关键词>`：纯后台搜索并立即播放第一条结果
- `force-search-play <关键词>`：不等待普通点播，直接执行 Stop + dwData=22 强制恢复
- `background-open-file <路径>`：纯后台播放本地音频
- `background-search-next <关键词>`：实验性提交酷狗队列负载
- `background-hotkey-next`：全局快捷键回退
- `background-next`：用于证明普通 `WM_APPCOMMAND` 不可用的诊断命令

2026-07-25 的实测结果：

- “半岛铁盒”成功切换到“秘密花园”
- POC `next` 成功切换歌曲
- POC `previous` 成功返回上一首
- POC `search-play "DJ阿志 嗨曲劲爆"` 返回 `Sent: true`、`TrackChanged: true`
- `probe-next` 检测到歌曲变化，实测延迟约 1.57 秒；延迟主要来自酷狗加载歌曲
- `toggle` 已验证可以暂停并恢复播放
- `direct-next` 使用内部 ID `0x40C` 成功切歌，检测延迟约 87ms；Edge 前台和鼠标坐标均未变化
- `direct-previous` 使用内部 ID `0x40B` 成功切歌，检测延迟约 137ms；Edge 前台和鼠标坐标均未变化
- `background-hotkey-next` 成功，但只保留为兼容回退
- 普通后台 `WM_APPCOMMAND` 能投递但酷狗不响应，已明确排除

2026-07-26 的底层 IPC 实测结果：

- `Local\KuGouDataExchange` 当前解析出类名为 `TaskListener` 的消息窗口
- 本地 MP3 通过 `dwData=1` 成功切换播放，接收端返回 `1`，前台窗口和鼠标均未变化
- `background-search-play "周杰伦 稻香"` 通过 `dwData=20` 成功切歌，
  接收端返回 `1`，约 150ms 检测到变化，前台窗口和鼠标均未变化
- 在线负载使用 `wParam=0`；使用发送方窗口句柄时会激活酷狗，已经明确排除
- 实验队列负载会被接收且不激活酷狗，但尚未确认它能插入当前单曲列表，
  因此暂不标记为已完成的“下一首排队”
- 当前播放的 `Porter Robinson、Madeon - Shelter…` 已精确解析为
  `audio_id=22468461`、`hash=2968314BA604525FB74AAB2166BCCF81`；
  窗口跑马灯旋转时标题和 ID 保持不变
- `force-search-play "周杰伦 稻香"` 已验证：
  `Stop(0x40D) → dwData=22` 成功切歌，约 397ms 检测到变化，前台窗口未变化

## 运行

```powershell
dotnet run --project .\experiments\kugou-control-poc -- status
dotnet run --project .\experiments\kugou-control-poc -- watch
dotnet run --project .\experiments\kugou-control-poc -- next
dotnet run --project .\experiments\kugou-control-poc -- previous
dotnet run --project .\experiments\kugou-control-poc -- toggle
dotnet run --project .\experiments\kugou-control-poc -- probe-next
dotnet run --project .\experiments\kugou-control-poc -- search-play "周杰伦 稻香"
dotnet run --project .\experiments\kugou-control-poc -- inspect-windows
dotnet run --project .\experiments\kugou-control-poc -- inspect-ipc
dotnet run --project .\experiments\kugou-control-poc -- popup-status
dotnet run --project .\experiments\kugou-control-poc -- close-vip-popup
dotnet run --project .\experiments\kugou-control-poc -- background-search-play "周杰伦 稻香"
dotnet run --project .\experiments\kugou-control-poc -- force-search-play "周杰伦 稻香"
dotnet run --project .\experiments\kugou-control-poc -- background-search-next "陈奕迅 十年"
dotnet run --project .\experiments\kugou-control-poc -- background-open-file "C:\Music\test.mp3"
dotnet run --project .\experiments\kugou-control-poc -- direct-next
dotnet run --project .\experiments\kugou-control-poc -- direct-previous
dotnet run --project .\experiments\kugou-control-poc -- direct-toggle
dotnet run --project .\experiments\kugou-control-poc -- background-hotkey-next
dotnet run --project .\experiments\kugou-control-poc -- sessions
```

## 安全与限制

- 全局媒体键已明确禁用，因为它可能被网易云音乐等其他播放器截获。
- 纯后台路径使用酷狗 20.0.81 的内部媒体命令：
  `0x40A` 播放/暂停、`0x40B` 上一首、`0x40C` 下一首、`0x40D` 停止。
  酷狗升级后如果命令 ID 改变，需要重新运行静态分析或更新映射。
- 在线点播使用酷狗自己的网页播放负载格式和公开搜索元数据；联网失败时不会回退到鼠标操作。
- 强制恢复只能绕开阻塞控制的模态层，不能绕过 VIP/付费授权或 DRM；结果中的
  `Privilege` 非零且仍被拒绝时会明确返回权限错误。
- `background-search-next` 目前只是协议研究入口，不能据“ReceiverResult = 1”
  推断酷狗已经把歌曲排到当前项之后。
- 程序只有确认目标句柄属于酷狗、且酷狗已经成为前台窗口后才会输入或点击；否则安全失败。
- 控制坐标基于酷狗 20.0.81 的 1060×720 主窗口，并会按当前客户端尺寸等比例换算。酷狗界面改版后需要重新校准。
- `search-play` 播放搜索结果第一条，因此关键词应包含歌手和歌名以减少歧义。
- VIP 歌曲可能只能试听并弹出会员窗口；POC 不会点击购买、升级、自动续费或协议选项。
- 酷狗底栏只提供播放/暂停切换按钮，所以 `play`、`pause`、`toggle` 在原生回退模式下都是同一个切换动作；需要幂等语义时应只使用 `toggle` 或继续增加图像状态识别。
- `stop` 的 `WM_APPCOMMAND` 路径尚未验证，不建议集成。
