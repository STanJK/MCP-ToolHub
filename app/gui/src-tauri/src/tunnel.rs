use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;

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

#[derive(Clone)]
pub struct TunnelManager {
    repo_root: PathBuf,
    config_path: PathBuf,
    inner: Arc<Mutex<Inner>>,
}

impl TunnelManager {
    pub fn new(repo_root: PathBuf, config_path: PathBuf) -> Self {
        Self { repo_root, config_path, inner: Arc::new(Mutex::new(Inner::default())) }
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

    fn ensure_profile(&self) -> Result<(), String> {
        let profile = self.current_profile_name()?;
        let profile_path = self.profile_path(&profile)?;

        // Reinitialize on every explicit Start/Restart. A profile file can exist
        // while being stale, incomplete, or tied to an older tunnel command.
        // The local config is the authority; init-tunnel.ps1 deterministically
        // rewrites the official tunnel-client profile from that config.
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
        SystemTime::now().duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_millis().min(u64::MAX as u128) as u64)
            .unwrap_or(0)
    }

    fn refresh_locked(inner: &mut Inner) {
        let exit = inner.child.as_mut().and_then(|child| child.try_wait().ok().flatten());
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

    fn stop_locked(inner: &mut Inner) {
        let Some(mut child) = inner.child.take() else { return; };
        let pid = child.id();
        log::info!(target: "toolhub::tunnel", "Stopping managed tunnel process tree PID {pid}");
        let status = Command::new("taskkill.exe")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        if let Err(error) = status {
            log::warn!(target: "toolhub::tunnel", "taskkill failed for PID {pid}: {error}");
            let _ = child.kill();
        }
        let _ = child.wait();
        inner.pid = None;
        inner.phase = "stopped".to_string();
        inner.connection = "unknown".to_string();
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
            Self::stop_locked(&mut inner);
            inner.phase = "starting".to_string();
            inner.connection = "observing".to_string();
            inner.last_error = None;
            inner.last_exit_code = None;
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
