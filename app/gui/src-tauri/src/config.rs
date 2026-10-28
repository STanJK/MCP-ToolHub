use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize)]
pub struct TunnelConfig {
    pub name: String,
    pub id: String,
    pub raw_key: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ModuleRegistration {
    pub enabled: bool,
    pub config: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ToolHubConfig {
    pub version: u32,
    pub tunnel: TunnelConfig,
    pub modules: BTreeMap<String, ModuleRegistration>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModuleSummary {
    pub id: String,
    pub enabled: bool,
    pub config_path: Option<String>,
    pub config_exists: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModuleConfigView {
    pub module_id: String,
    pub path: String,
    pub content: String,
}

pub fn repo_root() -> Result<PathBuf, String> {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    manifest
        .join("../../..")
        .canonicalize()
        .map_err(|error| format!("Failed to resolve ToolHub repository root: {error}"))
}

pub fn toolhub_config_path(repo_root: &Path) -> PathBuf {
    std::env::var_os("TOOLHUB_CONFIG")
        .map(PathBuf::from)
        .unwrap_or_else(|| repo_root.join("toolhub.local.yaml"))
}

pub fn load(path: &Path) -> Result<ToolHubConfig, String> {
    let raw = fs::read_to_string(path)
        .map_err(|error| format!("Failed to read {}: {error}", path.display()))?;
    let config: ToolHubConfig =
        serde_yaml::from_str(&raw).map_err(|error| format!("Invalid ToolHub YAML: {error}"))?;

    if config.version != 1 {
        return Err(format!("Unsupported ToolHub config version: {}", config.version));
    }
    if config.tunnel.name.is_empty() || config.tunnel.id.is_empty() || config.tunnel.raw_key.is_empty() {
        return Err("ToolHub tunnel name/id/raw_key must be configured".to_string());
    }
    Ok(config)
}

pub fn module_summaries(config_path: &Path) -> Result<Vec<ModuleSummary>, String> {
    let config = load(config_path)?;
    let config_dir = config_path.parent().unwrap_or_else(|| Path::new("."));

    Ok(config
        .modules
        .into_iter()
        .map(|(id, registration)| {
            let resolved = registration
                .config
                .as_deref()
                .map(|value| config_dir.join(value));
            ModuleSummary {
                id,
                enabled: registration.enabled,
                config_path: resolved.as_ref().map(|path| path.to_string_lossy().into_owned()),
                config_exists: resolved.as_ref().is_some_and(|path| path.is_file()),
            }
        })
        .collect())
}

fn module_path(config_path: &Path, module_id: &str) -> Result<PathBuf, String> {
    let config = load(config_path)?;
    let registration = config
        .modules
        .get(module_id)
        .ok_or_else(|| format!("Unknown ToolHub module: {module_id}"))?;
    let relative = registration
        .config
        .as_deref()
        .ok_or_else(|| format!("Module {module_id} has no config path"))?;
    let config_dir = config_path.parent().unwrap_or_else(|| Path::new("."));
    let path = config_dir.join(relative);

    if !path.is_file() {
        return Err(format!("Module config not found: {}", path.display()));
    }
    Ok(path)
}

pub fn read_module_config(config_path: &Path, module_id: &str) -> Result<ModuleConfigView, String> {
    let path = module_path(config_path, module_id)?;
    let content = fs::read_to_string(&path)
        .map_err(|error| format!("Failed to read {}: {error}", path.display()))?;
    Ok(ModuleConfigView {
        module_id: module_id.to_string(),
        path: path.to_string_lossy().into_owned(),
        content,
    })
}

pub fn write_module_config(
    config_path: &Path,
    module_id: &str,
    content: &str,
) -> Result<ModuleConfigView, String> {
    let path = module_path(config_path, module_id)?;
    let _: serde_yaml::Value = serde_yaml::from_str(content)
        .map_err(|error| format!("Refusing to save invalid YAML: {error}"))?;
    fs::write(&path, content)
        .map_err(|error| format!("Failed to write {}: {error}", path.display()))?;
    read_module_config(config_path, module_id)
}
