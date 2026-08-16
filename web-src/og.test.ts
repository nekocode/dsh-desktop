import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cardRows, renderCard } from '../scripts/make-og.ts';
import { OG_IMAGE, ORIGIN, SIZE_ROWS } from './site.ts';
import { placeholdersIn } from './template.ts';

const root = new URL('../', import.meta.url);
const card = readFileSync(new URL('web-src/og.png', root));

/** PNG stores width and height as big-endian 32-bit integers at bytes 16 and 20 of the IHDR. */
function pngSize(bytes: Buffer): { width: number; height: number } {
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

test('the committed card is the size the meta tags claim', () => {
  // `og:image:width` is a promise to a crawler. A card regenerated at the wrong size renders
  // letterboxed or cropped, and only in other people's feeds.
  assert.deepEqual(pngSize(card), { width: OG_IMAGE.width, height: OG_IMAGE.height });
});

test('the card quotes the size table rather than remembering it', () => {
  const rows = cardRows();
  const baseline = SIZE_ROWS.find((row) => row.id === 'upstream')?.megabytes;
  const winner = SIZE_ROWS.find((row) => row.id === 'app')?.megabytes;
  assert.ok(rows.includes(`>${baseline}<`), 'the card does not state the upstream size');
  assert.ok(rows.includes(`>${winner}<`), 'the card does not state the installed size');
  // The winning row is the only one painted in the brand colour, same as on the page.
  assert.equal(rows.match(/class="row win"/g)?.length, 1);
});

test('the card template resolves completely', () => {
  // It is rendered by a script rather than by the build, so `build.ts`'s leftover-placeholder
  // gate never sees it. A literal `{{claim}}` would be baked into a PNG and shipped.
  const template = readFileSync(new URL('web-src/templates/og.html', root), 'utf8');
  const rendered = renderCard(template, new URL('.', root).pathname);
  assert.deepEqual(placeholdersIn(rendered), []);
  assert.ok(rendered.includes(new URL(ORIGIN).host), 'the card does not name the site');
});
