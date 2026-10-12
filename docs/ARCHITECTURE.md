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

Local Build allows at most one running operation per project. Different projects may run concurrently.

Bridge YAML is read on each invocation, so project/operation edits take effect without restarting ToolHub.

stdout and stderr are bounded before being returned through MCP.

## Credential state

v0.1 intentionally permits:

```yaml
tunnel:
  raw_key: sk-...
```

inside the local gitignored ToolHub config.

A later credential-provider layer can replace this field without changing Module API v1 or Local Build bridge semantics.
