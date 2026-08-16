import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ptyShimSource } from './pty-shim.ts';

test('the adapter covers all 5 members upstream uses', () => {
  const src = ptyShimSource();
  for (const member of ['get pid()', 'onData(', 'onExit(', 'write(', 'kill(']) {
    assert.ok(src.includes(member), `missing ${member}`);
  }
});

test('the adapter decodes as a stream — a per-chunk toString would split multi-byte characters across chunks', () => {
  assert.match(ptyShimSource(), /decode\(chunk, \{ stream: true \}\)/);
});

test('the adapter converts signals to numbers — upstream looks them up in os.constants.signals', () => {
  const src = ptyShimSource();
  assert.ok(src.includes('constants.signals[code]'));
});

test('on Node the adapter forwards straight to node-pty, keeping both runtimes consistent', () => {
  const src = ptyShimSource();
  assert.ok(src.includes("require('node-pty').spawn"));
  assert.ok(src.includes('Bun.Terminal'));
});
