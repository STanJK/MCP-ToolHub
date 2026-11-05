param(
  [int]$ConnectTimeoutMs = 5000
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
    $read = $Stream.Read($Buffer, $offset, $Buffer.Length - $offset)
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

  $Stream.Write($lengthBytes, 0, $lengthBytes.Length)
  $Stream.Write($payload, 0, $payload.Length)
  $Stream.Flush()
}

$pipe = [System.IO.Pipes.NamedPipeClientStream]::new(
  ".",
  $pipeName,
  [System.IO.Pipes.PipeDirection]::InOut
)

try {
  $pipe.Connect($ConnectTimeoutMs)

  $hello = Read-Frame -Stream $pipe
  if ($hello.type -ne "hello" -or
      $hello.protocol -ne "cc-pipe-v1" -or
      $hello.module_id -ne "toolhub") {
    throw "Unexpected ToolHub hello: $($hello | ConvertTo-Json -Compress)"
  }

  Write-Frame -Stream $pipe -Value @{
    type = "hello-ack"
    protocol = "cc-pipe-v1"
  }

  $requestId = 2001
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
