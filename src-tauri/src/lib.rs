mod ai;
mod ai_network;
mod attachments;
mod development;
mod fs;
mod markdown;
mod workspace;
mod workspace_links;
mod wps_preview;

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

#[tauri::command]
async fn title_bar_button_center(window: tauri::WebviewWindow) -> Option<f64> {
    #[cfg(target_os = "macos")]
    {
        use objc2_app_kit::{NSView, NSWindow, NSWindowButton};
        use objc2_foundation::NSPoint;

        let (send, receive) = tokio::sync::oneshot::channel();
        window
            .with_webview(move |webview| {
                // Both handles are borrowed for the duration of the main-thread callback.
                let center = (|| {
                    let window = unsafe { webview.ns_window().cast::<NSWindow>().as_ref()? };
                    let view = unsafe { webview.inner().cast::<NSView>().as_ref()? };
                    let button = window.standardWindowButton(NSWindowButton::CloseButton)?;
                    if button.isHiddenOrHasHiddenAncestor() {
                        return None;
                    }
                    let bounds = button.bounds();
                    let midpoint = NSPoint::new(
                        bounds.origin.x + bounds.size.width / 2.0,
                        bounds.origin.y + bounds.size.height / 2.0,
                    );
                    let point = button.convertPoint_toView(midpoint, Some(view));
                    let bounds = view.bounds();
                    let y = point.y - bounds.origin.y;
                    Some(if view.isFlipped() { y } else { bounds.size.height - y })
                })();
                let _ = send.send(center);
            })
            .ok()?;
        receive.await.ok().flatten()
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = window;
        None
    }
}

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
        .manage(wps_preview::TemporaryPreviews::default())
        .manage(ai::Ai::default())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            title_bar_button_center,
            ai::ai_account,
            ai::ai_usage,
            ai::ai_models,
            ai::ai_network,
            ai::ai_set_proxy,
            ai::ai_login,
            ai::ai_cancel_login,
            ai::ai_logout,
            ai::ai_new_thread,
            ai::ai_start_turn,
            ai::ai_stop_turn,
            ai::ai_close_thread,
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
            workspace::trash_workspace_entry,
            workspace::open_workspace_attachment,
            workspace::reveal_workspace_location,
            workspace::workspace_file_applications,
            workspace::import_workspace_files,
            workspace::copy_workspace_file_to_clipboard,
            workspace::paste_workspace_clipboard,
            workspace::workspace_preview,
            workspace::release_workspace_preview,
            workspace::workspace_entries,
            workspace::rename_workspace_entry,
            workspace::copy_workspace_file,
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
