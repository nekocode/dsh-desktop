//! State machine for the update flow.
//!
//! Same shape as `lifecycle.rs`: states enumerated exhaustively, legal transitions hard-coded into
//! a table, illegal ones returning an error rather than being ignored. Transitions are pure; the
//! network, the disk and the window live in `mod.rs`.
//!
//! The state is also the entire contract with `ui/update.html` — it is serialized and pushed to the
//! window on every transition, so the page renders a state instead of tracking its own copy of one.

use std::fmt;

use serde::Serialize;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(tag = "phase", rename_all = "camelCase")]
pub enum State {
    /// Nothing in flight and no window open.
    #[default]
    Idle,
    /// Asking the endpoint. Only a manual check ever shows this — a startup check stays invisible.
    Checking,
    /// The endpoint answered, and this build is already current.
    UpToDate,
    /// A newer version exists. `notes` is upstream's release body, possibly empty.
    Available { version: String, notes: String },
    /// Fetching the update. `total` stays None until the server discloses a content length.
    Downloading {
        version: String,
        downloaded: u64,
        total: Option<u64>,
    },
    /// Written to disk. The bundle on disk is already the new one; only a restart is left.
    Installed { version: String },
    /// Any failure along the way. Carries the reason, which the window shows verbatim.
    Failed { reason: String },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Event {
    /// A check was started, by the startup timer or from the menu.
    Check,
    /// The endpoint offered a newer version.
    Found { version: String, notes: String },
    /// The endpoint had nothing newer.
    NotFound,
    /// The user asked for the update to be installed.
    Install,
    /// One downloaded chunk. Carries the chunk, not the running total: accumulating here is what
    /// keeps the arithmetic inside the pure function and therefore under test.
    Progress { chunk: u64, total: Option<u64> },
    /// The bundle has been replaced on disk.
    Done,
    /// Anything went wrong.
    Failed { reason: String },
    /// The window was closed — by a button, or by the user closing it.
    Dismiss,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IllegalTransition {
    pub state: State,
    pub event: Event,
}

impl fmt::Display for IllegalTransition {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "illegal transition: {:?} received {:?}", self.state, self.event)
    }
}

/// `(state, event) -> new state`. A pair missing from the table is a bug: error, never ignore.
pub fn next(state: &State, event: Event) -> Result<State, IllegalTransition> {
    let moved = match (state, &event) {
        // A check may start from any settled state. Not from Downloading — a second check while
        // bytes are in flight would race two installs onto the same bundle. Not from Installed
        // either: the bundle on disk is already newer than the running process, so whatever the
        // endpoint answers would be compared against the wrong version.
        (State::Idle | State::UpToDate | State::Available { .. } | State::Failed { .. }, Event::Check) => {
            State::Checking
        }
        (State::Checking, Event::Found { version, notes }) => State::Available {
            version: version.clone(),
            notes: notes.clone(),
        },
        (State::Checking, Event::NotFound) => State::UpToDate,
        (State::Available { version, .. }, Event::Install) => State::Downloading {
            version: version.clone(),
            downloaded: 0,
            total: None,
        },
        // The running total lives here rather than in the caller's closure, so "did the bar move"
        // is answerable by a unit test instead of by watching a download.
        (
            State::Downloading {
                version, downloaded, ..
            },
            Event::Progress { chunk, total },
        ) => State::Downloading {
            version: version.clone(),
            downloaded: downloaded + chunk,
            total: *total,
        },
        (State::Downloading { version, .. }, Event::Done) => State::Installed {
            version: version.clone(),
        },
        (State::Checking | State::Downloading { .. }, Event::Failed { reason }) => State::Failed {
            reason: reason.clone(),
        },
        // Closing the window returns to rest. Downloading is the one state it cannot happen from:
        // the window refuses to close while bytes are in flight, because the alternative is a
        // half-written bundle nobody is watching.
        (
            State::Idle
            | State::Checking
            | State::UpToDate
            | State::Available { .. }
            | State::Installed { .. }
            | State::Failed { .. },
            Event::Dismiss,
        ) => State::Idle,
        _ => {
            return Err(IllegalTransition {
                state: state.clone(),
                event,
            })
        }
    };
    Ok(moved)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn available() -> State {
        State::Available {
            version: "0.2.0".into(),
            notes: "fixes".into(),
        }
    }

    fn downloading() -> State {
        State::Downloading {
            version: "0.2.0".into(),
            downloaded: 0,
            total: None,
        }
    }

    fn found() -> Event {
        Event::Found {
            version: "0.2.0".into(),
            notes: "fixes".into(),
        }
    }

    #[test]
    fn a_check_that_finds_something_carries_the_version_and_the_notes_through() {
        let s = next(&State::Idle, Event::Check).unwrap();
        assert_eq!(s, State::Checking);
        assert_eq!(next(&s, found()).unwrap(), available());
    }

    #[test]
    fn a_check_that_finds_nothing_lands_on_up_to_date_so_a_manual_check_can_say_so() {
        assert_eq!(next(&State::Checking, Event::NotFound).unwrap(), State::UpToDate);
    }

    #[test]
    fn installing_keeps_the_version_it_was_offered() {
        assert_eq!(next(&available(), Event::Install).unwrap(), downloading());
    }

    #[test]
    fn progress_accumulates_chunks_rather_than_replacing_the_total() {
        let s = next(
            &downloading(),
            Event::Progress {
                chunk: 100,
                total: Some(300),
            },
        )
        .unwrap();
        let s = next(
            &s,
            Event::Progress {
                chunk: 50,
                total: Some(300),
            },
        )
        .unwrap();
        assert_eq!(
            s,
            State::Downloading {
                version: "0.2.0".into(),
                downloaded: 150,
                total: Some(300),
            }
        );
    }

    #[test]
    fn finishing_a_download_reaches_installed_with_the_version_that_was_downloaded() {
        let s = next(&downloading(), Event::Done).unwrap();
        assert_eq!(
            s,
            State::Installed {
                version: "0.2.0".into()
            }
        );
    }

    #[test]
    fn a_failure_while_checking_or_downloading_carries_the_reason_to_the_window() {
        for from in [State::Checking, downloading()] {
            assert_eq!(
                next(
                    &from,
                    Event::Failed {
                        reason: "boom".into()
                    }
                )
                .unwrap(),
                State::Failed {
                    reason: "boom".into()
                }
            );
        }
    }

    #[test]
    fn dismissing_returns_to_rest_from_every_state_that_can_show_a_window() {
        for from in [
            State::Idle,
            State::Checking,
            State::UpToDate,
            available(),
            State::Installed {
                version: "0.2.0".into(),
            },
            State::Failed {
                reason: "boom".into(),
            },
        ] {
            assert_eq!(next(&from, Event::Dismiss).unwrap(), State::Idle);
        }
    }

    #[test]
    fn a_download_in_flight_cannot_be_dismissed_or_a_half_written_bundle_is_left_behind() {
        assert!(next(&downloading(), Event::Dismiss).is_err());
    }

    #[test]
    fn a_second_check_cannot_start_while_one_is_running_or_downloading() {
        assert!(next(&State::Checking, Event::Check).is_err());
        assert!(next(&downloading(), Event::Check).is_err());
    }

    #[test]
    fn no_check_after_install_because_the_bundle_on_disk_is_no_longer_the_running_version() {
        let installed = State::Installed {
            version: "0.2.0".into(),
        };
        assert!(next(&installed, Event::Check).is_err());
    }

    #[test]
    fn a_result_arriving_after_the_window_was_closed_is_rejected_rather_than_reopening_it() {
        // The user closed the "Checking…" window; the request was already in flight. Rejecting is
        // what stops a window from popping back up on its own.
        assert!(next(&State::Idle, found()).is_err());
        assert!(next(&State::Idle, Event::NotFound).is_err());
    }

    #[test]
    fn installing_is_impossible_without_an_offer_so_no_download_starts_from_nothing() {
        assert!(next(&State::Idle, Event::Install).is_err());
        assert!(next(&State::UpToDate, Event::Install).is_err());
    }

    #[test]
    fn illegal_transition_errors_name_both_sides_or_they_cannot_be_diagnosed() {
        let text = next(&State::Idle, Event::Install).unwrap_err().to_string();
        assert!(text.contains("Idle"), "{text}");
        assert!(text.contains("Install"), "{text}");
    }

    #[test]
    fn the_window_reads_a_phase_tag_so_serialization_must_carry_one() {
        let json = serde_json::to_string(&available()).unwrap();
        assert!(json.contains(r#""phase":"available""#), "{json}");
        assert!(json.contains(r#""version":"0.2.0""#), "{json}");
    }
}
