#!/bin/sh
# Runner for `tauri build --runner`, so the Windows artifact can be cross-built on macOS.
#
# It exists to reconcile two things Tauri and cargo-xwin disagree about. Both failures look
# identical from the outside: a hundred `lld-link: error: undefined symbol: memcpy` lines out of
# libcmt.lib and libvcruntime.lib, naming neither cause.
#
# 1. `STATIC_VCRUNTIME=true`. The Tauri CLI sets it for every Windows target. On a real Windows
#    host that tells the `cc`/`winres` side to compile with `/MT`; under cargo-xwin it instead
#    selects static CRT import libraries *without* the matching `libucrt.lib`, so every libc symbol
#    ends up undefined. We get the static CRT from `-C target-feature=+crt-static` below, which
#    cargo-xwin handles correctly, so Tauri's variable is removed rather than worked around.
#
# 2. The static CRT flag has to reach cargo-xwin through `RUSTFLAGS`. Cargo would also read it from
#    `.cargo/config.toml`, but cargo-xwin does not look there — it would then link the *dynamic*
#    CRT libraries against a statically compiled crate. Setting it here keeps one source of truth
#    for the decision and keeps rustc and cargo-xwin reading the same value.
#
# Static CRT is what frees the installed app from the VC++ redistributable, for 0.12 MiB.
unset STATIC_VCRUNTIME
RUSTFLAGS="${RUSTFLAGS:+$RUSTFLAGS }-C target-feature=+crt-static"
export RUSTFLAGS

# `cargo xwin …`, not `cargo-xwin …`: cargo-xwin only sets up its MSVC sysroot when invoked as a
# cargo subcommand, and Tauri calls the runner binary directly.
exec cargo xwin "$@"
