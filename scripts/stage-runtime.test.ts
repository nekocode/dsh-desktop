import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUN_VERSION, bunRelease, capabilityProbe, sidecarFileName } from './stage-runtime.ts';
import { TARGETS } from './target.ts';

test('the sidecar name must carry the target triple — Tauri identifies the platform by it', () => {
  assert.equal(
    sidecarFileName('dsh-runtime', TARGETS['darwin-arm64']),
    'dsh-runtime-aarch64-apple-darwin',
  );
});

test('the Windows sidecar keeps its .exe — Tauri looks the file up by the exact name', () => {
  assert.equal(
    sidecarFileName('dsh-runtime', TARGETS['win32-x64']),
    'dsh-runtime-x86_64-pc-windows-msvc.exe',
  );
});

test('Bun names platforms its own way — neither node nor Rust spelling works', () => {
  const windows = bunRelease(TARGETS['win32-x64'], '1.3.14');
  assert.equal(
    windows.url,
    'https://github.com/oven-sh/bun/releases/download/bun-v1.3.14/bun-windows-x64.zip',
  );
  assert.equal(windows.member, 'bun-windows-x64/bun.exe');

  const macos = bunRelease(TARGETS['darwin-arm64'], '1.3.14');
  assert.match(macos.url, /bun-darwin-aarch64\.zip$/);
  assert.equal(macos.member, 'bun-darwin-aarch64/bun');
});

test('the pinned version is at least the release that gave Windows a pty', () => {
  // Below 1.3.14 `Bun.Terminal` is POSIX-only, and a Windows build would ship a bash tool that
  // returns empty output instead of failing.
  const order = (version: string) =>
    version
      .split('.')
      .map(Number)
      .reduce((accumulated, part) => accumulated * 10_000 + part, 0);
  assert.ok(order(BUN_VERSION) >= order('1.3.14'), `BUN_VERSION ${BUN_VERSION} is below 1.3.14`);
});

test('the self-check probes capabilities, not versions — versions change, what matters is whether the API exists', () => {
  assert.match(capabilityProbe('bun'), /Bun\.Terminal/);
  assert.match(capabilityProbe('node'), /stripTypeScriptTypes/);
  for (const kind of ['bun', 'node'] as const) {
    assert.match(
      capabilityProbe(kind),
      /process\.exit\(1\)/,
      `the ${kind} self-check must fail with a non-zero code`,
    );
  }
});
