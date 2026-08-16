# dsh-desktop

English | [中文](README.zh.md)

The official [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) wrapped as a macOS desktop app.

A Tauri 2 shell (system WKWebView, no bundled Chromium) + a trimmed dsh backend + dsh's own web UI.
**Not a single line of frontend logic is copied** — the interface is entirely upstream's `ui-*` plugins, and it follows upstream releases.

| | Size |
|---|---|
| `npm i @deepseek-ai/dsh` as-is | 347 MB |
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

Notarization credentials are read from `NOTARIZE_KEY_ID` / `NOTARIZE_ISSUER` / `NOTARIZE_KEY_PATH`.
Sign without notarizing: `SKIP_NOTARIZE=true`.

The script signs every nested binary itself, because Tauri signs only the outer bundle; the reasoning
is in `scripts/dist.sh`.

## What got trimmed

Flip the `AGGRESSIVE` switches in `scripts/trim.ts`; every item can be reverted independently.

| Switch | Cuts | Saves | Cost |
|---|---|---|---|
| `foreignProviders` | pi-ai (the anthropic / google / mistral / aws / openai SDKs) | 70 MB | only the official DeepSeek channel remains |
| `telemetry` | OpenTelemetry export | 34 MB | none (upstream defaults to DISABLED) |
| `workflow` | multi-agent workflow orchestration | 0.5 MB | out of scope for the first release |

Also cut: 59 KaTeX fonts, all sourcemaps and `.d.ts` files, the node-pty prebuilds for three
non-host platforms, and katex's CJS twin, which nothing in the artifact requires.

Two dependencies are swapped rather than cut, because the plugins that pull them in cannot be removed:

| Swap | From | To |
|---|---|---|
| `imageDecoding` | sharp + libvips, 18 MB | pure-JS header parser, `runtime/sharp-shim.js` |
| `nativeRipgrep` | `@vscode/ripgrep` binary, 4.3 MB | the same ripgrep as wasm, 768 KB, `runtime/ripgrep-shim.js` |

sharp goes because the only model channel in this bundle rejects images outright, so the bytes never
reach a model; the cost is that admission checks a file header instead of a full decode. ripgrep stays
because code search is worth its weight — the wasm build emits byte-identical `--json` records with the
same `.gitignore` semantics, and keeping search costs 0.9 MB in total. It runs 3–9x slower, worst
where the absolute cost is smallest: a typical repo search is 74 ms against 8.5 ms native.

Why each cut and swap is safe, and what breaks if it stops being safe, is documented where the decision
lives: `scripts/trim.ts` and the two shims.

## Runtime: Bun + three build-time patches

Bun instead of Node saves 28 MB (60 vs 89 after stripping). The three things Bun lacks are all patched at build time:

| Missing | Consequence | Fix |
|---|---|---|
| `node:module` has no `stripTypeScriptTypes` | the plugin tree never comes up | amaro's `strip-only`, byte-length preserving |
| `runProfile` builds HMR unconditionally, needing Node internals | crashes after the server is already listening | watch only when the composition has HMR |
| **node-pty reads no data** | the bash tool silently returns empty | an adapter over Bun's native PTY, `scripts/pty-shim.ts` |

All three are harmless on Node, so one backend artifact serves both runtimes; switching swaps the
single binary in `src-tauri/binaries/`:

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
  ripgrep-shim.ts   swaps the native ripgrep binary for the wasm build
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
- Hot reloading of `cordis.patch.yml` is disabled (config changes need an app restart).
- Upstream dsh is currently `0.1.0-rc.6`, itself in internal testing.
