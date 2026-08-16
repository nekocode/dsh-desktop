import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rewriteImport, type ImportRewrite } from './import-rewrite.ts';
import { STRIP_REWRITE } from './bun-shim.ts';
import { PTY_REWRITE } from './pty-shim.ts';
import { SHARP_REWRITE } from './sharp-shim.ts';

/**
 * One table over every rewrite, so a new shim inherits the whole contract instead of hand-copying
 * it — the sharp rewrite had no coverage at all while the other two had these tests written twice.
 *
 * `neighbour` and `callSite` pin the blast radius: only the one import may change.
 */
type Case = {
  readonly name: string;
  readonly rule: ImportRewrite;
  readonly upstream: string;
  readonly neighbour: string;
  readonly callSite: string;
};

const CASES: readonly Case[] = [
  {
    name: 'strip',
    rule: STRIP_REWRITE,
    upstream: `import { stripTypeScriptTypes } from "node:module";
import { Worker } from "node:worker_threads";

const stripped = stripTypeScriptTypes(STRIP_WRAP.prefix + program + STRIP_WRAP.suffix);
`,
    neighbour: 'from "node:worker_threads"',
    callSite: 'const stripped = stripTypeScriptTypes(STRIP_WRAP.prefix',
  },
  {
    name: 'pty',
    rule: PTY_REWRITE,
    upstream: `import { Buffer } from "node:buffer";
import * as nodePty from "node-pty";

const handle = new LocalTerminalHandle(nodePty.spawn(file, args, options), inspector);
`,
    neighbour: 'from "node:buffer"',
    callSite: 'nodePty.spawn(file, args, options)',
  },
  {
    name: 'sharp',
    rule: SHARP_REWRITE,
    upstream: `import { extname } from "node:path";
import sharp from "sharp";

const meta = await sharp(data).metadata();
`,
    neighbour: 'from "node:path"',
    callSite: 'await sharp(data).metadata()',
  },
];

for (const { name, rule, upstream, neighbour, callSite } of CASES) {
  test(`${name}: rewriteImport points the import at the shim`, () => {
    const out = rewriteImport(upstream, rule);
    assert.ok(out.includes(`./${rule.shimFilename}`));
    assert.doesNotMatch(out, rule.pattern);
  });

  test(`${name}: rewriteImport leaves neighbouring imports and call sites alone`, () => {
    const out = rewriteImport(upstream, rule);
    assert.ok(out.includes(neighbour));
    assert.ok(out.includes(callSite));
  });

  test(`${name}: rewriteImport is idempotent — rebuilding does not shim twice`, () => {
    const once = rewriteImport(upstream, rule);
    assert.equal(rewriteImport(once, rule), once);
  });

  test(`${name}: rewriteImport throws when the import is gone, never silently no-ops`, () => {
    assert.throws(
      () => rewriteImport('import { resolve } from "node:path";\n', rule),
      (error) => {
        // The error has to name the target and the consequence, or the build failure is unactionable.
        const text = String(error);
        assert.ok(text.includes(rule.target), text);
        assert.ok(text.includes(rule.consequence), text);
        return true;
      },
    );
  });

  test(`${name}: rewriteImport tolerates single-quoted imports`, () => {
    const singleQuoted = upstream.replace(/"([^"]+)"/g, "'$1'");
    assert.ok(rewriteImport(singleQuoted, rule).includes(rule.shimFilename));
  });
}

test('every rewrite targets a distinct upstream file — two rules on one file would fight', () => {
  const targets = CASES.map((c) => c.rule.target);
  assert.equal(new Set(targets).size, targets.length);
});
