# 嗷呜点歌机与连接器发布规范

这份文档是 `AwooMusicBot` 主程序、独立播放器连接器、QQ 兼容画像和
`app.enkianss.us` 下载代理的发布依据。自动化助手在执行任何版本号、上传、
Tag、Release 或 Cloudflare 部署任务前，必须先阅读根目录 `AGENTS.md` 和本文件。

## 1. 仓库、分支和账户边界

| 内容 | GitHub 仓库 | 默认分支 | 本地目录 |
| --- | --- | --- | --- |
| 点歌机主程序 | `Enkianssus/AwooMusicBot` | `master` | 仓库根目录 |
| 独立连接器 | `Enkianssus/awoo-connectors` | `main` | `BiliNCM-Connectors/` |

`BiliNCM-Connectors/` 是独立 Git 仓库，不是主仓库的一组普通文件。两个仓库
必须分别检查、提交和推送，不能把它们混进同一个提交。

发布前至少检查：

```powershell
git status --short --branch
git remote -v
git branch --show-current
gh auth status
```

连接器仓库需要在其目录中单独执行同样检查。必须确认：

- GitHub 当前活动账户是 `Enkianssus`。
- 主程序远端指向 `Enkianssus/AwooMusicBot`。
- 连接器仓库迁移完成后，远端指向 `Enkianssus/awoo-connectors`。
- 没有混入 `AwooMusicBot-Skins/`、Overlay、备份、实验目录、构建产物或用户的
  其它未提交改动。
- 只用 `git add -- <明确文件列表>` 暂存本次文件，禁止 `git add -A`、
  `git add .`、force push 和历史重写。

发布和部署只能使用 Enkianssus 的 GitHub 与 Cloudflare 账户。不得在任何
Enkianssus 项目、日志、提交、Worker 或公开历史中引入其它账户、Token、项目名
或标识。不得输出 GitHub Token、Cloudflare Token 或连接器签名私钥。

## 2. 远端写入授权

本地修改、测试和构建不等于远端发布授权。在执行以下任一操作前，必须获得
用户对具体目标的明确确认：

- `git push`
- 创建、移动或删除 Git Tag
- 创建、修改或删除 GitHub Release
- GitHub 仓库重命名或转移
- Cloudflare Worker 部署、路由修改、缓存清理或 D1 migration

已发布的 Tag、Release 和签名资产视为不可变内容。发现问题时发布更高版本，
不要覆盖同名 ZIP；删除 Release/Tag 或重写历史必须再次单独确认。

## 3. 点歌机版本规则

主程序使用标准三段版本：

```text
MAJOR.MINOR.PATCH
```

当前新架构属于 `1.1.x` 通道，Git Tag 使用 `v` 前缀，例如 `v1.1.10`。
`1.0.x` 是独立旧通道，不得通过版本元数据或更新代理将其静默升级到 `1.1.x`。

准备新版本时同步修改：

1. `package.json` 的 `version`。
2. `package-lock.json` 顶层 `version`。
3. `package-lock.json` 的 `packages[""].version`。
4. `package.json` 中 `build:dev` 的 `dist_electron_dev_<version>`。
5. README 中对用户可见、确实值得说明的版本变化。

推荐使用：

```powershell
npm version 1.1.10 --no-git-tag-version
```

随后手工同步 `build:dev` 的输出目录。`tests/app-version.test.mjs` 会阻止三处
版本元数据不一致。

### 主程序发布前验证

```powershell
npm ci
npm test
npm run lint
npx tsc --noEmit
npm audit --omit=dev --audit-level=high --registry=https://registry.npmjs.org
npm run build
```

正式 GitHub Action 也会执行 Lint、测试、生产依赖审计、Electron 打包和
Velopack 打包。不能因为远端还会测试，就跳过本地的低成本检查。

### 主程序上传方式

确认目标提交已经位于 `master` 后，创建与版本一致的 annotated tag：

```powershell
git push origin HEAD:master
git tag -a v1.1.10 -m "release Awoo MusicBot 1.1.10"
git push origin v1.1.10
```

`.github/workflows/release.yml` 监听 `v*`，从 Tag 解析版本并创建 GitHub
Release。不要同时手工创建另一个同名 Release。

发布完成后，Release 应至少包含以下六项，且文件名中的版本必须一致：

```text
assets.win.json
awoo-musicbot-<version>-full.nupkg
awoo-musicbot-win-Portable.zip
awoo-musicbot-win-Setup.exe
RELEASES
releases.win.json
```

还要验证：

```text
https://app.enkianss.us/update/awoo/RELEASES
https://app.enkianss.us/download/awoo
```

`RELEASES` 必须指向新版本；本站下载必须支持完整下载以及
`Range: bytes=0-0` 的 `206 Partial Content`。

## 4. 连接器版本规则

连接器版本不是普通统一 SemVer。桌面播放器连接器的前缀表达兼容的播放器
分支，最后一段才是连接器修订号。

| 连接器 | 版本格式 | 示例 | Tag | Runtime |
| --- | --- | --- | --- | --- |
| 网易云 | `P_MAJOR.P_MINOR.PATCH.BUILD.C_REV` | `3.1.37.205354.9` | `netease-v3.1.37.205354.9` | `win-x64` |
| 酷狗 | `P_MAJOR.P_MINOR.FEATURE.C_REV` | `20.0.81.5` | `kugou-v20.0.81.5` | `win-x86` |
| QQ 音乐 | `P_MAJOR.P_MINOR.C_REV` | `22.52.1` | `qqmusic-v22.52.1` | `win-x86` |
| Folia | `MAJOR.STAGE_BASELINE.REVISION` | `1.1.3` | `folia-v1.1.3` | `win-x86` |

### 网易云

- 播放器完整版本 `3.1.37.205354` 对应连接器分支前缀
  `3.1.37.205354`。
- 同一播放器分支的连接器修复只增加最后一段，例如 `.9` → `.10`。
- 支持新的播放器完整版本时更换前四段并从新的连接器 revision 开始。
- Tag 必须是五段版本；Release workflow 会拒绝其它段数。
- `.csproj` 的程序集版本受四段限制，当前采用
  `P_MAJOR.P_MINOR.PATCH.C_REV`；`InformationalVersion` 和 Catalog 使用完整
  五段版本。

### 酷狗

- 完整播放器版本可能类似 `20.0.81.27563`，但末尾 build 噪声不进入连接器
  分支号。
- 分支前缀是 `20.0.81`，连接器修订号是最后一段，如 `20.0.81.5`。
- 完整播放器 build 仍应记录在 Adapter、兼容画像、诊断和
  `testedPlayerVersion` 中。

### QQ 音乐

- 分支前缀是播放器的 `MAJOR.MINOR`，例如 `22.52`；最后一段是连接器
  revision，所以首个修订可为 `22.52.1`。
- 新 QQ 分支使用新的前两段；同分支修复只增加最后一段。
- 一个新连接器可以继续内置并加载 22.22、22.41、22.51 等旧版签名画像。
- 只增加或修正画像、且不需要新连接器代码时，优先发布独立 QQ profile
  包，而不是伪造一个新的 QQ 连接器版本。

### Folia

- Folia 没有桌面播放器文件版本，以 Stage API 合约作为兼容基线。
- 同一基线修复只增加最后一段。
- Stage API 基线变化时增加中间段并将 revision 重置。
- 只有连接器协议或打包不兼容时才增加 major。

### 自动更新边界

点歌机只会自动安装缺失连接器，或自动升级同一播放器分支中更高的最后一段。
播放器分支变化属于手动更新提示：

- 网易云比较前四段。
- 酷狗比较前三段。
- QQ 比较前两段。
- Folia 比较 major 与 Stage API 基线。

不要为了让更新按钮变成“自动”而错误沿用旧播放器前缀。
`minimumCoreVersion` 只有在连接器协议或行为真正依赖更高点歌机版本时才提高；
增加 framework-dependent 包不构成提高它的理由。

## 5. 连接器 Release 的固定资产合同

已发布的 v1 Release 是不可变的历史兼容资产。每个历史 v1 Release 原本包含
四个 ZIP 及其签名和哈希，共 12 个资产：

```text
awoo-connector-{id}-{version}-{rid}.zip
awoo-connector-{id}-{version}-{rid}-framework-dependent.zip
bilincm-connector-{id}-{version}-{rid}.zip
bilincm-connector-{id}-{version}-{rid}-framework-dependent.zip
```

这些历史资产继续服务 1.1.0–1.1.9，不能覆盖、重打包或删除。未来连接器
Release 不再沿用这组兼容资产合同；每次未来 Release 必须严格只生成 3 个资产：

```text
awoo-connector-{id}-{version}-{rid}-framework-dependent.zip
awoo-connector-{id}-{version}-{rid}-framework-dependent.zip.sig
awoo-connector-{id}-{version}-{rid}-framework-dependent.zip.sha256
```

未来 Release 的唯一 ZIP 必须满足：

- Awoo 包使用 `Awoo.Connector.<Player>.exe`。
- 不包含 legacy ZIP、self-contained ZIP 或 legacy smoke 目标。
- framework-dependent ZIP 使用点歌机私有、按架构共享的 .NET 8 Runtime；
  1.1.10 起的新客户端只安装该小包。本站代理失败时可以重试同一个签名小包
  的 GitHub Release 直链，但不得下载 SelfContained 完整包。
- `.sig` 和 `.sha256` 必须对应唯一 ZIP 的最终字节；签名后不得重新压缩、改内容
  或覆盖文件。

未来 Release 的 v2 Catalog 只记录这个唯一的 `package` 对象。旧版连接器归档和
旧版 Catalog 字段只存在于历史 v1，不得复制到未来 v2 Release。

必须保持：

```text
publicKeyId = bilincm-connectors-2026-01
```

仓库、程序或资产改名不等于签名密钥轮换。未经完整旧客户端迁移设计，不得
修改该标识或公开密钥。

## 6. 连接器代码准备与验证

连接器源代码位于独立仓库。发布前根据实际变更同步检查：

- `src/<Player>/BiliNCM.Connector.<Player>.csproj` 的版本。
- Adapter 的 `TestedVersion`。
- v2 Catalog 生成输入中的 `playerVersionPolicy` 与
  `testedPlayerVersion`。
- 新播放器画像、DLL SHA-256、CEF/API hash 或 Stage API 合约。
- 若协议字段发生变化，当前 Awoo connector smoke test 与 v2 package metadata
  是否仍保持一致；历史 v1 Catalog 不随未来 Release 改写。

最低构建验证：

```powershell
dotnet build .\BiliNCM.Connectors.slnx -c Release
```

还要运行与改动相关的 `tests/` PowerShell 规则测试或 .NET 测试 Harness。
未来 Release workflow 只发布 Awoo framework-dependent 小包，并运行 Awoo
小包 smoke test 验证 `ping`、版本、协议和 `shutdown`；该 smoke test 不是
功能测试的替代品。历史 v1 Release 不重跑、不覆盖，也不要求用未来 workflow
重新生成 legacy 资产。

## 7. 连接器上传方式

首次 v2 迁移与 Awoo MusicBot 1.1.10 的发布顺序必须保持：先完成 v2
Catalog/代理，再发布点歌机本体。迁移使用已经存在且已签名的 Awoo
framework-dependent 资产，不需要为了迁移虚构新的连接器修订号或 Tag：

1. 将 v2 workflow、Catalog 生成和 Worker/下载代理变更推送到各自已确认的远端
   分支，并从现有签名 Awoo framework-dependent 资产初始化 `catalog-v2.json`。
2. 部署并验证 `app.enkianss.us/connectors/v2/catalog.json` 及其 v2 下载代理；
   确认 Catalog 中 3 个既有资产的哈希、签名和大小一致。
3. v2 代理和 Catalog 验收通过后，才给 Awoo MusicBot 创建并推送 `v1.1.10`
   Tag。v2 尚未可用时禁止标记或发布 1.1.10。

只有未来连接器代码确实发生变化时，才将变更推送到仓库 `main` 并创建连接器
Tag；每次未来 Tag 由 workflow 生成唯一 Awoo 小包 Release 和 3 个资产。以
QQ `22.52.2` 为例：

```powershell
git push origin HEAD:main
git tag -a qqmusic-v22.52.2 -m "release QQ Music connector 22.52.2"
git push origin qqmusic-v22.52.2
```

其它连接器只替换 Tag 前缀和版本：

```text
netease-v...
kugou-v...
qqmusic-v...
folia-v...
```

`.github/workflows/release-connector.yml` 会自动：

1. 从 Tag 解析连接器、版本和 Runtime。
2. 只构建一个 Awoo framework-dependent ZIP。
3. 只执行 Awoo 小包 smoke test。
4. 对唯一 ZIP 计算 SHA-256 并使用 Ed25519 签名，创建恰好 3 个资产的
   GitHub Release。
5. 生成并由 `github-actions[bot]` 提交 `catalog-v2.json`。

不要手工重复创建 Release，也不要手工填写 v2 Catalog 中的哈希、签名、大小或
下载 URL。多个连接器连续发布时逐个等待完成；虽然 workflow 使用
`concurrency.group = connector-catalog` 且不会取消前一个任务，但 Release
出现不代表 v2 Catalog 机器人提交已经完成。历史 v1 Release 的旧 Catalog
机器人记录保持不变，不要让未来 workflow 改写它。

## 8. QQ 兼容画像发布

QQ profile 是独立的签名数据包，不包含播放器二进制或用户数据。版本使用
三段 SemVer，Tag 格式：

```text
qqmusic-profiles-vMAJOR.MINOR.PATCH
```

例如：

```powershell
git push origin HEAD:main
git tag -a qqmusic-profiles-v1.2.1 -m "release QQ Music profiles 1.2.1"
git push origin qqmusic-profiles-v1.2.1
```

`.github/workflows/release-qqmusic-profiles.yml` 会把
`profiles/qqmusic/*.json` 打包成：

```text
awoo-qqmusic-profiles-<version>.zip
bilincm-qqmusic-profiles-<version>.zip
```

两个 ZIP 都带 `.sig` 和 `.sha256`，合计六个资产；随后
`github-actions[bot]` 更新 `qqmusic-profile-catalog.json`。只有画像确实依赖
更高连接器能力时才提高 `minimumConnectorVersion`。

## 9. Catalog 与旧版兼容

公共地址是长期兼容合同：

```text
https://app.enkianss.us/connectors/v1/catalog.json
https://app.enkianss.us/connectors/v1/profiles/qqmusic/catalog.json
https://app.enkianss.us/connectors/v1/download/{id}/{version}/{asset}
https://app.enkianss.us/connectors/v2/catalog.json
https://app.enkianss.us/connectors/v2/download/{id}/{version}/{asset}
```

v1 是 1.1.0–1.1.9 的冻结兼容合同。其 Catalog 顶层连接器条目保留
legacy 包，`awooPackage` 和 `awooFrameworkDependent` 提供新命名包；历史 v1
Release 的 12 个资产保持原样：

- Awoo MusicBot 1.1.7–1.1.9 优先 Awoo 包，并保留完整包回退。
- 更早的点歌机继续读取顶层 legacy 包。
- 已发布旧二进制不回改、不重新打包，通过稳定的本站 URL、legacy 资产和
  GitHub 旧地址重定向继续兼容。

1.1.10 及以后使用独立的 v2 Catalog，不回退到 v1：

- 顶层必须是 `schemaVersion: 2`，`publicKeyId` 仍为
  `bilincm-connectors-2026-01`。
- 每个连接器只包含版本、协议、播放器兼容信息和一个签名的 `package` 对象；
  `package.deployment` 必须为 `framework-dependent`，并在对象内携带
  `runtime`、`runtimeChannel`、`asset`、`size`、`sha256`、`signature` 和
  `downloadUrl`。不再包含顶层 `asset`、`size`、`sha256`、`signature`、
  `downloadUrl`、`runtime`、`frameworkDependent`、`awooPackage` 或
  `awooFrameworkDependent` 字段。
- `package.asset` 必须是 Awoo 命名的 framework-dependent ZIP，并且
  `package.downloadUrl` 必须指向本站 `/connectors/v2/download/` 路径。包仍由
  私有共享 .NET 8 Runtime 启动；本站失败时只允许重试同一个签名 ZIP 的
  GitHub Release 直链。
- v2 条目的 `minimumCoreVersion` 不得低于 `1.1.10`。QQ 音乐画像继续使用
  独立的 v1 profile Catalog，因为它本身就是小体积资源。

因此，未来停止发布 SelfContained/legacy 大包时，先部署 v2 Worker 路由和只含
小包的 v2 Catalog，再发布使用 v2 的点歌机；不得在原 v1 Pipeline 或历史
Release 中删除资产，也不得让新客户端在 v2 不可用时静默回退 v1。若 v2 尚未
部署，1.1.10 的更新应明确报告 v2 清单 HTTP 错误，而不是下载旧的大包。

不得删除历史 v1 Release、legacy ZIP、legacy Catalog 字段、旧 Tag 或旧
Release。未来 v2 Release 不再附带这些旧资产。仓库由
`BiliNCM-Connectors` 改为 `awoo-connectors` 后，不能重新创建或复用旧仓库名，
否则 GitHub 对旧版硬编码 URL 的重定向会失效。

## 10. Cloudflare 下载代理部署

生产 Worker 源码和配置位于：

```text
BiliNCM-Connectors/cloudflare/appdownload/worker.js
BiliNCM-Connectors/cloudflare/appdownload/wrangler.toml
```

Worker 名称是 `appdownload`，配置中的账户 ID 为
`48a310efe84107a68b7ea095719805bb`。只允许使用 Enkianssus Token：

```powershell
$env:CLOUDFLARE_API_TOKEN = $env:ENKIANSSUS_CLOUDFLARE_API_TOKEN
npx wrangler whoami
npx wrangler deploy --dry-run
npx wrangler deploy
```

`whoami` 显示错误账户时立即停止。不要尝试使用其它账户的 Token 补救。

仓库改名只需要更新 Worker 的 `CONNECTOR_REPO` 和两个 Catalog 的
`repository` 展示字段。以下内容保持不变：

- Worker 名称与自定义域名
- `FEEDBACK_DB` D1 绑定
- `/connectors/v1/...` 路由与历史 v1 Catalog schema
- `/connectors/v2/...` 路由与 `catalog-v2.json` schema
- 两个 Catalog 的 `publicKeyId`

只有 D1 schema 真正变化时才执行 migration；下载路由、仓库名或页面文案变化
不需要 D1 migration。Catalog 缓存 TTL 为 300 秒，连接器版本 ZIP 使用长期
immutable 缓存，因此绝对不能用相同版本号覆盖不同内容。

## 11. 发布后验收

### 连接器或 QQ profile

未来连接器 v2 Release 只有同时满足以下条件才算完成：

1. 对应 GitHub Action 成功。
2. GitHub Release 已创建。
3. 连接器 Release 恰好有 3 个资产：一个 Awoo framework-dependent ZIP、同名
   `.sig` 和 `.sha256`；历史 v1 Release 的 12 个资产不改动。
4. 三个资产的哈希、签名和 v2 Catalog 数据一致。
5. `github-actions[bot]` 的 `catalog-v2.json` 提交已经进入 `main`。
6. `app.enkianss.us` v2 Catalog 在缓存传播后返回新版本。
7. 本站 ZIP 完整下载可用，`Range: bytes=0-0` 返回 `206`。
8. 1.1.10 从 v2 Catalog 选择 `package` framework-dependent 小包且不会下载
   SelfContained 完整包。
9. Awoo 小包 smoke test 返回正确的 `connectorId`、版本与协议版本。

QQ profile 仍按独立规则验收：两个 ZIP、各自的 `.sig` 和 `.sha256`，合计 6
个资产；profile Catalog 继续使用 v1 地址。v2 连接器发布不要求重新安装或
验收旧版点歌机；旧版兼容性由历史 v1 Release 和 Catalog 的不可变保留保证。

### 点歌机

1. `Build and Release Velopack` Action 成功。
2. 六个主程序 Release 资产齐全。
3. `RELEASES`、NUPKG、Portable ZIP 和 Setup 版本一致。
4. `app.enkianss.us/update/awoo/RELEASES` 指向新版本。
5. 本站下载和 Range 下载正常。
6. 从上一个稳定版执行一次真实更新，确认安装、重启和版本显示正确。

最终交付报告应列出提交、Tag、Release、Action 和生产代理地址，并明确写出
测试数量、构建结果、v2 Catalog bot 提交和历史 v1 资产保留结果。

## 12. 失败处理与回滚

- Action 失败时先保留日志和现场，不要立即删除 Tag 或 Release。
- 资产已经公开或进入 immutable 缓存后，使用更高版本修复，禁止覆盖原版本。
- v2 Catalog 机器人提交尚未完成时不要手工抢写 `catalog-v2.json`；先确认
  workflow 队列。历史 v1 Catalog 不得被未来 workflow 改写。
- 坏连接器优先发布更高 connector revision；点歌机本地会保留前一版本用于
  安装失败回滚。
- 删除 Release、删除 Tag、回退生产 Worker、清 Cloudflare 缓存或重写历史
  都是独立的远端破坏性操作，必须再次取得用户明确授权。
