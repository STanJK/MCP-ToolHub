# Architecture

## Layers

```text
OpenAI product
    |
    v
OpenAI Secure MCP Tunnel
    |
    v
official openai/tunnel-client
    |
    | stdio MCP
    v
ToolHub Core
    |
    | Module API v1
    v
Local Build
    |
    | bridge config
    v
project workspace + fixed operation
```

MCP-ToolHub does not implement the tunnel protocol. Transport is delegated to OpenAI's official `openai/tunnel-client`.

## Configuration split

### ToolHub configuration

`toolhub.local.yaml` owns:

- tunnel alias;
- tunnel ID;
- current raw runtime key;
- enabled module registry;
- each module's local config path.

It is local-only and gitignored.

### Module bridge configuration

Each module owns its own local configuration.

For Local Build:

```text
modules/local-build/local-build.local.yaml
```

This file owns:

- project IDs;
- absolute workspace roots;
- allowlisted operation IDs;
- fixed executable;
- fixed argv;
- optional relative cwd;
- timeout/output limits.

## Capability boundary

Remote Local Build input is limited to:

```json
{
  "project": "HalluCine",
  "operation": "build"
}
```

The caller cannot directly choose:

- executable;
- argv;
- shell text;
- cwd;
- environment variables;
- project root.

The bridge resolves the pair locally and calls Node `spawn(..., { shell: false })`.

## Workspace boundary

A project's root is absolute.

An operation may optionally provide a relative `cwd`. Before execution, Local Build resolves it against the project root and rejects any path that escapes the root.

Therefore a bridge entry such as:

```yaml
root: 'C:\Development\Example'
cwd: app\gui
```

is allowed, while absolute or parent-traversal cwd values that resolve outside the project root are rejected.

## Runtime model

Local Build uses asynchronous in-process jobs.

`run` only starts the configured process and returns a `run_id`. The process may continue after that MCP request has completed. Clients use `get_run` to poll status/output and `cancel_run` to request termination.

This deliberately separates:

```text
Tunnel request lifetime
!=
local build/test process lifetime
```

Local Build allows at most one active job per project. Different projects may run concurrently.

On Windows, cancellation terminates the full process tree with `taskkill /T /F`.

Completed jobs are retained in memory for recent inspection; retained stdout/stderr stay bounded by the configured output limit.

Bridge YAML is read when a new operation is started, so project/operation edits take effect without restarting ToolHub.

## Builtin capability boundary

Most Local Build operations are fixed `program + args` mappings. A builtin is permitted only when its semantics need multiple fail-closed checks that cannot be represented safely as one process invocation.

The first builtin is `git-sync-generated`. Its semantics are intentionally fixed in code:

- remote: `origin`;
- branch: `main`;
- generated file: `Cargo.lock`;
- no staged changes;
- no other visible worktree changes;
- only fast-forward synchronization;
- incoming remote state must itself modify `Cargo.lock`;
- final worktree must be clean.

The builtin accepts no remote path, command, branch, remote, or file argument. YAML may only opt a project into that exact capability with `builtin: git-sync-generated`.

Cargo verification operations should use `--locked` so normal check/build/test execution never rewrites dependency resolution state.

## Child MCP proxy modules

ToolHub can aggregate trusted local MCP servers through module-specific stdio clients.

Current proxy modules:

- `lceda-pro`: official JLCEDA Pro MCP child;
- `ida-pro`: `mrexodia/ida-pro-mcp` stdio proxy for the legacy in-IDA GUI plugin.

These modules discover their upstream tool catalogs at ToolHub startup, mirror each permitted upstream JSON input schema into Core, and return native MCP `CallToolResult` values.

The executable, argv, and allow/deny policy are local configuration. Remote callers can invoke only the mirrored tool names and cannot alter the child process command line.

Each proxy keeps one process-global child runtime per effective local configuration so repeated ToolHub server factories do not spawn duplicate child MCP processes.

For `ida-pro`, the child `ida-pro-mcp` process uses upstream instance discovery and proxies requests into the MCP server hosted by the running IDA GUI plugin. ToolHub does not parse Hex-Rays discovery files or speak the plugin's HTTP protocol directly.
## Credential state

v0.1 intentionally permits:

```yaml
tunnel:
  raw_key: sk-...
```

inside the local gitignored ToolHub config.

A later credential-provider layer can replace this field without changing Module API v1 or Local Build bridge semantics.
