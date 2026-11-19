use crate::fs::{selected_path, write_file};
use std::path::PathBuf;
use tauri::{AppHandle, Manager};
use tauri_plugin_fs::FsExt;

fn preference(app: &AppHandle) -> Result<PathBuf, String> {
    if !cfg!(debug_assertions) {
        return Err("development commands require a debug build".into());
    }
    Ok(app
        .path()
        .app_config_dir()
        .map_err(|err| err.to_string())?
        .join("dev-document.json"))
}

#[tauri::command]
pub(crate) async fn remember_document(app: AppHandle, path: Option<String>) -> Result<(), String> {
    let settings = preference(&app)?;
    let path = path.map(|path| selected_path(&app, path)).transpose()?;
    tokio::task::spawn_blocking(move || {
        std::fs::create_dir_all(settings.parent().unwrap()).map_err(|err| err.to_string())?;
        let content = serde_json::to_string(&path).map_err(|err| err.to_string())?;
        write_file(&settings, &content).map_err(|err| err.to_string())
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
pub(crate) async fn restore_document(app: AppHandle) -> Result<Option<PathBuf>, String> {
    let settings = preference(&app)?;
    tokio::task::spawn_blocking(move || {
        let text = match std::fs::read_to_string(settings) {
            Ok(text) => text,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(err) => return Err(err.to_string()),
        };
        let path: Option<PathBuf> = serde_json::from_str(&text).map_err(|err| err.to_string())?;
        let Some(path) = path else { return Ok(None) };
        if !path.is_absolute() || !path.is_file() {
            return Ok(None);
        }
        app.fs_scope()
            .allow_file(&path)
            .map_err(|err| err.to_string())?;
        Ok(Some(path))
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
pub(crate) fn focus_window(app: AppHandle) -> Result<(), String> {
    if !cfg!(debug_assertions) {
        return Err("development commands require a debug build".into());
    }
    if let Some(window) = app.get_webview_window("main") {
        window.unminimize().map_err(|err| err.to_string())?;
        window.show().map_err(|err| err.to_string())?;
        window.set_focus().map_err(|err| err.to_string())?;
    }
    Ok(())
}
