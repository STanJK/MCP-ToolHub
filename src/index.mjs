import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { loadToolHubConfig } from "./core/config.mjs";
import { createToolHubServer } from "./core/server.mjs";

const config = await loadToolHubConfig();
const server = await createToolHubServer(config);
await serveStdio(server);
