import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DIST_BASE_URL,
  PLATFORM,
  classify,
  dmgName,
  latestDmgName,
  latestKey,
  manifestKey,
  releaseKey,
  tarballName,
  url,
} from './dist-paths.ts';

test('a URL path minus its leading slash is the R2 key — the whole routing rests on this', () => {
  const key = releaseKey('0.2.0', dmgName('0.2.0'));
  assert.equal(new URL(url(key)).pathname.slice(1), key);
});

test('the manifest filename and the platform key inside it are the same string', () => {
  // The client asks for `{{target}}-{{arch}}.json` and then looks up `platforms[{{target}}-{{arch}}]`.
  // Two spellings of one identity is a manifest that validates and then matches nothing.
  assert.equal(manifestKey(PLATFORM), `updates/${PLATFORM}.json`);
  assert.equal(PLATFORM, 'darwin-aarch64');
});

test('every published path is served, and nothing else is', () => {
  const version = '0.2.0';
  for (const key of [
    manifestKey(PLATFORM),
    releaseKey(version, dmgName(version)),
    releaseKey(version, tarballName(version, PLATFORM)),
    latestKey(latestDmgName()),
  ]) {
    assert.ok(classify(`/${key}`), `published but not servable: ${key}`);
  }
});

test('classification drives caching: versioned bytes are immutable, pointers are not', () => {
  assert.equal(classify('/updates/darwin-aarch64.json')?.kind, 'manifest');
  assert.equal(classify('/dl/v0.2.0/DeepSeek-Harness-0.2.0-arm64.dmg')?.kind, 'release');
  assert.equal(classify('/dl/latest/DeepSeek-Harness-arm64.dmg')?.kind, 'latest');
});

test('a platform we have never shipped still resolves — the manifest route is not a fixed list', () => {
  // Windows and Linux releases will be produced by a separate pipeline. It must be able to publish
  // without this worker being redeployed first.
  assert.equal(classify('/updates/windows-x86_64.json')?.kind, 'manifest');
  assert.equal(classify('/updates/linux-x86_64.json')?.kind, 'manifest');
});

test('prerelease versions are servable — 0.2.0-rc.1 is a real release path', () => {
  assert.ok(classify('/dl/v0.2.0-rc.1/DeepSeek-Harness-0.2.0-rc.1-arm64.dmg'));
});

test('anything outside the whitelist is refused, so the worker is not a public bucket proxy', () => {
  for (const path of [
    '/',
    '/dl/',
    '/dl/v0.2.0/',
    '/updates/',
    '/updates/nested/darwin-aarch64.json',
    '/dl/v0.2.0/../../secret',
    '/dl/vNEXT/app.dmg',
    '/dl/latest/sub/dir.dmg',
    '/secret.txt',
    '/updates/darwin-aarch64.json.bak',
  ]) {
    assert.equal(classify(path), null, `should not be servable: ${path}`);
  }
});

test('the tarball carries the platform, so a second platform cannot collide with the first', () => {
  assert.equal(
    tarballName('0.2.0', 'darwin-aarch64'),
    'DeepSeek-Harness-0.2.0-darwin-aarch64.app.tar.gz',
  );
  assert.notEqual(tarballName('0.2.0', 'darwin-x86_64'), tarballName('0.2.0', 'darwin-aarch64'));
});

test('the latest alias carries no version — it is the link a download page can hard-code', () => {
  assert.ok(!latestDmgName().includes('0.2.0'));
  assert.equal(latestDmgName(), dmgName('0.2.0').replace('-0.2.0', ''));
});

test('the base URL is https — the updater refuses plain http in release builds', () => {
  assert.ok(DIST_BASE_URL.startsWith('https://'));
});
