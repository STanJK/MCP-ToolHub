import { spawn } from "node:child_process";

function lines(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
}

function cancelledResult() {
  return { status: "cancelled", exitCode: null, message: "Cancellation requested" };
}

function refused(message) {
  return { status: "refused", exitCode: 3, message };
}

function failed(step, result) {
  const detail = result.spawnError
    ? result.spawnError
    : `git exited with code ${result.code}`;
  return { status: "failed", exitCode: result.code ?? 1, message: `${step}: ${detail}` };
}

async function runGit(args, context) {
  if (context.isCancelled()) return { cancelled: true, code: null, stdout: "", stderr: "" };

  context.onLog(`$ git ${args.join(" ")}\n`);

  return await new Promise((resolve) => {
    let child;
    try {
      child = spawn("git.exe", args, {
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

async function step(args, context) {
  const result = await runGit(args, context);
  if (result.cancelled || context.isCancelled()) return { cancelled: true, result };
  return { cancelled: false, result };
}

export async function runGitSyncGenerated(context) {
  context.onLog("[ToolHub git-sync-generated] begin fail-closed Cargo.lock recovery\n");

  let current = await step(["fetch", "origin"], context);
  if (current.cancelled) return cancelledResult();
  if (current.result.code !== 0) return failed("git fetch origin failed", current.result);

  current = await step(["branch", "--show-current"], context);
  if (current.cancelled) return cancelledResult();
  if (current.result.code !== 0) return failed("git branch --show-current failed", current.result);
  if (current.result.stdout.trim() !== "main") {
    return refused(`Current branch must be main; got ${JSON.stringify(current.result.stdout.trim())}`);
  }

  current = await step(["diff", "--cached", "--name-only", "--no-ext-diff"], context);
  if (current.cancelled) return cancelledResult();
  if (current.result.code !== 0) return failed("staged-change check failed", current.result);
  if (lines(current.result.stdout).length !== 0) {
    return refused("Staged changes are present");
  }

  current = await step(["status", "--porcelain=v1", "--untracked-files=all"], context);
  if (current.cancelled) return cancelledResult();
  if (current.result.code !== 0) return failed("worktree status check failed", current.result);
  const worktreeLines = lines(current.result.stdout);
  if (worktreeLines.length !== 1 || worktreeLines[0] !== " M Cargo.lock") {
    return refused(`Working tree must contain exactly one unstaged Cargo.lock modification; got ${JSON.stringify(worktreeLines)}`);
  }

  current = await step(["merge-base", "--is-ancestor", "HEAD", "origin/main"], context);
  if (current.cancelled) return cancelledResult();
  if (current.result.code === 1) {
    return refused("origin/main is not a fast-forward descendant of HEAD");
  }
  if (current.result.code !== 0) return failed("fast-forward ancestry check failed", current.result);

  current = await step(["diff", "--name-only", "HEAD..origin/main"], context);
  if (current.cancelled) return cancelledResult();
  if (current.result.code !== 0) return failed("incoming-file check failed", current.result);
  const incomingFiles = new Set(lines(current.result.stdout));
  if (!incomingFiles.has("Cargo.lock")) {
    return refused("origin/main does not contain an incoming Cargo.lock change");
  }

  current = await step(["restore", "--source=HEAD", "--worktree", "--", "Cargo.lock"], context);
  if (current.cancelled) return cancelledResult();
  if (current.result.code !== 0) return failed("Cargo.lock restore failed", current.result);

  current = await step(["merge", "--ff-only", "origin/main"], context);
  if (current.cancelled) return cancelledResult();
  if (current.result.code !== 0) return failed("fast-forward merge failed", current.result);

  current = await step(["status", "--porcelain=v1", "--untracked-files=all"], context);
  if (current.cancelled) return cancelledResult();
  if (current.result.code !== 0) return failed("final cleanliness check failed", current.result);
  const finalLines = lines(current.result.stdout);
  if (finalLines.length !== 0) {
    return {
      status: "failed",
      exitCode: 4,
      message: `Post-sync working tree is not clean: ${JSON.stringify(finalLines)}`
    };
  }

  context.onLog("[ToolHub git-sync-generated] completed; working tree is clean\n");
  return { status: "completed", exitCode: 0, message: "Cargo.lock safely synchronized from origin/main" };
}
