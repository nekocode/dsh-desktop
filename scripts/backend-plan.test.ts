import { test } from 'node:test';
import assert from 'node:assert/strict';
import { packageNameOf, planBackend } from './backend-plan.ts';
import type { PluginRow } from './compose.ts';

const row = (id: string, name: string, disabled = false): PluginRow => ({ id, name, disabled });

test('packageNameOf strips the subpath and keeps the scope', () => {
  assert.equal(packageNameOf('@deepseek-ai/dsh-web-app/startup'), '@deepseek-ai/dsh-web-app');
  assert.equal(packageNameOf('@deepseek-ai/dsh-llm'), '@deepseek-ai/dsh-llm');
  assert.equal(packageNameOf('turndown/lib/x'), 'turndown');
  assert.equal(packageNameOf('turndown'), 'turndown');
});

test('planBackend removes packages of cut rows from the entry set', () => {
  const plan = planBackend({
    rows: [row('a', '@deepseek-ai/dsh-llm'), row('b', '@deepseek-ai/dsh-attachment-local')],
    cutRowIds: new Set(['b']),
    installedPackages: [],
  });
  assert.deepEqual(plan.entrySpecifiers, ['@deepseek-ai/dsh-llm']);
  assert.deepEqual([...plan.cutPackages], ['@deepseek-ai/dsh-attachment-local']);
});

test('planBackend keeps subpath entries — the main entry and a subpath have different closures', () => {
  const plan = planBackend({
    rows: [
      row('a', '@deepseek-ai/dsh-tool-subagent-control'),
      row('b', '@deepseek-ai/dsh-tool-subagent-control/list-agents'),
    ],
    cutRowIds: new Set(),
    installedPackages: [],
  });
  assert.deepEqual(plan.entrySpecifiers, [
    '@deepseek-ai/dsh-tool-subagent-control',
    '@deepseek-ai/dsh-tool-subagent-control/list-agents',
  ]);
});

test('planBackend treats upstream-disabled rows as entries too — presets mount them at runtime', () => {
  const plan = planBackend({
    rows: [row('tool-bash', '@deepseek-ai/dsh-tool-bash', true)],
    cutRowIds: new Set(),
    installedPackages: [],
  });
  assert.deepEqual(plan.entrySpecifiers, ['@deepseek-ai/dsh-tool-bash']);
});

test('planBackend unions in every @deepseek-ai package on disk — closing the runtime-computed-name hole', () => {
  const plan = planBackend({
    rows: [row('a', '@deepseek-ai/dsh-llm')],
    cutRowIds: new Set(),
    installedPackages: [
      '@deepseek-ai/dsh-llm',
      '@deepseek-ai/dsh-host-directory-picker-browse',
      '@deepseek-ai/dsh-host-directory-picker-native',
    ],
  });
  assert.deepEqual(plan.entrySpecifiers, [
    '@deepseek-ai/dsh-llm',
    '@deepseek-ai/dsh-host-directory-picker-browse',
    '@deepseek-ai/dsh-host-directory-picker-native',
  ]);
});

test('cuts outrank the disk union: a cut package cannot sneak back in from disk', () => {
  const plan = planBackend({
    rows: [row('b', '@deepseek-ai/dsh-attachment-local')],
    cutRowIds: new Set(['b']),
    installedPackages: ['@deepseek-ai/dsh-attachment-local', '@deepseek-ai/dsh-llm'],
  });
  assert.deepEqual(plan.entrySpecifiers, ['@deepseek-ai/dsh-llm']);
});

test('planBackend throws when one package is both cut and required by another row, instead of quietly picking a side', () => {
  assert.throws(
    () =>
      planBackend({
        rows: [
          row('cut-me', '@deepseek-ai/dsh-tool-fs-search'),
          row('keep-me', '@deepseek-ai/dsh-tool-fs-search'),
        ],
        cutRowIds: new Set(['cut-me']),
        installedPackages: [],
      }),
    /dsh-tool-fs-search.*keep-me/s,
  );
});

test('the same package cut once on each plane is not a conflict', () => {
  const plan = planBackend({
    rows: [
      row('tool-fs-search', '@deepseek-ai/dsh-tool-fs-search'),
      row('tool-fs-search', '@deepseek-ai/dsh-tool-fs-search'),
    ],
    cutRowIds: new Set(['tool-fs-search']),
    installedPackages: [],
  });
  assert.deepEqual(plan.entrySpecifiers, []);
});

test('planBackend throws when the trim table names a row that does not exist — otherwise the cut fails silently', () => {
  assert.throws(
    () =>
      planBackend({
        rows: [row('a', '@x/a')],
        cutRowIds: new Set(['renamed-upstream']),
        installedPackages: [],
      }),
    /renamed-upstream/,
  );
});
