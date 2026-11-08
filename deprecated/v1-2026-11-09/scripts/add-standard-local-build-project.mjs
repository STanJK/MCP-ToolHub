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

const projectId = process.env.TOOLHUB_PROJECT_ID;
const projectRootRaw = process.env.TOOLHUB_PROJECT_ROOT;
const description =
  process.env.TOOLHUB_PROJECT_DESCRIPTION ??
  (projectId ? `${projectId} standard Local Build project` : undefined);

const force =
  process.argv.includes("--force") ||
  process.env.npm_config_force === "true";

if (!projectId || !/^[A-Za-z0-9_.-]+$/.test(projectId)) {
  throw new Error(
    "Set TOOLHUB_PROJECT_ID to a non-empty project id using only letters, digits, _, ., or -"
  );
}
if (!projectRootRaw) {
  throw new Error("Set TOOLHUB_PROJECT_ROOT to an absolute project directory");
}

const projectRoot = path.resolve(projectRootRaw);
if (!path.isAbsolute(projectRoot)) {
  throw new Error("TOOLHUB_PROJECT_ROOT must resolve to an absolute path");
}

const raw = await readFile(configPath, "utf8");
const config = parse(raw);

if (!config || typeof config !== "object" || config.version !== 1) {
  throw new Error(`Invalid Local Build config: ${configPath}`);
}
if (!config.projects || typeof config.projects !== "object") {
  throw new Error("Invalid Local Build config: projects is required");
}
if (config.projects[projectId] && !force) {
  throw new Error(
    `${projectId} already exists; rerun with -- --force only if you intentionally want to replace it`
  );
}

config.projects[projectId] = {
  description,
  root: projectRoot,
  operations: {
    "git-status": {
      description: `Show ${projectId} git status`,
      program: "git.exe",
      args: ["status", "--short", "--branch"]
    },
    "git-pull": {
      description: `Fast-forward ${projectId} from its configured upstream`,
      program: "git.exe",
      args: ["pull", "--ff-only"]
    },
    "git-sync-generated": {
      description: "Safely recover a locally dirty Cargo.lock when origin/main contains the canonical incoming lockfile",
      builtin: "git-sync-generated"
    },
    "cargo-check": {
      description: "Cargo workspace check with locked dependency resolution",
      program: "cargo.exe",
      args: ["check", "--workspace", "--locked"]
    },
    "cargo-build": {
      description: "Cargo workspace build with locked dependency resolution",
      program: "cargo.exe",
      args: ["build", "--workspace", "--locked"]
    },
    "cargo-test": {
      description: "Cargo workspace test with locked dependency resolution",
      program: "cargo.exe",
      args: ["test", "--workspace", "--locked"]
    },
    "frontend-npm-build": {
      description: "Build frontend from app/gui",
      cwd: "app\\gui",
      program: "npm.cmd",
      args: ["run", "build"]
    }
  }
};

await writeFile(configPath, stringify(config, { lineWidth: 0 }), "utf8");

console.log(`Configured standard Local Build project ${projectId}`);
console.log(`Root: ${projectRoot}`);
console.log(`Updated: ${configPath}`);
