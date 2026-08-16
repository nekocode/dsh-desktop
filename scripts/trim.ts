import type { ImportRewrite } from './import-rewrite.ts';

/**
 * A whole-file swap of a third-party package entry, applied by `replaceEntry` in `build-backend.ts`,
 * which is also where the contract check is explained.
 */
export type EntryReplacement = {
  /** Relative to node_modules. */
  readonly target: string;
  /** Relative to the repository root. */
  readonly source: string;
  /** Packages the replacement imports that nothing can trace to; copied whole from our own tree. */
  readonly needs: readonly string[];
  /** Must still appear in the file being replaced. */
  readonly expects: string;
  /** What breaks if it stops appearing. */
  readonly consequence: string;
};
import { SHARP_REWRITE } from './sharp-shim.ts';
import { NATIVE_RIPGREP_PACKAGE, RIPGREP_REPLACEMENT } from './ripgrep-shim.ts';

/**
 * The trim manifest: which plugin rows the desktop build removes from dsh's official web profile.
 *
 * This goes through dsh's own profile patch mechanism (`disabled: true` in `cordis.patch.yml`)
 * rather than deleting packages — the composition manifest is the single source of truth, and a
 * plugin absent from the composition simply never gets its dependencies pulled into the backend by
 * nft tracing. Deleting packages would leave "what is installed" and "what runs" maintained in two
 * places, which inevitably drifts.
 *
 * Every entry is a build switch: if a cut turns out to go too far, turn that one off to revert it.
 */

export type Cut = {
  /**
   * Row ids to disable on the host plane (the composition tree from `dsh --dump-config`).
   * Applied through the profile's `cordis.patch.yml`.
   */
  readonly hostRows: readonly string[];
  /**
   * Row ids to disable on the agent plane (`dsh/config/agent-presets/&ast;/agent.cordis.yml`).
   * Only our own copy of the preset file can be edited — the shipped root outranks the user layer.
   */
  readonly presetRows: readonly string[];
  /** Why this can be cut and what is lost by cutting it. */
  readonly reason: string;
  /** Measured node_modules space freed (MiB, darwin-arm64). */
  readonly savedMiB: number;
};

export const CUTS = {
  images: {
    hostRows: ['attachment-local'],
    presetRows: [],
    // Permanently off; it stays in the table to record *why* this cut is not allowed.
    // To save sharp's weight use PACKAGE_CUTS.imageDecoding — keep the plugin, swap the engine.
    reason:
      "disabling attachment-local entirely leaves apiproxy's attachments injection unsatisfied, so the API gateway fails to start",
    savedMiB: 0.1,
  },
  telemetry: {
    hostRows: ['session-telemetry-otel'],
    presetRows: [],
    reason: 'OpenTelemetry export defaults to DISABLED yet drags in 34 MiB of @opentelemetry',
    savedMiB: 34,
  },
  foreignProviders: {
    hostRows: ['llm-pi-ai'],
    presetRows: [],
    reason:
      'pi-ai bundles the anthropic/google/mistral/aws/openai SDKs; deepseek-official is registered independently by dsh-llm-deepseek and does not need it',
    savedMiB: 70,
  },
  fileSearch: {
    // Upstream already disables the host row (presets own it); listing it here keeps the switch working if upstream ever moves it back to the host plane.
    hostRows: ['tool-fs-search'],
    presetRows: ['tool-fs-search'],
    reason:
      'the whole search stack; superseded by PACKAGE_CUTS.nativeRipgrep, which keeps the tools and drops 83% of their weight',
    savedMiB: 4.5,
  },
  sessionSearch: {
    hostRows: ['session-query-sqlite'],
    presetRows: [],
    reason: 'session full-text search defaults to openAt: never upstream, so it is off anyway',
    savedMiB: 0.3,
  },
  workflow: {
    hostRows: ['workflow-worker-thread', 'tool-workflow', 'ui-workflow-run'],
    presetRows: ['workflow-worker-thread', 'tool-workflow'],
    reason:
      'multi-agent workflow orchestration. Saves only 0.5 MiB, and tool-ralph hard-depends on workflowEngine, so cutting it drags a chain of other cuts along',
    savedMiB: 0.5,
  },
} as const satisfies Record<string, Cut>;

export type CutName = keyof typeof CUTS;

/** Build switches: true = cut. Everything is cut by default. */
export type CutSwitches = Record<CutName, boolean>;

/**
 * The switch combination the desktop build actually ships.
 *
 * `fileSearch` is off for a different reason than the rest: nothing forces it: code search is the
 * one capability worth its weight, and `PACKAGE_CUTS.nativeRipgrep` already removes 83% of that
 * weight by swapping the native ripgrep binary for the wasm build of the same tool. Cutting the
 * rows too would trade a real agent capability for the 0.2 MiB that remains.
 *
 * The other three are off because of hard dependencies found by actually running the build:
 *
 * - `images` / `sessionSearch`: `dsh-host-apiproxy` writes `attachments` and `sessionQuery` into
 *   its `static inject`, so cutting them keeps the whole API gateway from starting
 *   (`1 entry did not activate`). Save sharp's weight via `PACKAGE_CUTS.imageDecoding` instead.
 * - `workflow`: in the agent preset's delegation group, `tool-ralph` injects `workflowEngine`,
 *   which `workflow-worker-thread` provides. Cutting it means cutting ralph too, which is not
 *   worth 0.5 MiB. This one has the most insidious symptom: **the UI is perfectly fine and only
 *   creating a session fails** (`preset "standard" failed to mount`) — verifying "it starts up"
 *   cannot catch it.
 */
export const AGGRESSIVE: CutSwitches = {
  images: false,
  telemetry: true,
  foreignProviders: true,
  fileSearch: false,
  sessionSearch: false,
  workflow: false,
};

export function resolveCuts(switches: CutSwitches): CutName[] {
  return (Object.keys(CUTS) as CutName[]).filter((name) => switches[name]);
}

const HEADER = `# Generated by scripts/trim.ts — do not edit by hand; change the CUTS table and rebuild.
# Desktop trim layer: disable these rows after dsh-base + dsh-web-app.
`;

export function renderPatch(names: readonly CutName[]): string {
  const blocks = names
    .filter((name) => CUTS[name].hostRows.length > 0)
    .map((name) => {
      const cut = CUTS[name];
      const rows = cut.hostRows.map((id) => `- id: ${id}\n  disabled: true`).join('\n');
      return `# ${name}: ${cut.reason} (saves ${cut.savedMiB} MiB)\n${rows}`;
    });
  if (blocks.length === 0) return `${HEADER}\n[]\n`;
  return `${HEADER}\n${blocks.join('\n\n')}\n`;
}

/** Row ids to disable on the agent plane, deduplicated. */
export function presetRowsToDisable(names: readonly CutName[]): string[] {
  return [...new Set(names.flatMap((name) => CUTS[name].presetRows))];
}

/**
 * Once a row id is cut, it must be cut on **every plane** it appears on.
 *
 * This invariant came out of a real failure: the `workflow` cut only listed `hostRows`, while the
 * agent preset's delegation group carried a row with the same id. The package was dropped and the
 * preset still tried to mount it — the UI looked completely fine and **only creating a session
 * failed** (`preset "standard" failed to mount`). Verifying that "the service comes up" cannot
 * catch this, so it became a build-time assertion.
 *
 * @param presetRowIds - every row id that appears on the agent plane.
 */
export function assertCutPlanesComplete(
  names: readonly CutName[],
  presetRowIds: ReadonlySet<string>,
): void {
  const missing: string[] = [];
  for (const name of names) {
    const cut: Cut = CUTS[name];
    for (const id of cut.hostRows) {
      if (presetRowIds.has(id) && !cut.presetRows.includes(id)) missing.push(`${name}.${id}`);
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `these rows are cut on the host plane only, while the agent preset still carries the same ids: ${missing.join(', ')}. ` +
        'The package gets dropped while the preset still tries to mount it — the symptom is "UI fine, session creation fails". ' +
        'Add these ids to the presetRows of the corresponding CUTS entry.',
    );
  }
}

/**
 * Keeping the search tools obliges someone to supply a ripgrep binary.
 *
 * Found by measurement, not by reading: with `fileSearch` off and `nativeRipgrep` off, the artifact
 * grows by 0.1 MiB rather than the binary's 4.3 MiB, because `@vscode/ripgrep` resolves its
 * platform package by a name it computes at runtime (`@vscode/ripgrep-${platform}-${arch}`) and nft
 * cannot trace that — the same blind spot as the node-pty prebuilds. The build stays green, the UI
 * is fine, and every search fails with "Could not find @vscode/ripgrep-darwin-arm64".
 *
 * So the combination is illegal: either cut the rows, or let the wasm swap provide the binary. A
 * native build would additionally need its platform package listed in `prune.ts`'s `nativeExtras`.
 */
export function assertSearchHasBinary(
  cuts: readonly CutName[],
  packageCuts: readonly PackageCutName[],
): void {
  if (cuts.includes('fileSearch') || packageCuts.includes('nativeRipgrep')) return;
  throw new Error(
    'the grep/glob rows are kept but nothing supplies a ripgrep binary: nft cannot trace ' +
      "@vscode/ripgrep's computed platform package, so the artifact would ship the wrapper alone " +
      'and every search would fail at runtime. Turn PACKAGE_CUTS.nativeRipgrep back on, or cut ' +
      'CUTS.fileSearch, or add the platform package to nativeExtras in prune.ts.',
  );
}

/** Cut row ids (both planes merged), used to drop the corresponding packages from the backend. */
export function cutRowIds(names: readonly CutName[]): Set<string> {
  return new Set(names.flatMap((name) => [...CUTS[name].hostRows, ...CUTS[name].presetRows]));
}

/**
 * Package-level trimming: not "one fewer row in the composition" but "this package can never run
 * on this machine".
 *
 * Kept separate from `CUTS` because the trigger differs — `CUTS` turns off plugin rows, while this
 * turns off code paths that nft genuinely traces but that never execute at runtime.
 */
export type PackageCut = {
  /** Package name prefixes to drop from the artifact (`@img` drops the whole scope). */
  readonly packages: readonly string[];
  /**
   * Import rewrites this cut requires. Dropping a package upstream still imports is only safe when
   * something takes its place, so the replacement belongs to the cut rather than to the build
   * driver — a second cut needing one must not mean a second `if` over cut names.
   */
  readonly replaceImports?: readonly ImportRewrite[];
  /**
   * A package entry file replaced wholesale. Blunter than an import rewrite and reserved for
   * third-party packages whose entire job is to resolve something we resolve differently.
   */
  readonly replaceEntry?: EntryReplacement;
  readonly reason: string;
  readonly savedMiB: number;
};

/*
 * Considered, attempted, and rejected: koffi + @koromix (2.1 MiB).
 *
 * It only serves advapi32/kernel32/user32.dll, is unreachable on macOS, and every call site imports
 * it lazily from inside a Win32-only branch — so a stub looks free. It is not: a stub was built and
 * run, and `dsh-sandbox-windows-acl` asserts its Win32 struct layout at module top level, before
 * any branch runs —
 *
 *     if (STARTUPINFOW.size !== 104) throw new Error("STARTUPINFOW layout mismatch: ...")
 *
 * A stub has no `.size`, so `dsh-sandbox-local` fails to import and the backend never starts.
 * Passing the check means hardcoding 104, which defeats a fail-closed ABI guard and leaves a
 * constant that must drift with upstream's C++ probe. 2.1 MiB is not worth that price.
 */
export const PACKAGE_CUTS = {
  imageDecoding: {
    packages: ['sharp', '@img'],
    replaceImports: [SHARP_REWRITE],
    reason:
      'libvips is 18 MiB. The only model channel in this bundle, dsh-llm-deepseek, explicitly ' +
      'rejects image content, so images never reach the model; the attachments service is still ' +
      'provided by a pure-JS file-header parsing stand-in. Cost: the admission-time "full decode" ' +
      'check degrades to a header check',
    savedMiB: 18,
  },
  nativeRipgrep: {
    packages: [NATIVE_RIPGREP_PACKAGE],
    replaceEntry: RIPGREP_REPLACEMENT,
    /*
     * Measured, interleaved medians on an 8-performance-core M-series, and the single home for
     * these numbers — the shims point here rather than restating them.
     *
     *   repo root, ignore rules on   8.5 ms -> 74 ms   (8.7x)
     *   39 MB tree, --no-ignore       29 ms -> 144 ms  (5.0x)
     *   346 MB tree, --no-ignore     543 ms -> 1593 ms (2.9x)
     *
     * The ratio is worst where the absolute cost is trivial: a typical search is bounded by a
     * ~40 ms fixed wasm start, so 74 ms is imperceptible. On big trees the multiplier comes from
     * two places — wasm executes ~1.8x slower than single-threaded native, and WASI preview1 has no
     * threads at all, so native additionally wins ~1.5x from 8 cores. The gap therefore widens on
     * wider machines rather than narrowing.
     *
     * The one real risk: upstream's SEARCH_TIMEOUT_MS is 30 s, so a repo-wide grep that took over
     * roughly 10 s natively can now time out. Nothing in this bundle approaches that, but a much
     * larger workspace could.
     */
    reason:
      'the per-platform ripgrep binary is 4.3 MiB of Mach-O against 768 KiB for the wasm build of ' +
      'the same ripgrep, which emits byte-identical --json records with the same .gitignore ' +
      'semantics. Cost: 3-9x the wall clock, worst where the absolute is smallest (74 ms)',
    savedMiB: 3.6,
  },
  browserOnlyDeps: {
    packages: [
      'react',
      'react-dom',
      'scheduler',
      'use-sync-external-store',
      '@shikijs',
      'shiki',
      'katex',
    ],
    /*
     * These reach the artifact by accident. `installedScopePackages` feeds every `@deepseek-ai`
     * package with a JS entry to nft, and four of them — dsh-client-web, dsh-client-web-react,
     * dsh-client-ui-primitives, dsh-client-ui-attachment — are browser libraries whose entry
     * imports React, shiki and katex. Checked across all 134 composition rows: not one row's
     * server entry imports any of them. The rows that *depend* on React in package.json reference
     * it only from `lib/client.js`, the bundle served to the browser.
     *
     * The browser does not load them from node_modules either: a served client bundle calls
     * `require("react-dom")`, which the client runtime resolves from its own registry against the
     * React already inside `dsh-web-frontend/dist/assets/vendor-*.js`. There is no import map, and
     * `/node_modules/react-dom` returns the SPA fallback.
     *
     * Why not fix the entry set instead, which is the actual cause: "only trace packages that are
     * composition rows" breaks the build. 61 scope packages are in no row, including
     * `@deepseek-ai/dsh` itself, cordis, cordis-plugin-loader, and the directory-picker-browse /
     * -native pair whose names dsh computes at runtime — the very case the broad entry set exists
     * to cover. A hand list is the narrower risk.
     *
     * `npm run smoke` boots the artifact and creates a session against it, which is what keeps this
     * re-provable. Its limit is worth stating: it never renders a message, so if upstream ever
     * moves markdown, math or syntax rendering server-side, smoke would not notice.
     */
    reason:
      'React, shiki and katex are pulled in by browser-only @deepseek-ai packages that no ' +
      'composition row loads; the browser gets them from the prebuilt frontend bundle instead',
    savedMiB: 5.5,
  },
} as const satisfies Record<string, PackageCut>;

export type PackageCutName = keyof typeof PACKAGE_CUTS;

export const AGGRESSIVE_PACKAGES: Record<PackageCutName, boolean> = {
  imageDecoding: true,
  nativeRipgrep: true,
  browserOnlyDeps: true,
};

export function resolvePackageCuts(switches: Record<PackageCutName, boolean>): PackageCutName[] {
  return (Object.keys(PACKAGE_CUTS) as PackageCutName[]).filter((name) => switches[name]);
}

/** Package name prefixes dropped by package-level cuts, merged and deduplicated. */
export function droppedPackagePrefixes(names: readonly PackageCutName[]): string[] {
  return [...new Set(names.flatMap((name) => PACKAGE_CUTS[name].packages))];
}

/**
 * Every dropped prefix must match something.
 *
 * Same reasoning as `assertEveryCutMatched` for rows: if upstream stops shipping one of these — a
 * switch to preact, or pre-bundling — the prefix quietly matches nothing, `savedMiB` becomes a lie,
 * and the size creeps back with a green build. Size is the reason this project exists.
 *
 * Presence is asked of the installed tree, not of nft's traced set: the packages most worth cutting
 * are exactly the ones nft cannot see, such as ripgrep's runtime-computed platform package.
 */
export function assertDroppedPackagesMatched(
  prefixes: readonly string[],
  isInstalled: (prefix: string) => boolean,
): void {
  const unmatched = prefixes.filter((prefix) => !isInstalled(prefix));
  if (unmatched.length > 0) {
    throw new Error(
      `these package cuts matched nothing in the upstream tree: ${unmatched.join(', ')}. ` +
        'Upstream most likely stopped shipping them — drop the entry rather than leaving a cut ' +
        'that silently saves nothing.',
    );
  }
}

/** `as const satisfies` narrows each entry, so widen before reading the optional fields. */
function cutsOf(names: readonly PackageCutName[]): PackageCut[] {
  return names.map((name) => PACKAGE_CUTS[name]);
}

/** The import rewrites required by the resolved package cuts, in table order. */
export function importRewritesFor(names: readonly PackageCutName[]): ImportRewrite[] {
  return cutsOf(names).flatMap((cut) => cut.replaceImports ?? []);
}

/** The entry replacements required by the resolved package cuts, in table order. */
export function entryReplacementsFor(names: readonly PackageCutName[]): EntryReplacement[] {
  return cutsOf(names).flatMap((cut) => cut.replaceEntry ?? []);
}

/** Packages the resolved cuts' replacements import, deduplicated. */
export function replacementPackages(names: readonly PackageCutName[]): string[] {
  return [...new Set(entryReplacementsFor(names).flatMap((replacement) => replacement.needs))];
}
