/**
 * The two typeface files, by their content-hashed names.
 *
 * Written by `npm run fonts` (`scripts/make-fonts.ts`) and copied verbatim into the output.
 * The same names are spelled a second time in `styles.css`'s `@font-face` rules, because CSS
 * cannot import TypeScript; `styles.test.ts` reads those files and fails when the two disagree,
 * which is the difference between a wrong filename and a page that silently loses its type.
 */
export const FONT_FILE = {
  display: 'archivo-eb8ac466.woff2',
  mono: 'martian-mono-190af6b9.woff2',
} as const;

export const FONT_FILES: readonly string[] = Object.values(FONT_FILE);

/**
 * The glyph set both files were cut down to: printable ASCII plus every non-ASCII character
 * the copy actually uses.
 *
 * Listed one by one rather than taken as whole Unicode blocks — carrying nothing extra is the
 * point. `scripts/make-fonts.ts` subsets against this, and `build.ts` gates the rendered pages
 * against it, so typing a character that is not here fails the build instead of shipping a box.
 */
export const SUBSET_RANGES: readonly string[] = [
  'U+0020-007E', // printable ASCII
  'U+00A0', // no-break space
  'U+00B7', // · — the separator in every meta line
  'U+00D7', // ×
  'U+00A9', // ©
  'U+2013', // –
  'U+2014', // —
  'U+2018',
  'U+2019', // ‘ ’
  'U+201C',
  'U+201D', // “ ”
  'U+2026', // …
  'U+2192', // →
  'U+2193', // ↓ — the download glyph
  'U+2212', // − (minus, not a hyphen)
];

/**
 * Where the Latin subset stops mattering. At and above this codepoint the text is CJK and
 * beyond — no face is shipped for any of it, and the system stack draws it.
 */
export const SYSTEM_STACK_START = 0x2e80;

function parseRange(range: string): readonly [number, number] {
  const [from, to] = range.slice(2).split('-');
  const start = Number.parseInt(from as string, 16);
  return [start, to === undefined ? start : Number.parseInt(to, 16)];
}

/**
 * Parsed once, at module scope. `coverageOf` runs per character over every rendered page and
 * both stylesheets; re-parsing a constant table inside it made the gate about fifteen times
 * slower to reach the same answer.
 */
const RANGES: ReadonlyArray<readonly [number, number]> = SUBSET_RANGES.map(parseRange);

/**
 * Who draws a character. Three named states rather than one boolean: "the subset has it" and
 * "nothing here was ever going to have it" are different facts that happened to share an
 * answer, and collapsing them left the gate's one real case — `uncovered` — as the only one
 * without a name.
 */
export type Coverage = 'subset' | 'system-stack' | 'uncovered';

export function coverageOf(codepoint: number): Coverage {
  if (codepoint >= SYSTEM_STACK_START) return 'system-stack';
  if (codepoint === 0x0a || codepoint === 0x09) return 'subset';
  return RANGES.some(([start, end]) => codepoint >= start && codepoint <= end)
    ? 'subset'
    : 'uncovered';
}
