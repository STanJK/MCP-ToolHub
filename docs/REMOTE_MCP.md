# Remote MCP proxy

## Purpose

`remote-mcp` is a multi-server MCP forwarder. One ToolHub module can aggregate multiple named remote Streamable HTTP MCP servers.

```text
ChatGPT cloud
    |
    v
OpenAI Secure MCP Tunnel
    |
    v
MCP-ToolHub
    |
    +-> remote-mcp / sleeprecord-server -> remote MCP A
    +-> remote-mcp / nas-server         -> remote MCP B
    +-> remote-mcp / lab-server         -> remote MCP C
```

ToolHub remains the only MCP surface registered in ChatGPT.

## Named server profiles

The local config uses a `servers` map:

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

  nas-server:
    enabled: false
    url: 'https://nas.example.com/mcp'
    headers:
      X-API-Key:
        env: TOOLHUB_NAS_API_KEY
    allow_tools:
      - '*'
    deny_tools: []
```

Server IDs are static local capability names and must match:

```text
[a-z0-9][a-z0-9-]*
```

Examples:

```text
sleeprecord-server
nas-server
lab-server
```

The remote caller cannot supply a URL or create an arbitrary server profile.

## Public Tool names

Each upstream tool is namespaced by the configured server ID.

For example, if `sleeprecord-server` exposes:

```text
get_sleep_summary
list_sleep_sessions
```

ToolHub exposes:

```text
remote_mcp_sleeprecord_server_get_sleep_summary
remote_mcp_sleeprecord_server_list_sleep_sessions
```

This keeps multiple remote servers from colliding in the ChatGPT tool catalog.

## Static authentication

Headers are fixed local configuration. Secret values should normally be resolved from environment variables:

```yaml
headers:
  Authorization:
    env: TOOLHUB_SLEEPRECORD_TOKEN
    prefix: 'Bearer '
```

Custom static validation is also supported:

```yaml
headers:
  X-Client-Id:
    env: TOOLHUB_SLEEPRECORD_CLIENT_ID
  X-Client-Secret:
    env: TOOLHUB_SLEEPRECORD_CLIENT_SECRET
```

Literal non-secret headers are allowed:

```yaml
headers:
  X-Integration: MCP-ToolHub
```

The following transport-managed headers cannot be overridden:

- `Content-Type`
- `Mcp-Session-Id`
- `Mcp-Protocol-Version`

A static `Authorization` header is permitted.

## Transport policy

HTTPS is required by default. Plain HTTP requires explicit local opt-in:

```yaml
allow_insecure_http: true
```

The Streamable HTTP client keeps redirects same-origin.

## Discovery and forwarding

At ToolHub startup, each enabled server profile is initialized independently:

1. resolve its fixed URL and headers;
2. connect with Streamable HTTP;
3. perform MCP initialization;
4. call `tools/list`;
5. apply that server's `allow_tools` / `deny_tools` policy;
6. namespace the mirrored tools with the server ID;
7. forward later `tools/call` requests to the selected server.

Each server keeps its own MCP client/runtime. A call failure reconnects that server and retries once.

The mirrored tool catalog is startup-time state. After changing server profiles, remote tool lists, or allow/deny policy, restart ToolHub and refresh the ChatGPT connector.

## Setup

Copy:

```powershell
Copy-Item .\modules\remote-mcp\remote-mcp.example.yaml `
          .\modules\remote-mcp\remote-mcp.local.yaml
```

Enable the module once:

```yaml
modules:
  remote-mcp:
    enabled: true
    config: ./modules/remote-mcp/remote-mcp.local.yaml
```

Additional remote servers are added under `servers:`; no additional ToolHub module registration is required.
