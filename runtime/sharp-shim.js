/**
 * Pure-JS stand-in for `sharp` that only parses image file headers.
 *
 * Why it can be replaced: the only model channel in this bundle is `dsh-llm-deepseek`, and it
 * explicitly rejects image content
 * (`"The DeepSeek chat-completions adapter does not support image content."`).
 * Images never reach the model, yet 18 MiB of libvips would be carried for them.
 *
 * Why `dsh-attachment-local` cannot just be dropped: `dsh-host-apiproxy` writes `attachments`
 * into its `static inject`, and without it the whole API gateway fails to come up. So the plugin
 * stays and only the engine underneath is swapped.
 *
 * `dsh-attachment-local` touches sharp in exactly three places:
 *   sharp(data, opts) → image
 *   image.metadata()  → { format, width, height }
 *   image.raw().toBuffer()   — the admission-time "these bytes decode fully" check
 *
 * **An honest downgrade**: pure JS cannot decode pixels, so `raw().toBuffer()` degrades to a
 * header check and truncated images pass admission. The cost is acceptable — these bytes only go
 * into local storage, are never decoded again, and never reach the model. For real decode
 * validation, turn off the `imageDecoding` switch and restore the real sharp.
 */

/** Upstream only accepts these four formats; recognizing more would be pointless. */
const PNG_SIGNATURE = 0x89504e47;
const PNG_SIGNATURE_TAIL = 0x0d0a1a0a;

/**
 * Reads the image format and dimensions. Returns undefined when unrecognized; the caller turns
 * that into INVALID_IMAGE.
 * @param {Buffer} buf
 * @returns {{format: string, width: number, height: number} | undefined}
 */
export function parseImageHeader(buf) {
  if (
    buf.length >= 24 &&
    buf.readUInt32BE(0) === PNG_SIGNATURE &&
    buf.readUInt32BE(4) === PNG_SIGNATURE_TAIL
  ) {
    // The PNG spec requires IHDR to be the first chunk; anything else means a corrupt file.
    if (buf.toString('latin1', 12, 16) !== 'IHDR') return undefined;
    return { format: 'png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }

  const gif = buf.length >= 10 ? buf.toString('latin1', 0, 6) : '';
  if (gif === 'GIF87a' || gif === 'GIF89a') {
    // GIF logical screen dimensions are little-endian, the opposite of PNG.
    return { format: 'gif', width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  }

  if (
    buf.length >= 30 &&
    buf.toString('latin1', 0, 4) === 'RIFF' &&
    buf.toString('latin1', 8, 12) === 'WEBP'
  ) {
    return parseWebp(buf);
  }

  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) return parseJpeg(buf);

  return undefined;
}

/** WebP has three container chunks, each encoding the dimensions differently. */
function parseWebp(buf) {
  const chunk = buf.toString('latin1', 12, 16);
  if (chunk === 'VP8 ') {
    // Lossy: 14-bit dimensions; the top 2 bits are the scaling ratio and must be masked off.
    return {
      format: 'webp',
      width: buf.readUInt16LE(26) & 0x3fff,
      height: buf.readUInt16LE(28) & 0x3fff,
    };
  }
  if (chunk === 'VP8L') {
    // Lossless: 14+14 adjacent bits right after the signature byte, both stored as value - 1.
    const bits = buf.readUInt32LE(21);
    return { format: 'webp', width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (chunk === 'VP8X') {
    // Extended: 24-bit little-endian, storing "dimension - 1".
    return { format: 'webp', width: buf.readUIntLE(24, 3) + 1, height: buf.readUIntLE(27, 3) + 1 };
  }
  return undefined;
}

/**
 * Scans to the first SOF segment and reads the dimensions.
 *
 * SOF cannot be assumed at a fixed offset: EXIF, ICC and comment segments precede it with
 * variable lengths.
 */
function parseJpeg(buf) {
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) {
      i += 1;
      continue;
    }
    const marker = buf[i + 1];
    // Fill bytes, SOI, TEM and RSTn are standalone markers carrying no length.
    if (marker === 0xff) {
      i += 1;
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    // 0xC4/0xC8/0xCC fall inside the SOF marker range but are DHT/JPG/DAC and carry no dimensions.
    const isFrameHeader =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrameHeader) {
      return { format: 'jpeg', height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    // Reaching SOS without an SOF means the rest is entropy-coded data; searching further is pointless.
    if (marker === 0xda) return undefined;
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return undefined;
}

class ImageStub {
  #header;

  constructor(data) {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    this.#header = parseImageHeader(buf);
  }

  async metadata() {
    if (this.#header === undefined) throw new Error('sharp-shim: unrecognised image header');
    return this.#header;
  }

  raw() {
    // Upstream only awaits this promise and ignores the value — what it wants is the fact that decoding did not throw.
    return { toBuffer: async () => Buffer.alloc(0) };
  }
}

export default function sharp(data) {
  return new ImageStub(data);
}
