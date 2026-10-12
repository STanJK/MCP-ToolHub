import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { parse } from "yaml";
import { z } from "zod";

const runningProjects = new Set();

async function loadBridgeConfig(configPath) {
  const raw = await readFile(configPath, "utf8");
  const config = parse(raw);

  if (!config || typeof config !== "object") {
    throw new Error("Invalid Local Build config: expected a YAML object");
  }
  if (config.version !== 1) {
    throw new Error("Invalid Local Build config: version must be 1");
  }
  if (!config.projects || typeof config.projects !== "object") {
    throw new Error("Invalid Local Build config: projects is required");
  }

  return config;
}

function getProject(config, projectId) {
  const project = config.projects[projectId];
  if (!project) throw new Error(`Unknown project: ${projectId}`);
  if (typeof project.root !== "string" || project.root.length === 0) {
    throw new Error(`Project ${projectId} is missing root`);
  }
  if (!path.isAbsolute(project.root)) {
    throw new Error(`Project ${projectId} root must be absolute`);
  }
  if (!project.operations || typeof project.operations !== "object") {
    throw new Error(`Project ${projectId} is missing operations`);
  }
  return project;
}

function getOperation(project, operationId) {
  const operation = project.operations[operationId];
  if (!operation) throw new Error(`Unknown operation: ${operationId}`);
  if (typeof operation.program !== "string" || operation.program.length === 0) {
    throw new Error(`Operation ${operationId} is missing program`);
  }
  if (operation.args !== undefined && !Array.isArray(operation.args)) {
    throw new Error(`Operation ${operationId} args must be an array`);
  }
  if ((operation.args ?? []).some((arg) => typeof arg !== "string")) {
    throw new Error(`Operation ${operationId} args must contain only strings`);
  }
  return operation;
}

function resolveWorkingDirectory(project, operation) {
  const root = path.resolve(project.root);
  const requested = operation.cwd ?? ".";

  if (typeof requested !== "string" || path.isAbsolute(requested)) {
    throw new Error("Operation cwd must be a relative path inside the project root");
  }

  const cwd = path.resolve(root, requested);
  const relative = path.relative(root, cwd);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Operation cwd escapes the project root");
  }

  return cwd;
}

function positiveInteger(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function runOperation(config, projectId, project, operationId, operation) {
  return new Promise((resolve) => {
    if (runningProjects.has(projectId)) {
      resolve({
        ok: false,
        status: "busy",
        project: projectId,
        operation: operationId,
        exit_code: null,
        stdout: "",
        stderr: `Project ${projectId} already has a running operation`,
        duration_ms: 0,
        timed_out: false
      });
      return;
    }

    const defaults = config.defaults ?? {};
    const timeoutMs = positiveInteger(operation.timeout_ms, positiveInteger(defaults.timeout_ms, 900000));
    const maxOutputKb = positiveInteger(operation.max_output_kb, positiveInteger(defaults.max_output_kb, 1024));
    const maxOutputChars = maxOutputKb * 1024;
    const cwd = resolveWorkingDirectory(project, operation);

    runningProjects.add(projectId);
    const startedAt = Date.now();

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let finished = false;

    const appendBounded = (current, chunk) => {
      const next = current + chunk.toString("utf8");
      return next.length > maxOutputChars ? next.slice(next.length - maxOutputChars) : next;
    };

    const child = spawn(operation.program, operation.args ?? [], {
      cwd,
      shell: false,
      windowsHide: true,
      env: process.env
    });

    child.stdout?.on("data", (chunk) => { stdout = appendBounded(stdout, chunk); });
    child.stderr?.on("data", (chunk) => { stderr = appendBounded(stderr, chunk); });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    const finish = (exitCode, spawnError) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      runningProjects.delete(projectId);

      if (spawnError) stderr = appendBounded(stderr, spawnError.message);

      resolve({
        ok: !spawnError && !timedOut && exitCode === 0,
        status: timedOut ? "timed_out" : spawnError ? "spawn_error" : "completed",
        project: projectId,
        operation: operationId,
        exit_code: exitCode,
        stdout,
        stderr,
        duration_ms: Date.now() - startedAt,
        timed_out: timedOut
      });
    };

    child.on("error", (error) => finish(null, error));
    child.on("close", (code) => finish(code, null));
  });
}

export default async function createLocalBuildModule({ moduleId, configPath }) {
  return {
    async describe() {
      return {
        id: moduleId,
        version: 1,
        actions: [
          {
            id: "list_projects",
            title: "List Local Build projects",
            description: "Lists projects exposed by the Local Build bridge.",
            inputSchema: {}
          },
          {
            id: "list_operations",
            title: "List Local Build operations",
            description: "Lists allowlisted operations for one Local Build project.",
            inputSchema: { project: z.string().min(1) }
          },
          {
            id: "run",
            title: "Run Local Build operation",
            description: "Runs one preconfigured operation inside one configured project workspace.",
            inputSchema: {
              project: z.string().min(1),
              operation: z.string().min(1)
            }
          }
        ]
      };
    },

    async invoke(action, input) {
      const config = await loadBridgeConfig(configPath);

      if (action === "list_projects") {
        return {
          ok: true,
          status: "completed",
          projects: Object.entries(config.projects).map(([id, project]) => ({
            id,
            description: project.description ?? ""
          }))
        };
      }

      if (action === "list_operations") {
        const project = getProject(config, input.project);
        return {
          ok: true,
          status: "completed",
          project: input.project,
          operations: Object.entries(project.operations).map(([id, operation]) => ({
            id,
            description: operation.description ?? ""
          }))
        };
      }

      if (action === "run") {
        const project = getProject(config, input.project);
        const operation = getOperation(project, input.operation);
        return runOperation(config, input.project, project, input.operation, operation);
      }

      throw new Error(`Unknown Local Build action: ${action}`);
    }
  };
}
