import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isProfileBootFile,
  patchProfileBootHmr,
  SHIM_PACKAGES,
  stripShimSource,
} from './bun-shim.ts';

test('the shim prefers the runtime built-in and only falls back to amaro on Bun', () => {
  const src = stripShimSource();
  assert.ok(src.includes('node:module'), 'on Node it must use the built-in directly');
  assert.ok(src.includes('amaro'));
  // The core of the contract: only strip-only preserves length; transform reorders code and the slice lands wrong.
  assert.ok(src.includes("'strip-only'"));
});

test('the shim dependency is on the copy list', () => {
  assert.deepEqual(SHIM_PACKAGES, ['amaro']);
});

const BOOT = `	app.current = ctx;
	if (!signalShutdown.signal.aborted && ctx.fiber.state === 2 && ctx.get("loader") !== void 0) try {
		if (ctx.get("hmr") === void 0) {
			await ctx.loader.create({ name: "@deepseek-ai/cordis-plugin-hmr", config: { root: [] } });
		}
		await watchUserPatches(ctx, {});
	} catch (error) {}
`;

test('patchProfileBootHmr enables HMR only when the composition already has it', () => {
  const out = patchProfileBootHmr(BOOT);
  assert.match(out, /ctx\.get\("loader"\) !== void 0 && ctx\.get\("hmr"\) !== void 0\) try \{/);
});

test('patchProfileBootHmr is idempotent', () => {
  const once = patchProfileBootHmr(BOOT);
  assert.equal(patchProfileBootHmr(once), once);
});

test('patchProfileBootHmr throws when the target condition is missing', () => {
  assert.throws(() => patchProfileBootHmr('app.current = ctx;\n'), /profile-boot/);
});

test('isProfileBootFile matches hashed filenames by pattern', () => {
  assert.ok(isProfileBootFile('profile-boot-DG5t9aNs.js'));
  assert.ok(!isProfileBootFile('bin.js'));
  assert.ok(!isProfileBootFile('profile-boot-DG5t9aNs.js.map'));
});
