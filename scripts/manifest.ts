/**
 * The update manifest: what the client fetches, and the whole of what it is told about a release.
 *
 * One file per platform. The client validates the entire manifest before it so much as compares the
 * version, so a single malformed entry in a shared `latest.json` would stop *every* platform from
 * updating — and a shared file also means two release pipelines read-modify-writing one object.
 * Split per platform, a bad publish can only break the platform it was published for.
 *
 * Built here rather than by a heredoc in the release script so that the ways a manifest can be
 * quietly wrong — an empty signature, a `v` prefix, a plain-http URL — fail at build time instead of
 * on a user's machine, where the symptom is an update that never installs and says nothing.
 */

export type ManifestInput = {
  /** Bare semver, exactly as it appears in `package.json`. */
  version: string;
  /** Release notes, shown verbatim in the update window. May be empty. */
  notes: string;
  /** RFC 3339 timestamp. */
  pubDate: string;
  /** Tauri's `{{target}}-{{arch}}` identity for the artifact. */
  platform: string;
  url: string;
  /** Contents of the `.sig` produced by `tauri signer sign`. */
  signature: string;
};

export function buildManifest(input: ManifestInput): string {
  // A leading `v` is not a formatting nit: the client compares versions, and `v0.2.0` parses as
  // neither newer nor older than anything, so every install would be offered this "update" forever.
  if (!/^\d+\.\d+\.\d+/.test(input.version)) {
    throw new Error(`version must be bare semver, got "${input.version}"`);
  }
  if (!input.signature.trim()) {
    throw new Error('signature is empty — the client would reject the update after downloading it');
  }
  if (!input.url.startsWith('https://')) {
    throw new Error(`url must be https, got "${input.url}"`);
  }

  return `${JSON.stringify(
    {
      version: input.version,
      notes: input.notes,
      pub_date: input.pubDate,
      platforms: {
        [input.platform]: {
          signature: input.signature,
          url: input.url,
        },
      },
    },
    null,
    2,
  )}\n`;
}
