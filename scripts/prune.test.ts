import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultPrune, executableExtras, nativeExtras, shouldKeep } from './prune.ts';
import { TARGETS } from './target.ts';

// Pin the target: these paths assert one specific platform, and the host must not decide the answer.
const RULES = defaultPrune(TARGETS['darwin-arm64']);
const WINDOWS = defaultPrune(TARGETS['win32-x64']);
const keep = (p: string) => shouldKeep(p, RULES);

test('keeps what the runtime actually reads', () => {
  for (const p of [
    '@deepseek-ai/dsh/lib/bin.js',
    '@deepseek-ai/dsh/package.json',
    '@deepseek-ai/dsh/config/agent-presets/standard/agent.cordis.yml',
    '@deepseek-ai/dsh-web-frontend/dist/assets/index-Dqw48FrP.js',
    'node-pty/lib/index.js',
    'node-pty/prebuilds/darwin-arm64/pty.node',
    'node-pty/prebuilds/darwin-arm64/spawn-helper',
  ]) {
    assert.ok(keep(p), `should not be pruned: ${p}`);
  }
});

test('prunes sourcemaps — 55 MiB of dead weight', () => {
  assert.ok(!keep('@deepseek-ai/dsh-llm/lib/index.js.map'));
});

test('prunes .d.ts but does not prune types/ by directory name', () => {
  assert.ok(!keep('@deepseek-ai/dsh-llm/lib/types/index.d.ts'));
  assert.ok(!keep('zod/index.d.ts'));
  assert.ok(!keep('zod/index.d.mts'));
  // Learned the hard way: this .js is a module actually imported at runtime, and pruning by directory name breaks startup outright.
  assert.ok(keep('@deepseek-ai/dsh-llm/lib/types/message.js'));
});

test('keeps src/ — koffi requires its own src implementation directory per platform', () => {
  assert.ok(keep('koffi/src/koffi/index.js'));
});

test('nativeExtras adds the native artifacts nft cannot trace, varying by target', () => {
  assert.deepEqual(nativeExtras(RULES), [
    'node-pty/prebuilds/darwin-arm64',
    'node-addon-require-builtin',
    'node-addon-require-builtin-darwin-arm64',
    'node-addon-native-custom-loader',
    '@koromix/koffi-darwin-arm64',
  ]);
});

test('the Windows artifact carries no node-pty at all — Bun.Terminal is the pty', () => {
  const extras = nativeExtras(WINDOWS);
  assert.ok(!extras.some((entry) => entry.startsWith('node-pty/')));
  assert.ok(extras.includes('node-addon-require-builtin-win32-x64-msvc'));
  assert.ok(extras.includes('@koromix/koffi-win32-x64'));
  // No prebuild to keep means every prebuild directory is foreign.
  assert.ok(!shouldKeep('node-pty/prebuilds/win32-x64/conpty.node', WINDOWS));
  assert.ok(!shouldKeep('node-pty/prebuilds/darwin-arm64/pty.node', WINDOWS));
});

test('prunes PE debug databases — 28.3 of node-pty win32-x64 prebuild 29.7 MiB', () => {
  // Checked ahead of the "always keep .node" rule, or the pdb next to each .node would sail through.
  assert.ok(!shouldKeep('some-pkg/build/Release/addon.pdb', RULES));
  assert.ok(!shouldKeep('some-pkg/build/Release/addon.pdb', WINDOWS));
});

test('prunes the documentation at a package root', () => {
  assert.ok(!keep('@deepseek-ai/dsh/README.md'));
  assert.ok(!keep('@deepseek-ai/dsh/README.zh.md'));
  assert.ok(!keep('some-pkg/CHANGELOG.md'));
});

test('keeps markdown used as a runtime asset — pruning .md unconditionally would delete the agent skills', () => {
  assert.ok(keep('@deepseek-ai/dsh/config/agent-presets/cordis/skills/x/SKILL.md'));
  assert.ok(keep('@deepseek-ai/dsh-skill-badge/assets/dsh-badge.md'));
  // A README in a subdirectory is kept too: only the one at the package root is certainly for people
  assert.ok(keep('@deepseek-ai/dsh/config/README.md'));
});

test("keeps LICENSE — redistributing other people's code means carrying their license", () => {
  assert.ok(keep('@deepseek-ai/dsh/LICENSE'));
  assert.ok(keep('turndown/LICENSE.md'));
});

test('keeps only the target platform node-pty prebuild', () => {
  assert.ok(!keep('node-pty/prebuilds/win32-x64/pty.node'));
  assert.ok(!keep('node-pty/prebuilds/win32-arm64/pty.node'));
  assert.ok(!keep('node-pty/prebuilds/darwin-x64/pty.node'));
});

test('prunes node-pty sources and build material — the prebuild is already there', () => {
  assert.ok(!keep('node-pty/src/unix/pty.cc'));
  assert.ok(!keep('node-pty/deps/winpty/x.h'));
  assert.ok(!keep('node-pty/binding.gyp'));
});

test('prunes the KaTeX fonts — 59 files, 1.2 MiB, and the desktop build renders no math', () => {
  assert.ok(!keep('@deepseek-ai/dsh-web-frontend/dist/assets/fonts/KaTeX_Main-Regular.woff2'));
  assert.ok(!keep('@deepseek-ai/dsh-web-frontend/dist/assets/fonts/KaTeX_Size4-Regular.ttf'));
});

test('turning the math switch off keeps the fonts — every cut is independently revertible', () => {
  const rules = { ...RULES, dropMathFonts: false };
  assert.ok(
    shouldKeep('@deepseek-ai/dsh-web-frontend/dist/assets/fonts/KaTeX_Main-Regular.woff2', rules),
  );
});

test('does not prune by directory name — yaml/dist/doc and koffi/src are real modules', () => {
  assert.ok(keep('yaml/dist/doc/directives.js'));
  assert.ok(keep('some-pkg/test/helper.js'));
});

test('.node native modules are always kept, even under directories like src', () => {
  assert.ok(keep('better-sqlite3/build/Release/x.node'));
});

test('executableExtras names spawn-helper — without the +x bit the pty fails with a completely unrelated error', () => {
  assert.deepEqual(executableExtras(RULES), ['node-pty/prebuilds/darwin-arm64/spawn-helper']);
  // Windows has neither the helper nor an executable bit.
  assert.deepEqual(executableExtras(WINDOWS), []);
});
