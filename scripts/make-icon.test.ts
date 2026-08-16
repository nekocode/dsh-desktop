import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BRAND_BLUE,
  composeIconSvg,
  extractPathData,
  MACOS_LAYOUT,
  wrapForRender,
} from './make-icon.ts';

const FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" width="50" height="50" viewBox="0 0 50 50" fill="none">
\t<style>@media (prefers-color-scheme: dark) { path { fill: #fff; } }</style>
\t<path id="path" d="M48.8 10.0C48.3 9.7 48.1 10.2Z" fill="#000" fill-opacity="1.000000"/>
</svg>`;

test('extracts the whale path from the official favicon', () => {
  assert.equal(extractPathData(FAVICON), 'M48.8 10.0C48.3 9.7 48.1 10.2Z');
});

test('throws when extraction fails — an icon never crashes, it just stays wrong, so it must throw', () => {
  assert.throws(() => extractPathData('<svg><circle r="1"/></svg>'), /favicon/);
});

test('uses the official brand blue and no other blue', () => {
  assert.equal(BRAND_BLUE, '#4D6BFE');
  assert.ok(composeIconSvg('M0 0Z').includes('#4D6BFE'));
});

test('the whale is white and scaled centered inside its own viewBox', () => {
  const svg = composeIconSvg('M0 0Z');
  assert.match(svg, /<path d="M0 0Z" fill="#FFFFFF"\/>/);
  assert.ok(svg.includes('viewBox="0 0 50 50"'));
  assert.ok(svg.includes('preserveAspectRatio="xMidYMid meet"'));
});

test("follows Apple's macOS icon grid: an 824/1024 rounded square", () => {
  const svg = composeIconSvg('M0 0Z', MACOS_LAYOUT);
  assert.ok(svg.includes('width="824" height="824"'), svg.slice(0, 300));
  assert.ok(svg.includes('x="100" y="100"'));
  assert.ok(svg.includes('rx="185"'));
});

test('the layout is swappable — size and ratios are parameters', () => {
  const svg = composeIconSvg('M0 0Z', {
    size: 100,
    bodyRatio: 0.8,
    cornerRatio: 0.25,
    artRatio: 0.5,
  });
  assert.ok(svg.includes('width="100" height="100"'));
  assert.ok(svg.includes('width="80" height="80"'));
  assert.ok(svg.includes('rx="20"'));
});

test('the render HTML must have no margin or scrollbars — otherwise the screenshot is offset', () => {
  const html = wrapForRender('<svg/>', 1024);
  assert.ok(html.includes('margin:0'));
  assert.ok(html.includes('overflow:hidden'));
  assert.ok(html.includes('width:1024px'));
});
