# JADX MCP module

## Purpose

`jadx-mcp` is a dedicated ToolHub module for the local `0xdad0/jadx-mcp` plugin running inside `jadx-gui`.

It is intentionally separate from `remote-mcp`:

- `remote-mcp` is reserved for remote Streamable HTTP MCP services;
- `jadx-mcp` owns the local JADX GUI integration;
- the JADX module only accepts loopback URLs.

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
jadx_mcp_status / discover / call
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

Current JADX MCP settings:

```text
Host: 127.0.0.1
Port: 8811
Endpoint: http://127.0.0.1:8811/mcp
```

Keep the backend on loopback. The ToolHub module rejects non-loopback hosts.

## Module configuration

Copy the example:

```powershell
Copy-Item .\modules\jadx-mcp\jadx-mcp.example.yaml `
          .\modules\jadx-mcp\jadx-mcp.local.yaml
```

Current local config:

```yaml
version: 1
url: 'http://127.0.0.1:8811/mcp'

allow_tools:
  - '*'
deny_tools: []
```

Enable the module in `toolhub.local.yaml`:

```yaml
modules:
  jadx-mcp:
    enabled: true
    config: ./modules/jadx-mcp/jadx-mcp.local.yaml
```

## Connector-visible facade

The module always exposes only:

```text
jadx_mcp_status
jadx_mcp_discover
jadx_mcp_call
```

`describe()` is static and does not contact JADX, so closing JADX does not remove these tools from the connector catalog.

## Runtime flow

Health:

```text
jadx_mcp_status
```

Discover tools without schemas:

```text
jadx_mcp_discover
  query = decompile
  include_schema = false
```

Fetch schema only for a narrow tool set:

```text
jadx_mcp_discover
  query = <tool-name>
  include_schema = true
  limit = 5
```

Invoke:

```text
jadx_mcp_call
  tool = <exact upstream tool name>
  arguments = {...}
```

The full upstream JADX schema set therefore never becomes part of the connector-visible ToolHub catalog.

## Failure isolation

If JADX is closed or the plugin server is stopped:

```text
jadx_mcp_status
  -> status = offline
```

The ToolHub module itself remains loaded and other modules continue operating.

A failed call closes the local client, reconnects, refreshes the permitted upstream catalog, revalidates the requested tool, and retries once.

## Security boundary

The module accepts only:

```text
127.0.0.1
localhost
::1
```

The remote caller cannot provide a URL. The endpoint comes only from the local gitignored module config.

`allow_tools` and `deny_tools` remain local policy controls.
