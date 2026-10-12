$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$client = Join-Path $repoRoot ".toolhub\bin\tunnel-client.exe"
$configPath = if ($env:TOOLHUB_CONFIG) { $env:TOOLHUB_CONFIG } else { Join-Path $repoRoot "toolhub.local.yaml" }

if (-not (Test-Path $client)) {
  throw "tunnel-client.exe not found. Run .\scripts\bootstrap-tunnel.ps1 first."
}
if (-not (Test-Path $configPath)) {
  throw "ToolHub config not found: $configPath"
}

$env:TOOLHUB_CONFIG = (Resolve-Path $configPath).Path
$tunnelJson = & node (Join-Path $repoRoot "src\core\config-cli.mjs") tunnel-json
if ($LASTEXITCODE -ne 0) {
  throw "Failed to read tunnel config from $env:TOOLHUB_CONFIG"
}

$tunnel = $tunnelJson | ConvertFrom-Json
$env:CONTROL_PLANE_API_KEY = $tunnel.raw_key

& $client doctor --profile $tunnel.name --explain
if ($LASTEXITCODE -ne 0) {
  throw "tunnel-client doctor failed with exit code $LASTEXITCODE"
}

& $client run --profile $tunnel.name
exit $LASTEXITCODE
