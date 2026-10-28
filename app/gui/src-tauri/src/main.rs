use std::path::PathBuf;

use serde::Serialize;
use tauri::State;

mod config;
mod logging;
mod modules;
mod tunnel;

use config::{ModuleConfigView, ModuleSummary};
use logging::{LogEntry, LogRuntime};
use modules::ModuleProbe;
use tunnel::{TunnelManager, TunnelSnapshot};

struct AppRuntime {
    repo_root: PathBuf,
    config_path: PathBuf,
    tunnel: TunnelManager,
    logs: LogRuntime,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DashboardSnapshot {
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

#[tauri::command]
fn dashboard_snapshot(runtime: State<'_, AppRuntime>) -> DashboardSnapshot {
    let tunnel = runtime.tunnel.snapshot();
    let loaded = config::load(&runtime.config_path);

    let (tunnel_name, tunnel_id, module_count, enabled_module_count, config_ok) = match loaded {
        Ok(config) => {
            let count = config.modules.len();
            let enabled = config.modules.values().filter(|module| module.enabled).count();
            (Some(config.tunnel.name), Some(config.tunnel.id), count, enabled, true)
        }
        Err(error) => {
            log::warn!(target: "toolhub::config", "{error}");
            (None, None, 0, 0, false)
        }
    };

    let overall_status = if !config_ok {
        "error"
    } else if tunnel.phase == "running" && tunnel.connection == "connected" {
        "ready"
    } else if tunnel.phase == "running" {
        "degraded"
    } else {
        tunnel.phase.as_str()
    }.to_string();

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
fn module_config(module_id: String, runtime: State<'_, AppRuntime>) -> Result<ModuleConfigView, String> {
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
async fn probe_module(module_id: String, runtime: State<'_, AppRuntime>) -> Result<ModuleProbe, String> {
    let repo_root = runtime.repo_root.clone();
    let config_path = runtime.config_path.clone();
    tauri::async_runtime::spawn_blocking(move || modules::probe(&repo_root, &config_path, &module_id))
        .await
        .map_err(|error| error.to_string())?
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let logs = logging::install(app_log_dir()).map_err(std::io::Error::other)?;
            let repo_root = config::repo_root().map_err(std::io::Error::other)?;
            let config_path = config::toolhub_config_path(&repo_root);
            let tunnel = TunnelManager::new(repo_root.clone(), config_path.clone());

            log::info!(
                target: "toolhub::gui",
                "MCP-ToolHub GUI started; repo={} config={}",
                repo_root.display(),
                config_path.display()
            );

            app.manage(AppRuntime { repo_root, config_path, tunnel, logs });
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
