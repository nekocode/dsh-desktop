/**
 * Stages the JS runtime binary into Tauri's sidecar directory.
 *
 * Bun on both platforms. On macOS it is 28 MiB smaller than a stripped Node 24; on Windows it is
 * 5 MiB *larger* than node.exe (PE keeps its symbols in a separate .pdb, so the strip that pays for
 * Node on macOS has nothing to remove there) — it is used anyway, because one runtime across
 * platforms means one set of patches, and because `Bun.Terminal` removes the last native module
 * from the Windows artifact.
 *
 * The three things Bun natively lacks (`stripTypeScriptTypes`, the Node internals HMR needs, and
 * node-pty reading no data) are all patched at build time by `scripts/bun-shim.ts` and
 * `scripts/pty-shim.ts`, and those patches are harmless on Node — one artifact serves both
 * runtimes, and switching runtimes swaps only this binary.
 *
 * Building for the host and cross-building are deliberately different: the host binary comes from
 * whatever Bun is installed and is probed for the capabilities we depend on, while a cross-built
 * one is downloaded at a pinned version and cannot be probed at all — it does not run here.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { currentTarget, hostTag, type Target, type TargetTag } from './target.ts';

export type RuntimeKind = 'bun' | 'node';

/**
 * The Bun version a cross-build downloads.
 *
 * 1.3.14 is a floor, not a preference: it is the release where `Bun.Terminal` / `Bun.spawn({
 * terminal })` started driving ConPTY on Windows. Below it the Windows artifact has no pty at all,
 * and the bash tool returns empty output rather than failing — the worst failure shape there is.
 */
export const BUN_VERSION = '1.3.14';

/** Tauri requires externalBin files to be named by target triple, extension included. */
export function sidecarFileName(base: string, target: Target): string {
  return `${base}-${target.sidecarSuffix}`;
}

/**
 * Bun's own name for a platform. It matches neither node's (`win32`/`x64`) nor Rust's
 * (`x86_64-pc-windows-msvc`), so it is a third table rather than a transformation of either.
 */
const BUN_ASSET: Readonly<Record<TargetTag, string>> = {
  'darwin-arm64': 'bun-darwin-aarch64',
  'win32-x64': 'bun-windows-x64',
};

/** Where a pinned Bun build is published, and where its executable sits inside the archive. */
export function bunRelease(
  target: Target,
  version: string,
): { readonly url: string; readonly member: string } {
  const asset = BUN_ASSET[target.tag];
  return {
    url: `https://github.com/oven-sh/bun/releases/download/bun-v${version}/${asset}.zip`,
    member: `${asset}/bun${target.exeSuffix}`,
  };
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

/** Sidecar basename; `smoke.ts` resolves the staged binary from it too. */
export const SIDECAR_BASE = 'dsh-runtime';

/** `command -v` rather than `which`: on some systems the latter is not an executable, only a shell builtin. */
function which(command: string): string {
  return execFileSync('/bin/sh', ['-c', `command -v ${command}`], { encoding: 'utf8' }).trim();
}

const mib = (n: number) => (n / 1024 / 1024).toFixed(1);

/**
 * Downloads the pinned runtime for a target this machine cannot run, caching it under `build/`.
 *
 * The cache key carries the version, so bumping `BUN_VERSION` fetches a new file instead of
 * silently reusing the old one — the failure that would otherwise ship a Windows build with no pty.
 */
function fetchCrossRuntime(root: string, target: Target): string {
  const { url, member } = bunRelease(target, BUN_VERSION);
  const cacheDir = join(root, 'build', 'runtime-cache');
  const cached = join(cacheDir, `bun-${BUN_VERSION}-${target.tag}${target.exeSuffix}`);
  if (existsSync(cached)) {
    console.log(`[stage-runtime] cache hit: ${cached}`);
    return cached;
  }

  mkdirSync(cacheDir, { recursive: true });
  const archive = join(cacheDir, `bun-${BUN_VERSION}-${target.tag}.zip`);
  console.log(`[stage-runtime] downloading ${url}`);
  execFileSync('curl', ['-sSfL', '-o', archive, url], { stdio: 'inherit' });
  // -j flattens the archive's directory, -o overwrites: the same two flags make the extracted path
  // predictable regardless of how the release was packed.
  execFileSync('unzip', ['-o', '-j', '-q', archive, member, '-d', cacheDir], { stdio: 'inherit' });
  const extracted = join(cacheDir, `bun${target.exeSuffix}`);
  if (!existsSync(extracted)) throw new Error(`archive did not contain ${member}: ${url}`);
  // Rename rather than copy, and drop the archive: three copies of a 94 MiB binary would otherwise
  // accumulate per version, and only the version-keyed one is ever read again.
  renameSync(extracted, cached);
  rmSync(archive, { force: true });
  return cached;
}

/** Host build: the installed Bun, stripped, ad-hoc signed and probed for the APIs we rely on. */
function stageHostRuntime(kind: RuntimeKind, source: string, sidecar: string): void {
  copyFileSync(source, sidecar);

  const before = statSync(sidecar).size;
  // Node's official binary carries a 23 MiB symbol table; Bun ships stripped, so this is a no-op for it.
  execFileSync('strip', ['-S', '-x', sidecar], { stdio: 'pipe' });
  // strip invalidates the signature, and without re-signing the kernel kills the process outright.
  // A release build signs again with the Developer ID later; this ad-hoc signature only makes
  // development runs work.
  execFileSync('codesign', ['--force', '--sign', '-', sidecar]);
  console.log(`[stage-runtime] ${mib(before)} MiB → ${mib(statSync(sidecar).size)} MiB`);

  const probe = execFileSync(sidecar, ['-e', capabilityProbe(kind)], { encoding: 'utf8' });
  if (probe.trim() !== 'ok')
    throw new Error(`${kind} self-check failed: a required runtime capability is missing`);
  const version = execFileSync(sidecar, ['--version'], { encoding: 'utf8' }).trim();
  console.log(`[stage-runtime] self-check passed: ${kind} ${version}`);
}

function main(): void {
  const root = resolve(import.meta.dirname, '..');
  const target = currentTarget();
  const kind: RuntimeKind = (process.env['DSH_RUNTIME'] as RuntimeKind) ?? 'bun';
  const cross = target.tag !== hostTag();

  const outDir = join(root, 'src-tauri', 'binaries');
  mkdirSync(outDir, { recursive: true });
  const sidecar = join(outDir, sidecarFileName(SIDECAR_BASE, target));

  if (cross) {
    if (kind !== 'bun') throw new Error(`cross-building only stages Bun, not ${kind}`);
    const source = fetchCrossRuntime(root, target);
    copyFileSync(source, sidecar);
    console.log(`[stage-runtime] ${target.tag}: bun ${BUN_VERSION} → ${sidecar}`);
    console.log(`[stage-runtime] ${mib(statSync(sidecar).size)} MiB`);
    // No probe: the binary does not run on this machine. The version is pinned instead, and
    // `BUN_VERSION` documents which capability that pin is protecting.
    console.log('[stage-runtime] cross target: self-check skipped, version pinned instead');
    return;
  }

  const source = process.argv[2] ?? which(kind);
  console.log(`[stage-runtime] ${kind}: ${source} → ${sidecar}`);
  stageHostRuntime(kind, source, sidecar);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]).endsWith('stage-runtime.ts')) main();
