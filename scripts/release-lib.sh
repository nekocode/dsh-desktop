#!/usr/bin/env bash
# Shared plumbing for the two release scripts (`dist.sh`, `build-windows.sh`).
#
# Only the parts that are identical between them live here — progress output, the credentials file,
# and the artifact-name lookup. Everything platform-shaped stays in the script that owns it, because
# a shared function with an `if macOS` inside is the same duplication wearing a disguise.
#
# Sourced, not executed: these define functions and read `$ROOT`.

step() { printf '\n==> %s\n' "$1"; }
fail() { echo "Error: $1" >&2; exit 1; }

# Release credentials — Apple's, and the updater signing key. Kept out of the repository; `.env.*`
# is gitignored. Sourced rather than exported by hand so that one forgotten variable cannot make a
# release quietly produce an unsigned artifact.
load_release_env() {
  local file="$ROOT/scripts/.env.local"
  [[ -f "$file" ]] || return 0
  set -a
  # shellcheck disable=SC1090
  source "$file"
  set +a
}

# Artifact names come from scripts/dist-paths.ts — the same table publish.ts and the dist Worker
# read. Spelling them out again in shell is how an artifact ends up at a key nothing links to.
#
# The expression is evaluated with `target` already bound to the current build target, so callers
# write `name "artifactName(target, '1.2.3')"` and never restate which platform they are on.
name() {
  node --experimental-strip-types --input-type=module \
    -e "import * as p from './scripts/dist-paths.ts';
        import { currentTarget } from './scripts/target.ts';
        const target = currentTarget();
        console.log(p.$1)"
}

# One fact, one place: the Rust triple is a per-target fact and `scripts/target.ts` owns it.
target_triple() {
  node --experimental-strip-types --input-type=module \
    -e "import { currentTarget } from './scripts/target.ts'; console.log(currentTarget().rustTriple)"
}
