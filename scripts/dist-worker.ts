/**
 * The distribution worker: exposes the R2 bucket `dsh-desktop-dist` as `dsh-desktop.xiu.ai`.
 *
 * It serves exactly what `dist-paths.ts` says is publishable and nothing else. Forwarding whatever
 * the path happens to say would turn the host into a public proxy for every object the bucket may
 * ever hold, including artifacts that were never meant to be downloadable.
 *
 * Deployed by `wrangler deploy` (see `wrangler.jsonc`); the routing rules have unit tests, which is
 * why this is a real file rather than something a deploy script echoes into place.
 */

import { classify, type ArtifactKind } from './dist-paths.ts';

/** R2 surface actually used here. Typing only these three keeps the tests free of a Workers runtime. */
type Bucket = {
  head(key: string): Promise<{ httpEtag: string; size: number } | null>;
  get(
    key: string,
    options?: { range?: Headers; onlyIf?: Headers },
  ): Promise<{
    body?: ReadableStream<Uint8Array> | string;
    httpEtag: string;
    size: number;
    range?: { offset: number; length: number };
  } | null>;
};

type Env = { DIST_BUCKET: Bucket };

// A versioned key is written once and never overwritten, so it can be cached until the heat death of
// the universe. Manifests and `latest` aliases are rewritten by every release: cache them long and
// clients sit on a stale edge copy after a release, seeing an update that no longer exists.
const MUTABLE_POINTER = 'public, max-age=300';
const IMMUTABLE_OBJECT = 'public, max-age=31536000, immutable';
const OCTET_STREAM = 'application/octet-stream';

/**
 * Response headers come from the artifact kind, by table — never from metadata stored at upload
 * time. That way an upload that forgets a header cannot leave an artifact quietly serving the wrong
 * type or the wrong cache lifetime.
 */
export function httpMetadataFor(kind: ArtifactKind): {
  contentType: string;
  cacheControl: string;
} {
  switch (kind) {
    case 'manifest':
      return { contentType: 'application/json', cacheControl: MUTABLE_POINTER };
    case 'latest':
      return { contentType: OCTET_STREAM, cacheControl: MUTABLE_POINTER };
    case 'release':
      return { contentType: OCTET_STREAM, cacheControl: IMMUTABLE_OBJECT };
  }
}

/**
 * Only a request that actually carried a Range header is a range request.
 *
 * R2 populates `object.range` with the whole object even when nothing was asked for, so deciding
 * from the response would answer an ordinary download with a 206 — protocol-illegal, and the kind
 * of bug that shows up as a truncated download much later.
 */
export function wantsRange(headers: Headers): boolean {
  return headers.get('range') !== null;
}

function notFound(): Response {
  return new Response('Not found', { status: 404 });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const artifact = classify(new URL(request.url).pathname);
    if (!artifact) return notFound();

    const { contentType, cacheControl } = httpMetadataFor(artifact.kind);
    const headers = new Headers({
      'content-type': contentType,
      'cache-control': cacheControl,
    });

    if (request.method === 'HEAD') {
      // head() skips the body entirely, saving a full read of a 35 MB object per probe.
      const meta = await env.DIST_BUCKET.head(artifact.key);
      if (!meta) return notFound();
      headers.set('etag', meta.httpEtag);
      headers.set('content-length', String(meta.size));
      headers.set('accept-ranges', 'bytes');
      return new Response(null, { headers });
    }
    if (request.method !== 'GET') {
      return new Response('Method not allowed', {
        status: 405,
        headers: { allow: 'GET, HEAD' },
      });
    }

    // Range and conditional handling are handed to the R2 binding rather than hand-rolled; `range`
    // is passed only when the request truly carried one (see `wantsRange`).
    const isRange = wantsRange(request.headers);
    const options: { range?: Headers; onlyIf?: Headers } = { onlyIf: request.headers };
    if (isRange) options.range = request.headers;

    const object = await env.DIST_BUCKET.get(artifact.key, options);
    if (!object) return notFound();

    headers.set('etag', object.httpEtag);
    headers.set('accept-ranges', 'bytes');

    // A conditional request that matched comes back as metadata with no body at all.
    if (!('body' in object)) return new Response(null, { status: 304, headers });

    if (isRange && object.range) {
      const { offset, length } = object.range;
      headers.set('content-range', `bytes ${offset}-${offset + length - 1}/${object.size}`);
      return new Response(object.body, { status: 206, headers });
    }
    return new Response(object.body, { headers });
  },
};
