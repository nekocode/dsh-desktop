//! dsh-desktop: wraps the official DeepSeek Harness web backend as a macOS desktop app.
//!
//! The shell does exactly three things: spawn the backend sidecar, navigate the webview to its
//! address, and reap it on exit. The interface is entirely dsh's own ui-* plugins; not a single
//! line of frontend logic is copied here.

mod backend;
mod home;
mod lifecycle;
mod log;

use tauri::{Manager, RunEvent, WindowEvent};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
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
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build the Tauri application");

    app.run(|app, event| match event {
        // Closing the window means quitting the app: leaving a background process behind in a
        // single-window app only confuses the user. All three events must be handled — window
        // close, exit requested, and actual exit — since missing one leaks the process on that path.
        RunEvent::WindowEvent {
            event: WindowEvent::CloseRequested { .. },
            ..
        }
        | RunEvent::ExitRequested { .. }
        | RunEvent::Exit => {
            app.state::<backend::Backend>().shutdown();
        }
        _ => {}
    });
}
