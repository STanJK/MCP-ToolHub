# MCP-ToolHub

A narrow local capability broker for exposing **named, pre-approved project tasks** to MCP clients without exposing a general-purpose shell.

The intended remote path is:

```text
ChatGPT / Codex / Responses API
        |
        | MCP via OpenAI-hosted tunnel
        v
OpenAI Secure MCP Tunnel
        |
        | outbound-only HTTPS
        v
openai/tunnel-client  (runs locally)
        |
        | stdio MCP
        v
MCP-ToolHub
        |
        | local allowlist only
        +--> project A: build / test / lint / status
        +--> project B: build / test / ...
```

## Design rule

**MCP-ToolHub is not Remote PowerShell.**

Remote callers can only select:

- a configured project ID;
- a configured task ID.

They cannot provide:

- an arbitrary command;
- arbitrary command arguments;
- an arbitrary working directory;
- shell operators such as `|`, `>`, `&&`;
- an arbitrary PowerShell script body.

Every executable, argument and project root is defined in a local manifest that is not committed to Git.

## Tunnel: use the official implementation

This repository intentionally does **not** implement a reverse tunnel.

Use OpenAI's official [`openai/tunnel-client`](https://github.com/openai/tunnel-client) for the transport layer. It already supports:

- outbound-only HTTPS to the OpenAI tunnel control plane;
- stdio and Streamable HTTP MCP backends;
- streaming MCP notifications;
- health, readiness, metrics and a local admin UI;
- Windows, Linux and macOS release binaries;
- release checksums and provenance.

MCP-ToolHub only implements the local capability boundary.

## Requirements

- Node.js 20+
- npm
- Windows PowerShell 5.1+ or PowerShell 7+ for the helper scripts
- an OpenAI Secure MCP Tunnel ID and runtime API key when using the OpenAI tunnel

## Quick start: local MCP only

```powershell
git clone https://github.com/STanJK/MCP-ToolHub.git
cd MCP-ToolHub
npm install
Copy-Item .\toolhub.example.json .\toolhub.local.json
notepad .\toolhub.local.json
npm start
```

The server uses stdio, so it will wait for an MCP client on stdin.

To test with MCP Inspector:

```powershell
npx @modelcontextprotocol/inspector node .\src\index.mjs
```

## Configure projects and tasks

`toolhub.local.json` is deliberately gitignored.

Example:

```json
{
  "projects": {
    "example": {
      "description": "Example local project",
      "root": "C:\\Development\\ExampleProject",
      "tasks": {
        "status": {
          "description": "Show git status",
          "program": "git.exe",
          "args": ["status", "--short", "--branch"]
        },
        "build": {
          "description": "Run the project's checked-in build wrapper",
          "program": "powershell.exe",
          "args": [
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            ".toolhub\\build.ps1"
          ],
          "timeoutMs": 900000
        }
      }
    }
  }
}
```

A remote MCP caller sees only `example` and task names such as `status` and `build`.

## MCP tools

### `list_projects`

Lists project IDs and descriptions. Local filesystem paths are not exposed.

### `list_tasks`

Input:

```json
{ "project": "example" }
```

Lists the named tasks available for that project.

### `run_task`

Input:

```json
{
  "project": "example",
  "task": "build"
}
```

The server resolves that pair through the local manifest and launches the configured executable with Node's `spawn(..., { shell: false })`.

Only one task may execute per project at a time.

## OpenAI Secure MCP Tunnel

### 1. Install the official tunnel client

The helper script downloads the **latest official GitHub release**, verifies its SHA-256 against the release's `SHA256SUMS.txt`, and installs only the local binary under `.toolhub/bin/`.

```powershell
.\scripts\bootstrap-tunnel.ps1
```

Nothing from the tunnel client is vendored into this repository.

### 2. Install ToolHub dependencies

```powershell
npm install
```

### 3. Create the local ToolHub manifest

```powershell
Copy-Item .\toolhub.example.json .\toolhub.local.json
notepad .\toolhub.local.json
```

### 4. Initialize an OpenAI tunnel profile

Set the tunnel runtime key in the environment first:

```powershell
$env:CONTROL_PLANE_API_KEY = "sk-..."
```

Then initialize the profile:

```powershell
.\scripts\init-tunnel.ps1 -TunnelId "tunnel_..."
```

The helper configures the official tunnel client to launch:

```text
node <repo>\src\index.mjs
```

as its local stdio MCP backend.

### 5. Run

```powershell
$env:CONTROL_PLANE_API_KEY = "sk-..."
.\scripts\run-tunnel.ps1
```

The run helper passes the absolute `toolhub.local.json` path to the stdio child through `TOOLHUB_CONFIG`, runs `tunnel-client doctor`, then starts the official client.

## Security boundary

The important boundary is local and declarative:

```text
remote tool call
    |
    | project ID + task ID only
    v
toolhub.local.json
    |
    | fixed program + fixed args + fixed cwd
    v
spawn(shell = false)
```

For a stronger boundary, run the tunnel client and ToolHub under a dedicated low-privilege Windows account whose NTFS ACLs only permit the intended workspaces.

Do not put credentials in task arguments. Prefer environment variables, OS credential stores, or project-local mechanisms appropriate to the tool being launched.

## Repository layout

```text
src/
  index.mjs                    MCP capability broker
scripts/
  bootstrap-tunnel.ps1         fetch + verify official tunnel-client
  init-tunnel.ps1              create an official tunnel profile
  run-tunnel.ps1               doctor + run the profile
docs/
  ARCHITECTURE.md              trust boundaries and design notes
toolhub.example.json           tracked example manifest
toolhub.local.json             local manifest; gitignored
```

## Upstream references

- OpenAI Secure MCP Tunnel guide: https://developers.openai.com/api/docs/guides/secure-mcp-tunnels
- Official tunnel client: https://github.com/openai/tunnel-client
- Official tunnel wire protocol: https://github.com/openai/tunnel-client/blob/master/docs/protocol.md
- MCP TypeScript server SDK: https://github.com/modelcontextprotocol/typescript-sdk

The initial integration targets the current public OpenAI tunnel-client and MCP TypeScript v2 interfaces. No copy of the OpenAI tunnel protocol implementation is maintained here.
