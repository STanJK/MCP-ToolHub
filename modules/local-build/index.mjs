import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { parse } from "yaml";
import { z } from "zod";
import { runGitSyncGenerated } from "./builtins/git-sync-generated.mjs";

const jobs = new Map();
const activeJobByProject = new Map();
const MAX_RETAINED_TERMINAL_JOBS = 16;
const TERMINAL_STATUSES = new Set(["completed", "spawn_error", "cancelled", "timed_out", "refused", "failed"]);

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

  const hasProgram = typeof operation.program === "string" && operation.program.length > 0;
  const hasBuiltin = typeof operation.builtin === "string" && operation.builtin.length > 0;

  if (hasProgram === hasBuiltin) {
    throw new Error(`Operation ${operationId} must define exactly one of program or builtin`);
  }

  if (hasBuiltin) {
    if (operation.builtin !== "git-sync-generated") {
      throw new Error(`Operation ${operationId} uses unsupported builtin: ${operation.builtin}`);
    }
    if (operation.args !== undefined || operation.cwd !== undefined || operation.program !== undefined) {
      throw new Error(`Builtin operation ${operationId} cannot define program, args, or cwd`);
    }
    return operation;
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

function createOutputState() {
  return {
    buffer: Buffer.alloc(0),
    bytesSeen: 0,
    truncated: false
  };
}

function appendBounded(state, chunk, maxOutputBytes) {
  const nextChunk = Buffer.isBuffer(chunk)
    ? chunk
    : Buffer.from(String(chunk), "utf8");

  state.bytesSeen += nextChunk.length;

  const combined = state.buffer.length === 0
    ? nextChunk
    : Buffer.concat([state.buffer, nextChunk]);

  if (combined.length > maxOutputBytes) {
    state.buffer = combined.subarray(combined.length - maxOutputBytes);
    state.truncated = true;
  } else {
    state.buffer = combined;
  }
}

function isTerminal(job) {
  return TERMINAL_STATUSES.has(job.status);
}

function releaseProject(job) {
  if (activeJobByProject.get(job.project) === job.runId) {
    activeJobByProject.delete(job.project);
  }
}

function pruneTerminalJobs() {
  const terminal = [...jobs.values()]
    .filter(isTerminal)
    .sort((a, b) => (a.completedAt ?? 0) - (b.completedAt ?? 0));

  while (terminal.length > MAX_RETAINED_TERMINAL_JOBS) {
    const oldest = terminal.shift();
    if (oldest) jobs.delete(oldest.runId);
  }
}

function finalizeJob(job, exitCode, spawnError) {
  if (isTerminal(job)) return;

  if (job.timeoutTimer) {
    clearTimeout(job.timeoutTimer);
    job.timeoutTimer = null;
  }

  if (spawnError) {
    job.spawnError = spawnError instanceof Error ? spawnError.message : String(spawnError);
    appendBounded(job.stderrState, job.spawnError, job.maxOutputBytes);
  }

  job.exitCode = exitCode;
  job.completedAt = Date.now();
  job.child = null;

  if (job.timedOut) {
    job.status = "timed_out";
  } else if (job.cancelRequested) {
    job.status = "cancelled";
  } else if (job.spawnError) {
    job.status = "spawn_error";
  } else {
    job.status = "completed";
  }

  releaseProject(job);
  pruneTerminalJobs();
}

function jobSnapshot(job, includeOutput = true) {
  const now = job.completedAt ?? Date.now();
  const snapshot = {
    ok: job.status === "running" || job.status === "cancelling" || job.status === "cancel_failed"
      ? true
      : job.status === "completed" && job.exitCode === 0,
    run_id: job.runId,
    status: job.status,
    project: job.project,
    operation: job.operation,
    pid: job.pid ?? null,
    exit_code: job.exitCode ?? null,
    started_at: new Date(job.startedAt).toISOString(),
    completed_at: job.completedAt ? new Date(job.completedAt).toISOString() : null,
    duration_ms: now - job.startedAt,
    timed_out: job.timedOut,
    cancel_requested: job.cancelRequested,
    cancel_reason: job.cancelReason ?? null,
    message: job.message ?? null
  };

  if (includeOutput) {
    Object.assign(snapshot, {
      stdout: job.stdoutState.buffer.toString("utf8"),
      stdout_truncated: job.stdoutState.truncated,
      stdout_bytes_seen: job.stdoutState.bytesSeen,
      stdout_bytes_returned: job.stdoutState.buffer.length,
      stderr: job.stderrState.buffer.toString("utf8"),
      stderr_truncated: job.stderrState.truncated,
      stderr_bytes_seen: job.stderrState.bytesSeen,
      stderr_bytes_returned: job.stderrState.buffer.length
    });
  }

  return snapshot;
}

function markCancelFailure(job, message) {
  if (isTerminal(job)) return;
  appendBounded(job.stderrState, `\n[ToolHub cancel] ${message}\n`, job.maxOutputBytes);
  job.status = "cancel_failed";
}

function requestCancellation(job, reason) {
  if (isTerminal(job)) {
    return {
      ok: true,
      status: job.status,
      run_id: job.runId,
      already_terminal: true
    };
  }

  job.cancelRequested = true;
  job.cancelReason = reason;
  job.status = "cancelling";

  const child = job.child;
  if (!child || !job.pid) {
    if (job.builtin) {
      return {
        ok: true,
        status: job.status,
        run_id: job.runId,
        project: job.project,
        operation: job.operation
      };
    }

    markCancelFailure(job, "process handle is unavailable");
    return {
      ok: false,
      status: job.status,
      run_id: job.runId,
      error: "process handle is unavailable"
    };
  }

  if (process.platform === "win32") {
    let killer;
    try {
      killer = spawn("taskkill.exe", ["/PID", String(job.pid), "/T", "/F"], {
        shell: false,
        windowsHide: true,
        stdio: "ignore"
      });
    } catch (error) {
      markCancelFailure(job, error instanceof Error ? error.message : String(error));
      return {
        ok: false,
        status: job.status,
        run_id: job.runId,
        error: error instanceof Error ? error.message : String(error)
      };
    }

    killer.on("error", (error) => {
      markCancelFailure(job, `taskkill failed to start: ${error.message}`);
    });

    killer.on("close", (code) => {
      if (code === 0 || isTerminal(job)) return;
      setTimeout(() => {
        if (!isTerminal(job) && job.status === "cancelling") {
          markCancelFailure(job, `taskkill exited with code ${code}`);
        }
      }, 100);
    });
  } else {
    try {
      const sent = child.kill("SIGTERM");
      if (!sent) {
        markCancelFailure(job, "SIGTERM was not delivered");
      }
    } catch (error) {
      markCancelFailure(job, error instanceof Error ? error.message : String(error));
    }
  }

  return {
    ok: true,
    status: job.status,
    run_id: job.runId,
    project: job.project,
    operation: job.operation
  };
}


function finalizeBuiltinJob(job, result) {
  if (isTerminal(job)) return;

  if (job.timeoutTimer) {
    clearTimeout(job.timeoutTimer);
    job.timeoutTimer = null;
  }

  job.completedAt = Date.now();
  job.child = null;
  job.pid = null;
  job.message = result?.message ?? null;
  job.exitCode = result?.exitCode ?? null;

  if (job.timedOut) {
    job.status = "timed_out";
  } else if (job.cancelRequested) {
    job.status = "cancelled";
  } else {
    job.status = result?.status ?? "failed";
  }

  if (job.message) {
    appendBounded(
      job.stderrState,
      `\n[ToolHub builtin] ${job.status}: ${job.message}\n`,
      job.maxOutputBytes
    );
  }

  releaseProject(job);
  pruneTerminalJobs();
}

function startBuiltinOperation(job, cwd) {
  job.status = "running";

  job.timeoutTimer = setTimeout(() => {
    if (isTerminal(job)) return;
    job.timedOut = true;
    requestCancellation(job, "timeout");
  }, job.timeoutMs);

  queueMicrotask(async () => {
    try {
      const result = await runGitSyncGenerated({
        cwd,
        isCancelled: () => job.cancelRequested,
        onChild: (child) => {
          job.child = child;
          job.pid = child?.pid ?? null;
        },
        onStdout: (chunk) => appendBounded(job.stdoutState, chunk, job.maxOutputBytes),
        onStderr: (chunk) => appendBounded(job.stderrState, chunk, job.maxOutputBytes),
        onLog: (message) => appendBounded(job.stdoutState, message, job.maxOutputBytes)
      });
      finalizeBuiltinJob(job, result);
    } catch (error) {
      finalizeBuiltinJob(job, {
        status: "failed",
        exitCode: 1,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  });

  return jobSnapshot(job);
}

function startOperation(config, projectId, project, operationId, operation) {
  const existingRunId = activeJobByProject.get(projectId);
  if (existingRunId) {
    const existing = jobs.get(existingRunId);
    if (existing && !isTerminal(existing)) {
      return {
        ok: false,
        status: "busy",
        project: projectId,
        operation: operationId,
        active_run_id: existingRunId,
        active_operation: existing.operation,
        active_status: existing.status
      };
    }
    activeJobByProject.delete(projectId);
  }

  const defaults = config.defaults ?? {};
  const timeoutMs = positiveInteger(operation.timeout_ms, positiveInteger(defaults.timeout_ms, 900000));
  const maxOutputKb = positiveInteger(operation.max_output_kb, positiveInteger(defaults.max_output_kb, 1024));
  const maxOutputBytes = maxOutputKb * 1024;
  const cwd = resolveWorkingDirectory(project, operation);
  const runId = `run_${randomUUID()}`;
  const job = {
    runId,
    project: projectId,
    operation: operationId,
    status: "starting",
    startedAt: Date.now(),
    completedAt: null,
    exitCode: null,
    pid: null,
    child: null,
    timeoutTimer: null,
    timeoutMs,
    maxOutputBytes,
    timedOut: false,
    cancelRequested: false,
    cancelReason: null,
    spawnError: null,
    builtin: operation.builtin ?? null,
    message: null,
    stdoutState: createOutputState(),
    stderrState: createOutputState()
  };

  jobs.set(runId, job);
  activeJobByProject.set(projectId, runId);

  if (operation.builtin === "git-sync-generated") {
    return startBuiltinOperation(job, cwd);
  }

  let child;
  try {
    child = spawn(operation.program, operation.args ?? [], {
      cwd,
      shell: false,
      windowsHide: true,
      env: process.env
    });
  } catch (error) {
    finalizeJob(job, null, error);
    return jobSnapshot(job);
  }

  job.child = child;
  job.pid = child.pid ?? null;
  job.status = "running";

  child.stdout?.on("data", (chunk) => {
    appendBounded(job.stdoutState, chunk, job.maxOutputBytes);
  });
  child.stderr?.on("data", (chunk) => {
    appendBounded(job.stderrState, chunk, job.maxOutputBytes);
  });

  child.on("error", (error) => {
    finalizeJob(job, null, error);
  });

  child.on("close", (code) => {
    finalizeJob(job, code, null);
  });

  job.timeoutTimer = setTimeout(() => {
    if (isTerminal(job)) return;
    job.timedOut = true;
    requestCancellation(job, "timeout");
  }, timeoutMs);

  return jobSnapshot(job);
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
            title: "Start Local Build operation",
            description: "Starts one preconfigured operation and returns immediately with a run_id.",
            inputSchema: {
              project: z.string().min(1),
              operation: z.string().min(1)
            }
          },
          {
            id: "get_run",
            title: "Get Local Build run",
            description: "Returns current status and retained output for one Local Build run.",
            inputSchema: { run_id: z.string().min(1) }
          },
          {
            id: "list_runs",
            title: "List Local Build runs",
            description: "Lists active and recently completed Local Build runs.",
            inputSchema: { project: z.string().min(1).optional() }
          },
          {
            id: "cancel_run",
            title: "Cancel Local Build run",
            description: "Requests cancellation of a running Local Build job. Windows cancellation terminates the process tree.",
            inputSchema: { run_id: z.string().min(1) }
          }
        ]
      };
    },

    async invoke(action, input) {
      if (action === "get_run") {
        const job = jobs.get(input.run_id);
        if (!job) {
          return {
            ok: false,
            status: "not_found",
            run_id: input.run_id
          };
        }
        return jobSnapshot(job);
      }

      if (action === "list_runs") {
        const runs = [...jobs.values()]
          .filter((job) => !input.project || job.project === input.project)
          .sort((a, b) => b.startedAt - a.startedAt)
          .map((job) => jobSnapshot(job, false));
        return {
          ok: true,
          status: "completed",
          runs
        };
      }

      if (action === "cancel_run") {
        const job = jobs.get(input.run_id);
        if (!job) {
          return {
            ok: false,
            status: "not_found",
            run_id: input.run_id
          };
        }
        return requestCancellation(job, "user");
      }

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
        return startOperation(config, input.project, project, input.operation, operation);
      }

      throw new Error(`Unknown Local Build action: ${action}`);
    }
  };
}
