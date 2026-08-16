#!/usr/bin/env bash
# Release build: build -> sign every binary -> notarize -> staple -> DMG.
#
# Why not let Tauri sign: it only signs the executables under `Contents/MacOS/` and never touches
# the `.node` native modules or `spawn-helper` under `Contents/Resources/`. In practice notarization
# is rejected outright (sharp / koffi .node files report "not signed with a valid Developer ID
# certificate") while the outer .app signature still reports as "valid" — this is the tauri#11992
# trap. So the build produces an unsigned bundle and signing is done here.
#
# Signing order must go inside out: nested binaries first, then the .app. The other way round, the
# outer signature is invalidated by the inner changes.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# tauri.conf.json owns the product name; it decides the bundle filename, so deriving it here keeps
# a rename from breaking the release script 20 minutes into a run.
PRODUCT="$(node -p "require('./src-tauri/tauri.conf.json').productName")"
BUNDLE_DIR="src-tauri/target/release/bundle"
APP="$BUNDLE_DIR/macos/$PRODUCT.app"
ENTITLEMENTS="src-tauri/entitlements.plist"
DIST="dist"
SKIP_NOTARIZE="${SKIP_NOTARIZE:-false}"

step() { printf '\n==> %s\n' "$1"; }
fail() { echo "Error: $1" >&2; exit 1; }

# --- Preflight checks: better to stop now than to ship a bundle that will not install ---

step "Verifying signing identity"
: "${APPLE_TEAM_ID:?APPLE_TEAM_ID is required (the Team ID owning the Developer ID certificate)}"
# Filter by team, not by name: with several subjects in the keychain, codesign fails as ambiguous.
IDENTITY="$(security find-identity -v -p codesigning 2>/dev/null \
  | grep "Developer ID Application" | grep -F "($APPLE_TEAM_ID)" | head -1 \
  | awk '{print $2}')"
[[ -n "$IDENTITY" ]] || fail "no Developer ID Application certificate for team $APPLE_TEAM_ID in the keychain"
echo "Signing identity: $IDENTITY (team $APPLE_TEAM_ID)"

NOTARY_ARGS=()
if [[ "$SKIP_NOTARIZE" == false ]]; then
  step "Verifying notarization credentials"
  # Reuse the machine's existing NOTARIZE_* convention so the same credentials are not configured twice.
  KEY_ID="${APPLE_API_KEY:-${NOTARIZE_KEY_ID:-}}"
  ISSUER="${APPLE_API_ISSUER:-${NOTARIZE_ISSUER:-}}"
  KEY_PATH="${APPLE_API_KEY_PATH:-${NOTARIZE_KEY_PATH:-}}"
  [[ -n "$KEY_ID"   ]] || fail "NOTARIZE_KEY_ID is required (App Store Connect Key ID)"
  [[ -n "$ISSUER"   ]] || fail "NOTARIZE_ISSUER is required (Issuer ID)"
  [[ -f "$KEY_PATH" ]] || fail ".p8 not found: ${KEY_PATH:-<NOTARIZE_KEY_PATH unset>}"
  NOTARY_ARGS=(--key "$KEY_PATH" --key-id "$KEY_ID" --issuer "$ISSUER")
  echo "Notarization key: $KEY_ID"
fi

# --- Build (no signing identity, so Tauri produces an unsigned bundle) ---

step "Building"
env -u APPLE_SIGNING_IDENTITY -u APPLE_CERTIFICATE npx tauri build --bundles app
[[ -d "$APP" ]] || fail "artifact not found: $APP"

# --- Signing ---
#
# Entitlements apply **per executable**, not per bundle. dsh-runtime is a separately spawned
# process, so it must carry allow-jit itself or V8 never starts and the log shows only Killed: 9.

# What codesign says on failure **is** the diagnosis (expired certificate / ambiguous identity /
# unsupported binary type). Swallow it and the maintainer is left holding just a filename.
sign() {
  local file="$1"; shift
  local output
  output="$(codesign --force --sign "$IDENTITY" --options runtime --timestamp "$@" "$file" 2>&1)" \
    || fail "signing failed: ${file#"$APP"/}
$output"
}

step "Signing nested binaries"
# Resources holds 2500 files, of which only 6 are Mach-O. Forking file(1) once per file takes 15
# seconds; narrowing candidates to single digits with find predicates first and letting file(1)
# decide keeps the criterion identical while dropping the cost to 0.2 seconds. `-perm -u+x` is
# there to catch the extensionless spawn-helper.
count=0
while IFS= read -r -d '' file; do
  # Likewise avoid `file | grep -q`: grep -q exits early, file takes a SIGPIPE, and under pipefail
  # "it is Mach-O" would be read as a failure.
  [[ "$(file -b "$file" 2>/dev/null)" == *"Mach-O"* ]] || continue
  sign "$file"
  count=$((count + 1))
done < <(find "$APP/Contents/Resources" -type f \
  \( -name '*.node' -o -name '*.dylib' -o -name '*.so' -o -perm -u+x \) -print0)
echo "Signed $count nested binaries"
# Zero matches means the resource layout changed. Carrying on costs 20 minutes and ends in a vague
# notarization rejection from Apple.
[[ "$count" -gt 0 ]] || fail "no Mach-O found under Resources — did the resource layout change?"

step "Signing the sidecar runtime (with entitlements)"
sign "$APP/Contents/MacOS/dsh-runtime" --entitlements "$ENTITLEMENTS"

step "Signing the main executable and the .app"
sign "$APP/Contents/MacOS/dsh-desktop" --entitlements "$ENTITLEMENTS"
sign "$APP" --entitlements "$ENTITLEMENTS"

step "Verifying signatures"
codesign --verify --deep --strict --verbose=2 "$APP" 2>&1 | tail -2

# Capture the output into a variable before testing it, rather than `codesign ... | grep -q`:
# grep -q exits on the first match, codesign takes a SIGPIPE and returns 141, and pipefail turns a
# passing check into a failing one.
RUNTIME_ENTS="$(codesign -d --entitlements - --xml "$APP/Contents/MacOS/dsh-runtime" 2>/dev/null || true)"
[[ "$RUNTIME_ENTS" == *"allow-jit"* ]] \
  || fail "dsh-runtime lacks allow-jit — the kernel will kill Node's V8 outright"

APP_INFO="$(codesign -d -vv "$APP" 2>&1 || true)"
[[ "$APP_INFO" == *"(runtime)"* ]] || fail "Hardened Runtime is off; notarization will be rejected"
[[ "$APP_INFO" == *"TeamIdentifier=$APPLE_TEAM_ID"* ]] || fail "signed with the wrong team"

# --- Notarization ---
#
# The two timeouts cover different things: --timeout only bounds the polling *after* a successful
# submission and does not cover connection setup or upload. When the machine sleeps and drops the
# connection, notarytool waits forever, so a hard watchdog wraps it.

# One budget, two units: the hard watchdog must outlast the poll timeout, so derive it rather than
# leaving the ordering to whoever edits one of the two numbers.
NOTARY_WAIT_MINUTES=30
NOTARY_WAIT_TIMEOUT="${NOTARY_WAIT_MINUTES}m"
NOTARY_HARD_TIMEOUT=$(((NOTARY_WAIT_MINUTES + 10) * 60))

run_with_watchdog() {
  local seconds="$1"; shift
  local pid watchdog rc=0
  "$@" & pid=$!
  ( sleep "$seconds"; kill -TERM "$pid" 2>/dev/null ) & watchdog=$!
  wait "$pid" || rc=$?
  if kill -0 "$watchdog" 2>/dev/null; then
    kill -TERM "$watchdog" 2>/dev/null || true
    wait "$watchdog" 2>/dev/null || true
  else
    rc=124
  fi
  return "$rc"
}

# What gets submitted and what gets stapled are not the same thing: the .app can only be submitted
# zipped, but stapler cannot write into a zip ("Stapler is incapable of working with ZIP archive
# files"), so the ticket must be stapled onto the .app itself. For a DMG they are the same file.
notarize() {
  local artifact="$1" rc=0
  step "Notarizing $(basename "$artifact")"
  run_with_watchdog "$NOTARY_HARD_TIMEOUT" \
    xcrun notarytool submit "$artifact" "${NOTARY_ARGS[@]}" --wait --timeout "$NOTARY_WAIT_TIMEOUT" || rc=$?
  [[ "$rc" -eq 0 ]] || fail "notarization failed or timed out (rc=$rc). Check whether Apple actually received it: xcrun notarytool history"
}

staple() {
  step "staple $(basename "$1")"
  xcrun stapler staple "$1"
}

mkdir -p "$DIST"
if [[ "$SKIP_NOTARIZE" == false ]]; then
  ZIP="$DIST/${PRODUCT// /-}.zip"
  rm -f "$ZIP"
  # ditto rather than zip: only it preserves symlinks and permission bits.
  ditto -c -k --keepParent "$APP" "$ZIP"
  notarize "$ZIP"
  staple "$APP"
  rm -f "$ZIP"
fi

# --- DMG ---
#
# Built here instead of by Tauri: its DMG is produced before signing and therefore contains the
# unsigned .app.

step "Building the DMG"
DMG="$DIST/${PRODUCT// /-}-$(node -p "require('./package.json').version")-$(uname -m).dmg"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
ditto "$APP" "$STAGE/$(basename "$APP")"
ln -s /Applications "$STAGE/Applications"
rm -f "$DMG"
# ULMO (LZMA) is 18 MB smaller than the default UDZO (51 vs 69). It needs macOS 10.15+, and our
# minimumSystemVersion is 11.0, so it is affordable.
hdiutil create -volname "$PRODUCT" -srcfolder "$STAGE" -ov -format ULMO "$DMG" >/dev/null
codesign --force --sign "$IDENTITY" --timestamp "$DMG"
if [[ "$SKIP_NOTARIZE" == false ]]; then
  notarize "$DMG"
  staple "$DMG"
fi

step "Verifying Gatekeeper acceptance"
spctl -a -vvv -t install "$APP" 2>&1 | tail -3

step "Artifacts"
du -sh "$APP" "$DMG"
