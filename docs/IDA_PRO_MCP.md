# IDA Pro MCP integration

## Upstream selected

This integration targets:

- https://github.com/mrexodia/ida-pro-mcp
- package entry point: `ida-pro-mcp`
- GUI plugin HTTP MCP endpoint: normally `http://127.0.0.1:13337/mcp`

The upstream project currently recommends the official Hex-Rays IDA MCP server for new deployments and states that its GUI plugin path is no longer the preferred long-term route. This ToolHub module exists for the already-installed mrexodia GUI bridge and can be replaced later without changing ToolHub Core.

## Upstream runtime model

The installed IDA plugin hosts an MCP/JSON-RPC server inside the IDA process and registers the running instance in the Hex-Rays discovery directory.

A standalone `ida-pro-mcp` process can run in stdio mode. In that mode it:

1. performs the MCP initialize handshake locally;
2. discovers running IDA instances;
3. selects the only instance, or the first instance when several exist;
4. proxies non-initialize MCP requests to that IDA instance over HTTP;
5. defaults to `127.0.0.1:13337` when discovery finds nothing.

ToolHub intentionally uses this stdio wrapper rather than reimplementing the upstream discovery-file format or its IDA HTTP proxy protocol.

## ToolHub chain

```text
ChatGPT
  -> OpenAI Secure MCP Tunnel
  -> MCP-ToolHub
       -> ida_pro_status
       -> ida_pro_discover
       -> ida_pro_call
  -> @modelcontextprotocol/client (stdio)
  -> ida-pro-mcp --transport stdio
  -> auto-discovered IDA GUI instance
  -> IDA plugin HTTP MCP endpoint
  -> current IDB
```

ToolHub deliberately exposes a fixed three-tool facade instead of mirroring the upstream IDA tool catalog into the connector. The upstream catalog is discovered at runtime only when `status`, `discover`, or `call` needs it.

## Module configuration

Copy:

```powershell
Copy-Item .\modules\ida-pro\ida-pro.example.yaml .\modules\ida-pro\ida-pro.local.yaml
```

Typical Windows configuration:

```yaml
version: 1

command: 'C:/STanJK/Env/Python/3.11.9/Scripts/ida-pro-mcp.exe'

args:
  - --transport
  - stdio

allow_tools:
  - '*'

deny_tools: []
```

Then enable the module in `toolhub.local.yaml`:

```yaml
modules:
  local-build:
    enabled: true
    config: ./modules/local-build/local-build.local.yaml

  lceda-pro:
    enabled: true
    config: ./modules/lceda-pro/lceda-pro.local.yaml

  ida-pro:
    enabled: true
    config: ./modules/ida-pro/ida-pro.local.yaml
```

## Multiple IDA instances

Upstream stdio auto-discovery selects the first discovered instance when more than one IDA GUI is running.

For deterministic routing, pin the IDA RPC endpoint locally:

```yaml
args:
  - --transport
  - stdio
  - --ida-rpc
  - 'http://127.0.0.1:13337'
```

The remote model cannot change this endpoint because executable and argv remain local ToolHub configuration.

## Debugger extension

mrexodia/ida-pro-mcp hides debugger tools by default.

To expose the upstream `dbg_*` extension, explicitly pin an RPC URL containing `?ext=dbg`:

```yaml
args:
  - --transport
  - stdio
  - --ida-rpc
  - 'http://127.0.0.1:13337/mcp?ext=dbg'
```

This is a separate local trust decision.

## Capability boundary

`allow_tools: ['*']` mirrors the upstream tool surface **except for ToolHub hard-denied Python execution capabilities**.

ToolHub always filters:

- `py_eval`;
- `py_exec_file`;
- future upstream tool names containing a standalone `py` or `python` execution namespace such as `py_shell`, `python_eval`, `exec_python`, or `run-py-script`.

This hard deny is enforced twice: during `tools/list` mirroring and again immediately before forwarding `tools/call`. Local `allow_tools: ['*']` cannot override it.

The remaining upstream surface still includes powerful mutating IDB capabilities such as comments/renaming, type edits, code/data definition changes, and patching bytes or assembly. Use exact upstream tool names in `allow_tools` or `deny_tools` if a narrower surface is desired.

ToolHub does not expose generic Python execution through this module.

## Fixed facade and reconnect behavior

The connector-visible surface is always:

```text
ida_pro_status
ida_pro_discover
ida_pro_call
```

`describe()` is static and never contacts IDA. Therefore IDA being closed does not degrade ToolHub startup and does not remove IDA capability names from the connector catalog.

Runtime behavior:

1. `ida_pro_status` attempts to connect and reports `ready` or `offline`;
2. `ida_pro_discover` performs upstream `tools/list`, applies hard/local policy, and returns matching tool metadata;
3. schemas are omitted by default and returned only when `include_schema=true`;
4. `ida_pro_call` validates the exact upstream tool name against the permitted runtime catalog and forwards `tools/call` natively;
5. a failed call closes the child client, reconnects, refreshes the catalog, revalidates the target tool, and retries once.

This avoids two structural problems of full mirroring:

- large upstream schemas no longer bloat every ChatGPT turn;
- opening or closing IDA no longer requires the connector to gain or lose dozens of dynamic tool definitions.

Changing the local allow/deny policy still requires restarting ToolHub because module configuration is loaded when the module instance is created.
