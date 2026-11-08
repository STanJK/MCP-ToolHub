import { spawn } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/client/stdio";
import { parse } from "yaml";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const profileRoot = path.join(moduleDir, "project-profiles");
const runtimes = new Map();
const projectIdPattern = /^[a-z0-9][a-z0-9-]*$/;

const hardDeniedToolNames = new Set([
  "install_extension",
  "list_extensions",
  "reload_extension",
  "trigger_extension_action",
  "uninstall_extension",
  "execute_3p_developer_tool",
  "list_3p_developer_tools",
  "execute_webmcp_tool",
  "list_webmcp_tools",
  "get_os_app_state",
  "install_pwa",
  "launch_pwa",
  "uninstall_pwa",
  "configure_webauthn"
]);

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function isHardDeniedTool(name) {
  return hardDeniedToolNames.has(String(name));
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validateStringArray(scope, value, { allowEmpty = true } = {}) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) {
    throw new Error(`${scope} must be an array of non-empty strings`);
  }
  if (!allowEmpty && value.length === 0) {
    throw new Error(`${scope} must not be empty`);
  }
  return value;
}

function projectProfileDir(projectId) {
  if (!projectIdPattern.test(projectId)) {
    throw new Error(`Invalid chrome-mcp project id: ${projectId}`);
  }
  const resolved = path.resolve(profileRoot, projectId);
  const relative = path.relative(profileRoot, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`chrome-mcp project profile escaped profile root: ${projectId}`);
  }
  return resolved;
}

function validatePort(projectId, value) {
  if (!Number.isInteger(value) || value < 1024 || value > 65535) {
    throw new Error(
      `chrome-mcp project ${projectId} remote_debugging_port must be an integer in 1024..65535`
    );
  }
  return value;
}

function normalizeProject(projectId, rawProject, config) {
  if (!projectIdPattern.test(projectId)) {
    throw new Error(`Invalid chrome-mcp project id: ${projectId}`);
  }
  if (!isPlainObject(rawProject)) {
    throw new Error(`chrome-mcp project ${projectId} must be an object`);
  }
  if (rawProject.enabled === false) return null;
  if (rawProject.enabled !== undefined && rawProject.enabled !== true) {
    throw new Error(`chrome-mcp project ${projectId} enabled must be boolean`);
  }

  const allowTools = validateStringArray(
    `chrome-mcp project ${projectId} allow_tools`,
    rawProject.allow_tools,
    { allowEmpty: false }
  );
  const denyTools = validateStringArray(
    `chrome-mcp project ${projectId} deny_tools`,
    rawProject.deny_tools ?? []
  );
  const workspaceRoots = validateStringArray(
    `chrome-mcp project ${projectId} workspace_roots`,
    rawProject.workspace_roots ?? []
  );
  for (const root of workspaceRoots) {
    if (!path.isAbsolute(root)) {
      throw new Error(`chrome-mcp project ${projectId} workspace root must be absolute: ${root}`);
    }
  }

  const allowedUrlPatterns = validateStringArray(
    `chrome-mcp project ${projectId} allowed_url_patterns`,
    rawProject.allowed_url_patterns ?? []
  );
  const blockedUrlPatterns = validateStringArray(
    `chrome-mcp project ${projectId} blocked_url_patterns`,
    rawProject.blocked_url_patterns ?? []
  );
  if (allowedUrlPatterns.length > 0 && blockedUrlPatterns.length > 0) {
    throw new Error(
      `chrome-mcp project ${projectId} cannot set both allowed_url_patterns and blocked_url_patterns`
    );
  }

  if (
    rawProject.javascript_evaluation !== undefined &&
    typeof rawProject.javascript_evaluation !== "boolean"
  ) {
    throw new Error(`chrome-mcp project ${projectId} javascript_evaluation must be boolean`);
  }

  return {
    id: projectId,
    port: validatePort(projectId, rawProject.remote_debugging_port),
    profileDir: projectProfileDir(projectId),
    allowTools,
    denyTools,
    workspaceRoots,
    allowedUrlPatterns,
    blockedUrlPatterns,
    javascriptEvaluation: rawProject.javascript_evaluation !== false,
    chromeExecutable: config.chromeExecutable,
    mcpCommand: config.mcpCommand,
    mcpBaseArgs: config.mcpBaseArgs,
    startupTimeoutMs: config.startupTimeoutMs
  };
}

async function loadConfig(configPath) {
  const raw = await readFile(configPath, "utf8");
  const parsed = parse(raw);
  if (!isPlainObject(parsed)) throw new Error("Invalid chrome-mcp config");
  if (parsed.version !== 1) throw new Error("chrome-mcp config version must be 1");

  const chrome = parsed.chrome;
  if (
    !isPlainObject(chrome) ||
    typeof chrome.executable !== "string" ||
    chrome.executable.length === 0
  ) {
    throw new Error("chrome-mcp config requires chrome.executable");
  }

  const mcp = parsed.mcp;
  if (!isPlainObject(mcp) || typeof mcp.command !== "string" || mcp.command.length === 0) {
    throw new Error("chrome-mcp config requires mcp.command");
  }
  const mcpBaseArgs = validateStringArray("chrome-mcp mcp.args", mcp.args ?? []);
  const forbiddenManagedArg =
    /^(?:--auto-?connect|--browser-?url|--ws-?endpoint|--ws-?headers|--user-?data-?dir|--channel|--executable-?path|--isolated|--headless|--proxy-?server|--chrome-?arg|--ignore-?default-?chrome-?arg|--viewport|--config|--watch-?config|--allow-?unrestricted-?paths|--filesystem-?root|--workspace|--allowed-?url-?pattern|--blocked-?url-?pattern|--javascript-?evaluation|--accept-?insecure-?certs|--category-?extensions|--category-?experimental-?third-?party|--category-?experimental-?webmcp|--category-?pwa|--category-?webauthn)(?:=|$)/i;
  const forbiddenArg = mcpBaseArgs.find((arg) => forbiddenManagedArg.test(arg));
  if (forbiddenArg) {
    throw new Error(
      `chrome-mcp mcp.args contains ToolHub-managed security/browser flag: ${forbiddenArg}`
    );
  }

  const startupTimeoutMs = parsed.startup_timeout_ms ?? 20000;
  if (
    !Number.isInteger(startupTimeoutMs) ||
    startupTimeoutMs < 1000 ||
    startupTimeoutMs > 120000
  ) {
    throw new Error("chrome-mcp startup_timeout_ms must be an integer in 1000..120000");
  }

  if (!isPlainObject(parsed.projects)) {
    throw new Error("chrome-mcp config requires projects object");
  }

  const base = {
    chromeExecutable: chrome.executable,
    mcpCommand: mcp.command,
    mcpBaseArgs,
    startupTimeoutMs
  };
  const projects = new Map();
  const ports = new Map();
  for (const [projectId, rawProject] of Object.entries(parsed.projects)) {
    const project = normalizeProject(projectId, rawProject, base);
    if (!project) continue;
    if (ports.has(project.port)) {
      throw new Error(
        `chrome-mcp projects ${ports.get(project.port)} and ${project.id} share remote_debugging_port ${project.port}`
      );
    }
    ports.set(project.port, project.id);
    projects.set(project.id, project);
  }
  if (projects.size === 0) {
    throw new Error("chrome-mcp config has no enabled projects");
  }

  return { projects };
}

function toolAllowed(name, project) {
  if (isHardDeniedTool(name)) return false;
  if (project.denyTools.includes(name)) return false;
  return project.allowTools.includes("*") || project.allowTools.includes(name);
}

async function fetchJson(url, timeoutMs = 1200) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      cache: "no-store"
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function browserVersion(project) {
  try {
    const version = await fetchJson(`http://127.0.0.1:${project.port}/json/version`);
    if (!isPlainObject(version) || typeof version.webSocketDebuggerUrl !== "string") return null;
    return version;
  } catch {
    return null;
  }
}

async function waitForBrowser(project, expectedReady) {
  const deadline = Date.now() + project.startupTimeoutMs;
  while (Date.now() < deadline) {
    const version = await browserVersion(project);
    if (Boolean(version) === expectedReady) return version;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(
    expectedReady
      ? `Chrome DevTools endpoint did not become ready on 127.0.0.1:${project.port} within ${project.startupTimeoutMs} ms`
      : `Chrome DevTools endpoint did not stop on 127.0.0.1:${project.port} within ${project.startupTimeoutMs} ms`
  );
}

function chromeArgs(project) {
  return [
    "--remote-debugging-address=127.0.0.1",
    `--remote-debugging-port=${project.port}`,
    `--user-data-dir=${project.profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "about:blank"
  ];
}

function mcpArgs(project) {
  const args = [
    ...project.mcpBaseArgs,
    `--browser-url=http://127.0.0.1:${project.port}`
  ];
  for (const root of project.workspaceRoots) {
    args.push(`--filesystem-root=${root}`);
  }
  for (const pattern of project.allowedUrlPatterns) {
    args.push(`--allowed-url-pattern=${pattern}`);
  }
  for (const pattern of project.blockedUrlPatterns) {
    args.push(`--blocked-url-pattern=${pattern}`);
  }
  if (!project.javascriptEvaluation) {
    args.push("--no-javascript-evaluation");
  }
  return args;
}

function runtimeKey(configPath, project) {
  return JSON.stringify({
    configPath,
    id: project.id,
    port: project.port,
    profileDir: project.profileDir,
    allowTools: project.allowTools,
    denyTools: project.denyTools,
    workspaceRoots: project.workspaceRoots,
    allowedUrlPatterns: project.allowedUrlPatterns,
    blockedUrlPatterns: project.blockedUrlPatterns,
    javascriptEvaluation: project.javascriptEvaluation,
    chromeExecutable: project.chromeExecutable,
    mcpCommand: project.mcpCommand,
    mcpBaseArgs: project.mcpBaseArgs,
    startupTimeoutMs: project.startupTimeoutMs
  });
}

function createRuntime(project) {
  let client = null;
  let connecting = null;
  let catalog = null;
  let browserProcess = null;

  async function closeClient() {
    const current = client;
    client = null;
    catalog = null;
    if (current) {
      try {
        await current.close();
      } catch {}
    }
  }

  async function ensureBrowser() {
    const current = await browserVersion(project);
    if (current) return { version: current, launched: false };

    await mkdir(project.profileDir, { recursive: true });
    const child = spawn(project.chromeExecutable, chromeArgs(project), {
      stdio: "ignore",
      windowsHide: false,
      detached: false
    });
    browserProcess = child;
    child.once("exit", () => {
      if (browserProcess === child) browserProcess = null;
    });
    child.once("error", () => {
      if (browserProcess === child) browserProcess = null;
    });

    const version = await waitForBrowser(project, true);
    return { version, launched: true };
  }

  async function ensureConnected() {
    if (client) return client;
    if (connecting) return await connecting;

    connecting = (async () => {
      await ensureBrowser();
      const nextClient = new Client({
        name: `mcp-toolhub-chrome-${project.id}`,
        version: "0.1.0"
      });
      const transport = new StdioClientTransport({
        command: project.mcpCommand,
        args: mcpArgs(project),
        env: {
          ...getDefaultEnvironment(),
          CHROME_DEVTOOLS_MCP_NO_CONFIG_DISCOVERY: "1",
          CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: "1",
          CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: "1"
        }
      });

      try {
        await nextClient.connect(transport);
        client = nextClient;
        return nextClient;
      } catch (error) {
        try {
          await nextClient.close();
        } catch {}
        throw error;
      } finally {
        connecting = null;
      }
    })();

    return await connecting;
  }

  async function getCatalog({ refresh = false } = {}) {
    if (refresh) await closeClient();
    if (catalog) return catalog;

    const mcp = await ensureConnected();
    const listed = await mcp.listTools();
    catalog = (listed.tools ?? [])
      .filter((tool) => toolAllowed(tool.name, project))
      .map((tool) => ({
        name: tool.name,
        title: tool.title,
        description: tool.description ?? "",
        inputSchema: tool.inputSchema ?? { type: "object", properties: {} },
        annotations: tool.annotations
      }));

    if (catalog.length === 0) {
      throw new Error(
        `chrome-mcp project ${project.id} exposed no tools permitted by allow_tools`
      );
    }
    return catalog;
  }

  async function status({ refresh = false } = {}) {
    if (refresh) await closeClient();
    const version = await browserVersion(project);
    return {
      ok: true,
      status: version ? "ready" : "stopped",
      project: project.id,
      browser: version ? String(version.Browser ?? "Chrome") : null,
      endpoint: `http://127.0.0.1:${project.port}`,
      profile_dir: project.profileDir,
      mcp_connected: client !== null,
      allowed_tools_cached: catalog?.length ?? null
    };
  }

  async function start() {
    const { version, launched } = await ensureBrowser();
    return {
      ok: true,
      status: "ready",
      project: project.id,
      launched,
      browser: String(version.Browser ?? "Chrome"),
      endpoint: `http://127.0.0.1:${project.port}`,
      profile_dir: project.profileDir
    };
  }

  async function closeBrowserGracefully() {
    const version = await browserVersion(project);
    if (!version) return false;
    if (typeof globalThis.WebSocket !== "function") {
      throw new Error(
        "Node runtime does not provide WebSocket required for graceful Browser.close"
      );
    }

    await new Promise((resolve, reject) => {
      const socket = new WebSocket(version.webSocketDebuggerUrl);
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          try {
            socket.close();
          } catch {}
          reject(new Error("Browser.close timed out"));
        }
      }, 3000);

      const finish = (error = null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          socket.close();
        } catch {}
        if (error) reject(error);
        else resolve();
      };

      socket.addEventListener("open", () => {
        socket.send(JSON.stringify({ id: 1, method: "Browser.close" }));
      });
      socket.addEventListener("message", (event) => {
        try {
          const message = JSON.parse(String(event.data));
          if (message.id === 1) finish();
        } catch {}
      });
      socket.addEventListener("close", () => finish());
      socket.addEventListener("error", () =>
        finish(new Error("Browser.close WebSocket failed"))
      );
    });

    return true;
  }

  async function stop() {
    await closeClient();
    const wasRunning = Boolean(await browserVersion(project));
    if (wasRunning) {
      await closeBrowserGracefully();
      await waitForBrowser(project, false);
    }
    browserProcess = null;
    return {
      ok: true,
      status: "stopped",
      project: project.id,
      was_running: wasRunning,
      profile_dir: project.profileDir
    };
  }

  async function discover(input = {}) {
    const query =
      typeof input.query === "string" ? input.query.trim().toLowerCase() : "";
    const includeSchema = input.include_schema === true;
    const limit = Number.isInteger(input.limit)
      ? Math.max(1, Math.min(input.limit, 200))
      : 64;
    const tools = await getCatalog({ refresh: input.refresh === true });

    const filtered = tools
      .filter((tool) => {
        if (!query) return true;
        return (
          tool.name.toLowerCase().includes(query) ||
          (tool.title ?? "").toLowerCase().includes(query) ||
          tool.description.toLowerCase().includes(query)
        );
      })
      .slice(0, limit)
      .map((tool) => ({
        name: tool.name,
        ...(tool.title ? { title: tool.title } : {}),
        description: tool.description,
        ...(includeSchema
          ? {
              inputSchema: tool.inputSchema,
              annotations: tool.annotations
            }
          : {})
      }));

    return {
      ok: true,
      status: "ready",
      project: project.id,
      count: filtered.length,
      total_allowed: tools.length,
      tools: filtered
    };
  }

  async function call(input) {
    const name = input?.tool;
    if (typeof name !== "string" || name.length === 0) {
      throw new Error("chrome-mcp call requires tool");
    }
    if (isHardDeniedTool(name)) {
      throw new Error(
        `chrome-devtools-mcp tool ${name} is hard-denied by ToolHub policy`
      );
    }

    let tools = await getCatalog();
    if (!tools.some((tool) => tool.name === name)) {
      tools = await getCatalog({ refresh: true });
    }
    if (!tools.some((tool) => tool.name === name)) {
      throw new Error(
        `chrome-devtools-mcp tool is unavailable or not permitted for project ${project.id}: ${name}`
      );
    }

    const args = input?.arguments ?? {};
    if (!isPlainObject(args)) {
      throw new Error("chrome-mcp call arguments must be an object");
    }

    const invoke = async () => {
      const mcp = await ensureConnected();
      return await mcp.callTool({ name, arguments: args });
    };

    try {
      return await invoke();
    } catch (firstError) {
      await closeClient();
      try {
        const refreshed = await getCatalog();
        if (!refreshed.some((tool) => tool.name === name)) {
          throw new Error(
            `chrome-devtools-mcp tool disappeared after reconnect: ${name}`
          );
        }
        return await invoke();
      } catch (secondError) {
        throw new Error(
          `chrome-devtools-mcp call failed after reconnect: first=${errorMessage(firstError)}; retry=${errorMessage(secondError)}`
        );
      }
    }
  }

  return { status, start, stop, discover, call };
}

const STATIC_ACTIONS = [
  {
    id: "list_projects",
    title: "List Chrome DevTools projects",
    description:
      "List locally configured Chrome DevTools project profiles. Project IDs map to persistent user-data directories under modules/chrome-mcp/project-profiles.",
    inputJsonSchema: {
      type: "object",
      properties: {},
      additionalProperties: false
    }
  },
  {
    id: "status",
    title: "Chrome DevTools project status",
    description:
      "Check one configured project browser, or all enabled projects when project is omitted. This does not launch Chrome.",
    inputJsonSchema: {
      type: "object",
      properties: {
        project: {
          type: "string",
          description: "Configured chrome-mcp project ID."
        },
        refresh: {
          type: "boolean",
          default: false,
          description:
            "Drop the cached upstream MCP connection before reporting status."
        }
      },
      additionalProperties: false
    }
  },
  {
    id: "start",
    title: "Start a Chrome project profile",
    description:
      "Start or reuse the configured project's dedicated Chrome remote-debugging instance with its persistent user-data-dir.",
    inputJsonSchema: {
      type: "object",
      required: ["project"],
      properties: {
        project: {
          type: "string",
          minLength: 1
        }
      },
      additionalProperties: false
    }
  },
  {
    id: "stop",
    title: "Stop a Chrome project profile",
    description:
      "Gracefully close the configured project's Chrome instance through its loopback DevTools endpoint. Profile data remains on disk.",
    inputJsonSchema: {
      type: "object",
      required: ["project"],
      properties: {
        project: {
          type: "string",
          minLength: 1
        }
      },
      additionalProperties: false
    }
  },
  {
    id: "discover",
    title: "Discover Chrome DevTools tools",
    description:
      "Discover permitted upstream Chrome DevTools MCP tools for one project. Schemas are omitted by default.",
    inputJsonSchema: {
      type: "object",
      required: ["project"],
      properties: {
        project: {
          type: "string",
          minLength: 1
        },
        query: {
          type: "string"
        },
        include_schema: {
          type: "boolean",
          default: false
        },
        refresh: {
          type: "boolean",
          default: false
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 200,
          default: 64
        }
      },
      additionalProperties: false
    }
  },
  {
    id: "call",
    title: "Call a Chrome DevTools tool",
    description:
      "Call one permitted Chrome DevTools MCP tool inside one fixed project profile. The caller cannot choose command, debugging port, user-data-dir, URL policy, or filesystem roots.",
    inputJsonSchema: {
      type: "object",
      required: ["project", "tool"],
      properties: {
        project: {
          type: "string",
          minLength: 1
        },
        tool: {
          type: "string",
          minLength: 1
        },
        arguments: {
          type: "object",
          default: {},
          additionalProperties: true
        }
      },
      additionalProperties: false
    },
    resultMode: "mcp"
  }
];

export default async function createChromeMcpModule({ moduleId, configPath }) {
  const config = await loadConfig(configPath);
  const runtimeByProject = new Map();

  for (const [projectId, project] of config.projects) {
    const key = runtimeKey(configPath, project);
    let runtime = runtimes.get(key);
    if (!runtime) {
      runtime = createRuntime(project);
      runtimes.set(key, runtime);
    }
    runtimeByProject.set(projectId, runtime);
  }

  function getProject(projectId) {
    const project = config.projects.get(projectId);
    if (!project) {
      throw new Error(`Unknown or disabled chrome-mcp project: ${projectId}`);
    }
    return project;
  }

  function getRuntime(projectId) {
    getProject(projectId);
    return runtimeByProject.get(projectId);
  }

  return {
    async describe() {
      return {
        id: moduleId,
        version: 1,
        actions: STATIC_ACTIONS
      };
    },

    async invoke(action, input) {
      if (action === "list_projects") {
        return {
          ok: true,
          projects: [...config.projects.values()].map((project) => ({
            id: project.id,
            endpoint: `http://127.0.0.1:${project.port}`,
            profile_dir: project.profileDir,
            allow_tools: project.allowTools.length,
            deny_tools: project.denyTools.length,
            workspace_roots: project.workspaceRoots,
            javascript_evaluation: project.javascriptEvaluation
          }))
        };
      }

      if (action === "status") {
        if (input?.project !== undefined) {
          return await getRuntime(input.project).status({
            refresh: input?.refresh === true
          });
        }
        const projects = [];
        for (const [, runtime] of runtimeByProject) {
          projects.push(
            await runtime.status({
              refresh: input?.refresh === true
            })
          );
        }
        return {
          ok: true,
          status: projects.some((item) => item.status === "ready")
            ? "ready"
            : "stopped",
          projects
        };
      }

      if (action === "start") return await getRuntime(input?.project).start();
      if (action === "stop") return await getRuntime(input?.project).stop();
      if (action === "discover") {
        return await getRuntime(input?.project).discover(input ?? {});
      }
      if (action === "call") {
        return await getRuntime(input?.project).call(input ?? {});
      }

      throw new Error(`Unknown chrome-mcp facade action: ${action}`);
    }
  };
}
