/**
 * Replaces `@vscode/ripgrep` with the WebAssembly build of the same ripgrep.
 *
 * `@vscode/ripgrep` exists only to resolve a per-platform native binary. The `ripgrep` npm package
 * is the same upstream ripgrep compiled to `wasm32-wasip1`, an order of magnitude smaller. What
 * that trade costs in wall clock is measured once, in `PACKAGE_CUTS.nativeRipgrep`.
 *
 * Why replace this package rather than patch dsh: `dsh-tool-fs-search` reaches ripgrep through
 * exactly one line, `import("@vscode/ripgrep").then((m) => m.rgPath)`. Swapping the package leaves
 * every `@deepseek-ai/*` file untouched, so an upstream release cannot conflict with this.
 */
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Single-quote for `/bin/sh`, so paths with spaces or quotes survive. */
function shellQuote(text) {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

/**
 * The launcher `rgPath` has to name.
 *
 * Callers spawn `rgPath` as a program, so it must be executable on its own. The obvious form — a
 * `#!` line on the wasm package's own `rg.mjs` — cannot work here twice over: the shipped file
 * hardcodes `#!/usr/bin/env node`, and the user's machine has no Node, only our sidecar. Rewriting
 * that shebang to the sidecar fails too, because macOS splits a `#!` line on whitespace and our
 * interpreter lives at `…/DeepSeek Harness.app/Contents/MacOS/dsh-runtime`.
 *
 * A `/bin/sh` stub with a quoted `exec` is the one form that survives both.
 */
export function launcherScript(runtimePath, entryPath) {
  return `#!/bin/sh\nexec ${shellQuote(runtimePath)} ${shellQuote(entryPath)} "$@"\n`;
}

/**
 * The one export `@vscode/ripgrep` has, and the only thing dsh reads from it.
 *
 * The wasm package publishes its own `rgPath` for exactly this purpose, so the entry comes from its
 * public API rather than a subpath its `exports` map does not expose.
 *
 * The launcher goes under `$DSH_HOME`, which the host always sets, and there is deliberately no
 * fallback: writing an executable to a shared temp directory and then spawning it would be a local
 * privilege-escalation surface on any platform where `/tmp` is not per-user.
 *
 * `process.execPath` is read here, at first search, so moving or renaming the app cannot stale it.
 * dsh imports this package lazily, so a run that never searches never writes anything.
 */
const home = process.env.DSH_HOME;
if (home === undefined || home === '') {
  throw new Error(
    'ripgrep-shim: DSH_HOME is unset, so there is nowhere safe to write the launcher',
  );
}
const { rgPath: wasmEntry } = await import('ripgrep');
const dir = join(home, 'cache');
mkdirSync(dir, { recursive: true });
const launcher = join(dir, 'rg');
writeFileSync(launcher, launcherScript(process.execPath, wasmEntry));
chmodSync(launcher, 0o755);

export const rgPath = launcher;
