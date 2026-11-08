$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$guiRoot = Join-Path $repoRoot "app\gui"
$sourceExe = Join-Path $guiRoot "src-tauri\target\release\mcp-toolhub-gui-host.exe"
$uiEntry = Join-Path $guiRoot "dist\index.html"
$binDir = Join-Path $repoRoot "bin"
$targetExe = Join-Path $binDir "mcp-toolhub-gui-host.exe"

$npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
if (-not $npm) {
  throw "npm.cmd not found in PATH"
}

Push-Location $guiRoot
try {
  & $npm.Source run tauri:build
  if ($LASTEXITCODE -ne 0) {
    throw "ToolHub Tauri build failed with exit code $LASTEXITCODE"
  }
}
finally {
  Pop-Location
}

if (-not (Test-Path $sourceExe)) {
  throw "Built ToolHub backend not found: $sourceExe"
}

if (-not (Test-Path $uiEntry)) {
  throw "Built ToolHub static UI not found: $uiEntry"
}

New-Item -ItemType Directory -Force -Path $binDir | Out-Null
Copy-Item -Force $sourceExe $targetExe

Write-Host "CC Module Spec v1 package staged:"
Write-Host "Backend: $targetExe"
Write-Host "UI:      $uiEntry"
