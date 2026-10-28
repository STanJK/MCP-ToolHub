use std::path::{Path, PathBuf};
use std::process::Command;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolView {
    pub name: String,
    pub title: Option<String>,
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModuleProbe {
    pub ok: bool,
    pub module_id: String,
    pub status: String,
    pub message: String,
    pub tools: Vec<ToolView>,
    pub detail: serde_json::Value,
}

pub fn probe(repo_root: &Path, config_path: &Path, module_id: &str) -> Result<ModuleProbe, String> {
    let script: PathBuf = repo_root.join("src").join("control").join("module-probe.mjs");
    if !script.is_file() {
        return Err(format!("Module probe script not found: {}", script.display()));
    }

    log::info!(target: "toolhub::modules", "Probing module {module_id}");
    let output = Command::new("node")
        .arg(&script)
        .arg(module_id)
        .current_dir(repo_root)
        .env("TOOLHUB_CONFIG", config_path)
        .output()
        .map_err(|error| format!("Failed to start Node module probe: {error}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    for line in stderr.lines() {
        log::debug!(target: "toolhub::module_probe", "{line}");
    }

    if stdout.trim().is_empty() {
        return Err(format!("Module probe produced no JSON output (exit={:?})", output.status.code()));
    }

    let probe: ModuleProbe = serde_json::from_str(stdout.trim())
        .map_err(|error| format!("Invalid module probe JSON: {error}; output={stdout}"))?;

    if probe.ok {
        log::info!(
            target: "toolhub::modules",
            "Module {} probe status={} tools={}",
            probe.module_id,
            probe.status,
            probe.tools.len()
        );
    } else {
        log::warn!(target: "toolhub::modules", "Module {} probe failed: {}", probe.module_id, probe.message);
    }

    Ok(probe)
}
