# dsh-desktop

[English](README.md) | 中文

把官方 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 封装成桌面应用，macOS 与 Windows。

Tauri 2 壳（系统 WebView，不打包 Chromium）+ 裁剪过的 dsh 后端 + dsh 自己的 web UI。
**不复制一行前端逻辑**，界面完全是上游的 `ui-*` 插件，随上游升级。

| | macOS arm64 | Windows x64 |
|---|---|---|
| `npm i @deepseek-ai/dsh` 原样 | 347 MB | 347 MB |
| 裁剪后的 backend | 31 MB | 33 MB |
| 安装后 | 98 MB | 130 MB |
| 安装包 | 36 MB（DMG） | 32 MB（setup.exe） |

Windows 装得更大、下得更小：`bun.exe` 比 macOS 版大 34 MB（PE 的符号在独立 `.pdb` 里，
macOS 上那一刀 strip 在这里无处可砍），而 NSIS 的 solid LZMA 比 DMG 压得更狠。

对照：Electron 方案约 340 MB / 100–120 MB。

## 下载

[**dsh-desktop.xiu.ai**](https://dsh-desktop.xiu.ai/)

- [`DeepSeek-Harness-arm64.dmg`](https://dsh-desktop.xiu.ai/dl/latest/DeepSeek-Harness-arm64.dmg)
  —— macOS 11+，Apple Silicon，已签名并公证。
- [`DeepSeek-Harness-x64-setup.exe`](https://dsh-desktop.xiu.ai/dl/latest/DeepSeek-Harness-x64-setup.exe)
  —— Windows 10 1809+，x64。没做 Authenticode 签名，SmartScreen 会问一次：**更多信息 → 仍要运行**。

历史版本在 [Releases](https://github.com/nekocode/dsh-desktop/releases) 页。

站点由 `npm run build:web` 从 `web-src/` 生成，作为下载 Worker 的静态资源分发 —— 只有一个域名，
因为这个域名已经被那个 Worker 以 custom domain 独占，别的东西抢不走。

## 跑起来

```bash
npm install
npm run icon           # 从上游 favicon + 官方品牌蓝生成图标
npm run app:dev        # 开发
npm run app:build      # 构建 backend、smoke 验证、出未签名的 .app
npm run check          # typecheck + format + JS 单测 + clippy + Rust 单测
```

首次启动会把 profile 种子铺到
`~/Library/Application Support/com.nekocode.dsh-desktop/dsh-home/`，
之后这份 `cordis.patch.yml` 归你，升级不覆盖。profile 里其余文件归构建 ——
它们声明这一版带哪些插件 —— 升级时会被刷新。

**不碰你的 `~/.dsh`** —— 我们的 profile 是裁剪过的，跟 CLI 装的完整版放一起会互相打架。

## 出正式包

两个安装包都在 macOS 上出；加 `--release` 顺带发布。

```bash
./scripts/dist.sh                   # macOS：构建 · 签名 · 公证 · DMG · 更新包
npm run app:build:win               # Windows：→ dist/DeepSeek-Harness-<version>-x64-setup.exe + .sig
npm run deploy:dist                 # 重新部署下载 Worker（很少用到）
```

凭据放 `scripts/.env.local`，脚本自己 source：Apple 的 `APPLE_TEAM_ID` 和
`NOTARIZE_KEY_ID` / `NOTARIZE_ISSUER` / `NOTARIZE_KEY_PATH`，以及更新签名用的
`TAURI_SIGNING_PRIVATE_KEY_PATH` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`。
只签名不公证：`SKIP_NOTARIZE=true` —— 这样出的包 `--release` 会拒绝发布。
更新公钥烤在 `tauri.conf.json` 里，**私钥丢了，所有已安装的副本就永远更新不了了** ——
新钥匙塞不进旧包。

**macOS。** `dist.sh` 替 Tauri 做对了两件事，原因是同一个：Tauri 的产物是在签名**之前**打出来的 ——
嵌套二进制逐个自己签，不只签外层；DMG 和更新包都从已签名、已公证、已 staple 的 `.app` 现做，
`createUpdaterArtifacts` 是故意关着的。打完的 tar 包会再解开验一遍 —— 用户装的是那个压缩包，
不是它来源的那个目录。

**Windows**，一次性准备：

```bash
cargo install cargo-xwin                  # 首次使用时自动拉 MSVC CRT 与 Windows SDK
rustup target add x86_64-pc-windows-msvc
brew install llvm makensis                # llvm-rc 编资源脚本，makensis 出安装包
mkdir -p build/upstream-win32-x64
cp build/upstream-darwin-arm64/package.json build/upstream-win32-x64/
(cd build/upstream-win32-x64 && npm i --ignore-scripts --os=win32 --cpu=x64)
```

最后那次安装不是多余的：npm 按**执行安装的那台机器**解析 `optionalDependencies`，
所以 Windows 产物必须有自己的暂存目录，否则会把 macOS 的原生包装进去。
`DSH_TARGET` 决定构建读哪一个，`scripts/target.ts` 收着每一条按目标不同的事实 ——
没有一条是从宿主推出来的。

因为这条链路里没有 Windows 机器：**`npm run smoke` 自己跳过**（产物在这里跑不起来，验证放到真机上），
且**不做 Authenticode 签名** —— 更新签名（minisign）照出，那是已安装副本会校验的东西；
为什么现在买证书也去不掉 SmartScreen 的提示，见「已知限制」。安装包在进 `dist/` 的路上还会改名：
Tauri 按 `productName` 命名，里面**带空格**，而下载 Worker 的路由白名单不收 —— 本地全绿，上线 404。

Windows 版**不带 node-pty**：Bun 1.3.14 起 `Bun.Terminal` 原生驱动 ConPTY，
`scripts/pty-shim.ts` 本来就是能力探测，所以没有任何需要按平台编译或匹配的东西。

## 裁剪掉了什么

改 `scripts/trim.ts` 的 `AGGRESSIVE` 开关，每一项都能单独回退。

| 开关 | 砍掉 | 省 | 代价 |
|---|---|---|---|
| `foreignProviders` | pi-ai（anthropic / google / mistral / aws / openai 五套 SDK） | 70 MB | 只剩 DeepSeek 官方通道 |
| `telemetry` | OpenTelemetry 导出 | 34 MB | 无（上游默认就是 DISABLED） |
| `workflow` | 多智能体 workflow 编排 | 0.5 MB | 首版不做 |

还剪掉了：59 个 KaTeX 字体、全部 sourcemap 和 `.d.ts`、除目标平台外的全部 node-pty prebuild
（Windows 上是**全部**，外加它们旁边那 28 MB 的 `.pdb` 调试符号），以及 5.5 MB 纯浏览器库 —— React、shiki、katex 进产物，
只是因为 nft 追踪了没有任何组合行加载的 `@deepseek-ai` 包，而浏览器是从预构建前端 bundle 拿的。

另有两个依赖是**换掉**而不是砍掉 —— 一个是插件删不得，一个是工具值得留：

| 换 | 从 | 到 |
|---|---|---|
| `imageDecoding` | sharp + libvips，18 MB | 纯 JS 文件头解析，`runtime/sharp-shim.js` |
| `nativeRipgrep` | `@vscode/ripgrep` 二进制，4.3 MB | 同一个 ripgrep 的 wasm 版，768 KB，`runtime/ripgrep-shim.js` |

sharp 能换，是因为这个包里唯一的模型通道明确拒绝图片，字节根本到不了模型；代价是准入校验
从完整解码退化成文件头校验。ripgrep 留下，是因为代码搜索值这个体积 —— wasm 版产出逐字节
相同的 `--json` 记录、相同的 `.gitignore` 语义，留住搜索总共只花 0.9 MB。代价是慢 3–9 倍，
且比值最差的地方绝对值最小：常见仓库搜索 74ms，原生 8.5ms。

每一刀和每一次替换为什么安全、不安全时会怎么炸，都写在做决定的地方：
`scripts/trim.ts` 和两个 shim。

## 运行时：Bun + 三个构建期补丁

用 Bun 而不是 Node，省 28 MB（60 vs strip 后的 89）。Bun 缺的三样东西都在构建期补掉：

| 缺什么 | 后果 | 补法 |
|---|---|---|
| `node:module` 没有 `stripTypeScriptTypes` | 插件树起不来 | amaro 的 `strip-only`，按字节保长 |
| `runProfile` 无条件建 HMR，要 Node 内部模块 | 服务已在监听之后才崩 | 组合里本来就有 HMR 才 watch |
| **node-pty 读不到数据** | bash 工具静默返回空 | Bun 原生 PTY 适配层，`scripts/pty-shim.ts` |

三个补丁在 Node 上都无害，所以同一份 backend 产物两个运行时通用 ——
换运行时只换 `src-tauri/binaries/` 那一个二进制：

```bash
DSH_RUNTIME=node npm run stage:runtime
```

## 结构

```
scripts/
  compose.ts        解析 dsh 的组合清单（两个平面）
  trim.ts           裁剪开关表：砍什么、为什么、省多少
  backend-plan.ts   算出 nft 入口集和要剔除的包
  prune.ts          文件级裁剪规则
  preset-patch.ts   改 agent preset 组合（shipped root 用户层盖不住）
  import-rewrite.ts 把上游 import 指向 shim 的统一机制
  *-shim.ts         各个 shim：Bun 兼容、node-pty、sharp、ripgrep
  build-backend.ts  以上全部的 IO 层
  stage-runtime.ts  strip + 临时签名，放进 sidecar 目录
  make-icon.ts      官方 favicon + 官方品牌蓝 → App 图标
  dist.sh           签名 · 公证 · staple · DMG · 更新包 · 发布
  dist-paths.ts     分发拓扑：一张表，发布脚本和 Worker 共读
  dist-worker.ts    把 R2 暴露成 dsh-desktop.xiu.ai 的 Cloudflare Worker
  manifest.ts       更新清单，以及它会怎么静默出错
  publish.ts        上传 · 回读比对 · GitHub Release
  smoke.ts          启动产物并证明会话建得起来
src-tauri/src/
  lifecycle.rs      sidecar 状态机（纯函数，转移表写死）
  backend.rs        拉起 / 地址发现 / 收尸
  home.rs           $DSH_HOME 种子，以及其中哪个文件归用户
  menu.rs           应用菜单，唯一的新增是 Check for Updates…
  update/           状态机 · 策略 · 偏好 · 编排
ui/index.html       加载页（零依赖，后端起来后被整个导走）
ui/update.html      更新窗口（零依赖，有消息才打开）
```

判断逻辑全在纯函数里，副作用集中在 `build-backend.ts` 和 `backend.rs`。

```bash
npm run check   # typecheck + format + JS 单测 + clippy + Rust 单测
npm run smoke   # 启动产物、建会话、取客户端 bundle
```

改过裁剪之后真正要跑的是 `smoke`：坏掉的裁剪照样能启动、照样服务完整界面，只在建会话时才失败。
`app:build` 和 `app:dev` 会自动跑它。

## 已知限制

- macOS arm64 与 Windows x64。「一个平台一份产物」是所有裁剪的前提：各自有独立的上游暂存目录、
  各自的原生包、各自的更新清单。
- **Windows 安装包没做 Authenticode 签名**，SmartScreen 首次下载会弹「Windows 已保护你的电脑」，
  点**更多信息 → 仍要运行**即可安装。签名也去不掉这个提示 —— Microsoft 2024 年移除了
  EV 证书「立即获得信誉」的行为，OV 和 EV 现在都要靠下载量攒。自动更新不受影响：
  updater 自己下载安装包，文件不带 mark-of-the-web。
- 热重载 `cordis.patch.yml` 被关掉了（改配置需重启应用）。
- 上游 dsh 目前是 `0.1.0-rc.6`，本身处于 internal testing 阶段。
