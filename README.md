# dsh-desktop

English | [中文](README.zh.md)

The official [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) wrapped as a macOS desktop app.

A Tauri 2 shell (system WKWebView, no bundled Chromium) + a trimmed dsh backend + dsh's own web UI.
**Not a single line of frontend logic is copied** — the interface is entirely upstream's `ui-*` plugins, and it follows upstream releases.

| | Size |
|---|---|
| `npm i @deepseek-ai/dsh` as-is | 347 MB |
| Trimmed backend | 31 MB |
| Installed `.app` | 96 MB |
| DMG | 35 MB |

For comparison: an Electron build would be roughly 340 MB / 100–120 MB.

## Download

[`DeepSeek-Harness-arm64.dmg`](https://dsh-desktop.xiu.ai/dl/latest/DeepSeek-Harness-arm64.dmg) —
macOS 11+, Apple Silicon, signed and notarized. Individual versions are on the
[Releases](https://github.com/nekocode/dsh-desktop/releases) page.

## Updating

The app updates itself. It asks once a day, five seconds after launch, and stays silent unless there
is something to say; **Check for Updates…** in the application menu asks immediately and always
answers. An offer can be taken, postponed, or skipped for that version.

The update interface is a separate native window rather than anything drawn into the app. The main
window renders dsh's own web UI, which this project owns no line of — injecting into it would couple
the shell to upstream's markup and break the first time upstream changes it.

Manifests are one file per platform:

```
https://dsh-desktop.xiu.ai/updates/{{target}}-{{arch}}.json
```

so a Windows or Linux release can be cut by a separate pipeline without read-modify-writing the
manifest macOS clients depend on. Artifacts are served from R2 through a Worker whose routing is a
whitelist (`scripts/dist-worker.ts`), not a bucket proxy.

## Running it

```bash
npm install
npm run icon           # generate icons from the upstream favicon + official brand blue
npm run app:dev        # development
npm run app:build      # build the backend, smoke it, produce an unsigned .app
npm run check          # typecheck + format + JS unit tests + clippy + Rust unit tests
```

The first launch seeds the profile into
`~/Library/Application Support/com.nekocode.dsh-desktop/dsh-home/`;
from then on that `cordis.patch.yml` is yours, and upgrades never overwrite it. The rest of the
profile belongs to the build — it declares which plugins ship — so an upgrade refreshes it.

**Your `~/.dsh` is left alone** — our profile is trimmed, and putting it next to the full version installed by the CLI would make the two fight each other.

## Producing a release build

```bash
./scripts/dist.sh            # build · sign · notarize · DMG · update artifact
./scripts/dist.sh --release  # ...and publish it
npm run deploy:dist          # redeploy the download Worker (rarely needed)
```

Credentials live in `scripts/.env.local`, which the script sources: `APPLE_TEAM_ID` plus
`NOTARIZE_KEY_ID` / `NOTARIZE_ISSUER` / `NOTARIZE_KEY_PATH` for Apple, and
`TAURI_SIGNING_PRIVATE_KEY_PATH` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` for the updater. Sign without notarizing: `SKIP_NOTARIZE=true`
— which `--release` refuses to publish.

Two things the script does that Tauri would otherwise do wrong, both for the same reason — Tauri
produces its artifacts *before* signing:

- it signs every nested binary itself, not just the outer bundle
- it builds the DMG and the update tarball from the already signed, notarized and stapled `.app`,
  with `createUpdaterArtifacts` deliberately left off

The tarball is then unpacked again and re-verified, because what users install is the archive, not
the directory it came from.

The updater's public key is baked into `tauri.conf.json`. **Losing its private half means no
installed copy can ever be updated again**, since a new key cannot be introduced to an old build.

## What got trimmed

Flip the `AGGRESSIVE` switches in `scripts/trim.ts`; every item can be reverted independently.

| Switch | Cuts | Saves | Cost |
|---|---|---|---|
| `foreignProviders` | pi-ai (the anthropic / google / mistral / aws / openai SDKs) | 70 MB | only the official DeepSeek channel remains |
| `telemetry` | OpenTelemetry export | 34 MB | none (upstream defaults to DISABLED) |
| `workflow` | multi-agent workflow orchestration | 0.5 MB | out of scope for the first release |

Also cut: 59 KaTeX fonts, every sourcemap and `.d.ts` file, the node-pty prebuilds for three
non-host platforms, and 5.5 MB of browser-only libraries — React, shiki and katex reach the
artifact only because nft traces `@deepseek-ai` packages that no composition row loads, while the
browser gets them from the prebuilt frontend bundle.

Two dependencies are swapped rather than cut — one because its plugin cannot be removed, one because the tool is worth keeping:

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
  import-rewrite.ts one mechanism for pointing an upstream import at a shim
  *-shim.ts         the shims: Bun compatibility, node-pty, sharp, ripgrep
  build-backend.ts  the IO layer for all of the above
  stage-runtime.ts  strip + ad-hoc signing, staged into the sidecar directory
  make-icon.ts      official favicon + official brand blue → app icon
  dist.sh           sign · notarize · staple · DMG · update artifact · publish
  dist-paths.ts     the distribution topology: one table, read by the publisher and the Worker
  dist-worker.ts    the Cloudflare Worker serving dsh-desktop.xiu.ai out of R2
  manifest.ts       the update manifest, and the ways it can be silently wrong
  publish.ts        upload · read back and compare · GitHub Release
  smoke.ts          boot the artifact and prove a session can be created
src-tauri/src/
  lifecycle.rs      sidecar state machine (pure functions, hard-coded transition table)
  backend.rs        spawn / address discovery / reaping
  home.rs           $DSH_HOME seeding, and which of its files belong to the user
  menu.rs           the application menu, whose one addition is Check for Updates…
  update/           state machine · policy · preferences · orchestration
ui/index.html       loading page (zero dependencies, navigated away once the backend is up)
ui/update.html      the update window (zero dependencies, opened only when there is news)
```

All decision logic lives in pure functions; side effects are concentrated in `build-backend.ts` and `backend.rs`.

```bash
npm run check   # typecheck + format + JS unit tests + clippy + Rust unit tests
npm run smoke   # boot the built backend, create a session, serve a client bundle
```

`smoke` is the one that matters after changing a cut: a broken cut can still launch and serve a
complete UI, and only fail when a session is created. `app:build` and `app:dev` run it for you.

## Known limitations

- macOS arm64 only. Single-platform is the premise behind every cut.
- Hot reloading of `cordis.patch.yml` is disabled (config changes need an app restart).
- Upstream dsh is currently `0.1.0-rc.6`, itself in internal testing.
