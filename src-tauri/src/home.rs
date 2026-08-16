//! Preparation of `$DSH_HOME`.
//!
//! Uses the app's own Application Support directory and never touches a `~/.dsh` the user may
//! already have — our profile is trimmed, and sitting next to the full version installed by the CLI
//! the two would overwrite each other.
//!
//! The profile seed is written only where files are missing: once written, that `cordis.patch.yml`
//! belongs to the user, and plugin rows they add must not be wiped by an upgrade on the next launch.

use std::fs;
use std::path::{Path, PathBuf};

/// Profile name reserved for the desktop build.
pub const PROFILE: &str = "desktop";

pub fn home_dir(app_data: &Path) -> PathBuf {
    app_data.join("dsh-home")
}

/// Seeds `$DSH_HOME` from the bundled profile seed, never overwriting an existing file.
///
/// The seed directory itself is the single source of truth — no duplicate file list here. When the
/// build script adds another seed file this follows automatically; a hard-coded list would only
/// drift independently in two places across two languages.
///
/// Returns the names actually written, for logging — "wrote nothing" and "laid down a fresh copy"
/// are entirely different events, and startup diagnosis must be able to tell them apart.
pub fn seed_profile(home: &Path, seed_dir: &Path) -> std::io::Result<Vec<String>> {
    let target = home.join("profiles").join(PROFILE);
    fs::create_dir_all(&target)?;

    let mut written = Vec::new();
    let mut seen = 0usize;
    for entry in fs::read_dir(seed_dir)? {
        let entry = entry?;
        if !entry.file_type()?.is_file() {
            continue;
        }
        seen += 1;
        let name = entry.file_name();
        let dst = target.join(&name);
        if dst.exists() {
            continue;
        }
        fs::copy(entry.path(), &dst)?;
        written.push(name.to_string_lossy().into_owned());
    }
    if seen == 0 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            format!("the profile seed directory is empty: {}", seed_dir.display()),
        ));
    }
    Ok(written)
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE: [&str; 4] = [
        "package.json",
        "cordis.yml",
        "cordis.patch.yml",
        "pnpm-workspace.yaml",
    ];

    fn seed_fixture(dir: &Path) {
        fs::create_dir_all(dir).unwrap();
        for name in FIXTURE {
            fs::write(dir.join(name), format!("seed:{name}")).unwrap();
        }
    }

    fn temp(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("dsh-desktop-test-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn first_launch_lays_down_the_whole_seed() {
        let root = temp("first");
        let seed = root.join("seed");
        seed_fixture(&seed);
        let home = root.join("home");

        let written = seed_profile(&home, &seed).unwrap();
        assert_eq!(written.len(), FIXTURE.len());
        assert!(home.join("profiles/desktop/cordis.patch.yml").exists());
    }

    #[test]
    fn a_second_launch_does_not_overwrite_the_user_edited_patch_layer() {
        let root = temp("second");
        let seed = root.join("seed");
        seed_fixture(&seed);
        let home = root.join("home");

        seed_profile(&home, &seed).unwrap();
        let patch = home.join("profiles/desktop/cordis.patch.yml");
        fs::write(&patch, "- id: mine\n").unwrap();

        let written = seed_profile(&home, &seed).unwrap();
        assert!(written.is_empty());
        assert_eq!(fs::read_to_string(&patch).unwrap(), "- id: mine\n");
    }

    #[test]
    fn only_the_single_missing_file_is_restored() {
        let root = temp("partial");
        let seed = root.join("seed");
        seed_fixture(&seed);
        let home = root.join("home");

        seed_profile(&home, &seed).unwrap();
        fs::remove_file(home.join("profiles/desktop/package.json")).unwrap();

        assert_eq!(seed_profile(&home, &seed).unwrap(), vec!["package.json"]);
    }

    #[test]
    fn an_empty_seed_directory_errors_instead_of_laying_down_an_unusable_profile() {
        let root = temp("broken");
        let seed = root.join("seed");
        fs::create_dir_all(&seed).unwrap();

        let err = seed_profile(&root.join("home"), &seed).unwrap_err();
        assert!(err.to_string().contains("empty"), "{err}");
    }

    #[test]
    fn an_extra_seed_file_is_picked_up_automatically_without_code_changes() {
        let root = temp("extra");
        let seed = root.join("seed");
        seed_fixture(&seed);
        fs::write(seed.join("extra.yml"), "x").unwrap();

        let written = seed_profile(&root.join("home"), &seed).unwrap();
        assert!(written.contains(&"extra.yml".to_string()));
    }

    #[test]
    fn home_dir_never_lands_on_the_user_dsh_directory() {
        let dir = home_dir(Path::new("/tmp/app-data"));
        assert_eq!(dir, PathBuf::from("/tmp/app-data/dsh-home"));
    }
}
