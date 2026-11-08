import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { loadToolHubConfig } from "./core/config.mjs";
import { createToolHubServer } from "./core/server.mjs";

const args = new Set(process.argv.slice(2));
const localMode = args.has("--local");

async function createServer() {
  const config = await loadToolHubConfig(undefined, {
    modeOverride: localMode ? "local" : undefined
  });
  return await createToolHubServer(config);
}

serveStdio(createServer, {
  onerror(error) {
    console.error(error?.stack ?? error?.message ?? String(error));
  }
});

console.error(
  localMode
    ? "MCP-ToolHub running on stdio (local mode)"
    : "MCP-ToolHub running on stdio (tunnel mode)"
);
