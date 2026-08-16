import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildManifest } from './manifest.ts';
import { PLATFORM, tarballName, releaseKey, url } from './dist-paths.ts';

const INPUT = {
  version: '0.2.0',
  notes: 'Fixed the thing.',
  pubDate: '2026-08-16T08:00:00.000Z',
  platform: PLATFORM,
  url: url(releaseKey('0.2.0', tarballName('0.2.0', PLATFORM))),
  signature: 'dW50cnVzdGVkIGNvbW1lbnQ6...',
};

const parse = (input = INPUT) => JSON.parse(buildManifest(input));

test('the manifest states the version the client compares against its own', () => {
  assert.equal(parse().version, '0.2.0');
});

test('the platform key is the one the client looks itself up under', () => {
  const platforms = parse().platforms;
  assert.deepEqual(Object.keys(platforms), [PLATFORM]);
  assert.equal(platforms[PLATFORM].url, INPUT.url);
  assert.equal(platforms[PLATFORM].signature, INPUT.signature);
});

test('one platform per file — a broken entry cannot take the other platforms down with it', () => {
  // The client validates the whole file before it even looks at the version, so a single malformed
  // entry in a shared manifest would stop every platform from updating. Splitting the file keeps
  // the blast radius to the platform that was actually mis-published.
  assert.equal(Object.keys(parse().platforms).length, 1);
});

test('a leading v is refused — "v0.2.0" compares as newer than every real version forever', () => {
  assert.throws(() => buildManifest({ ...INPUT, version: 'v0.2.0' }), /version/i);
});

test('an empty signature is refused rather than published as an update nobody can install', () => {
  assert.throws(() => buildManifest({ ...INPUT, signature: '  ' }), /signature/i);
});

test('a non-https url is refused because the updater rejects it at the client anyway', () => {
  assert.throws(() => buildManifest({ ...INPUT, url: 'http://x/y.tar.gz' }), /https/i);
});

test('notes may be empty — a release without a changelog is still a release', () => {
  assert.equal(parse({ ...INPUT, notes: '' }).notes, '');
});

test('the output is formatted, because this file gets read by people diagnosing a bad release', () => {
  assert.ok(buildManifest(INPUT).includes('\n'));
});
