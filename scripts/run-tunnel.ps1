param([string]$Profile = "toolhub")
$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$client = Join-Path $repoRoot ".toolhub\bin\tunnel-client.exe"
$manifest = Join-Path $repoRoot "toolhub.local.json"
if (-not (Test-Path $client)) { throw "tunnel-client.exe not found. Run .\scripts\bootstrap-tunnel.ps1 first." }
if (-not (Test-Path $manifest)) { throw "toolhub.local.json not found. Copy toolhub.example.json and edit it first." }
if (-not $env:CONTROL_PLANE_API_KEY) { throw "CONTROL_PLANE_API_KEY is not set." }
$env:TOOLHUB_CONFIG = $manifest
& $client doctor --profile $Profile --explain
if ($LASTEXITCODE -ne 0) { throw "tunnel-client doctor failed with exit code $LASTEXITCODE" }
& $client run --profile $Profile
exit $LASTEXITCODE
