import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { BUCKET } from './publish.ts';
import { DIST_BASE_URL, PLATFORM, manifestKey, url } from './dist-paths.ts';

/*
 * Drift guards. Every fact below is stated in two files that no single change touches together —
 * the client's endpoint and the publisher's key, the bucket name and the Worker binding. Each pair
 * fails the same way when it drifts: the release succeeds, everything reports green, and installed
 * copies quietly stop finding updates. These tests are the only thing that notices.
 */

const root = resolve(import.meta.dirname, '..');
const read = (...parts: string[]) => readFileSync(join(root, ...parts), 'utf8');
const tauriConf = JSON.parse(read('src-tauri', 'tauri.conf.json'));
const wranglerConf = read('wrangler.jsonc');

test('the client fetches exactly the manifest key the publisher writes', () => {
  const endpoint: string = tauriConf.plugins.updater.endpoints[0];
  // Tauri expands `{{target}}-{{arch}}` into the same identity the manifest is filed under.
  assert.equal(endpoint.replace('{{target}}-{{arch}}', PLATFORM), url(manifestKey(PLATFORM)));
});

test('the updater is pinned to a public key, or any host could serve an update', () => {
  assert.ok((tauriConf.plugins.updater.pubkey as string).length > 40);
});

test('createUpdaterArtifacts stays off — Tauri would tar the bundle before it is signed', () => {
  // The bundler builds the update tarball during `tauri build`, and this project deliberately
  // builds unsigned there and signs afterwards (see scripts/dist.sh). Turning this on ships an
  // unsigned, unnotarized .app to everyone who auto-updates, and Gatekeeper kills it on launch —
  // a failure that is invisible until it is on other people's machines.
  assert.notEqual(tauriConf.bundle.createUpdaterArtifacts, true);
});

test('the publisher writes to the bucket the Worker actually reads', () => {
  assert.ok(wranglerConf.includes(`"bucket_name": "${BUCKET}"`), wranglerConf);
});

test('the Worker answers on the host the manifest URLs point at', () => {
  assert.ok(wranglerConf.includes(`"pattern": "${new URL(DIST_BASE_URL).host}"`), wranglerConf);
});

test('the app version and the release are the same number', () => {
  // tauri.conf.json defers to package.json rather than carrying a second copy of the version.
  assert.equal(tauriConf.version, '../package.json');
});
