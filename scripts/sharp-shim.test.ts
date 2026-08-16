import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp, { parseImageHeader } from '../runtime/sharp-shim.js';
import { IMAGES } from './fixtures.ts';

const bytes = (key: keyof typeof IMAGES) => Buffer.from(IMAGES[key].b64, 'base64');

test('reads format and dimensions from real images of all four formats', async () => {
  for (const [key, expected] of Object.entries(IMAGES)) {
    const meta = await sharp(bytes(key as keyof typeof IMAGES)).metadata();
    assert.equal(meta.width, expected.width, `${key} width`);
    assert.equal(meta.height, expected.height, `${key} height`);
  }
});

test("format names line up with upstream's MEDIA_TYPES table — a mismatch is judged INVALID_IMAGE", async () => {
  const formats = await Promise.all(
    (['png', 'jpeg', 'webp', 'gif'] as const).map((k) => sharp(bytes(k)).metadata()),
  );
  assert.deepEqual(
    formats.map((m) => m.format),
    ['png', 'jpeg', 'webp', 'gif'],
  );
});

test('lossless WebP takes another branch, encoding dimensions completely differently from lossy', async () => {
  const meta = await sharp(bytes('webp_lossless')).metadata();
  assert.equal(meta.width, IMAGES.webp_lossless.width);
  assert.equal(meta.height, IMAGES.webp_lossless.height);
});

test('a JPEG SOF is not at a fixed offset — with EXIF there are segments before it', async () => {
  const meta = await sharp(bytes('jpeg_exif')).metadata();
  assert.equal(meta.width, IMAGES.jpeg_exif.width);
  assert.equal(meta.height, IMAGES.jpeg_exif.height);
});

test('width and height must not be swapped: the fixtures are deliberately non-square', () => {
  for (const value of Object.values(IMAGES)) assert.notEqual(value.width, value.height);
});

test('unrecognized bytes return undefined, which upstream turns into INVALID_IMAGE', () => {
  assert.equal(parseImageHeader(Buffer.from('not an image at all, really')), undefined);
  assert.equal(parseImageHeader(Buffer.alloc(0)), undefined);
  // Valid header but truncated before the dimensions
  assert.equal(parseImageHeader(bytes('png').subarray(0, 12)), undefined);
});

test('metadata() throws when unrecognized instead of returning undefined for upstream to destructure', async () => {
  await assert.rejects(() => sharp(Buffer.from('nope')).metadata(), /unrecognised/);
});

test('raw().toBuffer() is awaitable — upstream only wants the fact that decoding did not throw', async () => {
  const buf = await sharp(bytes('png')).raw().toBuffer();
  assert.ok(Buffer.isBuffer(buf));
});

test('a PNG whose first chunk is not IHDR is treated as corrupt', () => {
  const broken = Buffer.from(bytes('png'));
  broken.write('XHDR', 12, 'latin1');
  assert.equal(parseImageHeader(broken), undefined);
});
