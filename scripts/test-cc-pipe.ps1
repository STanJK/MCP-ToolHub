param(
  [int]$ConnectTimeoutMs = 5000,
  [int]$IoTimeoutMs = 5000
)

$ErrorActionPreference = "Stop"
$pipeName = "STanJK-CC-toolhub"

function Read-Exact {
  param(
    [System.IO.Stream]$Stream,
    [byte[]]$Buffer
  )

  $offset = 0
  while ($offset -lt $Buffer.Length) {
    $task = $Stream.ReadAsync($Buffer, $offset, $Buffer.Length - $offset)
    if (-not $task.Wait($IoTimeoutMs)) {
      throw "Timed out after $IoTimeoutMs ms while reading from the CC pipe."
    }

    $read = $task.Result
    if ($read -le 0) {
      throw "Pipe closed while reading a frame."
    }
    $offset += $read
  }
}

function Read-Frame {
  param([System.IO.Stream]$Stream)

  $lengthBytes = New-Object byte[] 4
  Read-Exact -Stream $Stream -Buffer $lengthBytes
  $length = [BitConverter]::ToUInt32($lengthBytes, 0)

  if ($length -le 0 -or $length -gt 4194304) {
    throw "Invalid CC pipe frame length: $length"
  }

  $payload = New-Object byte[] $length
  Read-Exact -Stream $Stream -Buffer $payload
  $json = [Text.Encoding]::UTF8.GetString($payload)
  return $json | ConvertFrom-Json
}

function Write-Frame {
  param(
    [System.IO.Stream]$Stream,
    [object]$Value
  )

  $json = $Value | ConvertTo-Json -Compress -Depth 16
  $payload = [Text.Encoding]::UTF8.GetBytes($json)
  $lengthBytes = [BitConverter]::GetBytes([uint32]$payload.Length)

  $lengthTask = $Stream.WriteAsync($lengthBytes, 0, $lengthBytes.Length)
  if (-not $lengthTask.Wait($IoTimeoutMs)) {
    throw "Timed out after $IoTimeoutMs ms while writing the CC pipe frame length."
  }

  $payloadTask = $Stream.WriteAsync($payload, 0, $payload.Length)
  if (-not $payloadTask.Wait($IoTimeoutMs)) {
    throw "Timed out after $IoTimeoutMs ms while writing the CC pipe payload."
  }

  $Stream.Flush()
}

$pipePath = "\\.\pipe\$pipeName"
$visiblePipe = Get-ChildItem "\\.\pipe\" -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -eq $pipeName } |
  Select-Object -First 1

if ($visiblePipe) {
  Write-Host "[INFO] Pipe exists: $pipePath"
}
else {
  Write-Warning "Pipe is not currently visible: $pipePath"
}

$pipe = [System.IO.Pipes.NamedPipeClientStream]::new(
  ".",
  $pipeName,
  [System.IO.Pipes.PipeDirection]::InOut
)

try {
  try {
    Write-Host "[STEP] Connecting..."
    $pipe.Connect($ConnectTimeoutMs)
    Write-Host "[PASS] Pipe transport connected"

    $pipe.ReadMode = [System.IO.Pipes.PipeTransmissionMode]::Byte
  }
  catch {
    Write-Host ""
    Write-Host "[FAIL] Named pipe connect failed: $($_.Exception.Message)"
    Write-Host "[INFO] Expected pipe: $pipePath"

    $logPath = Join-Path $env:LOCALAPPDATA "MCP-ToolHub\logs\toolhub-gui.log"
    if (Test-Path $logPath) {
      Write-Host ""
      Write-Host "[INFO] Last 80 ToolHub log lines:"
      Get-Content $logPath -Tail 80
    }
    else {
      Write-Warning "ToolHub log not found: $logPath"
    }

    throw
  }

  Write-Host "[STEP] Waiting for ToolHub hello..."
  $hello = Read-Frame -Stream $pipe
  Write-Host "[PASS] ToolHub hello received"
  if ($hello.type -ne "hello" -or
      $hello.protocol -ne "cc-pipe-v1" -or
      $hello.module_id -ne "toolhub") {
    throw "Unexpected ToolHub hello: $($hello | ConvertTo-Json -Compress)"
  }

  Write-Host "[STEP] Sending hello-ack..."
  Write-Frame -Stream $pipe -Value @{
    type = "hello-ack"
    protocol = "cc-pipe-v1"
  }
  Write-Host "[PASS] hello-ack sent"

  $requestId = 2001
  Write-Host "[STEP] Sending GET /dashboard..."
  Write-Frame -Stream $pipe -Value @{
    type = "http.request"
    request_id = $requestId
    method = "GET"
    path = "/dashboard"
    query = ""
    content_type = $null
    accept = "application/json"
    body_b64 = $null
  }

  Write-Host "[STEP] Waiting for http.response..."
  while ($true) {
    $message = Read-Frame -Stream $pipe

    if ($message.type -eq "error.set" -or $message.type -eq "error.clear") {
      Write-Host "[MAILBOX] $($message | ConvertTo-Json -Compress)"
      continue
    }

    if ($message.type -eq "http.response" -and
        [uint64]$message.request_id -eq [uint64]$requestId) {
      $body = if ($null -ne $message.body_b64) {
        [Text.Encoding]::UTF8.GetString(
          [Convert]::FromBase64String([string]$message.body_b64)
        )
      } else {
        ""
      }

      Write-Host "[PASS] cc-pipe-v1 handshake"
      Write-Host "[PASS] GET /dashboard -> HTTP $($message.status)"
      Write-Host $body
      break
    }

    Write-Host "[INFO] Ignoring frame: $($message | ConvertTo-Json -Compress)"
  }
}
finally {
  $pipe.Dispose()
}
