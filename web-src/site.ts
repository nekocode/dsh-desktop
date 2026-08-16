/**
 * The site's registry: what pages exist, in what languages, and every fact the copy is
 * allowed to state as data rather than as prose.
 *
 * Pure — no filesystem, no network. `build.ts` is the only module that touches either.
 */

import { DIST_BASE_URL, latestDmgName, latestKey } from '../scripts/dist-paths.ts';
import { LOCALES, ROOT_LOCALE, localizedPath, type Locale } from './locale.ts';
import type { StringKey } from './strings.ts';

export const ORIGIN = DIST_BASE_URL;

export const REPO = 'https://github.com/nekocode/dsh-desktop';
export const UPSTREAM = 'https://github.com/deepseek-ai/deepseek-harness';

/**
 * Where the rendered site is written, and where the Worker serves it from. Pinned against
 * `wrangler.jsonc` by `site.test.ts` — the two files are never edited by the same change, and
 * a rename that reaches only one of them deploys an empty asset directory: every page 404s,
 * including the 404 itself, which the Worker fetches through the assets binding.
 */
export const OUTPUT_DIR = 'web';

/**
 * The two pages. `notFound` is not an indexable page — no canonical, no hreflang cluster, not
 * in the alternates — but it is a page for everything about loading and layout, which is why
 * it has an identity here rather than being a special case inside the renderer.
 */
export const PAGES = ['home', 'notFound'] as const;
export type Page = (typeof PAGES)[number];

/** The filename each page is written under, before its locale prefix. */
const PAGE_FILE: Record<Page, string> = { home: 'index.html', notFound: '404.html' };

/**
 * The page's own stylesheet, on top of the shell. `home.css` carries the hero, the size table
 * and the download list — none of which the 404 has, so it should not be made to download
 * them. The split also keeps both files under the project's 700-line ceiling.
 */
export const SHELL_STYLESHEET = 'styles.css';
const PAGE_STYLESHEET: Record<Page, string | null> = { home: 'home.css', notFound: null };

/** Which sheets a page links, in load order: the shell first, since the page's own overrides it. */
export function stylesheetsFor(page: Page): readonly string[] {
  const own = PAGE_STYLESHEET[page];
  return own ? [SHELL_STYLESHEET, own] : [SHELL_STYLESHEET];
}

/** Every stylesheet the build must copy. Derived, so adding one to a page is enough. */
export const STYLESHEETS: readonly string[] = [
  SHELL_STYLESHEET,
  ...Object.values(PAGE_STYLESHEET).filter((sheet) => sheet !== null),
];

/**
 * The static files that are copied rather than rendered. Named here because `build.ts` writes
 * them and both `render.ts` and the layout template point at them; three independent spellings
 * of one filename is a broken `og:image` that no gate looks at.
 *
 * `appleTouchIcon` is its own entry rather than sharing the share card: Apple wants a square,
 * the share card is 1200×630, and pointing both at one file worked only for as long as that
 * file happened to be the square app icon.
 */
export const STATIC_ASSETS = {
  icon: 'icon.svg',
  appleTouchIcon: 'apple-touch-icon.png',
  ogImage: 'og.png',
} as const;

/**
 * The share card, and the dimensions that go in the meta tags beside it.
 *
 * 1200×630 is the size every crawler is built around, and stating it lets a card render on
 * first fetch instead of after the image has been pulled and measured. The numbers live here
 * because `scripts/make-og.ts` renders to them and `render.ts` declares them — `og.test.ts`
 * reads the PNG header and fails when the file stops matching.
 */
export const OG_IMAGE = { width: 1200, height: 630 } as const;

/** The URL a page is served at. Home is the locale's directory, not its index filename. */
export function pagePath(page: Page, locale: Locale): string {
  return page === 'home' ? localizedPath(locale, '') : localizedPath(locale, PAGE_FILE[page]);
}

export function homeUrl(locale: Locale): string {
  return `${ORIGIN}${pagePath('home', locale)}`;
}

/** Where a page is written, relative to the output directory — its URL minus the leading slash. */
export function outputPath(page: Page, locale: Locale): string {
  return localizedPath(locale, PAGE_FILE[page]).slice(1);
}

/**
 * The URL of the 404 that answers a path matching nothing.
 *
 * The Worker asks this, because it is the Worker that serves the 404 — the asset layer's own
 * `not_found_handling` cannot be used here (see `dist-worker.ts`). Keeping the prefix rule in
 * the registry is what stops the Worker from growing its own idea of where a locale lives.
 *
 * Absolute. Returned relative, it would resolve against the path that missed, so `/zh/nope`
 * would ask for `/zh/zh/404.html` — a second miss, this time with nowhere left to fall back to.
 */
export function notFoundUrlFor(pathname: string): string {
  const prefixed = LOCALES.find(
    (locale) => locale !== ROOT_LOCALE && pathname.startsWith(`/${locale}/`),
  );
  return pagePath('notFound', prefixed ?? ROOT_LOCALE);
}

/** The hreflang cluster, including `x-default`, which points at the root locale. */
export function alternates(): ReadonlyArray<readonly [Locale | 'x-default', string]> {
  return [
    ...LOCALES.map((locale) => [locale, homeUrl(locale)] as const),
    ['x-default', homeUrl(ROOT_LOCALE)] as const,
  ];
}

/**
 * A download is either available or planned, and the two shapes differ: only an available
 * one has somewhere to point. Modelling it as a union rather than an optional `href` makes
 * "planned, with a download link" unrepresentable instead of merely discouraged — which is
 * the whole risk of a page that advertises platforms it cannot yet ship.
 */
export type Download =
  | {
      readonly status: 'available';
      readonly id: string;
      readonly os: string;
      readonly arch: string;
      readonly href: string;
    }
  | {
      readonly status: 'planned';
      readonly id: string;
      readonly os: string;
      readonly arch: string;
    };

/**
 * Every platform the page speaks about. macOS points at the mutable `latest` alias derived
 * from `dist-paths.ts`, so cutting a release never means editing HTML; the other two are
 * here to hold their place, and gain an `href` the day a pipeline produces one.
 */
export const DOWNLOADS: readonly Download[] = [
  {
    status: 'available',
    id: 'macos-arm64',
    os: 'macOS',
    arch: 'Apple Silicon',
    href: `/${latestKey(latestDmgName())}`,
  },
  { status: 'planned', id: 'windows-x64', os: 'Windows', arch: 'x86-64' },
  { status: 'planned', id: 'linux-x64', os: 'Linux', arch: 'x86-64' },
];

/**
 * The download the hero pushes. Throws rather than picking one when there is more than a
 * single candidate: on the day Windows ships, "which one does the big button offer" is a
 * decision someone has to make, not something this function should guess.
 */
export function primaryDownload(): Extract<Download, { status: 'available' }> {
  const available = DOWNLOADS.filter((entry) => entry.status === 'available');
  const [first] = available;
  if (!first || available.length !== 1) {
    throw new Error(`expected exactly one available download, found ${available.length}`);
  }
  return first;
}

/**
 * The size table — the page's central argument, so the numbers are data and the labels are
 * copy. `megabytes` is the fact; `labelKey` names the string that describes it.
 *
 * These same four numbers appear in both READMEs and, as prose, in the headline copy. Tests
 * compare all of them rather than letting the page and the docs drift into disagreeing about
 * how big the product is.
 */
export type SizeRow = {
  readonly id: string;
  readonly labelKey: StringKey;
  readonly megabytes: number;
};

export const SIZE_ROWS: readonly SizeRow[] = [
  { id: 'upstream', labelKey: 'sizeUpstream', megabytes: 347 },
  { id: 'backend', labelKey: 'sizeBackend', megabytes: 31 },
  { id: 'app', labelKey: 'sizeApp', megabytes: 98 },
  { id: 'dmg', labelKey: 'sizeDmg', megabytes: 36 },
];

/** The row the bars are scaled against, and the one the eye should land on. */
export const SIZE_BASELINE_ID = 'upstream';
export const SIZE_HIGHLIGHT_ID = 'app';

function megabytesOf(id: string): number {
  const row = SIZE_ROWS.find((entry) => entry.id === id);
  if (!row) throw new Error(`no size row: ${id}`);
  return row.megabytes;
}

export function baselineMegabytes(): number {
  return megabytesOf(SIZE_BASELINE_ID);
}

/** How much the trimming saves — the number the headline copy quotes in both languages. */
export function savedMegabytes(): number {
  return baselineMegabytes() - megabytesOf(SIZE_HIGHLIGHT_ID);
}
