#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::PathBuf;
use std::thread;
use std::time::Duration;

use serde::Serialize;
use tauri::State;

mod cc_pipe;
mod config;
mod logging;
mod modules;
mod tunnel;

use config::{ModuleConfigView, ModuleSummary};
use logging::{LogEntry, LogRuntime};
use modules::ModuleProbe;
use tunnel::{TunnelManager, TunnelSnapshot};

#[derive(Clone)]
pub(crate) struct AppRuntime {
    pub(crate) repo_root: PathBuf,
    pub(crate) config_path: PathBuf,
    pub(crate) tunnel: TunnelManager,
    pub(crate) logs: LogRuntime,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DashboardSnapshot {
    overall_status: String,
    version: String,
    config_path: String,
    tunnel_name: Option<String>,
    tunnel_id: Option<String>,
    module_count: usize,
    enabled_module_count: usize,
    tunnel: TunnelSnapshot,
}

fn app_log_dir() -> PathBuf {
    std::env::var_os("LOCALAPPDATA")
        .or_else(|| std::env::var_os("APPDATA"))
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")))
        .join("MCP-ToolHub")
        .join("logs")
}

fn create_runtime() -> Result<AppRuntime, String> {
    let logs = logging::install(app_log_dir())?;
    let repo_root = config::repo_root()?;
    let config_path = config::toolhub_config_path(&repo_root);
    let tunnel = TunnelManager::new(repo_root.clone(), config_path.clone());

    Ok(AppRuntime {
        repo_root,
        config_path,
        tunnel,
        logs,
    })
}

fn start_bootstrap(runtime: &AppRuntime) -> Result<(), String> {
    let bootstrap_tunnel = runtime.tunnel.clone();
    thread::Builder::new()
        .name("ToolHubBootstrap".to_string())
        .spawn(move || {
            log::info!(
                target: "toolhub::bootstrap",
                "Bootstrap requested; starting ToolHub tunnel automatically"
            );

            match bootstrap_tunnel.restart() {
                Ok(snapshot) => log::info!(
                    target: "toolhub::bootstrap",
                    "Bootstrap tunnel start completed: phase={} connection={}",
                    snapshot.phase,
                    snapshot.connection
                ),
                Err(error) => log::error!(
                    target: "toolhub::bootstrap",
                    "Bootstrap tunnel start failed: {error}"
                ),
            }
        })
        .map(|_| ())
        .map_err(|error| format!("start ToolHub bootstrap thread failed: {error}"))
}

fn run_cc_backend(bootstrap_requested: bool) -> Result<(), String> {
    let runtime = create_runtime()?;

    log::info!(
        target: "toolhub::cc",
        "Starting true headless CC backend; repo={} config={}",
        runtime.repo_root.display(),
        runtime.config_path.display()
    );

    cc_pipe::start(runtime.clone())?;

    if bootstrap_requested {
        start_bootstrap(&runtime)?;
    }

    log::info!(
        target: "toolhub::cc",
        "Headless CC backend ready; pipe=\\\\.\\pipe\\STanJK-CC-toolhub"
    );

    loop {
        thread::sleep(Duration::from_secs(3600));
    }
}

pub(crate) fn dashboard_snapshot_impl(runtime: &AppRuntime) -> DashboardSnapshot {
    let tunnel = runtime.tunnel.snapshot();
    let loaded = config::load(&runtime.config_path);

    let (tunnel_name, tunnel_id, module_count, enabled_module_count, config_ok) = match loaded {
        Ok(config) => {
            let count = config.modules.len();
            let enabled = config.modules.values().filter(|module| module.enabled).count();
            (
                Some(config.tunnel.name),
                Some(config.tunnel.id),
                count,
                enabled,
                true,
            )
        }
        Err(error) => {
            log::warn!(target: "toolhub::config", "{error}");
            (None, None, 0, 0, false)
        }
    };

    let active_tunnel = tunnel.phase == "running" || tunnel.phase == "external";
    let overall_status = if !config_ok {
        "error"
    } else if active_tunnel && tunnel.connection == "connected" {
        "ready"
    } else if active_tunnel {
        "degraded"
    } else {
        tunnel.phase.as_str()
    }
    .to_string();

    DashboardSnapshot {
        overall_status,
        version: env!("CARGO_PKG_VERSION").to_string(),
        config_path: runtime.config_path.to_string_lossy().into_owned(),
        tunnel_name,
        tunnel_id,
        module_count,
        enabled_module_count,
        tunnel,
    }
}

#[tauri::command]
fn dashboard_snapshot(runtime: State<'_, AppRuntime>) -> DashboardSnapshot {
    dashboard_snapshot_impl(&runtime)
}

#[tauri::command]
async fn restart_tunnel(runtime: State<'_, AppRuntime>) -> Result<TunnelSnapshot, String> {
    let tunnel = runtime.tunnel.clone();
    tauri::async_runtime::spawn_blocking(move || tunnel.restart())
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
fn log_snapshot(after_sequence: Option<u64>, runtime: State<'_, AppRuntime>) -> Vec<LogEntry> {
    runtime.logs.snapshot_after(after_sequence)
}

#[tauri::command]
fn log_clear(runtime: State<'_, AppRuntime>) {
    runtime.logs.clear_memory();
}

#[tauri::command]
fn module_list(runtime: State<'_, AppRuntime>) -> Result<Vec<ModuleSummary>, String> {
    config::module_summaries(&runtime.config_path)
}

#[tauri::command]
fn module_config(
    module_id: String,
    runtime: State<'_, AppRuntime>,
) -> Result<ModuleConfigView, String> {
    config::read_module_config(&runtime.config_path, &module_id)
}

#[tauri::command]
fn save_module_config(
    module_id: String,
    content: String,
    runtime: State<'_, AppRuntime>,
) -> Result<ModuleConfigView, String> {
    let result = config::write_module_config(&runtime.config_path, &module_id, &content)?;
    log::info!(target: "toolhub::config", "Saved module config for {module_id}");
    Ok(result)
}

#[tauri::command]
async fn probe_module(
    module_id: String,
    runtime: State<'_, AppRuntime>,
) -> Result<ModuleProbe, String> {
    let repo_root = runtime.repo_root.clone();
    let config_path = runtime.config_path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        modules::probe(&repo_root, &config_path, &module_id)
    })
    .await
    .map_err(|error| error.to_string())?
}

fn run_gui(bootstrap_requested: bool) {
    tauri::Builder::default()
        .setup(move |app| {
            let runtime = create_runtime().map_err(std::io::Error::other)?;

            log::info!(
                target: "toolhub::gui",
                "MCP-ToolHub GUI started; repo={} config={}",
                runtime.repo_root.display(),
                runtime.config_path.display()
            );

            cc_pipe::start(runtime.clone()).map_err(std::io::Error::other)?;

            if bootstrap_requested {
                start_bootstrap(&runtime).map_err(std::io::Error::other)?;
            }

            app.manage(runtime);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            dashboard_snapshot,
            restart_tunnel,
            log_snapshot,
            log_clear,
            module_list,
            module_config,
            save_module_config,
            probe_module
        ])
        .run(tauri::generate_context!())
        .expect("error while running MCP-ToolHub GUI");
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let bootstrap_requested = args.iter().any(|arg| {
        arg.eq_ignore_ascii_case("--bootstrap") || arg.eq_ignore_ascii_case("-bootstrap")
    });
    let cc_backend_requested = args
        .iter()
        .any(|arg| arg.eq_ignore_ascii_case("--cc-backend"));

    if cc_backend_requested {
        if let Err(error) = run_cc_backend(bootstrap_requested) {
            eprintln!("MCP-ToolHub CC backend failed: {error}");
            std::process::exit(1);
        }
        return;
    }

    run_gui(bootstrap_requested);
}
