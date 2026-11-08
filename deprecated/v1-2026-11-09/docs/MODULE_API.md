# Module API v1

MCP-ToolHub modules use a deliberately small runtime contract.

A module lives at:

```text
modules/<module-id>/index.mjs
```

and default-exports a factory:

```js
export default async function createModule({ moduleId, configPath }) {
  return {
    async describe() { ... },
    async invoke(action, input, context) { ... }
  };
}
```

## describe()

`describe()` returns the module identity and the actions that Core should expose as MCP tools.

```js
{
  id: "local-build",
  version: 1,
  actions: [
    {
      id: "run",
      title: "Run Local Build operation",
      description: "...",
      inputSchema: {
        project: z.string(),
        operation: z.string()
      }
    }
  ]
}
```

Core converts the module/action pair into an MCP tool name:

```text
local-build + run
        ↓
local_build_run
```

## MCP proxy actions

Module API v1 also supports a narrow proxy extension for modules that aggregate another MCP server.

An action may provide an upstream JSON Schema directly:

```js
{
  id: "upstream_tool",
  inputJsonSchema: upstreamTool.inputSchema,
  resultMode: "mcp"
}
```

Core wraps `inputJsonSchema` with the MCP SDK's `fromJsonSchema()`, so the upstream schema is advertised and validated without translating it into Zod manually.

When `resultMode: "mcp"` is set, `invoke()` returns a standard MCP `CallToolResult` and Core forwards it directly instead of wrapping it in ToolHub JSON-text convention. This preserves native MCP content blocks and structured content.

This extension is used by the `lceda-pro` module to proxy the official JLCEDA Pro MCP server.
## invoke()

```js
invoke(action, input, context)
```

Arguments:

- `action`: action ID declared by `describe()`
- `input`: validated MCP tool input
- `context.moduleId`: current module ID
- `context.configPath`: absolute path to the module's local configuration
- `context.requestId`: per-call request identifier

A module should return a JSON-serializable object. Convention:

```json
{
  "ok": true,
  "status": "completed"
}
```

If `ok` is `false`, Core marks the MCP tool result as an error.

## Module discovery

Top-level `toolhub.local.yaml` enables modules:

```yaml
modules:
  local-build:
    enabled: true
    config: ./modules/local-build/local-build.local.yaml
```

The module ID must match:

```text
[a-z0-9][a-z0-9-]*
```

Core then loads only:

```text
modules/<module-id>/index.mjs
```

The remote caller cannot provide a module file path.

## Failure isolation

Module API v1 modules are isolated at the Core boundary. If an enabled module cannot be imported, instantiated, described, or validated, Core records that module as `degraded`, logs the reason, skips its tools, and continues serving healthy modules.

Core exposes:

```text
toolhub_module_status
```

which reports each ready module with its action count and each degraded module with the failure stage and error message.

A module invocation failure is already scoped to that tool call and is returned as an MCP error result; it does not tear down the ToolHub server.
## v1 non-goals

Module API v1 intentionally has no:

- module-to-module RPC;
- mutable Core object;
- lifecycle hooks;
- dependency injection container;
- remote module installation;
- arbitrary module entry paths.

Those can be added only when a concrete module requires them.
