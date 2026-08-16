# dsh-desktop

[English](README.md) | 中文

把官方 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 封装成 macOS 桌面应用。

Tauri 2 壳（系统 WKWebView，不打包 Chromium）+ 裁剪过的 dsh 后端 + dsh 自己的 web UI。
**不复制一行前端逻辑**，界面完全是上游的 `ui-*` 插件，随上游升级。

| | 体积 |
|---|---|
| `npm i @deepseek-ai/dsh` 原样 | 344 MB |
| 裁剪后的 backend | 39 MB |
| 安装后 `.app` | 102 MB |
| DMG | 37 MB |

对照：Electron 方案约 340 MB / 100–120 MB。

## 下载

`DeepSeek-Harness-<version>-arm64.dmg` —— macOS 11+，Apple Silicon，已签名并公证。

## 跑起来

```bash
npm install
npm run icon           # 从上游 favicon + 官方品牌蓝生成图标
npm run app:dev        # 开发
npm run app:build      # 出未签名的 .app
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

公证凭据从 `NOTARIZE_KEY_ID` / `NOTARIZE_ISSUER` / `NOTARIZE_KEY_PATH` 读
（和 App Store Connect API Key 的常见约定一致）。只签名不公证：`SKIP_NOTARIZE=true`。

脚本会逐个验证嵌套二进制的签名 —— Gatekeeper 拦的是最里面那个没签的文件，
而外层 `.app` 的签名照样显示「有效」，这是 Tauri sidecar 最常见的翻车点。

## 裁剪掉了什么

改 `scripts/trim.ts` 的 `AGGRESSIVE` 开关，每一项都能单独回退。

| 开关 | 砍掉 | 省 | 代价 |
|---|---|---|---|
| `foreignProviders` | pi-ai（anthropic / google / mistral / aws / openai 五套 SDK） | 70 MB | 只剩 DeepSeek 官方通道 |
| `telemetry` | OpenTelemetry 导出 | 34 MB | 无（上游默认就是 DISABLED） |
| `fileSearch` | `@vscode/ripgrep` | 5.5 MB | **失去 grep / glob 工具** |
| `workflow` | 多智能体 workflow 编排 | 0.5 MB | 首版不做 |

还剪掉了：59 个 KaTeX 字体、全部 sourcemap 和 `.d.ts`、三个非本机平台的 node-pty prebuild。

### sharp 的 18 MB：留插件、换底座

`dsh-host-apiproxy` 把 `attachments` 写进 `static inject`，所以 `dsh-attachment-local`
**不能删**。但这个包里唯一的模型通道 `dsh-llm-deepseek` 明确拒绝图片内容
（`"The DeepSeek chat-completions adapter does not support image content."`）——
图片根本到不了模型，却要为此背 18 MB 的 libvips。

于是把 sharp 换成纯 JS 的文件头解析替身（`runtime/sharp-shim.js`，拿 PIL 生成的真图片
单测，含无损 WebP 和带 EXIF 的 JPEG 两条特殊分支）。插件照常提供 `attachments` 服务，
体积没了。

**诚实的降级**：准入期的「完整解码」校验退化成文件头校验，截断的图片会通过。
这些字节只进本地存储、永远不再解码、永远送不到模型，代价可接受。要真解码校验就把
`PACKAGE_CUTS.imageDecoding` 关掉。

**真砍不掉的**：session-query-sqlite（同样是 `static inject`）、koffi（2 MB，
macOS 上永远调不到，但 `dsh-sandbox-windows-acl` 在模块顶层做 fail-closed 的
Win32 ABI 布局自检，换桩要抄上游魔数 —— 不值）。

## 运行时：Bun + 三个构建期补丁

用 Bun 而不是 Node，省 28 MB（60 vs strip 后的 89）。Bun 缺的三样东西都在构建期补掉：

| 缺什么 | 后果 | 补法 |
|---|---|---|
| `node:module` 没有 `stripTypeScriptTypes` | 插件树起不来 | amaro 的 `strip-only`（Node 内建实现就是它），**按字节保长** |
| `runProfile` 无条件建 HMR，要 Node 内部模块 | 监听之后才崩，最难查 | 改成「组合里本来就有 HMR 才 watch」 |
| **node-pty 读不到数据** | bash 工具静默返回空 | 用 Bun 原生 PTY（`Bun.spawn({ terminal })`）做适配层 |

第三条是关键。node-pty 在 Bun 下**能 fork、能拿退出码，就是 `onData` 零回调** ——
命令确实跑了，用户什么也看不到。dsh 只用到 node-pty 的 5 个成员
（`spawn` / `pid` / `onData` / `onExit` / `write` / `kill`，没有 `resize`），
适配面很小，见 `scripts/pty-shim.ts`。

三个补丁在 Node 上都是无害的（适配层会原样转发给真的 node-pty），
所以同一份 backend 产物两个运行时通用 —— 换运行时只换 `src-tauri/binaries/` 那一个二进制：

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
  bun-shim.ts       Bun 兼容补丁
  build-backend.ts  以上全部的 IO 层
  stage-runtime.ts  strip + 临时签名，放进 sidecar 目录
  make-icon.ts      官方 favicon + 官方品牌蓝 → App 图标
  dist.sh           签名 · 公证 · staple · DMG
src-tauri/src/
  lifecycle.rs      sidecar 状态机（纯函数，转移表写死）
  backend.rs        拉起 / 地址发现 / 收尸
  home.rs           $DSH_HOME 种子
ui/index.html       加载页（零依赖，后端起来后被整个导走）
```

判断逻辑全在纯函数里，副作用集中在 `build-backend.ts` 和 `backend.rs`。

```bash
npm run check   # typecheck + format + JS 单测 + clippy + Rust 单测
```

## 已知限制

- 仅 macOS arm64。单平台是所有裁剪的前提。
- 代码搜索（grep / glob）默认关闭，见上表。
- 热重载 `cordis.patch.yml` 被关掉了（改配置需重启应用）。
- 上游 dsh 目前是 `0.1.0-rc.6`，本身处于 internal testing 阶段。
