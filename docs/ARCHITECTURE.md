# Architecture

## Scope

MCP-ToolHub solves one narrow problem: allow an MCP client to invoke a small set of named local development tasks without exposing a general-purpose shell.

It does not implement a network tunnel. Remote connectivity is delegated to OpenAI's official `openai/tunnel-client`.

## Trust boundary

Remote input is limited to two identifiers:

- `project`
- `task`

The local `toolhub.local.json` resolves those identifiers to a fixed project root, executable and argument vector. The process is launched with `shell: false`.

The remote caller cannot directly choose:

- executable path;
- command text;
- command arguments;
- working directory;
- arbitrary environment variables.

## Why no home-grown tunnel

OpenAI's official tunnel client already implements authenticated outbound HTTPS polling, MCP stdio forwarding, Streamable HTTP forwarding, streaming notifications, health/readiness, metrics, diagnostics and supported Windows release artifacts.

Reimplementing the tunnel would increase attack surface and maintenance cost without strengthening the local capability boundary.

## Runtime model

Only one task may run per configured project at a time. Different projects can run independently.

Task stdout and stderr are bounded before returning them over MCP.

## Recommended Windows hardening

For a stronger second boundary, run both `tunnel-client.exe` and ToolHub under a dedicated low-privilege local account. Grant that account only the NTFS rights required for explicitly exposed project roots.

This gives two independent controls:

1. MCP allowlist: only named project/task pairs are callable.
2. Windows ACLs: even a ToolHub bug cannot access unrelated workspaces if the process identity lacks permission.

## Upstream transport

The intended transport chain is:

`OpenAI product -> Secure MCP Tunnel -> openai/tunnel-client -> stdio -> MCP-ToolHub`

The official tunnel client's `sample_mcp_stdio_local` profile is used as the integration path.
