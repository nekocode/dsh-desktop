import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RIPGREP_REPLACEMENT } from './ripgrep-shim.ts';

// The shim is a boundary module: importing it writes the launcher. Point $DSH_HOME at a temp
// directory first, so running the tests cannot leave an executable in the developer's home.
const home = mkdtempSync(join(tmpdir(), 'dsh-shim-test-'));
process.env['DSH_HOME'] = home;
const { launcherScript, rgPath } = await import('../runtime/ripgrep-shim.js');

test('rgPath names a launcher that actually runs ripgrep', () => {
  const version = execFileSync(rgPath, ['--version'], { encoding: 'utf8' });
  assert.match(version, /ripgrep/);
});

test('the launcher lands under $DSH_HOME, never a shared temp directory', () => {
  assert.ok(rgPath.startsWith(home), rgPath);
});

test('the launcher really executes through paths with spaces, forwarding argv', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh desktop test-'));
  // A stand-in for the runtime: proves the quoting survives exec, not just string equality.
  const runtime = join(dir, 'fake runtime');
  writeFileSync(runtime, '#!/bin/sh\necho "$@"\n');
  chmodSync(runtime, 0o755);

  const launcher = join(dir, 'rg');
  writeFileSync(launcher, launcherScript(runtime, join(dir, 'entry point.mjs')));
  chmodSync(launcher, 0o755);

  const out = execFileSync(launcher, ['--json', '--regexp=x'], { encoding: 'utf8' }).trim();
  assert.equal(out, `${join(dir, 'entry point.mjs')} --json --regexp=x`);
});

test('a single quote in a path cannot break out of the exec line', () => {
  assert.ok(launcherScript(`/a'b/rt`, '/x').includes(`'/a'\\''b/rt'`));
});

test('the shim imports exactly the package the build is told to copy', () => {
  const source = readFileSync(new URL('../runtime/ripgrep-shim.js', import.meta.url), 'utf8');
  // Two literals that must agree: what the build copies, and what the shim imports at runtime.
  for (const needed of RIPGREP_REPLACEMENT.needs) {
    assert.match(source, new RegExp(`import\\('${needed}'\\)`));
  }
});

test('the shim refuses to write a launcher outside $DSH_HOME', async () => {
  delete process.env['DSH_HOME'];
  try {
    // A fresh query string defeats the ESM cache, so the module body runs again.
    await assert.rejects(() => import(`../runtime/ripgrep-shim.js?bare=${Date.now()}`), /DSH_HOME/);
  } finally {
    process.env['DSH_HOME'] = home;
  }
});
