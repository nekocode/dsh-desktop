/**
 * Replaces `dsh-attachment-local`'s sharp with a pure-JS file-header parsing stand-in.
 *
 * The stand-in itself is `runtime/sharp-shim.js` (a real file, not a template string — it is an
 * actual parser and must be unit-testable against real images). This module only decides which
 * import to rewrite and what the file is called.
 */
import type { ImportRewrite } from './import-rewrite.ts';

/** Filename copied into the package. */
export const SHARP_SHIM_FILENAME = 'dsh-desktop-sharp-shim.js';

/** Source file of the stand-in, relative to the repository root. */
export const SHARP_SHIM_SOURCE = 'runtime/sharp-shim.js';

export const SHARP_REWRITE: ImportRewrite = {
  target: '@deepseek-ai/dsh-attachment-local/lib/index.js',
  shimFilename: SHARP_SHIM_FILENAME,
  pattern: /import\s+sharp\s+from\s*['"]sharp['"]\s*;?/,
  replacement: `import sharp from "./${SHARP_SHIM_FILENAME}";`,
  body: { copyFrom: SHARP_SHIM_SOURCE },
  consequence:
    'the artifact ships without the 18 MiB of libvips it still imports and crashes outright',
};
