param(
  [Parameter(Mandatory=$true)][string]$TunnelId,
  [string]$Profile = "toolhub"
)
$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$client = Join-Path $repoRoot ".toolhub\bin\tunnel-client.exe"
if (-not (Test-Path $client)) { throw "tunnel-client.exe not found. Run .\scripts\bootstrap-tunnel.ps1 first." }
$server = Join-Path $repoRoot "src\index.mjs"
$command = "node `"$server`""
& $client init --sample sample_mcp_stdio_local --profile $Profile --tunnel-id $TunnelId --mcp-command $command
if ($LASTEXITCODE -ne 0) { throw "tunnel-client init failed with exit code $LASTEXITCODE" }
Write-Host "Initialized official tunnel-client profile $Profile."
