import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HOST_TAG } from './prune.ts';
import { RIPGREP_REPLACEMENT } from './ripgrep-shim.ts';
import {
  assertCutPlanesComplete,
  assertSearchHasBinary,
  AGGRESSIVE_PACKAGES,
  entryReplacementsFor,
  replacementPackages,
  droppedPackagePrefixes,
  PACKAGE_CUTS,
  resolvePackageCuts,
  AGGRESSIVE,
  CUTS,
  cutRowIds,
  presetRowsToDisable,
  renderPatch,
  resolveCuts,
  type CutName,
} from './trim.ts';

test('every cut has a reason, target rows and a measured saving', () => {
  for (const [name, cut] of Object.entries(CUTS)) {
    assert.ok(cut.hostRows.length + cut.presetRows.length > 0, `${name} has no target rows`);
    assert.ok(cut.reason.length > 0, `${name} has no reason`);
    assert.ok(cut.savedMiB > 0, `${name} has no measured saving`);
  }
});

test('presetRowsToDisable collects only agent-plane rows, deduplicated', () => {
  assert.deepEqual(presetRowsToDisable(['fileSearch', 'images']), ['tool-fs-search']);
});

test('cutRowIds merges rows from both planes', () => {
  const ids = cutRowIds(['fileSearch', 'telemetry']);
  assert.ok(ids.has('tool-fs-search'));
  assert.ok(ids.has('session-telemetry-otel'));
});

test('resolveCuts returns only the switches that are on', () => {
  const all = Object.fromEntries(Object.keys(CUTS).map((k) => [k, true])) as Record<
    CutName,
    boolean
  >;
  assert.deepEqual(new Set(resolveCuts(all)), new Set(Object.keys(CUTS)));
  assert.deepEqual(resolveCuts({ ...all, fileSearch: false }).includes('fileSearch'), false);
});

test('images / sessionSearch / workflow must stay off — all are hard dependencies found by running the build', () => {
  assert.equal(AGGRESSIVE.images, false);
  assert.equal(AGGRESSIVE.sessionSearch, false);
  assert.equal(AGGRESSIVE.workflow, false);
});

test('fileSearch stays off — the wasm swap keeps the tools at 17% of the weight', () => {
  assert.equal(AGGRESSIVE.fileSearch, false);
  assert.equal(AGGRESSIVE_PACKAGES.nativeRipgrep, true);
});

test('entryReplacementsFor and replacementPackages follow the resolved cuts', () => {
  assert.deepEqual(entryReplacementsFor([]), []);
  assert.deepEqual(replacementPackages([]), []);
  // The packages a replacement needs are derived from it, so the two can never disagree.
  assert.deepEqual(replacementPackages(['nativeRipgrep']), [...RIPGREP_REPLACEMENT.needs]);
});

test('the ripgrep cut drops a host-specific package — a hard-coded arch drops the wrong one', () => {
  assert.equal(PACKAGE_CUTS.nativeRipgrep.packages[0], `@vscode/ripgrep-${HOST_TAG}`);
});

test('keeping the search rows without a binary supplier is rejected — it ships a broken search', () => {
  assert.throws(() => assertSearchHasBinary([], []), /ripgrep binary/);
});

test('either cutting the rows or swapping in wasm satisfies the search invariant', () => {
  assertSearchHasBinary(['fileSearch'], []);
  assertSearchHasBinary([], ['nativeRipgrep']);
});

test('renderPatch emits a disabled entry for every cut row', () => {
  const text = renderPatch(['images']);
  assert.match(text, /- id: attachment-local\n {2}disabled: true/);
  assert.doesNotMatch(text, /session-telemetry-otel/);
});

test('renderPatch writes the reason as a comment — six months on nobody remembers why it was cut', () => {
  const text = renderPatch(['telemetry']);
  assert.ok(text.includes(CUTS.telemetry.reason));
});

test('renderPatch still emits a valid empty YAML array when nothing is cut', () => {
  const text = renderPatch([]);
  assert.match(text, /^\[\]$/m);
});

test('renderPatch output is stable: the same input yields byte-identical results', () => {
  const names: CutName[] = ['workflow', 'images'];
  assert.equal(renderPatch(names), renderPatch(names));
});

test('every package-level cut has a reason and a measured saving', () => {
  for (const [name, cut] of Object.entries(PACKAGE_CUTS)) {
    assert.ok(cut.packages.length > 0, `${name} has no target packages`);
    assert.ok(cut.reason.length > 0, `${name} has no reason`);
    assert.ok(cut.savedMiB > 0, `${name} has no measured saving`);
  }
});

test('every package-level cut is on by default', () => {
  assert.deepEqual(
    new Set(resolvePackageCuts(AGGRESSIVE_PACKAGES)),
    new Set(Object.keys(PACKAGE_CUTS)),
  );
});

test('droppedPackagePrefixes merges and deduplicates', () => {
  assert.deepEqual(droppedPackagePrefixes(['imageDecoding']), ['sharp', '@img']);
  assert.deepEqual(droppedPackagePrefixes([]), []);
});

test('assertCutPlanesComplete catches a host-plane-only cut — which breaks session creation', () => {
  assert.throws(
    () => assertCutPlanesComplete(['telemetry'], new Set(['session-telemetry-otel'])),
    /presetRows/,
  );
});

test('assertCutPlanesComplete accepts rows that appear on the host plane only', () => {
  assertCutPlanesComplete(['telemetry'], new Set(['something-else']));
});

test('assertCutPlanesComplete accepts rows declared on both planes', () => {
  assertCutPlanesComplete(['fileSearch'], new Set(['tool-fs-search']));
});
