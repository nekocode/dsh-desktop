//! Spawning, address discovery and reaping of the backend sidecar.
//!
//! Every side effect is concentrated here; state decisions live in `lifecycle` and address parsing
//! is a pure function, both unit-testable.

use std::collections::VecDeque;
use std::sync::Mutex;
use std::time::Duration;

use tauri::{AppHandle, Manager, Url};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

use crate::home;
use crate::lifecycle::{next, Event, State};
use crate::log;

/// The one line dsh prints on stdout once it has started successfully.
const ANNOUNCE: &str = "dsh web:";

/// Subdirectory holding the backend inside the bundled resources, matching the resources mapping in `tauri.conf.json`.
const BACKEND_DIR: &str = "backend";
/// Entry of the whole plugin tree, relative to the backend directory.
const DSH_ENTRY: &str = "node_modules/@deepseek-ai/dsh/lib/bin.js";

/// How many trailing stderr lines to report on failure. Enough to read the stack, not enough to flood the window.
const TAIL_LINES: usize = 40;

/// Upper bound from spawn to announced address. A cold start measures ~0.6s; 60s leaves room for slow machines and antivirus.
const STARTUP_TIMEOUT: Duration = Duration::from_secs(60);

/// Window label, used by both navigation and error reporting.
const MAIN_WINDOW: &str = "main";

/// Navigates the webview from the loading page to the backend address once ready.
///
/// Navigation happens on the Rust side rather than letting the loading page jump via Tauri's JS
/// API: that keeps the loading page pure static HTML with no dependency on any injected global, so
/// it cannot turn into a blank screen because of CSP or an API version change.
fn navigate(app: &AppHandle, url: &str) {
    let Some(window) = app.get_webview_window(MAIN_WINDOW) else {
        log::event("window", "navigate", "main window not found");
        return;
    };
    match Url::parse(url) {
        Ok(parsed) => {
            let result = window.navigate(parsed);
            log::event("window", "navigate", &format!("{url} ok={}", result.is_ok()));
        }
        Err(e) => log::event("window", "navigate", &format!("invalid url {url}: {e}")),
    }
}

/// Surfaces the failure reason on the loading page. Only a visible reason can be pasted back to us.
pub fn show_failure(app: &AppHandle, reason: &str) {
    let Some(window) = app.get_webview_window(MAIN_WINDOW) else {
        return;
    };
    let payload = serde_json::to_string(reason).unwrap_or_else(|_| "\"unknown error\"".into());
    let _ = window.eval(format!("window.dshFailed && window.dshFailed({payload})"));
}

/// Recognizes the listening address in a line of dsh stdout.
///
/// The port is always chosen by the OS (`--port 0`), so the address can only be read from this line
/// — a hard-coded port would fail silently whenever the user already occupies it.
pub fn parse_serving_url(line: &str) -> Option<String> {
    let rest = line.trim().strip_prefix(ANNOUNCE)?.trim();
    if rest.starts_with("http://") || rest.starts_with("https://") {
        Some(rest.to_string())
    } else {
        None
    }
}

/// The process handle lives next to the state: the state says whether killing is allowed right now, the handle says what to kill.
#[derive(Default)]
pub struct Backend {
    inner: Mutex<StateAndChild>,
}

#[derive(Default)]
struct StateAndChild {
    state: State,
    child: Option<CommandChild>,
}

impl Backend {
    fn apply(&self, event: Event) -> Result<State, String> {
        let mut guard = self.inner.lock().map_err(|e| e.to_string())?;
        let moved = next(&guard.state, event).map_err(|e| e.to_string())?;
        guard.state = moved.clone();
        Ok(moved)
    }

    /// Transitions on `Attached` and takes the process handle **under the same lock**.
    ///
    /// Two separate locks would open a window where the state is already Starting while child is
    /// still None: a shutdown arriving in that window loses the handle forever and leaves the
    /// process in the background holding the port. That is the only reason `Attached` exists, so
    /// it gets its own method rather than an `Option` sentinel on every other transition.
    fn attach(&self, child: CommandChild) -> Result<State, String> {
        let mut guard = self.inner.lock().map_err(|e| e.to_string())?;
        let moved = next(&guard.state, Event::Attached).map_err(|e| e.to_string())?;
        guard.state = moved.clone();
        guard.child = Some(child);
        Ok(moved)
    }

    fn state(&self) -> Option<State> {
        self.inner.lock().ok().map(|guard| guard.state.clone())
    }

    /// Must be called on exit: closing the Tauri window does not reap the sidecar, and the leftover
    /// process keeps holding the port.
    ///
    /// Goes through the state machine rather than writing the field directly — a single write path
    /// is what makes the state a single source of truth.
    pub fn shutdown(&self) {
        if let Err(e) = self.apply(Event::Shutdown) {
            log::event("backend", "shutdown", &format!("rejected by the state machine: {e}"));
        }
        // The handle must be taken even from a poisoned lock — failing to would leak a process
        // permanently, which is worse than a panic, so this is logged explicitly rather than hidden
        // behind a silent `if let Ok`.
        let child = match self.inner.lock() {
            Ok(mut guard) => guard.child.take(),
            Err(poisoned) => {
                log::event("backend", "shutdown", "lock poisoned, taking the handle anyway");
                poisoned.into_inner().child.take()
            }
        };
        match child {
            Some(child) => {
                let result = child.kill();
                log::event("backend", "shutdown", &format!("killed: {}", result.is_ok()));
            }
            None => log::event("backend", "shutdown", "no child"),
        }
    }
}

/// Spawns the sidecar and waits asynchronously for it to announce its address.
///
/// The main thread is never blocked: the Tauri window must appear before the sidecar is up, or the
/// user stares at an unresponsive black screen. The loading page shows first; navigation follows
/// once the address arrives.
pub fn launch(app: &AppHandle) -> Result<(), String> {
    let backend = app.state::<Backend>();
    backend.apply(Event::Launch)?;

    let resources = app
        .path()
        .resource_dir()
        .map_err(|e| format!("resource directory not found: {e}"))?;
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("data directory not found: {e}"))?;

    let dsh_home = home::home_dir(&app_data);
    let seeded = home::seed_profile(&dsh_home, &resources.join(BACKEND_DIR).join("profile"))
        .map_err(|e| format!("seeding the profile failed: {e}"))?;
    log::event(
        "home",
        "seed-profile",
        &format!("home={} written={:?}", dsh_home.display(), seeded),
    );

    let entry = resources.join(BACKEND_DIR).join(DSH_ENTRY);
    if !entry.exists() {
        return Err(format!("backend entry missing: {}", entry.display()));
    }

    let (mut rx, child) = app
        .shell()
        .sidecar("dsh-runtime")
        .map_err(|e| format!("sidecar not found: {e}"))?
        .env("DSH_HOME", dsh_home.to_string_lossy().to_string())
        // The telemetry plugin is already cut at build time; this variable is a second line of defense in case the switch is ever turned off.
        .env("DSH_TELEMETRY_DISABLED", "1")
        .args([
            entry.to_string_lossy().to_string(),
            "--profile".into(),
            home::PROFILE.into(),
            "--host".into(),
            "127.0.0.1".into(),
            // Let the OS pick the port to avoid clashing with services already on the user's machine.
            "--port".into(),
            "0".into(),
        ])
        .spawn()
        .map_err(|e| format!("spawning the sidecar failed: {e}"))?;

    // The transition and taking the handle must share one lock, or a shutdown in that instant
    // misses the process. An illegal transition has exactly one cause: the app shut down in the
    // meantime, so the just-spawned process is reaped immediately.
    if let Err(e) = backend.attach(child) {
        log::event("backend", "attach", &format!("already shut down, reaping the process: {e}"));
        return Ok(());
    }
    log::event("backend", "spawn", &format!("entry={}", entry.display()));

    watch_startup(app);

    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        // All diagnostics from a dsh crash land on stderr; the last few lines are kept to report to the user.
        let mut tail: VecDeque<String> = VecDeque::with_capacity(TAIL_LINES);

        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(bytes) | CommandEvent::Stderr(bytes) => {
                    let text = String::from_utf8_lossy(&bytes);
                    for line in text.lines() {
                        match parse_serving_url(line) {
                            Some(url) => serve(&app, &url),
                            None if !line.trim().is_empty() => {
                                if tail.len() == TAIL_LINES {
                                    tail.pop_front();
                                }
                                tail.push_back(line.to_string());
                            }
                            None => {}
                        }
                    }
                }
                CommandEvent::Terminated(payload) => {
                    let tail: Vec<&str> = tail.iter().map(String::as_str).collect();
                    crashed(
                        &app,
                        format!(
                            "sidecar exited code={:?} signal={:?}\n{}",
                            payload.code,
                            payload.signal,
                            tail.join("\n")
                        ),
                    );
                }
                _ => {}
            }
        }
    });

    Ok(())
}

fn serve(app: &AppHandle, url: &str) {
    match app.state::<Backend>().apply(Event::Served {
        url: url.to_string(),
    }) {
        Ok(_) => {
            log::event("backend", "ready", url);
            navigate(app, url);
        }
        Err(e) => log::event("backend", "ready", &format!("rejected: {e}")),
    }
}

/// The process died, or startup timed out. Both paths share one exit so the UI behaves consistently.
fn crashed(app: &AppHandle, reason: String) {
    log::event("backend", "crashed", &reason);
    match app.state::<Backend>().apply(Event::Crashed {
        reason: reason.clone(),
    }) {
        Ok(_) => show_failure(app, &reason),
        // A process exit after shutdown is normal, but any other rejection is a bug — log them all,
        // so that expected silence and unexpected silence never share the same quiet path.
        Err(e) => log::event("backend", "crashed", &format!("rejected by the state machine: {e}")),
    }
}

/// Startup watchdog.
///
/// Without it, a sidecar that "starts but never prints an address" (a stuck port bind, a stuck
/// profile, a stuck native module load) spins forever: no error, no log, no way out.
fn watch_startup(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(STARTUP_TIMEOUT).await;
        if matches!(app.state::<Backend>().state(), Some(State::Starting)) {
            crashed(
                &app,
                format!(
                    "startup timed out (still not listening after {}s). The backend process is alive but never announced an address.",
                    STARTUP_TIMEOUT.as_secs()
                ),
            );
        }
    });
}

#[cfg(test)]
mod tests {
    use super::parse_serving_url;

    #[test]
    fn recognizes_the_listening_address() {
        assert_eq!(
            parse_serving_url("dsh web: http://127.0.0.1:58422").as_deref(),
            Some("http://127.0.0.1:58422")
        );
    }

    #[test]
    fn tolerates_surrounding_whitespace_and_line_ending_leftovers() {
        assert_eq!(
            parse_serving_url("  dsh web:   http://127.0.0.1:1 \r").as_deref(),
            Some("http://127.0.0.1:1")
        );
    }

    #[test]
    fn ordinary_log_lines_are_not_taken_as_addresses() {
        for line in [
            "",
            "dsh: booting",
            "some noise http://127.0.0.1:1",
            "dsh web:",
            "dsh web: not-a-url",
        ] {
            assert_eq!(parse_serving_url(line), None, "false positive: {line}");
        }
    }
}
