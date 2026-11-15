use crate::fs::selected_path;
use percent_encoding::{percent_decode_str, utf8_percent_encode, NON_ALPHANUMERIC};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, File},
    io::{self, Read, Write},
    path::{Component, Path, PathBuf},
    sync::Mutex,
};
use tauri::{
    ipc::{InvokeBody, Request, Response},
    AppHandle,
};
use tauri_plugin_fs::FsExt;

static FILE_OPERATION: Mutex<()> = Mutex::new(());

fn parent(file: &Path) -> Result<PathBuf, String> {
    file.parent()
        .ok_or("missing parent directory")?
        .canonicalize()
        .map_err(|err| err.to_string())
}

fn relative_href(href: &str) -> Option<(String, &str)> {
    let end = href.find(['#', '?']).unwrap_or(href.len());
    let path = percent_decode_str(&href[..end]).decode_utf8().ok()?;
    if path.is_empty()
        || path.starts_with('/')
        || path.contains([':', '\\'])
        || path.chars().any(char::is_control)
    {
        return None;
    }
    Some((path.into_owned(), &href[end..]))
}

fn document_name(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| {
            ["md", "markdown"]
                .iter()
                .any(|md| ext.eq_ignore_ascii_case(md))
        })
}

fn checked_file(path: &Path) -> Result<File, String> {
    if !path.metadata().map_err(|err| err.to_string())?.is_file() {
        return Err("expected a regular file".into());
    }
    File::open(path).map_err(|err| err.to_string())
}

fn attachment_file(app: &AppHandle, base: &Path, path: &Path) -> Result<PathBuf, String> {
    let actual = base
        .join(path)
        .canonicalize()
        .map_err(|err| err.to_string())?;
    if !actual.starts_with(base) && !app.fs_scope().is_allowed(&actual) {
        return Err("attachment is outside the document or selected workspace".into());
    }
    if !actual.is_file() {
        return Err("expected a regular attachment file".into());
    }
    Ok(actual)
}

fn asset_directory(base: &Path) -> Result<PathBuf, String> {
    let path = base.join("assets");
    match fs::create_dir(&path) {
        Ok(()) => {}
        Err(err) if err.kind() == io::ErrorKind::AlreadyExists => {}
        Err(err) => return Err(err.to_string()),
    }
    if !fs::symlink_metadata(&path)
        .map_err(|err| err.to_string())?
        .is_dir()
    {
        return Err("assets must be a directory beside the document".into());
    }
    Ok(path)
}

fn extension(path: &Path) -> String {
    path.extension()
        .and_then(|value| value.to_str())
        .filter(|value| value.len() <= 16 && value.bytes().all(|byte| byte.is_ascii_alphanumeric()))
        .unwrap_or_default()
        .to_ascii_lowercase()
}

fn image_extension(ext: &str) -> bool {
    matches!(
        ext,
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "avif" | "bmp" | "svg" | "ico"
    )
}

fn copy_with_hash(mut reader: impl Read, mut writer: impl Write) -> Result<String, String> {
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let count = reader.read(&mut buffer).map_err(|err| err.to_string())?;
        if count == 0 {
            break;
        }
        writer
            .write_all(&buffer[..count])
            .map_err(|err| err.to_string())?;
        hash.update(&buffer[..count]);
    }
    Ok(format!("{:x}", hash.finalize()))
}

fn hash_name(hash: &str, ext: &str) -> String {
    if ext.is_empty() {
        hash.to_owned()
    } else {
        format!("{hash}.{ext}")
    }
}

fn persist_asset(
    staged: tempfile::NamedTempFile,
    target: &Path,
    expected_hash: &str,
) -> Result<bool, String> {
    staged.as_file().sync_all().map_err(|err| err.to_string())?;
    match staged.persist_noclobber(target) {
        Ok(_) => Ok(true),
        Err(err) if err.error.kind() == io::ErrorKind::AlreadyExists => {
            let metadata = fs::symlink_metadata(target).map_err(|err| err.to_string())?;
            if !metadata.is_file()
                || copy_with_hash(checked_file(target)?, io::sink())? != expected_hash
            {
                return Err("an attachment at the destination has different content".into());
            }
            Ok(false)
        }
        Err(err) => Err(err.to_string()),
    }
}

#[derive(Serialize)]
pub(crate) struct Attachment {
    href: String,
    name: String,
    image: bool,
}

fn import(base: &Path, reader: impl Read, name: &str) -> Result<Attachment, String> {
    let _locked = FILE_OPERATION.lock().map_err(|err| err.to_string())?;
    let assets = asset_directory(base)?;
    let ext = extension(Path::new(name));
    let mut staged = tempfile::NamedTempFile::new_in(&assets).map_err(|err| err.to_string())?;
    let hash = copy_with_hash(reader, &mut staged)?;
    let filename = hash_name(&hash, &ext);
    persist_asset(staged, &assets.join(&filename), &hash)?;
    Ok(Attachment {
        href: format!("assets/{filename}"),
        name: name.to_owned(),
        image: image_extension(&ext),
    })
}

#[tauri::command]
pub(crate) async fn import_attachment(
    app: AppHandle,
    document: String,
    source: String,
) -> Result<Attachment, String> {
    let document = selected_path(&app, document)?;
    let source = selected_path(&app, source)?;
    tokio::task::spawn_blocking(move || {
        let name = source
            .file_name()
            .ok_or("attachment has no name")?
            .to_string_lossy();
        import(&parent(&document)?, checked_file(&source)?, &name)
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
pub(crate) async fn import_inline_attachment(
    app: AppHandle,
    request: Request<'_>,
) -> Result<Attachment, String> {
    fn header(request: &Request<'_>, key: &str) -> Result<String, String> {
        let value = request
            .headers()
            .get(key)
            .ok_or_else(|| format!("missing {key}"))?
            .to_str()
            .map_err(|err| err.to_string())?;
        percent_decode_str(value)
            .decode_utf8()
            .map(|value| value.into_owned())
            .map_err(|err| err.to_string())
    }
    let document = selected_path(&app, header(&request, "x-onebox-document")?)?;
    let name = header(&request, "x-onebox-filename")?;
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected attachment bytes".into());
    };
    let bytes = bytes.clone();
    tokio::task::spawn_blocking(move || import(&parent(&document)?, bytes.as_slice(), &name))
        .await
        .map_err(|err| err.to_string())?
}

#[tauri::command]
pub(crate) async fn read_image(
    app: AppHandle,
    document: String,
    href: String,
) -> Result<Response, String> {
    let document = selected_path(&app, document)?;
    tokio::task::spawn_blocking(move || {
        let (relative, _) = relative_href(&href).ok_or("expected a relative path")?;
        let actual = attachment_file(&app, &parent(&document)?, Path::new(&relative))?;
        if !image_extension(&extension(&actual)) {
            return Err("unsupported image extension".into());
        }
        fs::read(actual)
            .map(Response::new)
            .map_err(|err| err.to_string())
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
pub(crate) async fn open_relative_attachment(
    app: AppHandle,
    document: String,
    href: String,
) -> Result<(), String> {
    let document = selected_path(&app, document)?;
    tokio::task::spawn_blocking(move || {
        let (relative, _) = relative_href(&href).ok_or("expected a relative path")?;
        let actual = attachment_file(&app, &parent(&document)?, Path::new(&relative))?;
        open::that(actual).map_err(|err| err.to_string())
    })
    .await
    .map_err(|err| err.to_string())?
}

#[derive(Deserialize)]
pub(crate) struct Reference {
    href: String,
    image: bool,
}

#[derive(Deserialize, Serialize)]
pub(crate) struct AssetCopy {
    source: String,
    name: String,
    hash: String,
}

#[derive(Serialize, Default)]
pub(crate) struct TransferPlan {
    rewrites: BTreeMap<String, String>,
    assets: Vec<AssetCopy>,
    source_hash: String,
}

fn normalize(path: &Path) -> PathBuf {
    let mut result = PathBuf::new();
    for part in path.components() {
        match part {
            Component::CurDir => {}
            Component::ParentDir => {
                result.pop();
            }
            _ => result.push(part),
        }
    }
    result
}

fn relative_link(base: &Path, target: &Path) -> Result<String, String> {
    let base: Vec<_> = base.components().collect();
    let target: Vec<_> = target.components().collect();
    let common = base.iter().zip(&target).take_while(|(a, b)| a == b).count();
    if common == 0 {
        return Err("a relative link cannot span these filesystem roots".into());
    }
    let mut parts = vec!["..".to_owned(); base.len() - common];
    for part in &target[common..] {
        let value = part.as_os_str().to_str().ok_or("invalid UTF-8 link path")?;
        parts.push(
            utf8_percent_encode(value, NON_ALPHANUMERIC)
                .to_string()
                .replace("%2D", "-")
                .replace("%2E", ".")
                .replace("%5F", "_"),
        );
    }
    Ok(if parts.is_empty() {
        "./".into()
    } else {
        parts.join("/")
    })
}

fn plan_transfer(
    source: &Path,
    destination: &Path,
    refs: Vec<Reference>,
    find_attachment: impl Fn(&Path, &Path) -> Result<PathBuf, String>,
) -> Result<TransferPlan, String> {
    let from = parent(source)?;
    let to = parent(destination)?;
    let mut plan = TransferPlan {
        source_hash: copy_with_hash(checked_file(source)?, io::sink())?,
        ..TransferPlan::default()
    };
    let source_here = from.join(source.file_name().ok_or("missing source name")?);
    let destination_here = to.join(destination.file_name().ok_or("missing destination name")?);
    let mut copies = BTreeSet::new();
    for reference in refs {
        let Some((relative, suffix)) = relative_href(&reference.href) else {
            continue;
        };
        let relative = Path::new(&relative);
        let candidate = normalize(&from.join(relative));
        if candidate == source_here {
            let rewritten = format!("{}{suffix}", relative_link(&to, &destination_here)?);
            if rewritten != reference.href {
                plan.rewrites.insert(reference.href, rewritten);
            }
            continue;
        }
        if from == to {
            continue;
        }
        let is_asset = reference.image
            || relative.starts_with("assets")
            || (!document_name(relative) && candidate.is_file());
        let rewritten = if is_asset {
            let actual = find_attachment(&from, relative)?;
            let hash = copy_with_hash(checked_file(&actual)?, io::sink())?;
            let name = hash_name(&hash, &extension(relative));
            if copies.insert(name.clone()) {
                plan.assets.push(AssetCopy {
                    source: relative
                        .to_str()
                        .ok_or("invalid attachment path")?
                        .to_owned(),
                    name: name.clone(),
                    hash,
                });
            }
            format!("assets/{name}{suffix}")
        } else {
            format!("{}{suffix}", relative_link(&to, &candidate)?)
        };
        if rewritten != reference.href {
            plan.rewrites.insert(reference.href, rewritten);
        }
    }
    Ok(plan)
}

#[tauri::command]
pub(crate) async fn plan_document_transfer(
    app: AppHandle,
    source: String,
    destination: String,
    refs: Vec<Reference>,
) -> Result<TransferPlan, String> {
    let source = selected_path(&app, source)?;
    let destination = selected_path(&app, destination)?;
    tokio::task::spawn_blocking(move || {
        plan_transfer(&source, &destination, refs, |base, path| {
            attachment_file(&app, base, path)
        })
    })
    .await
    .map_err(|err| err.to_string())?
}

fn commit_transfer(
    source: &Path,
    destination: &Path,
    content: &str,
    plan: TransferPlan,
    move_original: bool,
    find_attachment: impl Fn(&Path, &Path) -> Result<PathBuf, String>,
) -> Result<(), String> {
    let _locked = FILE_OPERATION.lock().map_err(|err| err.to_string())?;
    if !document_name(destination) {
        return Err("choose a Markdown destination".into());
    }
    if fs::symlink_metadata(destination).is_ok() {
        return Err("a document already exists at the destination".into());
    }
    let source_parent = parent(source)?;
    let destination_parent = parent(destination)?;
    let mut created = Vec::new();
    let result = (|| {
        if !plan.assets.is_empty() {
            let assets = asset_directory(&destination_parent)?;
            for copy in plan.assets {
                let path = Path::new(&copy.source);
                // The destination can only be a content-addressed file in assets/.
                if copy.hash.len() != 64
                    || !copy.hash.bytes().all(|byte| byte.is_ascii_hexdigit())
                    || copy.name != hash_name(&copy.hash, &extension(path))
                    || path.is_absolute()
                {
                    return Err("invalid attachment transfer".into());
                }
                let actual = find_attachment(&source_parent, path)?;
                let mut staged =
                    tempfile::NamedTempFile::new_in(&assets).map_err(|err| err.to_string())?;
                if copy_with_hash(checked_file(&actual)?, &mut staged)? != copy.hash {
                    return Err(
                        "the attachment changed while the document was being transferred".into(),
                    );
                }
                let target = assets.join(copy.name);
                if persist_asset(staged, &target, &copy.hash)? {
                    created.push(target);
                }
            }
        }
        let mut staged =
            tempfile::NamedTempFile::new_in(&destination_parent).map_err(|err| err.to_string())?;
        staged
            .write_all(content.as_bytes())
            .map_err(|err| err.to_string())?;
        staged.as_file().sync_all().map_err(|err| err.to_string())?;
        staged
            .persist_noclobber(destination)
            .map_err(|err| err.to_string())?;
        created.push(destination.to_owned());
        if move_original {
            if copy_with_hash(checked_file(source)?, io::sink())? != plan.source_hash {
                return Err("the source document changed while it was being moved".into());
            }
            fs::remove_file(source).map_err(|err| err.to_string())?;
        }
        Ok(())
    })();
    if result.is_err() {
        for path in created.into_iter().rev() {
            let _ = fs::remove_file(path);
        }
    }
    result
}

#[tauri::command]
pub(crate) async fn transfer_document(
    app: AppHandle,
    source: String,
    destination: String,
    content: String,
    assets: Vec<AssetCopy>,
    source_hash: String,
    move_original: bool,
) -> Result<(), String> {
    let source = selected_path(&app, source)?;
    let destination = selected_path(&app, destination)?;
    let plan = TransferPlan {
        assets,
        source_hash,
        ..TransferPlan::default()
    };
    tokio::task::spawn_blocking(move || {
        commit_transfer(
            &source,
            &destination,
            &content,
            plan,
            move_original,
            |base, path| attachment_file(&app, base, path),
        )
    })
    .await
    .map_err(|err| err.to_string())?
}

#[derive(Serialize)]
pub(crate) struct WorkspaceDocument {
    path: String,
    name: String,
}

fn scan_workspace(path: &Path) -> io::Result<Vec<WorkspaceDocument>> {
    let mut documents = Vec::new();
    let mut folders = vec![path.to_owned()];
    while let Some(folder) = folders.pop() {
        for entry in fs::read_dir(folder)? {
            let entry = entry?;
            let kind = entry.file_type()?;
            let entry_path = entry.path();
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name.starts_with('.') || name.eq_ignore_ascii_case("assets") {
                continue;
            }
            if kind.is_dir() {
                folders.push(entry_path);
            } else if kind.is_file() && document_name(&entry_path) {
                documents.push(WorkspaceDocument {
                    name: entry_path
                        .strip_prefix(path)
                        .unwrap()
                        .to_string_lossy()
                        .into_owned(),
                    path: entry_path.to_string_lossy().into_owned(),
                });
            }
        }
    }
    documents.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(documents)
}

#[tauri::command]
pub(crate) async fn workspace_documents(
    app: AppHandle,
    path: String,
) -> Result<Vec<WorkspaceDocument>, String> {
    let path = selected_path(&app, path)?;
    tokio::task::spawn_blocking(move || scan_workspace(&path).map_err(|err| err.to_string()))
        .await
        .map_err(|err| err.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn find_asset(base: &Path, path: &Path) -> Result<PathBuf, String> {
        base.join(path)
            .canonicalize()
            .map_err(|err| err.to_string())
    }

    #[test]
    fn deduplicates_assets_and_hides_the_directory_from_workspace() {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path();
        let first = import(base, b"one".as_slice(), "foo.PNG").unwrap();
        let same = import(base, b"one".as_slice(), "another.png").unwrap();
        let second = import(base, b"two".as_slice(), "foo.png").unwrap();
        assert_eq!(first.href, same.href);
        assert_ne!(first.href, second.href);
        assert!(first.image);
        fs::write(base.join("Doc.md"), "# Doc").unwrap();
        fs::write(base.join("assets/hidden.md"), "hidden").unwrap();
        let names = scan_workspace(base).unwrap();
        assert_eq!(names.len(), 1);
        assert_eq!(names[0].name, "Doc.md");
    }

    #[test]
    fn move_copies_the_bytes_and_rebases_document_links() {
        let dir = tempfile::tempdir().unwrap();
        let from = dir.path().join("from");
        let to = dir.path().join("to");
        fs::create_dir(&from).unwrap();
        fs::create_dir(&to).unwrap();
        let source = from.join("Note.md");
        let dest = to.join("Renamed.md");
        fs::write(&source, "original").unwrap();
        let asset = import(&from, b"attachment".as_slice(), "data.pdf").unwrap();
        let refs = vec![
            Reference {
                href: asset.href.clone(),
                image: false,
            },
            Reference {
                href: "Other%20doc.md#heading".into(),
                image: false,
            },
        ];
        let plan = plan_transfer(&source, &dest, refs, find_asset).unwrap();
        assert_eq!(
            plan.rewrites["Other%20doc.md#heading"],
            "../from/Other%20doc.md#heading"
        );
        commit_transfer(
            &source,
            &dest,
            &format!("[Data]({})", asset.href),
            plan,
            true,
            find_asset,
        )
        .unwrap();
        assert!(!source.exists());
        assert_eq!(fs::read(to.join(&asset.href)).unwrap(), b"attachment");
        assert!(from.join(&asset.href).exists());
    }

    #[test]
    fn document_conflict_leaves_the_source_and_destination_intact() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("Source.md");
        let dest = dir.path().join("Existing.md");
        fs::write(&source, "source").unwrap();
        fs::write(&dest, "existing").unwrap();
        let plan = plan_transfer(&source, &dest, Vec::new(), find_asset).unwrap();
        assert!(commit_transfer(&source, &dest, "new", plan, true, find_asset).is_err());
        assert_eq!(fs::read_to_string(source).unwrap(), "source");
        assert_eq!(fs::read_to_string(dest).unwrap(), "existing");
    }

    #[test]
    fn rolls_back_a_move_if_the_source_changes_after_planning() {
        let dir = tempfile::tempdir().unwrap();
        let from = dir.path().join("from");
        let to = dir.path().join("to");
        fs::create_dir(&from).unwrap();
        fs::create_dir(&to).unwrap();
        let source = from.join("Original.md");
        let dest = to.join("Moved.md");
        fs::write(&source, "first version").unwrap();
        let asset = import(&from, b"keep me".as_slice(), "photo.png").unwrap();
        let plan = plan_transfer(
            &source,
            &dest,
            vec![Reference {
                href: asset.href.clone(),
                image: true,
            }],
            find_asset,
        )
        .unwrap();
        fs::write(&source, "external edit").unwrap();

        assert!(commit_transfer(&source, &dest, "stale", plan, true, find_asset).is_err());
        assert_eq!(fs::read_to_string(source).unwrap(), "external edit");
        assert!(from.join(&asset.href).exists());
        assert!(!to.join(&asset.href).exists());
        assert!(!dest.exists());
    }
}
