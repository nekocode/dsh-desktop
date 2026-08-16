/**
 * Swaps the native ripgrep binary for the WebAssembly build of the same tool.
 *
 * The replacement itself is `runtime/ripgrep-shim.js` (a real file, not a template string — it
 * writes a launcher and must be unit-testable). This module is data only: what is replaced, what
 * the replacement needs, and what has to stay true upstream. The trade this buys — size against
 * wall clock — is recorded once, in `PACKAGE_CUTS.nativeRipgrep`.
 *
 * Unlike the three `ImportRewrite` shims, nothing here touches `@deepseek-ai/*` source: the entry
 * file of a third-party package is replaced instead, so an upstream dsh release has nothing to
 * conflict with.
 */
import { HOST_TAG } from './prune.ts';
import type { EntryReplacement } from './trim.ts';

/** The per-platform native binary the wasm build makes unnecessary. */
export const NATIVE_RIPGREP_PACKAGE = `@vscode/ripgrep-${HOST_TAG}`;

export const RIPGREP_REPLACEMENT: EntryReplacement = {
  target: '@vscode/ripgrep/lib/index.js',
  source: 'runtime/ripgrep-shim.js',
  /** nft cannot trace it — the shim resolves it at runtime — so it is copied whole. */
  needs: ['ripgrep'],
  expects: 'rgPath',
  consequence:
    'the grep and glob tools would resolve no binary and every search would fail at runtime',
};
