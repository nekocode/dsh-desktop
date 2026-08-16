//! When to check, and when to interrupt the user. Pure decisions over what is on disk.
//!
//! Kept apart from the network call so both rules can be tested without a server and without
//! waiting a day: an update policy that can only be verified by living through it is a policy
//! nobody ever verifies.

use serde::{Deserialize, Serialize};

/// How long an automatic check waits after the previous one.
///
/// A release is a manual, infrequent act; polling more often only spends the user's bandwidth on
/// an answer that has not changed. The menu item exists for anyone who wants to ask right now.
pub const CHECK_INTERVAL_MS: u64 = 24 * 60 * 60 * 1000;

/// What the user's past decisions left behind. Persisted verbatim; see `store.rs`.
///
/// `serde(default)` on purpose: a file written by an older build must keep loading when a field is
/// added, or an upgrade silently resets everyone's preferences.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Prefs {
    /// Milliseconds since the epoch. None means no check has ever completed.
    pub last_check_at: Option<u64>,
    /// A version the user asked never to be told about again.
    pub skipped_version: Option<String>,
}

/// What set a check in motion. The two differ in exactly one way: a manual check obeys no rules,
/// because the user is standing right there having just asked.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Trigger {
    Startup,
    Manual,
}

pub fn should_check(trigger: Trigger, prefs: &Prefs, now_ms: u64) -> bool {
    if trigger == Trigger::Manual {
        return true;
    }
    match prefs.last_check_at {
        None => true,
        // `saturating_sub` rather than a comparison: a timestamp in the future (clock corrected
        // backwards, a machine restored from a backup) would otherwise park the next check up to a
        // day out — or forever, if the skew is large. Treat it as "long enough ago".
        Some(last) => now_ms.saturating_sub(last) >= CHECK_INTERVAL_MS || now_ms < last,
    }
}

/// Whether a found version is worth opening a window for.
pub fn should_announce(trigger: Trigger, prefs: &Prefs, version: &str) -> bool {
    if trigger == Trigger::Manual {
        return true;
    }
    prefs.skipped_version.as_deref() != Some(version)
}

#[cfg(test)]
mod tests {
    use super::*;

    const DAY: u64 = CHECK_INTERVAL_MS;

    fn skipping(version: &str) -> Prefs {
        Prefs {
            skipped_version: Some(version.into()),
            ..Prefs::default()
        }
    }

    #[test]
    fn the_very_first_launch_checks() {
        assert!(should_check(Trigger::Startup, &Prefs::default(), 0));
    }

    #[test]
    fn a_check_within_the_day_is_skipped_but_the_next_day_is_not() {
        let prefs = Prefs {
            last_check_at: Some(1_000),
            ..Prefs::default()
        };
        assert!(!should_check(Trigger::Startup, &prefs, 1_000 + DAY - 1));
        assert!(should_check(Trigger::Startup, &prefs, 1_000 + DAY));
    }

    #[test]
    fn a_timestamp_from_the_future_does_not_park_checking_forever() {
        // A clock corrected backwards, or a machine restored from a backup, writes exactly this.
        let prefs = Prefs {
            last_check_at: Some(u64::MAX),
            ..Prefs::default()
        };
        assert!(should_check(Trigger::Startup, &prefs, 1_000));
    }

    #[test]
    fn asking_from_the_menu_ignores_the_throttle_because_the_user_just_asked() {
        let prefs = Prefs {
            last_check_at: Some(1_000),
            ..Prefs::default()
        };
        assert!(should_check(Trigger::Manual, &prefs, 1_001));
    }

    #[test]
    fn a_skipped_version_is_never_announced_on_its_own() {
        assert!(!should_announce(Trigger::Startup, &skipping("0.2.0"), "0.2.0"));
    }

    #[test]
    fn skipping_one_version_does_not_skip_the_next_one() {
        assert!(should_announce(Trigger::Startup, &skipping("0.2.0"), "0.3.0"));
    }

    #[test]
    fn a_manual_check_shows_even_a_skipped_version_or_the_menu_would_look_broken() {
        assert!(should_announce(Trigger::Manual, &skipping("0.2.0"), "0.2.0"));
    }

    #[test]
    fn a_missing_field_loads_as_none_so_an_older_file_keeps_working() {
        let prefs: Prefs = serde_json::from_str("{}").unwrap();
        assert_eq!(prefs, Prefs::default());
    }
}
