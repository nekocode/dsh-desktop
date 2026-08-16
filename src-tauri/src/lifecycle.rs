//! Lifecycle state machine for the backend sidecar.
//!
//! States are enumerated exhaustively, legal transitions are hard-coded into a table, and illegal
//! transitions error out — no pile of bools conjuring invisible states like "starting but already
//! ready". Transitions are pure functions; side effects such as spawn / kill / navigation stay in
//! `backend.rs`.

use std::fmt;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub enum State {
    /// Not started yet, or already fully reaped.
    #[default]
    Stopped,
    /// The process has been spawned but has not printed its listening address yet.
    Starting,
    /// Serving at this address.
    Ready { url: String },
    /// Failed to start or died mid-flight. Carries the reason, which the UI shows to the user.
    Failed { reason: String },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Event {
    /// Start requested (first launch or a retry after failure).
    Launch,
    /// The process has been spawned and its handle is handed to the state machine.
    ///
    /// A self-transition that changes nothing — it exists so that taking the handle goes through
    /// the same lock. If the app shut down in the meantime the transition is illegal, and the
    /// caller uses that to kill the just-spawned process immediately.
    Attached,
    /// The listening address was parsed from stdout.
    Served { url: String },
    /// The process exited or startup timed out.
    Crashed { reason: String },
    /// The app is exiting; reap the process.
    Shutdown,
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

/// `(state, event) -> new state`. A combination absent from the table is a bug: error, never ignore.
pub fn next(state: &State, event: Event) -> Result<State, IllegalTransition> {
    let moved = match (state, &event) {
        // Cold start, and retry after a failure.
        (State::Stopped | State::Failed { .. }, Event::Launch) => State::Starting,
        // Storing the handle: the state is unchanged; the illegal side (already shut down) is the meaningful case.
        (State::Starting, Event::Attached) => State::Starting,
        // Only an address makes it ready.
        (State::Starting, Event::Served { url }) => State::Ready { url: url.clone() },
        // Whether it never starts or dies while running, both land in Failed.
        (State::Starting | State::Ready { .. }, Event::Crashed { reason }) => State::Failed {
            reason: reason.clone(),
        },
        // Any live state can be shut down; shutting down an already stopped one is idempotent.
        (_, Event::Shutdown) => State::Stopped,
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

    fn ready() -> State {
        State::Ready {
            url: "http://127.0.0.1:1234".into(),
        }
    }

    fn served() -> Event {
        Event::Served {
            url: "http://127.0.0.1:1234".into(),
        }
    }

    fn crashed() -> Event {
        Event::Crashed {
            reason: "boom".into(),
        }
    }

    #[test]
    fn attaching_the_handle_does_not_change_state() {
        assert_eq!(next(&State::Starting, Event::Attached).unwrap(), State::Starting);
    }

    #[test]
    fn attaching_after_shutdown_is_illegal_so_the_caller_kills_the_process() {
        assert!(next(&State::Stopped, Event::Attached).is_err());
        assert!(next(&ready(), Event::Attached).is_err());
    }

    #[test]
    fn cold_start_to_ready() {
        let s = next(&State::Stopped, Event::Launch).unwrap();
        assert_eq!(s, State::Starting);
        assert_eq!(next(&s, served()).unwrap(), ready());
    }

    #[test]
    fn crashing_while_starting_carries_the_reason_into_failed() {
        let s = next(&State::Starting, crashed()).unwrap();
        assert_eq!(
            s,
            State::Failed {
                reason: "boom".into()
            }
        );
    }

    #[test]
    fn crashing_after_ready_also_lands_in_failed() {
        assert!(matches!(next(&ready(), crashed()).unwrap(), State::Failed { .. }));
    }

    #[test]
    fn retry_is_allowed_after_failure() {
        let failed = State::Failed {
            reason: "boom".into(),
        };
        assert_eq!(next(&failed, Event::Launch).unwrap(), State::Starting);
    }

    #[test]
    fn shutdown_works_from_any_state_and_is_idempotent() {
        for s in [State::Stopped, State::Starting, ready(), State::Failed { reason: "x".into() }] {
            assert_eq!(next(&s, Event::Shutdown).unwrap(), State::Stopped);
        }
    }

    #[test]
    fn launching_twice_is_illegal_so_no_second_process_starts() {
        assert!(next(&State::Starting, Event::Launch).is_err());
        assert!(next(&ready(), Event::Launch).is_err());
    }

    #[test]
    fn an_address_without_a_launch_is_illegal() {
        assert!(next(&State::Stopped, served()).is_err());
        assert!(next(&ready(), served()).is_err());
    }

    #[test]
    fn a_crash_without_a_launch_is_illegal() {
        assert!(next(&State::Stopped, crashed()).is_err());
    }

    #[test]
    fn illegal_transition_errors_carry_state_and_event_or_they_cannot_be_diagnosed() {
        let err = next(&State::Stopped, served()).unwrap_err();
        let text = err.to_string();
        assert!(text.contains("Stopped"), "{text}");
        assert!(text.contains("Served"), "{text}");
    }
}
