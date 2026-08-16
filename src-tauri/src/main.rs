// Suppresses the console window on Windows; a no-op on macOS, kept so going cross-platform later needs no revisit.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    dsh_desktop_lib::run()
}
