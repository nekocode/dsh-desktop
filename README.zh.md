# dsh-desktop

[English](README.md) | 中文

把官方 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 封装成 macOS 桌面应用。

Tauri 2 壳（系统 WKWebView，不打包 Chromium）+ 裁剪过的 dsh 后端 + dsh 自己的 web UI。
**不复制一行前端逻辑**，界面完全是上游的 `ui-*` 插件，随上游升级。

| | 体积 |
|---|---|
| `npm i @deepseek-ai/dsh` 原样 | 347 MB |
| 裁剪后的 backend | 31 MB |
| 安装后 `.app` | 96 MB |
| DMG | 35 MB |

对照：Electron 方案约 340 MB / 100–120 MB。

## 下载

`DeepSeek-Harness-<version>-arm64.dmg` —— macOS 11+，Apple Silicon，已签名并公证。

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
之后这份 `cordis.patch.yml` 归你，升级不覆盖。

**不碰你的 `~/.dsh`** —— 我们的 profile 是裁剪过的，跟 CLI 装的完整版放一起会互相打架。

## 出正式包

```bash
APPLE_TEAM_ID=<你的 team> ./scripts/dist.sh
```

公证凭据从 `NOTARIZE_KEY_ID` / `NOTARIZE_ISSUER` / `NOTARIZE_KEY_PATH` 读。
只签名不公证：`SKIP_NOTARIZE=true`。

嵌套二进制由脚本自己逐个签 —— Tauri 只签外层。原因写在 `scripts/dist.sh` 里。

## 裁剪掉了什么

改 `scripts/trim.ts` 的 `AGGRESSIVE` 开关，每一项都能单独回退。

| 开关 | 砍掉 | 省 | 代价 |
|---|---|---|---|
| `foreignProviders` | pi-ai（anthropic / google / mistral / aws / openai 五套 SDK） | 70 MB | 只剩 DeepSeek 官方通道 |
| `telemetry` | OpenTelemetry 导出 | 34 MB | 无（上游默认就是 DISABLED） |
| `workflow` | 多智能体 workflow 编排 | 0.5 MB | 首版不做 |

还剪掉了：59 个 KaTeX 字体、全部 sourcemap 和 `.d.ts`、三个非本机平台的 node-pty prebuild，以及 5.5 MB 纯浏览器库 —— React、shiki、katex 进产物，
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
  dist.sh           签名 · 公证 · staple · DMG
  smoke.ts          启动产物并证明会话建得起来
src-tauri/src/
  lifecycle.rs      sidecar 状态机（纯函数，转移表写死）
  backend.rs        拉起 / 地址发现 / 收尸
  home.rs           $DSH_HOME 种子
ui/index.html       加载页（零依赖，后端起来后被整个导走）
```

判断逻辑全在纯函数里，副作用集中在 `build-backend.ts` 和 `backend.rs`。

```bash
npm run check   # typecheck + format + JS 单测 + clippy + Rust 单测
npm run smoke   # 启动产物、建会话、取客户端 bundle
```

改过裁剪之后真正要跑的是 `smoke`：坏掉的裁剪照样能启动、照样服务完整界面，只在建会话时才失败。
`app:build` 和 `app:dev` 会自动跑它。

## 已知限制

- 仅 macOS arm64。单平台是所有裁剪的前提。
- 热重载 `cordis.patch.yml` 被关掉了（改配置需重启应用）。
- 上游 dsh 目前是 `0.1.0-rc.6`，本身处于 internal testing 阶段。
