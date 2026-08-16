#!/usr/bin/env bash
# Cross-builds the Windows x64 installer from macOS, signs it for the updater, and can publish it.
#
# There is no Windows machine in this loop. Everything the artifact contains is either downloaded at
# a pinned version (bun.exe), staged from an npm install resolved *for* win32 (`--os=win32`), or
# compiled by cargo-xwin against Microsoft's own headers and import libraries. What cannot be done
# here is equally clear-cut: the artifact never runs, so `smoke.ts` skips itself.
#
# Two signatures exist and they are unrelated. The **updater** signature (minisign, produced here)
# is what an installed copy checks before applying an update; without it the update is refused.
# **Authenticode** — what stops SmartScreen warning on first download — is not done at all: it needs
# a certificate whose key lives in an HSM, and it is a separate decision. Auto-updates are unharmed
# by its absence, because the updater downloads the installer itself and the file therefore carries
# no mark-of-the-web.
#
# Shape of the result (measured, 2026-08-16): 124 MiB installed, 32 MiB installer.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# shellcheck source=scripts/release-lib.sh
source "$ROOT/scripts/release-lib.sh"
# Same credentials file as the macOS pipeline; only the updater key is read here.
load_release_env

export DSH_TARGET=win32-x64
TRIPLE="$(target_triple)"
UPSTREAM="build/upstream-$DSH_TARGET"
DIST="dist"

DO_RELEASE=false
NOTES_FILE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --release) DO_RELEASE=true; shift ;;
    --notes-file)
      [[ $# -ge 2 ]] || { echo "Error: --notes-file requires a path" >&2; exit 1; }
      NOTES_FILE="$2"; shift 2 ;;
    -h|--help)
      echo "Usage: $(basename "$0") [--release] [--notes-file PATH]"
      exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

step "Checking the cross toolchain"
command -v cargo >/dev/null || fail "cargo is not installed"
XWIN_VERSION="$(cargo xwin --version 2>/dev/null | tail -1)" \
  || fail "cargo-xwin is missing. Install it: cargo install cargo-xwin"
rustup target list --installed | grep -qx "$TRIPLE" \
  || fail "the $TRIPLE target is missing. Add it: rustup target add $TRIPLE"
# tauri-build compiles the Windows resource script, and its failure without this is a bare
# `NotAttempted("llvm-rc")` panic that names no package to install.
LLVM_BIN="$(brew --prefix llvm 2>/dev/null)/bin"
[[ -x "$LLVM_BIN/llvm-rc" ]] || fail "llvm-rc not found. Install it: brew install llvm"
export PATH="$LLVM_BIN:$PATH"
# Tauri shells out to makensis for the installer. It downloads its own NSIS plugin but not NSIS.
command -v makensis >/dev/null || fail "makensis not found. Install it: brew install makensis"
# cargo-xwin downloads Microsoft's CRT and SDK on first use; accepting the licence must be explicit.
export XWIN_ACCEPT_LICENSE="${XWIN_ACCEPT_LICENSE:-1}"
echo "cargo-xwin $XWIN_VERSION, llvm-rc at $LLVM_BIN"

step "Verifying the updater signing key"
# Checked before the build, not after: discovering it at the end costs the whole five minutes, and
# an unsigned installer published as an update is one every installed copy refuses.
[[ -f "${TAURI_SIGNING_PRIVATE_KEY_PATH:-}" ]] \
  || fail "TAURI_SIGNING_PRIVATE_KEY_PATH is not a file: ${TAURI_SIGNING_PRIVATE_KEY_PATH:-<unset>}
It is the same key the macOS release uses; see scripts/.env.local."
echo "Updater key: $TAURI_SIGNING_PRIVATE_KEY_PATH"

if [[ "$DO_RELEASE" == true ]]; then
  step "Verifying release tooling"
  command -v wrangler >/dev/null || fail "wrangler is not installed (needed to publish to R2)"
  command -v gh >/dev/null || fail "gh is not installed (needed for the GitHub Release)"
  [[ -z "$NOTES_FILE" || -f "$NOTES_FILE" ]] || fail "notes file not found: $NOTES_FILE"
fi

step "Checking the win32 upstream staging directory"
# npm resolves optionalDependencies against the platform doing the installing, so the Windows
# artifact needs its own install: the macOS one holds macOS native packages and nothing else.
[[ -d "$UPSTREAM/node_modules" ]] || fail "missing $UPSTREAM.
Create it once with:
  mkdir -p $UPSTREAM && cp build/upstream-darwin-arm64/package.json $UPSTREAM/
  (cd $UPSTREAM && npm i --ignore-scripts --os=win32 --cpu=x64)"
echo "$UPSTREAM present"

step "Building"
# beforeBuildCommand (`npm run prebuild`) inherits DSH_TARGET, so the backend is traced and pruned
# for win32, and the sidecar is the pinned Windows bun.exe rather than this machine's.
npx tauri build --runner "$ROOT/scripts/cargo-xwin.sh" --target "$TRIPLE" --bundles nsis

BUNDLE_DIR="src-tauri/target/$TRIPLE/release/bundle/nsis"
BUILT="$(find "$BUNDLE_DIR" -maxdepth 1 -name '*.exe' | head -1)"
[[ -n "$BUILT" ]] || fail "no installer produced under $BUNDLE_DIR"

step "Naming and signing"
VERSION="$(node -p "require('./package.json').version")"
mkdir -p "$DIST"
# Tauri names it from productName, which contains a space — and the download Worker's route
# whitelist rejects those, so a published URL would 404 while every local check passed.
INSTALLER="$DIST/$(name "artifactName(target, '$VERSION')")"
cp "$BUILT" "$INSTALLER"
rm -f "$INSTALLER.sig"
# The key and its password are read straight from the environment, so neither appears on a command
# line or in a process listing.
npx tauri signer sign "$INSTALLER" >/dev/null
[[ -s "$INSTALLER.sig" ]] || fail "tauri signer produced no signature next to $INSTALLER"
echo "$(basename "$INSTALLER") + .sig"

step "Artifacts"
# Both numbers, because they answer different questions: what the user downloads, and what the
# install costs on their disk.
INSTALLED="src-tauri/target/$TRIPLE/release"
printf 'installer  %s\n' "$(du -h "$INSTALLER" | cut -f1)"
printf 'payload    %s (shell + runtime + backend)\n' \
  "$(du -ch "$INSTALLED/dsh-desktop.exe" "src-tauri/binaries/dsh-runtime-$TRIPLE.exe" build/backend \
     | tail -1 | cut -f1)"
echo "$INSTALLER"

if [[ "$DO_RELEASE" == true ]]; then
  step "Publishing"
  node --experimental-strip-types scripts/publish.ts "$VERSION" ${NOTES_FILE:+"$NOTES_FILE"}
fi
