use std::{
    collections::HashMap,
    env,
    fs::{self, File},
    io::Read,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{LazyLock, Mutex},
    thread,
    time::{Duration, Instant},
};
use tauri::Url;
use tempfile::TempDir;
use tokio::sync::Semaphore;

static CONVERTERS: LazyLock<Semaphore> = LazyLock::new(|| Semaphore::new(2));
const MAX_PREVIEW_BYTES: u64 = 100 * 1024 * 1024;

#[derive(Default)]
pub(crate) struct TemporaryPreviews(Mutex<HashMap<PathBuf, TempDir>>);

impl TemporaryPreviews {
    pub(crate) fn retain(&self, path: PathBuf, directory: TempDir) -> Result<(), String> {
        self.0
            .lock()
            .map_err(|err| err.to_string())?
            .insert(path, directory);
        Ok(())
    }

    pub(crate) fn release(&self, path: &Path) {
        let directory = self
            .0
            .lock()
            .ok()
            .and_then(|mut previews| previews.remove(path));
        drop(directory);
    }
}

pub(crate) struct Format {
    extension: &'static str,
    filter: &'static str,
}

pub(crate) fn format(path: &Path) -> Option<Format> {
    let (extension, filter) = match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
        "wps" | "wpt" => ("docx", "docx:Office Open XML Text"),
        "et" | "ett" => ("xlsx", "xlsx:Calc MS Excel 2007 XML"),
        "dps" | "dpt" => ("pptx", "pptx:Impress MS PowerPoint 2007 XML"),
        _ => return None,
    };
    Some(Format { extension, filter })
}

fn executable() -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        let installed = PathBuf::from("/Applications/LibreOffice.app/Contents/MacOS/soffice");
        if installed.is_file() {
            return Some(installed);
        }
    }
    #[cfg(windows)]
    for key in ["ProgramFiles", "ProgramFiles(x86)"] {
        if let Some(dir) = env::var_os(key) {
            let installed = PathBuf::from(dir).join("LibreOffice/program/soffice.exe");
            if installed.is_file() {
                return Some(installed);
            }
        }
    }
    let name = if cfg!(windows) {
        "soffice.exe"
    } else {
        "soffice"
    };
    env::split_paths(&env::var_os("PATH")?)
        .filter(|dir| dir.is_absolute())
        .map(|dir| dir.join(name))
        .find(|file| file.is_file())
}

pub(crate) fn convert(path: &Path, format: Format) -> Result<(PathBuf, TempDir), String> {
    let _permit = CONVERTERS
        .try_acquire()
        .map_err(|_| "正在转换其他文件，请稍后重试。")?;
    let program = executable().ok_or("WPS 离线预览需要 LibreOffice。你也可以使用「打开方式」。")?;
    let source_file = File::open(path).map_err(|_| "无法读取 WPS 文件。")?;
    let scratch = tempfile::Builder::new()
        .prefix("onebox-wps-")
        .tempdir()
        .map_err(|_| "无法创建 WPS 预览目录。")?;
    let directory = scratch
        .path()
        .canonicalize()
        .map_err(|err| err.to_string())?;
    let source = directory
        .join("document")
        .with_extension(path.extension().unwrap_or_default());
    let mut copy = File::create(&source).map_err(|err| err.to_string())?;
    if std::io::copy(&mut source_file.take(MAX_PREVIEW_BYTES + 1), &mut copy)
        .map_err(|err| err.to_string())?
        > MAX_PREVIEW_BYTES
    {
        return Err("WPS 文件超过 100 MiB，请使用「打开方式」。".into());
    }
    drop(copy);

    // Keep conversion separate from any running LibreOffice session and its settings.
    let profile = directory.join("profile");
    let user = profile.join("user");
    fs::create_dir_all(&user).map_err(|err| err.to_string())?;
    fs::write(user.join("registrymodifications.xcu"), r#"<?xml version="1.0" encoding="UTF-8"?>
<oor:items xmlns:oor="http://openoffice.org/2001/registry">
<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="DisableMacrosExecution" oor:op="fuse"><value>true</value></prop></item>
<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="BlockUntrustedRefererLinks" oor:op="fuse"><value>true</value></prop></item>
<item oor:path="/org.openoffice.Office.Writer/Content/Update"><prop oor:name="Link" oor:op="fuse"><value>0</value></prop></item>
<item oor:path="/org.openoffice.Office.Calc/Content/Update"><prop oor:name="Link" oor:op="fuse"><value>1</value></prop></item>
</oor:items>"#).map_err(|err| err.to_string())?;
    let profile = Url::from_directory_path(profile).map_err(|_| "无法准备 WPS 预览。")?;
    let mut command = Command::new(program);
    command
        .arg(format!("-env:UserInstallation={profile}"))
        .args([
            "--headless",
            "--nologo",
            "--norestore",
            "--convert-to",
            format.filter,
            "--outdir",
        ])
        .arg(&directory)
        .arg(&source)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    let failure = "此 WPS 文件无法转换，请使用「打开方式」。";
    let mut child = command
        .spawn()
        .map_err(|_| "无法启动 LibreOffice，请使用「打开方式」。")?;
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => break,
            Ok(Some(_)) => return Err(failure.into()),
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(50)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("WPS 预览转换超时，请使用「打开方式」。".into());
            }
        }
    }
    let output = source.with_extension(format.extension);
    let mut result = File::open(&output).map_err(|_| failure)?;
    let mut signature = [0; 4];
    if result.metadata().map_err(|_| failure)?.len() > MAX_PREVIEW_BYTES
        || result.read_exact(&mut signature).is_err()
        || &signature != b"PK\x03\x04"
    {
        return Err(failure.into());
    }
    drop(result);
    let _ = fs::remove_file(source);
    Ok((output, scratch))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[ignore = "requires LibreOffice and WPS fixtures in ONEBOX_WPS_FIXTURES"]
    fn converts_wps_fixtures_and_removes_previews_on_release() {
        let fixtures = env::var_os("ONEBOX_WPS_FIXTURES").expect("set ONEBOX_WPS_FIXTURES");
        let previews = TemporaryPreviews::default();
        let mut count = 0;
        for entry in fs::read_dir(fixtures).expect("read sample directory") {
            let path = entry.expect("read fixture").path();
            let Some(format) = format(&path) else {
                continue;
            };
            let original = fs::read(&path).unwrap();
            let expected = format.extension;
            let (output, directory) =
                convert(&path, format).unwrap_or_else(|err| panic!("{path:?}: {err}"));
            assert_eq!(
                output.extension().and_then(|ext| ext.to_str()),
                Some(expected)
            );
            previews.retain(output.clone(), directory).unwrap();
            assert!(output.is_file());
            previews.release(&output);
            assert!(!output.exists());
            assert_eq!(fs::read(&path).unwrap(), original);
            count += 1;
        }
        assert!(count > 0, "no WPS fixtures found");
    }
}
