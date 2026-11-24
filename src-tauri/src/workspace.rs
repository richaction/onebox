use crate::{
    attachments::{copy_with_hash, document_name, normalize, relative_href, FILE_OPERATION},
    fs::{selected_path, write_file},
    workspace_links::{links, rebased_link, rewrite},
};
use serde::Serialize;
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, File, OpenOptions},
    io::{self, Write},
    path::{Component, Path, PathBuf},
};
use tauri::{AppHandle, Manager};
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
    active_document_changed: bool,
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
    let demo = demo_workspace_path(&app)?;
    activate_workspace(app, demo, true).await
}

fn demo_workspace_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|err| err.to_string())?
        .join("Onebox 调试样例"))
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
    let seed = Path::new(env!("CARGO_MANIFEST_DIR")).join("../examples/manual-testing");
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::other("Missing sample directory parent"))?;
    if !path.exists() {
        fs::create_dir_all(parent)?;
        let staging = tempfile::tempdir_in(parent)?;
        copy_sample_files(&seed, staging.path())?;
        fs::rename(staging.path(), path)?;
    }
    for (version, directory, names) in [
        ("demo-excel-v1", "04 文件预览", &["Excel 冻结窗格与两万行.xlsx"][..]),
        ("demo-charts-v1", "01 编辑器", &["图表数字与公式.md"][..]),
        ("demo-format-v1", "01 编辑器", &["全格式验收.md"][..]),
        (
            "demo-images-v1",
            "04 文件预览",
            &[
                "AVIF 山雾.avif",
                "BMP 网格.bmp",
                "ICO 小图标.ico",
                "TIFF 多页.tiff",
                "WebP 透明图层.webp",
            ][..],
        ),
        (
            "demo-archives-v1",
            "04 文件预览",
            &["ZIP 中文目录.zip", "TAR.GZ 多文件.tar.gz", "7Z 多文件.7z"][..],
        ),
    ] {
        let marker = parent.join(version);
        if marker.exists() {
            continue;
        }
        // Add new fixtures to existing editable workspaces without overwriting user edits.
        let folder = path.join(directory);
        match fs::create_dir(&folder) {
            Ok(()) => {}
            Err(err) if err.kind() == io::ErrorKind::AlreadyExists => {}
            Err(err) => return Err(err),
        }
        if folder.symlink_metadata()?.is_dir() {
            for name in names {
                let mut staged = tempfile::NamedTempFile::new_in(&folder)?;
                io::copy(&mut File::open(seed.join(directory).join(name))?, &mut staged)?;
                match staged.persist_noclobber(folder.join(name)) {
                    Ok(_) => {}
                    Err(err) if err.error.kind() == io::ErrorKind::AlreadyExists => {}
                    Err(err) => return Err(err.error),
                }
            }
        }
        File::create(marker)?;
    }
    Ok(())
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
        if cfg!(debug_assertions) && demo_workspace_path(&app).is_ok_and(|demo| demo == root) {
            if let Err(err) = seed_demo_workspace(&root) {
                eprintln!("Unable to refresh demo fixtures: {err}");
            }
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
    let name = if directory || name.starts_with('.') || Path::new(name).extension().is_some() {
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
    let markdown = !directory && document_name(&path);
    Ok(WorkspaceEntry {
        path,
        name,
        directory,
        markdown,
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
pub(crate) async fn trash_workspace_entry(
    app: AppHandle,
    root: String,
    path: String,
) -> Result<(), String> {
    let settings = workspace_preference(&app)?;
    let root = selected_path(&app, root)?;
    let path = selected_path(&app, path)?;
    tokio::task::spawn_blocking(move || {
        let _locked = FILE_OPERATION.lock().map_err(|err| err.to_string())?;
        let real_root = root.canonicalize().map_err(|err| err.to_string())?;
        if real_root != root || remembered_root(&settings)?.as_deref() != Some(root.as_path()) {
            return Err("请先打开此工作区".into());
        }
        let entry = workspace_path(&root, &real_root, &path)?;
        if entry == real_root {
            return Err("不能删除工作区根目录".into());
        }
        let kind = entry
            .symlink_metadata()
            .map_err(|err| err.to_string())?
            .file_type();
        if !(kind.is_file() || kind.is_dir()) {
            return Err("此项目不能移到废纸篓".into());
        }
        #[cfg(any(target_os = "macos", windows, target_os = "linux"))]
        return trash::delete(entry).map_err(|err| format!("移到废纸篓失败：{err}"));
        #[cfg(not(any(target_os = "macos", windows, target_os = "linux")))]
        Err("此平台不支持移到废纸篓".into())
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
pub(crate) async fn import_workspace_files(
    app: AppHandle,
    root: String,
    folder: String,
    paths: Vec<String>,
) -> Result<WorkspaceImport, String> {
    let settings = workspace_preference(&app)?;
    let root = selected_path(&app, root)?;
    let folder = selected_path(&app, folder)?;
    let sources = paths
        .into_iter()
        .map(|path| selected_path(&app, path))
        .collect::<Vec<_>>();
    tokio::task::spawn_blocking(move || {
        let _locked = FILE_OPERATION.lock().map_err(|err| err.to_string())?;
        let real_root = root.canonicalize().map_err(|err| err.to_string())?;
        if remembered_root(&settings)?.as_deref() != Some(real_root.as_path()) {
            return Err("请先打开此工作区".into());
        }
        let folder = workspace_path(&root, &real_root, &folder)?;
        let mut result = WorkspaceImport::default();
        for source in sources {
            match source.and_then(|source| {
                copy_into_workspace(&source, &folder).map_err(|err| err.to_string())
            }) {
                Ok(path) => result.paths.push(path),
                Err(_) => result.failed += 1,
            }
        }
        Ok(result)
    })
    .await
    .map_err(|err| err.to_string())?
}

#[derive(Default, Serialize)]
pub(crate) struct WorkspaceImport {
    paths: Vec<PathBuf>,
    failed: usize,
}

#[tauri::command]
pub(crate) async fn copy_workspace_file_to_clipboard(
    app: AppHandle,
    root: String,
    sources: Vec<String>,
) -> Result<isize, String> {
    #[cfg(target_os = "macos")]
    {
        let settings = workspace_preference(&app)?;
        let root = selected_path(&app, root)?;
        let sources = sources
            .into_iter()
            .map(|path| selected_path(&app, path))
            .collect::<Result<Vec<_>, _>>()?;
        tokio::task::spawn_blocking(move || {
            let _locked = FILE_OPERATION.lock().map_err(|err| err.to_string())?;
            let real_root = root.canonicalize().map_err(|err| err.to_string())?;
            if real_root != root || remembered_root(&settings)?.as_deref() != Some(root.as_path()) {
                return Err("请先打开此工作区".into());
            }
            if sources.is_empty() {
                return Err("请选择要复制的文件或文件夹".into());
            }
            let sources = sources
                .into_iter()
                .map(|source| {
                    let source = workspace_path(&root, &real_root, &source)?;
                    if source == real_root
                        || !fs::symlink_metadata(&source)
                            .is_ok_and(|metadata| metadata.is_file() || metadata.is_dir())
                    {
                        return Err("请选择要复制的文件或文件夹".into());
                    }
                    Ok(source)
                })
                .collect::<Result<Vec<_>, String>>()?;
            objc2::rc::autoreleasepool(|_| {
                write_files_to_pasteboard(&objc2_app_kit::NSPasteboard::generalPasteboard(), &sources)
            })
        })
        .await
        .map_err(|err| err.to_string())?
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, root, sources);
        Err("当前平台不支持复制文件到系统剪贴板".into())
    }
}

#[cfg(target_os = "macos")]
fn write_files_to_pasteboard(
    board: &objc2_app_kit::NSPasteboard,
    sources: &[PathBuf],
) -> Result<isize, String> {
    use objc2::runtime::ProtocolObject;
    use objc2_foundation::{NSArray, NSString, NSURL};

    let urls = sources
        .iter()
        .map(|source| {
            let path = source.to_str().ok_or("无效文件名")?;
            Ok(NSURL::fileURLWithPath_isDirectory(
                &NSString::from_str(path),
                source.is_dir(),
            ))
        })
        .collect::<Result<Vec<_>, &str>>()?;
    let objects: Vec<_> = urls.iter().map(|url| ProtocolObject::from_ref(&**url)).collect();
    let items = NSArray::from_slice(&objects);
    board.clearContents();
    if !board.writeObjects(&items) {
        return Err("无法复制文件到系统剪贴板".into());
    }
    Ok(board.changeCount())
}

#[cfg(target_os = "macos")]
fn read_clipboard_paths(
    board: &objc2_app_kit::NSPasteboard,
    local_change_count: Option<isize>,
) -> Result<Option<Vec<PathBuf>>, String> {
    use objc2::ClassType;
    use objc2_foundation::{NSArray, NSURL};

    let change_count = board.changeCount();
    if local_change_count == Some(change_count) {
        return Ok(None);
    }
    let classes = NSArray::from_slice(&[NSURL::class()]);
    // NSURL conforms to NSPasteboardReading. The returned objects are checked
    // before the path is used, and non-file and remote URLs are ignored.
    let objects = unsafe { board.readObjectsForClasses_options(&classes, None) };
    let paths = objects
        .into_iter()
        .flat_map(|objects| objects.to_vec())
        .filter_map(|object| {
            let url = object.downcast::<NSURL>().ok()?;
            if !url.isFileURL() || url.host().is_some_and(|host| {
                let host = host.to_string();
                !host.is_empty() && !host.eq_ignore_ascii_case("localhost")
            }) {
                return None;
            }
            let path = PathBuf::from(url.path()?.to_string());
            path.is_absolute().then_some(path)
        })
        .collect();
    if board.changeCount() != change_count {
        return Err("剪贴板内容已变化，请重试".into());
    }
    Ok(Some(paths))
}

#[cfg(target_os = "macos")]
fn copy_clipboard_entry(source: &Path, folder: &Path) -> Result<PathBuf, String> {
    let metadata = fs::symlink_metadata(source).map_err(|err| err.to_string())?;
    if metadata.is_dir() {
        let source = source.canonicalize().map_err(|err| err.to_string())?;
        return copy_directory_to_folder(&source, folder);
    }
    copy_into_workspace(source, folder).map_err(|err| err.to_string())
}

#[tauri::command]
pub(crate) async fn paste_workspace_clipboard(
    app: AppHandle,
    root: String,
    folder: String,
    local_change_count: Option<isize>,
) -> Result<Option<WorkspaceImport>, String> {
    #[cfg(target_os = "macos")]
    {
        let settings = workspace_preference(&app)?;
        let root = selected_path(&app, root)?;
        let folder = selected_path(&app, folder)?;
        tokio::task::spawn_blocking(move || {
            let _locked = FILE_OPERATION.lock().map_err(|err| err.to_string())?;
            let real_root = root.canonicalize().map_err(|err| err.to_string())?;
            if real_root != root || remembered_root(&settings)?.as_deref() != Some(root.as_path()) {
                return Err("请先打开此工作区".into());
            }
            let folder = workspace_path(&root, &real_root, &folder)?;
            if !folder.is_dir() {
                return Err("请选择目标文件夹".into());
            }
            let paths = objc2::rc::autoreleasepool(|_| {
                read_clipboard_paths(
                    &objc2_app_kit::NSPasteboard::generalPasteboard(),
                    local_change_count,
                )
            })?;
            let Some(paths) = paths else {
                return Ok(None);
            };
            let mut result = WorkspaceImport::default();
            for path in paths {
                match copy_clipboard_entry(&path, &folder) {
                    Ok(path) => result.paths.push(path),
                    Err(_) => result.failed += 1,
                }
            }
            Ok(Some(result))
        })
        .await
        .map_err(|err| err.to_string())?
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, root, folder, local_change_count);
        Err("当前平台不支持从系统剪贴板粘贴文件".into())
    }
}

#[tauri::command]
pub(crate) async fn copy_workspace_file(
    app: AppHandle,
    root: String,
    source: String,
    target: String,
) -> Result<PathBuf, String> {
    let settings = workspace_preference(&app)?;
    let root = selected_path(&app, root)?;
    let source = selected_path(&app, source)?;
    let target = selected_path(&app, target)?;
    tokio::task::spawn_blocking(move || {
        let _locked = FILE_OPERATION.lock().map_err(|err| err.to_string())?;
        let real_root = root.canonicalize().map_err(|err| err.to_string())?;
        if real_root != root || remembered_root(&settings)?.as_deref() != Some(root.as_path()) {
            return Err("请先打开此工作区".into());
        }
        let source = workspace_path(&root, &real_root, &source)?;
        let target = workspace_path(&root, &real_root, &target)?;
        copy_entry(&source, &target)
    })
    .await
    .map_err(|err| err.to_string())?
}

fn copy_entry(source: &Path, target: &Path) -> Result<PathBuf, String> {
    let source_type = fs::symlink_metadata(source)
        .map_err(|err| err.to_string())?
        .file_type();
    if !target.is_dir() || !(source_type.is_file() || source_type.is_dir()) {
        return Err("请选择要复制的文件或文件夹，以及目标文件夹".into());
    }
    if source_type.is_dir() {
        return copy_directory_to_folder(source, target);
    }
    let from = source.parent().ok_or("找不到上级目录")?;
    let mut rewritten = None;
    if from != target && document_name(source) {
        match fs::read_to_string(source) {
            Ok(text) => {
                rewritten = rewrite(&text, &links(&text), |href| {
                    rebased_link(href, from, target, |_| None)
                })?;
            }
            Err(err) if err.kind() == io::ErrorKind::InvalidData => {}
            Err(err) => return Err(format!("无法读取 Markdown：{err}")),
        }
    }
    copy_file_to_folder(source, target, rewritten.as_deref()).map_err(|err| format!("复制失败：{err}"))
}

fn copy_directory_to_folder(source: &Path, target: &Path) -> Result<PathBuf, String> {
    if target.starts_with(source) {
        return Err("不能将文件夹粘贴到自身或其子目录".into());
    }
    let name = source
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("无效文件夹名")?;
    let staging = tempfile::Builder::new()
        .prefix(".onebox-copy-")
        .tempdir_in(target)
        .map_err(|err| format!("复制失败：{err}"))?;
    let staged = staging.path().join("folder");
    snapshot_tree(source, Some(&staged))?;
    let mut destination = target.join(name);
    let mut suffix = 2;
    loop {
        match rename_exclusive(&staged, &destination) {
            Ok(()) => return Ok(destination),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                destination = target.join(format!("{name} ({suffix})"));
                suffix += 1;
            }
            Err(error) => return Err(format!("复制失败：{error}")),
        }
    }
}

fn copy_into_workspace(source: &Path, folder: &Path) -> io::Result<PathBuf> {
    copy_file_to_folder(source, folder, None)
}

fn copy_file_to_folder(source: &Path, folder: &Path, content: Option<&str>) -> io::Result<PathBuf> {
    let name = source
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "无效文件名"))?;
    let metadata = fs::symlink_metadata(source)?;
    if !metadata.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "请选择普通文件",
        ));
    }
    let mut staged = tempfile::NamedTempFile::new_in(folder)?;
    if let Some(content) = content {
        staged.write_all(content.as_bytes())?;
    } else {
        io::copy(&mut File::open(source)?, &mut staged)?;
    }
    staged.as_file().set_permissions(metadata.permissions())?;
    staged.as_file().sync_all()?;
    let stem = source
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or(name);
    let extension = source
        .extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| format!(".{extension}"))
        .unwrap_or_default();
    let mut destination = folder.join(name);
    let mut suffix = 2;
    loop {
        match staged.persist_noclobber(&destination) {
            Ok(_) => return Ok(destination),
            Err(error) if error.error.kind() == io::ErrorKind::AlreadyExists => {
                staged = error.file;
                destination = folder.join(format!("{stem} ({suffix}){extension}"));
                suffix += 1;
            }
            Err(error) => return Err(error.error),
        }
    }
}

fn preview_file(root: Option<&Path>, entry: &Path) -> Result<PathBuf, String> {
    let path = match root {
        Some(root) => workspace_path(
            root,
            &root.canonicalize().map_err(|err| err.to_string())?,
            entry,
        )?,
        None => entry.canonicalize().map_err(|err| err.to_string())?,
    };
    if !path.is_file() {
        return Err("请选择普通文件".into());
    }
    Ok(path)
}

fn internal_preview_file(root: Option<&Path>, entry: &Path) -> Result<PathBuf, String> {
    let path = preview_file(root, entry)?;
    let unsupported = [entry, path.as_path()].iter().any(|candidate| {
        candidate
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| {
                ["wps", "et", "dps", "wpt", "ett", "dpt"]
                    .iter()
                    .any(|format| extension.eq_ignore_ascii_case(format))
            })
    });
    if unsupported {
        return Err("无法预览此文件。可以使用「打开方式」。".into());
    }
    Ok(path)
}

#[tauri::command]
pub(crate) async fn reveal_workspace_location(
    app: AppHandle,
    root: Option<String>,
    path: String,
) -> Result<(), String> {
    let root = root.map(|root| selected_path(&app, root)).transpose()?;
    let entry = selected_path(&app, path)?;
    tokio::task::spawn_blocking(move || {
        if let Some(root) = root {
            workspace_path(&root, &root.canonicalize().map_err(|err| err.to_string())?, &entry)?;
        } else {
            entry.symlink_metadata().map_err(|err| err.to_string())?;
        }
        #[cfg(target_os = "macos")]
        return std::process::Command::new("/usr/bin/open")
            .arg("-R")
            .arg(&entry)
            .status()
            .map_err(|err| err.to_string())?
            .success()
            .then_some(())
            .ok_or_else(|| "无法在访达中显示此项目".into());

        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            let mut selection = std::ffi::OsString::from("/select,\"");
            selection.push(&entry);
            selection.push("\"");
            return std::process::Command::new("explorer.exe")
                .raw_arg(selection)
                .spawn()
                .map(drop)
                .map_err(|err| err.to_string());
        }

        #[cfg(not(any(target_os = "macos", windows)))]
        {
            let folder = if entry.is_dir() {
                entry.as_path()
            } else {
                entry.parent().ok_or("无法确定所在文件夹")?
            };
            open::that(folder).map_err(|err| err.to_string())
        }
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
pub(crate) async fn open_workspace_attachment(
    app: AppHandle,
    root: Option<String>,
    path: String,
    application: Option<String>,
) -> Result<(), String> {
    let root = root.map(|root| selected_path(&app, root)).transpose()?;
    let entry = selected_path(&app, path)?;
    tokio::task::spawn_blocking(move || {
        let path = preview_file(root.as_deref(), &entry)?;
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FileApplications {
    items: Vec<FileApplication>,
    default_icon: Option<String>,
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
    use objc2::AnyThread;
    use objc2_app_kit::{
        NSBitmapImageFileType, NSBitmapImageRep, NSCompositingOperation, NSDeviceRGBColorSpace,
        NSGraphicsContext, NSWorkspace,
    };
    use objc2_foundation::{NSDictionary, NSPoint, NSRect, NSSize, NSString};

    const SIZE: isize = 36;
    let icon = NSWorkspace::sharedWorkspace().iconForFile(&NSString::from_str(path));
    // A null planes pointer asks AppKit to allocate the RGBA backing buffer.
    let bitmap = unsafe {
        NSBitmapImageRep::initWithBitmapDataPlanes_pixelsWide_pixelsHigh_bitsPerSample_samplesPerPixel_hasAlpha_isPlanar_colorSpaceName_bytesPerRow_bitsPerPixel(
            NSBitmapImageRep::alloc(), std::ptr::null_mut(), SIZE, SIZE, 8, 4, true, false,
            NSDeviceRGBColorSpace, 0, 0,
        )
    }?;
    let context = NSGraphicsContext::graphicsContextWithBitmapImageRep(&bitmap)?;
    let previous_context = NSGraphicsContext::currentContext();
    NSGraphicsContext::setCurrentContext(Some(&context));
    icon.drawInRect_fromRect_operation_fraction(
        NSRect::new(NSPoint::ZERO, NSSize::new(SIZE as f64, SIZE as f64)),
        NSRect::ZERO,
        NSCompositingOperation::Copy,
        1.0,
    );
    NSGraphicsContext::setCurrentContext(previous_context.as_deref());

    // PNG encoding accepts an empty properties dictionary.
    let png = unsafe {
        bitmap.representationUsingType_properties(NSBitmapImageFileType::PNG, &NSDictionary::new())
    }?;
    Some(png.to_vec())
}

#[cfg(target_os = "macos")]
fn cached_file_application_icon(path: &str) -> Option<String> {
    use base64::{engine::general_purpose::STANDARD, Engine};
    use std::sync::Mutex;

    static CACHE: Mutex<BTreeMap<String, String>> = Mutex::new(BTreeMap::new());
    if let Some(icon) = CACHE.lock().ok()?.get(path).cloned() {
        return Some(icon);
    }
    // Drawing can be slow on a cold lookup. Keep the cache available to other requests.
    let png = file_application_icon(path)?;
    let icon = format!("data:image/png;base64,{}", STANDARD.encode(png));
    CACHE.lock().ok()?.insert(path.into(), icon.clone());
    Some(icon)
}

#[tauri::command]
pub(crate) async fn workspace_file_applications(
    app: AppHandle,
    root: Option<String>,
    path: String,
    on_list: tauri::ipc::Channel<FileApplications>,
) -> Result<BTreeMap<String, String>, String> {
    let root = root.map(|root| selected_path(&app, root)).transpose()?;
    let entry = selected_path(&app, path)?;
    tokio::task::spawn_blocking(move || {
        let path = preview_file(root.as_deref(), &entry)?;
        #[cfg(target_os = "macos")]
        return objc2::rc::autoreleasepool(|_| {
            let items = file_applications(&path);
            let default_icon = items
                .iter()
                .find(|app| app.default)
                .and_then(|app| cached_file_application_icon(&app.path));
            let alternatives: Vec<_> = items
                .iter()
                .filter(|app| !app.default)
                .map(|app| app.path.clone())
                .collect();
            on_list
                .send(FileApplications {
                    items,
                    default_icon,
                })
                .map_err(|err| err.to_string())?;
            Ok(alternatives
                .into_iter()
                .filter_map(|path| cached_file_application_icon(&path).map(|icon| (path, icon)))
                .collect())
        });
        #[cfg(not(target_os = "macos"))]
        {
            let _ = path;
            on_list
                .send(FileApplications {
                    items: Vec::new(),
                    default_icon: None,
                })
                .map_err(|err| err.to_string())?;
            Ok(BTreeMap::new())
        }
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
pub(crate) async fn workspace_preview(
    app: AppHandle,
    root: Option<String>,
    path: String,
) -> Result<PathBuf, String> {
    let settings = workspace_preference(&app)?;
    let root = root.map(|root| selected_path(&app, root)).transpose()?;
    let entry = selected_path(&app, path)?;
    tokio::task::spawn_blocking(move || {
        if let Some(root) = &root {
            let real_root = root.canonicalize().map_err(|err| err.to_string())?;
            if remembered_root(&settings)?.as_deref() != Some(real_root.as_path()) {
                return Err("请先打开此工作区".into());
            }
        }
        let path = internal_preview_file(root.as_deref(), &entry)?;
        app.asset_protocol_scope()
            .allow_file(&path)
            .map_err(|err| err.to_string())?;
        Ok(path)
    })
    .await
    .map_err(|err| err.to_string())?
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

fn case_only_rename(from: &Path, to: &Path) -> io::Result<bool> {
    let (Some(parent), Some(from_name), Some(to_name)) =
        (from.parent(), from.file_name(), to.file_name())
    else {
        return Ok(false);
    };
    if to.parent() != Some(parent)
        || from_name == to_name
        || from_name.to_string_lossy().to_lowercase() != to_name.to_string_lossy().to_lowercase()
        || !fs::symlink_metadata(to).is_ok_and(|meta| !meta.file_type().is_symlink())
    {
        return Ok(false);
    }
    let mut actual_source = false;
    for entry in fs::read_dir(parent)? {
        let name = entry?.file_name();
        if name == to_name {
            return Ok(false);
        }
        actual_source |= name == from_name;
    }
    Ok(actual_source)
}

fn rename_noclobber(from: &Path, to: &Path) -> io::Result<()> {
    match rename_exclusive(from, to) {
        Ok(()) => return Ok(()),
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists && case_only_rename(from, to)? => {}
        Err(error) => return Err(error),
    }
    // A case-insensitive volume sees both names as the same entry. Stage the
    // move so a newly created destination can still never be overwritten.
    let staging = tempfile::tempdir_in(from.parent().unwrap())?;
    let staged = staging.path().join("entry");
    rename_exclusive(from, &staged)?;
    if let Err(error) = rename_exclusive(&staged, to) {
        if let Err(rollback) = rename_exclusive(&staged, from) {
            let retained = staging.keep();
            return Err(io::Error::other(format!(
                "{error}；无法恢复原文件名：{rollback}。文件保存在 {}",
                retained.join("entry").display()
            )));
        }
        return Err(error);
    }
    Ok(())
}

fn rename_exclusive(from: &Path, to: &Path) -> io::Result<()> {
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
        let resolve = |base: &Path| {
            if relative.as_os_str().is_empty() {
                base.to_owned()
            } else {
                base.join(&relative)
            }
        };
        let from = resolve(root);
        let metadata = fs::symlink_metadata(&from).map_err(|err| err.to_string())?;
        let kind = metadata.file_type();
        let to = copy_to.map(resolve);
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
            return Err(format!("不支持复制此文件类型：{}", from.display()));
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

enum DestinationName<'a> {
    Original,
    Markdown(&'a str),
    Rename(&'a str),
}

fn rename_leaf(source: &Path, stem: &str, directory: bool) -> Result<PathBuf, String> {
    if stem.is_empty()
        || stem == "."
        || stem == ".."
        || stem.ends_with([' ', '.'])
        || stem.contains(['/', '\\', '\0'])
        || stem.chars().any(char::is_control)
    {
        return Err("请输入有效的文件名".into());
    }
    let mut leaf = std::ffi::OsString::from(stem);
    if !directory {
        if let Some(extension) = source.extension() {
            leaf.push(".");
            leaf.push(extension);
        } else if Path::new(stem).extension().is_some() {
            return Err("文件扩展名不能修改".into());
        }
    }
    let path = PathBuf::from(leaf);
    if path.file_name() != Some(path.as_os_str()) {
        return Err("请输入有效的文件名".into());
    }
    Ok(path)
}

fn move_entry(
    root: &Path,
    real_root: &Path,
    source: &Path,
    target: &Path,
    name: Option<&str>,
    active_document: Option<&Path>,
) -> Result<WorkspaceMove, String> {
    relocate_entry(
        root, real_root, source, target,
        name.map_or(DestinationName::Original, DestinationName::Markdown),
        active_document,
    )
}

fn relocate_entry(
    root: &Path,
    real_root: &Path,
    source: &Path,
    target: &Path,
    name: DestinationName<'_>,
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
        DestinationName::Original => target.join(source.file_name().unwrap()),
        DestinationName::Markdown(name) => {
            let leaf = Path::new(name);
            if kind.is_dir() || leaf.file_name() != Some(leaf.as_os_str()) || !document_name(leaf) {
                return Err("请选择有效的 Markdown 文件名".into());
            }
            target.join(leaf)
        }
        DestinationName::Rename(stem) => target.join(rename_leaf(&source, stem, kind.is_dir())?),
    };
    let display = |path: &Path| root.join(path.strip_prefix(real_root).unwrap());
    if source == destination {
        return Ok(WorkspaceMove {
            destination: display(&destination),
            active_document: None,
            active_document_changed: false,
        });
    }
    if !case_only_rename(&source, &destination).map_err(|err| err.to_string())? {
        ensure_absent(&destination).map_err(|err| err.to_string())?;
    }
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
    let active_document_changed = active.as_ref().is_some_and(|path| {
        edits.iter().any(|edit| &edit.before_path == path)
    });
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
        active_document_changed,
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

#[tauri::command]
pub(crate) async fn rename_workspace_entry(
    app: AppHandle,
    root: Option<String>,
    source: String,
    stem: String,
    active_document: Option<String>,
) -> Result<WorkspaceMove, String> {
    let root = root.map(|path| selected_path(&app, path)).transpose()?;
    let source = selected_path(&app, source)?;
    let active = active_document.and_then(|path| selected_path(&app, path).ok());
    tokio::task::spawn_blocking(move || {
        let parent = source.parent().ok_or("找不到上级目录")?;
        if let Some(root) = root {
            let real_root = root.canonicalize().map_err(|err| err.to_string())?;
            return relocate_entry(
                &root, &real_root, &source, parent, DestinationName::Rename(&stem), active.as_deref(),
            );
        }

        let _locked = FILE_OPERATION.lock().map_err(|err| err.to_string())?;
        if !fs::symlink_metadata(&source).is_ok_and(|meta| meta.is_file()) {
            return Err("只能重命名普通文件".into());
        }
        let destination = parent.join(rename_leaf(&source, &stem, false)?);
        if source != destination {
            if !case_only_rename(&source, &destination).map_err(|err| err.to_string())? {
                ensure_absent(&destination).map_err(|err| err.to_string())?;
            }
            rename_noclobber(&source, &destination).map_err(|err| err.to_string())?;
            if let Err(error) = app.fs_scope().allow_file(&destination) {
                return Err(report_rollback(error.to_string(), rename_noclobber(&destination, &source).map_err(|err| err.to_string())));
            }
        }
        let active_document = (active.as_ref() == Some(&source)).then(|| destination.clone());
        Ok(WorkspaceMove { destination, active_document, active_document_changed: false })
    })
    .await
    .map_err(|err| err.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;


    #[test]
    fn renaming_keeps_the_extension_and_rewrites_workspace_links() {
        let folder = tempfile::tempdir().unwrap();
        let root = folder.path().canonicalize().unwrap();
        let attachment = root.join("table.XLSX");
        let note = root.join("note.md");
        fs::write(&attachment, "attachment").unwrap();
        fs::write(&note, "[统计](table.XLSX)").unwrap();
        let renamed = relocate_entry(
            &root, &root, &attachment, &root, DestinationName::Rename("新统计.v2"), Some(&note),
        ).unwrap();
        assert_eq!(renamed.destination, root.join("新统计.v2.XLSX"));
        assert_eq!(renamed.active_document, Some(note.clone()));
        assert_eq!(fs::read_to_string(&renamed.destination).unwrap(), "attachment");
        assert!(fs::read_to_string(note).unwrap().ends_with(".v2.XLSX)"));
        assert!(!attachment.exists());
        assert!(rename_leaf(Path::new("README"), "read.me", false).is_err());
        assert!(rename_leaf(Path::new("file.md"), "../outside", false).is_err());

        let conflict = root.join("existing.XLSX");
        fs::write(&conflict, "existing").unwrap();
        assert!(relocate_entry(
            &root, &root, &renamed.destination, &root, DestinationName::Rename("existing"), None,
        ).is_err());
        assert_eq!(fs::read_to_string(conflict).unwrap(), "existing");

        let renamed_case = relocate_entry(
            &root, &root, &renamed.destination, &root, DestinationName::Rename("新统计.V2"), None,
        ).unwrap();
        assert_eq!(renamed_case.destination, root.join("新统计.V2.XLSX"));
        assert!(fs::read_dir(root).unwrap().any(|entry| entry.unwrap().file_name() == "新统计.V2.XLSX"));
    }

    #[test]
    fn wps_formats_can_be_opened_externally_but_not_previewed() {
        let directory = tempfile::tempdir().unwrap();
        for extension in ["wps", "ET", "dps", "wpt", "ett", "dpt"] {
            let file = directory.path().join(format!("示例.{extension}"));
            fs::write(&file, "sample").unwrap();
            assert!(internal_preview_file(None, &file).is_err(), "{extension}");
            assert_eq!(preview_file(None, &file).unwrap(), file.canonicalize().unwrap());
        }
        for extension in ["doc", "docx", "xls", "xlsx", "ppt", "pptx"] {
            let file = directory.path().join(format!("示例.{extension}"));
            fs::write(&file, "sample").unwrap();
            assert_eq!(internal_preview_file(None, &file).unwrap(), file.canonicalize().unwrap());
        }
    }

    #[test]
    fn importing_a_dropped_file_keeps_the_source_and_existing_copies() {
        let source_dir = tempfile::tempdir().unwrap();
        let destination = tempfile::tempdir().unwrap();
        let source = source_dir.path().join("文档.wps");
        fs::write(&source, "dropped").unwrap();
        fs::write(destination.path().join("文档.wps"), "existing").unwrap();
        fs::write(destination.path().join("文档 (2).wps"), "another").unwrap();
        let copied = copy_into_workspace(&source, destination.path()).unwrap();
        assert_eq!(copied, destination.path().join("文档 (3).wps"));
        assert_eq!(fs::read_to_string(&copied).unwrap(), "dropped");
        assert_eq!(fs::read_to_string(&source).unwrap(), "dropped");
        assert_eq!(
            fs::read_to_string(destination.path().join("文档.wps")).unwrap(),
            "existing"
        );
        assert_eq!(fs::read_dir(destination.path()).unwrap().count(), 3);
    }

    #[test]
    fn copying_one_file_uses_a_free_name_and_preserves_markdown_links() {
        let workspace = tempfile::tempdir().unwrap();
        let source = workspace.path().join("Note.md");
        let target = workspace.path().join("target");
        let original = "[图](assets/image.png#detail)\r\n";
        fs::create_dir(&target).unwrap();
        fs::write(&source, original).unwrap();
        fs::write(workspace.path().join("Note (2).md"), "existing").unwrap();

        let backup = copy_entry(&source, workspace.path()).unwrap();
        assert_eq!(backup, workspace.path().join("Note (3).md"));
        assert_eq!(fs::read_to_string(backup).unwrap(), original);

        let copy = copy_entry(&source, &target).unwrap();
        assert_eq!(copy, target.join("Note.md"));
        assert_eq!(fs::read_to_string(copy).unwrap(), "[图](../assets/image.png#detail)\r\n");
        assert_eq!(fs::read_to_string(source).unwrap(), original);
    }

    #[test]
    fn copying_a_folder_keeps_its_name_tree_and_existing_destinations() {
        let workspace = tempfile::tempdir().unwrap();
        let source = workspace.path().join("资料.v2");
        let target = workspace.path().join("target");
        let note = "[附件](附件/数据.BIN)\r\n";
        fs::create_dir_all(source.join("附件/空文件夹")).unwrap();
        fs::write(source.join("笔记.md"), note).unwrap();
        fs::write(source.join("附件/数据.BIN"), [0, 1, 255]).unwrap();
        fs::create_dir(&target).unwrap();

        let first = copy_entry(&source, &target).unwrap();
        assert_eq!(first, target.join("资料.v2"));
        assert_eq!(fs::read_to_string(first.join("笔记.md")).unwrap(), note);
        assert_eq!(fs::read(first.join("附件/数据.BIN")).unwrap(), [0, 1, 255]);
        assert!(first.join("附件/空文件夹").is_dir());

        fs::write(target.join("资料.v2 (2)"), "same name").unwrap();
        let next = copy_entry(&source, &target).unwrap();
        assert_eq!(next, target.join("资料.v2 (3)"));
        assert_eq!(
            fs::read_to_string(target.join("资料.v2 (2)")).unwrap(),
            "same name"
        );
        assert_eq!(fs::read_to_string(source.join("笔记.md")).unwrap(), note);
        assert_eq!(fs::read_dir(&target).unwrap().count(), 3);
        assert!(copy_entry(&source, &source).is_err());
        assert!(copy_entry(&source, &source.join("附件")).is_err());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn copy_puts_original_file_and_folder_urls_on_the_pasteboard() {
        use objc2::ClassType;
        use objc2_app_kit::NSPasteboard;
        use objc2_foundation::{NSArray, NSURL};

        let directory = tempfile::tempdir().unwrap();
        let file = directory.path().join("中文 #备份.TAR.GZ");
        let folder = directory.path().join("第二份.PDF");
        fs::write(&file, [0, 1, 255]).unwrap();
        fs::create_dir(&folder).unwrap();
        let sources = [file, folder];
        objc2::rc::autoreleasepool(|_| {
            let board = NSPasteboard::pasteboardWithUniqueName();
            write_files_to_pasteboard(&board, &sources).unwrap();
            let classes = NSArray::from_slice(&[NSURL::class()]);
            // NSURL conforms to NSPasteboardReading. No reading options are supplied.
            let objects = unsafe { board.readObjectsForClasses_options(&classes, None) }.unwrap();
            assert_eq!(objects.count(), sources.len());
            for (object, source) in objects.to_vec().into_iter().zip(sources) {
                let url = object.downcast::<NSURL>().unwrap();
                assert!(url.isFileURL());
                let pasted_path = PathBuf::from(url.path().unwrap().to_string());
                assert_eq!(pasted_path, source);
                assert_eq!(url.hasDirectoryPath(), source.is_dir());
            }
        });
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn pasting_a_finder_folder_uses_the_current_clipboard_without_moving_the_source() {
        use objc2_app_kit::NSPasteboard;

        let directory = tempfile::tempdir().unwrap();
        let old = directory.path().join("old.txt");
        let source = directory.path().join("资料.v2");
        let target = directory.path().join("workspace");
        fs::write(&old, "old clipboard").unwrap();
        fs::create_dir_all(source.join("子目录/空目录")).unwrap();
        fs::write(source.join("子目录/笔记.txt"), "keep the original").unwrap();
        fs::create_dir(&target).unwrap();
        let target = target.canonicalize().unwrap();

        objc2::rc::autoreleasepool(|_| {
            let board = NSPasteboard::pasteboardWithUniqueName();
            let local = write_files_to_pasteboard(&board, &[old]).unwrap();
            assert_eq!(read_clipboard_paths(&board, Some(local)).unwrap(), None);

            write_files_to_pasteboard(&board, std::slice::from_ref(&source)).unwrap();
            let paths = read_clipboard_paths(&board, Some(local)).unwrap().unwrap();
            assert_eq!(paths, [source.clone()]);
            let pasted = copy_clipboard_entry(&paths[0], &target).unwrap();
            assert_eq!(pasted, target.join("资料.v2"));
            assert!(pasted.join("子目录/空目录").is_dir());
            assert_eq!(
                fs::read_to_string(pasted.join("子目录/笔记.txt")).unwrap(),
                "keep the original"
            );
            assert!(source.join("子目录/笔记.txt").is_file());
            assert_eq!(
                copy_clipboard_entry(&paths[0], &target).unwrap(),
                target.join("资料.v2 (2)")
            );
            assert!(copy_clipboard_entry(&source, &source.join("子目录").canonicalize().unwrap()).is_err());
            board.clearContents();
            assert_eq!(read_clipboard_paths(&board, Some(local)).unwrap(), Some(vec![]));
        });
    }

    #[test]
    fn moving_a_regular_file_across_volumes_stages_the_file_before_removing_the_source() {
        let workspace = tempfile::tempdir().unwrap();
        let source = workspace.path().join("source.pdf");
        let destination = workspace.path().join("target.pdf");
        fs::write(&source, b"%PDF").unwrap();

        cross_volume_move(&source, &destination, &[]).unwrap();

        assert!(!source.exists());
        assert_eq!(fs::read(destination).unwrap(), b"%PDF");
    }

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
        let text = create_entry(Some(&root), &root, &folder.path, "notes.txt", false).unwrap();
        assert!(!text.markdown);
        assert_eq!(text.name, "notes.txt");
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
