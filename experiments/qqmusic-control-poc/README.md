# QQ 音乐底层控制 POC

这是与 BiliNCM-TS 主程序隔离的 WinForms 测试项目。当前重点是复现
QQ 音乐右键菜单里的“下一首播放”：把目标歌曲插入当前歌曲之后，
不立即播放、不重播当前歌曲。

## 当前可用能力

- 从 QQ 音乐窗口标题读取当前歌曲；
- 250ms 轮询并产生 `TrackChanged` 日志；
- 通过文字搜索获取 QQ 音乐歌曲 `songID/songType`；
- 立即播放搜索结果（QQ 音乐单实例命令）；
- 原生“下一首播放”（精确支持已校准的 22.22 与 22.41 构建）；
- 自动查找当前 QQ 音乐实际版本目录，不再依赖固定安装根目录；
- 只读 DLL 分析器：核对版本、双 DLL 哈希、PE 结构和关键调用链；
- 只读等待并验证下一次切歌是否精确命中目标。

UI 已恢复 `/playcontrol pause/play/next` 测试入口；上一首暂时保持
停用。控制结果和原生“下一首播放”队列验证相互独立：歌单只有一首、
VIP 试听很短、歌曲自然结束或窗口标题短暂不可读时，只记录为未确认，
不会直接判定控制失败。

## 原生“下一首播放”原理

现场捕捉 QQ 音乐右键菜单操作后确认：

- 菜单入口为 `CQMListViewMenu::OnNextPlay`；
- 它把目标歌曲转换为完整的原生 `SongItem`；
- 随后在 QQ 音乐 UI 线程调用 `AddSongs(..., mode=0)`；
- 调用前后当前歌曲保持不变。

POC 使用隐藏 `/playbysongid` 请求让 QQ 音乐自己解析歌曲对象，在
最终“立即播放”分发前临时跳转到版本锁定的 UI 线程代码：

1. 从 QQ 音乐隐藏命令分类取出刚解析的 `SongItem`；
2. 在原 UI 线程调用与右键菜单相同的 `AddSongs(mode=0)`；
3. 跳过立即播放分发；
4. 恢复原始指令并释放临时内存。

成功必须同时满足：

- 内部阶段为 `NativeStage=5`；
- `GetCatManager` 与 `GetSongInfo` 返回成功；
- 解析出的 `ResolvedSongId` 与请求 songID 精确一致；
- 原始代码已恢复；
- 当前歌曲和前台窗口均未变化。

结果 `NativeNextInsertedCurrentTrackUnchangedPendingNextVerification`
表示目标已按原生调用提交、当前歌曲未受影响，正在等待下一次真实切歌
验证。它不会把“歌曲没变化”误报成切歌成功或失败。

## 已校准版本

| 文件版本 | QQMusic.dll SHA-256 | 状态 |
| --- | --- | --- |
| 22.22 | `FF0AB7911EB2ACF433F2DAF0FC4BA48FFFC64169CD822CE4D5B00E88FA180A50` | 已现场插入并重复验证 |
| 22.41 | `A5F3E917A5233D925268C34656E49096B6223B74631C5002DB606AD4B2C7A3F3` | 已完成静态调用链恢复与全部只读门禁验证 |

22.41 同时锁定 `QQMusicCommon.dll` SHA-256：
`36775378403DB33D049EE87BCAD654BA3A041B7D41259CD7EDFE65457D7E2A06`。
它的原生插入地址不是从旧版本按偏移差推算，而是重新从
`playsong` 回调、右键菜单资源、导出表和 `AddSongs` 调用图恢复。

程序启动时会自动执行一次只读分析，也可以点击“只读分析当前版本”。
只有所有强制检查通过，“设为下一首播放”才可能进入写入阶段；未知版本
只显示候选 RVA 并拒绝修改 QQ 音乐进程。

## 2026-07-30 22.22 现场验证

- 当前歌曲：`Sad Machine (Xeuphoria's Goodbye Ver.) - Xeuphoria`；
- 原生设置下一首：`songID=363196789`，
  `Everything Goes On (群星依旧) - Porter Robinson / 英雄联盟`；
- 内部结果：`NativeStage=5`、`GetSongInfo=0`、
  `ResolvedSongId=363196789`；
- 设置前后当前歌曲未变化，QQ 音乐和浏览器焦点均未变化；
- 用户随后手动点击 QQ 音乐底栏“下一首”，实际先播放
  `Everything Goes On`，验证了目标确实被插入当前项之后；
- 后续再切歌进入 `Sad Machine - Porter Robinson`，不属于第一次
  “下一首播放”的结果。

## 启动 UI

```powershell
dotnet run --project .\experiments\qqmusic-control-poc
```

使用流程：

1. 搜索歌曲；
2. 选中结果；
3. 点击“设为下一首播放（原生插入）”；
4. 确认日志显示内部 songID 与目标一致，并且当前歌曲未变化；
5. 在 QQ 音乐里手动点击底栏“下一首”；
   也可使用 POC 已恢复的“下一首”按钮；
6. POC 的只读监测器会显示“下一首已验证”或保留“未确认”结果。

## CLI

读取当前歌曲：

```powershell
dotnet run --project .\experiments\qqmusic-control-poc -- status
```

只读分析当前客户端，不发送歌曲或播放控制命令：

```powershell
dotnet run --project .\experiments\qqmusic-control-poc -- \
  analyze-native-next --read-only
```

返回 `ExecutionAllowed=true` 只表示二进制画像与安全门禁全部吻合，
不表示已经改动播放器。未知构建会返回非零退出码并列出可供人工校准的
字符串引用、菜单引用和稳定导出候选。

提交原生“下一首播放”：

```powershell
dotnet run --project .\experiments\qqmusic-control-poc -- \
  single-insert-next 363196789 0 --confirm-live-test
```

只读等待手动切歌并核对目标：

```powershell
dotnet run --project .\experiments\qqmusic-control-poc -- \
  verify-next "Everything Goes On (群星依旧)" \
  "Porter Robinson / 英雄联盟" 60 --read-only
```

只读验证结果：

- `ExpectedNextTrackConfirmed`：切歌后精确命中目标；
- `NoTrackChangeObservedQueueNotJudged`：期间没有切歌，可能是未操作或
  歌单只有一首，不判定队列失败；
- `TrackChangedButExpectedSongNotObserved`：发生真实切歌，但目标未出现；
- `ExpectedSongAlreadyPlayingCannotVerifyQueue`：验证开始时目标已在播放，
  无法据此判断队列。

UI 点击“下一首”后，如果先观察到其他歌曲，会继续等待 10 秒：

- 期间出现设定目标即确认成功；
- 目标未出现则清除待验证状态，但只报告“未确认”；
- 不会把 VIP 试听自动结束或单曲循环当作底层命令失败。

## 版本与安全边界

原生下一首实现严格锁定：

- QQ 音乐文件版本与 `QQMusic.dll / QQMusicCommon.dll` 双哈希；
- `QQMusic.exe`、两个 DLL 必须来自当前进程的同一实际版本目录；
- 两个 PE 必须是 x86，目标指令与函数必须落在预期代码/数据节；
- `GetICatMgr / GetQQUinEx` 导出、`playsong` 字符串锚点与
  `AddSongs` 调用者必须存在；
- 任一条件不匹配就拒绝执行，不把自动候选直接用于进程写入；
- 超时但 UI 回调可能仍在运行时，宁可暂留 4KB 远程内存，也不会释放
  正在执行的代码。

因此“小更新后自动恢复”是两层设计：

1. 自动分析器可在新版本中继续找到稳定字符串、菜单和导出候选；
2. 候选必须经过静态校准并加入精确画像后才能执行。

它不会为了追求“每版自动可用”而把未经确认的地址写进播放器。原因是
`SongItem` 布局、线程约束或调用语义若有一项变化，错误调用可能立即播放
目标、破坏队列，甚至使 QQ 音乐崩溃。

项目不使用 `SendInput`、系统媒体键、`WM_APPCOMMAND`、鼠标坐标或浏览器
控制，不会把播放命令发送给正在观看视频的浏览器。它不绕过会员、版权
或 DRM 限制。所有代码都位于 `experiments/qqmusic-control-poc`。
