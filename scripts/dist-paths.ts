/**
 * Where every published artifact lives — the single source of truth for the distribution topology.
 *
 * An R2 key and a download URL are two shapes of one fact: the URL path minus its leading `/` *is*
 * the key. The dist worker's routing rests on that identity, and so does the upload side; spelling
 * the two out separately guarantees an eventual manifest pointing at a key nobody ever uploaded.
 *
 * Consumed from both languages on purpose: `dist-worker.ts` imports it to decide what is servable,
 * and `dist.sh` shells out to it for every key it uploads. One table, two readers.
 */

/** Authoritative download host. Also the origin the updater endpoint in `tauri.conf.json` points at. */
export const DIST_BASE_URL = 'https://dsh-desktop.xiu.ai';

/**
 * This build's platform identity, verbatim from Tauri's `{{target}}-{{arch}}` expansion.
 *
 * The client fetches `updates/<platform>.json` and then looks itself up under
 * `platforms[<platform>]` inside that file — so the filename, the key inside it and the tarball
 * name are all derived from this one string. Anything else validates fine and then matches nothing.
 */
export const PLATFORM = 'darwin-aarch64';

/** Product name as it appears in artifact filenames (`productName` with spaces dashed). */
const PRODUCT = 'DeepSeek-Harness';

/**
 * Human-facing architecture label for the DMG. macOS users know "arm64"; "aarch64" is the toolchain
 * spelling nobody types on a download page. The mapping between the two lives here and nowhere else.
 */
const DMG_ARCH = 'arm64';

export type ArtifactKind = 'manifest' | 'release' | 'latest';

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

export function dmgName(version: string): string {
  return `${PRODUCT}-${version}-${DMG_ARCH}.dmg`;
}

export function latestDmgName(): string {
  return `${PRODUCT}-${DMG_ARCH}.dmg`;
}

/** The updater's own artifact: a gzipped `.app`, named per platform so platforms cannot collide. */
export function tarballName(version: string, platform: string): string {
  return `${PRODUCT}-${version}-${platform}.app.tar.gz`;
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
