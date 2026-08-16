//! Persistence of the update preferences. The one place in this module that touches the disk.
//!
//! Deliberately not `tauri-plugin-store`: two numbers do not justify a dependency, a schema and a
//! JS-side API surface.

use std::fs;
use std::path::{Path, PathBuf};

use crate::log;

use super::policy::Prefs;

pub fn path(app_data: &Path) -> PathBuf {
    app_data.join("update.json")
}

/// Reads the preferences, falling back to defaults for anything unreadable.
///
/// Never returns an error: the worst a lost file can cost is one redundant check, while refusing to
/// start over a corrupt two-field JSON would cost the whole update flow. Both fallbacks are logged,
/// so "never written yet" and "written but unreadable" stay distinguishable.
pub fn load(path: &Path) -> Prefs {
    let text = match fs::read_to_string(path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Prefs::default(),
        Err(e) => {
            log::event("update", "load-prefs", &format!("unreadable, using defaults: {e}"));
            return Prefs::default();
        }
    };
    match serde_json::from_str(&text) {
        Ok(prefs) => prefs,
        Err(e) => {
            log::event("update", "load-prefs", &format!("corrupt, using defaults: {e}"));
            Prefs::default()
        }
    }
}

pub fn save(path: &Path, prefs: &Prefs) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    fs::write(path, serde_json::to_string(prefs)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("dsh-desktop-update-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn what_was_saved_is_what_is_loaded() {
        let file = temp("roundtrip").join("update.json");
        let prefs = Prefs {
            last_check_at: Some(1_700_000_000_000),
            skipped_version: Some("0.2.0".into()),
        };
        save(&file, &prefs).unwrap();
        assert_eq!(load(&file), prefs);
    }

    #[test]
    fn saving_creates_the_directory_because_the_first_save_may_precede_any_other_write() {
        let file = temp("mkdir").join("nested").join("update.json");
        save(&file, &Prefs::default()).unwrap();
        assert!(file.exists());
    }

    #[test]
    fn a_missing_file_is_the_first_launch_not_an_error() {
        assert_eq!(load(&temp("absent").join("update.json")), Prefs::default());
    }

    #[test]
    fn a_corrupt_file_degrades_to_defaults_rather_than_disabling_updates() {
        let file = temp("corrupt").join("update.json");
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(&file, "{not json").unwrap();
        assert_eq!(load(&file), Prefs::default());
    }

    #[test]
    fn prefs_live_next_to_the_rest_of_the_app_data_not_inside_the_dsh_home() {
        // `dsh-home` is seeded from the bundle and belongs to dsh; our own state must not land in it.
        let path = path(Path::new("/tmp/app-data"));
        assert_eq!(path, PathBuf::from("/tmp/app-data/update.json"));
    }
}
