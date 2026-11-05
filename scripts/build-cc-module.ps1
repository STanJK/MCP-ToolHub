$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$manifestPath = Join-Path $repoRoot "cc-interface\Cargo.toml"
$sourceExe = Join-Path $repoRoot "cc-interface\target\release\mcp-toolhub-cc-interface.exe"
$binDir = Join-Path $repoRoot "bin"
$targetExe = Join-Path $binDir "cc-interface.exe"

$cargo = Get-Command cargo.exe -ErrorAction SilentlyContinue
if (-not $cargo) {
  throw "cargo.exe not found in PATH"
}

& $cargo.Source build --manifest-path $manifestPath --release --locked
if ($LASTEXITCODE -ne 0) {
  throw "CC interface build failed with exit code $LASTEXITCODE"
}

if (-not (Test-Path $sourceExe)) {
  throw "Built CC interface not found: $sourceExe"
}

New-Item -ItemType Directory -Force -Path $binDir | Out-Null
Copy-Item -Force $sourceExe $targetExe

Write-Host "Staged CC Module Spec v1 interface:"
Write-Host $targetExe
