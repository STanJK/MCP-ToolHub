import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { loadToolHubConfig } from "./core/config.mjs";
import { createToolHubServer } from "./core/server.mjs";

async function createServer() {
  const config = await loadToolHubConfig();
  return await createToolHubServer(config);
}

serveStdio(createServer, {
  onerror(error) {
    console.error(error?.stack ?? error?.message ?? String(error));
  }
});

console.error("MCP-ToolHub running on stdio");
