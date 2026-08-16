/**
 * Derives "which packages the backend needs" from the composition manifests.
 *
 * Pure computation, no filesystem access: the input is the composition rows of both planes plus the
 * cut row ids plus the package names installed on disk; the output is the nft entry set and the set
 * of packages to drop.
 */
import type { PluginRow } from './compose.ts';

export type BackendPlanInput = {
  /** The union of the host-plane rows and the rows of every agent preset plane. */
  readonly rows: readonly PluginRow[];
  /** The row ids that were cut. */
  readonly cutRowIds: ReadonlySet<string>;
  /** Every package under `node_modules/@deepseek-ai/` on disk that has a JS entry. */
  readonly installedPackages: readonly string[];
};

export type BackendPlan = {
  /** Entry module specifiers for nft: order-preserving, deduplicated, subpaths included. */
  readonly entrySpecifiers: readonly string[];
  /** Cut package names; skipped entirely during the copy stage. */
  readonly cutPackages: ReadonlySet<string>;
};

/** `@scope/pkg/sub` -> `@scope/pkg`; `pkg/sub` -> `pkg`. */
export function packageNameOf(specifier: string): string {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? specifier);
}

export function planBackend(input: BackendPlanInput): BackendPlan {
  const cutPackages = new Set<string>();
  for (const row of input.rows) {
    if (input.cutRowIds.has(row.id)) cutPackages.add(packageNameOf(row.name));
  }

  assertEveryCutMatched(input);
  assertNoContestedPackage(input, cutPackages);

  const entrySpecifiers: string[] = [];
  const seen = new Set<string>();
  const add = (specifier: string): void => {
    if (seen.has(specifier) || cutPackages.has(packageNameOf(specifier))) return;
    seen.add(specifier);
    entrySpecifiers.push(specifier);
  };

  // Composition rows come first: only they carry subpath information.
  // Rows upstream marked disabled still enter the entry set — the web profile disables tool-bash/
  // tool-fs and friends because the agent presets mount them at runtime; the packages are alive.
  for (const row of input.rows) add(row.name);

  // Then union in every @deepseek-ai package on disk: dsh computes package names at runtime per
  // platform (directory-picker's -browse / -native), so scanning the manifests can never be complete.
  for (const name of input.installedPackages) add(name);

  return { entrySpecifiers, cutPackages };
}

/**
 * Row ids in the trim table must actually exist in the composition manifests.
 *
 * One upstream rename and the cut silently stops working: the row stays enabled, the package gets
 * copied, the size quietly creeps back up, and the build is all green. Size is this project's
 * reason to exist, so letting it regress silently is unacceptable.
 */
function assertEveryCutMatched(input: BackendPlanInput): void {
  const known = new Set(input.rows.map((row) => row.id));
  const missing = [...input.cutRowIds].filter((id) => !known.has(id));
  if (missing.length > 0) {
    throw new Error(
      `row ids from the trim table were not found in the composition manifests: ${missing.join(', ')}. ` +
        'Upstream most likely renamed them — update CUTS instead of letting the cut fail silently.',
    );
  }
}

/**
 * The same package being cut by one row and required by another means the trim table is wrong, so
 * this must throw rather than quietly pick a side: keeping it defeats the cut, dropping it crashes
 * at runtime.
 */
function assertNoContestedPackage(input: BackendPlanInput, cutPackages: ReadonlySet<string>): void {
  for (const row of input.rows) {
    if (input.cutRowIds.has(row.id)) continue;
    const pkg = packageNameOf(row.name);
    if (!cutPackages.has(pkg)) continue;
    throw new Error(
      `cut conflict: package ${pkg} was cut, but composition row "${row.id}" (${row.name}) still needs it. ` +
        'Either add that row to CUTS as well, or turn off the corresponding cut switch.',
    );
  }
}
