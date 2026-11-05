#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(not(windows))]
compile_error!("mcp-toolhub-cc-interface currently supports Windows only");

use std::env;
use std::ffi::c_void;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::Duration;

use std::os::windows::process::CommandExt;

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const DETACHED_PROCESS: u32 = 0x0000_0008;
const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
const HEALTH_PORT: u16 = 8080;

#[link(name = "kernel32")]
unsafe extern "system" {
    fn OpenProcess(
        dw_desired_access: u32,
        b_inherit_handle: i32,
        dw_process_id: u32,
    ) -> *mut c_void;
    fn QueryFullProcessImageNameW(
        h_process: *mut c_void,
        dw_flags: u32,
        lp_exe_name: *mut u16,
        lpdw_size: *mut u32,
    ) -> i32;
    fn CloseHandle(h_object: *mut c_void) -> i32;
}

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let action = env::args()
        .nth(1)
        .ok_or_else(|| "usage: cc-interface.exe <probe|start|stop>".to_string())?;
    let root = module_root()?;

    match action.as_str() {
        "probe" => {
            let running = is_running(&root)?;
            println!(r#"{{"running":{running}}}"#);
            Ok(())
        }
        "start" => start(&root),
        "stop" => stop(&root),
        other => Err(format!("unsupported lifecycle action: {other}")),
    }
}

fn module_root() -> Result<PathBuf, String> {
    let root = env::var_os("CC_MODULE_ROOT")
        .map(PathBuf::from)
        .unwrap_or(env::current_dir().map_err(|error| format!("resolve current directory failed: {error}"))?);

    root.canonicalize()
        .map_err(|error| format!("resolve module root {} failed: {error}", root.display()))
}

fn cc_state_dir() -> Result<PathBuf, String> {
    let base = env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .ok_or_else(|| "LOCALAPPDATA is unavailable".to_string())?;
    Ok(base.join("MCP-ToolHub").join("cc"))
}

fn pid_file() -> Result<PathBuf, String> {
    Ok(cc_state_dir()?.join("runtime.pid"))
}

fn read_managed_pid() -> Result<Option<u32>, String> {
    let path = pid_file()?;
    let raw = match fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("read {} failed: {error}", path.display())),
    };

    let pid = match raw.trim().parse::<u32>() {
        Ok(pid) if pid > 0 => pid,
        _ => {
            let _ = fs::remove_file(&path);
            return Ok(None);
        }
    };

    let Some(image) = process_image_path(pid) else {
        let _ = fs::remove_file(&path);
        return Ok(None);
    };

    let is_node = image
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.eq_ignore_ascii_case("node.exe"));

    if is_node {
        Ok(Some(pid))
    } else {
        let _ = fs::remove_file(&path);
        Ok(None)
    }
}

fn expected_tunnel_client(root: &Path) -> PathBuf {
    root.join(".toolhub").join("bin").join("tunnel-client.exe")
}

fn normalize_path(path: &Path) -> String {
    path.canonicalize()
        .unwrap_or_else(|_| path.to_path_buf())
        .to_string_lossy()
        .replace('/', "\\")
        .trim_start_matches(r"\\?\")
        .to_ascii_lowercase()
}

fn process_image_path(pid: u32) -> Option<PathBuf> {
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return None;
        }

        let mut buffer = vec![0u16; 32768];
        let mut size = buffer.len() as u32;
        let ok = QueryFullProcessImageNameW(handle, 0, buffer.as_mut_ptr(), &mut size);
        let _ = CloseHandle(handle);

        if ok == 0 || size == 0 {
            return None;
        }

        buffer.truncate(size as usize);
        Some(PathBuf::from(String::from_utf16_lossy(&buffer)))
    }
}

fn listener_pid(port: u16) -> Result<Option<u32>, String> {
    let mut command = Command::new("netstat.exe");
    command
        .args(["-ano", "-p", "tcp"])
        .creation_flags(CREATE_NO_WINDOW)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let output = command
        .output()
        .map_err(|error| format!("launch netstat.exe failed: {error}"))?;

    if !output.status.success() {
        return Err(format!(
            "netstat.exe failed with {}: {}",
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }

    for line in String::from_utf8_lossy(&output.stdout).lines() {
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() < 5
            || !parts[0].eq_ignore_ascii_case("TCP")
            || !parts[3].eq_ignore_ascii_case("LISTENING")
        {
            continue;
        }

        let Some(colon) = parts[1].rfind(':') else {
            continue;
        };
        let Ok(local_port) = parts[1][colon + 1..].parse::<u16>() else {
            continue;
        };

        if local_port == port {
            if let Ok(pid) = parts[4].parse::<u32>() {
                return Ok(Some(pid));
            }
        }
    }

    Ok(None)
}

fn external_toolhub_pid(root: &Path) -> Result<Option<u32>, String> {
    let Some(pid) = listener_pid(HEALTH_PORT)? else {
        return Ok(None);
    };
    let Some(image) = process_image_path(pid) else {
        return Ok(None);
    };

    if normalize_path(&image) == normalize_path(&expected_tunnel_client(root)) {
        Ok(Some(pid))
    } else {
        Ok(None)
    }
}

fn is_running(root: &Path) -> Result<bool, String> {
    if read_managed_pid()?.is_some() {
        return Ok(true);
    }

    Ok(external_toolhub_pid(root)?.is_some())
}

fn validate_start_files(root: &Path) -> Result<PathBuf, String> {
    let runtime = root.join("src").join("cc").join("runtime.mjs");
    if !runtime.is_file() {
        return Err(format!("CC runtime not found: {}", runtime.display()));
    }

    let config = root.join("toolhub.local.yaml");
    if !config.is_file() {
        return Err(format!("ToolHub config not found: {}", config.display()));
    }

    let init = root.join("scripts").join("init-tunnel.ps1");
    if !init.is_file() {
        return Err(format!("Tunnel init script not found: {}", init.display()));
    }

    let run = root.join("scripts").join("run-tunnel.ps1");
    if !run.is_file() {
        return Err(format!("Tunnel run script not found: {}", run.display()));
    }

    let client = expected_tunnel_client(root);
    if !client.is_file() {
        return Err(format!(
            "tunnel-client.exe not found: {} (run scripts\\bootstrap-tunnel.ps1 first)",
            client.display()
        ));
    }

    let mut where_node = Command::new("where.exe");
    where_node
        .arg("node.exe")
        .creation_flags(CREATE_NO_WINDOW)
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    let status = where_node
        .status()
        .map_err(|error| format!("launch where.exe failed: {error}"))?;
    if !status.success() {
        return Err("node.exe is not available in PATH".to_string());
    }

    Ok(runtime)
}

fn start(root: &Path) -> Result<(), String> {
    if is_running(root)? {
        return Ok(());
    }

    let runtime = validate_start_files(root)?;
    fs::create_dir_all(cc_state_dir()?)
        .map_err(|error| format!("create CC state directory failed: {error}"))?;

    let mut command = Command::new("node.exe");
    command
        .arg(runtime)
        .current_dir(root)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW | DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);

    command
        .spawn()
        .map_err(|error| format!("launch ToolHub CC runtime failed: {error}"))?;

    for _ in 0..20 {
        thread::sleep(Duration::from_millis(50));
        if read_managed_pid()?.is_some() {
            return Ok(());
        }
    }

    Err("ToolHub CC runtime did not publish its PID after start".to_string())
}

fn taskkill_tree(pid: u32) -> Result<(), String> {
    let mut command = Command::new("taskkill.exe");
    command
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .creation_flags(CREATE_NO_WINDOW)
        .stdout(Stdio::null())
        .stderr(Stdio::piped());

    let output = command
        .output()
        .map_err(|error| format!("launch taskkill.exe failed for PID {pid}: {error}"))?;

    if output.status.success() || process_image_path(pid).is_none() {
        Ok(())
    } else {
        Err(format!(
            "taskkill failed for PID {pid} with {}: {}",
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        ))
    }
}

fn stop(root: &Path) -> Result<(), String> {
    if let Some(pid) = read_managed_pid()? {
        taskkill_tree(pid)?;
        for _ in 0..20 {
            if process_image_path(pid).is_none() {
                break;
            }
            thread::sleep(Duration::from_millis(50));
        }
    }

    let _ = fs::remove_file(pid_file()?);

    if let Some(pid) = external_toolhub_pid(root)? {
        taskkill_tree(pid)?;
    }

    Ok(())
}
