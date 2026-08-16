/**
 * File-level pruning: 97% of an installed node_modules is never read at runtime — sourcemaps,
 * `.d.ts`, prebuilds for four platforms, READMEs, tests.
 *
 * The decision looks only at the relative path (relative to `node_modules/`); pure functions with
 * no filesystem involvement.
 */

export type PruneRules = {
  /** Name of the only node-pty prebuild directory to keep. */
  readonly prebuildDir: string;
  /** Drop the KaTeX math fonts (59 files, 1.2 MiB). */
  readonly dropMathFonts: boolean;
};

/**
 * Derived, not written down: `stage-runtime.ts` picks the sidecar triple from the same two values.
 * A hard-coded arch here would silently keep the wrong prebuild on a host it does not match, and
 * the only symptom would be a confusing "missing native artifact" much later in the build.
 */
export const DEFAULT_PRUNE: PruneRules = {
  prebuildDir: `${process.platform}-${process.arch}`,
  dropMathFonts: true,
};

/**
 * Things nft's static tracing cannot see, which must be added to the copy list by hand. Every entry
 * came out of an actual failure.
 *
 * - `node-pty/prebuilds/<platform>`: required through a relative path assembled at runtime; without
 *   it, startup dies in the subprocess plugin. `spawn-helper` is even more hidden — a forked
 *   executable with no require at all.
 * - `node-addon-require-builtin*`: the cordis loader uses it to reach Node's internal module loader
 *   without `--expose-internals`. It picks a package from optionalDependencies per platform, with
 *   the name computed at runtime. Without it, the HMR that `runProfile` unconditionally creates
 *   throws "--expose-internals is required" and the whole tree fails to start.
 */
export function nativeExtras(rules: PruneRules): string[] {
  return [
    `node-pty/prebuilds/${rules.prebuildDir}`,
    'node-addon-require-builtin',
    `node-addon-require-builtin-${rules.prebuildDir}`,
    'node-addon-native-custom-loader',
  ];
}

/**
 * Files that must carry the executable bit.
 *
 * `npm i --ignore-scripts` installs `spawn-helper` as `rw-r--r--`, so node-pty hits
 * `posix_spawnp failed` the moment it opens a pty. This is not a Bun issue — Node fails the same
 * way, and the error never mentions permissions, only that spawn failed. Fix it at build time
 * rather than relying on the install environment.
 */
export function executableExtras(rules: PruneRules): string[] {
  return [`node-pty/prebuilds/${rules.prebuildDir}/spawn-helper`];
}

/** Redistributing other people's code requires their license; nothing may prune it. */
const LICENSE = /^(LICENSE|LICENCE|COPYING|NOTICE)/i;

// There used to be a "prune whole trees by directory name" table here (types/ src/ doc/ …). It
// blew up three times in a row:
//   @deepseek-ai/dsh-llm/lib/types/message.js  a module actually imported at runtime
//   koffi/src/koffi/                           koffi's per-platform implementation directory
//   yaml/dist/doc/directives.js                a regular module of the yaml parser
// A directory name says nothing about its contents. It saved nothing anyway: third-party files are
// copied only when nft traces them, and the @deepseek-ai packages contain no test directories.

/**
 * Prune only the documentation at a package root.
 *
 * "The extension tells you the contents" is the same mistake as "the directory name tells you the
 * contents". Pruning `*.md` unconditionally removed the agent presets' `skills/&ast;/SKILL.md` and
 * `dsh-skill-badge`'s badge template — those markdown files are runtime assets fed to the model,
 * not documentation for people.
 *
 * Narrowed to "package root + a README/CHANGELOG-style name"; every other markdown file is kept.
 * Of the 385 `.md` files in the tree, only 3 are not README/CHANGELOG, so keeping them costs nothing.
 */
const ROOT_DOC =
  /^(@[^/]+\/)?[^/]+\/(README|CHANGELOG|HISTORY|CONTRIBUTING|SECURITY|CODE_OF_CONDUCT)[^/]*\.md$/i;

/** node-pty ships 1.2 MiB of deps + 2.4 MiB of third_party purely to build from source; with a prebuild present they are unnecessary. */
const NODE_PTY_BUILD_ONLY = /^node-pty\/(deps|third_party|scripts|typings|src)\//;

export function shouldKeep(relativePath: string, rules: PruneRules): boolean {
  const segments = relativePath.split('/');
  const basename = segments.at(-1) ?? '';

  // Foreign prebuilds are checked first: those directories are all `.node` files and bare
  // executables, so letting the "always keep native modules" rule below run first would let 58 MiB
  // of win32 artifacts slip in.
  if (isForeignPrebuild(segments, rules.prebuildDir)) return false;

  if (basename.endsWith('.node')) return true;
  if (LICENSE.test(basename)) return true;

  if (basename.endsWith('.map')) return false;
  if (/\.d\.[cm]?ts$/.test(basename)) return false;
  if (ROOT_DOC.test(relativePath)) return false;
  if (basename === 'binding.gyp') return false;

  if (NODE_PTY_BUILD_ONLY.test(relativePath)) return false;
  if (rules.dropMathFonts && isMathFont(segments, basename)) return false;

  return true;
}

function isForeignPrebuild(segments: readonly string[], keep: string): boolean {
  const index = segments.indexOf('prebuilds');
  if (index === -1) return false;
  const platform = segments[index + 1];
  return platform !== undefined && platform !== keep;
}

function isMathFont(segments: readonly string[], basename: string): boolean {
  return segments.includes('fonts') && basename.startsWith('KaTeX_');
}
