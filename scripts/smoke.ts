/**
 * Boots the built backend and proves it is usable, not merely alive.
 *
 * This exists because of a failure the build could not see: the `workflow` cut disabled a row on
 * one plane only, and the result launched, served HTTP 200, and rendered a complete UI — while
 * every attempt to create a session failed. `trim.ts` records the lesson; this is the part that
 * executes it, so a cut can be re-proved instead of re-argued.
 *
 * It matters most for cuts justified by reachability rather than by a build-time fact, which is why
 * `PACKAGE_CUTS.browserOnlyDeps` points here.
 */
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { BACKEND_OUT_DIR, DSH_ENTRY } from './build-backend.ts';
import { hostTriple, SIDECAR_BASE, sidecarFileName } from './stage-runtime.ts';

/** The line dsh prints once it is listening; the same contract `backend.rs` parses. */
export function parseServingUrl(line: string): string | undefined {
  const rest = line
    .trim()
    .replace(/^dsh web:/, '')
    .trim();
  if (rest === line.trim()) return undefined;
  return rest.startsWith('http://') || rest.startsWith('https://') ? rest : undefined;
}

/** Unwraps a server response into a plain verdict, so assertions read the same for every call. */
export function isOk(body: string): boolean {
  try {
    return (JSON.parse(body) as { result?: { ok?: boolean } }).result?.ok === true;
  } catch {
    return false;
  }
}

/**
 * Client bundle paths are discovered from the served HTML rather than hardcoded: which plugins ship
 * a bundle is exactly the kind of thing a cut changes, so a fixed name would test the wrong file.
 */
export function firstPluginBundle(html: string): string | undefined {
  return /\/plugins\/[\w@/.-]+\.js/.exec(html)?.[0];
}

/** Errors upstream logs without exiting; a cut that half-breaks the tree shows up here first. */
export function logFailures(log: string): string[] {
  return log
    .split('\n')
    .filter((line) =>
      /cannot find module|failed to import|did not activate|failed to mount/i.test(line),
    )
    .slice(0, 5);
}

const ROOT = resolve(import.meta.dirname, '..');
const BACKEND = join(ROOT, BACKEND_OUT_DIR);
/** Must match `home.rs`'s PROFILE: the seed directory and the launch flag have to agree. */
const PROFILE = 'desktop';

/** Prefer the staged sidecar — that is what ships. Fall back to this process's runtime. */
function runtimePath(): string {
  const name = sidecarFileName(SIDECAR_BASE, hostTriple(process.platform, process.arch));
  const sidecar = join(ROOT, 'src-tauri', 'binaries', name);
  return existsSync(sidecar) ? sidecar : process.execPath;
}

function seedHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'dsh-smoke-'));
  const profile = join(home, 'profiles', PROFILE);
  mkdirSync(profile, { recursive: true });
  cpSync(join(BACKEND, 'profile'), profile, { recursive: true });
  return home;
}

/** The server re-checks that the body's method matches the path, so both carry it. */
async function post(url: string, method: string): Promise<string> {
  const res = await fetch(`${url}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', method, rpcId: 'smoke', payload: {} }),
  });
  return res.text();
}

async function get(url: string): Promise<{ status: number; body: string }> {
  const res = await fetch(url);
  return { status: res.status, body: await res.text() };
}

async function main(): Promise<void> {
  const entry = join(BACKEND, 'node_modules', DSH_ENTRY);
  if (!existsSync(entry))
    throw new Error(`no backend to smoke: ${entry} (run npm run build:backend)`);

  const home = seedHome();
  // argv and env mirror `src-tauri/src/backend.rs::launch`, which is the authority; smoking a
  // configuration the app does not ship would prove the wrong thing.
  const child = spawn(
    runtimePath(),
    [entry, '--profile', PROFILE, '--host', '127.0.0.1', '--port', '0'],
    { env: { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1' } },
  );

  let log = '';
  let url: string | undefined;
  const collect = (chunk: Buffer): void => {
    log += chunk.toString();
    for (const line of log.split('\n')) url ??= parseServingUrl(line);
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);

  const deadline = Date.now() + 60_000;
  while (url === undefined && child.exitCode === null && Date.now() < deadline) {
    await new Promise((done) => setTimeout(done, 200));
  }

  const failures: string[] = [];
  const check = (name: string, ok: boolean, detail = ''): void => {
    console.log(`[smoke] ${ok ? 'ok  ' : 'FAIL'} ${name}${detail === '' ? '' : ` — ${detail}`}`);
    if (!ok) failures.push(name);
  };

  try {
    check(
      'backend announces an address',
      url !== undefined,
      url ?? log.split('\n').slice(-3).join(' | '),
    );
    if (url !== undefined) {
      const page = await get(url);
      check('serves the UI', page.status === 200, `HTTP ${page.status}, ${page.body.length} bytes`);

      // The one call a mount failure actually surfaces on: rows load lazily, per session.
      check('creates a session', isOk(await post(url, 'session.create')));
      check('lists agent presets', isOk(await post(url, 'agentPreset.list')));
      check('lists models', isOk(await post(url, 'llm.models')));

      const bundle = firstPluginBundle(page.body);
      const served = bundle === undefined ? undefined : await get(`${url}${bundle}`);
      check(
        'serves a client bundle',
        served?.status === 200 && served.body.length > 0,
        bundle ?? 'none referenced',
      );
    }
    const logged = logFailures(log);
    check('no load failures logged', logged.length === 0, logged.join(' | '));
  } finally {
    child.kill();
    rmSync(home, { recursive: true, force: true });
  }

  if (failures.length > 0) throw new Error(`smoke failed: ${failures.join(', ')}`);
  console.log('[smoke] backend is usable, not merely alive');
}

if (process.argv[1] !== undefined && resolve(process.argv[1]).endsWith('smoke.ts')) await main();
