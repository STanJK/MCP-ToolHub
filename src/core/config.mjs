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
  if (config.tunnel !== undefined) {
    if (!config.tunnel || typeof config.tunnel !== "object") {
      throw new Error("Invalid ToolHub config: tunnel must be an object when present");
    }
    for (const key of ["name", "id", "raw_key"]) {
      if (typeof config.tunnel[key] !== "string" || config.tunnel[key].length === 0) {
        throw new Error(`Invalid ToolHub config: tunnel.${key} is required when tunnel is configured`);
      }
    }
  }

  if (config.http !== undefined) {
    if (!config.http || typeof config.http !== "object") {
      throw new Error("Invalid ToolHub config: http must be an object when present");
    }

    const host = config.http.host ?? "127.0.0.1";
    const port = config.http.port ?? 3333;
    const mcpPath = config.http.path ?? "/mcp";

    if (typeof host !== "string" || host.length === 0) {
      throw new Error("Invalid ToolHub config: http.host must be a non-empty string");
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error("Invalid ToolHub config: http.port must be an integer from 1 to 65535");
    }
    if (typeof mcpPath !== "string" || !mcpPath.startsWith("/")) {
      throw new Error("Invalid ToolHub config: http.path must start with /");
    }
    if (config.http.allow_public_bind !== undefined && typeof config.http.allow_public_bind !== "boolean") {
      throw new Error("Invalid ToolHub config: http.allow_public_bind must be boolean");
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
