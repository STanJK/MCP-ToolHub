import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const coreDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(coreDir, "../..");
const moduleIdPattern = /^[a-z0-9][a-z0-9-]*$/;

export async function loadEnabledModules(toolHubConfig) {
  const loaded = [];

  for (const [moduleId, registration] of Object.entries(toolHubConfig.modules)) {
    if (!registration?.enabled) continue;

    if (!moduleIdPattern.test(moduleId)) {
      throw new Error(`Invalid module id: ${moduleId}`);
    }
    if (typeof registration.config !== "string" || registration.config.length === 0) {
      throw new Error(`Module ${moduleId} is missing config path`);
    }

    const moduleEntry = path.join(repoRoot, "modules", moduleId, "index.mjs");
    const configPath = path.resolve(toolHubConfig.__meta.configDir, registration.config);
    const imported = await import(pathToFileURL(moduleEntry).href);

    if (typeof imported.default !== "function") {
      throw new Error(`Module ${moduleId} must default-export a factory function`);
    }

    const instance = await imported.default({ moduleId, configPath });

    if (!instance || typeof instance.describe !== "function" || typeof instance.invoke !== "function") {
      throw new Error(`Module ${moduleId} must implement describe() and invoke()`);
    }

    const descriptor = await instance.describe();
    if (!descriptor || descriptor.id !== moduleId || descriptor.version !== 1 || !Array.isArray(descriptor.actions)) {
      throw new Error(`Module ${moduleId} returned an invalid Module API v1 descriptor`);
    }

    loaded.push({ id: moduleId, configPath, instance, descriptor });
  }

  return loaded;
}
