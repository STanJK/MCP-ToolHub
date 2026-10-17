# Remote MCP proxy

## Purpose

`remote-mcp` makes MCP-ToolHub act as an MCP forwarder to one remote Streamable HTTP MCP server.

The intended chain is:

```text
ChatGPT cloud
    |
    v
OpenAI Secure MCP Tunnel
    |
    v
MCP-ToolHub
    |
    | Streamable HTTP + fixed static authentication
    v
remote MCP server
```

ToolHub remains the only MCP surface registered in ChatGPT. The remote server is aggregated behind it in the same way local child MCP servers are aggregated.

## Static authentication model

The remote URL and authentication headers are local ToolHub configuration. Remote callers cannot supply or modify them.

Example:

```yaml
version: 1

url: 'https://mcp.example.com/mcp'

headers:
  Authorization:
    env: TOOLHUB_REMOTE_MCP_TOKEN
    prefix: 'Bearer '

allow_tools:
  - '*'

deny_tools: []
```

For a custom two-header static validation scheme:

```yaml
headers:
  X-Client-Id:
    env: TOOLHUB_REMOTE_MCP_CLIENT_ID
  X-Client-Secret:
    env: TOOLHUB_REMOTE_MCP_CLIENT_SECRET
```

Literal non-secret headers are also allowed:

```yaml
headers:
  X-Integration: MCP-ToolHub
```

Secrets should normally be injected into the ToolHub process environment rather than written directly into YAML.

The following MCP transport-managed headers cannot be overridden:

- `Content-Type`
- `Mcp-Session-Id`
- `Mcp-Protocol-Version`

A static `Authorization` header is permitted.

## Transport policy

HTTPS is required by default.

Plain HTTP requires an explicit local opt-in:

```yaml
allow_insecure_http: true
```

This should only be used for a trusted LAN/dev endpoint.

The MCP SDK Streamable HTTP transport keeps redirects same-origin.

## Tool discovery and forwarding

At ToolHub startup, the module:

1. resolves configured static headers;
2. connects to the fixed remote MCP URL;
3. performs the MCP initialize handshake;
4. calls `tools/list`;
5. applies local `allow_tools` / `deny_tools`;
6. mirrors upstream JSON input schemas into ToolHub;
7. prefixes exported tools with `remote_mcp_`;
8. forwards `tools/call` and returns the upstream native MCP result.

If a call fails because the remote MCP connection has died, ToolHub closes the client, reconnects, and retries the call once.

The tool catalog is startup-time state. If the remote server changes its tool list or local allow/deny policy changes, restart ToolHub and refresh the ChatGPT connector.

## Relation to CloudBase static credentials

CloudBase hosted MCP examples use the same general shape: a fixed HTTP MCP URL plus static request headers for non-interactive authentication.

ToolHub generalizes that pattern instead of hard-coding Tencent-specific header names. Any remote MCP server can use Bearer, API-key, or custom static headers configured locally.

## Setup

Copy:

```powershell
Copy-Item .\modules\remote-mcp\remote-mcp.example.yaml `
          .\modules\remote-mcp\remote-mcp.local.yaml
```

Set the required secret environment variables, edit the fixed URL/tool policy, then enable:

```yaml
modules:
  remote-mcp:
    enabled: true
    config: ./modules/remote-mcp/remote-mcp.local.yaml
```

Restart ToolHub and refresh the ChatGPT connector.
