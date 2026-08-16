import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fill, keep, placeholdersIn, stripComments, throwOnMissing } from './template.ts';

test('a value replaces its placeholder', () => {
  assert.equal(
    fill('<h1>{{title}}</h1>', { title: 'Harness' }, throwOnMissing),
    '<h1>Harness</h1>',
  );
});

test('`keep` leaves an unknown placeholder for a later pass', () => {
  // The layout is assembled before it is resolved: nav and body arrive carrying their own
  // placeholders, and string replacement never rescans what it just inserted.
  assert.equal(fill('{{body}}', { body: '<p>{{lede}}</p>' }, keep), '<p>{{lede}}</p>');
  assert.equal(fill('{{unknown}}', {}, keep), '{{unknown}}');
});

test('`throwOnMissing` fails the build rather than shipping a literal placeholder', () => {
  assert.throws(() => fill('{{heroTitle}}', {}, throwOnMissing), /heroTitle/);
});

test('a multi-line value inherits the indentation of the line it lands on', () => {
  // The template owns the layout; the generator emits flat lines. Baking the indent into
  // the generator means the next reflow of the template silently misaligns the output.
  const rendered = fill(
    '<head>\n  {{meta}}\n</head>',
    { meta: '<title>a</title>\n<link rel="x">' },
    throwOnMissing,
  );
  assert.equal(rendered, '<head>\n  <title>a</title>\n  <link rel="x">\n</head>');
});

test('blank lines inside a multi-line value stay bare', () => {
  // Padding them would plant trailing whitespace on every blank line of every page.
  const rendered = fill('  {{block}}', { block: 'a\n\nb' }, throwOnMissing);
  assert.equal(rendered, '  a\n\n  b');
});

test('`$&` in a value survives — CSS and code samples contain it', () => {
  assert.equal(
    fill('{{css}}', { css: 'a[href$="&"] { color: red }' }, throwOnMissing),
    'a[href$="&"] { color: red }',
  );
});

test('placeholdersIn reports what is still unresolved', () => {
  assert.deepEqual(placeholdersIn('{{a}} b {{c}}'), ['a', 'c']);
  assert.deepEqual(placeholdersIn('nothing here'), []);
});

test('own-line comments are stripped, inline ones are kept', () => {
  // Template comments are written for whoever edits the template. They are not content,
  // and without this they would be shipped to every visitor.
  assert.equal(stripComments('<!-- why -->\n<p>a</p>\n'), '<p>a</p>\n');
  assert.equal(stripComments('  <!-- why\n       continued -->\n<p>a</p>'), '<p>a</p>');
  assert.equal(stripComments('<p>a</p> <!-- kept -->'), '<p>a</p> <!-- kept -->');
});
