use std::process::Command;
#[cfg(target_os = "macos")]
use tauri::Url;

const LOOPBACK: &str = "localhost,127.0.0.1,::1";

pub struct Network {
    http: Option<String>,
    https: Option<String>,
    all: Option<String>,
    bypass: String,
}

#[cfg(target_os = "macos")]
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

fn env_value(upper: &str, lower: &str) -> Option<String> {
    [upper, lower]
        .into_iter()
        .filter_map(|key| std::env::var(key).ok())
        .find(|value| !value.is_empty())
}

impl Network {
    pub fn resolve() -> Self {
        #[cfg(target_os = "macos")]
        if let Some(system) = mac_system_settings() {
            return system;
        }

        let http = env_value("HTTP_PROXY", "http_proxy");
        let https = env_value("HTTPS_PROXY", "https_proxy");
        let all = env_value("ALL_PROXY", "all_proxy");
        let bypass = env_value("NO_PROXY", "no_proxy").unwrap_or_default();
        Self::new(http, https, all, &bypass)
    }

    fn new(http: Option<String>, https: Option<String>, all: Option<String>, bypass: &str) -> Self {
        let bypass = if bypass.is_empty() {
            LOOPBACK.into()
        } else {
            format!("{LOOPBACK},{bypass}")
        };
        Self {
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
    Some(Network::new(http, https, all, &bypass))
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;

    #[test]
    fn reads_enabled_mac_proxies_and_exclusions() {
        let route = parse_mac_proxy("<dictionary> {\n HTTPSPort : 7890\n HTTPSEnable : 1\n HTTPSProxy : 127.0.0.1\n HTTPEnable : 0\n ExceptionsList : <array> {\n 0 : *.local\n }\n}").unwrap();
        let mut command = Command::new("codex");
        route.apply(&mut command);
        let env = |key| {
            command
                .get_envs()
                .find(|(name, _)| *name == key)
                .and_then(|(_, value)| value?.to_str())
        };
        assert_eq!(env("HTTP_PROXY"), None);
        assert_eq!(env("HTTPS_PROXY"), Some("http://127.0.0.1:7890/"));
        assert_eq!(env("NO_PROXY"), Some("localhost,127.0.0.1,::1,.local"));
        assert!(parse_mac_proxy("<dictionary> {\n}").is_none());
    }
}
