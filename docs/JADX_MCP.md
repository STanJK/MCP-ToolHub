# JADX MCP via remote-mcp

## Purpose

JADX is integrated through the existing `remote-mcp` facade rather than a dedicated ToolHub module.

The local backend is the `0xdad0/jadx-mcp` plugin running inside `jadx-gui`:

```text
ChatGPT / Codex
    |
    v
OpenAI Secure MCP Tunnel
    |
    v
MCP-ToolHub
    |
    v
remote_mcp_status / discover / call
    |
    v
http://127.0.0.1:8811/mcp
    |
    v
0xdad0/jadx-mcp
    |
    v
jadx-gui 1.5.6
    |
    v
current APK / DEX / JAR
```

No JADX-specific connector tools are added. The connector-visible ToolHub surface remains the fixed three-tool `remote-mcp` facade.

## Local layout

Current local convention:

```text
C:\STanJK\Software\Jadx\
    jadx-gui-1.5.6.exe
    jre\
    lib\

C:\STanJK\Env\LocalMCP\jadx-mcp\
    build\libs\jadx-mcp-0.1.0.jar

C:\Users\STanJK\.jadx\plugins\
    jadx-mcp-0.1.0.jar
```

JADX MCP settings:

```text
Host: 127.0.0.1
Port: 8811
Endpoint: http://127.0.0.1:8811/mcp
```

Keep the MCP server on loopback. The local plugin should not be exposed directly to LAN/WAN.

## remote-mcp profile

Add this server under `servers:` in:

```text
modules/remote-mcp/remote-mcp.local.yaml
```

```yaml
  jadx:
    enabled: true
    url: 'http://127.0.0.1:8811/mcp'
    allow_insecure_http: true
    headers: {}
    allow_tools:
      - '*'
    deny_tools: []
```

Plain HTTP is explicitly allowed only because the endpoint is loopback-local.

## Runtime flow

Check backend health:

```text
remote_mcp_status
  server = jadx
```

Discover tools without schemas:

```text
remote_mcp_discover
  server = jadx
  query = decompile
  include_schema = false
```

Fetch schema only for the tool about to be called:

```text
remote_mcp_discover
  server = jadx
  query = <exact-or-narrow-tool-name>
  include_schema = true
  limit = 5
```

Invoke:

```text
remote_mcp_call
  server = jadx
  tool = <exact upstream tool name>
  arguments = {...}
```

This keeps the full JADX upstream catalog out of the connector schema and only brings relevant argument schemas into model context on demand.

## Lifecycle

The `remote-mcp` server registry is loaded when ToolHub starts.

After adding or changing the `jadx` profile:

1. stop ToolHub;
2. start/restart `jadx-gui` and start the jadx-mcp server;
3. restart ToolHub;
4. a ChatGPT connector refresh is not required solely for adding the profile because the connector-visible `remote_mcp_status / discover / call` tools are unchanged.

If JADX is closed later, only the `jadx` backend becomes unavailable. Other ToolHub modules and remote MCP profiles continue working.
