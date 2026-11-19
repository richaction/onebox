mod attachments;
mod development;
mod fs;
mod markdown;
mod office_preview;
mod workspace;
mod workspace_links;

#[cfg(target_os = "macos")]
use tauri::tray::{MouseButton, MouseButtonState, TrayIconEvent};

#[cfg(desktop)]
use tauri::Manager;

#[cfg(target_os = "macos")]
use tauri::{
    menu::{Menu, MenuItem, MenuItemKind},
    AppHandle,
};

#[cfg(target_os = "macos")]
const QUIT: &str = "onebox-quit";

#[cfg(target_os = "macos")]
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
    let builder = tauri::Builder::default();

    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _, _| {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
        }
    }));

    let builder = builder
        .manage(std::sync::Mutex::new(markdown::PendingDocument::default()))
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            development::remember_document,
            development::restore_document,
            development::focus_window,
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
            workspace::select_workspace_root,
            workspace::open_demo_workspace,
            workspace::restore_workspace_root,
            workspace::clear_workspace_root,
            workspace::create_workspace_entry,
            workspace::open_workspace_attachment,
            workspace::workspace_file_applications,
            workspace::workspace_file_application_icons,
            workspace::workspace_preview,
            workspace::workspace_office_preview,
            workspace::workspace_video_poster,
            workspace::workspace_entries,
            workspace::move_workspace_entry
        ]);

    #[cfg(target_os = "macos")]
    let builder = builder.menu(editor_menu).on_menu_event(|app, event| {
        if event.id() == QUIT {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.close();
            }
        }
    });

    #[cfg(target_os = "macos")]
    let builder = builder.on_tray_icon_event(|app, event| {
        if let TrayIconEvent::Click {
            button: MouseButton::Left,
            button_state: MouseButtonState::Up,
            ..
        } = event
        {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }
    });

    builder
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
