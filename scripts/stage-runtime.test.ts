import { test } from 'node:test';
import assert from 'node:assert/strict';
import { capabilityProbe, hostTriple, sidecarFileName } from './stage-runtime.ts';

test('the sidecar name must carry the target triple — Tauri identifies the platform by it', () => {
  assert.equal(
    sidecarFileName('dsh-runtime', 'aarch64-apple-darwin'),
    'dsh-runtime-aarch64-apple-darwin',
  );
});

test('hostTriple maps to Rust naming, not Node naming', () => {
  assert.equal(hostTriple('darwin', 'arm64'), 'aarch64-apple-darwin');
  assert.equal(hostTriple('darwin', 'x64'), 'x86_64-apple-darwin');
});

test('hostTriple throws on non-macOS instead of assembling a name that cannot run', () => {
  assert.throws(() => hostTriple('linux', 'x64'), /macOS/);
  assert.throws(() => hostTriple('darwin', 'ia32'), /architecture/);
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
