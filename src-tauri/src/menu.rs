//! The application menu — the only place the update feature touches the app's chrome.
//!
//! The main window renders dsh's own web UI, which this project owns no line of. A native menu item
//! is therefore the only entry point that cannot break when upstream changes its markup, and the
//! only one that needs no cooperation from it.

use tauri::menu::{Menu, MenuItem};
use tauri::AppHandle;

use crate::log;
use crate::update;

/// Id the menu event is matched on. Kept next to the item so the two cannot drift apart.
const CHECK_FOR_UPDATES: &str = "check-for-updates";

/// Builds the platform's standard menu and adds one item to it.
///
/// Starting from `Menu::default` rather than composing a menu from scratch: the standard menu also
/// carries Edit (copy, paste, select-all) and Window, and a web UI without those is broken in ways
/// users report as "the app ate my clipboard".
pub fn install(app: &AppHandle) -> tauri::Result<()> {
    let check = MenuItem::with_id(app, CHECK_FOR_UPDATES, "Check for Updates…", true, None::<&str>)?;
    let menu = Menu::default(app)?;
    place(app, &menu, &check)?;
    app.set_menu(menu)?;

    app.on_menu_event(move |app, event| {
        if event.id() == CHECK_FOR_UPDATES {
            log::event("menu", "check-for-updates", "requested");
            let app = app.clone();
            tauri::async_runtime::spawn(update::check(app, update::Trigger::Manual));
        }
    });
    Ok(())
}

/// Where the item goes, which is the one thing that genuinely differs per platform.
#[cfg(target_os = "macos")]
fn place(app: &AppHandle, menu: &Menu<tauri::Wry>, check: &MenuItem<tauri::Wry>) -> tauri::Result<()> {
    use tauri::menu::{MenuItemKind, PredefinedMenuItem};

    // On macOS the first submenu is the application menu, and "Check for Updates…" belongs directly
    // under "About" — that is where every Mac user has looked for it for twenty years.
    let items = menu.items()?;
    let Some(MenuItemKind::Submenu(app_menu)) = items.first() else {
        // Not fatal: an app without the menu item still updates on its own schedule.
        log::event("menu", "place", "no application submenu; item not installed");
        return Ok(());
    };
    app_menu.insert(check, 1)?;
    app_menu.insert(&PredefinedMenuItem::separator(app)?, 2)?;
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn place(app: &AppHandle, menu: &Menu<tauri::Wry>, check: &MenuItem<tauri::Wry>) -> tauri::Result<()> {
    use tauri::menu::SubmenuBuilder;

    // Windows and Linux have no application menu, and their convention puts this under Help.
    let help = SubmenuBuilder::new(app, "Help").item(check).build()?;
    menu.append(&help)
}
