//! Structured logging: who / what / when / result.
//!
//! When the desktop app crashes on a user's machine, these lines are all there is. Better verbose
//! than a bare "startup failed". JSON so that pipeline filters can consume it directly.
//!
//! Written to stderr and to a file at once: launched from Finder, stderr has nowhere to go and only
//! the on-disk copy is recoverable; launched from a terminal, stderr is the most immediate feedback.
//! Dropping either side leaves a blind spot.

use std::fs::{create_dir_all, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

static LOG_FILE: OnceLock<PathBuf> = OnceLock::new();

/// Sets the on-disk location. Call once after Tauri can resolve paths; without it, only stderr is written.
pub fn set_file(path: PathBuf) {
    let Some(dir) = path.parent() else { return };
    if create_dir_all(dir).is_ok() {
        let _ = LOG_FILE.set(path);
    }
}

pub fn event(who: &str, what: &str, result: &str) {
    let when = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let line = serde_json::json!({
        "who": who,
        "what": what,
        "when": when,
        "result": result,
    })
    .to_string();

    eprintln!("{line}");

    if let Some(path) = LOG_FILE.get() {
        // A logging failure must not take the app down with it; this is the only place silence is allowed.
        if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
            let _ = writeln!(file, "{line}");
        }
    }
}
