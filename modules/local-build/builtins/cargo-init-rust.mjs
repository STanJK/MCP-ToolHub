import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";

function cancelledResult() {
  return { status: "cancelled", exitCode: null, message: "Cancellation requested" };
}

function refused(message) {
  return { status: "refused", exitCode: 3, message };
}

function failed(step, result) {
  const detail = result.spawnError
    ? result.spawnError
    : `cargo exited with code ${result.code}`;
  return {
    status: "failed",
    exitCode: result.code ?? 1,
    message: `${step}: ${detail}`
  };
}

async function exists(filePath) {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function runCargo(args, context) {
  if (context.isCancelled()) {
    return { cancelled: true, code: null, stdout: "", stderr: "" };
  }

  context.onLog(`$ cargo ${args.join(" ")}\n`);

  return await new Promise((resolve) => {
    let child;
    try {
      child = spawn("cargo.exe", args, {
        cwd: context.cwd,
        shell: false,
        windowsHide: true,
        env: process.env
      });
    } catch (error) {
      resolve({
        cancelled: false,
        code: null,
        stdout: "",
        stderr: "",
        spawnError: error instanceof Error ? error.message : String(error)
      });
      return;
    }

    context.onChild(child);

    const stdoutChunks = [];
    const stderrChunks = [];

    child.stdout?.on("data", (chunk) => {
      stdoutChunks.push(Buffer.from(chunk));
      context.onStdout(chunk);
    });

    child.stderr?.on("data", (chunk) => {
      stderrChunks.push(Buffer.from(chunk));
      context.onStderr(chunk);
    });

    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      context.onChild(null);
      resolve(result);
    };

    child.on("error", (error) => {
      finish({
        cancelled: context.isCancelled(),
        code: null,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        spawnError: error.message
      });
    });

    child.on("close", (code) => {
      finish({
        cancelled: context.isCancelled(),
        code,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8")
      });
    });
  });
}

export async function runCargoInitRust(context, options = {}) {
  const packageName = options.packageName ?? path.basename(context.cwd)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_");

  if (!/^[a-z][a-z0-9_-]*$/.test(packageName)) {
    return refused(`Invalid Rust package name: ${JSON.stringify(packageName)}`);
  }

  const manifest = path.join(context.cwd, "Cargo.toml");
  if (await exists(manifest)) {
    return refused("Cargo.toml already exists; refusing to reinitialize an existing Rust project");
  }

  context.onLog("[ToolHub cargo-init-rust] initializing Rust binary project\n");

  let result = await runCargo(
    ["init", "--bin", "--vcs", "none", "--name", packageName, "."],
    context
  );

  if (result.cancelled || context.isCancelled()) return cancelledResult();
  if (result.code !== 0) return failed("cargo init failed", result);

  result = await runCargo(["generate-lockfile", "--offline"], context);

  if (result.cancelled || context.isCancelled()) return cancelledResult();
  if (result.code !== 0) return failed("cargo generate-lockfile --offline failed", result);

  if (!(await exists(manifest))) {
    return {
      status: "failed",
      exitCode: 4,
      message: "cargo init reported success but Cargo.toml is missing"
    };
  }

  const lockfile = path.join(context.cwd, "Cargo.lock");
  if (!(await exists(lockfile))) {
    return {
      status: "failed",
      exitCode: 4,
      message: "cargo generate-lockfile reported success but Cargo.lock is missing"
    };
  }

  context.onLog("[ToolHub cargo-init-rust] completed with Cargo.toml and Cargo.lock\n");
  return {
    status: "completed",
    exitCode: 0,
    message: `Initialized Rust package ${packageName} with offline Cargo.lock`
  };
}
