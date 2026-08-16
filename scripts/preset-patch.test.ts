import { test } from 'node:test';
import assert from 'node:assert/strict';
import { disablePresetRows } from './preset-patch.ts';

const PRESET = `# comments must survive
- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    text: hi

# file search
- id: tool-fs-search
  name: '@deepseek-ai/dsh-tool-fs-search'
  config:
    sampleOverCapGlobResults: false

- id: tool-web
  name: '@deepseek-ai/dsh-tool-web'
`;

test('disablePresetRows inserts disabled: true after the target row name', () => {
  const out = disablePresetRows(PRESET, ['tool-fs-search']).text;
  assert.match(
    out,
    /- id: tool-fs-search\n {2}name: '@deepseek-ai\/dsh-tool-fs-search'\n {2}disabled: true\n/,
  );
});

test('disablePresetRows leaves other rows alone', () => {
  const out = disablePresetRows(PRESET, ['tool-fs-search']).text;
  assert.equal((out.match(/disabled: true/g) ?? []).length, 1);
  assert.match(out, /- id: tool-web\n {2}name: '@deepseek-ai\/dsh-tool-web'\n$/);
});

test('disablePresetRows preserves comments — upstream comments are design documentation and a YAML round-trip would eat them', () => {
  const out = disablePresetRows(PRESET, ['tool-fs-search']).text;
  assert.ok(out.includes('# comments must survive'));
  assert.ok(out.includes('# file search'));
});

test('disablePresetRows returns the text unchanged when the target row is absent', () => {
  assert.equal(disablePresetRows(PRESET, ['tool-nope']).text, PRESET);
});

test('disablePresetRows does not insert twice into an already disabled row', () => {
  const once = disablePresetRows(PRESET, ['tool-fs-search']).text;
  assert.equal(disablePresetRows(once, ['tool-fs-search']).text, once);
});

test('disablePresetRows reports which rows matched — zero matches means upstream changed', () => {
  assert.deepEqual(disablePresetRows(PRESET, ['tool-fs-search']).disabled, ['tool-fs-search']);
  assert.deepEqual(disablePresetRows(PRESET, ['tool-nope']).disabled, []);
});

test('disablePresetRows handles indented rows — child rows inside a group can be disabled too', () => {
  const nested = `- id: delegation
  name: cordis:group
  group: true
  config:
    - id: tool-subagent
      name: '@deepseek-ai/dsh-tool-subagent'
`;
  const out = disablePresetRows(nested, ['tool-subagent']).text;
  assert.match(
    out,
    / {4}- id: tool-subagent\n {6}name: '@deepseek-ai\/dsh-tool-subagent'\n {6}disabled: true\n/,
  );
});
