import { loadToolHubConfig } from "./config.mjs";

const command = process.argv[2];
const config = await loadToolHubConfig();

if (command === "tunnel-json") {
  process.stdout.write(JSON.stringify(config.tunnel));
} else {
  throw new Error("Usage: node src/core/config-cli.mjs tunnel-json");
}
