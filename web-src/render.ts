/**
 * Turns the registry and the string tables into HTML — the only module that knows what
 * either looks like.
 *
 * Two passes, not two parses: `assemble` splices the page body into the layout, at which
 * point the body still carries its own `{{...}}`. String replacement never rescans what it
 * just inserted, so the skeleton has to be built first and resolved once, whole.
 */

import { manifestKey } from '../scripts/dist-paths.ts';
import { TARGETS } from '../scripts/target.ts';
import { FONT_FILE } from './fonts.ts';
import { LANG_TAG, LOCALES, LOCALE_NAME, OG_LOCALE, type Locale } from './locale.ts';
import {
  DOWNLOADS,
  ORIGIN,
  REPO,
  SIZE_HIGHLIGHT_ID,
  SIZE_ROWS,
  OG_IMAGE,
  STATIC_ASSETS,
  UPSTREAM,
  alternates,
  baselineMegabytes,
  downloadById,
  homeUrl,
  pagePath,
  primaryDownload,
  stylesheetsFor,
  type DownloadId,
  type Page,
} from './site.ts';
import { STRINGS } from './strings.ts';
import { fill, keep, placeholdersIn, stripComments, throwOnMissing } from './template.ts';

/**
 * The escaping policy, stated once so there is a rule to follow rather than a precedent to
 * guess at: **attribute values are escaped, element text is not.** There is no user input on
 * this site — every string is copy from `strings.ts` — so text nodes are trusted. An attribute
 * is different in kind: one straight quote in a description ends the attribute and the tag
 * with it, and the copy is edited by people who have no reason to know that.
 */
function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
}

/**
 * Every off-page destination, in one place. Spelling `/dl/latest/...` into a template would
 * put a second copy of the artifact path a release has to keep in step with; there is
 * already one in each README.
 */
const HREFS = {
  // Asked for, not recomputed: `DOWNLOADS` already owns where the macOS build lives, and a
  // second `latestKey(latestArtifactName(...))` here would keep pointing at `latest` on the day the
  // registry starts pointing somewhere else — with every test still green.
  dmgHref: primaryDownload().href,
  // The hero tag reads the shipping version out of the live update manifest, so the page
  // never states a version of its own. Same-origin, and the file is already published.
  manifestHref: `/${manifestKey(TARGETS['darwin-arm64'].updaterPlatform)}`,
  iconHref: `/${STATIC_ASSETS.icon}`,
  appleTouchIconHref: `/${STATIC_ASSETS.appleTouchIcon}`,
  ogImageHref: `/${STATIC_ASSETS.ogImage}`,
  repoHref: REPO,
  repoReleasesHref: `${REPO}/releases`,
  upstreamHref: UPSTREAM,
} as const;

/**
 * The size table: the page's central claim, drawn as bars scaled against the largest row.
 *
 * The bar width is a custom property rather than an inline `width`, so the CSS owns whether
 * it is a width at all — at narrow viewports the bars become a different thing entirely, and
 * a hardcoded width in the markup would have to be fought.
 */
function sizeTable(locale: Locale): string {
  const strings = STRINGS[locale];
  const baseline = baselineMegabytes();
  const share = (megabytes: number) => `${((megabytes / baseline) * 100).toFixed(1)}%`;
  return SIZE_ROWS.map((row, index) => {
    const highlight = row.id === SIZE_HIGHLIGHT_ID ? ' is-highlight' : '';
    // Two bars sharing one scale, so the comparison the eye makes is the true one. Both are
    // drawn even where the platforms agree: a row that quietly dropped to a single bar would
    // read as "this row has no Windows number" rather than "the number is the same".
    return [
      `<li class="spec-row${highlight}" style="--i:${index}">`,
      `  <span class="spec-label">${strings[row.labelKey]}</span>`,
      `  <span class="spec-bars">`,
      `    <span class="spec-track"><i style="--w:${share(row.megabytes)}"></i></span>`,
      `    <span class="spec-track is-alt"><i style="--w:${share(row.windowsMegabytes)}"></i></span>`,
      `  </span>`,
      `  <span class="spec-value">${row.megabytes}<span class="spec-unit">${strings.sizeUnit}</span>`,
      `    <span class="spec-alt">${row.windowsMegabytes}<span class="spec-unit">${strings.sizeUnit}</span></span>`,
      `  </span>`,
      `</li>`,
    ].join('\n');
  }).join('\n');
}

/** Which bar is which. Two tones with no key is a chart that has to be guessed at. */
function sizeLegend(locale: Locale): string {
  const strings = STRINGS[locale];
  return [
    `<span class="spec-key"><i></i>${strings.sizeMacOs}</span>`,
    `<span class="spec-key is-alt"><i></i>${strings.sizeWindows}</span>`,
  ].join('\n');
}

/**
 * The line drawing on each platform's card: one window, drawn three ways.
 *
 * Inline SVG rather than an image file: it is a handful of shapes each, it has to take the ink
 * colour of whichever scheme the reader is in, and a fourth request for eight hundred bytes is
 * not worth making.
 */
const WINDOW = `
    <rect class="art-line" x="8.5" y="6.5" width="63" height="51"/>
    <path class="art-line" d="M8.5 18.5h63"/>
    <circle class="art-fill" cx="14" cy="12.5" r="1.6"/>
    <circle class="art-fill" cx="20" cy="12.5" r="1.6"/>
    <circle class="art-fill" cx="26" cy="12.5" r="1.6"/>`;

/** What sits inside that window, per platform — the only part that differs. */
const PLATFORM_ART: Record<DownloadId, string> = {
  // A conversation — what the app is actually for.
  'macos-arm64': `
    <rect class="art-fill" x="16" y="26" width="30" height="4"/>
    <rect class="art-fill" x="16" y="34" width="18" height="4"/>
    <rect class="art-accent" x="38" y="34" width="12" height="4"/>
    <rect class="art-fill" x="16" y="42" width="36" height="4"/>
    <rect class="art-fill" x="16" y="50" width="22" height="4"/>`,
  // Four panes, which is the one thing everyone already reads as Windows.
  'windows-x64': `
    <rect class="art-accent" x="17" y="25" width="20" height="13"/>
    <rect class="art-line" x="41.5" y="25.5" width="19" height="12"/>
    <rect class="art-line" x="17.5" y="42.5" width="19" height="11"/>
    <rect class="art-line" x="41.5" y="42.5" width="19" height="11"/>`,
  // A prompt and a cursor, and nothing else: there is nothing to download yet.
  'linux-x64': `
    <path class="art-line" d="M18 29l7 6-7 6"/>
    <rect class="art-fill" x="29" y="38" width="16" height="3"/>`,
};

function platformArt(id: DownloadId): string {
  return `<svg viewBox="0 0 80 64" fill="none" aria-hidden="true">${WINDOW}${PLATFORM_ART[id]}</svg>`;
}

/**
 * The platform cards. Rendered from `DOWNLOADS` rather than written out, so a platform gaining
 * an artifact changes one field — and until it does, its card cannot offer a link that would 404.
 *
 * The button carries the verb only. The card already names its platform, and reusing the hero's
 * "Download for macOS" here put that label on the Windows card the moment a second platform
 * shipped.
 */
function downloadCards(locale: Locale): string {
  const strings = STRINGS[locale];
  return DOWNLOADS.map((entry) => {
    return [
      `<article class="dl-card is-${entry.status}">`,
      `  <div class="dl-art">${platformArt(entry.id)}</div>`,
      `  <h3 class="dl-os">${entry.os}</h3>`,
      `  <p class="dl-arch">${entry.arch}</p>`,
      `  <p class="dl-note">${strings[entry.noteKey]}</p>`,
      entry.status === 'available'
        ? `  <a class="btn dl-get" href="${escapeAttr(entry.href)}">${strings.downloadAction}</a>`
        : `  <p class="btn-off dl-get">${strings.statusPlanned}</p>`,
      `</article>`,
    ].join('\n');
  }).join('\n');
}

/**
 * Always the home page, never "this page in the other language". Both pages the site has are
 * right to behave that way: home *is* the target, and the 404 has no localised URL of its own
 * to switch to — the URL that missed is not a page. A third page would have to pass its own
 * identity in, which is why this takes a locale and not a page today.
 */
function languageOptions(locale: Locale): string {
  return LOCALES.map(
    (other) =>
      `<option value="${pagePath('home', other)}" lang="${LANG_TAG[other]}"` +
      `${other === locale ? ' selected' : ''}>${LOCALE_NAME[other]}</option>`,
  ).join('\n');
}

/**
 * `</` closes a `<script>` element regardless of JSON quoting; escaping the slash keeps both
 * the JSON valid and the element open.
 */
function escapeJsonLd(value: unknown): string {
  return JSON.stringify(value, null, 2).replace(/</g, '\\u003c');
}

/**
 * Deliberately absent: `softwareVersion`. The live manifest is the version's single source
 * of truth (the tag in the hero reads it at runtime); repeating it here would create a
 * second one that goes stale between releases and tells search engines something untrue.
 */
function jsonLd(locale: Locale): string {
  const strings = STRINGS[locale];
  return escapeJsonLd({
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: 'DeepSeek Harness',
    url: homeUrl(locale),
    description: strings.metaDescription,
    applicationCategory: 'DeveloperApplication',
    operatingSystem: 'macOS 11+, Windows 10 1809+',
    processorRequirements: primaryDownload().arch,
    downloadUrl: `${ORIGIN}${HREFS.dmgHref}`,
    softwareHelp: HREFS.repoHref,
    releaseNotes: HREFS.repoReleasesHref,
    isAccessibleForFree: true,
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
  });
}

function seoHead(locale: Locale): string {
  const strings = STRINGS[locale];
  const url = homeUrl(locale);
  return [
    `<title>${strings.docTitle}</title>`,
    `<meta name="description" content="${escapeAttr(strings.metaDescription)}">`,
    `<link rel="canonical" href="${url}">`,
    ...alternates().map(
      ([tag, href]) =>
        `<link rel="alternate" hreflang="${tag === 'x-default' ? tag : LANG_TAG[tag]}" href="${href}">`,
    ),
    // index/follow is already the default; writing it changes no crawler's behaviour and only
    // reads as policy where there is none. `max-image-preview` is the part that is not default.
    `<meta name="robots" content="max-image-preview:large">`,
    `<meta property="og:type" content="website">`,
    `<meta property="og:url" content="${url}">`,
    `<meta property="og:title" content="${escapeAttr(strings.docTitle)}">`,
    `<meta property="og:description" content="${escapeAttr(strings.metaDescription)}">`,
    `<meta property="og:image" content="${ORIGIN}${HREFS.ogImageHref}">`,
    // Stated, not left to be measured: a crawler that knows the dimensions can lay the card
    // out on the first fetch instead of after pulling the image, and some never come back.
    `<meta property="og:image:width" content="${OG_IMAGE.width}">`,
    `<meta property="og:image:height" content="${OG_IMAGE.height}">`,
    `<meta property="og:image:alt" content="${escapeAttr(strings.ogImageAlt)}">`,
    `<meta property="og:locale" content="${OG_LOCALE[locale]}">`,
    ...LOCALES.filter((other) => other !== locale).map(
      (other) => `<meta property="og:locale:alternate" content="${OG_LOCALE[other]}">`,
    ),
    // The card is 1200×630 and carries the size comparison, so it wants the wide variant —
    // `summary` would crop it to a square thumbnail and throw away the entire argument.
    // title/description/image fall back to the `og:` tags, so those are not repeated here.
    `<meta name="twitter:card" content="summary_large_image">`,
    `<script type="application/ld+json">`,
    jsonLd(locale),
    `</script>`,
  ].join('\n');
}

/**
 * Resource order in `<head>` is decided here and nowhere else, because the order has reasons:
 * both faces preload ahead of the stylesheet that will demand them, and the shell sheet comes
 * before the page's own, which is written to override it.
 *
 * Takes the page rather than reading a global, so the 404 goes through the same function: it
 * has different content, not different loading behaviour.
 */
function headAssets(page: Page): string {
  return [
    ...Object.values(FONT_FILE).map(
      (file) => `<link rel="preload" href="/${file}" as="font" type="font/woff2" crossorigin>`,
    ),
    ...stylesheetsFor(page).map((sheet) => `<link rel="stylesheet" href="/${sheet}">`),
  ].join('\n');
}

/** The half of the substitutions that depends on language alone. Both pages share it. */
function localeBase(page: Page, locale: Locale): Record<string, string> {
  return {
    ...STRINGS[locale],
    ...HREFS,
    lang: LANG_TAG[locale],
    homeHref: pagePath('home', locale),
    headAssets: headAssets(page),
    langOptions: languageOptions(locale),
  };
}

function substitutions(locale: Locale): Record<string, string> {
  return {
    ...localeBase('home', locale),
    seoHead: seoHead(locale),
    sizeTable: sizeTable(locale),
    sizeLegend: sizeLegend(locale),
    downloadCards: downloadCards(locale),
    windowsHref: downloadById('windows-x64').href,
  };
}

/** First pass: build the skeleton. The body's own placeholders survive for the second. */
function assemble(layout: string, content: string): string {
  return fill(layout, { content: content.replace(/\n+$/, '') }, keep);
}

/** Last step: an unresolved placeholder fails the build. Shipping a literal one is worse. */
function finalize(rendered: string, label: string): string {
  const leftovers = placeholdersIn(rendered);
  if (leftovers.length > 0) {
    throw new Error(`web template ${label}: unresolved after rendering: ${leftovers.join(', ')}`);
  }
  return stripComments(rendered);
}

export function renderHome(layout: string, body: string, locale: Locale): string {
  return finalize(
    fill(assemble(layout, body), substitutions(locale), throwOnMissing),
    `home/${locale}`,
  );
}

/**
 * The 404 stays out of the page registry — it is noindex, has no canonical and no hreflang
 * cluster — but it does not stay out of the layout. Its head is the difference; its shell is not.
 */
export function renderNotFound(layout: string, body: string, locale: Locale): string {
  const strings = STRINGS[locale];
  return finalize(
    fill(
      assemble(layout, body),
      {
        ...localeBase('notFound', locale),
        seoHead: [
          `<title>${strings.notFoundTitle}</title>`,
          `<meta name="robots" content="noindex">`,
        ].join('\n'),
      },
      throwOnMissing,
    ),
    `404/${locale}`,
  );
}
