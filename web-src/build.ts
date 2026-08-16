/**
 * Renders the site into `web/`, the directory the Worker serves as static assets.
 *
 * The only module here that touches the filesystem. Everything it decides lives in
 * `site.ts`, `strings.ts` and `render.ts`, which are pure and tested; this file reads,
 * gates, renders, writes and reports, in that order.
 *
 * Every gate runs before the first write. A site that fails a check should not exist in a
 * half-published state on disk — the deploy that follows would ship whatever landed.
 *
 * No bundler and no dependencies: `node --experimental-strip-types web-src/build.ts`.
 */

import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FONT_FILES, coverageOf } from './fonts.ts';
import { LOCALES, type Locale } from './locale.ts';
import { OUTPUT_DIR, PAGES, STATIC_ASSETS, STYLESHEETS, outputPath } from './site.ts';
import { STRINGS, assertStringTablesComplete } from './strings.ts';
import { renderHome, renderNotFound } from './render.ts';

const here = new URL('.', import.meta.url);
const outDir = fileURLToPath(new URL(`../${OUTPUT_DIR}/`, import.meta.url));

const read = (relativePath: string): Promise<string> =>
  readFile(new URL(relativePath, here), 'utf8');

async function write(relativePath: string, contents: string | Uint8Array): Promise<number> {
  const path = `${outDir}${relativePath}`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents);
  return typeof contents === 'string' ? Buffer.byteLength(contents) : contents.byteLength;
}

/**
 * Every character on the page must be one the subset can draw, or CJK, which is left to the
 * system stack on purpose. Without this, a stray `é` ships as a blank box that nobody sees
 * until a reader mentions it.
 */
function assertGlyphsCovered(label: string, html: string): void {
  const missing = new Set(
    [...html]
      .map((character) => character.codePointAt(0) as number)
      .filter((point) => coverageOf(point) === 'uncovered'),
  );
  if (missing.size > 0) {
    const listed = [...missing].map(
      (point) => `U+${point.toString(16).toUpperCase()} ${String.fromCodePoint(point)}`,
    );
    throw new Error(`${label}: characters outside the font subset: ${listed.join(', ')}`);
  }
}

/**
 * Copy that nothing renders is copy maintained in two languages for nobody. Matching on the
 * rendered output rather than on placeholders in the templates catches the strings that reach
 * the page through `render.ts` — the size labels and the platform statuses — which a
 * placeholder scan would report as unused every time.
 *
 * Known limit, stated rather than left to be discovered: a very short value can be satisfied by
 * an unrelated occurrence — `versionFallback` is a single em dash, and any page containing one
 * passes. Every string long enough to be worth translating is checked properly.
 */
function assertEveryStringRendered(locale: Locale, pages: readonly string[]): void {
  const unused = Object.entries(STRINGS[locale])
    .filter(([, value]) => !pages.some((page) => page.includes(value)))
    .map(([key]) => key);
  if (unused.length > 0) {
    throw new Error(`${locale}: strings translated but never rendered: ${unused.join(', ')}`);
  }
}

// A tuple, not `[...].map(read)`: an array of reads types as `string[]`, and under
// `noUncheckedIndexedAccess` every destructured name then needs casting back to `string`.
const [layout, home, notFound] = await Promise.all([
  read('templates/layout.html'),
  read('templates/home.html'),
  read('templates/not-found.html'),
]);
const stylesheets = await Promise.all(
  STYLESHEETS.map(async (name) => [name, await read(name)] as const),
);

// --- gates ---
assertStringTablesComplete();

const rendered = LOCALES.map((locale) => ({
  locale,
  pages: [
    { path: outputPath('home', locale), html: renderHome(layout, home, locale) },
    { path: outputPath('notFound', locale), html: renderNotFound(layout, notFound, locale) },
  ],
}));

for (const { locale, pages } of rendered) {
  for (const page of pages) assertGlyphsCovered(`${locale}/${page.path}`, page.html);
  assertEveryStringRendered(
    locale,
    pages.map((page) => page.html),
  );
}
for (const [name, css] of stylesheets) assertGlyphsCovered(name, css);
const pageCount = LOCALES.length * PAGES.length;
console.log(`[web] gates passed: ${LOCALES.length} locales × ${PAGES.length} pages`);

// --- write ---
// Cleared first: a page removed from the registry would otherwise stay served forever, since
// the asset upload adds and replaces but never deletes what it no longer knows about.
await rm(outDir, { recursive: true, force: true });

let bytes = 0;
for (const { pages } of rendered) {
  for (const page of pages) {
    bytes += await write(page.path, page.html);
    console.log(`[web] ${page.path}`);
  }
}

for (const [name, css] of stylesheets) bytes += await write(name, css);

// Copied rather than rendered: fonts, icons and the share card are inputs, not output. The
// icon comes from `npm run icon`, off the same upstream artwork the app icon uses, so the site
// cannot end up wearing a different whale than the app.
//
// Source and destination as a pair, rather than a list of names the loop has to work out the
// directory of. The three inputs come from three different places and a fourth would come from
// a fifth; a table absorbs that, a ternary inside the loop does not.
//
// The share card is rendered by `npm run og` from the site's own design and the size table.
// The touch icon is the app's own icon, square as Apple wants it — the two were one file until
// the card stopped being square, which is exactly the kind of thing a table makes visible.
const COPIES: ReadonlyArray<readonly [string, string]> = [
  ...FONT_FILES.map((file) => [`fonts/${file}`, file] as const),
  [STATIC_ASSETS.icon, STATIC_ASSETS.icon],
  [STATIC_ASSETS.ogImage, STATIC_ASSETS.ogImage],
  ['../src-tauri/icons/icon.png', STATIC_ASSETS.appleTouchIcon],
];
for (const [from, to] of COPIES) await copyFile(new URL(from, here), `${outDir}${to}`);

console.log(`[web] done: ${pageCount} pages, ${(bytes / 1024).toFixed(1)} KB of HTML and CSS`);
