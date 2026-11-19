use crate::{
    attachments::{copy_with_hash, document_name, normalize, relative_href, FILE_OPERATION},
    fs::{selected_path, write_file},
    workspace_links::{links, rebased_link, rewrite},
};
use serde::Serialize;
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, File, OpenOptions},
    io::{self, Read},
    path::{Component, Path, PathBuf},
};
use tauri::{ipc::Response, AppHandle, Manager};
use tauri_plugin_fs::FsExt;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceEntry {
    path: PathBuf,
    name: String,
    directory: bool,
    markdown: bool,
    accessible: bool,
}

#[derive(Serialize)]
pub(crate) struct WorkspaceRoot {
    root: PathBuf,
    entries: Vec<WorkspaceEntry>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceMove {
    destination: PathBuf,
    active_document: Option<PathBuf>,
}

fn workspace_path(root: &Path, real_root: &Path, path: &Path) -> Result<PathBuf, String> {
    let relative = path
        .strip_prefix(root)
        .map_err(|_| "路径不在当前工作区内")?;
    for part in relative.components() {
        if !matches!(part, Component::Normal(_)) {
            return Err("此路径不能在工作区内操作".into());
        }
    }
    let expected = real_root.join(relative);
    let actual = path
        .canonicalize()
        .map_err(|err| format!("无法访问路径：{err}"))?;
    if actual != expected {
        return Err("工作区操作需要实际路径，不能通过符号链接移动".into());
    }
    Ok(actual)
}

fn list_entries(path: &Path) -> io::Result<Vec<WorkspaceEntry>> {
    let mut entries = Vec::new();
    for entry in fs::read_dir(path)? {
        let entry = entry?;
        let Ok(name) = entry.file_name().into_string() else {
            continue;
        };
        let kind = entry.file_type()?;
        let path = entry.path();
        entries.push(WorkspaceEntry {
            markdown: kind.is_file() && document_name(&path),
            path,
            name,
            directory: kind.is_dir(),
            accessible: kind.is_dir() || kind.is_file(),
        });
    }
    entries.sort_by_cached_key(|entry| {
        (
            !entry.directory,
            entry.name.to_lowercase(),
            entry.name.clone(),
        )
    });
    Ok(entries)
}

fn workspace_preference(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_config_dir()
        .map_err(|err| err.to_string())?
        .join("workspace.json"))
}

fn remembered_root(settings: &Path) -> Result<Option<PathBuf>, String> {
    match fs::read_to_string(settings) {
        Ok(text) => serde_json::from_str(&text).map_err(|err| err.to_string()),
        Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(err.to_string()),
    }
}

fn remember_root(settings: &Path, root: Option<&Path>) -> Result<(), String> {
    fs::create_dir_all(settings.parent().unwrap()).map_err(|err| err.to_string())?;
    let text = serde_json::to_string(&root).map_err(|err| err.to_string())?;
    write_file(settings, &text).map_err(|err| err.to_string())
}

fn workspace_root(path: PathBuf) -> Result<WorkspaceRoot, String> {
    let entries = list_entries(&path).map_err(|err| format!("读取目录失败：{err}"))?;
    Ok(WorkspaceRoot {
        root: path,
        entries,
    })
}

#[tauri::command]
pub(crate) async fn select_workspace_root(
    app: AppHandle,
    path: String,
) -> Result<WorkspaceRoot, String> {
    let selected = selected_path(&app, path)?;
    activate_workspace(app, selected, false).await
}

#[tauri::command]
pub(crate) async fn open_demo_workspace(app: AppHandle) -> Result<WorkspaceRoot, String> {
    if !cfg!(debug_assertions) {
        return Err("调试样例仅在开发版提供".into());
    }
    let demo = app
        .path()
        .app_data_dir()
        .map_err(|err| err.to_string())?
        .join("Onebox 调试样例");
    activate_workspace(app, demo, true).await
}

fn copy_sample_files(from: &Path, to: &Path) -> io::Result<()> {
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let destination = to.join(entry.file_name());
        let kind = entry.file_type()?;
        if kind.is_dir() {
            fs::create_dir(&destination)?;
            copy_sample_files(&entry.path(), &destination)?;
        } else if kind.is_file() {
            fs::copy(entry.path(), destination)?;
        }
    }
    Ok(())
}

fn seed_demo_workspace(path: &Path) -> io::Result<()> {
    if path.exists() {
        return Ok(());
    }
    let seed = Path::new(env!("CARGO_MANIFEST_DIR")).join("../examples/manual-testing");
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::other("Missing sample directory parent"))?;
    fs::create_dir_all(parent)?;
    let staging = tempfile::tempdir_in(parent)?;
    copy_sample_files(&seed, staging.path())?;
    fs::rename(staging.path(), path)
}

async fn activate_workspace(
    app: AppHandle,
    selected: PathBuf,
    demo: bool,
) -> Result<WorkspaceRoot, String> {
    let settings = workspace_preference(&app)?;
    tokio::task::spawn_blocking(move || {
        let _locked = FILE_OPERATION.lock().map_err(|err| err.to_string())?;
        if demo {
            seed_demo_workspace(&selected).map_err(|err| format!("无法准备调试样例：{err}"))?;
        }
        let root = selected.canonicalize().map_err(|err| err.to_string())?;
        let workspace = workspace_root(root)?;
        app.fs_scope()
            .allow_directory(&workspace.root, true)
            .map_err(|err| err.to_string())?;
        remember_root(&settings, Some(&workspace.root))?;
        Ok(workspace)
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
pub(crate) async fn restore_workspace_root(
    app: AppHandle,
) -> Result<Option<WorkspaceRoot>, String> {
    let settings = workspace_preference(&app)?;
    tokio::task::spawn_blocking(move || {
        let _locked = FILE_OPERATION.lock().map_err(|err| err.to_string())?;
        let Some(root) = remembered_root(&settings)? else {
            return Ok(None);
        };
        if !root.is_absolute() || !root.canonicalize().is_ok_and(|resolved| resolved == root) {
            return Ok(None);
        }
        let workspace = workspace_root(root)?;
        app.fs_scope()
            .allow_directory(&workspace.root, true)
            .map_err(|err| err.to_string())?;
        Ok(Some(workspace))
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
pub(crate) async fn clear_workspace_root(app: AppHandle) -> Result<(), String> {
    let settings = workspace_preference(&app)?;
    tokio::task::spawn_blocking(move || {
        let _locked = FILE_OPERATION.lock().map_err(|err| err.to_string())?;
        remember_root(&settings, None)
    })
    .await
    .map_err(|err| err.to_string())?
}

fn create_entry(
    remembered: Option<&Path>,
    root: &Path,
    folder: &Path,
    name: &str,
    directory: bool,
) -> Result<WorkspaceEntry, String> {
    if remembered != Some(root) {
        return Err("请先打开一个工作区根目录".into());
    }
    let name = name.trim();
    if name.is_empty()
        || name.ends_with('.')
        || name
            .chars()
            .any(|ch| ch.is_control() || "\\/:*?\"<>|".contains(ch))
        || Path::new(name).file_name().and_then(|leaf| leaf.to_str()) != Some(name)
    {
        return Err("请输入有效的名称".into());
    }
    let real_root = root.canonicalize().map_err(|err| err.to_string())?;
    if real_root != root {
        return Err("工作区根目录已变化，请重新打开文件夹".into());
    }
    let parent = workspace_path(root, &real_root, folder)?;
    let name = if directory || document_name(Path::new(name)) {
        name.to_owned()
    } else {
        format!("{name}.md")
    };
    let path = parent.join(&name);
    let result = if directory {
        fs::create_dir(&path)
    } else {
        OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .map(drop)
    };
    result.map_err(|err| match err.kind() {
        io::ErrorKind::AlreadyExists => "这里已有同名文件或文件夹".into(),
        _ => format!("新建失败：{err}"),
    })?;
    Ok(WorkspaceEntry {
        path,
        name,
        directory,
        markdown: !directory,
        accessible: true,
    })
}

#[tauri::command]
pub(crate) async fn create_workspace_entry(
    app: AppHandle,
    root: String,
    folder: String,
    name: String,
    directory: bool,
) -> Result<WorkspaceEntry, String> {
    let settings = workspace_preference(&app)?;
    let root = selected_path(&app, root)?;
    let folder = selected_path(&app, folder)?;
    tokio::task::spawn_blocking(move || {
        let _locked = FILE_OPERATION.lock().map_err(|err| err.to_string())?;
        create_entry(
            remembered_root(&settings)?.as_deref(),
            &root,
            &folder,
            &name,
            directory,
        )
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
pub(crate) async fn open_workspace_attachment(
    app: AppHandle,
    root: String,
    path: String,
    application: Option<String>,
) -> Result<(), String> {
    let root = selected_path(&app, root)?;
    let entry = selected_path(&app, path)?;
    tokio::task::spawn_blocking(move || {
        let real_root = root.canonicalize().map_err(|err| err.to_string())?;
        let path = workspace_path(&root, &real_root, &entry)?;
        if !path.is_file() {
            return Err("请选择文件".into());
        }
        #[cfg(target_os = "macos")]
        if let Some(application) = application.as_deref() {
            if !objc2::rc::autoreleasepool(|_| {
                file_applications(&path)
                    .iter()
                    .any(|item| item.path == application)
            }) {
                return Err("该应用不在此文件的可用列表中".into());
            }
            return std::process::Command::new("/usr/bin/open")
                .arg("-a")
                .arg(application)
                .arg(&path)
                .status()
                .map_err(|err| err.to_string())?
                .success()
                .then_some(())
                .ok_or_else(|| "无法用所选应用打开".into());
        }
        #[cfg(not(target_os = "macos"))]
        let _ = application;
        open::that(path).map_err(|err| err.to_string())
    })
    .await
    .map_err(|err| err.to_string())?
}

#[derive(Serialize)]
pub(crate) struct FileApplication {
    path: String,
    name: String,
    default: bool,
}

#[cfg(target_os = "macos")]
fn file_applications(path: &Path) -> Vec<FileApplication> {
    use objc2_app_kit::NSWorkspace;
    use objc2_foundation::{NSBundle, NSFileManager, NSString, NSURL};

    let url = NSURL::fileURLWithPath(&NSString::from_str(&path.to_string_lossy()));
    let workspace = NSWorkspace::sharedWorkspace();
    let default_url = workspace.URLForApplicationToOpenURL(&url);
    let available = workspace.URLsForApplicationsToOpenURL(&url);
    let candidates = default_url
        .iter()
        .cloned()
        .chain(available.to_vec())
        .filter_map(|app| {
            let path = app.path()?.to_string();
            let display = NSFileManager::defaultManager()
                .displayNameAtPath(&NSString::from_str(&path))
                .to_string();
            let name = display.strip_suffix(".app").unwrap_or(&display).to_owned();
            let bundle = NSBundle::bundleWithURL(&app);
            let identity = bundle
                .as_ref()
                .and_then(|bundle| bundle.bundleIdentifier())
                .map(|id| id.to_string().to_lowercase());
            Some((
                identity,
                FileApplication {
                    path,
                    name,
                    default: default_url.as_deref() == Some(&*app),
                },
            ))
        })
        .collect();
    unique_file_applications(candidates)
}

#[cfg(target_os = "macos")]
fn unique_file_applications(
    mut candidates: Vec<(Option<String>, FileApplication)>,
) -> Vec<FileApplication> {
    // Prefer the default, then installed app bundles over nested helpers and temporary copies.
    candidates.sort_by_cached_key(|(_, app)| {
        let bundle_path = Path::new(&app.path);
        let installed = bundle_path
            .parent()
            .is_some_and(|parent| parent.ends_with("Applications"))
            && !app.path.contains(".app/")
            && !app.path.starts_with("/private/var/");
        (
            !app.default,
            !installed,
            app.name.to_lowercase(),
            app.path.clone(),
        )
    });
    let mut ids = BTreeSet::new();
    let mut names = BTreeSet::new();
    let mut applications = Vec::new();
    for (identity, app) in candidates {
        let name = app.name.trim().to_lowercase();
        if names.contains(&name) || identity.as_ref().is_some_and(|id| ids.contains(id)) {
            continue;
        }
        names.insert(name);
        ids.extend(identity);
        applications.push(app);
    }
    applications.sort_by_cached_key(|app| (!app.default, app.name.to_lowercase()));
    applications
}

#[cfg(target_os = "macos")]
fn file_application_icon(path: &str) -> Option<Vec<u8>> {
    use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSWorkspace};
    use objc2_foundation::{NSDictionary, NSString};

    let icon = NSWorkspace::sharedWorkspace().iconForFile(&NSString::from_str(path));
    let data = icon.TIFFRepresentation()?;
    let bitmap = NSBitmapImageRep::imageRepWithData(&data)?;
    // PNG encoding accepts an empty properties dictionary.
    let png = unsafe {
        bitmap.representationUsingType_properties(NSBitmapImageFileType::PNG, &NSDictionary::new())
    }?;
    let icon = image::load_from_memory(&png.to_vec())
        .ok()?
        .thumbnail_exact(36, 36);
    let mut encoded = io::Cursor::new(Vec::new());
    icon.write_to(&mut encoded, image::ImageFormat::Png).ok()?;
    Some(encoded.into_inner())
}

#[tauri::command]
pub(crate) async fn workspace_file_applications(
    app: AppHandle,
    root: String,
    path: String,
) -> Result<Vec<FileApplication>, String> {
    let root = selected_path(&app, root)?;
    let entry = selected_path(&app, path)?;
    tokio::task::spawn_blocking(move || {
        let real_root = root.canonicalize().map_err(|err| err.to_string())?;
        let path = workspace_path(&root, &real_root, &entry)?;
        if !path.is_file() {
            return Err("请选择文件".into());
        }
        #[cfg(target_os = "macos")]
        return Ok(objc2::rc::autoreleasepool(|_| file_applications(&path)));
        #[cfg(not(target_os = "macos"))]
        Ok(Vec::new())
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
pub(crate) async fn workspace_file_application_icons(
    app: AppHandle,
    root: String,
    path: String,
    applications: Vec<String>,
) -> Result<BTreeMap<String, Vec<u8>>, String> {
    let root = selected_path(&app, root)?;
    let entry = selected_path(&app, path)?;
    tokio::task::spawn_blocking(move || {
        let real_root = root.canonicalize().map_err(|err| err.to_string())?;
        let path = workspace_path(&root, &real_root, &entry)?;
        if !path.is_file() {
            return Err("请选择文件".into());
        }
        #[cfg(target_os = "macos")]
        return objc2::rc::autoreleasepool(|_| {
            use std::sync::{Mutex, OnceLock};
            static CACHE: OnceLock<Mutex<BTreeMap<String, Vec<u8>>>> = OnceLock::new();
            let allowed = file_applications(&path);
            let mut cache = CACHE
                .get_or_init(Default::default)
                .lock()
                .map_err(|err| err.to_string())?;
            let mut icons = BTreeMap::new();
            for application in allowed {
                if !applications.contains(&application.path) {
                    continue;
                }
                if let Some(icon) = cache.get(&application.path) {
                    icons.insert(application.path, icon.clone());
                } else if let Some(icon) = file_application_icon(&application.path) {
                    cache.insert(application.path.clone(), icon.clone());
                    icons.insert(application.path, icon);
                }
            }
            Ok(icons)
        });
        #[cfg(not(target_os = "macos"))]
        {
            let _ = applications;
            Ok(BTreeMap::new())
        }
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
pub(crate) async fn workspace_preview(
    app: AppHandle,
    root: String,
    path: String,
) -> Result<Response, String> {
    let settings = workspace_preference(&app)?;
    let root = selected_path(&app, root)?;
    let path = selected_path(&app, path)?;
    tokio::task::spawn_blocking(move || {
        let real_root = root.canonicalize().map_err(|err| err.to_string())?;
        if remembered_root(&settings)?.as_deref() != Some(real_root.as_path()) {
            return Err("请先打开此工作区".into());
        }
        let path = workspace_path(&root, &real_root, &path)?;
        if !path.is_file() {
            return Err("请选择普通文件".into());
        }
        let extension = path
            .extension()
            .and_then(|ext| ext.to_str())
            .unwrap_or_default();
        match extension.to_ascii_lowercase().as_str() {
            "txt" => {
                const LIMIT: u64 = 4 * 1024 * 1024;
                let mut bytes = Vec::new();
                File::open(path)
                    .and_then(|file| file.take(LIMIT + 1).read_to_end(&mut bytes))
                    .map_err(|err| err.to_string())?;
                Ok(Response::new(bytes))
            }
            "pdf" | "mp3" | "m4a" | "aac" | "wav" | "flac" | "ogg" | "opus" | "mp4" | "m4v"
            | "mov" | "webm" | "ogv" | "png" | "jpg" | "jpeg" | "gif" | "webp" | "avif" | "bmp"
            | "svg" | "ico" => {
                app.asset_protocol_scope()
                    .allow_file(&path)
                    .map_err(|err| err.to_string())?;
                Ok(Response::new(Vec::<u8>::new()))
            }
            _ => Err("此文件类型不支持预览".into()),
        }
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
pub(crate) async fn workspace_office_preview(
    app: AppHandle,
    root: String,
    path: String,
) -> Result<Response, String> {
    let settings = workspace_preference(&app)?;
    let root = selected_path(&app, root)?;
    let entry = selected_path(&app, path)?;
    let permit = crate::office_preview::CONVERTERS
        .try_acquire()
        .map_err(|_| "正在生成其他 Office 预览，请稍后重试")?;
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        let real_root = root.canonicalize().map_err(|err| err.to_string())?;
        if remembered_root(&settings)?.as_deref() != Some(real_root.as_path()) {
            return Err("请先打开此工作区".into());
        }
        let path = workspace_path(&root, &real_root, &entry)?;
        let extension = path
            .extension()
            .and_then(|ext| ext.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        if !matches!(
            extension.as_str(),
            "doc" | "docx" | "xls" | "xlsx" | "ppt" | "pptx"
        ) {
            return Err("请选择 Word、Excel 或 PowerPoint 文件".into());
        }
        crate::office_preview::render(&path, &extension).map(Response::new)
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
pub(crate) async fn workspace_video_poster(
    app: AppHandle,
    root: String,
    path: String,
) -> Result<Response, String> {
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, root, path);
        return Ok(Response::new(Vec::<u8>::new()));
    }
    #[cfg(target_os = "macos")]
    {
        let root = selected_path(&app, root)?;
        let entry = selected_path(&app, path)?;
        tokio::task::spawn_blocking(move || {
            let real_root = root.canonicalize().map_err(|err| err.to_string())?;
            let path = workspace_path(&root, &real_root, &entry)?;
            let extension = path
                .extension()
                .and_then(|ext| ext.to_str())
                .unwrap_or_default()
                .to_ascii_lowercase();
            if !path.is_file()
                || !matches!(extension.as_str(), "mp4" | "m4v" | "mov" | "webm" | "ogv")
            {
                return Err("请选择视频文件".into());
            }
            let temporary = tempfile::tempdir().map_err(|err| err.to_string())?;
            let result = std::process::Command::new("/usr/bin/qlmanage")
                .args(["-t", "-s", "640", "-o"])
                .arg(temporary.path())
                .arg(&path)
                .output()
                .map_err(|err| err.to_string())?;
            if !result.status.success() {
                return Ok(Response::new(Vec::<u8>::new()));
            }
            let mut name = path.file_name().ok_or("无效的视频文件名")?.to_os_string();
            name.push(".png");
            let bytes = fs::read(temporary.path().join(name)).unwrap_or_default();
            Ok(Response::new(bytes))
        })
        .await
        .map_err(|err| err.to_string())?
    }
}

#[tauri::command]
pub(crate) async fn workspace_entries(
    app: AppHandle,
    root: String,
    folder: String,
) -> Result<Vec<WorkspaceEntry>, String> {
    let root = selected_path(&app, root)?;
    let folder = selected_path(&app, folder)?;
    tokio::task::spawn_blocking(move || {
        let real_root = root.canonicalize().map_err(|err| err.to_string())?;
        workspace_path(&root, &real_root, &folder)?;
        list_entries(&folder).map_err(|err| format!("读取目录失败：{err}"))
    })
    .await
    .map_err(|err| err.to_string())?
}

struct Edit {
    before_path: PathBuf,
    after_path: PathBuf,
    before: String,
    after: String,
}

fn verify_edits(edits: &[Edit]) -> Result<(), String> {
    for edit in edits {
        let path = &edit.before_path;
        if fs::read_to_string(path).map_err(|err| err.to_string())? != edit.before {
            return Err(format!("文档已被其他程序修改：{}", path.display()));
        }
        OpenOptions::new()
            .write(true)
            .open(path)
            .map_err(|err| format!("无法写入 {}：{err}", path.display()))?;
    }
    Ok(())
}

fn replace_text(path: &Path, expected: &str, next: &str) -> Result<(), String> {
    if !fs::symlink_metadata(path).is_ok_and(|meta| meta.is_file())
        || fs::read_to_string(path).map_err(|err| err.to_string())? != expected
    {
        return Err(format!("文档已变化：{}", path.display()));
    }
    write_file(path, next).map_err(|err| format!("无法保存 {}：{err}", path.display()))
}

fn report_rollback(error: String, rollback: Result<(), String>) -> String {
    match rollback {
        Ok(()) => error,
        Err(err) => format!("{error}。恢复时遇到问题：{err}"),
    }
}

fn undo_edits(edits: &[Edit]) -> Result<(), String> {
    let mut first_error = None;
    for edit in edits.iter().rev() {
        if let Err(err) = replace_text(&edit.after_path, &edit.after, &edit.before) {
            first_error.get_or_insert(err);
        }
    }
    first_error.map_or(Ok(()), Err)
}

fn apply_edits(edits: &[Edit]) -> Result<(), String> {
    for (index, edit) in edits.iter().enumerate() {
        if let Err(err) = replace_text(&edit.after_path, &edit.before, &edit.after) {
            return Err(report_rollback(err, undo_edits(&edits[..index])));
        }
    }
    Ok(())
}

fn moved_path(path: &Path, moves: &BTreeMap<PathBuf, PathBuf>) -> Option<PathBuf> {
    path.ancestors().find_map(|source| {
        let destination = moves.get(source)?;
        Some(if path == source {
            destination.clone()
        } else {
            destination.join(path.strip_prefix(source).unwrap())
        })
    })
}

fn related_edits(root: &Path, moves: &BTreeMap<PathBuf, PathBuf>) -> Result<Vec<Edit>, String> {
    let mut folders = vec![root.to_owned()];
    let mut edits = Vec::new();
    while let Some(folder) = folders.pop() {
        for entry in
            list_entries(&folder).map_err(|err| format!("无法扫描 {}：{err}", folder.display()))?
        {
            let before_path = entry.path;
            if entry.directory {
                folders.push(before_path);
                continue;
            }
            if !entry.markdown {
                continue;
            }
            let after_path = moved_path(&before_path, moves).unwrap_or_else(|| before_path.clone());
            // A file with invalid UTF-8 cannot contain normal Markdown destinations.
            let before = match fs::read_to_string(&before_path) {
                Ok(text) => text,
                Err(err) if err.kind() == io::ErrorKind::InvalidData => continue,
                Err(err) => return Err(format!("无法读取 {}：{err}", before_path.display())),
            };
            if !before.contains('[') {
                continue;
            }
            let after = rewrite(&before, &links(&before), |href| {
                rebased_link(href, &folder, after_path.parent().unwrap(), |path| {
                    moved_path(path, moves)
                })
            })?;
            if let Some(after) = after {
                edits.push(Edit {
                    before_path,
                    after_path,
                    before,
                    after,
                });
            }
        }
    }
    verify_edits(&edits)?;
    Ok(edits)
}

fn ensure_absent(path: &Path) -> io::Result<()> {
    match fs::symlink_metadata(path) {
        Ok(_) => Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            "目标已存在同名文件或文件夹",
        )),
        Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(err),
    }
}

fn rename_noclobber(from: &Path, to: &Path) -> io::Result<()> {
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        use rustix::fs::{renameat_with, RenameFlags, CWD};
        renameat_with(CWD, from, CWD, to, RenameFlags::NOREPLACE).map_err(Into::into)
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        ensure_absent(to)?;
        fs::rename(from, to)
    }
}

#[derive(PartialEq, Eq)]
enum TreeEntry {
    Directory,
    File(String),
    Link(PathBuf),
}

fn copy_link(target: &Path, link: &Path, _kind: fs::FileType) -> io::Result<()> {
    #[cfg(unix)]
    return std::os::unix::fs::symlink(target, link);
    #[cfg(windows)]
    {
        use std::os::windows::fs::FileTypeExt;
        if _kind.is_symlink_dir() {
            std::os::windows::fs::symlink_dir(target, link)
        } else {
            std::os::windows::fs::symlink_file(target, link)
        }
    }
}

fn snapshot_tree(
    root: &Path,
    copy_to: Option<&Path>,
) -> Result<BTreeMap<PathBuf, TreeEntry>, String> {
    let mut entries = BTreeMap::new();
    let mut pending = vec![PathBuf::new()];
    let mut copied_folders = Vec::new();
    while let Some(relative) = pending.pop() {
        let from = root.join(&relative);
        let metadata = fs::symlink_metadata(&from).map_err(|err| err.to_string())?;
        let kind = metadata.file_type();
        let to = copy_to.map(|base| base.join(&relative));
        let entry = if kind.is_dir() {
            if let Some(to) = to {
                fs::create_dir(&to).map_err(|err| err.to_string())?;
                copied_folders.push((to, metadata.permissions()));
            }
            for entry in fs::read_dir(&from).map_err(|err| err.to_string())? {
                pending.push(relative.join(entry.map_err(|err| err.to_string())?.file_name()));
            }
            TreeEntry::Directory
        } else if kind.is_symlink() {
            let target = fs::read_link(&from).map_err(|err| err.to_string())?;
            if let Some(to) = to {
                copy_link(&target, &to, kind).map_err(|err| err.to_string())?;
            }
            TreeEntry::Link(target)
        } else if kind.is_file() {
            let file = File::open(&from).map_err(|err| err.to_string())?;
            let hash = if let Some(to) = to {
                let copy = OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&to)
                    .map_err(|err| err.to_string())?;
                let hash = copy_with_hash(file, &copy)?;
                copy.set_permissions(metadata.permissions())
                    .map_err(|err| err.to_string())?;
                copy.sync_all().map_err(|err| err.to_string())?;
                hash
            } else {
                copy_with_hash(file, io::sink())?
            };
            TreeEntry::File(hash)
        } else {
            return Err(format!("不支持跨卷移动此文件类型：{}", from.display()));
        };
        entries.insert(relative, entry);
    }
    for (dir, permissions) in copied_folders.into_iter().rev() {
        fs::set_permissions(dir, permissions).map_err(|err| err.to_string())?;
    }
    Ok(entries)
}

fn cross_volume_move(source: &Path, destination: &Path, edits: &[Edit]) -> Result<(), String> {
    let staging = tempfile::Builder::new()
        .prefix(".onebox-move-")
        .tempdir_in(destination.parent().unwrap())
        .map_err(|err| err.to_string())?;
    let retirement = tempfile::Builder::new()
        .prefix(".onebox-move-")
        .tempdir_in(source.parent().unwrap())
        .map_err(|err| err.to_string())?;
    let staged = staging.path().join("folder");
    let snapshot = snapshot_tree(source, Some(&staged))?;
    if snapshot_tree(source, None)? != snapshot {
        return Err("源文件夹在复制时发生变化，请重试".into());
    }
    verify_edits(edits)?;
    rename_noclobber(&staged, destination).map_err(|err| err.to_string())?;
    let result = apply_edits(edits).and_then(|()| {
        let retire = (|| {
            if snapshot_tree(source, None)? != snapshot {
                return Err("源文件夹在提交前发生变化，请重试".into());
            }
            rename_noclobber(source, &retirement.path().join("original"))
                .map_err(|err| err.to_string())
        })();
        retire.map_err(|err| report_rollback(err, undo_edits(edits)))
    });
    result.map_err(|err| {
        report_rollback(
            err,
            rename_noclobber(destination, &staged).map_err(|err| err.to_string()),
        )
    })
}

fn move_directory(source: &Path, destination: &Path, edits: &[Edit]) -> Result<(), String> {
    match rename_noclobber(source, destination) {
        Ok(()) => apply_edits(edits).map_err(|err| {
            report_rollback(
                err,
                rename_noclobber(destination, source).map_err(|err| err.to_string()),
            )
        }),
        Err(err) if err.kind() == io::ErrorKind::CrossesDevices => {
            cross_volume_move(source, destination, edits)
        }
        Err(err) => Err(format!("无法移动文件夹：{err}")),
    }
}

fn companion_destination(
    desired: PathBuf,
    directory: bool,
    moves: &BTreeMap<PathBuf, PathBuf>,
) -> Result<PathBuf, String> {
    let mut candidate = desired.clone();
    let mut index = 2;
    loop {
        match ensure_absent(&candidate) {
            Ok(()) if !moves.values().any(|path| *path == candidate) => return Ok(candidate),
            Ok(()) => {}
            Err(err) if err.kind() == io::ErrorKind::AlreadyExists && !directory => {}
            Err(err) => return Err(format!("{}：{err}", candidate.display())),
        }
        let stem = desired.file_stem().unwrap().to_string_lossy();
        let mut name = format!("{stem}-{index}");
        if let Some(ext) = desired.extension() {
            name.push('.');
            name.push_str(&ext.to_string_lossy());
        }
        candidate = desired.with_file_name(name);
        index += 1;
    }
}

fn plan_companions(
    source: &Path,
    destination: &Path,
    text: &str,
    moves: &mut BTreeMap<PathBuf, PathBuf>,
) -> Result<(), String> {
    let from = source.parent().unwrap();
    let to = destination.parent().unwrap();
    if from == to {
        return Ok(());
    }
    let companions: BTreeSet<_> = links(text)
        .into_iter()
        .filter_map(|link| {
            let (path, _) = relative_href(&link.href)?;
            Some(normalize(&from.join(path)))
        })
        .collect();
    for companion in companions {
        if companion == from
            || !companion.starts_with(from)
            || to.starts_with(&companion)
            || (to.starts_with(from) && companion.starts_with(to))
            || moved_path(&companion, moves).is_some()
        {
            continue;
        }
        let kind = match fs::symlink_metadata(&companion) {
            Ok(metadata) => metadata.file_type(),
            Err(err) if err.kind() == io::ErrorKind::NotFound => continue,
            Err(err) => return Err(format!("无法读取 {}：{err}", companion.display())),
        };
        if !(kind.is_dir() || (kind.is_file() && !document_name(&companion)))
            || !companion.canonicalize().is_ok_and(|path| path == companion)
        {
            continue;
        }
        let desired = to.join(companion.strip_prefix(from).unwrap());
        let target = companion_destination(desired, kind.is_dir(), moves)?;
        moves.insert(companion, target);
    }
    Ok(())
}

fn prepare_parent(root: &Path, parent: &Path, created: &mut Vec<PathBuf>) -> Result<(), String> {
    match fs::symlink_metadata(parent) {
        Ok(meta) if meta.is_dir() => workspace_path(root, root, parent).map(drop),
        Ok(_) => Err(format!("目标路径不是普通文件夹：{}", parent.display())),
        Err(err) if err.kind() == io::ErrorKind::NotFound => {
            prepare_parent(root, parent.parent().ok_or("无效的目标路径")?, created)?;
            fs::create_dir(parent).map_err(|err| err.to_string())?;
            created.push(parent.to_owned());
            Ok(())
        }
        Err(err) => Err(err.to_string()),
    }
}

fn move_paths(
    root: &Path,
    moves: &BTreeMap<PathBuf, PathBuf>,
    edits: &[Edit],
) -> Result<(), String> {
    let mut completed = Vec::new();
    let mut created = Vec::new();
    let result = (|| {
        for (source, destination) in moves {
            workspace_path(root, root, source)?;
            prepare_parent(root, destination.parent().unwrap(), &mut created)?;
            move_directory(source, destination, &[])?;
            completed.push((source, destination));
        }
        apply_edits(edits)
    })();
    result.map_err(|mut err| {
        for (source, destination) in completed.into_iter().rev() {
            err = report_rollback(err, move_directory(destination, source, &[]));
        }
        for parent in created.into_iter().rev() {
            err = report_rollback(err, fs::remove_dir(parent).map_err(|err| err.to_string()));
        }
        err
    })
}

fn move_entry(
    root: &Path,
    real_root: &Path,
    source: &Path,
    target: &Path,
    name: Option<&str>,
    active_document: Option<&Path>,
) -> Result<WorkspaceMove, String> {
    let _locked = FILE_OPERATION.lock().map_err(|err| err.to_string())?;
    let source = workspace_path(root, real_root, source)?;
    let target = workspace_path(root, real_root, target)?;
    if source == real_root || !target.is_dir() {
        return Err("请选择工作区内的目标文件夹".into());
    }
    let kind = fs::symlink_metadata(&source)
        .map_err(|err| err.to_string())?
        .file_type();
    if !kind.is_dir() && !kind.is_file() {
        return Err("只能移动文件夹或普通文件".into());
    }
    if target.starts_with(&source) {
        return Err("不能将文件夹移动到自身或其子目录".into());
    }
    let destination = match name {
        None => target.join(source.file_name().unwrap()),
        Some(name) => {
            let leaf = Path::new(name);
            if kind.is_dir() || leaf.file_name() != Some(leaf.as_os_str()) || !document_name(leaf) {
                return Err("请选择有效的 Markdown 文件名".into());
            }
            target.join(leaf)
        }
    };
    let display = |path: &Path| root.join(path.strip_prefix(real_root).unwrap());
    if source == destination {
        return Ok(WorkspaceMove {
            destination: display(&destination),
            active_document: None,
        });
    }
    ensure_absent(&destination).map_err(|err| err.to_string())?;
    let active = active_document.and_then(|path| path.canonicalize().ok());
    let mut moves = BTreeMap::from([(source.clone(), destination.clone())]);
    let source_text = if kind.is_file() && document_name(&source) {
        let text =
            fs::read_to_string(&source).map_err(|err| format!("无法读取 Markdown：{err}"))?;
        plan_companions(&source, &destination, &text, &mut moves)?;
        Some(text)
    } else {
        None
    };
    let edits = related_edits(real_root, &moves)?;
    if let Some(text) = source_text {
        if fs::read_to_string(&source).map_err(|err| err.to_string())? != text {
            return Err("源文档已被其他程序修改，请重试".into());
        }
    }
    let active_document = active
        .as_deref()
        .and_then(|path| {
            moved_path(path, &moves).or_else(|| {
                edits
                    .iter()
                    .find(|edit| edit.before_path == path)
                    .map(|edit| edit.after_path.clone())
            })
        })
        .as_deref()
        .map(display);

    move_paths(real_root, &moves, &edits)?;
    Ok(WorkspaceMove {
        destination: display(&destination),
        active_document,
    })
}

#[tauri::command]
pub(crate) async fn move_workspace_entry(
    app: AppHandle,
    root: String,
    source: String,
    target: String,
    name: Option<String>,
    active_document: Option<String>,
) -> Result<WorkspaceMove, String> {
    let root = selected_path(&app, root)?;
    let source = selected_path(&app, source)?;
    let target = selected_path(&app, target)?;
    let active = active_document.and_then(|path| selected_path(&app, path).ok());
    tokio::task::spawn_blocking(move || {
        let real_root = root.canonicalize().map_err(|err| err.to_string())?;
        move_entry(
            &root,
            &real_root,
            &source,
            &target,
            name.as_deref(),
            active.as_deref(),
        )
    })
    .await
    .map_err(|err| err.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_os = "macos")]
    #[test]
    fn open_with_supplies_a_drawn_application_icon() {
        objc2::rc::autoreleasepool(|_| {
            let png = file_application_icon("/System/Applications/TextEdit.app").unwrap();
            let image = image::load_from_memory(&png).unwrap().into_rgba8();
            assert_eq!((image.width(), image.height()), (36, 36));
            assert!(image.pixels().any(|pixel| pixel[3] > 64));
        });
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn open_with_keeps_the_default_and_one_representative_of_each_app() {
        let app = |identity: &str, path: &str, name: &str, default| {
            (
                Some(identity.into()),
                FileApplication {
                    path: path.into(),
                    name: name.into(),
                    default,
                },
            )
        };
        let applications = unique_file_applications(vec![
            app(
                "com.example.work.helper",
                "/tmp/WorkBuddy.app",
                "WorkBuddy",
                false,
            ),
            app(
                "com.example.work",
                "/Applications/WorkBuddy.app",
                "WorkBuddy",
                false,
            ),
            app(
                "com.example.work",
                "/tmp/WorkBuddy Beta.app",
                "WorkBuddy Beta",
                false,
            ),
            app(
                "com.example.editor",
                "/System/Applications/Editor.app",
                "Editor",
                true,
            ),
            app(
                "com.example.editor",
                "/Applications/Editor.app",
                "Editor",
                false,
            ),
        ]);
        assert_eq!(
            applications
                .iter()
                .map(|app| app.path.as_str())
                .collect::<Vec<_>>(),
            vec![
                "/System/Applications/Editor.app",
                "/Applications/WorkBuddy.app",
            ]
        );
    }

    fn fixture() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir.path().join("起点/assets")).unwrap();
        fs::create_dir_all(dir.path().join("目标/子目录/assets")).unwrap();
        dir
    }

    fn move_at(
        root: &Path,
        source: &str,
        target: &str,
        active: Option<&str>,
    ) -> Result<WorkspaceMove, String> {
        let real_root = root.canonicalize().unwrap();
        move_entry(
            root,
            &real_root,
            &root.join(source),
            &root.join(target),
            None,
            active.map(|path| root.join(path)).as_deref(),
        )
    }

    #[test]
    fn a_directory_query_is_shallow_and_includes_assets_and_dotfiles() {
        let dir = fixture();
        let root = dir.path();
        fs::write(root.join("首页.markdown"), "Home").unwrap();
        fs::write(root.join("附件.pdf"), b"PDF").unwrap();
        fs::write(root.join("起点/Note.md"), "Nested").unwrap();
        fs::create_dir(root.join(".hidden")).unwrap();
        fs::write(root.join(".hidden/.note.md"), "Hidden note").unwrap();
        let root_entries = list_entries(root).unwrap();
        assert_eq!(root_entries.len(), 5);
        assert!(root_entries[..3].iter().all(|entry| entry.directory));
        assert!(root_entries.iter().any(|entry| entry.name == ".hidden"));
        assert!(list_entries(&root.join(".hidden")).unwrap()[0].markdown);
        assert!(root_entries
            .iter()
            .any(|entry| entry.name == "首页.markdown" && entry.markdown));
        assert!(root_entries
            .iter()
            .any(|entry| entry.name == "附件.pdf" && !entry.markdown && !entry.directory));
        let source = list_entries(&root.join("起点")).unwrap();
        assert_eq!(source.len(), 2);
        assert_eq!(source[0].name, "assets");
        assert_eq!(source[1].name, "Note.md");
    }

    #[test]
    fn starts_without_a_root_and_only_restores_the_last_saved_choice() {
        let temp = tempfile::tempdir().unwrap();
        let settings = temp.path().join("settings/workspace.json");
        assert_eq!(remembered_root(&settings).unwrap(), None);
        let root = temp.path().canonicalize().unwrap();
        remember_root(&settings, Some(&root)).unwrap();
        assert_eq!(
            remembered_root(&settings).unwrap().as_deref(),
            Some(root.as_path())
        );
        remember_root(&settings, None).unwrap();
        assert_eq!(remembered_root(&settings).unwrap(), None);
    }

    #[test]
    fn creates_entries_only_under_the_selected_root_without_overwriting() {
        let dir = fixture();
        let root = dir.path().canonicalize().unwrap();
        let nested = root.join("起点");
        let parent = root.parent().unwrap();
        assert!(create_entry(None, &root, &root, "新笔记", false).is_err());
        assert!(create_entry(Some(&root), &root, parent, "新笔记", false).is_err());
        assert!(create_entry(Some(&root), &root, &nested, ".dotted", true).is_ok());
        assert!(create_entry(Some(&root), &root, &nested, "../旁路", false).is_err());

        let folder = create_entry(Some(&root), &root, &nested, "子项目", true).unwrap();
        assert!(folder.directory && folder.path.is_dir());
        let note = create_entry(Some(&root), &root, &folder.path, "新笔记", false).unwrap();
        assert!(note.markdown);
        assert_eq!(note.name, "新笔记.md");
        fs::write(&note.path, "first edit").unwrap();
        assert!(create_entry(Some(&root), &root, &folder.path, "新笔记.md", false).is_err());
        assert_eq!(fs::read_to_string(note.path).unwrap(), "first edit");
    }

    #[test]
    fn moves_referenced_files_and_updates_links_verbatim_at_both_locations() {
        let dir = fixture();
        let root = dir.path();
        fs::write(root.join("起点/assets/图 一.png"), b"same picture").unwrap();
        fs::write(root.join("起点/assets/also.png"), b"same picture").unwrap();
        fs::write(root.join("起点/assets/report.pdf"), b"source report").unwrap();
        fs::write(root.join("起点/assets/unrelated.pdf"), b"unrelated").unwrap();
        fs::write(
            root.join("目标/子目录/assets/existing image.png"),
            b"same picture",
        )
        .unwrap();
        fs::write(
            root.join("目标/子目录/assets/report.pdf"),
            b"different report",
        )
        .unwrap();
        fs::write(root.join("起点/Guide.md"), "# Guide").unwrap();
        let before = concat!(
            "#  Note\r\n\r\n",
            "![Reference][image] and ![Other](./assets/also.png)\r\n\r\n",
            "[image]: <assets/%E5%9B%BE%20%E4%B8%80.png> \"title\"\r\n\r\n",
            "[PDF](assets/report.pdf?mode=open#page=2) and [Guide](./Guide.md#intro).\r\n",
            "`![Example](assets/also.png)`\r\n",
        );
        fs::write(root.join("起点/Note.md"), before).unwrap();
        fs::write(
            root.join("Home.md"),
            "[go](起点/Note.md#h) [image](起点/assets/also.png)",
        )
        .unwrap();

        let result = move_at(root, "起点/Note.md", "目标/子目录", Some("Home.md")).unwrap();
        assert_eq!(result.destination, root.join("目标/子目录/Note.md"));
        assert_eq!(result.active_document, Some(root.join("Home.md")));
        assert!(!root.join("起点/Note.md").exists());
        let actual = fs::read_to_string(result.destination).unwrap();
        let expected = before
            .replace("assets/report.pdf?", "assets/report-2.pdf?")
            .replace("./Guide.md", "../../%E8%B5%B7%E7%82%B9/Guide.md");
        assert_eq!(actual, expected);
        assert_eq!(
            fs::read_dir(root.join("目标/子目录/assets"))
                .unwrap()
                .count(),
            5
        );
        assert_eq!(
            fs::read(root.join("目标/子目录/assets/report-2.pdf")).unwrap(),
            b"source report"
        );
        assert_eq!(
            fs::read(root.join("目标/子目录/assets/report.pdf")).unwrap(),
            b"different report"
        );
        assert_eq!(
            fs::read(root.join("目标/子目录/assets/also.png")).unwrap(),
            b"same picture"
        );
        assert!(!root.join("起点/assets/also.png").exists());
        assert!(root.join("起点/assets/unrelated.pdf").exists());
        assert_eq!(fs::read_to_string(root.join("Home.md")).unwrap(),
            "[go](%E7%9B%AE%E6%A0%87/%E5%AD%90%E7%9B%AE%E5%BD%95/Note.md#h) [image](%E7%9B%AE%E6%A0%87/%E5%AD%90%E7%9B%AE%E5%BD%95/assets/also.png)");
    }

    #[test]
    fn moves_linked_folders_with_their_contents_and_rebases_nested_markdown() {
        let dir = fixture();
        let root = dir.path();
        fs::create_dir(root.join("起点/.materials")).unwrap();
        fs::write(root.join("起点/Note.md"), "[folder](.materials/)\n").unwrap();
        fs::write(root.join("起点/.materials/raw.txt"), "unlisted content").unwrap();
        fs::write(
            root.join("起点/.materials/Child.md"),
            "[home](../../Home.md)",
        )
        .unwrap();
        fs::write(root.join("Home.md"), "[raw](起点/.materials/raw.txt#part)").unwrap();

        let result = move_at(
            root,
            "起点/Note.md",
            "目标/子目录",
            Some("起点/.materials/Child.md"),
        )
        .unwrap();
        let target = root.join("目标/子目录");
        let child = target.join(".materials/Child.md");
        assert_eq!(result.active_document, Some(child.clone()));
        assert!(!root.join("起点/.materials").exists());
        assert_eq!(
            fs::read_to_string(child).unwrap(),
            "[home](../../../Home.md)"
        );
        assert_eq!(
            fs::read_to_string(target.join("Note.md")).unwrap(),
            "[folder](.materials/)\n"
        );
        assert_eq!(
            fs::read_to_string(target.join(".materials/raw.txt")).unwrap(),
            "unlisted content"
        );
        assert_eq!(
            fs::read_to_string(root.join("Home.md")).unwrap(),
            "[raw](%E7%9B%AE%E6%A0%87/%E5%AD%90%E7%9B%AE%E5%BD%95/.materials/raw.txt#part)"
        );
    }

    #[test]
    fn rolls_back_the_document_and_companion_when_a_link_cannot_be_written() {
        let dir = fixture();
        let root = dir.path().canonicalize().unwrap();
        let note = root.join("起点/Note.md");
        let asset = root.join("起点/assets/raw.txt");
        let target_note = root.join("目标/Note.md");
        let target_asset = root.join("目标/assets/raw.txt");
        fs::write(&note, "[asset](assets/raw.txt)").unwrap();
        fs::write(&asset, "content").unwrap();
        let moves = BTreeMap::from([
            (note.clone(), target_note.clone()),
            (asset.clone(), target_asset),
        ]);
        let edits = [Edit {
            before_path: note.clone(),
            after_path: target_note.clone(),
            before: "stale text".into(),
            after: "new text".into(),
        }];
        assert!(move_paths(&root, &moves, &edits).is_err());
        assert!(note.is_file() && asset.is_file());
        assert!(!target_note.exists() && !root.join("目标/assets").exists());
    }

    #[test]
    fn moving_a_folder_keeps_internal_links_and_rebases_links_on_both_sides() {
        let dir = fixture();
        let root = dir.path();
        fs::create_dir(root.join("起点/empty")).unwrap();
        fs::write(root.join("起点/assets/icon.png"), b"image").unwrap();
        fs::write(root.join("起点/Child.md"), "Child").unwrap();
        fs::write(root.join("根文档.md"), "[note](起点/Note.md#hi)\n").unwrap();
        fs::write(
            root.join("起点/Note.md"),
            "![icon](./assets/icon.png) [Child](./Child.md) [Root](../根文档.md?mode=edit#title)\n",
        )
        .unwrap();
        let result = move_at(root, "起点", "目标/子目录", Some("起点/Note.md")).unwrap();
        assert_eq!(
            result.active_document,
            Some(root.join("目标/子目录/起点/Note.md"))
        );
        assert!(!root.join("起点").exists());
        assert!(result.destination.join("empty").is_dir());
        assert_eq!(
            fs::read(result.destination.join("assets/icon.png")).unwrap(),
            b"image"
        );
        assert_eq!(fs::read_to_string(result.destination.join("Note.md")).unwrap(),
            "![icon](./assets/icon.png) [Child](./Child.md) [Root](../../../%E6%A0%B9%E6%96%87%E6%A1%A3.md?mode=edit#title)\n");
        assert_eq!(fs::read_to_string(root.join("根文档.md")).unwrap(),
            "[note](%E7%9B%AE%E6%A0%87/%E5%AD%90%E7%9B%AE%E5%BD%95/%E8%B5%B7%E7%82%B9/Note.md#hi)\n");
    }

    #[test]
    fn conflicts_and_descendants_preserve_the_originals() {
        let dir = fixture();
        let root = dir.path();
        fs::create_dir(root.join("起点/nested")).unwrap();
        fs::write(root.join("起点/Note.md"), "source").unwrap();
        fs::write(root.join("目标/子目录/Note.md"), "destination").unwrap();
        assert!(move_at(root, "起点", "起点/nested", None).is_err());
        assert!(move_at(root, "起点/Note.md", "目标/子目录", None).is_err());
        assert_eq!(
            fs::read_to_string(root.join("起点/Note.md")).unwrap(),
            "source"
        );
        assert_eq!(
            fs::read_to_string(root.join("目标/子目录/Note.md")).unwrap(),
            "destination"
        );
    }

    #[test]
    fn moving_to_a_new_name_in_the_same_directory_rewrites_self_links_and_backlinks() {
        let dir = fixture();
        let root = dir.path();
        let source = root.join("起点/Note.md");
        let target = root.join("起点");
        fs::write(&source, "[self](Note.md#title)").unwrap();
        fs::write(target.join("Other.md"), "[note](./Note.md)").unwrap();
        let result = move_entry(
            root,
            &root.canonicalize().unwrap(),
            &source,
            &target,
            Some("New.md"),
            Some(&source),
        )
        .unwrap();
        assert_eq!(result.active_document, Some(target.join("New.md")));
        assert_eq!(
            fs::read_to_string(&result.destination).unwrap(),
            "[self](New.md#title)"
        );
        assert_eq!(
            fs::read_to_string(target.join("Other.md")).unwrap(),
            "[note](New.md)"
        );
        assert!(!source.exists());
    }

    #[cfg(unix)]
    #[test]
    fn a_read_only_backlink_leaves_the_source_and_destination_intact() {
        use std::os::unix::fs::PermissionsExt;
        let dir = fixture();
        let root = dir.path();
        let source = root.join("起点/Note.md");
        let backlink = root.join("Home.md");
        fs::write(&source, "# Note").unwrap();
        fs::write(&backlink, "[note](起点/Note.md)").unwrap();
        fs::set_permissions(&backlink, fs::Permissions::from_mode(0o444)).unwrap();
        // Run this check under an account subject to the directory's permissions.
        if OpenOptions::new().write(true).open(&backlink).is_err() {
            assert!(move_at(root, "起点/Note.md", "目标/子目录", None).is_err());
            assert_eq!(fs::read_to_string(source).unwrap(), "# Note");
            assert!(!root.join("目标/子目录/Note.md").exists());
            assert_eq!(
                fs::read_to_string(&backlink).unwrap(),
                "[note](起点/Note.md)"
            );
        }
    }

    #[test]
    fn a_cross_volume_copy_can_commit_and_can_roll_back_published_files() {
        let dir = fixture();
        let root = dir.path();
        let source = root.join("起点");
        let dest = root.join("目标/子目录/起点");
        fs::write(source.join("Note.md"), "content").unwrap();
        fs::write(source.join("assets/proof.pdf"), b"asset").unwrap();
        let other = root.join("Other.md");
        fs::write(&other, "unchanged").unwrap();
        let edits = [
            Edit {
                before_path: other.clone(),
                after_path: other.clone(),
                before: "unchanged".into(),
                after: "changed".into(),
            },
            Edit {
                before_path: source.join("Note.md"),
                after_path: dest.join("missing.md"),
                before: "content".into(),
                after: "different".into(),
            },
        ];
        assert!(cross_volume_move(&source, &dest, &edits).is_err());
        assert_eq!(fs::read_to_string(&other).unwrap(), "unchanged");
        assert!(source.exists());
        assert!(!dest.exists());

        cross_volume_move(&source, &dest, &[]).unwrap();
        assert!(!source.exists());
        assert_eq!(fs::read(dest.join("assets/proof.pdf")).unwrap(), b"asset");
        assert_eq!(fs::read_to_string(dest.join("Note.md")).unwrap(), "content");
    }
}
