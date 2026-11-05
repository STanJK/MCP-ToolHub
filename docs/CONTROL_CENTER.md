# Control Center integration

MCP-ToolHub implements the downstream boundary defined by **STanJK PC Control Center — CC Module Spec v1**.

The integration is intentionally narrow:

```text
STanJK PC Control Center
        |
        | probe / start / stop
        v
bin/cc-interface.exe
        |
        v
ToolHub-owned CC runtime
        |
        +-- scripts/init-tunnel.ps1
        +-- scripts/run-tunnel.ps1
        +-- official tunnel-client.exe
        +-- MCP-ToolHub Core
```

Control Center does not know ToolHub module state, tunnel metrics, verbose logs, configuration, MCP catalogs, or backend-specific diagnostics.

## Package contract

The repository root contains:

```text
cc-module.json
```

with module id:

```text
toolhub
```

The manifest declares only the lifecycle interface:

```text
bin/cc-interface.exe
```

No CC-hosted module UI is declared in v1. The existing Tauri ToolHub GUI remains a standalone module-owned interface because its current frontend depends on the Tauri backend and is not a static CC-hosted page.

## Lifecycle semantics

### probe

`probe` is side-effect-light.

It returns exactly one JSON object:

```json
{"running": true}
```

or:

```json
{"running": false}
```

Running means either:

1. the CC-managed ToolHub runtime process is alive; or
2. the compatible legacy ToolHub tunnel runtime is already active through the repository-local `.toolhub/bin/tunnel-client.exe`.

Probe does not report tunnel readiness, backend health, module health, logs, or metrics.

### start

`start` returns promptly after dispatching the ToolHub-owned CC runtime.

The CC runtime:

1. refreshes the existing tunnel-client profile through `scripts/init-tunnel.ps1`;
2. starts the existing `scripts/run-tunnel.ps1` path;
3. owns the resulting process tree;
4. monitors only the top-level tunnel readiness needed for Error Mailbox reporting.

If a compatible ToolHub tunnel is already running, start is idempotent and does not launch a duplicate runtime.

### stop

`stop` terminates the CC-managed ToolHub runtime process tree.

For compatibility, if ToolHub was started through the legacy launcher rather than CC, the adapter may stop the repository-local `tunnel-client.exe` that owns the default ToolHub health listener.

## Error Mailbox

When CC invokes `start`, it supplies `CC_ERROR_MAILBOX_URL`.

The ToolHub-owned CC runtime may report only top-level problems such as:

- `toolhub-config-missing`
- `tunnel-profile-init-failed`
- `tunnel-runtime-start-failed`
- `tunnel-not-ready`
- `tunnel-runtime-exited`
- `toolhub-cc-runtime-failed`

The runtime clears the Error latch after the tunnel readiness endpoint becomes healthy.

ToolHub does not send normal logs, module status, MCP activity, progress, or metrics through the mailbox.

Detailed module-owned logs remain at:

```text
%LOCALAPPDATA%\MCP-ToolHub\cc\cc-runtime.log
```

## Build the CC adapter

From the ToolHub repository root:

```powershell
npm run cc:build
```

This runs:

```text
cargo build --manifest-path cc-interface/Cargo.toml --release --locked
```

and stages:

```text
bin/cc-interface.exe
```

The staged executable is intentionally not committed.

## Pre-onboarding requirements

Before onboarding ToolHub into CC:

1. `node.exe` must be available in PATH.
2. `toolhub.local.yaml` must exist.
3. the official tunnel client must be installed:

```powershell
.\scripts\bootstrap-tunnel.ps1
```

4. build the lifecycle adapter:

```powershell
npm run cc:build
```

## Direct lifecycle smoke test

A local smoke test can be run without Control Center:

```powershell
cd C:\STanJK\Development\MCP-ToolHub
$env:CC_MODULE_ROOT = (Get-Location).Path

.\bin\cc-interface.exe probe
.\bin\cc-interface.exe start
.\bin\cc-interface.exe probe
.\bin\cc-interface.exe stop
.\bin\cc-interface.exe probe
```

Without `CC_ERROR_MAILBOX_URL`, mailbox reporting is simply disabled for this manual smoke test.

## Onboard into Control Center

Build Control Center from its `round1/headless-supervisor` implementation, then run its administration command:

```powershell
stanjk-pc-control-center.exe module onboard C:\STanJK\Development\MCP-ToolHub
```

After onboarding, use **Reload All** in the CC Dashboard.

Set ToolHub to **Managed** when CC should own its desired running state across CC startup and unexpected stops.

## Legacy compatibility

The CC integration does not replace existing ToolHub entry points.

These remain supported:

```powershell
.\scripts\run-tunnel.ps1
```

Standalone GUI:

```text
mcp-toolhub-gui-host.exe
mcp-toolhub-gui-host.exe -bootstrap
```

Local DSH stdio mode:

```powershell
npm run start:local
```

Lifecycle ownership should not be mixed deliberately. When CC owns the runtime, Start/Stop should be performed through Control Center. The standalone launchers remain compatibility paths for machines or sessions where CC is not the lifecycle owner.

## Deliberate v1 exclusions

This integration does not add any of the following to the CC boundary:

- ToolHub module telemetry
- ToolHub logs
- MCP tool catalogs
- tunnel metrics
- module configuration editing
- ToolHub business APIs
- module-to-module RPC
- a CC event bus

Those remain ToolHub-owned concerns.
