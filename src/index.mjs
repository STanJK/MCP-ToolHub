import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

const configPath = path.resolve(process.env.TOOLHUB_CONFIG ?? path.join(process.cwd(), "toolhub.local.json"));

async function loadConfig() {
  const raw = await readFile(configPath, "utf8");
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || !parsed.projects || typeof parsed.projects !== "object") {
    throw new Error("Invalid ToolHub config: expected top-level projects object");
  }
  return parsed;
}

function getProject(config, projectId) {
  const project = config.projects[projectId];
  if (!project) throw new Error(`Unknown project: ${projectId}`);
  if (!project.root || typeof project.root !== "string") throw new Error(`Project ${projectId} is missing root`);
  if (!project.tasks || typeof project.tasks !== "object") throw new Error(`Project ${projectId} is missing tasks`);
  return project;
}

function getTask(project, taskId) {
  const task = project.tasks[taskId];
  if (!task) throw new Error(`Unknown task: ${taskId}`);
  if (!task.program || typeof task.program !== "string") throw new Error(`Task ${taskId} is missing program`);
  if (task.args !== undefined && !Array.isArray(task.args)) throw new Error(`Task ${taskId} args must be an array`);
  return task;
}

const runningByProject = new Set();

function runConfiguredTask(projectId, project, taskId, task) {
  return new Promise((resolve) => {
    if (runningByProject.has(projectId)) {
      resolve({ ok: false, exitCode: null, stdout: "", stderr: `Project ${projectId} already has a running task`, timedOut: false });
      return;
    }

    runningByProject.add(projectId);
    const timeoutMs = Number.isInteger(task.timeoutMs) && task.timeoutMs > 0 ? task.timeoutMs : 300000;
    const child = spawn(task.program, task.args ?? [], {
      cwd: path.resolve(project.root),
      shell: false,
      windowsHide: true,
      env: process.env
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let finished = false;

    const appendBounded = (current, chunk) => {
      const next = current + chunk.toString("utf8");
      const max = 1024 * 1024;
      return next.length > max ? next.slice(next.length - max) : next;
    };

    child.stdout?.on("data", (chunk) => { stdout = appendBounded(stdout, chunk); });
    child.stderr?.on("data", (chunk) => { stderr = appendBounded(stderr, chunk); });

    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);

    const finish = (exitCode, spawnError) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      runningByProject.delete(projectId);
      if (spawnError) stderr = appendBounded(stderr, spawnError.message);
      resolve({ ok: !spawnError && !timedOut && exitCode === 0, exitCode, stdout, stderr, timedOut });
    };

    child.on("error", (error) => finish(null, error));
    child.on("close", (code) => finish(code, null));
  });
}

const server = new McpServer({ name: "mcp-toolhub", version: "0.1.0" });

server.registerTool("list_projects", {
  title: "List configured ToolHub projects",
  description: "Lists project IDs and descriptions without exposing local filesystem paths.",
  inputSchema: {}
}, async () => {
  const config = await loadConfig();
  const projects = Object.entries(config.projects).map(([id, project]) => ({ id, description: project.description ?? "" }));
  return { content: [{ type: "text", text: JSON.stringify({ projects }, null, 2) }] };
});

server.registerTool("list_tasks", {
  title: "List configured tasks for a project",
  description: "Lists named tasks that are locally allowlisted for one configured project.",
  inputSchema: { project: z.string().min(1) }
}, async ({ project: projectId }) => {
  const config = await loadConfig();
  const project = getProject(config, projectId);
  const tasks = Object.entries(project.tasks).map(([id, task]) => ({ id, description: task.description ?? "" }));
  return { content: [{ type: "text", text: JSON.stringify({ project: projectId, tasks }, null, 2) }] };
});

server.registerTool("run_task", {
  title: "Run a configured project task",
  description: "Runs a pre-approved local task selected only by project ID and task ID.",
  inputSchema: { project: z.string().min(1), task: z.string().min(1) }
}, async ({ project: projectId, task: taskId }) => {
  const config = await loadConfig();
  const project = getProject(config, projectId);
  const task = getTask(project, taskId);
  const result = await runConfiguredTask(projectId, project, taskId, task);
  return {
    isError: !result.ok,
    content: [{ type: "text", text: JSON.stringify({
      project: projectId, task: taskId, ok: result.ok, exitCode: result.exitCode,
      timedOut: result.timedOut, stdout: result.stdout, stderr: result.stderr
    }, null, 2) }]
  };
});

await serveStdio(server);
