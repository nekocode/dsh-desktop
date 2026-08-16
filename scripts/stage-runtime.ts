/**
 * Stages the JS runtime binary into Tauri's sidecar directory.
 *
 * Bun by default: 28 MiB smaller than a stripped Node 24. The three things it natively lacks
 * (`stripTypeScriptTypes`, the Node internals HMR needs, and node-pty reading no data) are all
 * patched at build time by `scripts/bun-shim.ts` and `scripts/pty-shim.ts`, and those patches are
 * harmless on Node — one artifact serves both runtimes, and switching runtimes swaps only this binary.
 *
 * The self-check probes **capabilities**, not version numbers: versions change, branch, and get
 * patched by distributions, while "does this API exist" is what we actually depend on.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

export type RuntimeKind = 'bun' | 'node';

/** Tauri requires externalBin files to be named by target triple. */
export function sidecarFileName(base: string, triple: string): string {
  return `${base}-${triple}`;
}

/**
 * The self-check script: if it runs, this binary satisfies our dependencies.
 *
 * On Bun it probes `Bun.Terminal` — the foundation of the PTY adapter, without which the terminal
 * silently returns empty output, the hardest class of failure in this project. On Node it probes
 * `stripTypeScriptTypes`, which Code Mode relies on.
 */
export function capabilityProbe(kind: RuntimeKind): string {
  const check =
    kind === 'bun'
      ? "typeof Bun !== 'undefined' && typeof Bun.Terminal === 'function'"
      : "typeof require('node:module').stripTypeScriptTypes === 'function'";
  return `if (!(${check})) { console.error('MISSING'); process.exit(1); } process.stdout.write('ok')`;
}

export function hostTriple(platform: string, arch: string): string {
  if (platform !== 'darwin') throw new Error(`only macOS is supported for now, got ${platform}`);
  if (arch !== 'arm64' && arch !== 'x64') throw new Error(`unsupported architecture ${arch}`);
  return `${arch === 'arm64' ? 'aarch64' : 'x86_64'}-apple-darwin`;
}

/** Sidecar basename; `smoke.ts` resolves the staged binary from it too. */
export const SIDECAR_BASE = 'dsh-runtime';

/** `command -v` rather than `which`: on some systems the latter is not an executable, only a shell builtin. */
function which(command: string): string {
  return execFileSync('/bin/sh', ['-c', `command -v ${command}`], { encoding: 'utf8' }).trim();
}

function main(): void {
  const root = resolve(import.meta.dirname, '..');
  const kind: RuntimeKind = (process.env['DSH_RUNTIME'] as RuntimeKind) ?? 'bun';
  const source = process.argv[2] ?? which(kind);

  const outDir = join(root, 'src-tauri', 'binaries');
  mkdirSync(outDir, { recursive: true });
  const target = join(
    outDir,
    sidecarFileName(SIDECAR_BASE, hostTriple(process.platform, process.arch)),
  );
  copyFileSync(source, target);

  const before = statSync(target).size;
  // Node's official binary carries a 23 MiB symbol table; Bun ships stripped, so this is a no-op for it.
  execFileSync('strip', ['-S', '-x', target], { stdio: 'pipe' });
  // strip invalidates the signature, and without re-signing the kernel kills the process outright.
  // A release build signs again with the Developer ID later; this ad-hoc signature only makes
  // development runs work.
  execFileSync('codesign', ['--force', '--sign', '-', target]);
  const after = statSync(target).size;

  const mib = (n: number) => (n / 1024 / 1024).toFixed(1);
  console.log(`[stage-runtime] ${kind}: ${source} → ${target}`);
  console.log(`[stage-runtime] ${mib(before)} MiB → ${mib(after)} MiB`);

  const probe = execFileSync(target, ['-e', capabilityProbe(kind)], { encoding: 'utf8' });
  if (probe.trim() !== 'ok')
    throw new Error(`${kind} self-check failed: a required runtime capability is missing`);
  const version = execFileSync(target, ['--version'], { encoding: 'utf8' }).trim();
  console.log(`[stage-runtime] self-check passed: ${kind} ${version}`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]).endsWith('stage-runtime.ts')) main();
