# JLCEDA Pro MCP integration

## Upstream reality

JLCEDA Pro / EasyEDA Pro desktop client V4.1.60+ includes its own command-line client and MCP server.

Mainland China executable:

```text
lceda-pro
```

Local MCP mode:

```powershell
lceda-pro --mcp stdio
```

Remote/browser-oriented MCP mode:

```powershell
lceda-pro --mcp http --port 3030 --token <token>
```

Official references:

- https://prodocs.lceda.cn/cn/api/guide/cli.html
- https://prodocs.lceda.cn/public/storage/texts/api/guide/cli-for-ai.html
- https://github.com/easyeda/easyeda-client-cli

The desktop CLI treats the running editor as a programmable backend. It manages editor sessions, can execute JavaScript through the extension API, can query API/format documentation, and exposes those capabilities over MCP.

## Why ToolHub proxies the official MCP

Older/community integrations commonly build:

```text
AI MCP -> custom bridge -> WebSocket -> Run API Gateway extension -> EasyEDA
```

That remains useful on older editor stacks, but current desktop clients already provide the MCP boundary.

ToolHub therefore uses:

```text
ChatGPT
  -> Secure MCP Tunnel
  -> MCP-ToolHub
  -> stdio MCP client
  -> lceda-pro --mcp stdio
  -> official local editor bridge
  -> JLCEDA Pro
```

ToolHub does not copy or reimplement:

- the JLCEDA bridge protocol;
- editor WebSocket framing;
- extension API metadata;
- the upstream MCP tool catalog.

## Discovery and forwarding

At ToolHub startup, the `lceda-pro` module:

1. spawns the configured official `lceda-pro --mcp stdio` child;
2. performs the MCP initialize handshake;
3. calls `tools/list`;
4. applies the local `allow_tools` / `deny_tools` policy;
5. mirrors each permitted upstream JSON input schema into ToolHub;
6. prefixes the public ToolHub tool name with `lceda_pro_`;
7. forwards later calls through MCP `tools/call`;
8. returns the upstream MCP result natively, preserving structured/content blocks.

The proxy runtime is process-global so MCP protocol probing does not spawn duplicate JLCEDA MCP children.

## Security boundary

This module is intentionally a different trust class from Local Build.

Local Build exposes fixed named process capabilities. The official JLCEDA MCP may expose editor mutation and generic invocation capabilities that can reach the full extension API. The upstream AI guide states that invocation under the built-in `eda` extension identity can carry external-interaction permissions including file/system access.

For that reason, the module requires an explicit local tool policy:

```yaml
allow_tools:
  - '*'
deny_tools: []
```

`*` means the operator intentionally trusts the full official MCP surface. Replace it with exact upstream tool names to narrow access.

The remote model cannot change the child executable, MCP arguments, or allow/deny policy; those remain local YAML configuration.

## Operational notes

- Desktop client only; the online/browser editor does not provide the documented session/bridge behavior.
- Verify the editor endpoint with `lceda-pro doctor`.
- The official AI guide recommends forward-slash Windows paths when values cross shell/JSON boundaries.
- Project writes should remain inside configured EasyEDA/JLCEDA project directories.
- The official workflow requires checking the top-level `ok` result after key editor commands.
- Tool discovery is startup-time. After upgrading JLCEDA Pro or changing tool policy, restart ToolHub and refresh the ChatGPT connector.
