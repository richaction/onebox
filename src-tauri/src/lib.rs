mod attachments;
mod fs;
mod markdown;

#[cfg(any(target_os = "macos", target_os = "windows"))]
use tauri::{
    menu::{Menu, MenuItem, MenuItemKind},
    AppHandle, Manager,
};

#[cfg(any(target_os = "macos", target_os = "windows"))]
const QUIT: &str = "onebox-quit";

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn editor_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let menu = Menu::default(app)?;
    // Tauri's first submenu ends with the native Quit action. Route Quit through
    // CloseRequested so the webview can finish saving before the process exits.
    if let Some(MenuItemKind::Submenu(group)) = menu.items()?.first() {
        if let Some(native_quit) = group.items()?.last() {
            group.remove(native_quit)?;
            group.append(&MenuItem::with_id(
                app,
                QUIT,
                format!("Quit {}", app.package_info().name),
                true,
                Some("CmdOrCtrl+Q"),
            )?)?;
        }
    }
    Ok(menu)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .manage(std::sync::Mutex::new(markdown::PendingDocument::default()))
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            fs::read_text,
            fs::write_text,
            markdown::open_document,
            markdown::document_batch,
            markdown::release_document,
            attachments::import_attachment,
            attachments::import_inline_attachment,
            attachments::read_image,
            attachments::open_relative_attachment,
            attachments::plan_document_transfer,
            attachments::transfer_document,
            attachments::workspace_documents
        ]);

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    let builder = builder.menu(editor_menu).on_menu_event(|app, event| {
        if event.id() == QUIT {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.close();
            }
        }
    });

    builder
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
