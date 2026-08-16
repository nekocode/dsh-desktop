import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { latestArtifactName, latestKey } from '../scripts/dist-paths.ts';
import { TARGETS } from '../scripts/target.ts';
import { LOCALES, ROOT_LOCALE, type Locale } from './locale.ts';
import {
  DOWNLOADS,
  OUTPUT_DIR,
  PRIMARY_DOWNLOAD_ID,
  PAGES,
  SHELL_STYLESHEET,
  SIZE_ROWS,
  STYLESHEETS,
  alternates,
  baselineMegabytes,
  downloadById,
  homeUrl,
  notFoundUrlFor,
  outputPath,
  pagePath,
  primaryDownload,
  savedMegabytes,
  stylesheetsFor,
} from './site.ts';
import { STRINGS, assertStringTablesComplete } from './strings.ts';

const read = (name: string) => readFile(new URL(`../${name}`, import.meta.url), 'utf8');

test('the root locale owns `/`, every other locale is prefixed', () => {
  assert.equal(pagePath('home', ROOT_LOCALE), '/');
  assert.equal(outputPath('home', ROOT_LOCALE), 'index.html');
  for (const locale of LOCALES.filter((other) => other !== ROOT_LOCALE)) {
    assert.equal(pagePath('home', locale), `/${locale}/`);
    assert.equal(outputPath('home', locale), `${locale}/index.html`);
    assert.equal(outputPath('notFound', locale), `${locale}/404.html`);
  }
});

test('a page is written to the path it is served at, minus the leading slash', () => {
  // A page reachable at a path it was never written to is a 404 nobody notices until deploy.
  for (const locale of LOCALES) {
    assert.equal(new URL(homeUrl(locale)).pathname, pagePath('home', locale));
    assert.equal(outputPath('notFound', locale), pagePath('notFound', locale).slice(1));
  }
});

test('the 404 URL is absolute, so it cannot resolve against the path that missed', () => {
  // Relative, `/zh/nope` would ask for `/zh/zh/404.html` — a second miss, with no fallback left.
  for (const path of ['/nope', '/dl/v9.9.9/x.dmg', '/deep/er/still']) {
    assert.equal(notFoundUrlFor(path), '/404.html');
  }
  assert.equal(notFoundUrlFor('/zh/nope'), '/zh/404.html');
});

test('the 404 URL is the page path, never a second spelling of it', () => {
  for (const locale of LOCALES) {
    assert.equal(notFoundUrlFor(pagePath('home', locale)), pagePath('notFound', locale));
  }
});

test('the hreflang cluster covers every locale plus an x-default', () => {
  const tags = alternates().map(([tag]) => tag);
  assert.deepEqual(tags, [...LOCALES, 'x-default']);
  assert.equal(alternates().at(-1)?.[1], homeUrl(ROOT_LOCALE));
});

test('every page links the shell first, and only the sheets that exist', () => {
  for (const page of PAGES) {
    const sheets = stylesheetsFor(page);
    assert.equal(sheets[0], SHELL_STYLESHEET, `${page} does not load the shell first`);
    for (const sheet of sheets) assert.ok(STYLESHEETS.includes(sheet), `${page} loads ${sheet}`);
  }
});

test('the hero offers a stated platform, not whichever entry happens to be first', () => {
  // With one shipping platform "the available one" and "the one the button offers" were the same
  // answer. With two they are not, and a page that re-decides it when the table is reordered is a
  // page that quietly hands Windows users a DMG.
  assert.equal(primaryDownload().id, PRIMARY_DOWNLOAD_ID);
  assert.equal(primaryDownload().status, 'available');
});

test('every download href is the artifact path, not a copy of it', () => {
  assert.equal(
    downloadById('macos-arm64').href,
    `/${latestKey(latestArtifactName(TARGETS['darwin-arm64']))}`,
  );
  assert.equal(
    downloadById('windows-x64').href,
    `/${latestKey(latestArtifactName(TARGETS['win32-x64']))}`,
  );
});

test('a planned platform cannot be handed out', () => {
  // The union makes "planned, with a download link" unrepresentable; this checks the table still
  // uses it that way, and that asking for one by id fails loudly rather than returning undefined.
  assert.throws(() => downloadById('linux-x64'), /linux-x64/);
});

test('the row button says only the verb — a platform-specific label lies on every other row', () => {
  // It did: the table reused the hero's "Download for macOS" for every row, and the day Windows
  // shipped that label appeared on the Windows row.
  for (const locale of LOCALES) {
    const strings = STRINGS[locale as Locale];
    assert.ok(
      !/macOS|Windows/.test(strings.downloadAction),
      `${locale} row button names a platform`,
    );
    assert.match(strings.ctaDownload, /macOS/);
    assert.match(strings.ctaDownloadWindows, /Windows/);
  }
});

test('every download entry is uniquely identified', () => {
  assert.equal(new Set(DOWNLOADS.map((entry) => entry.id)).size, DOWNLOADS.length);
});

test('the size baseline is the largest row — the bars are scaled against it', () => {
  // Both platforms' bars share this scale, so it has to bound both or a bar overflows its track.
  const all = SIZE_ROWS.flatMap((row) => [row.megabytes, row.windowsMegabytes]);
  assert.equal(baselineMegabytes(), Math.max(...all));
});

test('no string is present but blank', () => {
  assertStringTablesComplete();
});

test('the size table and both READMEs state the same numbers', async () => {
  // A shared module is impossible — the READMEs are prose — so divergence is caught here
  // instead of being discovered by a reader.
  const expected = SIZE_ROWS.map((row) => row.megabytes);
  for (const name of ['README.md', 'README.zh.md']) {
    const text = await read(name);
    // The READMEs list one column per platform; the chart argues about macOS, so it is the macOS
    // column — the first `N MB` cell of each row — that has to agree. Rows whose second cell is
    // not a bare size (the trim tables further down) do not match and are not compared.
    const found = [...text.matchAll(/^\|[^|]*\|\s*(\d+)\s*MB[^|]*\|/gm)].map(([, mb]) =>
      Number(mb),
    );
    assert.deepEqual(found, expected, `${name} disagrees with SIZE_ROWS`);
  }
});

test('the copy quotes the size table rather than remembering it', () => {
  // The headline names the installed size and the body names the saving. Both are `SIZE_ROWS`
  // arithmetic, and a build that shrinks the app would otherwise leave the prose disagreeing
  // with the chart printed directly beneath it.
  // The alt text describing the share card names the upstream size too, so all three are
  // checked: the number the card compares against, the number it lands on, and the gap.
  const app = SIZE_ROWS.find((row) => row.id === 'app')?.megabytes;
  for (const locale of LOCALES) {
    const copy = Object.values(STRINGS[locale as Locale]).join('\n');
    assert.ok(copy.includes(`${app} MB`), `${locale} copy never names the installed size`);
    assert.ok(copy.includes(`${savedMegabytes()} MB`), `${locale} copy misstates the saving`);
    assert.ok(
      copy.includes(`${baselineMegabytes()} MB`),
      `${locale} copy misstates the upstream size`,
    );
  }
});

test('the build writes where the Worker reads', async () => {
  // Two files no single change touches together. A rename reaching only one of them deploys
  // an empty asset directory: every page 404s, including the 404 the Worker fetches itself.
  assert.ok((await read('wrangler.jsonc')).includes(`"directory": "./${OUTPUT_DIR}"`));
});
