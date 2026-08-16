/**
 * One mechanism for every build-time rewrite of an upstream import to a shim.
 *
 * Three upstream files are patched this way (TypeScript stripping, node-pty, sharp). All three
 * share the property that makes them dangerous: skipping the rewrite breaks nothing visibly — the
 * build stays green and the failure surfaces on the user's machine as an empty terminal, a plugin
 * tree that never comes up, or a missing decoder. So the rule that matters is "a rewrite that no
 * longer matches must fail the build, never no-op", and it is enforced here once rather than
 * re-typed per shim, where the third copy is the one that forgets.
 *
 * What legitimately differs between shims is data: which file, which import, what the body is.
 */

export type ImportRewrite = {
  /** The upstream file to patch, relative to node_modules. */
  readonly target: string;
  /** Shim filename, written next to the target and imported from it. */
  readonly shimFilename: string;
  /** The upstream import statement to replace. */
  readonly pattern: RegExp;
  /** Its replacement, binding the same names from `./<shimFilename>`. */
  readonly replacement: string;
  /** Where the shim body comes from: generated here, or copied from a real file in the repo. */
  readonly body: { readonly generate: () => string } | { readonly copyFrom: string };
  /** What silently breaks when this rewrite is skipped. Goes into the build error. */
  readonly consequence: string;
};

/**
 * Applies one rewrite to a source file's text.
 *
 * Idempotent: building over an already-patched tree is a no-op rather than a second rewrite.
 */
export function rewriteImport(source: string, rule: ImportRewrite): string {
  if (source.includes(rule.shimFilename)) return source;
  if (!rule.pattern.test(source)) {
    throw new Error(
      `no import matching ${rule.pattern} in ${rule.target} — upstream changed the shape, so the ` +
        `shim must follow rather than be skipped silently: ${rule.consequence}`,
    );
  }
  // A function replacement, so `$&` and friends in the replacement text stay literal.
  return source.replace(rule.pattern, () => rule.replacement);
}
