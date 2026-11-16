use crate::{
    attachments::{
        attachment_file, commit_transfer_locked, copy_with_hash, document_name, plan_transfer,
        FILE_OPERATION,
    },
    fs::{selected_path, write_file},
    workspace_links::{links, rebased_link, references, rewrite},
};
use serde::Serialize;
use std::{
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    io,
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

fn visible_name(name: &str) -> bool {
    !name.starts_with('.') && !name.eq_ignore_ascii_case("assets")
}

fn workspace_path(root: &Path, real_root: &Path, path: &Path) -> Result<PathBuf, String> {
    let relative = path
        .strip_prefix(root)
        .map_err(|_| "路径不在当前工作区内")?;
    for part in relative.components() {
        if !matches!(part, Component::Normal(name) if name.to_str().is_some_and(visible_name)) {
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
        if !visible_name(&name) {
            continue;
        }
        let kind = entry.file_type()?;
        let path = entry.path();
        if kind.is_dir() || kind.is_file() {
            entries.push(WorkspaceEntry {
                markdown: kind.is_file() && document_name(&path),
                path,
                name,
                directory: kind.is_dir(),
            });
        }
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
    let settings = workspace_preference(&app)?;
    tokio::task::spawn_blocking(move || {
        let _locked = FILE_OPERATION.lock().map_err(|err| err.to_string())?;
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
        || !visible_name(name)
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
) -> Result<(), String> {
    let root = selected_path(&app, root)?;
    let entry = selected_path(&app, path)?;
    tokio::task::spawn_blocking(move || {
        let real_root = root.canonicalize().map_err(|err| err.to_string())?;
        let path = workspace_path(&root, &real_root, &entry)?;
        if !path.is_file() {
            return Err("请选择文件".into());
        }
        open::that(path).map_err(|err| err.to_string())
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

fn moved_path(path: &Path, source: &Path, destination: &Path) -> Option<PathBuf> {
    let suffix = path.strip_prefix(source).ok()?;
    Some(if suffix.as_os_str().is_empty() {
        destination.to_owned()
    } else {
        destination.join(suffix)
    })
}

fn related_edits(
    root: &Path,
    source: &Path,
    destination: &Path,
    directory: bool,
) -> Result<Vec<Edit>, String> {
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
            if !entry.markdown || (!directory && before_path == source) {
                continue;
            }
            let after_path = moved_path(&before_path, source, destination)
                .unwrap_or_else(|| before_path.clone());
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
                rebased_link(
                    href,
                    &folder,
                    after_path.parent().unwrap(),
                    source,
                    destination,
                )
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

fn move_document(
    source: &Path,
    destination: &Path,
    edits: &[Edit],
    find_attachment: impl Fn(&Path, &Path) -> Result<PathBuf, String>,
) -> Result<(), String> {
    let before = fs::read_to_string(source).map_err(|err| format!("无法读取 Markdown：{err}"))?;
    let links = links(&before);
    let plan = plan_transfer(source, destination, references(&links), &find_attachment)?;
    if copy_with_hash(before.as_bytes(), io::sink())? != plan.source_hash {
        return Err("源文档已被其他程序修改，请重试".into());
    }
    let updated = rewrite(&before, &links, |href| Ok(plan.rewrites.get(href).cloned()))?;
    apply_edits(edits)?;
    commit_transfer_locked(
        source,
        destination,
        updated.as_deref().unwrap_or(&before),
        plan,
        true,
        find_attachment,
    )
    .map_err(|err| report_rollback(err, undo_edits(edits)))
}

fn move_entry(
    root: &Path,
    real_root: &Path,
    source: &Path,
    target: &Path,
    name: Option<&str>,
    active_document: Option<&Path>,
    find_attachment: impl Fn(&Path, &Path) -> Result<PathBuf, String>,
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
    if !kind.is_dir() && (!kind.is_file() || !document_name(&source)) {
        return Err("只能移动文件夹或 Markdown 文档".into());
    }
    if target.starts_with(&source) {
        return Err("不能将文件夹移动到自身或其子目录".into());
    }
    let destination = match name {
        None => target.join(source.file_name().unwrap()),
        Some(name) => {
            let leaf = Path::new(name);
            if kind.is_dir()
                || leaf.file_name() != Some(leaf.as_os_str())
                || !visible_name(name)
                || !document_name(leaf)
            {
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
    let edits = related_edits(real_root, &source, &destination, kind.is_dir())?;
    let active_document = active
        .as_deref()
        .and_then(|path| {
            moved_path(path, &source, &destination).or_else(|| {
                edits
                    .iter()
                    .find(|edit| edit.before_path == path)
                    .map(|edit| edit.after_path.clone())
            })
        })
        .as_deref()
        .map(display);

    if kind.is_dir() {
        move_directory(&source, &destination, &edits)?;
    } else {
        move_document(&source, &destination, &edits, find_attachment)?;
    }
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
            |base, path| attachment_file(&app, base, path),
        )
    })
    .await
    .map_err(|err| err.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

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
            |base, relative| {
                base.join(relative)
                    .canonicalize()
                    .map_err(|err| err.to_string())
            },
        )
    }

    #[test]
    fn a_directory_query_is_shallow_and_hides_assets_and_hidden_entries() {
        let dir = fixture();
        let root = dir.path();
        fs::write(root.join("首页.markdown"), "Home").unwrap();
        fs::write(root.join("附件.pdf"), b"PDF").unwrap();
        fs::write(root.join("起点/Note.md"), "Nested").unwrap();
        fs::create_dir(root.join(".hidden")).unwrap();
        let root_entries = list_entries(root).unwrap();
        assert_eq!(root_entries.len(), 4);
        assert!(root_entries[..2].iter().all(|entry| entry.directory));
        assert!(root_entries
            .iter()
            .any(|entry| entry.name == "首页.markdown" && entry.markdown));
        assert!(root_entries
            .iter()
            .any(|entry| entry.name == "附件.pdf" && !entry.markdown && !entry.directory));
        let source = list_entries(&root.join("起点")).unwrap();
        assert_eq!(source.len(), 1);
        assert_eq!(source[0].name, "Note.md");
        assert!(list_entries(&root.join("目标/子目录")).unwrap().is_empty());
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
        assert!(create_entry(Some(&root), &root, &nested, "assets", true).is_err());
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
    fn moves_an_unopened_markdown_verbatim_except_link_targets_and_merges_assets() {
        let dir = fixture();
        let root = dir.path();
        fs::write(root.join("起点/assets/图 一.png"), b"same picture").unwrap();
        fs::write(root.join("起点/assets/also.png"), b"same picture").unwrap();
        fs::write(root.join("起点/assets/report.pdf"), b"source report").unwrap();
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
        let hash = copy_with_hash(b"source report".as_slice(), io::sink()).unwrap();
        let expected = before
            .replace("./assets/also.png", "assets/existing%20image.png")
            .replace(
                "assets/%E5%9B%BE%20%E4%B8%80.png",
                "assets/existing%20image.png",
            )
            .replace("assets/report.pdf?", &format!("assets/{hash}.pdf?"))
            .replace("./Guide.md", "../../%E8%B5%B7%E7%82%B9/Guide.md");
        assert_eq!(actual, expected);
        assert_eq!(
            fs::read_dir(root.join("目标/子目录/assets"))
                .unwrap()
                .count(),
            3
        );
        assert_eq!(
            fs::read(root.join(format!("目标/子目录/assets/{hash}.pdf"))).unwrap(),
            b"source report"
        );
        assert_eq!(
            fs::read(root.join("目标/子目录/assets/report.pdf")).unwrap(),
            b"different report"
        );
        assert_eq!(
            fs::read(root.join("起点/assets/also.png")).unwrap(),
            b"same picture"
        );
        assert_eq!(fs::read_to_string(root.join("Home.md")).unwrap(),
            "[go](%E7%9B%AE%E6%A0%87/%E5%AD%90%E7%9B%AE%E5%BD%95/Note.md#h) [image](起点/assets/also.png)");
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
            |base, path| {
                base.join(path)
                    .canonicalize()
                    .map_err(|err| err.to_string())
            },
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
