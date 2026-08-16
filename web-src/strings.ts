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
 *
 * House style for the copy: short sentences, plain words, no line that could not be said out
 * loud to someone who asked what this is.
 */

import { LOCALES, type Locale } from './locale.ts';

const en = {
  // --- head ---
  docTitle: 'DeepSeek Harness — a desktop app for macOS and Windows',
  metaDescription:
    'The official DeepSeek Harness, packaged as a desktop app for macOS and Windows. It runs on the WebView your system already has, so it installs at 98 MB instead of 347 MB, and the interface is upstream’s own.',
  ogImageAlt:
    'DeepSeek Harness, with a bar chart: 347 MB for the npm install against 98 MB for this app.',
  skipToContent: 'Skip to content',

  // --- banner ---
  // One sentence, with the sponsor's name inside it: the renderer links the name wherever the
  // translation puts it, so neither language has to be bent around a fixed link position.
  sponsorNote: 'All the tokens behind this project are provided by xiu.ai.',

  // --- nav ---
  navDownload: 'Download',
  navSource: 'Source',
  langLabel: 'Language',

  // --- hero ---
  // The tag's version is filled in from the live update manifest; this is what it reads
  // until that lands, and what it keeps reading if the fetch fails.
  versionFallback: '—',
  heroTagMeta: 'macOS · Windows',
  heroClaim: 'The official harness, in an app window.',
  heroLede:
    'The same dsh you install from npm, with an icon in the dock and no terminal to keep open. The window is drawn by the WebView your system already ships, and the interface is upstream’s own: this project does not copy it and does not patch it.',

  // --- size table ---
  sizeHeading: 'How big it is',
  sizeUpstream: 'npm i @deepseek-ai/dsh, as-is',
  sizeBackend: 'Trimmed backend',
  sizeApp: 'Installed',
  sizeInstaller: 'Installer',
  sizeMacOs: 'macOS arm64',
  sizeWindows: 'Windows x64',
  sizeUnit: 'MB',
  sizeNote: 'The same app on Electron would be about 340 MB installed and 100–120 MB to download.',

  // --- what it is ---
  featuresHeading: 'How it works',
  webviewTitle: 'No browser bundled',
  webviewBody:
    'The window is drawn by the system WebView: WKWebView on macOS, WebView2 on Windows. No Chromium, no second JavaScript engine. Most of the 249 MB saved comes from there.',
  upstreamTitle: 'Upstream’s interface, untouched',
  upstreamBody:
    'The app loads dsh’s own ui-* plugins. No frontend code is copied, and nothing is injected into the page, so what you get is what upstream ships.',
  updateTitle: 'It updates itself',
  updateBody:
    'It checks once a day, five seconds after launch, and stays quiet when there is nothing new. Install it, put it off, or skip that version. The prompt is a small native window.',
  profileTitle: 'It leaves your ~/.dsh alone',
  profileBody:
    'The app keeps its own config under Application Support. After the first launch that cordis.patch.yml is yours to edit, and updates never overwrite it.',

  // --- download ---
  downloadHeading: 'Get it',
  ctaDownload: 'Download for macOS',
  ctaDownloadWindows: 'Download for Windows',
  ctaMeta: 'macOS 11+ · signed and notarized',
  ctaMetaWindows: 'Windows 10 1809+ · SmartScreen asks once',
  releaseNotes: 'Release notes',
  downloadAction: 'Download',
  statusPlanned: 'Not yet',
  macNote: 'macOS 11 or later, Apple Silicon. Signed and notarized, so it opens on the first try.',
  windowsNote:
    'Windows 10 1809 or later. Not signed yet, so SmartScreen asks once: More info, then Run anyway.',
  linuxNote: 'Nothing to download yet. Linux is the next one we build, and it is not ready today.',

  // --- footer ---
  footerSource: 'Source',
  footerReleases: 'Releases',
  footerUpstream: 'Upstream project',
  footerDisclaimer:
    'A third-party wrapper around the official DeepSeek Harness. Not affiliated with DeepSeek.',

  // --- 404 ---
  notFoundTitle: 'Nothing here',
  notFoundBody: 'This host serves one page and a shelf of builds. You asked for neither.',
  notFoundHome: 'Back to the start',
} as const;

export type StringKey = keyof typeof en;

const zh: Record<StringKey, string> = {
  // --- head ---
  docTitle: 'DeepSeek Harness —— macOS 与 Windows 上的桌面应用',
  metaDescription:
    '把官方 DeepSeek Harness 装进 macOS 和 Windows 的桌面应用。窗口交给系统自带的 WebView 画，所以装完是 98 MB，而不是 347 MB；界面就是上游那一套。',
  ogImageAlt: 'DeepSeek Harness，一张对比图：npm 装下来 347 MB，这个应用 98 MB。',
  skipToContent: '跳到正文',

  // --- banner ---
  sponsorNote: '本项目所有算力由 xiu.ai 提供',

  // --- nav ---
  navDownload: '下载',
  navSource: '源码',
  langLabel: '语言',

  // --- hero ---
  versionFallback: '—',
  heroTagMeta: 'macOS · Windows',
  heroClaim: '官方 harness，装进桌面应用。',
  heroLede:
    '和你用 npm 装的 dsh 是同一套东西，只是多了个图标，也不用一直开着终端。窗口交给系统自带的 WebView 画，界面完全是上游的：这个项目既不复制它，也不改它。',

  // --- size table ---
  sizeHeading: '它有多大',
  sizeUpstream: 'npm i @deepseek-ai/dsh 原样',
  sizeBackend: '裁剪后的 backend',
  sizeApp: '安装后',
  sizeInstaller: '安装包',
  sizeMacOs: 'macOS arm64',
  sizeWindows: 'Windows x64',
  sizeUnit: 'MB',
  sizeNote: '同样的东西用 Electron 做，装完大约 340 MB，下载 100–120 MB。',

  // --- what it is ---
  featuresHeading: '它是怎么做的',
  webviewTitle: '不打包浏览器',
  webviewBody:
    '窗口用系统自带的 WebView 画：macOS 上是 WKWebView，Windows 上是 WebView2。不带 Chromium，也没有第二个 JavaScript 引擎。省下的 249 MB 大半来自这里。',
  upstreamTitle: '上游的界面，一点没动',
  upstreamBody:
    '应用加载的是 dsh 自己的 ui-* 插件。一行前端代码都不复制，也不往页面里注入东西，所以你看到的就是上游发布的样子。',
  updateTitle: '它自己更新',
  updateBody:
    '启动 5 秒后查一次，一天最多一次，没有新版就不吭声。有新版可以装、可以推迟，也可以跳过这一版。提示是一个独立的原生小窗口。',
  profileTitle: '不碰你的 ~/.dsh',
  profileBody:
    '应用把自己的配置放在 Application Support 下。首次启动之后，那份 cordis.patch.yml 就归你改，更新不会覆盖。',

  // --- download ---
  downloadHeading: '拿到手',
  ctaDownload: '下载 macOS 版',
  ctaDownloadWindows: '下载 Windows 版',
  ctaMeta: 'macOS 11+ · 已签名并公证',
  ctaMetaWindows: 'Windows 10 1809+ · SmartScreen 会问一次',
  releaseNotes: '更新日志',
  downloadAction: '下载',
  statusPlanned: '还没有',
  macNote: 'macOS 11 及以上，Apple Silicon。已签名并公证，双击就能打开。',
  windowsNote: 'Windows 10 1809 及以上。还没签名，SmartScreen 会拦一次：更多信息 → 仍要运行。',
  linuxNote: '现在还没有可下的东西。Linux 是下一个要做的，但今天还没好。',

  // --- footer ---
  footerSource: '源码',
  footerReleases: 'Releases',
  footerUpstream: '上游项目',
  footerDisclaimer: '对官方 DeepSeek Harness 的第三方封装，与 DeepSeek 无关。',

  // --- 404 ---
  notFoundTitle: '这里什么都没有',
  notFoundBody: '这台主机只有一个页面和一堆安装包，你要的两样都不是。',
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
