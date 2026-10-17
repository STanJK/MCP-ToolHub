import { readFile } from "node:fs/promises";
import process from "node:process";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { parse } from "yaml";

const runtimes = new Map();
const forbiddenHeaderNames = new Set(["content-type", "mcp-session-id", "mcp-protocol-version"]);

function normalizeActionId(name) {
  let id = String(name)
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!id) id = "tool";
  if (!/^[a-z0-9]/.test(id)) id = `tool_${id}`;
  return id;
}

function resolveHeaderValue(name, value) {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") {
    throw new Error(`remote-mcp header ${name} must be a string or { env, prefix?, suffix? }`);
  }
  if (typeof value.env !== "string" || value.env.length === 0) {
    throw new Error(`remote-mcp header ${name} env reference is missing env`);
  }
  const secret = process.env[value.env];
  if (typeof secret !== "string" || secret.length === 0) {
    throw new Error(`remote-mcp header ${name} requires environment variable ${value.env}`);
  }
  const prefix = value.prefix ?? "";
  const suffix = value.suffix ?? "";
  if (typeof prefix !== "string" || typeof suffix !== "string") {
    throw new Error(`remote-mcp header ${name} prefix/suffix must be strings`);
  }
  return `${prefix}${secret}${suffix}`;
}

async function loadConfig(configPath) {
  const raw = await readFile(configPath, "utf8");
  const config = parse(raw);
  if (!config || typeof config !== "object") throw new Error("Invalid remote-mcp config");
  if (config.version !== 1) throw new Error("remote-mcp config version must be 1");
  if (typeof config.url !== "string" || config.url.length === 0) {
    throw new Error("remote-mcp config requires url");
  }

  let url;
  try {
    url = new URL(config.url);
  } catch {
    throw new Error("remote-mcp url must be a valid absolute URL");
  }
  if (url.protocol !== "https:" && config.allow_insecure_http !== true) {
    throw new Error("remote-mcp requires https unless allow_insecure_http: true is explicitly set");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("remote-mcp url must use http or https");
  }

  const headerConfig = config.headers ?? {};
  if (!headerConfig || typeof headerConfig !== "object" || Array.isArray(headerConfig)) {
    throw new Error("remote-mcp headers must be an object");
  }
  const headers = {};
  for (const [name, value] of Object.entries(headerConfig)) {
    if (forbiddenHeaderNames.has(name.toLowerCase())) {
      throw new Error(`remote-mcp header ${name} is transport-managed and cannot be configured`);
    }
    headers[name] = resolveHeaderValue(name, value);
  }

  const allowTools = config.allow_tools;
  if (!Array.isArray(allowTools) || allowTools.length === 0 || allowTools.some((x) => typeof x !== "string")) {
    throw new Error("remote-mcp config requires non-empty allow_tools");
  }
  const denyTools = config.deny_tools ?? [];
  if (!Array.isArray(denyTools) || denyTools.some((x) => typeof x !== "string")) {
    throw new Error("remote-mcp deny_tools must be an array of strings");
  }

  return {
    url,
    headers,
    allowTools,
    denyTools,
    source: {
      url: config.url,
      headerNames: Object.keys(headerConfig).sort(),
      allowTools,
      denyTools
    }
  };
}

function toolAllowed(name, config) {
  if (config.denyTools.includes(name)) return false;
  return config.allowTools.includes("*") || config.allowTools.includes(name);
}

function runtimeKey(configPath, config) {
  return JSON.stringify({ configPath, ...config.source });
}

function createRuntime(config) {
  let client = null;
  let connecting = null;
  let actions = null;
  const upstreamByAction = new Map();

  async function closeClient() {
    const current = client;
    client = null;
    if (current) {
      try { await current.close(); } catch {}
    }
  }

  async function ensureConnected() {
    if (client) return client;
    if (connecting) return await connecting;

    connecting = (async () => {
      const nextClient = new Client({
        name: "mcp-toolhub-remote-proxy",
        version: "0.1.0"
      });
      const transport = new StreamableHTTPClientTransport(config.url, {
        requestInit: { headers: config.headers },
        redirectPolicy: "same-origin"
      });
      try {
        await nextClient.connect(transport);
        client = nextClient;
        return nextClient;
      } catch (error) {
        try { await nextClient.close(); } catch {}
        throw error;
      } finally {
        connecting = null;
      }
    })();

    return await connecting;
  }

  async function discover() {
    if (actions) return actions;
    const mcp = await ensureConnected();
    const listed = await mcp.listTools();
    upstreamByAction.clear();
    const used = new Set();
    const discovered = [];

    for (const tool of listed.tools ?? []) {
      if (!toolAllowed(tool.name, config)) continue;
      let actionId = normalizeActionId(tool.name);
      if (used.has(actionId)) {
        let n = 2;
        while (used.has(`${actionId}_${n}`)) n++;
        actionId = `${actionId}_${n}`;
      }
      used.add(actionId);
      upstreamByAction.set(actionId, tool.name);
      discovered.push({
        id: actionId,
        title: tool.title ?? `Remote MCP: ${tool.name}`,
        description: `[Remote MCP: ${tool.name}] ${tool.description ?? ""}`.trim(),
        inputJsonSchema: tool.inputSchema ?? { type: "object", properties: {} },
        annotations: tool.annotations,
        resultMode: "mcp"
      });
    }

    if (discovered.length === 0) {
      throw new Error("remote-mcp exposed no tools permitted by allow_tools");
    }
    actions = discovered;
    return actions;
  }

  async function invoke(action, input) {
    await discover();
    const upstreamName = upstreamByAction.get(action);
    if (!upstreamName) throw new Error(`Unknown proxied remote-mcp action: ${action}`);

    const call = async () => {
      const mcp = await ensureConnected();
      return await mcp.callTool({ name: upstreamName, arguments: input ?? {} });
    };

    try {
      return await call();
    } catch (firstError) {
      await closeClient();
      try {
        return await call();
      } catch (secondError) {
        const first = firstError instanceof Error ? firstError.message : String(firstError);
        const second = secondError instanceof Error ? secondError.message : String(secondError);
        throw new Error(`remote-mcp call failed after reconnect: first=${first}; retry=${second}`);
      }
    }
  }

  return { discover, invoke };
}

export default async function createRemoteMcpModule({ moduleId, configPath }) {
  const config = await loadConfig(configPath);
  const key = runtimeKey(configPath, config);
  let runtime = runtimes.get(key);
  if (!runtime) {
    runtime = createRuntime(config);
    runtimes.set(key, runtime);
  }

  return {
    async describe() {
      return { id: moduleId, version: 1, actions: await runtime.discover() };
    },
    async invoke(action, input) {
      return await runtime.invoke(action, input);
    }
  };
}
