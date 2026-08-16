import { test } from 'node:test';
import assert from 'node:assert/strict';
import { firstPluginBundle, isOk, logFailures, parseServingUrl } from './smoke.ts';

test('parseServingUrl reads the address dsh announces, and only that line', () => {
  assert.equal(parseServingUrl('dsh web: http://127.0.0.1:1234'), 'http://127.0.0.1:1234');
  assert.equal(parseServingUrl('  dsh web:   http://127.0.0.1:1 \r'), 'http://127.0.0.1:1');
  for (const line of [
    '',
    'dsh: booting',
    'noise http://127.0.0.1:1',
    'dsh web:',
    'dsh web: nope',
  ]) {
    assert.equal(parseServingUrl(line), undefined, line);
  }
});

test('isOk unwraps the result envelope and treats junk as failure', () => {
  assert.equal(isOk('{"result":{"ok":true,"value":{}}}'), true);
  assert.equal(isOk('{"result":{"ok":false,"error":{}}}'), false);
  assert.equal(isOk('not found'), false);
  assert.equal(isOk(''), false);
});

test('firstPluginBundle discovers the bundle path instead of hardcoding a package', () => {
  const html =
    '<script src="/assets/index.js"></script>{"modules":["/plugins/@deepseek-ai/dsh-client-x/client.js"]}';
  assert.equal(firstPluginBundle(html), '/plugins/@deepseek-ai/dsh-client-x/client.js');
  assert.equal(firstPluginBundle('<html></html>'), undefined);
});

test('logFailures catches the shapes a half-broken cut produces, bounded', () => {
  assert.deepEqual(logFailures('fine\nError: Cannot find module "katex"\nalso fine'), [
    'Error: Cannot find module "katex"',
  ]);
  assert.deepEqual(logFailures('preset "standard" failed to mount').length, 1);
  assert.deepEqual(logFailures('1 entry did not activate').length, 1);
  assert.deepEqual(logFailures('all good'), []);
  assert.equal(logFailures('cannot find module\n'.repeat(20)).length, 5);
});
