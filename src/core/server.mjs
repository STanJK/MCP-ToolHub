import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/server";
import { loadEnabledModules } from "./modules.mjs";

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
  const modules = await loadEnabledModules(toolHubConfig);

  for (const loaded of modules) {
    for (const action of loaded.descriptor.actions) {
      if (!action?.id || typeof action.id !== "string") {
        throw new Error(`Module ${loaded.id} has an action without an id`);
      }

      server.registerTool(
        toolName(loaded.id, action.id),
        {
          title: action.title ?? `${loaded.id}: ${action.id}`,
          description: action.description ?? "",
          inputSchema: action.inputSchema ?? {}
        },
        async (input) => {
          try {
            const result = await loaded.instance.invoke(action.id, input ?? {}, {
              moduleId: loaded.id,
              configPath: loaded.configPath,
              requestId: randomUUID()
            });
            return toMcpResult(result);
          } catch (error) {
            return toMcpResult({
              ok: false,
              status: "error",
              error: error instanceof Error ? error.message : String(error)
            });
          }
        }
      );
    }
  }

  return server;
}
