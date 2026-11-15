use std::{
    fs::{self, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
};
use tauri::AppHandle;
use tauri_plugin_fs::FsExt;

pub(crate) fn selected_path(app: &AppHandle, path: String) -> Result<PathBuf, String> {
    let path = PathBuf::from(path);
    if path.is_absolute() && app.fs_scope().is_allowed(&path) {
        Ok(path)
    } else {
        Err("file was not selected in a dialog".into())
    }
}

#[tauri::command]
pub async fn read_text(app: AppHandle, path: String) -> Result<String, String> {
    read_file(selected_path(&app, path)?)
        .await
        .map_err(|err| format!("read failed: {err}"))
}

#[tauri::command]
pub async fn write_text(app: AppHandle, path: String, content: String) -> Result<(), String> {
    let path = selected_path(&app, path)?;
    tokio::task::spawn_blocking(move || write_file(&path, &content))
        .await
        .map_err(|err| format!("write task failed: {err}"))?
        .map_err(|err| format!("write failed: {err}"))
}

pub(crate) async fn read_file(path: PathBuf) -> io::Result<String> {
    if !tokio::fs::metadata(&path).await?.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "expected a file",
        ));
    }
    tokio::fs::read_to_string(path).await
}

pub(crate) fn write_file(path: &Path, content: &str) -> io::Result<()> {
    let (target, permissions) = match fs::symlink_metadata(path) {
        Ok(_) => {
            let target = path.canonicalize()?;
            let metadata = target.metadata()?;
            if !metadata.is_file() {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "expected a file",
                ));
            }
            OpenOptions::new().write(true).open(&target)?;
            (target, Some(metadata.permissions()))
        }
        Err(err) if err.kind() == io::ErrorKind::NotFound => (path.to_owned(), None),
        Err(err) => return Err(err),
    };
    let parent = target
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "missing parent directory"))?;
    // Stage the entire write beside the destination so a failure leaves the old file intact.
    let mut staged = tempfile::NamedTempFile::new_in(parent)?;
    staged.write_all(content.as_bytes())?;
    if let Some(permissions) = permissions {
        staged.as_file().set_permissions(permissions)?;
    }
    staged.as_file().sync_all()?;
    staged.persist(target)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn round_trips_text() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("sample.md");
        write_file(&path, "# 标题\n").unwrap();
        assert_eq!(read_file(path.clone()).await.unwrap(), "# 标题\n");
        write_file(&path, "新的正文").unwrap();
        assert_eq!(read_file(path).await.unwrap(), "新的正文");
    }

    #[tokio::test]
    async fn missing_file_errors() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("missing.md");
        assert!(read_file(path).await.is_err());
    }
}
