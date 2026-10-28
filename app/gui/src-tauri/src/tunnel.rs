use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use sysinfo::{Pid, System};

const HEALTH_ADDR: &str = "127.0.0.1:8080";
const HEALTH_PORT: u16 = 8080;

#[cfg(windows)]
fn hide_window(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    command.creation_flags(0x08000000);
}

#[cfg(not(windows))]
fn hide_window(_command: &mut Command) {}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelSnapshot {
    pub phase: String,
    pub connection: String,
    pub pid: Option<u32>,
    pub started_at_ms: Option<u64>,
    pub last_exit_code: Option<i32>,
    pub last_error: Option<String>,
}

struct Inner {
    child: Option<Child>,
    phase: String,
    connection: String,
    pid: Option<u32>,
    started_at_ms: Option<u64>,
    last_exit_code: Option<i32>,
    last_error: Option<String>,
}

impl Default for Inner {
    fn default() -> Self {
        Self {
            child: None,
            phase: "stopped".to_string(),
            connection: "unknown".to_string(),
            pid: None,
            started_at_ms: None,
            last_exit_code: None,
            last_error: None,
        }
    }
}

#[derive(Debug)]
struct PortOwner {
    pid: u32,
    executable: Option<PathBuf>,
    expected_toolhub_client: bool,
}

#[derive(Clone)]
pub struct TunnelManager {
    repo_root: PathBuf,
    config_path: PathBuf,
    inner: Arc<Mutex<Inner>>,
}

impl TunnelManager {
    pub fn new(repo_root: PathBuf, config_path: PathBuf) -> Self {
        let manager = Self {
            repo_root,
            config_path,
            inner: Arc::new(Mutex::new(Inner::default())),
        };
        manager.start_external_observer();
        manager
    }

    fn current_profile_name(&self) -> Result<String, String> {
        crate::config::load(&self.config_path).map(|config| config.tunnel.name)
    }

    fn profile_path(&self, profile: &str) -> Result<PathBuf, String> {
        let home = std::env::var_os("USERPROFILE")
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(PathBuf::from))
            .ok_or_else(|| "USERPROFILE/HOME is unavailable".to_string())?;
        Ok(home
            .join(".config")
            .join("tunnel-client")
            .join(format!("{profile}.yaml")))
    }

    fn expected_client_path(&self) -> PathBuf {
        self.repo_root
            .join(".toolhub")
            .join("bin")
            .join("tunnel-client.exe")
    }

    fn normalize_path(path: &Path) -> String {
        path.canonicalize()
            .unwrap_or_else(|_| path.to_path_buf())
            .to_string_lossy()
            .replace('/', "\\")
            .trim_start_matches(r"\\?\")
            .to_lowercase()
    }

    fn listener_pid() -> Option<u32> {
        let mut command = Command::new("netstat.exe");
        command.args(["-ano", "-p", "tcp"]);
        hide_window(&mut command);
        let output = command.output().ok()?;
        if !output.status.success() {
            return None;
        }

        for line in String::from_utf8_lossy(&output.stdout).lines() {
            let parts: Vec<&str> = line.split_whitespace().collect();
            if parts.len() < 5 || !parts[0].eq_ignore_ascii_case("TCP") {
                continue;
            }
            if !parts[3].eq_ignore_ascii_case("LISTENING") {
                continue;
            }
            let local = parts[1];
            let Some(colon) = local.rfind(':') else {
                continue;
            };
            let Ok(port) = local[colon + 1..].parse::<u16>() else {
                continue;
            };
            if port != HEALTH_PORT {
                continue;
            }
            if let Ok(pid) = parts[4].parse::<u32>() {
                return Some(pid);
            }
        }
        None
    }

    fn process_path(pid: u32) -> Option<PathBuf> {
        let mut system = System::new_all();
        system.refresh_all();
        system
            .process(Pid::from_u32(pid))
            .and_then(|process| process.exe())
            .map(Path::to_path_buf)
    }

    fn port_owner(&self) -> Option<PortOwner> {
        let pid = Self::listener_pid()?;
        let executable = Self::process_path(pid);
        let expected = executable.as_ref().is_some_and(|path| {
            Self::normalize_path(path) == Self::normalize_path(&self.expected_client_path())
        });
        Some(PortOwner {
            pid,
            executable,
            expected_toolhub_client: expected,
        })
    }

    fn health_ready() -> bool {
        let Ok(mut stream) = TcpStream::connect_timeout(
            &HEALTH_ADDR.parse().expect("static health address"),
            Duration::from_millis(350),
        ) else {
            return false;
        };
        let _ = stream.set_read_timeout(Some(Duration::from_millis(350)));
        let _ = stream.set_write_timeout(Some(Duration::from_millis(350)));
        if stream
            .write_all(b"GET /readyz HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
            .is_err()
        {
            return false;
        }
        let mut response = [0u8; 256];
        let Ok(count) = stream.read(&mut response) else {
            return false;
        };
        let head = String::from_utf8_lossy(&response[..count]);
        head.lines()
            .next()
            .is_some_and(|line| line.contains(" 200 "))
    }

    fn start_external_observer(&self) {
        let manager = self.clone();
        thread::Builder::new()
            .name("ToolHubTunnelObserver".to_string())
            .spawn(move || loop {
                thread::sleep(Duration::from_secs(2));

                let should_probe = {
                    let mut inner = manager.inner.lock().unwrap_or_else(|error| error.into_inner());
                    Self::refresh_locked(&mut inner);
                    inner.child.is_none() && inner.phase != "starting"
                };
                if !should_probe {
                    continue;
                }

                let owner = manager.port_owner();
                let mut inner = manager.inner.lock().unwrap_or_else(|error| error.into_inner());
                if inner.child.is_some() || inner.phase == "starting" {
                    continue;
                }

                match owner {
                    Some(owner) if owner.expected_toolhub_client => {
                        inner.phase = "external".to_string();
                        inner.connection = if Self::health_ready() {
                            "connected".to_string()
                        } else {
                            "degraded".to_string()
                        };
                        inner.pid = Some(owner.pid);
                        inner.started_at_ms = None;
                        inner.last_error = None;
                    }
                    Some(owner) => {
                        inner.phase = "blocked".to_string();
                        inner.connection = "degraded".to_string();
                        inner.pid = Some(owner.pid);
                        let executable = owner
                            .executable
                            .as_ref()
                            .map(|path| path.display().to_string())
                            .unwrap_or_else(|| "<unknown>".to_string());
                        inner.last_error = Some(format!(
                            "{HEALTH_ADDR} is owned by PID {} ({executable}), not ToolHub tunnel-client",
                            owner.pid
                        ));
                    }
                    None => {
                        if inner.phase == "external" || inner.phase == "blocked" {
                            inner.phase = "stopped".to_string();
                            inner.connection = "unknown".to_string();
                            inner.pid = None;
                            inner.last_error = None;
                        }
                    }
                }
            })
            .expect("failed to start tunnel observer");
    }

    fn ensure_profile(&self) -> Result<(), String> {
        let profile = self.current_profile_name()?;
        let profile_path = self.profile_path(&profile)?;
        let script = self.repo_root.join("scripts").join("init-tunnel.ps1");
        if !script.is_file() {
            return Err(format!("Tunnel init script not found: {}", script.display()));
        }

        log::info!(
            target: "toolhub::tunnel",
            "Refreshing tunnel profile {} at {}",
            profile,
            profile_path.display()
        );

        let mut command = Command::new("powershell.exe");
        command
            .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"])
            .arg(&script)
            .current_dir(&self.repo_root)
            .env("TOOLHUB_CONFIG", &self.config_path)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        hide_window(&mut command);

        let output = command
            .output()
            .map_err(|error| format!("Failed to start init-tunnel.ps1: {error}"))?;

        for line in String::from_utf8_lossy(&output.stdout).lines() {
            log::info!(target: "toolhub::tunnel", "{line}");
        }
        for line in String::from_utf8_lossy(&output.stderr).lines() {
            log::error!(target: "toolhub::tunnel", "{line}");
        }

        if !output.status.success() {
            return Err(format!(
                "init-tunnel.ps1 failed with exit code {:?}",
                output.status.code()
            ));
        }
        if !profile_path.is_file() {
            return Err(format!(
                "Tunnel profile init reported success but profile is still missing: {}",
                profile_path.display()
            ));
        }

        log::info!(
            target: "toolhub::tunnel",
            "Tunnel profile {} initialized successfully",
            profile
        );
        Ok(())
    }

    fn now_ms() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_millis().min(u64::MAX as u128) as u64)
            .unwrap_or(0)
    }

    fn refresh_locked(inner: &mut Inner) {
        let exit = inner
            .child
            .as_mut()
            .and_then(|child| child.try_wait().ok().flatten());

        if let Some(status) = exit {
            inner.last_exit_code = status.code();
            inner.child = None;
            inner.pid = None;
            if status.success() {
                inner.phase = "stopped".to_string();
                inner.connection = "unknown".to_string();
            } else {
                inner.phase = "error".to_string();
                inner.connection = "degraded".to_string();
                inner.last_error = Some(format!("Tunnel process exited with {status}"));
            }
        }
    }

    pub fn snapshot(&self) -> TunnelSnapshot {
        let mut inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
        Self::refresh_locked(&mut inner);
        TunnelSnapshot {
            phase: inner.phase.clone(),
            connection: inner.connection.clone(),
            pid: inner.pid,
            started_at_ms: inner.started_at_ms,
            last_exit_code: inner.last_exit_code,
            last_error: inner.last_error.clone(),
        }
    }

    fn stop_managed_locked(inner: &mut Inner) {
        let Some(mut child) = inner.child.take() else {
            return;
        };
        let pid = child.id();
        log::info!(target: "toolhub::tunnel", "Stopping managed tunnel process tree PID {pid}");
        let mut command = Command::new("taskkill.exe");
        command.args(["/PID", &pid.to_string(), "/T", "/F"]);
        command.stdout(Stdio::null()).stderr(Stdio::null());
        hide_window(&mut command);
        let status = command.status();

        if let Err(error) = status {
            log::warn!(target: "toolhub::tunnel", "taskkill failed for PID {pid}: {error}");
            let _ = child.kill();
        }
        let _ = child.wait();

        inner.pid = None;
        inner.phase = "stopped".to_string();
        inner.connection = "unknown".to_string();
    }

    fn stop_external_if_toolhub(&self) -> Result<(), String> {
        let Some(owner) = self.port_owner() else {
            return Ok(());
        };

        if !owner.expected_toolhub_client {
            let executable = owner
                .executable
                .as_ref()
                .map(|path| path.display().to_string())
                .unwrap_or_else(|| "<unknown>".to_string());
            return Err(format!(
                "Refusing to kill PID {} on {HEALTH_ADDR}: executable is {executable}, not {}",
                owner.pid,
                self.expected_client_path().display()
            ));
        }

        log::info!(
            target: "toolhub::tunnel",
            "Taking over existing ToolHub tunnel-client PID {}",
            owner.pid
        );

        let mut command = Command::new("taskkill.exe");
        command.args(["/PID", &owner.pid.to_string(), "/T", "/F"]);
        command.stdout(Stdio::null()).stderr(Stdio::null());
        hide_window(&mut command);
        let status = command
            .status()
            .map_err(|error| format!("Failed to stop existing tunnel PID {}: {error}", owner.pid))?;
        if !status.success() {
            return Err(format!(
                "taskkill failed while taking over existing tunnel PID {}",
                owner.pid
            ));
        }

        for _ in 0..20 {
            if Self::listener_pid().is_none() {
                return Ok(());
            }
            thread::sleep(Duration::from_millis(100));
        }
        Err(format!(
            "Existing tunnel PID {} exited but {HEALTH_ADDR} is still occupied",
            owner.pid
        ))
    }

    fn observe_line(inner: &Arc<Mutex<Inner>>, line: &str) {
        let lower = line.to_lowercase();
        let mut state = inner.lock().unwrap_or_else(|error| error.into_inner());

        if lower.contains("dispatcher forwarded command")
            || lower.contains("\"component\":\"dispatcher\"")
            || lower.contains("connected")
            || lower.contains("connection established")
        {
            state.connection = "connected".to_string();
        }

        if lower.contains("disconnected")
            || lower.contains("connectionrefused")
            || lower.contains("connection refused")
        {
            state.connection = "degraded".to_string();
        }
    }

    fn spawn_reader(
        reader: impl std::io::Read + Send + 'static,
        level: &'static str,
        inner: Arc<Mutex<Inner>>,
    ) {
        thread::spawn(move || {
            for line in BufReader::new(reader).lines().map_while(Result::ok) {
                Self::observe_line(&inner, &line);
                match level {
                    "ERROR" => log::error!(target: "toolhub::tunnel", "{line}"),
                    _ => log::info!(target: "toolhub::tunnel", "{line}"),
                }
            }
        });
    }

    pub fn restart(&self) -> Result<TunnelSnapshot, String> {
        {
            let mut inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
            Self::refresh_locked(&mut inner);
            Self::stop_managed_locked(&mut inner);
            inner.phase = "starting".to_string();
            inner.connection = "observing".to_string();
            inner.pid = None;
            inner.last_error = None;
            inner.last_exit_code = None;
        }

        if let Err(error) = self.stop_external_if_toolhub() {
            let mut inner = self.inner.lock().unwrap_or_else(|poison| poison.into_inner());
            inner.phase = "blocked".to_string();
            inner.connection = "degraded".to_string();
            inner.last_error = Some(error.clone());
            log::error!(target: "toolhub::tunnel", "{error}");
            return Err(error);
        }

        if let Err(error) = self.ensure_profile() {
            let mut inner = self.inner.lock().unwrap_or_else(|poison| poison.into_inner());
            inner.phase = "error".to_string();
            inner.connection = "degraded".to_string();
            inner.last_error = Some(error.clone());
            log::error!(target: "toolhub::tunnel", "{error}");
            return Err(error);
        }

        let script = self.repo_root.join("scripts").join("run-tunnel.ps1");
        if !script.is_file() {
            let message = format!("Tunnel script not found: {}", script.display());
            let mut inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
            inner.phase = "error".to_string();
            inner.connection = "degraded".to_string();
            inner.last_error = Some(message.clone());
            return Err(message);
        }

        log::info!(
            target: "toolhub::tunnel",
            "Starting ToolHub tunnel with config {}",
            self.config_path.display()
        );

        let mut command = Command::new("powershell.exe");
        command
            .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"])
            .arg(&script)
            .current_dir(&self.repo_root)
            .env("TOOLHUB_CONFIG", &self.config_path)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        hide_window(&mut command);

        let mut child = command.spawn().map_err(|error| {
            let message = format!("Failed to start run-tunnel.ps1: {error}");
            let mut inner = self.inner.lock().unwrap_or_else(|poison| poison.into_inner());
            inner.phase = "error".to_string();
            inner.connection = "degraded".to_string();
            inner.last_error = Some(message.clone());
            message
        })?;

        let pid = child.id();
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();

        {
            let mut inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
            inner.pid = Some(pid);
            inner.started_at_ms = Some(Self::now_ms());
            inner.phase = "running".to_string();
            inner.child = Some(child);
        }

        if let Some(stdout) = stdout {
            Self::spawn_reader(stdout, "INFO", Arc::clone(&self.inner));
        }
        if let Some(stderr) = stderr {
            Self::spawn_reader(stderr, "ERROR", Arc::clone(&self.inner));
        }

        Ok(self.snapshot())
    }
}
