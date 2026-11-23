use std::{fs, io, path::Path, process::Command};
use tauri::Url;

const SETTINGS: &str = "onebox-proxy";
const LOOPBACK: &str = "localhost,127.0.0.1,::1";

#[derive(Clone, serde::Serialize)]
pub struct NetworkInfo {
    pub custom: Option<String>,
    pub source: &'static str,
    pub endpoint: Option<String>,
}

pub struct Network {
    pub info: NetworkInfo,
    http: Option<String>,
    https: Option<String>,
    all: Option<String>,
    bypass: String,
}

fn proxy_url(value: &str) -> Option<Url> {
    let url = if value.contains("://") {
        Url::parse(value)
    } else {
        Url::parse(&format!("http://{value}"))
    }
    .ok()?;
    if matches!(url.scheme(), "http" | "https" | "socks5" | "socks5h")
        && url.host().is_some()
        && url.port_or_known_default().is_some()
        && url.username().is_empty()
        && url.password().is_none()
        && matches!(url.path(), "" | "/")
        && url.query().is_none()
        && url.fragment().is_none()
    {
        Some(url)
    } else {
        None
    }
}

pub fn save(home: &Path, custom: Option<&str>) -> Result<Network, String> {
    let path = home.join(SETTINGS);
    let custom = custom
        .map(|value| {
            proxy_url(value.trim())
                .map(|url| url.to_string())
                .ok_or("请输入代理地址，例如 http://127.0.0.1:7890 或 socks5h://127.0.0.1:7891。")
        })
        .transpose()?;
    if let Some(value) = &custom {
        fs::create_dir_all(home).map_err(|e| e.to_string())?;
        let mut file = tempfile::NamedTempFile::new_in(home).map_err(|e| e.to_string())?;
        io::Write::write_all(&mut file, value.as_bytes()).map_err(|e| e.to_string())?;
        file.persist(path).map_err(|e| e.to_string())?;
    } else if let Err(error) = fs::remove_file(path) {
        if error.kind() != io::ErrorKind::NotFound {
            return Err(error.to_string());
        }
    }
    Ok(Network::resolve(custom))
}

pub fn load(home: &Path) -> Network {
    let custom = fs::read_to_string(home.join(SETTINGS))
        .ok()
        .and_then(|value| proxy_url(value.trim()))
        .map(|url| url.to_string());
    Network::resolve(custom)
}

fn env_value(upper: &str, lower: &str) -> Option<String> {
    [upper, lower]
        .into_iter()
        .filter_map(|key| std::env::var(key).ok())
        .find(|value| !value.is_empty())
}

fn display_endpoint(value: &str) -> Option<String> {
    let url = Url::parse(value).ok()?;
    Some(format!(
        "{}://{}:{}",
        url.scheme(),
        url.host()?,
        url.port_or_known_default()?
    ))
}

impl Network {
    fn resolve(custom: Option<String>) -> Self {
        if let Some(url) = &custom {
            return Self::new(
                "custom",
                custom.clone(),
                Some(url.clone()),
                Some(url.clone()),
                Some(url.clone()),
                "",
            );
        }
        #[cfg(target_os = "macos")]
        if let Some(system) = mac_system_settings() {
            return system;
        }

        let http = env_value("HTTP_PROXY", "http_proxy");
        let https = env_value("HTTPS_PROXY", "https_proxy");
        let all = env_value("ALL_PROXY", "all_proxy");
        let bypass = env_value("NO_PROXY", "no_proxy").unwrap_or_default();
        let source = if http.is_some() || https.is_some() || all.is_some() {
            "environment"
        } else {
            "default"
        };
        Self::new(source, None, http, https, all, &bypass)
    }

    fn new(
        source: &'static str,
        custom: Option<String>,
        http: Option<String>,
        https: Option<String>,
        all: Option<String>,
        bypass: &str,
    ) -> Self {
        let endpoint = https
            .as_deref()
            .or(all.as_deref())
            .and_then(display_endpoint);
        let bypass = if bypass.is_empty() {
            LOOPBACK.into()
        } else {
            format!("{LOOPBACK},{bypass}")
        };
        Self {
            info: NetworkInfo {
                custom,
                source,
                endpoint,
            },
            http,
            https,
            all,
            bypass,
        }
    }

    pub fn apply(&self, command: &mut Command) {
        for (upper, lower, value) in [
            ("HTTP_PROXY", "http_proxy", &self.http),
            ("HTTPS_PROXY", "https_proxy", &self.https),
            ("ALL_PROXY", "all_proxy", &self.all),
        ] {
            if let Some(value) = value {
                command.env(upper, value).env(lower, value);
            }
        }
        command
            .env("NO_PROXY", &self.bypass)
            .env("no_proxy", &self.bypass);
    }
}

#[cfg(target_os = "macos")]
fn mac_system_settings() -> Option<Network> {
    let output = Command::new("/usr/sbin/scutil")
        .arg("--proxy")
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    parse_mac_proxy(std::str::from_utf8(&output.stdout).ok()?)
}

#[cfg(target_os = "macos")]
fn parse_mac_proxy(settings: &str) -> Option<Network> {
    let value = |name: &str| {
        settings
            .lines()
            .filter_map(|line| line.trim().split_once(" : "))
            .find_map(|(key, value)| (key == name).then_some(value.trim()))
    };
    let address = |enable, host, port, scheme| -> Option<String> {
        if value(enable) != Some("1") {
            return None;
        }
        let host = value(host)?;
        let host = if host.parse::<std::net::Ipv6Addr>().is_ok() {
            format!("[{host}]")
        } else {
            host.to_owned()
        };
        let port = value(port)?.parse::<u16>().ok().filter(|port| *port > 0)?;
        proxy_url(&format!("{scheme}://{host}:{port}")).map(|url| url.to_string())
    };
    let http = address("HTTPEnable", "HTTPProxy", "HTTPPort", "http");
    let https = address("HTTPSEnable", "HTTPSProxy", "HTTPSPort", "http");
    let all = address("SOCKSEnable", "SOCKSProxy", "SOCKSPort", "socks5h");
    if http.is_none() && https.is_none() && all.is_none() {
        return None;
    }
    let bypass = settings
        .lines()
        .skip_while(|line| !line.trim_start().starts_with("ExceptionsList : "))
        .skip(1)
        .take_while(|line| line.trim() != "}")
        .filter_map(|line| {
            let (index, name) = line.trim().split_once(" : ")?;
            index.parse::<usize>().ok()?;
            Some(name.trim().strip_prefix('*').unwrap_or(name.trim()))
        })
        .collect::<Vec<_>>()
        .join(",");
    Some(Network::new("system", None, http, https, all, &bypass))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_and_persists_custom_proxy_without_exposing_credentials() {
        let home = tempfile::tempdir().unwrap();
        assert!(save(home.path(), Some("http://user:secret@localhost:7890")).is_err());
        let saved = save(home.path(), Some("127.0.0.1:7890")).unwrap();
        assert_eq!(
            saved.info.endpoint.as_deref(),
            Some("http://127.0.0.1:7890")
        );
        assert_eq!(load(home.path()).info.custom, saved.info.custom);
        assert!(saved.bypass.contains("127.0.0.1"));
        assert_eq!(
            display_endpoint("http://user:secret@localhost:7890").as_deref(),
            Some("http://localhost:7890")
        );
        save(home.path(), None).unwrap();
        assert!(load(home.path()).info.custom.is_none());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn reads_enabled_mac_proxies_and_exclusions() {
        let route = parse_mac_proxy("<dictionary> {\n HTTPSPort : 7890\n HTTPSEnable : 1\n HTTPSProxy : 127.0.0.1\n HTTPEnable : 0\n ExceptionsList : <array> {\n 0 : *.local\n }\n}").unwrap();
        assert_eq!(route.info.source, "system");
        assert_eq!(
            route.info.endpoint.as_deref(),
            Some("http://127.0.0.1:7890")
        );
        assert!(route.http.is_none());
        assert!(route.bypass.ends_with(",.local"));
        assert!(parse_mac_proxy("<dictionary> {\n}").is_none());
    }
}
