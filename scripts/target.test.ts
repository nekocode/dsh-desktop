import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hostTag, resolveTarget, TARGETS, upstreamDirName } from './target.ts';

test('the host tag is what npm and node call this machine', () => {
  assert.equal(hostTag(), `${process.platform}-${process.arch}`);
});

test('an unset DSH_TARGET means "build for this machine"', () => {
  assert.equal(resolveTarget(undefined).tag, hostTag());
  assert.equal(resolveTarget('').tag, hostTag());
});

test('an unknown target is refused rather than silently treated as the host', () => {
  // Silently falling back would produce an artifact for the wrong platform that builds, packages
  // and installs — and only fails once a user runs it.
  assert.throws(() => resolveTarget('linux-x64'), /linux-x64/);
});

test('the Windows target carries the msvc triple and the .exe suffix', () => {
  const target = TARGETS['win32-x64'];
  assert.equal(target.rustTriple, 'x86_64-pc-windows-msvc');
  assert.equal(target.exeSuffix, '.exe');
});

test('the macOS target keeps the triple Tauri already ships under', () => {
  const target = TARGETS['darwin-arm64'];
  assert.equal(target.rustTriple, 'aarch64-apple-darwin');
  assert.equal(target.exeSuffix, '');
});

test('per-platform package names follow each ecosystem, not one rule', () => {
  // node-addon-require-builtin appends the ABI on Windows and nothing on macOS. Deriving one name
  // from `${platform}-${arch}` resolves to a package that does not exist on npm, and the failure
  // surfaces much later as "--expose-internals is required for HMR service".
  assert.equal(
    TARGETS['win32-x64'].requireBuiltinPackage,
    'node-addon-require-builtin-win32-x64-msvc',
  );
  assert.equal(
    TARGETS['darwin-arm64'].requireBuiltinPackage,
    'node-addon-require-builtin-darwin-arm64',
  );
});

test('koffi ships per target — it is loaded by name at runtime, so nft never sees it', () => {
  assert.equal(TARGETS['win32-x64'].koffiPackage, '@koromix/koffi-win32-x64');
  assert.equal(TARGETS['darwin-arm64'].koffiPackage, '@koromix/koffi-darwin-arm64');
});

test('Windows ships no node-pty prebuild — Bun.Terminal drives ConPTY natively', () => {
  assert.equal(TARGETS['win32-x64'].nodePtyPrebuild, null);
  assert.equal(TARGETS['darwin-arm64'].nodePtyPrebuild, 'darwin-arm64');
});

test('each target stages upstream in its own directory', () => {
  // npm resolves optionalDependencies against the *installing* platform, so one directory cannot
  // serve two targets: whichever installed last decides which native packages exist.
  assert.equal(upstreamDirName(TARGETS['win32-x64']), 'upstream-win32-x64');
  assert.equal(upstreamDirName(TARGETS['darwin-arm64']), 'upstream-darwin-arm64');
});

test('the sidecar filename is the triple Tauri looks for', () => {
  assert.equal(TARGETS['win32-x64'].sidecarSuffix, 'x86_64-pc-windows-msvc.exe');
  assert.equal(TARGETS['darwin-arm64'].sidecarSuffix, 'aarch64-apple-darwin');
});
