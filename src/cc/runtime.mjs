import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";

const repoRoot = process.env.CC_MODULE_ROOT
  ? path.resolve(process.env.CC_MODULE_ROOT)
  : path.resolve(process.cwd());

const localAppData = process.env.LOCALAPPDATA;
if (!localAppData) {
  throw new Error("LOCALAPPDATA is unavailable");
}

const stateDir = path.join(localAppData, "MCP-ToolHub", "cc");
mkdirSync(stateDir, { recursive: true });

const pidPath = path.join(stateDir, "runtime.pid");
const logPath = path.join(stateDir, "cc-runtime.log");
const logFd = openSync(logPath, "a");

const mailboxUrl = process.env.CC_ERROR_MAILBOX_URL || "";
const toolhubConfig =
  process.env.TOOLHUB_CONFIG || path.join(repoRoot, "toolhub.local.yaml");
const initScript = path.join(repoRoot, "scripts", "init-tunnel.ps1");
const runScript = path.join(repoRoot, "scripts", "run-tunnel.ps1");
const readyUrl = process.env.TOOLHUB_CC_READY_URL || "http://127.0.0.1:8080/readyz";

let child = null;
let lastMailboxState = undefined;
let desiredErrorCode = null;
let notReadySince = null;
let readinessTimer = null;
let exiting = false;

function log(level, message) {
  appendFileSync(
    logPath,
    `${new Date().toISOString()} ${level.toUpperCase()} ${message}\n`,
    "utf8"
  );
}

function cleanupPid() {
  try {
    if (!existsSync(pidPath)) return;
    const current = readFileSync(pidPath, "utf8").trim();
    if (current === String(process.pid)) {
      unlinkSync(pidPath);
    }
  } catch {
    // Best effort only.
  }
}

async function postMailbox(payload) {
  if (!mailboxUrl) {
    return false;
  }

  try {
    const response = await fetch(mailboxUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(1500)
    });

    if (!response.ok) {
      log("warn", `CC Error Mailbox returned HTTP ${response.status}`);
      return false;
    }
    return true;
  } catch (error) {
    log(
      "warn",
      `CC Error Mailbox unavailable: ${error instanceof Error ? error.message : String(error)}`
    );
    return false;
  }
}

async function setError(code, summary, detail) {
  desiredErrorCode = code;

  if (lastMailboxState === code) {
    return;
  }

  const sent = await postMailbox({
    op: "set",
    error: {
      code,
      summary,
      detail
    }
  });

  if (sent) {
    lastMailboxState = code;
  }
}

async function clearError() {
  desiredErrorCode = null;

  if (lastMailboxState === null) {
    return;
  }

  const sent = await postMailbox({ op: "clear" });
  if (sent) {
    lastMailboxState = null;
  }
}

function spawnPowerShell(script) {
  return spawn(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script],
    {
      cwd: repoRoot,
      windowsHide: true,
      shell: false,
      env: {
        ...process.env,
        TOOLHUB_CONFIG: toolhubConfig
      },
      stdio: ["ignore", logFd, logFd]
    }
  );
}

function waitForExit(proc) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    proc.once("error", (error) => {
      finish({
        code: null,
        error: error instanceof Error ? error.message : String(error)
      });
    });

    proc.once("exit", (code, signal) => {
      finish({ code, signal, error: null });
    });
  });
}

async function checkReady() {
  try {
    const response = await fetch(readyUrl, {
      method: "GET",
      signal: AbortSignal.timeout(1000)
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function readinessTick() {
  if (exiting || !child) {
    return;
  }

  const ready = await checkReady();
  if (ready) {
    notReadySince = null;
    await clearError();
    return;
  }

  if (notReadySince === null) {
    notReadySince = Date.now();
    return;
  }

  if (Date.now() - notReadySince >= 10_000) {
    await setError(
      "tunnel-not-ready",
      "ToolHub tunnel is not ready",
      `The tunnel runtime is alive but ${readyUrl} has not reported ready for at least 10 seconds.`
    );
  }
}

async function shutdown(exitCode) {
  if (exiting) {
    return;
  }
  exiting = true;

  if (readinessTimer) {
    clearInterval(readinessTimer);
    readinessTimer = null;
  }

  cleanupPid();

  try {
    closeSync(logFd);
  } catch {
    // Best effort.
  }

  process.exit(exitCode);
}

async function main() {
  writeFileSync(pidPath, `${process.pid}\n`, "utf8");
  log(
    "info",
    `CC runtime started pid=${process.pid} module=${process.env.CC_MODULE_ID || "toolhub"} root=${repoRoot}`
  );

  if (!existsSync(toolhubConfig)) {
    await setError(
      "toolhub-config-missing",
      "ToolHub configuration is missing",
      toolhubConfig
    );
    throw new Error(`ToolHub config not found: ${toolhubConfig}`);
  }

  log("info", "refreshing tunnel-client profile");
  const init = spawnPowerShell(initScript);
  const initResult = await waitForExit(init);

  if (initResult.error || initResult.code !== 0) {
    const detail = initResult.error
      ? `init-tunnel.ps1 failed to start: ${initResult.error}`
      : `init-tunnel.ps1 exited with code ${initResult.code}`;
    await setError(
      "tunnel-profile-init-failed",
      "ToolHub tunnel profile initialization failed",
      detail
    );
    throw new Error(detail);
  }

  log("info", "starting ToolHub tunnel runtime");
  child = spawnPowerShell(runScript);

  child.once("error", async (error) => {
    log("error", `run-tunnel.ps1 spawn failed: ${error.message}`);
    await setError(
      "tunnel-runtime-start-failed",
      "ToolHub tunnel runtime failed to start",
      error.message
    );
    await shutdown(1);
  });

  child.once("exit", async (code, signal) => {
    if (exiting) {
      return;
    }

    const detail = `run-tunnel.ps1 exited with code ${code ?? "null"} signal ${signal ?? "none"}`;
    log(code === 0 ? "warn" : "error", detail);
    await setError(
      "tunnel-runtime-exited",
      "ToolHub tunnel runtime exited",
      detail
    );
    await shutdown(code === 0 ? 1 : (code ?? 1));
  });

  readinessTimer = setInterval(() => {
    void readinessTick();
  }, 2000);

  void readinessTick();
}

process.on("exit", () => {
  cleanupPid();
});

process.on("uncaughtException", async (error) => {
  log("error", error?.stack ?? error?.message ?? String(error));
  if (!desiredErrorCode) {
    await setError(
      "toolhub-cc-runtime-failed",
      "ToolHub Control Center runtime failed",
      error?.message ?? String(error)
    );
  }
  await shutdown(1);
});

process.on("unhandledRejection", async (reason) => {
  const message = reason instanceof Error ? reason.message : String(reason);
  log("error", `unhandled rejection: ${message}`);
  if (!desiredErrorCode) {
    await setError(
      "toolhub-cc-runtime-failed",
      "ToolHub Control Center runtime failed",
      message
    );
  }
  await shutdown(1);
});

void main().catch(async (error) => {
  log("error", error?.stack ?? error?.message ?? String(error));
  if (!desiredErrorCode) {
    await setError(
      "toolhub-cc-runtime-failed",
      "ToolHub Control Center runtime failed",
      error?.message ?? String(error)
    );
  }
  await shutdown(1);
});
