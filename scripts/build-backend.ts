/**
 * Materializes the trimmed backend out of the upstream dsh install directory.
 *
 * Two complementary strategies, each covering a different failure mode:
 *
 * - `@deepseek-ai/*` is copied whole (with files pruned by the prune rules). These packages carry a
 *   lot of non-JS assets nft cannot trace — agent preset yml, the frontend dist, i18n. Copying them
 *   whole makes pitfalls (2)(3)(6)(7) from dsh-minimal-build.md (package names computed at runtime /
 *   subpaths / the browser condition / no JS entry) disappear in one move.
 * - Third-party dependencies go through nft reachability tracing. They are large, change rarely and
 *   have no dynamic package names, so tracing sheds dead weight like sharp, the five LLM SDKs and otel.
 *
 * Side effects are concentrated in this file; all decision logic lives in compose / trim /
 * backend-plan / prune, where it is unit-testable.
 */
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { nodeFileTrace } from '@vercel/nft';

import { parseComposedConfig, type PluginRow } from './compose.ts';
import { packageNameOf, planBackend } from './backend-plan.ts';
import {
  DEFAULT_PRUNE,
  executableExtras,
  nativeExtras,
  shouldKeep,
  type PruneRules,
} from './prune.ts';
import { disablePresetRows } from './preset-patch.ts';
import {
  AGGRESSIVE,
  assertDroppedPackagesMatched,
  AGGRESSIVE_PACKAGES,
  assertCutPlanesComplete,
  assertSearchHasBinary,
  cutRowIds,
  droppedPackagePrefixes,
  entryReplacementsFor,
  type EntryReplacement,
  importRewritesFor,
  replacementPackages,
  presetRowsToDisable,
  renderPatch,
  resolveCuts,
  resolvePackageCuts,
} from './trim.ts';
import { type ImportRewrite, rewriteImport } from './import-rewrite.ts';
import {
  isProfileBootFile,
  patchProfileBootHmr,
  SHIM_PACKAGES,
  STRIP_REWRITE,
} from './bun-shim.ts';
import { PTY_REWRITE } from './pty-shim.ts';

const SCOPE = '@deepseek-ai';
/** The real entry of the whole plugin tree. It has only `bin` and no exports, so it cannot be resolved and must be hard-coded. */
export const DSH_ENTRY = `${SCOPE}/dsh/lib/bin.js`;
/** Upstream keeps the agent-plane composition inside the dsh package; profile-boot hard-codes it as the system root. */
const PRESET_ROOT = `${SCOPE}/dsh/config/agent-presets`;
const PRESET_CONFIG = 'agent.cordis.yml';

export type BuildOptions = {
  /** Directory where `@deepseek-ai/dsh` is installed (contains node_modules). */
  readonly upstreamDir: string;
  /** Output directory; it is wiped and rebuilt. */
  readonly outDir: string;
  readonly prune?: PruneRules;
};

function log(what: string, result: string): void {
  console.log(`[build-backend] ${what}: ${result}`);
}

/** A throwaway DSH_HOME used only to make dsh dump the composition manifest; it never reaches the artifact. */
function dumpHostComposition(upstreamDir: string): PluginRow[] {
  const home = join(upstreamDir, '.dump-home');
  const bin = join(upstreamDir, 'node_modules', DSH_ENTRY);
  const yamlText = execFileSync(process.execPath, [bin, '--profile', 'web', '--dump-config'], {
    env: { ...process.env, DSH_HOME: home },
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  rmSync(home, { recursive: true, force: true });
  return parseComposedConfig(yamlText);
}

/** The composition file of each agent preset. Used both for reading and patching, so the layout is written once. */
function presetConfigFiles(nodeModules: string): string[] {
  const root = join(nodeModules, PRESET_ROOT);
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(root, entry.name, PRESET_CONFIG))
    .filter((file) => existsSync(file));
}

function readPresetCompositions(nodeModules: string): PluginRow[] {
  return presetConfigFiles(nodeModules).flatMap((file) =>
    parseComposedConfig(readFileSync(file, 'utf8')),
  );
}

/**
 * The `@deepseek-ai` packages on disk, split by whether they can serve as a module entry.
 *
 * `importable`: has main/module/exports and can be handed to nft as an entry.
 * `all`: plus the bin-only packages (`@deepseek-ai/dsh` itself is one) and pure asset packages,
 * which cannot be imported but must still be copied into the artifact.
 *
 * Pure binary packages (the landlock sandbox kind) have no package.json entry at all, and using one
 * as an nft entry fails the build outright (pitfall (7)), so the split is decided by package.json,
 * not by directory name.
 */
function installedScopePackages(upstreamDir: string): { all: string[]; importable: string[] } {
  const scopeDir = join(upstreamDir, 'node_modules', SCOPE);
  const all: string[] = [];
  const importable: string[] = [];
  for (const entry of readdirSync(scopeDir, { withFileTypes: true })) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const manifestPath = join(scopeDir, entry.name, 'package.json');
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    const name = `${SCOPE}/${entry.name}`;
    all.push(name);
    if (manifest['main'] ?? manifest['module'] ?? manifest['exports']) importable.push(name);
  }
  return { all, importable };
}

/**
 * Packages allowed to fail resolution: they carry assets only, with no JS entry.
 *
 * An allowlist rather than "log a line on failure": a warning that is always lit is no warning at
 * all, and nobody would notice an entry that genuinely matters landing in the same line. A failed
 * resolution means that entry's third-party closure is never traced and never copied — which shows
 * up as a load crash on the user's machine.
 */
const ASSET_ONLY_PACKAGES = new Set([`${SCOPE}/dsh-web-frontend`]);

/** Resolves entry specifiers to real files. Anything outside the allowlist that fails to resolve throws. */
function resolveEntries(upstreamDir: string, specifiers: readonly string[]): string[] {
  const req = createRequire(join(upstreamDir, 'noop.js'));
  const files: string[] = [];
  const unexpected: string[] = [];
  for (const specifier of specifiers) {
    try {
      files.push(req.resolve(specifier));
    } catch {
      if (!ASSET_ONLY_PACKAGES.has(packageNameOf(specifier))) unexpected.push(specifier);
    }
  }
  if (unexpected.length > 0) {
    throw new Error(
      `these entries could not be resolved: ${unexpected.join(', ')}. ` +
        'Either upstream changed its exports, or they are pure asset packages — add the latter to ASSET_ONLY_PACKAGES.',
    );
  }
  return files;
}

/**
 * A derived check: if a package is copied into the artifact, the `.node` files it ships must come
 * along.
 *
 * `nativeExtras` is a hand-written list and only guards against upstream *removing* things (a
 * missing one throws). When upstream *adds* a native package nft cannot trace, the hand-written
 * list notices nothing and the failure only appears as a crash on the user's machine. This check
 * derives from what is actually on disk, so it needs no maintenance.
 */
function assertNativeModulesKept(
  nodeModules: string,
  keep: ReadonlySet<string>,
  cutPackages: ReadonlySet<string>,
  rules: PruneRules,
  isDropped: (pkg: string) => boolean,
): void {
  const copiedPackages = new Set([...keep].map(packageNameOf));
  const missing: string[] = [];
  for (const pkg of copiedPackages) {
    // Scope packages are copied whole, so every `.node` that shouldKeep accepts is already in
    // `keep` — the check cannot fire there. Skipping them drops ~30% of this walk.
    if (pkg.startsWith(`${SCOPE}/`)) continue;
    if (cutPackages.has(pkg) || isDropped(pkg)) continue;
    const dir = join(nodeModules, pkg);
    if (!existsSync(dir)) continue;
    for (const rel of listFiles(dir, nodeModules)) {
      // Prebuilds for other platforms are meant to be dropped; not a miss.
      if (rel.endsWith('.node') && !keep.has(rel) && shouldKeep(rel, rules)) missing.push(rel);
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `the packages owning these native modules made it into the artifact but the modules themselves did not:\n  ${missing.join('\n  ')}\n` +
        'nft cannot trace a require assembled at runtime — add them to nativeExtras in prune.ts.',
    );
  }
}

/** Recursively lists every file under a directory, returning paths relative to `base`. */
function listFiles(root: string, base: string): string[] {
  return readdirSync(root, { withFileTypes: true, recursive: true })
    .filter((entry) => !entry.isDirectory())
    .map((entry) => relative(base, join(entry.parentPath, entry.name)));
}

function copyFiles(nodeModules: string, outNodeModules: string, paths: Iterable<string>): void {
  for (const rel of paths) {
    const from = join(nodeModules, rel);
    // nft's file list may contain broken symlinks, which would make the copy throw.
    if (!existsSync(from)) continue;
    const to = join(outNodeModules, rel);
    mkdirSync(dirname(to), { recursive: true });
    cpSync(from, to, { recursive: true, dereference: true, preserveTimestamps: true });
  }
}

export const BACKEND_OUT_DIR = join('build', 'backend');

export async function buildBackend(options: BuildOptions): Promise<void> {
  const rules = options.prune ?? DEFAULT_PRUNE;
  const nodeModules = join(options.upstreamDir, 'node_modules');
  const outNodeModules = join(options.outDir, 'node_modules');

  const cuts = resolveCuts(AGGRESSIVE);
  const packageCuts = resolvePackageCuts(AGGRESSIVE_PACKAGES);
  log('cut switches', `rows [${cuts.join(', ')}] packages [${packageCuts.join(', ')}]`);

  // Package-level cuts drop packages nft genuinely traces but that never run, so they can only be
  // filtered out by name during the copy stage — tracing cannot stop them.
  const droppedPrefixes = droppedPackagePrefixes(packageCuts);
  const isDropped = (pkg: string) =>
    droppedPrefixes.some((prefix) => pkg === prefix || pkg.startsWith(`${prefix}/`));

  const presetPlane = readPresetCompositions(nodeModules);
  const rows = [...dumpHostComposition(options.upstreamDir), ...presetPlane];
  log('composition rows', `${rows.length} rows across host + presets`);

  // Cutting a row id means cutting it on every plane it appears on; missing one shows up as
  // "UI fine, session creation fails", which a single launch check cannot catch.
  assertCutPlanesComplete(cuts, new Set(presetPlane.map((row) => row.id)));
  assertSearchHasBinary(cuts, packageCuts);

  const scopePackages = installedScopePackages(options.upstreamDir);
  const plan = planBackend({
    rows,
    cutRowIds: cutRowIds(cuts),
    installedPackages: scopePackages.importable,
  });
  log('entry set', `${plan.entrySpecifiers.length} entries, ${plan.cutPackages.size} packages cut`);

  const entryFiles = resolveEntries(options.upstreamDir, plan.entrySpecifiers);

  // The launcher itself has only bin and no exports, so it cannot be resolved; it is the real entry of the whole tree and must be added by hand.
  entryFiles.push(join(nodeModules, DSH_ENTRY));

  // `**/*.map` must be ignored: without it, 55 MiB of sourcemaps get traced in.
  const traced = await nodeFileTrace(entryFiles, {
    base: options.upstreamDir,
    ignore: ['**/*.map'],
  });
  log('nft reachable files', String(traced.fileList.size));

  rmSync(options.outDir, { recursive: true, force: true });
  mkdirSync(outNodeModules, { recursive: true });

  // Three independent sets rather than running counts: the sizes are then order-independent, so
  // reordering these phases can no longer produce silently wrong size accounting — which is the one
  // number this whole project exists to move.
  const thirdParty = new Set<string>();
  for (const file of traced.fileList) {
    const rel = relative('node_modules', file);
    if (rel.startsWith('..') || rel.startsWith(`${SCOPE}/`)) continue;
    const pkg = packageNameOf(rel);
    if (plan.cutPackages.has(pkg) || isDropped(pkg)) continue;
    if (shouldKeep(rel, rules)) thirdParty.add(rel);
  }

  // @deepseek-ai: copied whole.
  const scope = new Set<string>();
  for (const name of scopePackages.all) {
    if (plan.cutPackages.has(name) || isDropped(name)) continue;
    for (const rel of listFiles(join(nodeModules, name), nodeModules)) {
      if (shouldKeep(rel, rules)) scope.add(rel);
    }
  }

  // Native artifacts nft cannot trace, plus the shims' own dependencies, added directory by directory.
  const native = new Set<string>();
  for (const extra of [...nativeExtras(rules), ...SHIM_PACKAGES]) {
    const dir = join(nodeModules, extra);
    const files = existsSync(dir) ? listFiles(dir, nodeModules) : [];
    if (files.length === 0)
      throw new Error(`missing native artifact: ${extra} (did the upstream layout change?)`);
    for (const rel of files) native.add(rel);
  }

  const keep = new Set([...thirdParty, ...scope, ...native]);
  assertDroppedPackagesMatched(droppedPrefixes, (prefix) => existsSync(join(nodeModules, prefix)));
  log(
    'copy list',
    `third-party ${thirdParty.size} + scope ${scope.size} + native ${native.size} = ${keep.size}`,
  );

  assertNativeModulesKept(nodeModules, keep, plan.cutPackages, rules, isDropped);
  copyFiles(nodeModules, outNodeModules, keep);
  copyOwnPackages(root(), outNodeModules, replacementPackages(packageCuts), rules);
  markExecutable(outNodeModules, executableExtras(rules));

  patchPresets(outNodeModules, presetRowsToDisable(cuts));
  // Bun compatibility is unconditional; the rest is whatever the resolved package cuts require.
  for (const rule of [STRIP_REWRITE, PTY_REWRITE, ...importRewritesFor(packageCuts)]) {
    installRewrite(root(), outNodeModules, rule);
  }
  for (const replacement of entryReplacementsFor(packageCuts)) {
    replaceEntry(root(), outNodeModules, replacement);
  }
  patchProfileBoot(outNodeModules);
  writeProfileSeed(join(options.outDir, 'profile'), renderPatch(cuts));

  log('done', options.outDir);
}

/** Restores the executable bit: npm's --ignore-scripts drops it. */
function markExecutable(outNodeModules: string, paths: readonly string[]): void {
  for (const rel of paths) {
    const file = join(outNodeModules, rel);
    if (!existsSync(file)) throw new Error(`file to mark executable does not exist: ${rel}`);
    chmodSync(file, 0o755);
  }
  log('executable bits', paths.join(', '));
}

/**
 * Agent-plane cuts can only be applied to our own copy of the preset files — a shipped root cannot
 * be overridden from the user layer.
 *
 * Every row to disable must match in at least one preset: zero matches means upstream renamed the
 * row and the cut would silently stop working (the package gets copied as usual and the size
 * quietly creeps back up).
 */
function patchPresets(outNodeModules: string, rowIds: readonly string[]): void {
  if (rowIds.length === 0) return;
  const hit = new Set<string>();
  for (const file of presetConfigFiles(outNodeModules)) {
    const before = readFileSync(file, 'utf8');
    const { text, disabled } = disablePresetRows(before, rowIds);
    if (text === before) continue;
    writeFileSync(file, text);
    disabled.forEach((id) => hit.add(id));
    log('preset cut', `${basename(dirname(file))}: ${disabled.join(', ')}`);
  }
  const missed = rowIds.filter((id) => !hit.has(id));
  if (missed.length > 0) {
    throw new Error(
      `preset cut matched no file: ${missed.join(', ')}. Upstream most likely renamed the rows.`,
    );
  }
}

/**
 * Applies one import rewrite: write the shim next to its target, then repoint the import.
 *
 * The rewrite itself throws when upstream's import shape stops matching, so a shim can never
 * silently become a no-op — see `import-rewrite.ts`.
 */
function installRewrite(repoRoot: string, outNodeModules: string, rule: ImportRewrite): void {
  const target = join(outNodeModules, rule.target);
  const shim = join(dirname(target), rule.shimFilename);
  if ('copyFrom' in rule.body) {
    cpSync(join(repoRoot, rule.body.copyFrom), shim);
  } else {
    writeFileSync(shim, rule.body.generate());
  }
  writeFileSync(target, rewriteImport(readFileSync(target, 'utf8'), rule));
  log('shim', `${rule.target} → ${rule.shimFilename}`);
}

/**
 * Copies packages this repo depends on directly into the artifact.
 *
 * Replacements come from our own node_modules rather than the upstream staging directory: that
 * directory is reinstalled whenever dsh is upgraded, so a dependency added there would vanish
 * silently. Ours is pinned in this repo's package.json, where an upstream bump cannot touch it.
 */
function copyOwnPackages(
  repoRoot: string,
  outNodeModules: string,
  packages: readonly string[],
  rules: PruneRules,
): void {
  const repoModules = join(repoRoot, 'node_modules');
  for (const name of packages) {
    const dir = join(repoModules, name);
    const files = listFiles(dir, repoModules).filter((rel) => shouldKeep(rel, rules));
    if (files.length === 0) throw new Error(`replacement package is missing: ${name}`);

    // Only the package itself is copied, so it has to be self-contained. Today's version is; a
    // later one that grows a dependency would otherwise ship an artifact that fails on first use.
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    const deps = Object.keys(manifest.dependencies ?? {});
    if (deps.length > 0) {
      throw new Error(
        `${name} gained dependencies (${deps.join(', ')}) and is no longer self-contained; ` +
          'copying it alone would ship a package that fails to resolve them at runtime.',
      );
    }

    copyFiles(repoModules, outNodeModules, files);
    log('own package', `${name}: ${files.length} files`);
  }
}

/**
 * Replaces a third-party package's entry file wholesale.
 *
 * Blunter than an import rewrite and, unlike one, it cannot fail loudly on its own — overwriting a
 * file always "works". So the contract the replacement relies on is asserted against the original
 * first, and the build stops rather than shipping a package that resolves nothing.
 */
function replaceEntry(
  repoRoot: string,
  outNodeModules: string,
  replacement: EntryReplacement,
): void {
  const target = join(outNodeModules, replacement.target);
  if (!existsSync(target)) {
    // The package is only in the artifact because something upstream imports it. Its absence means
    // upstream stopped, so the swap is now pointless — and the cut that drops the native package
    // it replaced is pointless too.
    throw new Error(
      `${replacement.target} is not in the artifact, so nothing upstream imports it any more; ` +
        `drop the cut that replaces it rather than swapping a package nobody loads.`,
    );
  }
  if (!readFileSync(target, 'utf8').includes(replacement.expects)) {
    throw new Error(
      `${replacement.target} no longer mentions ${replacement.expects} — the package changed its ` +
        `contract, so ${replacement.source} must follow rather than silently overwrite it: ` +
        replacement.consequence,
    );
  }
  cpSync(join(repoRoot, replacement.source), target);
  log('entry swap', `${replacement.target} → ${replacement.source}`);
}

/**
 * The one Bun patch that is not an import rewrite: `runProfile` builds HMR unconditionally.
 *
 * dsh ships several profile-boot artifacts (content-hashed names) and only the one that actually
 * contains the boot path carries this code. Try each; zero matches means upstream changed the shape.
 */
function patchProfileBoot(outNodeModules: string): void {
  const libDir = join(outNodeModules, dirname(DSH_ENTRY));
  const patched: string[] = [];
  for (const name of readdirSync(libDir).filter(isProfileBootFile)) {
    const file = join(libDir, name);
    const before = readFileSync(file, 'utf8');
    let after: string;
    try {
      after = patchProfileBootHmr(before);
    } catch {
      continue;
    }
    if (after === before) continue;
    writeFileSync(file, after);
    patched.push(name);
  }
  if (patched.length === 0) throw new Error('no profile-boot file received the HMR patch');
  log('HMR patch', patched.join(', '));
}

/** The profile seed: copied into the user's $DSH_HOME on first launch, and theirs from then on. */
function writeProfileSeed(dir: string, patch: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'package.json'),
    `${JSON.stringify(
      {
        name: 'dsh-profile-desktop',
        private: true,
        dependencies: {},
        dsh: { profile: { bundles: [`${SCOPE}/dsh-base`, `${SCOPE}/dsh-web-app`] } },
      },
      null,
      2,
    )}\n`,
  );
  // profile-boot rewrites cordis.yml to an empty array on every launch; this is just a placeholder.
  writeFileSync(join(dir, 'cordis.yml'), '[]\n');
  writeFileSync(join(dir, 'cordis.patch.yml'), patch);
  writeFileSync(
    join(dir, 'pnpm-workspace.yaml'),
    'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n',
  );
}

function root(): string {
  return resolve(import.meta.dirname, '..');
}

const isMain =
  process.argv[1] !== undefined && resolve(process.argv[1]).endsWith('build-backend.ts');
if (isMain) {
  await buildBackend({
    upstreamDir: join(root(), 'build', 'upstream'),
    outDir: join(root(), BACKEND_OUT_DIR),
  });
}
