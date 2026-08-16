/**
 * Fetches the two web fonts and cuts them down to the glyphs the site actually sets.
 *
 * Run by hand (`npm run fonts`), like `npm run icon` — the output is committed, because a
 * deploy should not depend on Google being up, and the site build should not depend on
 * Python being installed. This script exists rather than a note in a comment so the
 * artifacts stay reproducible instead of becoming files nobody knows how to regenerate.
 *
 * Requires `pyftsubset` (fonttools) with brotli.
 *
 * Why subset at all: the latin variable cut of Archivo alone is 90 KB. This page's entire
 * argument is that 251 MB were deleted from the product; arriving in 180 KB of typeface
 * would undercut it. Subsetting gets the pair to roughly a fifth of that.
 *
 * The Chinese page is deliberately not covered. A CJK face is megabytes, so Chinese falls
 * back to the system stack (PingFang SC and friends) and the design is built to hold up
 * with Latin and CJK in different families.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { FONT_FILE, SUBSET_RANGES } from '../web-src/fonts.ts';
import { sha256 } from './publish.ts';

/** A modern desktop UA, because the Google Fonts CSS endpoint serves woff2 only to one. */
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

type FontSpec = {
  /** Which role in `FONT_FILE` this face fills — the entry this run rewrites. */
  readonly role: keyof typeof FONT_FILE;
  /** Output basename, before the content hash. */
  readonly name: string;
  /** The `family=` value in the Google Fonts URL, axes included. */
  readonly query: string;
};

export const FONTS: readonly FontSpec[] = [
  // Both are variable on width as well as weight. The width axis is the design: the wordmark
  // is Archivo expanded, the size table is Martian Mono condensed, and neither costs a file.
  { role: 'display', name: 'archivo', query: 'Archivo:wdth,wght@62..125,400..700' },
  { role: 'mono', name: 'martian-mono', query: 'Martian+Mono:wdth,wght@75..112.5,300..800' },
];

export function cssUrl(query: string): string {
  return `https://fonts.googleapis.com/css2?family=${query}&display=swap`;
}

/**
 * Pulls the `latin` face out of a Google Fonts stylesheet.
 *
 * The response is one `@font-face` per unicode range, each preceded by a comment naming it.
 * Taking the first `src:` would take Vietnamese — the blocks are ordered by range, not by
 * how likely anyone is to want them.
 */
export function latinSourceUrl(css: string): string {
  const block = css.split(/\/\*\s*/).find((section) => section.startsWith('latin */'));
  if (!block) throw new Error('no /* latin */ block in the Google Fonts response');
  const src = block.match(/url\((https:\/\/[^)]+\.woff2)\)/);
  if (!src?.[1]) throw new Error('the /* latin */ block carries no woff2 URL');
  return src[1];
}

/** Content hash in the filename, so swapping a typeface is a new URL and never a stale cache. */
export function hashedName(name: string, bytes: Uint8Array): string {
  return `${name}-${sha256(bytes).slice(0, 8)}.woff2`;
}

/**
 * Rewrites the two places the hashed filenames are spelled: the `FONT_FILE` table and the
 * `@font-face` rules that CSS cannot import it into.
 *
 * The script computes the hash, so the script writes it — the same reason `make-icon.ts`
 * writes `web-src/icon.svg` instead of telling someone to. Printing it and asking for two
 * manual transcriptions leaves the repo inconsistent in between, and gets one of them wrong.
 */
export function rewriteFilename(source: string, before: string, after: string): string {
  if (before === after) return source;
  if (!source.includes(before)) throw new Error(`expected to find ${before}`);
  return source.replaceAll(before, after);
}

async function download(url: string): Promise<Uint8Array> {
  const response = await fetch(url, { headers: { 'user-agent': UA } });
  if (!response.ok) throw new Error(`GET ${url} → ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

async function main(): Promise<void> {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const outDir = join(root, 'web-src', 'fonts');
  const scratch = mkdtempSync(join(tmpdir(), 'dsh-fonts-'));
  const replaced: Array<readonly [keyof typeof FONT_FILE, string]> = [];
  try {
    for (const font of FONTS) {
      const css = await fetch(cssUrl(font.query), { headers: { 'user-agent': UA } }).then((r) =>
        r.text(),
      );
      const full = await download(latinSourceUrl(css));
      const input = join(scratch, `${font.name}.woff2`);
      const output = join(scratch, `${font.name}.subset.woff2`);
      writeFileSync(input, full);
      execFileSync('pyftsubset', [
        input,
        `--output-file=${output}`,
        '--flavor=woff2',
        `--unicodes=${SUBSET_RANGES.join(',')}`,
        // Kerning and contextual alternates are what separate set type from arranged glyphs;
        // everything else in the layout tables is for scripts this subset does not contain.
        '--layout-features=kern,calt,liga',
        '--no-hinting',
      ]);
      const subset = readFileSync(output);
      const name = hashedName(font.name, subset);
      writeFileSync(join(outDir, name), subset);
      replaced.push([font.role, name]);
      const saved = Math.round((1 - subset.length / full.length) * 100);
      console.log(
        `[fonts] ${font.name}: ${full.length} → ${subset.length} bytes (−${saved}%) as ${name}`,
      );
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  // Both spellings, rewritten here rather than by hand: the table `render.ts` preloads from,
  // and the `@font-face` rules in the shell stylesheet.
  const sources = [join(root, 'web-src', 'fonts.ts'), join(root, 'web-src', 'styles.css')];
  for (const path of sources) {
    let text = readFileSync(path, 'utf8');
    for (const [role, name] of replaced) text = rewriteFilename(text, FONT_FILE[role], name);
    writeFileSync(path, text);
  }

  // Superseded cuts are orphans the moment the hash changes: nothing references them, and the
  // build copies whatever the table names, so they would sit in the repo forever.
  const kept = new Set(replaced.map(([, name]) => name));
  for (const file of readdirSync(outDir)) {
    if (file.endsWith('.woff2') && !kept.has(file)) {
      unlinkSync(join(outDir, file));
      console.log(`[fonts] removed superseded ${file}`);
    }
  }
  console.log(`[fonts] web-src/fonts.ts and web-src/styles.css updated`);
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]).endsWith('make-fonts.ts');
if (isMain) await main();
