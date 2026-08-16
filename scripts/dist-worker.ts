/**
 * The distribution worker: exposes the R2 bucket `dsh-desktop-dist` as `dsh-desktop.xiu.ai`.
 *
 * It serves exactly what `dist-paths.ts` says is publishable and nothing else. Forwarding whatever
 * the path happens to say would turn the host into a public proxy for every object the bucket may
 * ever hold, including artifacts that were never meant to be downloadable.
 *
 * It also fronts the landing page, which ships as this Worker's static assets — the hostname is
 * already a Worker custom domain, so nothing else can claim it.
 *
 * Deployed by `npm run deploy:dist`, which renders `web/` first; a bare `wrangler deploy` would
 * upload whatever that directory happens to hold, and it is not tracked. The routing rules have
 * unit tests, which is why this is a real file rather than something a deploy script echoes
 * into place.
 */

import { classify, type ArtifactKind } from './dist-paths.ts';
import { notFoundUrlFor } from '../web-src/site.ts';

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

/** The static-assets binding. Only `fetch` is used, so only `fetch` is typed. */
type Assets = { fetch(request: Request): Promise<Response> };

type Env = { DIST_BUCKET: Bucket; ASSETS: Assets };

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

/**
 * The landing page's 404, in the reader's language, served by this Worker rather than by the
 * asset layer's `not_found_handling`.
 *
 * That option cannot be used here. Since compatibility date 2025-04-01 the runtime prefers
 * asset serving for navigation requests, so with a `404-page` fallback configured, clicking a
 * download link — a navigation request that matches no static asset — would be answered with
 * the 404 page instead of ever reaching this handler. Every browser download would break, and
 * nothing but a browser would notice.
 *
 * A missing artifact is answered the same way. It is a wrong URL, not a different kind of
 * event, and the page says so in a form a person can read.
 */
async function notFound(url: URL, env: Env): Promise<Response> {
  const page = await env.ASSETS.fetch(new Request(new URL(notFoundUrlFor(url.pathname), url)));
  return new Response(page.body, {
    status: 404,
    headers: { 'content-type': page.headers.get('content-type') ?? 'text/html; charset=utf-8' },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const artifact = classify(url.pathname);
    if (!artifact) return notFound(url, env);

    const { contentType, cacheControl } = httpMetadataFor(artifact.kind);
    const headers = new Headers({
      'content-type': contentType,
      'cache-control': cacheControl,
    });

    if (request.method === 'HEAD') {
      // head() skips the body entirely, saving a full read of a 35 MB object per probe.
      const meta = await env.DIST_BUCKET.head(artifact.key);
      if (!meta) return notFound(url, env);
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
    if (!object) return notFound(url, env);

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
