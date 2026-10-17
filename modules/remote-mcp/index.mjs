import { readFile } from "node:fs/promises";
import process from "node:process";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { parse } from "yaml";

const runtimes = new Map();
const serverIdPattern = /^[a-z0-9][a-z0-9-]*$/;
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

function resolveHeaderValue(serverId, name, value) {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") {
    throw new Error(`remote-mcp server ${serverId} header ${name} must be a string or { env, prefix?, suffix? }`);
  }
  if (typeof value.env !== "string" || value.env.length === 0) {
    throw new Error(`remote-mcp server ${serverId} header ${name} env reference is missing env`);
  }
  const secret = process.env[value.env];
  if (typeof secret !== "string" || secret.length === 0) {
    throw new Error(`remote-mcp server ${serverId} header ${name} requires environment variable ${value.env}`);
  }
  const prefix = value.prefix ?? "";
  const suffix = value.suffix ?? "";
  if (typeof prefix !== "string" || typeof suffix !== "string") {
    throw new Error(`remote-mcp server ${serverId} header ${name} prefix/suffix must be strings`);
  }
  return `${prefix}${secret}${suffix}`;
}

function parseServerConfig(serverId, rawServer) {
  if (!serverIdPattern.test(serverId)) {
    throw new Error(`Invalid remote-mcp server id: ${serverId}`);
  }
  if (!rawServer || typeof rawServer !== "object" || Array.isArray(rawServer)) {
    throw new Error(`remote-mcp server ${serverId} must be an object`);
  }
  if (rawServer.enabled === false) return null;
  if (rawServer.enabled !== undefined && rawServer.enabled !== true) {
    throw new Error(`remote-mcp server ${serverId} enabled must be boolean`);
  }
  if (typeof rawServer.url !== "string" || rawServer.url.length === 0) {
    throw new Error(`remote-mcp server ${serverId} requires url`);
  }

  let url;
  try {
    url = new URL(rawServer.url);
  } catch {
    throw new Error(`remote-mcp server ${serverId} url must be a valid absolute URL`);
  }
  if (url.protocol !== "https:" && rawServer.allow_insecure_http !== true) {
    throw new Error(`remote-mcp server ${serverId} requires https unless allow_insecure_http: true is explicitly set`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`remote-mcp server ${serverId} url must use http or https`);
  }

  const headerConfig = rawServer.headers ?? {};
  if (!headerConfig || typeof headerConfig !== "object" || Array.isArray(headerConfig)) {
    throw new Error(`remote-mcp server ${serverId} headers must be an object`);
  }
  const headers = {};
  for (const [name, value] of Object.entries(headerConfig)) {
    if (forbiddenHeaderNames.has(name.toLowerCase())) {
      throw new Error(`remote-mcp server ${serverId} header ${name} is transport-managed and cannot be configured`);
    }
    headers[name] = resolveHeaderValue(serverId, name, value);
  }

  const allowTools = rawServer.allow_tools;
  if (!Array.isArray(allowTools) || allowTools.length === 0 || allowTools.some((x) => typeof x !== "string")) {
    throw new Error(`remote-mcp server ${serverId} requires non-empty allow_tools`);
  }
  const denyTools = rawServer.deny_tools ?? [];
  if (!Array.isArray(denyTools) || denyTools.some((x) => typeof x !== "string")) {
    throw new Error(`remote-mcp server ${serverId} deny_tools must be an array of strings`);
  }

  return {
    id: serverId,
    url,
    headers,
    allowTools,
    denyTools,
    source: {
      id: serverId,
      url: rawServer.url,
      headerNames: Object.keys(headerConfig).sort(),
      allowTools,
      denyTools
    }
  };
}

async function loadConfig(configPath) {
  const raw = await readFile(configPath, "utf8");
  const config = parse(raw);
  if (!config || typeof config !== "object") throw new Error("Invalid remote-mcp config");
  if (config.version !== 1) throw new Error("remote-mcp config version must be 1");
  if (!config.servers || typeof config.servers !== "object" || Array.isArray(config.servers)) {
    throw new Error("remote-mcp config requires servers object");
  }

  const servers = [];
  for (const [serverId, rawServer] of Object.entries(config.servers)) {
    const parsed = parseServerConfig(serverId, rawServer);
    if (parsed) servers.push(parsed);
  }
  if (servers.length === 0) {
    throw new Error("remote-mcp config has no enabled servers");
  }
  return { servers };
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
  let tools = null;

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
        name: `mcp-toolhub-remote-${config.id}`,
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

  async function discoverTools() {
    if (tools) return tools;
    const mcp = await ensureConnected();
    const listed = await mcp.listTools();
    tools = (listed.tools ?? []).filter((tool) => toolAllowed(tool.name, config));
    if (tools.length === 0) {
      throw new Error(`remote-mcp server ${config.id} exposed no tools permitted by allow_tools`);
    }
    return tools;
  }

  async function callTool(name, input) {
    const call = async () => {
      const mcp = await ensureConnected();
      return await mcp.callTool({ name, arguments: input ?? {} });
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
        throw new Error(`remote-mcp server ${config.id} call failed after reconnect: first=${first}; retry=${second}`);
      }
    }
  }

  return { discoverTools, callTool };
}

export default async function createRemoteMcpModule({ moduleId, configPath }) {
  const config = await loadConfig(configPath);
  const runtimeByServer = new Map();
  const targetByAction = new Map();
  let descriptor = null;

  for (const serverConfig of config.servers) {
    const key = runtimeKey(configPath, serverConfig);
    let runtime = runtimes.get(key);
    if (!runtime) {
      runtime = createRuntime(serverConfig);
      runtimes.set(key, runtime);
    }
    runtimeByServer.set(serverConfig.id, runtime);
  }

  async function discover() {
    if (descriptor) return descriptor;

    const actions = [];
    const used = new Set();
    targetByAction.clear();

    for (const serverConfig of config.servers) {
      const runtime = runtimeByServer.get(serverConfig.id);
      const upstreamTools = await runtime.discoverTools();
      const serverPrefix = normalizeActionId(serverConfig.id);

      for (const tool of upstreamTools) {
        const baseActionId = normalizeActionId(`${serverPrefix}_${tool.name}`);
        let actionId = baseActionId;
        if (used.has(actionId)) {
          let n = 2;
          while (used.has(`${baseActionId}_${n}`)) n++;
          actionId = `${baseActionId}_${n}`;
        }
        used.add(actionId);
        targetByAction.set(actionId, { runtime, upstreamName: tool.name, serverId: serverConfig.id });
        actions.push({
          id: actionId,
          title: tool.title ?? `${serverConfig.id}: ${tool.name}`,
          description: `[Remote MCP ${serverConfig.id}: ${tool.name}] ${tool.description ?? ""}`.trim(),
          inputJsonSchema: tool.inputSchema ?? { type: "object", properties: {} },
          annotations: tool.annotations,
          resultMode: "mcp"
        });
      }
    }

    descriptor = { id: moduleId, version: 1, actions };
    return descriptor;
  }

  return {
    async describe() {
      return await discover();
    },
    async invoke(action, input) {
      await discover();
      const target = targetByAction.get(action);
      if (!target) throw new Error(`Unknown proxied remote-mcp action: ${action}`);
      return await target.runtime.callTool(target.upstreamName, input);
    }
  };
}
