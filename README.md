# dsh-desktop

English | [中文](README.zh.md)

The official [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) wrapped as a macOS desktop app.

A Tauri 2 shell (system WKWebView, no bundled Chromium) + a trimmed dsh backend + dsh's own web UI.
**Not a single line of frontend logic is copied** — the interface is entirely upstream's `ui-*` plugins, and it follows upstream releases.

| | Size |
|---|---|
| `npm i @deepseek-ai/dsh` as-is | 344 MB |
| Trimmed backend | 39 MB |
| Installed `.app` | 102 MB |
| DMG | 37 MB |

For comparison: an Electron build would be roughly 340 MB / 100–120 MB.

## Download

`DeepSeek-Harness-<version>-arm64.dmg` — macOS 11+, Apple Silicon, signed and notarized.

## Running it

```bash
npm install
npm run icon           # generate icons from the upstream favicon + official brand blue
npm run app:dev        # development
npm run app:build      # produce an unsigned .app
npm run check          # typecheck + format + JS unit tests + clippy + Rust unit tests
```

The first launch seeds the profile into
`~/Library/Application Support/com.nekocode.dsh-desktop/dsh-home/`;
from then on that `cordis.patch.yml` is yours, and upgrades never overwrite it.

**Your `~/.dsh` is left alone** — our profile is trimmed, and putting it next to the full version installed by the CLI would make the two fight each other.

## Producing a release build

```bash
APPLE_TEAM_ID=<your team> ./scripts/dist.sh
```

Notarization credentials are read from `NOTARIZE_KEY_ID` / `NOTARIZE_ISSUER` / `NOTARIZE_KEY_PATH`
(matching the common App Store Connect API Key convention). Sign without notarizing: `SKIP_NOTARIZE=true`.

The script verifies the signature of every nested binary one by one — Gatekeeper rejects on the innermost
unsigned file while the outer `.app` signature still reports as "valid", which is the most common way
Tauri sidecars go wrong.

## What got trimmed

Flip the `AGGRESSIVE` switches in `scripts/trim.ts`; every item can be reverted independently.

| Switch | Cuts | Saves | Cost |
|---|---|---|---|
| `foreignProviders` | pi-ai (the anthropic / google / mistral / aws / openai SDKs) | 70 MB | only the official DeepSeek channel remains |
| `telemetry` | OpenTelemetry export | 34 MB | none (upstream defaults to DISABLED) |
| `fileSearch` | `@vscode/ripgrep` | 5.5 MB | **loses the grep / glob tools** |
| `workflow` | multi-agent workflow orchestration | 0.5 MB | out of scope for the first release |

Also cut: 59 KaTeX fonts, all sourcemaps and `.d.ts` files, and the node-pty prebuilds for three
non-host platforms.

### sharp's 18 MB: keep the plugin, swap the engine

`dsh-host-apiproxy` writes `attachments` into its `static inject`, so `dsh-attachment-local`
**cannot be removed**. But the only model channel in this bundle, `dsh-llm-deepseek`, explicitly
rejects image content
(`"The DeepSeek chat-completions adapter does not support image content."`) —
images never reach the model, yet 18 MB of libvips would be carried for them.

So sharp is replaced with a pure-JS file-header parsing stand-in (`runtime/sharp-shim.js`, unit-tested
against real images generated with PIL, including the two special branches: lossless WebP and JPEG with EXIF).
The plugin still provides the `attachments` service; the weight is gone.

**An honest downgrade**: the admission-time "full decode" check degrades to a header check, so truncated
images will pass. Those bytes only go into local storage, are never decoded again, and never reach the
model, so the trade is acceptable. To get real decode validation back, turn off `PACKAGE_CUTS.imageDecoding`.

**What genuinely cannot be cut**: session-query-sqlite (also a `static inject`) and koffi (2 MB, never
reachable on macOS, but `dsh-sandbox-windows-acl` runs a fail-closed Win32 ABI layout self-check at module
top level, and stubbing it would mean copying upstream's magic numbers — not worth it).

## Runtime: Bun + three build-time patches

Bun instead of Node saves 28 MB (60 vs 89 after stripping). The three things Bun lacks are all patched at build time:

| Missing | Consequence | Fix |
|---|---|---|
| `node:module` has no `stripTypeScriptTypes` | the plugin tree never comes up | amaro's `strip-only` (which is what Node's built-in implementation is), **byte-length preserving** |
| `runProfile` unconditionally builds HMR, needing Node internals | crashes only after the watch starts — the hardest kind to trace | changed to "watch only if the composition actually has HMR" |
| **node-pty reads no data** | the bash tool silently returns empty | an adapter over Bun's native PTY (`Bun.spawn({ terminal })`) |

The third one is the critical one. Under Bun, node-pty **forks fine and reports exit codes — `onData` just
never fires** — the command really runs and the user sees nothing. dsh uses only 5 node-pty members
(`spawn` / `pid` / `onData` / `onExit` / `write` / `kill`, no `resize`), so the adapter surface is tiny;
see `scripts/pty-shim.ts`.

All three patches are harmless on Node (the adapter forwards straight through to the real node-pty),
so one backend artifact works on both runtimes — switching runtimes only swaps the single binary in
`src-tauri/binaries/`:

```bash
DSH_RUNTIME=node npm run stage:runtime
```

## Layout

```
scripts/
  compose.ts        parses dsh's composition manifests (two planes)
  trim.ts           the trim switch table: what is cut, why, and how much it saves
  backend-plan.ts   computes the nft entry set and the packages to exclude
  prune.ts          file-level pruning rules
  preset-patch.ts   patches the agent preset composition (a shipped root the user layer cannot override)
  bun-shim.ts       Bun compatibility patches
  build-backend.ts  the IO layer for all of the above
  stage-runtime.ts  strip + ad-hoc signing, staged into the sidecar directory
  make-icon.ts      official favicon + official brand blue → app icon
  dist.sh           sign · notarize · staple · DMG
src-tauri/src/
  lifecycle.rs      sidecar state machine (pure functions, hard-coded transition table)
  backend.rs        spawn / address discovery / reaping
  home.rs           $DSH_HOME seeding
ui/index.html       loading page (zero dependencies, navigated away once the backend is up)
```

All decision logic lives in pure functions; side effects are concentrated in `build-backend.ts` and `backend.rs`.

```bash
npm run check   # typecheck + format + JS unit tests + clippy + Rust unit tests
```

## Known limitations

- macOS arm64 only. Single-platform is the premise behind every cut.
- Code search (grep / glob) is off by default; see the table above.
- Hot reloading of `cordis.patch.yml` is disabled (config changes need an app restart).
- Upstream dsh is currently `0.1.0-rc.6`, itself in internal testing.
