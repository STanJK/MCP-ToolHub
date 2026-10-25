import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const coreDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(coreDir, "../..");
const moduleIdPattern = /^[a-z0-9][a-z0-9-]*$/;

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

export async function loadEnabledModules(toolHubConfig) {
  const loaded = [];
  const failed = [];

  for (const [moduleId, registration] of Object.entries(toolHubConfig.modules)) {
    if (!registration?.enabled) continue;

    const failure = (stage, error) => {
      const entry = {
        id: moduleId,
        status: "degraded",
        stage,
        error: errorMessage(error)
      };
      failed.push(entry);
      console.error(
        `[ToolHub] module ${moduleId} degraded during ${stage}: ${entry.error}`
      );
    };

    if (!moduleIdPattern.test(moduleId)) {
      failure("registration", new Error(`Invalid module id: ${moduleId}`));
      continue;
    }
    if (typeof registration.config !== "string" || registration.config.length === 0) {
      failure("registration", new Error(`Module ${moduleId} is missing config path`));
      continue;
    }

    const moduleEntry = path.join(repoRoot, "modules", moduleId, "index.mjs");
    const configPath = path.resolve(toolHubConfig.__meta.configDir, registration.config);

    let imported;
    try {
      imported = await import(pathToFileURL(moduleEntry).href);
    } catch (error) {
      failure("import", error);
      continue;
    }

    if (typeof imported.default !== "function") {
      failure(
        "contract",
        new Error(`Module ${moduleId} must default-export a factory function`)
      );
      continue;
    }

    let instance;
    try {
      instance = await imported.default({ moduleId, configPath });
    } catch (error) {
      failure("factory", error);
      continue;
    }

    if (!instance || typeof instance.describe !== "function" || typeof instance.invoke !== "function") {
      failure(
        "contract",
        new Error(`Module ${moduleId} must implement describe() and invoke()`)
      );
      continue;
    }

    let descriptor;
    try {
      descriptor = await instance.describe();
    } catch (error) {
      failure("describe", error);
      continue;
    }

    if (!descriptor || descriptor.id !== moduleId || descriptor.version !== 1 || !Array.isArray(descriptor.actions)) {
      failure(
        "contract",
        new Error(`Module ${moduleId} returned an invalid Module API v1 descriptor`)
      );
      continue;
    }

    loaded.push({
      id: moduleId,
      configPath,
      instance,
      descriptor,
      status: "ready"
    });
  }

  return { loaded, failed };
}
