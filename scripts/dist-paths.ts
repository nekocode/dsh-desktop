/**
 * Where every published artifact lives — the single source of truth for the distribution topology.
 *
 * An R2 key and a download URL are two shapes of one fact: the URL path minus its leading `/` *is*
 * the key. The dist worker's routing rests on that identity, and so does the upload side; spelling
 * the two out separately guarantees an eventual manifest pointing at a key nobody ever uploaded.
 *
 * Consumed from both languages on purpose: `dist-worker.ts` imports it to decide what is servable,
 * and `dist.sh` shells out to it for every key it uploads. One table, two readers.
 *
 * Nothing here reads the environment, and the target arrives as an argument. The Worker bundles
 * this module, and a top-level `currentTarget()` would put a build-time decision inside a running
 * edge script.
 */
import type { Target } from './target.ts';

/** Authoritative download host. Also the origin the updater endpoint in `tauri.conf.json` points at. */
export const DIST_BASE_URL = 'https://dsh-desktop.xiu.ai';

/** Product name as it appears in artifact filenames (`productName` with spaces dashed). */
const PRODUCT = 'DeepSeek-Harness';

export type ArtifactKind = 'manifest' | 'release' | 'latest';

/**
 * The path prefixes every published artifact lives under.
 *
 * `wrangler.jsonc` restates these as `run_worker_first` globs — it cannot import TypeScript —
 * and `dist-paths.test.ts` fails when the two disagree. Without that, adding a prefix here
 * would leave the new route relying on the asset layer *not* claiming it first, which is the
 * exact accident `run_worker_first` exists to stop depending on.
 */
export const ARTIFACT_PREFIXES = ['dl', 'updates'] as const;

/** Per-platform update manifest. One file per platform, never a shared `latest.json`. */
export function manifestKey(platform: string): string {
  return `updates/${platform}.json`;
}

/** Versioned artifact. Written once and never overwritten, which is what lets it be cached forever. */
export function releaseKey(version: string, filename: string): string {
  return `dl/v${version}/${filename}`;
}

/** Mutable alias for download pages, so a release does not mean editing HTML. */
export function latestKey(filename: string): string {
  return `dl/latest/${filename}`;
}

export function url(key: string): string {
  return `${DIST_BASE_URL}/${key}`;
}

/**
 * What a person downloads: the DMG on macOS, the installer on Windows.
 *
 * Named from the target rather than spelled out per platform, because the two differ only in the
 * suffix — and because the Worker's route whitelist rejects spaces, which is exactly what Tauri's
 * own `DeepSeek Harness_0.1.0_x64-setup.exe` contains. Renaming to this on the way into `dist/` is
 * what keeps a published URL from 404ing.
 */
export function artifactName(target: Target, version: string): string {
  return `${PRODUCT}-${version}-${target.archLabel}${target.downloadSuffix}`;
}

/** The unversioned alias a download page can hard-code. */
export function latestArtifactName(target: Target): string {
  return `${PRODUCT}-${target.archLabel}${target.downloadSuffix}`;
}

/**
 * What the updater downloads.
 *
 * On Windows it is the installer itself — the same file as `artifactName`, which the publisher
 * relies on to upload one object instead of two identical ones. On macOS it is a gzipped `.app`,
 * named per platform so two platforms cannot collide in one directory.
 */
export function updaterPayloadName(target: Target, version: string): string {
  return target.updaterPayload === 'installer'
    ? artifactName(target, version)
    : `${PRODUCT}-${version}-${target.updaterPlatform}.app.tar.gz`;
}

/**
 * The whitelist. Matching by shape rather than forwarding whatever the path says keeps the worker
 * from degrading into a public proxy for every object the bucket may ever hold.
 *
 * Platforms are matched by shape, not by an enumerated list: a Windows or Linux release will be cut
 * by a separate pipeline, and it must be able to publish without this worker being redeployed first.
 */
const ROUTES: ReadonlyArray<{ pattern: RegExp; kind: ArtifactKind }> = [
  { pattern: /^updates\/[a-z0-9]+-[a-z0-9_]+\.json$/, kind: 'manifest' },
  // Semver including prereleases (`0.2.0-rc.1`); the filename may not contain a slash, which is
  // also what keeps `..` traversal out.
  {
    pattern: /^dl\/v\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?\/[A-Za-z0-9][A-Za-z0-9._-]*$/,
    kind: 'release',
  },
  { pattern: /^dl\/latest\/[A-Za-z0-9][A-Za-z0-9._-]*$/, kind: 'latest' },
];

export function classify(pathname: string): { key: string; kind: ArtifactKind } | null {
  const key = pathname.slice(1);
  for (const { pattern, kind } of ROUTES) {
    if (pattern.test(key)) return { key, kind };
  }
  return null;
}
