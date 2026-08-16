import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker, { httpMetadataFor, wantsRange } from './dist-worker.ts';

/** Minimal stand-in for the R2 binding: only the three shapes the worker actually reads. */
function bucket(objects: Record<string, string>) {
  const find = (key: string) => {
    const body = objects[key];
    if (body === undefined) return null;
    return { body, httpEtag: `"etag-${key}"`, size: body.length };
  };
  return {
    head: async (key: string) => find(key),
    get: async (key: string, options?: { range?: Headers }) => {
      const object = find(key);
      if (!object) return null;
      const header = options?.range?.get('range');
      if (!header) return object;
      const [start, end] = header.replace('bytes=', '').split('-');
      const offset = Number(start);
      const length = Number(end) - offset + 1;
      return {
        ...object,
        body: object.body.slice(offset, offset + length),
        range: { offset, length },
      };
    },
  };
}

const DMG = 'dl/v0.2.0/DeepSeek-Harness-0.2.0-arm64.dmg';
const env = () =>
  ({
    DIST_BUCKET: bucket({
      'updates/darwin-aarch64.json': '{"version":"0.2.0"}',
      [DMG]: 'MZ-pretend-a-disk-image',
    }),
  }) as never;

const fetch = (path: string, init?: RequestInit) =>
  worker.fetch(new Request(`https://dsh-desktop.xiu.ai${path}`, init), env());

test('serves a published manifest', async () => {
  const response = await fetch('/updates/darwin-aarch64.json');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/json');
  assert.equal(await response.text(), '{"version":"0.2.0"}');
});

test('a manifest is a mutable pointer, so it must not be cached across a release', async () => {
  const response = await fetch('/updates/darwin-aarch64.json');
  assert.match(response.headers.get('cache-control') ?? '', /max-age=300/);
  assert.ok(!response.headers.get('cache-control')?.includes('immutable'));
});

test('a versioned artifact is written once, so it is cached forever', async () => {
  const response = await fetch(`/${DMG}`);
  assert.match(response.headers.get('cache-control') ?? '', /immutable/);
});

test('a whitelisted path with nothing behind it is a 404, not a 500', async () => {
  const response = await fetch('/updates/windows-x86_64.json');
  assert.equal(response.status, 404);
});

test('an unlisted path is refused before the bucket is ever touched', async () => {
  const response = await worker.fetch(
    new Request('https://dsh-desktop.xiu.ai/secret.txt'),
    // A null binding proves the refusal happens without a lookup: touching it would throw.
    { DIST_BUCKET: null } as never,
  );
  assert.equal(response.status, 404);
});

test('HEAD answers with the size without pulling the body out of R2', async () => {
  const response = await fetch(`/${DMG}`, { method: 'HEAD' });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-length'), '23');
  assert.equal(response.headers.get('accept-ranges'), 'bytes');
  assert.equal(await response.text(), '');
});

test('writes are refused — this host is read-only', async () => {
  const response = await fetch(`/${DMG}`, { method: 'PUT' });
  assert.equal(response.status, 405);
  assert.equal(response.headers.get('allow'), 'GET, HEAD');
});

test('a range request gets 206 with a content-range covering exactly what was asked', async () => {
  const response = await fetch(`/${DMG}`, { headers: { range: 'bytes=0-1' } });
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('content-range'), 'bytes 0-1/23');
  assert.equal(await response.text(), 'MZ');
});

test('a plain download is never answered as Partial Content', () => {
  // R2 fills in `object.range` even when the request carried no Range header. Deciding from that
  // would answer an ordinary download with a 206, which is protocol-illegal — a resumed download
  // that starts over would silently truncate. Only the request header may decide.
  assert.equal(wantsRange(new Headers()), false);
  assert.equal(wantsRange(new Headers({ range: 'bytes=0-1' })), true);
});

test('the content type is derived from the artifact kind, never from what was uploaded', () => {
  // The upload side sends no Content-Type on purpose: one table decides, so a forgotten header on
  // an upload cannot make an artifact inherit the wrong caching or type.
  assert.equal(httpMetadataFor('manifest').contentType, 'application/json');
  assert.equal(httpMetadataFor('release').contentType, 'application/octet-stream');
  assert.equal(httpMetadataFor('latest').contentType, 'application/octet-stream');
});
