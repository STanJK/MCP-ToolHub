# Control Center integration

MCP-ToolHub targets the current **STanJK PC Control Center CC Module Spec v1** and **CC Pipe Protocol v1**.

The authoritative topology is:

```text
CC HTTP/static host
http://127.0.0.1:32145
        |
        | static ToolHub frontend
        | /modules/toolhub/ui/
        |
        | opaque HTTP proxy
        | /api/modules/toolhub/*
        v
\\.\pipe\STanJK-CC-toolhub
        |
        v
original mcp-toolhub-gui-host.exe backend
        + thin CC Pipe Adapter
        + existing TunnelManager
        + existing module probe/config/log runtime
```

There is no second CC-specific ToolHub business backend and no dedicated ToolHub TCP API port.

## Current Control Center implementation status

The current Control Center specification is the downstream adaptation target.

At the time of this integration, the CC repository documentation explicitly states that the persistent pipe router is the next CC-side implementation step and the checked-in supervisor runtime still contains the earlier short-lived lifecycle adapter.

Therefore ToolHub is adapted to the new canonical protocol ahead of the CC runtime switchover.

## Manifest

The repository root contains:

```json
{
  "spec": "cc-module-v1",
  "id": "toolhub",
  "name": "MCP ToolHub",
  "version": "0.1.0",
  "description": "Local MCP runtime and Secure MCP Tunnel broker",
  "backend": {
    "version": 1,
    "entry": "bin/mcp-toolhub-gui-host.exe",
    "args": ["--cc-backend", "--bootstrap"]
  },
  "ui": {
    "entry": "app/gui/dist/index.html"
  }
}
```

CC Managed launch therefore starts the original ToolHub backend executable directly.

No lifecycle wrapper process is used.

## Original backend modes

The same executable supports both existing standalone operation and CC Managed operation.

### Existing standalone GUI

```text
mcp-toolhub-gui-host.exe
```

The window is visible and the CC pipe server is also available so a later-started CC instance can bind dynamically.

### Existing standalone bootstrap

```text
mcp-toolhub-gui-host.exe -bootstrap
```

The window is visible and the existing tunnel bootstrap behavior is preserved.

### CC Managed backend

```text
mcp-toolhub-gui-host.exe --cc-backend --bootstrap
```

This is the same backend binary.

`--cc-backend` hides the Tauri window because CC hosts the module frontend in its own shell.

`--bootstrap` preserves the existing ToolHub tunnel startup path.

## Persistent pipe

The backend always hosts:

```text
\\.\pipe\STanJK-CC-toolhub
```

The module is the Named Pipe server and CC is the client.

Framing is:

```text
[u32 little-endian JSON length][UTF-8 JSON]
```

The implementation enforces a bounded control-plane frame size.

Immediately after CC connects, ToolHub sends:

```json
{
  "type": "hello",
  "protocol": "cc-pipe-v1",
  "module_id": "toolhub"
}
```

and requires the standard `hello-ack` before the session is considered bound.

## Lifecycle

Running state is the persistent CC pipe binding state. ToolHub does not expose a separate probe executable.

### Start

If ToolHub is Managed and unbound, CC launches:

```text
bin/mcp-toolhub-gui-host.exe --cc-backend --bootstrap
```

The normal backend starts, creates the standard pipe and waits for CC binding.

### Stop

CC sends:

```json
{
  "type": "lifecycle.stop",
  "request_id": 1001
}
```

ToolHub stops its tunnel runtime through the existing `TunnelManager`, replies with `lifecycle.result`, then exits the original backend.

## Frontend

The existing React frontend is reused unchanged at the page/component level.

Only its transport layer is dual-mode.

### Standalone Tauri mode

```text
React
 -> @tauri-apps/api invoke(...)
 -> existing Rust commands
```

### CC static-host mode

```text
React
 -> /api/modules/toolhub/*
 -> CC opaque HTTP/pipe proxy
 -> ToolHub CC Pipe Adapter
 -> existing Rust backend operations
```

The frontend automatically detects whether it is running inside Tauri.

The Vite build uses:

```text
base: "./"
```

so static assets remain valid when served below:

```text
/modules/toolhub/ui/
```

## ToolHub-owned proxied routes

CC does not interpret these routes.

ToolHub currently owns:

```text
GET  /dashboard
POST /tunnel/restart

GET  /logs?afterSequence=<n>
POST /logs/clear

GET  /modules
GET  /modules/{module-id}/config
PUT  /modules/{module-id}/config
POST /modules/{module-id}/probe
```

These correspond to the existing standalone GUI capabilities.

No ToolHub route semantics are added to CC itself.

## Concurrent HTTP proxy requests

Each `http.request` carries a required `request_id`.

ToolHub dispatches proxied requests independently and returns:

```json
{
  "type": "http.response",
  "request_id": 2001,
  "status": 200,
  "content_type": "application/json",
  "body_b64": "..."
}
```

Responses are correlated by request ID and do not require in-order completion.

## Error Mailbox

Only top-level Error transitions are proactively pushed.

Current ToolHub mappings are deliberately narrow:

```text
tunnel-runtime-error
tunnel-disconnected
```

Healthy/recovered state sends:

```json
{"type":"error.clear"}
```

ToolHub does not push normal logs, module status, tool catalogs, metrics, progress or other business events over the pipe.

Those remain pull-based through the module frontend API.

## Build

From the repository root:

```powershell
npm run cc:build
```

This performs the normal Tauri release build, which also builds the React frontend.

It then stages the same release backend binary at:

```text
bin/mcp-toolhub-gui-host.exe
```

and requires the static frontend entry to exist at:

```text
app/gui/dist/index.html
```

Both paths match `cc-module.json`.

## Pipe smoke test

Before the CC-side persistent router lands, the ToolHub backend can be validated directly with the repository smoke-test client.

Start the backend:

```powershell
.\bin\mcp-toolhub-gui-host.exe --cc-backend --bootstrap
```

Then, from a second PowerShell:

```powershell
.\scripts\test-cc-pipe.ps1
```

The script validates:

- the module-first `hello` handshake;
- `hello-ack`;
- length-prefixed framing;
- request correlation;
- `GET /dashboard` through `http.request/http.response`;
- interleaved Error Mailbox frames.

It does not issue `lifecycle.stop`.

## Onboarding

After the new CC pipe-router implementation lands:

```powershell
stanjk-pc-control-center.exe module onboard C:\STanJK\Development\MCP-ToolHub
```

Then use **Reload All**.

When Managed is enabled, CC may launch the ToolHub backend if it is unbound.

When ToolHub was started independently first, CC should bind to the already-running standard pipe instead of launching a second backend.

## Compatibility

These existing modes remain supported:

```powershell
.\scripts\run-tunnel.ps1
npm run start:local
npm run gui:build
```

and:

```text
mcp-toolhub-gui-host.exe
mcp-toolhub-gui-host.exe -bootstrap
```

The CC integration does not replace Secure MCP Tunnel mode or DSH local stdio mode.

## Boundary rules

ToolHub keeps ownership of:

- tunnel state and restart semantics;
- ToolHub module state;
- module configuration;
- module probes/tool catalogs;
- ToolHub logs;
- business/frontend semantics.

CC owns only:

- registration;
- optional Managed launch of the original backend;
- persistent pipe binding;
- static frontend hosting;
- opaque HTTP/pipe transport;
- lifecycle stop dispatch;
- one top-level Error latch.
