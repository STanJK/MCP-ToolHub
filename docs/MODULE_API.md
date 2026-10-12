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

## v1 non-goals

Module API v1 intentionally has no:

- module-to-module RPC;
- mutable Core object;
- lifecycle hooks;
- dependency injection container;
- remote module installation;
- arbitrary module entry paths.

Those can be added only when a concrete module requires them.
