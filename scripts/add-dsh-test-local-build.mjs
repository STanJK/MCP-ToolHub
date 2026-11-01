import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const configPath = path.resolve(
  process.env.TOOLHUB_LOCAL_BUILD_CONFIG ??
    path.join(repoRoot, "modules", "local-build", "local-build.local.yaml")
);
const projectRoot = path.resolve(
  process.env.DSH_TEST_ROOT ??
    "C:\\STanJK\\AIWorkspace\\DSH\\DSH_Test"
);
const force = process.argv.includes("--force") || process.env.npm_config_force === "true";

const raw = await readFile(configPath, "utf8");
const config = parse(raw);

if (!config || typeof config !== "object" || config.version !== 1) {
  throw new Error(`Invalid Local Build config: ${configPath}`);
}
if (!config.projects || typeof config.projects !== "object") {
  throw new Error("Invalid Local Build config: projects is required");
}
if (config.projects.DSH_Test && !force) {
  throw new Error(
    "DSH_Test already exists; rerun with --force only if you intentionally want to replace it"
  );
}

config.projects.DSH_Test = {
  description: "Local Rust build target for DSH tool-use validation",
  root: projectRoot,
  operations: {
    "git-status": {
      description: "Show DSH_Test git status",
      program: "git.exe",
      args: ["status", "--short", "--branch"]
    },
    "cargo-check": {
      description: "Check DSH_Test with locked dependency resolution",
      program: "cargo.exe",
      args: ["check", "--workspace", "--locked"]
    },
    "cargo-build": {
      description: "Build DSH_Test with locked dependency resolution",
      program: "cargo.exe",
      args: ["build", "--workspace", "--locked"]
    },
    "cargo-test": {
      description: "Test DSH_Test with locked dependency resolution",
      program: "cargo.exe",
      args: ["test", "--workspace", "--locked"]
    }
  }
};

await writeFile(configPath, stringify(config, { lineWidth: 0 }), "utf8");
console.log(`Configured DSH_Test Local Build project at ${projectRoot}`);
console.log(`Updated ${configPath}`);
