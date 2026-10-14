# MCP-ToolHub

A small local MCP capability broker. The first module is **Local Build**: remote callers may select a configured project and a configured operation, but they never receive a general-purpose shell.

## Architecture

```text
ChatGPT / Codex / Responses API
        |
        v
OpenAI Secure MCP Tunnel
        |
        v
official openai/tunnel-client
        | stdio MCP
        v
ToolHub Core
        | Module API v1
        v
Local Build
        | local YAML bridge
        v
fixed project root + fixed process mapping
```

The tunnel layer is not reimplemented here. MCP-ToolHub uses OpenAI's official `openai/tunnel-client`.

## Requirements

- Node.js 20+
- npm
- Windows PowerShell 5.1+ or PowerShell 7+ for helper scripts
- an OpenAI Secure MCP Tunnel ID and runtime API key when using Tunnel

## Configuration

There are two local configuration layers.

### 1. ToolHub config

Copy:

```powershell
Copy-Item .\toolhub.example.yaml .\toolhub.local.yaml
```

Example:

```yaml
version: 1

tunnel:
  name: main
  id: tunnel_0123456789abcdef0123456789abcdef
  raw_key: sk-replace-me

modules:
  local-build:
    enabled: true
    config: ./modules/local-build/local-build.local.yaml
```

`toolhub.local.yaml` is gitignored. For v0.1 the raw runtime key is intentionally stored directly in this local file; a credential provider can replace this later.

### 2. Local Build bridge

Copy:

```powershell
Copy-Item .\modules\local-build\local-build.example.yaml .\modules\local-build\local-build.local.yaml
```

Example:

```yaml
version: 1

defaults:
  timeout_ms: 900000
  max_output_kb: 1024

projects:
  HalluCine:
    description: HalluCine workspace
    root: 'C:\STanJK\Development\HalluCine'

    operations:
      check:
        program: cargo.exe
        args:
          - check
          - --workspace

      build:
        program: cargo.exe
        args:
          - build
          - --workspace

      frontend-build:
        cwd: app\gui
        program: npm.cmd
        args:
          - run
          - build
```

`operations` is the allowlist. If an operation is not present, it cannot be requested remotely.

### Cargo locked verification

The default Cargo examples use `--locked`:

```text
cargo check --workspace --locked
cargo build --workspace --locked
cargo test  --workspace --locked
```

These operations are verification capabilities: if `Cargo.toml` and `Cargo.lock` disagree, Cargo fails instead of rewriting the local lockfile.

### Safe generated-state synchronization

Local Build also supports one narrow builtin:

```yaml
git-sync-generated:
  description: Safely replace a locally dirty Cargo.lock with an incoming origin/main Cargo.lock and fast-forward
  builtin: git-sync-generated
```

This is not a general Git reset/restore capability. It is hard-coded to `Cargo.lock`, `main`, and `origin/main`, and fails closed unless all of these are true:

1. `git fetch origin` succeeds.
2. The current branch is exactly `main`.
3. There are no staged changes.
4. The complete visible worktree change set is exactly one unstaged `Cargo.lock` modification.
5. `origin/main` is a fast-forward descendant of local `HEAD`.
6. `HEAD..origin/main` contains an incoming `Cargo.lock` change.

Only then does it restore the local `Cargo.lock` from `HEAD`, fast-forward to `origin/main`, and require the final `git status --porcelain` to be clean.


Remote callers cannot provide executable paths, argv, cwd, shell text, project roots, or arbitrary environment variables.

Local Build always launches configured operations with:

```text
spawn(program, args, { shell: false })
```

An optional operation `cwd` must be relative and must resolve inside the configured project root.

### Output retention

`max_output_kb` is enforced independently for stdout and stderr using UTF-8 byte counts. If a stream exceeds the configured limit, Local Build keeps the **tail** of that stream and reports the truncation explicitly.

A run result includes:

```json
{
  "stdout": "...",
  "stdout_truncated": false,
  "stdout_bytes_seen": 128,
  "stdout_bytes_returned": 128,
  "stderr": "...",
  "stderr_truncated": false,
  "stderr_bytes_seen": 0,
  "stderr_bytes_returned": 0
}
```

When `stdout_truncated` or `stderr_truncated` is `true`, the corresponding text is only the retained tail rather than the complete stream.

## Local Build MCP tools

The module exposes:

- `local_build_list_projects`
- `local_build_list_operations`
- `local_build_run`
- `local_build_get_run`
- `local_build_list_runs`
- `local_build_cancel_run`

`local_build_run` starts a configured operation and returns immediately with a `run_id`:

```json
{
  "ok": true,
  "run_id": "run_...",
  "status": "running",
  "project": "HalluCine",
  "operation": "cargo-build"
}
```

Long-running work is polled separately:

```json
{
  "run_id": "run_..."
}
```

with `local_build_get_run`. This keeps the local process lifecycle independent from any individual Tunnel request deadline.

At most one active job may exist per project. A busy response includes the current `active_run_id`.

On Windows, `local_build_cancel_run` uses `taskkill /PID <pid> /T /F` so the process tree is terminated rather than only the immediate parent process.

## Local setup

```powershell
git clone https://github.com/STanJK/MCP-ToolHub.git
cd MCP-ToolHub
npm install

Copy-Item .\toolhub.example.yaml .\toolhub.local.yaml
Copy-Item .\modules\local-build\local-build.example.yaml .\modules\local-build\local-build.local.yaml

notepad .\toolhub.local.yaml
notepad .\modules\local-build\local-build.local.yaml
```

For local stdio MCP testing:

```powershell
npx @modelcontextprotocol/inspector node .\src\index.mjs
```

## OpenAI Secure MCP Tunnel

Install the official tunnel client release and verify its SHA-256:

```powershell
.\scripts\bootstrap-tunnel.ps1
```

Create the official stdio tunnel-client profile from `toolhub.local.yaml`:

```powershell
.\scripts\init-tunnel.ps1
```

Run it:

```powershell
.\scripts\run-tunnel.ps1
```

The helper scripts read `tunnel.name`, `tunnel.id`, and `tunnel.raw_key` from the local ToolHub YAML. `raw_key` is injected into `CONTROL_PLANE_API_KEY` for the official tunnel client.

## Module API v1

Modules live at:

```text
modules/<module-id>/index.mjs
```

and implement only:

```text
describe()
invoke(action, input, context)
```

Core converts module actions to MCP tools. See `docs/MODULE_API.md` for the exact v1 contract.

## Repository layout

```text
src/
  index.mjs
  core/
    config.mjs
    config-cli.mjs
    modules.mjs
    server.mjs

modules/
  local-build/
    index.mjs
    local-build.example.yaml
    local-build.local.yaml      # gitignored

scripts/
  bootstrap-tunnel.ps1
  init-tunnel.ps1
  run-tunnel.ps1

docs/
  ARCHITECTURE.md
  MODULE_API.md

toolhub.example.yaml
toolhub.local.yaml              # gitignored
```

## Security direction

The current application boundary is a local declarative allowlist. For stronger isolation later, run ToolHub and `tunnel-client.exe` under a dedicated low-privilege Windows account with NTFS access only to explicitly exposed project roots.

## Upstream

- OpenAI tunnel client: https://github.com/openai/tunnel-client
- OpenAI Secure MCP Tunnel guide: https://developers.openai.com/api/docs/guides/secure-mcp-tunnels
- MCP TypeScript SDK: https://github.com/modelcontextprotocol/typescript-sdk
