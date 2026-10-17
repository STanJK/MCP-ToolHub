import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { loadToolHubConfig } from "./core/config.mjs";
import { createToolHubServer } from "./core/server.mjs";
import { serveHostedHttp } from "./hosted-http.mjs";

function selectedTransport() {
  const index = process.argv.indexOf("--transport");
  if (index !== -1) {
    const value = process.argv[index + 1];
    if (!value) throw new Error("--transport requires stdio or http");
    return value;
  }
  return process.env.TOOLHUB_TRANSPORT ?? "stdio";
}

async function createServer() {
  const config = await loadToolHubConfig();
  return await createToolHubServer(config);
}

const transport = selectedTransport();

if (transport === "http") {
  await serveHostedHttp();
} else if (transport === "stdio") {
  serveStdio(createServer, {
    onerror(error) {
      console.error(error?.stack ?? error?.message ?? String(error));
    }
  });
  console.error("MCP-ToolHub running on stdio");
} else {
  throw new Error(`Unsupported ToolHub transport: ${transport}`);
}
