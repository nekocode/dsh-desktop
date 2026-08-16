import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { LOCALES, type Locale } from './locale.ts';
import { DOWNLOADS, SPONSOR } from './site.ts';
import { STRINGS } from './strings.ts';
import { renderHome, renderNotFound } from './render.ts';

const read = (name: string) => readFile(new URL(name, import.meta.url), 'utf8');
const [layout, home, notFound] = await Promise.all([
  read('templates/layout.html'),
  read('templates/home.html'),
  read('templates/not-found.html'),
]);

/**
 * The cards on the page, in the order they were drawn — cut apart on the element each one opens
 * with, so the assertions read the shipped markup and the markup carries no hook for them.
 */
function cards(locale: Locale): readonly string[] {
  return renderHome(layout, home, locale)
    .split('<article class="dl-card')
    .slice(1)
    .map((part) => part.slice(0, part.indexOf('</article>')));
}

const RENDERED = new Map<Locale, readonly string[]>(
  LOCALES.map((locale) => [locale, cards(locale)]),
);

test('every platform in the registry gets a card, in its order', () => {
  for (const [locale, rendered] of RENDERED) {
    assert.equal(rendered.length, DOWNLOADS.length, `${locale} renders the wrong number of cards`);
    DOWNLOADS.forEach((entry, index) => {
      assert.ok(
        rendered[index]?.includes(`>${entry.os}<`),
        `${locale}/${entry.id} is out of place`,
      );
    });
  }
});

test('a planned platform card carries no link', () => {
  // The union already makes "planned, with an href" unrepresentable in the registry. This is the
  // other half: that the card for one cannot grow a link that would 404 the moment it is clicked.
  for (const [locale, rendered] of RENDERED) {
    DOWNLOADS.forEach((entry, index) => {
      assert.equal(
        rendered[index]?.includes('href='),
        entry.status === 'available',
        `${locale}/${entry.id} card links the wrong way`,
      );
    });
  }
});

test('the sponsor banner names the sponsor and links it, on every page in every language', () => {
  // The banner sits in the shared layout, so the 404 carries it too. The link is spliced into
  // the sentence at the sponsor's own name — the name is mid-sentence in Chinese and at the end
  // in English — so a locale whose copy drops the name renders a banner nobody can click, and
  // `sponsorLine` throws instead of letting that ship.
  for (const locale of LOCALES) {
    for (const [page, html] of [
      ['home', renderHome(layout, home, locale)],
      ['notFound', renderNotFound(layout, notFound, locale)],
    ] as const) {
      assert.ok(
        html.includes(
          `<a href="${SPONSOR.href}" target="_blank" rel="noopener">${SPONSOR.name}</a>`,
        ),
        `${locale}/${page} does not link the sponsor`,
      );
    }
  }
});

test('each card says what its platform needs, in its own words', () => {
  // One note per platform, on the right card: the requirements differ (notarized vs SmartScreen
  // vs nothing to download at all), and a shared line would be wrong on two cards out of three.
  for (const [locale, rendered] of RENDERED) {
    DOWNLOADS.forEach((entry, index) => {
      assert.ok(
        rendered[index]?.includes(STRINGS[locale][entry.noteKey]),
        `${locale}/${entry.id} card is missing its note`,
      );
    });
  }
});
