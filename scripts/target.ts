/**
 * The build target — the one place that knows which platform an artifact is being produced for.
 *
 * Everything platform-shaped used to be derived from `process.platform` / `process.arch`, which is
 * only correct while host and target are the same machine. The Windows artifact is cross-built on
 * macOS, and under that assumption every derivation silently produces the *host's* answer: a darwin
 * prebuild inside a Windows installer, a package name npm never published, a sidecar Tauri cannot
 * find. All of those build, package and install cleanly, and only fail on a user's machine.
 *
 * So the target is named explicitly (`DSH_TARGET`), and the per-target facts are a table rather
 * than a formula — because they genuinely do not follow one rule. `node-addon-require-builtin`
 * appends the ABI on Windows and nothing on macOS; koffi uses an npm scope; Tauri's sidecar suffix
 * is a Rust triple plus an executable extension. A formula that fits two of those breaks the third.
 */

export type TargetTag = 'darwin-arm64' | 'win32-x64';

/**
 * What the updater downloads for a target.
 *
 * macOS installs by replacing the `.app`, so the payload is a tarball of it. Windows installs by
 * *running the installer*, so the payload is the same `-setup.exe` people download by hand — one
 * file serving both roles, which the publisher has to know so it does not upload it twice.
 */
export type UpdaterPayload = 'app-tarball' | 'installer';

export type Target = {
  readonly tag: TargetTag;
  /** Rust/Tauri target triple. */
  readonly rustTriple: string;
  /** Executable extension on the target. */
  readonly exeSuffix: string;
  /**
   * Tauri's `{{target}}-{{arch}}` identity. It names the update manifest *and* the key inside it,
   * and the client looks itself up by this exact string — a second spelling validates and matches
   * nothing.
   */
  readonly updaterPlatform: string;
  /** Architecture as a download page spells it. `aarch64` is the toolchain's word, not a user's. */
  readonly archLabel: string;
  /** What the downloadable artifact is called after the version. */
  readonly downloadSuffix: string;
  readonly updaterPayload: UpdaterPayload;
  /**
   * What Tauri appends to an `externalBin` name. It is the triple *plus* the extension, and Tauri
   * looks the file up by that exact string — a missing `.exe` fails the build with only a path.
   */
  readonly sidecarSuffix: string;
  /**
   * `node-addon-require-builtin`'s per-platform package. The cordis loader picks it by a name it
   * assembles at runtime, so nft never sees it and it has to be copied by hand.
   */
  readonly requireBuiltinPackage: string;
  /**
   * koffi's per-platform package. Loaded through `existsSync` on a name built at runtime, so nft
   * cannot see it either. Only `dsh-sandbox-windows-acl` imports koffi, which makes this dead
   * weight on macOS — it is listed there anyway because the current macOS artifact already ships
   * it, and dropping it is a separate decision with its own verification.
   */
  readonly koffiPackage: string;
  /**
   * The node-pty prebuild directory to keep, or `null` when the target ships none.
   *
   * Windows ships none: `pty-shim.ts` probes for `Bun.Terminal`, which drives ConPTY natively as of
   * Bun 1.3.14, so node-pty's native half is never loaded there. That also makes the Windows
   * artifact free of native modules entirely.
   */
  readonly nodePtyPrebuild: string | null;
};

export const TARGETS: Readonly<Record<TargetTag, Target>> = {
  'darwin-arm64': {
    tag: 'darwin-arm64',
    rustTriple: 'aarch64-apple-darwin',
    exeSuffix: '',
    updaterPlatform: 'darwin-aarch64',
    archLabel: 'arm64',
    downloadSuffix: '.dmg',
    updaterPayload: 'app-tarball',
    sidecarSuffix: 'aarch64-apple-darwin',
    requireBuiltinPackage: 'node-addon-require-builtin-darwin-arm64',
    koffiPackage: '@koromix/koffi-darwin-arm64',
    nodePtyPrebuild: 'darwin-arm64',
  },
  'win32-x64': {
    tag: 'win32-x64',
    rustTriple: 'x86_64-pc-windows-msvc',
    exeSuffix: '.exe',
    updaterPlatform: 'windows-x86_64',
    archLabel: 'x64',
    downloadSuffix: '-setup.exe',
    updaterPayload: 'installer',
    sidecarSuffix: 'x86_64-pc-windows-msvc.exe',
    requireBuiltinPackage: 'node-addon-require-builtin-win32-x64-msvc',
    koffiPackage: '@koromix/koffi-win32-x64',
    nodePtyPrebuild: null,
  },
};

/** What npm and node call this machine; also the default target. */
export function hostTag(): string {
  return `${process.platform}-${process.arch}`;
}

/**
 * Resolves `DSH_TARGET`. An unset value means "build for this machine".
 *
 * An unrecognised value throws rather than falling back to the host: a typo would otherwise produce
 * a complete, installable artifact for the wrong platform.
 */
export function resolveTarget(value: string | undefined): Target {
  const tag = value === undefined || value === '' ? hostTag() : value;
  const target = (TARGETS as Record<string, Target | undefined>)[tag];
  if (target === undefined) {
    throw new Error(
      `unsupported build target: ${tag} (known: ${Object.keys(TARGETS).join(', ')}). ` +
        'Set DSH_TARGET to one of those, or leave it unset to build for this machine.',
    );
  }
  return target;
}

/**
 * Where the upstream dsh install for a target is staged, relative to `build/`.
 *
 * One directory per target, because npm resolves `optionalDependencies` against the platform doing
 * the installing: a single directory would hold whichever set was installed last, and the build
 * would happily copy macOS native packages into a Windows installer.
 */
export function upstreamDirName(target: Target): string {
  return `upstream-${target.tag}`;
}

/** The target this process is building for. */
export function currentTarget(): Target {
  return resolveTarget(process.env['DSH_TARGET']);
}
