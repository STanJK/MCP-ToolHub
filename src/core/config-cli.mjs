import { loadToolHubConfig } from "./config.mjs";

const command = process.argv[2];
const config = await loadToolHubConfig();

if (command === "tunnel-json") {
  if (!config.tunnel) {
    throw new Error("Tunnel config is not present in toolhub.local.yaml");
  }
  process.stdout.write(JSON.stringify(config.tunnel));
} else {
  throw new Error("Usage: node src/core/config-cli.mjs tunnel-json");
}
