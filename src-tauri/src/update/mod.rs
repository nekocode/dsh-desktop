//! Update checking, downloading and installing.
//!
//! Everything with a side effect lives here; the decisions live in `state.rs` (what may happen
//! next) and `policy.rs` (whether it should happen at all), both pure and both tested.
//!
//! The user interface is a separate small window (`ui/update.html`), never anything drawn into the
//! main window. The main window shows dsh's own web UI, which this project does not own a line of:
//! injecting into it would couple us to upstream's DOM and break the moment it changes.

mod policy;
mod state;
mod store;

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::backend::Backend;
use crate::log;

pub use policy::Trigger;
use policy::Prefs;
use state::{next, Event, State};

/// Label of the update window. Also what `lib.rs` matches on to tell it apart from the main window.
pub const WINDOW: &str = "update";

/// Event carrying the whole state to the window. One payload, pushed on every transition — the page
/// renders what it is given instead of keeping a second copy of the state to drift from this one.
///
/// Addressed to the update window rather than broadcast: the only other window is dsh's own UI, and
/// spraying thousands of download-progress events into a page that has no listener for them is both
/// wasted IPC and a way to collide with upstream's own event names.
const STATE_EVENT: &str = "update:state";

/// How many bytes must arrive before the window is told again.
///
/// The download callback fires per network chunk — thousands of times for a 35 MB update. Every one
/// of those would be a serialization, an IPC hop and a layout. Progress is still counted exactly;
/// only the telling is batched, and 512 KB is finer than the bar can draw anyway.
const PROGRESS_STEP: u64 = 512 * 1024;

/// How long the automatic check waits after launch.
///
/// The backend sidecar is starting in this window and it is what the user is waiting for; a check
/// racing it would compete for exactly the bandwidth and CPU that delay the thing they asked for.
const STARTUP_DELAY: Duration = Duration::from_secs(5);

pub struct Updater {
    state: Mutex<State>,
    /// The offer from the last successful check, kept because installing happens later, only if
    /// the user says so — and the plugin cannot re-derive it without asking the endpoint again.
    pending: Mutex<Option<Update>>,
    prefs_path: PathBuf,
}

impl Updater {
    fn new(prefs_path: PathBuf) -> Self {
        Self {
            state: Mutex::new(State::default()),
            pending: Mutex::new(None),
            prefs_path,
        }
    }

    /// Moves the state machine and pushes the result to the window in one step.
    ///
    /// Emitting here rather than at each call site is what makes "the window always shows the
    /// current state" true by construction instead of by remembering.
    fn apply(&self, app: &AppHandle, event: Event) -> Result<State, String> {
        let moved = {
            let mut guard = self.state.lock().map_err(|e| e.to_string())?;
            let moved = next(&guard, event).map_err(|e| e.to_string())?;
            *guard = moved.clone();
            moved
        };
        let _ = app.emit_to(WINDOW, STATE_EVENT, &moved);
        Ok(moved)
    }

    fn state(&self) -> State {
        self.state
            .lock()
            .map(|guard| guard.clone())
            .unwrap_or_default()
    }

    fn prefs(&self) -> Prefs {
        store::load(&self.prefs_path)
    }

    fn write_prefs(&self, prefs: &Prefs) {
        match store::save(&self.prefs_path, prefs) {
            Ok(()) => log::event("update", "save-prefs", "ok"),
            // Losing this costs one redundant check, or one extra prompt for a skipped version.
            // Not worth failing anything the user asked for.
            Err(e) => log::event("update", "save-prefs", &format!("failed: {e}")),
        }
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Registers the updater and schedules the automatic check.
///
/// Failing to resolve the data directory disables persistence, not updating: the app should still
/// be able to tell the user a new version exists, it just re-asks every launch.
pub fn init(app: &AppHandle) {
    let prefs_path = match app.path().app_data_dir() {
        Ok(dir) => store::path(&dir),
        Err(e) => {
            log::event("update", "init", &format!("no data directory, prefs disabled: {e}"));
            PathBuf::new()
        }
    };
    app.manage(Updater::new(prefs_path));

    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(STARTUP_DELAY).await;
        check(app, Trigger::Startup).await;
    });
}

/// Asks the endpoint, and opens the window if there is something worth saying.
pub async fn check(app: AppHandle, trigger: Trigger) {
    let updater = app.state::<Updater>();
    let prefs = updater.prefs();
    if !policy::should_check(trigger, &prefs, now_ms()) {
        log::event("update", "check", "skipped: checked within the last day");
        return;
    }
    if let Err(e) = updater.apply(&app, Event::Check) {
        log::event("update", "check", &format!("rejected: {e}"));
        return;
    }
    // A manual check must show something immediately: the user clicked a menu item and is waiting
    // for an answer, including the answer "nothing new".
    if trigger == Trigger::Manual {
        open_window(&app);
    }

    let found = match app.updater() {
        Ok(plugin) => plugin.check().await,
        Err(e) => Err(e),
    };
    match found {
        Ok(Some(update)) => {
            let version = update.version.clone();
            let notes = update.body.clone().unwrap_or_default();
            log::event("update", "check", &format!("found {version}"));
            record_check(&updater, &prefs);
            *updater.pending.lock().unwrap_or_else(|e| e.into_inner()) = Some(update);
            if updater.apply(&app, Event::Found { version: version.clone(), notes }).is_err() {
                return;
            }
            // Deliberately the copy read before `record_check`: only `last_check_at` changed, and
            // re-reading the file to learn a value we just wrote ourselves is I/O for nothing.
            if policy::should_announce(trigger, &prefs, &version) {
                open_window(&app);
            } else {
                log::event("update", "announce", &format!("suppressed: {version} was skipped"));
                let _ = updater.apply(&app, Event::Dismiss);
            }
        }
        Ok(None) => {
            log::event("update", "check", "already up to date");
            record_check(&updater, &prefs);
            let _ = updater.apply(&app, Event::NotFound);
        }
        Err(e) => {
            // Being offline is the ordinary case here, so a failed startup check stays silent in
            // the UI and only leaves a log line; a manual check has a window open to show it in.
            log::event("update", "check", &format!("failed: {e}"));
            let _ = updater.apply(&app, Event::Failed { reason: e.to_string() });
        }
    }
}

/// Only a check that actually reached the endpoint resets the clock. Recording a failed one would
/// mean a machine that was offline at launch waits a full day before trying again.
fn record_check(updater: &Updater, prefs: &Prefs) {
    updater.write_prefs(&Prefs {
        last_check_at: Some(now_ms()),
        ..prefs.clone()
    });
}

async fn install(app: AppHandle) {
    let updater = app.state::<Updater>();
    if let Err(e) = updater.apply(&app, Event::Install) {
        log::event("update", "install", &format!("rejected: {e}"));
        return;
    }
    let Some(update) = updater.pending.lock().unwrap_or_else(|e| e.into_inner()).take() else {
        let _ = updater.apply(&app, Event::Failed {
            reason: "the update offer is gone; check again".into(),
        });
        return;
    };

    let progress_app = app.clone();
    let mut unreported: u64 = 0;
    let result = update
        .download_and_install(
            move |chunk, total| {
                // Counted exactly, reported in steps — see PROGRESS_STEP. The final step is
                // reported by whichever chunk crosses it; the last few bytes ride along with Done.
                unreported += chunk as u64;
                if unreported < PROGRESS_STEP {
                    return;
                }
                let _ = progress_app.state::<Updater>().apply(
                    &progress_app,
                    Event::Progress {
                        chunk: unreported,
                        total,
                    },
                );
                unreported = 0;
            },
            || {},
        )
        .await;

    match result {
        Ok(()) => {
            log::event("update", "install", "bundle replaced, awaiting restart");
            let _ = updater.apply(&app, Event::Done);
        }
        Err(e) => {
            log::event("update", "install", &format!("failed: {e}"));
            let _ = updater.apply(&app, Event::Failed { reason: e.to_string() });
        }
    }
}

fn open_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(WINDOW) {
        let _ = window.set_focus();
        return;
    }
    let built = WebviewWindowBuilder::new(app, WINDOW, WebviewUrl::App("update.html".into()))
        .title("Software Update")
        .inner_size(440.0, 340.0)
        .resizable(false)
        .minimizable(false)
        .center()
        .build();

    match built {
        Ok(window) => {
            let app = app.clone();
            window.on_window_event(move |event| {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    // Closing mid-download would leave a half-written bundle with nobody watching
                    // the result, so the window refuses to go away until the bytes have landed.
                    let updater = app.state::<Updater>();
                    if matches!(updater.state(), State::Downloading { .. }) {
                        api.prevent_close();
                        return;
                    }
                    let _ = updater.apply(&app, Event::Dismiss);
                }
            });
            log::event("update", "window", "opened");
        }
        Err(e) => log::event("update", "window", &format!("failed to open: {e}")),
    }
}

fn close_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(WINDOW) {
        let _ = window.close();
    }
}

/// The window asks for the state as it loads: it may well be created after the transition that
/// caused it, and an event that fired before anyone was listening is an empty window.
#[tauri::command]
pub fn update_state(updater: tauri::State<'_, Updater>) -> State {
    updater.state()
}

#[tauri::command]
pub fn update_install(app: AppHandle) {
    tauri::async_runtime::spawn(install(app));
}

#[tauri::command]
pub fn update_check(app: AppHandle) {
    tauri::async_runtime::spawn(check(app, Trigger::Manual));
}

#[tauri::command]
pub fn update_skip(app: AppHandle) {
    let updater = app.state::<Updater>();
    if let State::Available { version, .. } = updater.state() {
        log::event("update", "skip", &version);
        updater.write_prefs(&Prefs {
            skipped_version: Some(version),
            ..updater.prefs()
        });
    }
    let _ = updater.apply(&app, Event::Dismiss);
    close_window(&app);
}

#[tauri::command]
pub fn update_dismiss(app: AppHandle) {
    let _ = app.state::<Updater>().apply(&app, Event::Dismiss);
    close_window(&app);
}

/// Restarts into the version that was just written to disk.
///
/// The sidecar must be reaped first. `restart()` replaces this process, and a backend left running
/// keeps the port it was given — the relaunched app then starts a second one and the two fight over
/// the same `$DSH_HOME`.
#[tauri::command]
pub fn update_restart(app: AppHandle) {
    log::event("update", "restart", "reaping the backend before relaunch");
    app.state::<Backend>().shutdown();
    app.restart();
}
