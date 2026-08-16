import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { BRAND_BLUE } from '../scripts/make-icon.ts';
import { FONT_FILES, SUBSET_RANGES, coverageOf } from './fonts.ts';
import { STYLESHEETS } from './site.ts';

// Both sheets, joined: which file a rule lives in is a size decision, not a contract.
const styles = (
  await Promise.all(STYLESHEETS.map((name) => readFile(new URL(name, import.meta.url), 'utf8')))
).join('\n');

test('the stylesheet loads exactly the font files that were generated', async () => {
  // CSS cannot import TypeScript, so the hashed filenames exist in two places. A rename that
  // updates only one of them costs the page its typography and nothing complains.
  for (const file of FONT_FILES) {
    assert.ok(styles.includes(`url('/${file}')`), `the stylesheets do not load ${file}`);
  }
  const loaded = [...styles.matchAll(/url\('\/([^']+\.woff2)'\)/g)].map(([, file]) => file);
  assert.deepEqual(
    loaded.sort(),
    [...FONT_FILES].sort(),
    'a stylesheet loads a font nobody generated',
  );
});

test('the accent is the official brand blue, spelled the same as the app icon', () => {
  // "Do not substitute another color" — the wording on the badge asset make-icon.ts cites.
  assert.ok(
    styles.toLowerCase().includes(`--accent: ${BRAND_BLUE.toLowerCase()};`),
    `--accent is not set to ${BRAND_BLUE}`,
  );
});

test('no codepoint in the stylesheets is one nothing can draw', () => {
  // Stylesheets carry visible text too — `content:` values, and the odd dash in a comment.
  for (const character of styles) {
    const point = character.codePointAt(0) as number;
    assert.notEqual(
      coverageOf(point),
      'uncovered',
      `a stylesheet uses U+${point.toString(16).toUpperCase()} "${character}"`,
    );
  }
});

test('every subset range parses, and covers what it says it covers', () => {
  assert.ok(
    SUBSET_RANGES.every((range) => /^U\+[0-9A-F]{4}(-[0-9A-F]{4})?$/.test(range)),
    'malformed range',
  );
  for (const [character, expected] of [
    ['A', 'subset'],
    ['~', 'subset'],
    ['·', 'subset'],
    ['↓', 'subset'],
    ['é', 'uncovered'],
    ['€', 'uncovered'],
    // No face is shipped for CJK, so the subset is not the thing that draws it.
    ['界', 'system-stack'],
  ] as const) {
    assert.equal(coverageOf(character.codePointAt(0) as number), expected, character);
  }
});
