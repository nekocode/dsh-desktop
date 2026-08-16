/**
 * Publishes a signed, notarized build: artifacts to R2, manifest to R2, DMG to a GitHub Release.
 *
 * Invoked by `scripts/dist.sh --release`, which is the only thing that can guarantee the artifacts
 * on disk are the notarized ones. Everything this script needs is derived from the version, so it
 * cannot be handed a DMG from one build and a tarball from another.
 *
 * Publish order is the part that matters, and it is not a style choice — see `main`.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  PLATFORM,
  dmgName,
  latestDmgName,
  latestKey,
  manifestKey,
  releaseKey,
  tarballName,
  url,
} from './dist-paths.ts';
import { buildManifest } from './manifest.ts';

/** R2 bucket behind dsh-desktop.xiu.ai. Pinned against `wrangler.jsonc` by `publish.test.ts`. */
export const BUCKET = 'dsh-desktop-dist';

/** Where `dist.sh` leaves its artifacts. */
export const DIST_DIR = 'dist';

export const GITHUB_REPO = 'nekocode/dsh-desktop';

/**
 * Cloudflare auth profile (`wrangler auth list`). Overridable so a second maintainer does not have
 * to name their profile after this one.
 */
const WRANGLER_PROFILE = process.env.WRANGLER_PROFILE ?? 'xiu';

/** How long to keep re-reading a freshly published object before calling it a failed publish. */
const VERIFY_ATTEMPTS = 5;
const VERIFY_DELAY_MS = 4000;

/** Exported because `make-fonts.ts` hashes its output the same way; one spelling, one meaning. */
export const sha256 = (bytes: Buffer | Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex');

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

function put(key: string, file: string): void {
  // `--remote` is not optional. Without it wrangler writes to a *local simulation* of the bucket
  // and still reports "Upload complete", so the release passes every check it runs on itself and
  // publishes nothing at all.
  execFileSync(
    'wrangler',
    [
      'r2',
      'object',
      'put',
      `${BUCKET}/${key}`,
      '--file',
      file,
      '--remote',
      '--profile',
      WRANGLER_PROFILE,
    ],
    { stdio: 'pipe' },
  );
  console.log(`[publish] r2 put ${key}`);
}

/**
 * Reads the object back over the public host and compares bytes.
 *
 * A successful upload call is not the same fact as "the right bytes are downloadable": the Worker
 * binding, the route and the cache all sit in between, and each has its own way of being wrong.
 *
 * The cache-busting query is what makes this a real check — the manifest is served with a 5 minute
 * TTL, and the Worker routes on the path alone, so a unique query reaches R2 while an ordinary URL
 * could be answered from the edge copy of the *previous* release.
 */
async function verify(key: string, file: string): Promise<void> {
  const expected = sha256(readFileSync(file));
  for (let attempt = 1; attempt <= VERIFY_ATTEMPTS; attempt++) {
    const response = await fetch(`${url(key)}?published=${Date.now()}`, { cache: 'no-store' });
    if (response.ok) {
      const actual = sha256(new Uint8Array(await response.arrayBuffer()));
      if (actual === expected) {
        console.log(`[publish] verified ${url(key)}`);
        return;
      }
      throw new Error(`published bytes differ at ${url(key)} (want ${expected}, got ${actual})`);
    }
    if (attempt < VERIFY_ATTEMPTS) await sleep(VERIFY_DELAY_MS);
  }
  throw new Error(`${url(key)} never became readable after ${VERIFY_ATTEMPTS} attempts`);
}

/**
 * The GitHub Release is the download entry point for people who do not have the app yet; R2 is what
 * the installed app updates from. Failing to create it must not fail the release — by the time this
 * runs, the update path is already live and correct.
 */
function githubRelease(version: string, notes: string, dmg: string): void {
  const title = `v${version}`;
  try {
    execFileSync(
      'gh',
      ['release', 'create', title, '--repo', GITHUB_REPO, '--title', title, '--notes', notes, dmg],
      { stdio: 'pipe' },
    );
    console.log(`[publish] github release ${title} created`);
  } catch {
    // Already released (a re-run, or a release cut by hand): replace the asset instead.
    execFileSync('gh', ['release', 'upload', title, '--repo', GITHUB_REPO, '--clobber', dmg], {
      stdio: 'pipe',
    });
    console.log(`[publish] github release ${title} asset replaced`);
  }
}

export async function publish(version: string, notes: string, distDir: string): Promise<void> {
  const dmg = join(distDir, dmgName(version));
  const tarball = join(distDir, tarballName(version, PLATFORM));
  // `tauri signer sign` writes the signature next to what it signed.
  const signature = readFileSync(`${tarball}.sig`, 'utf8').trim();

  const tarballKey = releaseKey(version, tarballName(version, PLATFORM));
  const dmgKey = releaseKey(version, dmgName(version));

  // Order is the whole design here. Immutable artifacts go up first and are verified before
  // anything points at them; the manifest — the only object a running app reads — goes last. The
  // other way round leaves a window where every client is told about a version whose bytes are
  // still 404, and an update that fails once is an update the user stops trusting.
  put(tarballKey, tarball);
  put(dmgKey, dmg);
  await verify(tarballKey, tarball);
  await verify(dmgKey, dmg);

  // Mutable alias for download pages, so publishing does not mean editing HTML.
  put(latestKey(latestDmgName()), dmg);

  const manifestPath = join(distDir, `${PLATFORM}.json`);
  writeFileSync(
    manifestPath,
    buildManifest({
      version,
      notes,
      pubDate: new Date().toISOString(),
      platform: PLATFORM,
      url: url(tarballKey),
      signature,
    }),
  );
  put(manifestKey(PLATFORM), manifestPath);
  await verify(manifestKey(PLATFORM), manifestPath);

  githubRelease(version, notes || `DeepSeek Harness v${version}`, dmg);
  console.log(`[publish] v${version} is live at ${url(manifestKey(PLATFORM))}`);
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]).endsWith('publish.ts');
if (isMain) {
  const [version, notesFile] = process.argv.slice(2);
  if (!version) {
    console.error('usage: publish.ts <version> [notes-file]');
    process.exit(1);
  }
  const notes = notesFile ? readFileSync(notesFile, 'utf8').trim() : '';
  await publish(version, notes, join(resolve(import.meta.dirname, '..'), DIST_DIR));
}
