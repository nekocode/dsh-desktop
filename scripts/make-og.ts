/**
 * Renders the share card — the image a link to the site unfurls into.
 *
 * Run by hand (`npm run og`), like `npm run icon` and `npm run fonts`, and the PNG is
 * committed. A deploy should not need a browser installed, and the card only changes when
 * the design or the numbers do.
 *
 * Headless Chrome rather than a drawing library, for the same reason `make-icon.ts` uses it:
 * the card is the page's own design, and the only renderer guaranteed to agree with what a
 * visitor sees is the one that draws the page.
 *
 * Every fact on the card comes from `web-src/site.ts` — the size rows, the origin, the brand
 * blue, the font filenames. Nothing here is typed twice, so a card cannot end up quoting a
 * number the site has stopped claiming.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BRAND_BLUE } from './make-icon.ts';
import { FONT_FILE } from '../web-src/fonts.ts';
import {
  OG_IMAGE,
  ORIGIN,
  SIZE_ROWS,
  SIZE_BASELINE_ID,
  SIZE_HIGHLIGHT_ID,
} from '../web-src/site.ts';
import { STRINGS } from '../web-src/strings.ts';
import { fill, stripComments, throwOnMissing } from '../web-src/template.ts';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

/**
 * The two rows the card shows: what the upstream install weighs, and what this one does.
 *
 * Not all four. A card is read at a glance in a feed, and the argument is the distance
 * between those two numbers; the middle rows are detail, and detail belongs on the page.
 */
export function cardRows(): string {
  const baseline = SIZE_ROWS.find((row) => row.id === SIZE_BASELINE_ID);
  const winner = SIZE_ROWS.find((row) => row.id === SIZE_HIGHLIGHT_ID);
  if (!baseline || !winner) throw new Error('the size table has no baseline or no highlight row');

  const strings = STRINGS.en;
  return [baseline, winner]
    .map((row) => {
      const share = ((row.megabytes / baseline.megabytes) * 100).toFixed(1);
      const win = row.id === SIZE_HIGHLIGHT_ID ? ' win' : '';
      // The card shows the macOS figure, and the row it highlights is the one where the two
      // platforms differ (98 against 130). Unlabelled, a card read at a glance would state a
      // number that is only true for half the product.
      const label = `${strings[row.labelKey]}${row.megabytes === row.windowsMegabytes ? '' : ' · macOS'}`;
      return [
        `<div class="row${win}">`,
        `  <span class="label">${label}</span>`,
        `  <span class="value">${row.megabytes}<span class="unit">${strings.sizeUnit}</span></span>`,
        `  <span class="bar"><i style="width:${share}%"></i></span>`,
        `</div>`,
      ].join('\n');
    })
    .join('\n');
}

/**
 * The card's footer line, and the one string that lives here rather than in `strings.ts`.
 *
 * The card is rendered once, in English, so a translated copy of this would be maintained for
 * nobody — which is exactly what the build's "every string is rendered" guard exists to catch.
 * `ctaMeta` used to fill this slot; it names one platform, and on a card whose kicker reads
 * "macOS · Windows" that contradicted itself.
 */
const FOOT_META = 'macOS 11+ · Windows 10 1809+';

/** Chrome loads the card from a temp file, so the fonts have to be absolute `file://` URLs. */
function fontUrl(root: string, file: string): string {
  return `file://${resolve(root, 'web-src', 'fonts', file)}`;
}

export function renderCard(template: string, root: string): string {
  const strings = STRINGS.en;
  return stripComments(
    fill(
      template,
      {
        displayFontUrl: fontUrl(root, FONT_FILE.display),
        monoFontUrl: fontUrl(root, FONT_FILE.mono),
        accent: BRAND_BLUE,
        width: String(OG_IMAGE.width),
        height: String(OG_IMAGE.height),
        kicker: strings.heroPillMeta,
        claim: strings.heroClaim,
        rows: cardRows(),
        host: new URL(ORIGIN).host,
        footMeta: FOOT_META,
      },
      throwOnMissing,
    ),
  );
}

function main(): void {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const template = readFileSync(resolve(root, 'web-src', 'templates', 'og.html'), 'utf8');

  // Written next to the fonts it references: Chrome resolves `file://` against the document,
  // and a card rendered out of /tmp would silently fall back to a system face.
  const scratch = resolve(root, 'web-src', 'og.render.html');
  writeFileSync(scratch, renderCard(template, root));

  const out = resolve(root, 'web-src', 'og.png');
  try {
    execFileSync(
      CHROME,
      [
        '--headless',
        '--disable-gpu',
        '--hide-scrollbars',
        // Chrome will not read a `file://` font from a `file://` document without this.
        '--allow-file-access-from-files',
        `--screenshot=${out}`,
        `--window-size=${OG_IMAGE.width},${OG_IMAGE.height}`,
        `file://${scratch}`,
      ],
      { stdio: 'pipe' },
    );
  } finally {
    // The rendered HTML is scaffolding for the screenshot. Left behind it would sit in the
    // source tree looking like a page, next to templates that are.
    rmSync(scratch, { force: true });
  }

  console.log(`[make-og] web-src/og.png at ${OG_IMAGE.width}×${OG_IMAGE.height}`);
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]).endsWith('make-og.ts');
if (isMain) main();
