# Remote MCP proxy

## Purpose

`remote-mcp` is a multi-server MCP forwarder exposed through a fixed three-tool facade. One ToolHub module can aggregate multiple named remote Streamable HTTP MCP servers without mirroring every upstream schema into the connector.

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

## Connector-visible facade

ToolHub always exposes only:

```text
remote_mcp_status
remote_mcp_discover
remote_mcp_call
```

Example flow:

```text
remote_mcp_discover
  server = sleeprecord-server
  query = queryEnv
  include_schema = true

remote_mcp_call
  server = sleeprecord-server
  tool = queryEnv
  arguments = {...}
```

The configured server ID selects a local static profile. Remote callers still cannot supply or alter a URL, credential header, or unregistered backend.

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

`describe()` is static and does not contact any remote server.

At runtime:

1. `remote_mcp_status` checks one or all configured servers;
2. `remote_mcp_discover` connects to the selected server, calls `tools/list`, applies its `allow_tools` / `deny_tools` policy, and returns matching metadata;
3. schemas are omitted by default and returned only when `include_schema=true`;
4. `remote_mcp_call` revalidates the exact upstream tool name against the selected server's permitted catalog and forwards `tools/call`;
5. a failed call reconnects that server, refreshes the catalog, revalidates the tool, and retries once.

Credentials referenced through environment variables are resolved only when the selected server is contacted. A missing secret or unavailable remote backend therefore does not remove the fixed facade from ToolHub startup.

Changing the local server registry or allow/deny policy still requires restarting ToolHub because module configuration is loaded when the module instance is created.

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
