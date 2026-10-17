import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { parse } from "yaml";

export function getToolHubConfigPath() {
  return path.resolve(
    process.env.TOOLHUB_CONFIG ?? path.join(process.cwd(), "toolhub.local.yaml")
  );
}

export async function loadToolHubConfig(configPath = getToolHubConfigPath()) {
  const resolvedPath = path.resolve(configPath);
  const raw = await readFile(resolvedPath, "utf8");
  const config = parse(raw);

  if (!config || typeof config !== "object") {
    throw new Error("Invalid ToolHub config: expected a YAML object");
  }
  if (config.version !== 1) {
    throw new Error("Invalid ToolHub config: version must be 1");
  }
  if (!config.tunnel || typeof config.tunnel !== "object") {
    throw new Error("Invalid ToolHub config: tunnel is required");
  }

  for (const key of ["name", "id", "raw_key"]) {
    if (typeof config.tunnel[key] !== "string" || config.tunnel[key].length === 0) {
      throw new Error(`Invalid ToolHub config: tunnel.${key} is required`);
    }
  }

  if (!config.modules || typeof config.modules !== "object") {
    throw new Error("Invalid ToolHub config: modules is required");
  }

  return {
    ...config,
    __meta: {
      configPath: resolvedPath,
      configDir: path.dirname(resolvedPath)
    }
  };
}
