import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseComposedConfig } from './compose.ts';

const SAMPLE = `# == @deepseek-ai/dsh-base
- id: timer
  name: '@deepseek-ai/cordis-plugin-timer'
# == patched by @deepseek-ai/dsh-web-app
- id: hmr
  name: '@deepseek-ai/cordis-plugin-hmr'
  config:
    root:
      - .
  disabled: true
- id: session-persistence-jsonl
  name: '@deepseek-ai/dsh-session-persistence-jsonl'
  config:
    root: !!js dshHomePath('sessions')
- id: telemetry
  name: '@deepseek-ai/dsh-session-telemetry-otel'
  config:
    exporter:
      url: !!js >-
        process.env.DSH_TELEMETRY_OTLP_URL ??
        'https://example.invalid/v1/logs'
- id: startup
  name: '@deepseek-ai/dsh-web-app/startup'
`;

test('parseComposedConfig reads id / name / disabled for every row', () => {
  const rows = parseComposedConfig(SAMPLE);
  assert.equal(rows.length, 5);
  assert.deepEqual(rows[0], {
    id: 'timer',
    name: '@deepseek-ai/cordis-plugin-timer',
    disabled: false,
  });
  assert.equal(rows[1]?.disabled, true);
});

test('parseComposedConfig tolerates !!js scalars and !!js block scalars', () => {
  const rows = parseComposedConfig(SAMPLE);
  assert.equal(rows[2]?.name, '@deepseek-ai/dsh-session-persistence-jsonl');
  assert.equal(rows[3]?.name, '@deepseek-ai/dsh-session-telemetry-otel');
});

test('parseComposedConfig rejects rows without a name instead of skipping them silently', () => {
  assert.throws(() => parseComposedConfig('- id: nameless\n  config: {}\n'), /nameless/);
});

test('parseComposedConfig returns an empty array for an empty manifest', () => {
  assert.deepEqual(parseComposedConfig('[]\n'), []);
});

const GROUPED = `- id: delegation
  name: cordis:group
  group: true
  isolate:
    workflowEngine: true
  config:
    - id: tool-subagent-control
      name: '@deepseek-ai/dsh-tool-subagent-control'
    - id: tool-subagent-list
      name: '@deepseek-ai/dsh-tool-subagent-control/list-agents'
- id: tool-web
  name: '@deepseek-ai/dsh-tool-web'
`;

test('parseComposedConfig flattens group rows recursively — agent presets hide plugins in a group config', () => {
  const names = parseComposedConfig(GROUPED).map((r) => r.name);
  assert.deepEqual(names, [
    '@deepseek-ai/dsh-tool-subagent-control',
    '@deepseek-ai/dsh-tool-subagent-control/list-agents',
    '@deepseek-ai/dsh-tool-web',
  ]);
});

test('parseComposedConfig drops pseudo package names such as cordis:group', () => {
  assert.ok(!parseComposedConfig(GROUPED).some((r) => r.name.includes(':')));
});

test('a disabled group marks its child rows disabled too', () => {
  const rows = parseComposedConfig(`- id: g
  name: cordis:group
  group: true
  disabled: true
  config:
    - id: inner
      name: '@x/inner'
`);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.disabled, true);
});

test('parseComposedConfig ignores a !!js disabled expression — platform conditions are undecidable at build time', () => {
  const rows = parseComposedConfig(`- id: tool-pwsh
  name: '@deepseek-ai/dsh-tool-pwsh'
  disabled: !!js process.platform !== 'win32'
`);
  assert.equal(rows[0]?.disabled, false);
});
