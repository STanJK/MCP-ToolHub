# MCP-ToolHub

A small local MCP capability broker for exposing selected workstation capabilities without turning the machine into a general-purpose remote shell. Current modules cover fixed local build operations, local child-MCP proxies for JLCEDA Pro and IDA Pro, and a remote Streamable HTTP MCP proxy with fixed static authentication.

## Architecture

```text
ChatGPT / Codex
        |
        v
OpenAI Secure MCP Tunnel
        |
        v
official openai/tunnel-client
        | stdio MCP
        v
MCP-ToolHub Core
        |
        +---------------+---------------+---------------+
        |               |               |               |
        v               v               v               v
   Local Build      JLCEDA Pro       IDA Pro        Remote MCP
        |               |               |               |
 fixed project +   lceda-pro MCP   ida-pro-mcp    HTTPS + static
 fixed operation        |            stdio           headers
        |               v               |               |
        v          JLCEDA editor        v               v
 local toolchain                    IDA GUI       remote server
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

## Local Build project: RA3MCP

RA3MCP is wired directly to the underlying CMake / Cargo toolchains rather than through `Build.ps1`, `Test.ps1`, or `Stage.ps1`.

Project root:

```text
C:\STanJK\Development\RA3MCP
```

Current fixed operations:

```text
git-status
git-pull
git-sync-generated

native-configure
native-build
native-test

cargo-check
cargo-build
cargo-test
```

Native configuration uses the Visual Studio 2026 bundled CMake:

```text
C:\Program Files\Microsoft Visual Studio\18\Community\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe
```

with generator:

```text
Visual Studio 18 2026
Win32
```

The native sequence is equivalent to:

```text
cmake -S . -B build/win32
      -G "Visual Studio 18 2026"
      -A Win32
      -DMINHOOK_DIR:PATH=C:/STanJK/Development/RA3MCP/third_party/minhook
      -DRA3_BUILD_BRIDGE=ON

cmake --build build/win32 --config Release
ctest --test-dir build/win32 -C Release --output-on-failure
```

The Rust controller uses locked offline verification:

```text
cargo check --locked --offline -p ra3ctl
cargo build --locked --offline -p ra3ctl --release
cargo test  --locked --offline -p ra3ctl
```

`--locked` prevents local dependency-resolution drift; `--offline` prevents ToolHub verification from downloading dependencies.

RA3MCP staging remains outside the normal ToolHub build path for now.
## JLCEDA Pro / 嘉立创 EDA official MCP proxy

ToolHub can aggregate the MCP server built into JLCEDA Pro desktop client V4.1.60+.

```text
ChatGPT
  -> OpenAI Secure MCP Tunnel
  -> MCP-ToolHub
  -> @modelcontextprotocol/client (stdio)
  -> lceda-pro --mcp stdio
  -> JLCEDA Pro local bridge
  -> active editor session
```

ToolHub does not reimplement the editor protocol or JLCEDA WebSocket bridge. It launches the official MCP server as a child process, discovers its tools with `tools/list`, mirrors each upstream JSON input schema, and forwards `tools/call` results as native MCP results.

Create the local module config:

```powershell
Copy-Item .\modules\lceda-pro\lceda-pro.example.yaml .\modules\lceda-pro\lceda-pro.local.yaml
```

Example:

```yaml
version: 1
command: lceda-pro
args:
  - --mcp
  - stdio
allow_tools:
  - '*'
deny_tools: []
```

If the executable is not on PATH, use an absolute path such as:

```yaml
command: 'C:/Program Files/lceda-pro/lceda-pro.exe'
```

Then enable it in `toolhub.local.yaml`:

```yaml
modules:
  local-build:
    enabled: true
    config: ./modules/local-build/local-build.local.yaml

  lceda-pro:
    enabled: true
    config: ./modules/lceda-pro/lceda-pro.local.yaml
```

`allow_tools: ['*']` is an explicit trust decision: it mirrors the complete official MCP surface exposed by the installed JLCEDA Pro version, including editor-changing operations and any generic invocation capability. Replace `*` with exact upstream tool names to narrow the surface, and/or use `deny_tools`.

The upstream tool catalog is discovered when ToolHub starts. After changing the JLCEDA client version or tool policy, restart ToolHub and refresh the ChatGPT connector so the new tool catalog is discovered.
## IDA Pro / mrexodia ida-pro-mcp proxy

ToolHub can also aggregate the GUI MCP bridge from `mrexodia/ida-pro-mcp`.

```text
ChatGPT
  -> OpenAI Secure MCP Tunnel
  -> MCP-ToolHub
  -> ida-pro-mcp --transport stdio
  -> upstream instance auto-discovery
  -> IDA GUI plugin MCP on 127.0.0.1:<port>
  -> current IDB
```

The upstream stdio server already knows how to discover registered IDA GUI instances and proxy MCP requests to them, so ToolHub deliberately does not parse Hex-Rays discovery files or reimplement the IDA HTTP bridge.

Create the local config:

```powershell
Copy-Item .\modules\ida-pro\ida-pro.example.yaml .\modules\ida-pro\ida-pro.local.yaml
```

Example for the local Python environment used during installation:

```yaml
version: 1
command: 'C:/STanJK/Env/Python/3.11.9/Scripts/ida-pro-mcp.exe'
args:
  - --transport
  - stdio
allow_tools:
  - '*'
deny_tools: []
```

Enable it under `modules.ida-pro` in `toolhub.local.yaml`, restart ToolHub, and refresh the ChatGPT connector.

When multiple IDA instances are running, add `--ida-rpc http://127.0.0.1:<port>` to the local args to pin a specific instance. Debugger tools are an upstream opt-in extension and can be selected by pinning an RPC URL containing `?ext=dbg`.

`allow_tools: ['*']` is a high-trust mode: the upstream surface includes mutating IDB operations and `py_eval`. Use exact tool names to narrow it if needed.

The upstream project currently recommends the official Hex-Rays IDA MCP server for new deployments and describes this GUI-plugin path as transitional. The ToolHub module is intentionally isolated so the upstream implementation can be swapped later.

See `docs/IDA_PRO_MCP.md` for the exact runtime and trust model.
## Remote MCP proxy

`remote-mcp` is a generic multi-server forwarding module. ToolHub stays behind the existing Secure MCP Tunnel; each named server profile points to one remote Streamable HTTP MCP endpoint.

```text
ChatGPT cloud
  -> OpenAI Secure MCP Tunnel
  -> MCP-ToolHub
     -> remote-mcp / sleeprecord-server -> remote MCP
     -> remote-mcp / nas-server         -> remote MCP
     -> remote-mcp / lab-server         -> remote MCP
```

Create the local config:

```powershell
Copy-Item .\modules\remote-mcp\remote-mcp.example.yaml `
          .\modules\remote-mcp\remote-mcp.local.yaml
```

Example:

```yaml
version: 1

servers:
  sleeprecord-server:
    enabled: true
    url: 'https://sleep.example.com/mcp'

    headers:
      Authorization:
        env: TOOLHUB_SLEEPRECORD_TOKEN
        prefix: 'Bearer '

    allow_tools:
      - '*'
    deny_tools: []

  another-server:
    enabled: false
    url: 'https://another.example.com/mcp'
    headers:
      X-API-Key:
        env: TOOLHUB_ANOTHER_SERVER_API_KEY
    allow_tools:
      - '*'
    deny_tools: []
```

Server IDs are local static capability names. They must match:

```text
[a-z0-9][a-z0-9-]*
```

If `sleeprecord-server` exposes an upstream tool called `get_sleep_summary`, ChatGPT sees:

```text
remote_mcp_sleeprecord_server_get_sleep_summary
```

The remote caller cannot choose an arbitrary URL or authentication header. URL, headers, credentials, and allow/deny policy are all local ToolHub configuration.

HTTPS is required by default; `allow_insecure_http: true` is an explicit opt-in for trusted LAN/dev endpoints.

See `docs/REMOTE_MCP.md`.
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
    builtins/
      git-sync-generated.mjs
    local-build.example.yaml
    local-build.local.yaml      # gitignored

  lceda-pro/
    index.mjs
    lceda-pro.example.yaml
    lceda-pro.local.yaml        # gitignored

  ida-pro/
    index.mjs
    ida-pro.example.yaml
    ida-pro.local.yaml          # gitignored

scripts/
  bootstrap-tunnel.ps1
  init-tunnel.ps1
  run-tunnel.ps1

docs/
  ARCHITECTURE.md
  MODULE_API.md
  JLCEDA_MCP.md
  IDA_PRO_MCP.md
  REMOTE_MCP.md

toolhub.example.yaml
toolhub.local.yaml              # gitignored
```

## Security direction

The current application boundary is a local declarative allowlist. For stronger isolation later, run ToolHub and `tunnel-client.exe` under a dedicated low-privilege Windows account with NTFS access only to explicitly exposed project roots.

## Upstream

- OpenAI tunnel client: https://github.com/openai/tunnel-client
- OpenAI Secure MCP Tunnel guide: https://developers.openai.com/api/docs/guides/secure-mcp-tunnels
- MCP TypeScript SDK: https://github.com/modelcontextprotocol/typescript-sdk
