/**
 * Every word on the site, in both languages.
 *
 * Completeness is a type, not a test: `zh` is declared as `Record<StringKey, string>` where
 * `StringKey` is derived from `en`, so a missing translation fails `tsc` and an invented key
 * fails the excess-property check. A runtime gate can only catch what types cannot express —
 * here, a key present but blank.
 *
 * Product names stay untranslated on purpose. "DeepSeek Harness" is the thing's name, `dsh`
 * is a command, and `~/.dsh` is a path; translating any of them makes the page harder to
 * follow, not easier.
 */

import { LOCALES, type Locale } from './locale.ts';

const en = {
  // --- head ---
  docTitle: 'DeepSeek Harness — the official harness, as a native app for macOS and Windows',
  metaDescription:
    'The official DeepSeek Harness wrapped as a native desktop app for macOS and Windows. A Tauri 2 shell over the system WebView, a trimmed backend, and upstream’s own UI. 98 MB installed on macOS.',
  ogImageAlt:
    'DeepSeek Harness, with a bar chart: 347 MB for the upstream install against 98 MB for this one.',
  skipToContent: 'Skip to content',

  // --- nav ---
  navDownload: 'Download',
  navSource: 'Source',
  langLabel: 'Language',

  // --- hero ---
  // The pill's version is filled in from the live update manifest; this is what it reads
  // until that lands, and what it keeps reading if the fetch fails.
  versionFallback: '—',
  heroPillMeta: 'macOS · Windows',
  heroClaim: 'The official harness, as a desktop app.',
  heroLede:
    'A Tauri 2 shell over the system WebView, a trimmed dsh backend, and dsh’s own web UI. Not one line of frontend logic is copied — the interface is upstream’s, and it follows upstream releases.',

  // --- size table ---
  sizeHeading: 'What it weighs',
  sizeUpstream: 'npm i @deepseek-ai/dsh, as-is',
  sizeBackend: 'Trimmed backend',
  sizeApp: 'Installed',
  sizeInstaller: 'Installer',
  sizeMacOs: 'macOS arm64',
  sizeWindows: 'Windows x64',
  sizeUnit: 'MB',
  sizeNote:
    'For comparison, an Electron build would be roughly 340 MB installed and 100–120 MB to download.',

  // --- what it is ---
  featuresHeading: 'How',
  webviewTitle: 'Nothing bundled that the OS already has',
  webviewBody:
    'The window renders in the system WebView — WKWebView on macOS, WebView2 on Windows. No Chromium, no second JavaScript engine — that is where most of the 249 MB went.',
  upstreamTitle: 'Upstream’s interface, verbatim',
  upstreamBody:
    'The app runs dsh’s own ui-* plugins. This project owns no line of that frontend, so it cannot fall behind it, and it injects nothing into markup upstream is free to change.',
  updateTitle: 'It updates itself',
  updateBody:
    'It asks once a day, five seconds after launch, and stays silent unless there is something to say. An offer can be taken, postponed, or skipped. The update window is native, not drawn into the app.',
  profileTitle: 'Your ~/.dsh is left alone',
  profileBody:
    'The app keeps its own trimmed profile under Application Support. From first launch that cordis.patch.yml is yours, and upgrades never overwrite it.',

  // --- download ---
  downloadHeading: 'Get it',
  ctaDownload: 'Download for macOS',
  ctaDownloadWindows: 'Download for Windows',
  ctaMeta: 'macOS 11+ · signed and notarized',
  ctaMetaWindows: 'Windows 10 1809+ · unsigned, SmartScreen asks once',
  releaseNotes: 'Release notes',
  downloadAction: 'Download',
  statusAvailable: 'Available',
  statusPlanned: 'Planned',
  plannedNote:
    'macOS and Windows ship today. Linux is here because it is next, not because it is ready.',

  // --- footer ---
  footerSource: 'Source',
  footerReleases: 'Releases',
  footerUpstream: 'Upstream project',
  footerDisclaimer:
    'An independent wrapper around the official DeepSeek Harness. Not affiliated with DeepSeek.',

  // --- 404 ---
  notFoundTitle: 'Nothing at this path',
  notFoundBody:
    'This host serves one page and a shelf of build artifacts. Whatever you asked for is neither.',
  notFoundHome: 'Back to the start',
} as const;

export type StringKey = keyof typeof en;

const zh: Record<StringKey, string> = {
  // --- head ---
  docTitle: 'DeepSeek Harness —— 官方 harness，macOS 与 Windows 的原生应用',
  metaDescription:
    '把官方 DeepSeek Harness 封装成 macOS 与 Windows 的原生桌面应用。Tauri 2 壳跑在系统 WebView 上，后端经过裁剪，界面是上游自己的。macOS 上安装后 98 MB。',
  ogImageAlt: 'DeepSeek Harness，配一张对比图：上游安装 347 MB，这个 98 MB。',
  skipToContent: '跳到正文',

  // --- nav ---
  navDownload: '下载',
  navSource: '源码',
  langLabel: '语言',

  // --- hero ---
  versionFallback: '—',
  heroPillMeta: 'macOS · Windows',
  heroClaim: '官方 harness，一个桌面应用。',
  heroLede:
    'Tauri 2 壳跑在系统 WebView 上，加一个裁剪过的 dsh 后端，加 dsh 自己的 web UI。不复制一行前端逻辑 —— 界面完全是上游的，也随上游升级。',

  // --- size table ---
  sizeHeading: '它有多大',
  sizeUpstream: 'npm i @deepseek-ai/dsh 原样',
  sizeBackend: '裁剪后的 backend',
  sizeApp: '安装后',
  sizeInstaller: '安装包',
  sizeMacOs: 'macOS arm64',
  sizeWindows: 'Windows x64',
  sizeUnit: 'MB',
  sizeNote: '对照：Electron 方案安装后约 340 MB，下载 100–120 MB。',

  // --- what it is ---
  featuresHeading: '怎么做到的',
  webviewTitle: '系统已经有的，一律不打包',
  webviewBody:
    '窗口用系统 WebView 渲染 —— macOS 上是 WKWebView，Windows 上是 WebView2。不带 Chromium，不带第二个 JavaScript 引擎 —— 省下的 249 MB 大半来自这里。',
  upstreamTitle: '上游的界面，一字不改',
  upstreamBody:
    '应用跑的是 dsh 自己的 ui-* 插件。这个项目一行前端都不拥有，所以不会落后于它，也不会往上游随时会改的 DOM 里注入任何东西。',
  updateTitle: '自己更新',
  updateBody:
    '启动 5 秒后问一次，一天最多一次，没消息就完全不出声。发现新版可以装、可以推迟、也可以跳过。更新界面是独立的原生窗口，不是画进应用里的。',
  profileTitle: '不碰你的 ~/.dsh',
  profileBody:
    '应用在 Application Support 下自带一份裁剪过的 profile。首次启动之后那份 cordis.patch.yml 就归你，升级不会覆盖。',

  // --- download ---
  downloadHeading: '拿到手',
  ctaDownload: '下载 macOS 版',
  ctaDownloadWindows: '下载 Windows 版',
  ctaMeta: 'macOS 11+ · 已签名并公证',
  ctaMetaWindows: 'Windows 10 1809+ · 未签名，SmartScreen 会问一次',
  releaseNotes: '更新日志',
  downloadAction: '下载',
  statusAvailable: '可用',
  statusPlanned: '计划中',
  plannedNote: 'macOS 与 Windows 都已发布。Linux 列在这里是因为它排在后面，不是因为它已经好了。',

  // --- footer ---
  footerSource: '源码',
  footerReleases: 'Releases',
  footerUpstream: '上游项目',
  footerDisclaimer: '对官方 DeepSeek Harness 的第三方封装，与 DeepSeek 无隶属关系。',

  // --- 404 ---
  notFoundTitle: '这个路径下什么也没有',
  notFoundBody: '这台主机只提供一个页面和一架构建产物。你要的两者都不是。',
  notFoundHome: '回首页',
};

export const STRINGS: Record<Locale, Record<StringKey, string>> = { en, zh };

/** The one flaw the type system cannot see: a key that exists but says nothing. */
export function assertStringTablesComplete(): void {
  for (const locale of LOCALES) {
    for (const [key, value] of Object.entries(STRINGS[locale])) {
      if (value.trim() === '') throw new Error(`empty string: ${locale}.${key}`);
    }
  }
}
