import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  ARTIFACT_PREFIXES,
  DIST_BASE_URL,
  artifactName,
  classify,
  latestArtifactName,
  latestKey,
  manifestKey,
  releaseKey,
  updaterPayloadName,
  url,
} from './dist-paths.ts';
import { TARGETS } from './target.ts';

const MACOS = TARGETS['darwin-arm64'];
const WINDOWS = TARGETS['win32-x64'];

test('a URL path minus its leading slash is the R2 key — the whole routing rests on this', () => {
  const key = releaseKey('0.2.0', artifactName(MACOS, '0.2.0'));
  assert.equal(new URL(url(key)).pathname.slice(1), key);
});

test('the manifest filename and the platform key inside it are the same string', () => {
  // The client asks for `{{target}}-{{arch}}.json` and then looks up `platforms[{{target}}-{{arch}}]`.
  // Two spellings of one identity is a manifest that validates and then matches nothing.
  for (const target of [MACOS, WINDOWS]) {
    const platform = target.updaterPlatform;
    assert.equal(manifestKey(platform), `updates/${platform}.json`);
  }
  assert.equal(MACOS.updaterPlatform, 'darwin-aarch64');
  assert.equal(WINDOWS.updaterPlatform, 'windows-x86_64');
});

test('every published path is served, and nothing else is', () => {
  const version = '0.2.0';
  for (const target of [MACOS, WINDOWS]) {
    for (const key of [
      manifestKey(target.updaterPlatform),
      releaseKey(version, artifactName(target, version)),
      releaseKey(version, updaterPayloadName(target, version)),
      latestKey(latestArtifactName(target)),
    ]) {
      assert.ok(classify(`/${key}`), `published but not servable: ${key}`);
    }
  }
});

test('artifact names carry no space — the route whitelist rejects them, silently, in production', () => {
  // Tauri's own NSIS output is `DeepSeek Harness_0.1.0_x64-setup.exe`. Publishing that name would
  // pass every local check and 404 for every user.
  for (const target of [MACOS, WINDOWS]) {
    for (const name of [
      artifactName(target, '0.2.0'),
      latestArtifactName(target),
      updaterPayloadName(target, '0.2.0'),
    ]) {
      assert.ok(!/\s/.test(name), `name contains whitespace: ${name}`);
    }
  }
});

test('classification drives caching: versioned bytes are immutable, pointers are not', () => {
  assert.equal(classify('/updates/darwin-aarch64.json')?.kind, 'manifest');
  assert.equal(classify('/dl/v0.2.0/DeepSeek-Harness-0.2.0-arm64.dmg')?.kind, 'release');
  assert.equal(classify('/dl/latest/DeepSeek-Harness-arm64.dmg')?.kind, 'latest');
  assert.equal(classify('/dl/v0.2.0/DeepSeek-Harness-0.2.0-x64-setup.exe')?.kind, 'release');
});

test('a platform we have never shipped still resolves — the manifest route is not a fixed list', () => {
  // A Linux release will be produced by a separate pipeline. It must be able to publish without
  // this worker being redeployed first.
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

test('the macOS update payload carries the platform, so a second platform cannot collide', () => {
  assert.equal(
    updaterPayloadName(MACOS, '0.2.0'),
    'DeepSeek-Harness-0.2.0-darwin-aarch64.app.tar.gz',
  );
  assert.notEqual(updaterPayloadName(MACOS, '0.2.0'), artifactName(MACOS, '0.2.0'));
});

test('on Windows the download and the update payload are one file', () => {
  // The updater runs the installer rather than unpacking a bundle, so publishing two objects would
  // upload the same 32 MiB twice.
  assert.equal(updaterPayloadName(WINDOWS, '0.2.0'), artifactName(WINDOWS, '0.2.0'));
  assert.equal(artifactName(WINDOWS, '0.2.0'), 'DeepSeek-Harness-0.2.0-x64-setup.exe');
});

test('the latest alias carries no version — it is the link a download page can hard-code', () => {
  for (const target of [MACOS, WINDOWS]) {
    assert.ok(!latestArtifactName(target).includes('0.2.0'));
    assert.equal(latestArtifactName(target), artifactName(target, '0.2.0').replace('-0.2.0', ''));
  }
});

test('the base URL is https — the updater refuses plain http in release builds', () => {
  assert.ok(DIST_BASE_URL.startsWith('https://'));
});

test('every artifact prefix is one the Worker is guaranteed to see first', () => {
  // Static assets are served ahead of the Worker unless a path is listed here. A prefix that
  // is not would be answered by the asset layer — which for a navigation request means the
  // 404 page instead of the download, in browsers only, silently.
  const wrangler = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
  for (const prefix of ARTIFACT_PREFIXES) {
    assert.ok(
      wrangler.includes(`"/${prefix}/*"`),
      `wrangler.jsonc does not run_worker_first /${prefix}/*`,
    );
  }
});

test('every route the Worker serves sits under a declared prefix', () => {
  for (const target of [MACOS, WINDOWS]) {
    for (const key of [
      manifestKey(target.updaterPlatform),
      releaseKey('0.2.0', artifactName(target, '0.2.0')),
      latestKey(latestArtifactName(target)),
    ]) {
      const [prefix] = key.split('/');
      assert.ok(
        (ARTIFACT_PREFIXES as readonly string[]).includes(prefix as string),
        `${key} is published under an undeclared prefix`,
      );
    }
  }
});
