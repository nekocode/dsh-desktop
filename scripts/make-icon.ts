/**
 * Generates the app icon: the whale from the official favicon + the official brand blue.
 *
 * Neither source of truth is copied by hand:
 * - the artwork is read from `dsh-web-frontend/dist/favicon.svg` in the upstream install directory,
 *   so it follows whenever upstream changes its logo;
 * - the color is `#4D6BFE`, from the official badge asset `dsh-skill-badge/assets/dsh-badge.md`,
 *   whose exact wording is "Do not substitute another color".
 *
 * Rasterization borrows headless Chrome — this machine has no rsvg/cairo, and Chrome is the only
 * thing that guarantees the SVG renders exactly as it does in the UI.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/** The official brand blue. See dsh-skill-badge/assets/dsh-badge.md. */
export const BRAND_BLUE = '#4D6BFE';

/** Location of the upstream favicon, relative to node_modules. */
export const FAVICON_PATH = '@deepseek-ai/dsh-web-frontend/dist/favicon.svg';

/**
 * Extracts the whale's path data from the favicon.
 *
 * Throws when not found: upstream changing the SVG structure while we quietly fall back to the old
 * icon is the worst outcome — an icon never crashes, it just stays wrong forever.
 */
export function extractPathData(svgText: string): string {
  const match = /<path[^>]*\sd="([^"]+)"/.exec(svgText);
  if (match?.[1] === undefined) {
    throw new Error(
      'no <path d="..."> found in the official favicon; upstream changed its structure',
    );
  }
  return match[1];
}

export type IconLayout = {
  /** Canvas edge length (px). */
  readonly size: number;
  /** Rounded square size as a fraction of the canvas. Apple's macOS template is 824/1024. */
  readonly bodyRatio: number;
  /** Corner radius as a fraction of the square's edge. Apple's template is 185.4/824. */
  readonly cornerRatio: number;
  /** Artwork size as a fraction of the canvas. */
  readonly artRatio: number;
};

/** Apple's macOS icon grid since Big Sur. */
export const MACOS_LAYOUT: IconLayout = {
  size: 1024,
  bodyRatio: 824 / 1024,
  cornerRatio: 185.4 / 824,
  artRatio: 0.55,
};

/**
 * Composes the final SVG: a brand-blue rounded square + a white whale.
 *
 * The whale is placed with a nested `<svg viewBox>` + `preserveAspectRatio` rather than a
 * hand-computed transform, so a change to upstream's viewBox size cannot misalign it.
 */
export function composeIconSvg(pathData: string, layout: IconLayout = MACOS_LAYOUT): string {
  const { size } = layout;
  const body = Math.round(size * layout.bodyRatio);
  const bodyOffset = Math.round((size - body) / 2);
  const corner = Math.round(body * layout.cornerRatio);
  const art = Math.round(size * layout.artRatio);
  const artOffset = Math.round((size - art) / 2);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect x="${bodyOffset}" y="${bodyOffset}" width="${body}" height="${body}" rx="${corner}" ry="${corner}" fill="${BRAND_BLUE}"/>
  <svg x="${artOffset}" y="${artOffset}" width="${art}" height="${art}" viewBox="0 0 50 50" preserveAspectRatio="xMidYMid meet">
    <path d="${pathData}" fill="#FFFFFF"/>
  </svg>
</svg>
`;
}

/** Wraps the SVG in HTML so headless Chrome's screenshot has no white margin or scrollbars. */
export function wrapForRender(svg: string, size: number): string {
  return `<!doctype html><meta charset="utf-8">
<style>html,body{margin:0;padding:0;width:${size}px;height:${size}px;overflow:hidden;background:transparent}</style>
${svg}`;
}

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

function main(): void {
  const root = resolve(import.meta.dirname, '..');
  const favicon = join(root, 'build', 'upstream', 'node_modules', FAVICON_PATH);
  if (!existsSync(favicon)) {
    throw new Error(
      `upstream favicon not found: ${favicon}\nRun npm run build:backend once to install upstream first.`,
    );
  }

  const svg = composeIconSvg(extractPathData(readFileSync(favicon, 'utf8')));
  const design = join(root, 'design');
  mkdirSync(design, { recursive: true });
  writeFileSync(join(design, 'icon.svg'), svg);

  // The site wears the same icon as the app, from the same artwork, in the same command.
  // It is committed because `design/` is not, and because the landing page has to build from
  // a clean checkout — upstream's favicon only exists after a backend build.
  writeFileSync(join(root, 'web-src', 'icon.svg'), svg);

  // The render HTML is an intermediate artifact; keep it out of the repo directory.
  const html = join(tmpdir(), 'dsh-desktop-icon-render.html');
  writeFileSync(html, wrapForRender(svg, MACOS_LAYOUT.size));

  // This machine has no rsvg/cairo; Chrome is the only rasterizer that guarantees the result matches the UI.
  execFileSync(
    CHROME,
    [
      '--headless',
      '--disable-gpu',
      '--default-background-color=00000000',
      `--screenshot=${join(design, 'icon.png')}`,
      `--window-size=${MACOS_LAYOUT.size},${MACOS_LAYOUT.size}`,
      `file://${html}`,
    ],
    { stdio: 'pipe' },
  );

  execFileSync(
    'npx',
    ['tauri', 'icon', join(design, 'icon.png'), '-o', join(root, 'src-tauri', 'icons')],
    {
      cwd: root,
      stdio: 'pipe',
    },
  );

  console.log(`[make-icon] brand blue ${BRAND_BLUE}, artwork from ${FAVICON_PATH}`);
  console.log(
    `[make-icon] design/icon.svg + design/icon.png + src-tauri/icons/ + web-src/icon.svg updated`,
  );
}

if (process.argv[1] !== undefined && resolve(process.argv[1]).endsWith('make-icon.ts')) main();
