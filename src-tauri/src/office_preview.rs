use std::{
    env,
    fs::{self, File},
    io::Read,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::LazyLock,
    thread,
    time::{Duration, Instant},
};
use tauri::Url;
use tokio::sync::Semaphore;

pub(crate) static CONVERTERS: LazyLock<Semaphore> = LazyLock::new(|| Semaphore::new(2));

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

pub(crate) fn render(path: &Path, extension: &str) -> Result<Vec<u8>, String> {
    const MAX_INPUT: u64 = 100 * 1024 * 1024;
    const MAX_PDF: u64 = 64 * 1024 * 1024;
    let metadata = fs::metadata(path).map_err(|err| err.to_string())?;
    if !metadata.is_file() || metadata.len() > MAX_INPUT {
        return Err("Office 文件超过 100 MiB 或不是普通文件".into());
    }
    let program = executable()
        .ok_or("Office 预览需要 LibreOffice。安装后可在此重试，或使用「打开方式」。")?;
    let scratch = tempfile::tempdir().map_err(|err| err.to_string())?;
    let profile_path = scratch.path().join("profile");
    let user = profile_path.join("user");
    fs::create_dir_all(&user).map_err(|err| err.to_string())?;
    // Use a fresh profile, with macros and automatic link updates disabled.
    fs::write(
        user.join("registrymodifications.xcu"),
        r#"<?xml version="1.0" encoding="UTF-8"?>
<oor:items xmlns:oor="http://openoffice.org/2001/registry">
<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="DisableMacrosExecution" oor:op="fuse"><value>true</value></prop></item>
<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="BlockUntrustedRefererLinks" oor:op="fuse"><value>true</value></prop></item>
<item oor:path="/org.openoffice.Office.Writer/Content/Update"><prop oor:name="Link" oor:op="fuse"><value>0</value></prop></item>
<item oor:path="/org.openoffice.Office.Calc/Content/Update"><prop oor:name="Link" oor:op="fuse"><value>1</value></prop></item>
</oor:items>"#,
    ).map_err(|err| err.to_string())?;
    let profile = Url::from_directory_path(&profile_path).map_err(|_| "无法准备 Office 预览")?;
    let source = scratch.path().join(format!("document.{extension}"));
    fs::copy(path, &source).map_err(|err| err.to_string())?;
    let (input_filter, pdf_filter) = match extension {
        "doc" => ("MS Word 97", "pdf:writer_pdf_Export"),
        "docx" => ("Office Open XML Text", "pdf:writer_pdf_Export"),
        "xls" => ("MS Excel 97", "pdf:calc_pdf_Export"),
        "xlsx" => ("Calc MS Excel 2007 XML", "pdf:calc_pdf_Export"),
        "ppt" => ("MS PowerPoint 97", "pdf:impress_pdf_Export"),
        "pptx" => ("Impress MS PowerPoint 2007 XML", "pdf:impress_pdf_Export"),
        _ => return Err("此 Office 格式不支持预览".into()),
    };
    let mut command = Command::new(program);
    #[cfg(target_os = "macos")]
    if env::var_os("FONTCONFIG_FILE").is_none() {
        // macOS headless builds may use Fontconfig instead of Core Text.
        // Give the converter access to local fonts and a CJK fallback.
        let config = scratch.path().join("fonts.conf");
        fs::write(
            &config,
            r#"<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">
<fontconfig>
  <dir>/System/Library/Fonts</dir>
  <dir>/Library/Fonts</dir>
  <dir>~/Library/Fonts</dir>
  <cachedir prefix="xdg">fontconfig</cachedir>
  <match target="pattern">
    <test name="lang" compare="contains"><string>zh</string></test>
    <edit name="family" mode="append">
      <string>Hiragino Sans GB</string><string>Heiti SC</string><string>Songti SC</string>
    </edit>
  </match>
</fontconfig>"#,
        )
        .map_err(|err| err.to_string())?;
        command.env("FONTCONFIG_FILE", config);
    }
    command
        .arg(format!("-env:UserInstallation={profile}"))
        .arg(format!("--infilter={input_filter}"))
        .args([
            "--headless",
            "--nologo",
            "--norestore",
            "--convert-to",
            pdf_filter,
            "--outdir",
        ])
        .arg(scratch.path())
        .arg(source)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let mut child = command
        .spawn()
        .map_err(|err| format!("无法启动 LibreOffice：{err}"))?;
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => break,
            Ok(Some(_)) => return Err("LibreOffice 无法转换此文件".into()),
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(50)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("Office 预览转换超时，请重试或使用「打开方式」".into());
            }
        }
    }
    let pdf = File::open(scratch.path().join("document.pdf"))
        .map_err(|_| "无法生成预览。文件可能受密码保护或已损坏。")?;
    let mut bytes = Vec::new();
    pdf.take(MAX_PDF + 1)
        .read_to_end(&mut bytes)
        .map_err(|err| err.to_string())?;
    if bytes.len() as u64 > MAX_PDF {
        return Err("预览超过 64 MiB，请使用「打开方式」".into());
    }
    if !bytes.starts_with(b"%PDF-") {
        return Err("LibreOffice 未生成有效预览".into());
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[ignore = "requires a local LibreOffice installation"]
    fn renders_modern_and_legacy_office_samples() {
        let fixtures =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../examples/manual-testing/04 文件预览");
        for (name, extension) in [
            ("Word 多页文档", "docx"),
            ("Word 旧格式", "doc"),
            ("Excel 多工作表", "xlsx"),
            ("Excel 旧格式", "xls"),
            ("PowerPoint 三页幻灯片", "pptx"),
            ("PowerPoint 旧格式", "ppt"),
        ] {
            let path = fixtures.join(format!("{name}.{extension}"));
            let original = fs::read(&path).expect("read source");
            let pdf = render(&path, extension).unwrap_or_else(|err| panic!("{name}: {err}"));
            assert!(pdf.starts_with(b"%PDF-"), "{name}");
            assert_eq!(fs::read(&path).expect("read source again"), original);
        }
        assert!(render(&fixtures.join("损坏的 Office.docx"), "docx").is_err());
    }
}
