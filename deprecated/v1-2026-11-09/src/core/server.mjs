import { randomUUID } from "node:crypto";
import { McpServer, fromJsonSchema } from "@modelcontextprotocol/server";
import { loadEnabledModules } from "./modules.mjs";

const actionIdPattern = /^[a-z0-9][a-z0-9_]*$/;

function toolName(moduleId, actionId) {
  return `${moduleId.replaceAll("-", "_")}_${actionId}`;
}

function toMcpResult(result) {
  return {
    isError: result?.ok === false,
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
  };
}

export async function createToolHubServer(toolHubConfig) {
  const server = new McpServer({ name: "mcp-toolhub", version: "0.1.0" });
  const { loaded: modules, failed } = await loadEnabledModules(toolHubConfig);

  server.registerTool(
    "toolhub_module_status",
    {
      title: "ToolHub module status",
      description: "Report enabled ToolHub modules and isolate degraded backends.",
      inputSchema: {}
    },
    async () => {
      const ready = modules.map((module) => ({
        id: module.id,
        status: "ready",
        actions: module.descriptor.actions.length
      }));

      return toMcpResult({
        ok: true,
        status: failed.length === 0 ? "ready" : "degraded",
        modules: [...ready, ...failed]
      });
    }
  );

  for (const loaded of modules) {
    for (const action of loaded.descriptor.actions) {
      if (!action?.id || typeof action.id !== "string" || !actionIdPattern.test(action.id)) {
        console.error(
          `[ToolHub] skipping invalid action from module ${loaded.id}: ${String(action?.id)}`
        );
        continue;
      }

      let inputSchema;
      try {
        inputSchema = action.inputJsonSchema
          ? fromJsonSchema(action.inputJsonSchema)
          : (action.inputSchema ?? {});
      } catch (error) {
        console.error(
          `[ToolHub] skipping action ${loaded.id}.${action.id}: invalid schema: ${error instanceof Error ? error.message : String(error)}`
        );
        continue;
      }

      server.registerTool(
        toolName(loaded.id, action.id),
        {
          title: action.title ?? `${loaded.id}: ${action.id}`,
          description: action.description ?? "",
          inputSchema,
          annotations: action.annotations
        },
        async (input) => {
          try {
            const result = await loaded.instance.invoke(action.id, input ?? {}, {
              moduleId: loaded.id,
              configPath: loaded.configPath,
              requestId: randomUUID()
            });
            if (action.resultMode === "mcp") {
              return result;
            }
            return toMcpResult(result);
          } catch (error) {
            return toMcpResult({
              ok: false,
              status: "error",
              module: loaded.id,
              action: action.id,
              error: error instanceof Error ? error.message : String(error)
            });
          }
        }
      );
    }
  }

  return server;
}
