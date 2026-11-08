param([string]$Version = "latest")
$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$installDir = Join-Path $repoRoot ".toolhub\bin"
New-Item -ItemType Directory -Force -Path $installDir | Out-Null
$releaseApi = if ($Version -eq "latest") { "https://api.github.com/repos/openai/tunnel-client/releases/latest" } else { "https://api.github.com/repos/openai/tunnel-client/releases/tags/$Version" }
$release = Invoke-RestMethod -Headers @{ "User-Agent" = "MCP-ToolHub" } -Uri $releaseApi
$arch = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "arm64" } else { "amd64" }
$assetName = "tunnel-client-$($release.tag_name)-windows-$arch.zip"
$asset = $release.assets | Where-Object { $_.name -eq $assetName } | Select-Object -First 1
$sums = $release.assets | Where-Object { $_.name -eq "SHA256SUMS.txt" } | Select-Object -First 1
if (-not $asset) { throw "Could not find official release asset $assetName" }
if (-not $sums) { throw "Could not find SHA256SUMS.txt" }
$temp = Join-Path ([System.IO.Path]::GetTempPath()) ("mcp-toolhub-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $temp | Out-Null
try {
  $zipPath = Join-Path $temp $assetName
  $sumPath = Join-Path $temp "SHA256SUMS.txt"
  Invoke-WebRequest -UseBasicParsing -Uri $asset.browser_download_url -OutFile $zipPath
  Invoke-WebRequest -UseBasicParsing -Uri $sums.browser_download_url -OutFile $sumPath
  $line = Get-Content $sumPath | Where-Object { $_ -match [regex]::Escape($assetName) } | Select-Object -First 1
  if (-not $line) { throw "No checksum entry found for $assetName" }
  $expected = ($line -split "\s+")[0].Trim().ToLowerInvariant()
  $actual = (Get-FileHash -Algorithm SHA256 $zipPath).Hash.ToLowerInvariant()
  if ($expected -ne $actual) { throw "SHA256 mismatch for $assetName" }
  Expand-Archive -Force -Path $zipPath -DestinationPath $installDir
  $exe = Get-ChildItem -Path $installDir -Recurse -Filter "tunnel-client.exe" | Select-Object -First 1
  if (-not $exe) { throw "tunnel-client.exe not found after extraction" }
  $target = Join-Path $installDir "tunnel-client.exe"
  if ($exe.FullName -ne $target) { Copy-Item -Force $exe.FullName $target }
  Write-Host "Installed official OpenAI tunnel-client $($release.tag_name)"
  Write-Host "Verified SHA256: $actual"
  Write-Host $target
} finally {
  Remove-Item -Recurse -Force $temp -ErrorAction SilentlyContinue
}
