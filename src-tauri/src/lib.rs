//! dsh-desktop: wraps the official DeepSeek Harness web backend as a macOS desktop app.
//!
//! The shell does exactly three things: spawn the backend sidecar, navigate the webview to its
//! address, and reap it on exit. The interface is entirely dsh's own ui-* plugins; not a single
//! line of frontend logic is copied here. Self-updating is the one thing the shell adds on top, and
//! it lives entirely in native chrome (`menu.rs`, `update/`) for the same reason.

mod backend;
mod home;
mod lifecycle;
mod log;
mod menu;
mod update;

use tauri::{Manager, RunEvent, WindowEvent};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            update::update_state,
            update::update_check,
            update::update_install,
            update::update_skip,
            update::update_dismiss,
            update::update_restart,
        ])
        .setup(|app| {
            // Wire up file logging first: every later step in setup must be able to leave its failure reason behind.
            if let Ok(dir) = app.path().app_log_dir() {
                log::set_file(dir.join("dsh-desktop.jsonl"));
            }
            app.manage(backend::Backend::default());
            if let Err(reason) = backend::launch(app.handle()) {
                log::event("app", "launch-backend", &reason);
                // Deliberately not returning Err: the window must appear so the loading page can
                // show this reason to the user; exiting outright leaves an app that "does nothing
                // when double-clicked".
                backend::show_failure(app.handle(), &reason);
            }
            // Both of these are additions to a working app, never preconditions for one: a menu
            // that fails to build must not cost the user the app itself.
            if let Err(e) = menu::install(app.handle()) {
                log::event("app", "install-menu", &e.to_string());
            }
            update::init(app.handle());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build the Tauri application");

    app.run(|app, event| match event {
        // Closing the window means quitting the app: leaving a background process behind in a
        // single-window app only confuses the user. All three events must be handled — window
        // close, exit requested, and actual exit — since missing one leaks the process on that path.
        //
        // The label test is what keeps the update window out of it: that window closes on its own
        // whenever a check ends, and without the test every dismissed update notice would reap the
        // backend out from under a running session.
        RunEvent::WindowEvent {
            label,
            event: WindowEvent::CloseRequested { .. },
            ..
        } if label == backend::MAIN_WINDOW => {
            app.state::<backend::Backend>().shutdown();
        }
        RunEvent::ExitRequested { .. } | RunEvent::Exit => {
            app.state::<backend::Backend>().shutdown();
        }
        _ => {}
    });
}
