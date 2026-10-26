import { readFile } from "node:fs/promises";
import process from "node:process";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { parse } from "yaml";

const runtimes = new Map();
const serverIdPattern = /^[a-z0-9][a-z0-9-]*$/;
const forbiddenHeaderNames = new Set(["content-type", "mcp-session-id", "mcp-protocol-version"]);

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function resolveHeaderValue(serverId, name, value) {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") {
    throw new Error(
      `remote-mcp server ${serverId} header ${name} must be a string or { env, prefix?, suffix? }`
    );
  }
  if (typeof value.env !== "string" || value.env.length === 0) {
    throw new Error(
      `remote-mcp server ${serverId} header ${name} env reference is missing env`
    );
  }

  const secret = process.env[value.env];
  if (typeof secret !== "string" || secret.length === 0) {
    throw new Error(
      `remote-mcp server ${serverId} header ${name} requires environment variable ${value.env}`
    );
  }

  const prefix = value.prefix ?? "";
  const suffix = value.suffix ?? "";
  if (typeof prefix !== "string" || typeof suffix !== "string") {
    throw new Error(
      `remote-mcp server ${serverId} header ${name} prefix/suffix must be strings`
    );
  }

  return `${prefix}${secret}${suffix}`;
}

function resolveHeaders(serverConfig) {
  const headers = {};
  for (const [name, value] of Object.entries(serverConfig.headerConfig)) {
    headers[name] = resolveHeaderValue(serverConfig.id, name, value);
  }
  return headers;
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
    throw new Error(
      `remote-mcp server ${serverId} requires https unless allow_insecure_http: true is explicitly set`
    );
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`remote-mcp server ${serverId} url must use http or https`);
  }

  const headerConfig = rawServer.headers ?? {};
  if (!headerConfig || typeof headerConfig !== "object" || Array.isArray(headerConfig)) {
    throw new Error(`remote-mcp server ${serverId} headers must be an object`);
  }
  for (const name of Object.keys(headerConfig)) {
    if (forbiddenHeaderNames.has(name.toLowerCase())) {
      throw new Error(
        `remote-mcp server ${serverId} header ${name} is transport-managed and cannot be configured`
      );
    }
  }

  const allowTools = rawServer.allow_tools;
  if (
    !Array.isArray(allowTools) ||
    allowTools.length === 0 ||
    allowTools.some((x) => typeof x !== "string")
  ) {
    throw new Error(`remote-mcp server ${serverId} requires non-empty allow_tools`);
  }

  const denyTools = rawServer.deny_tools ?? [];
  if (!Array.isArray(denyTools) || denyTools.some((x) => typeof x !== "string")) {
    throw new Error(`remote-mcp server ${serverId} deny_tools must be an array of strings`);
  }

  return {
    id: serverId,
    url,
    headerConfig,
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

  if (!config || typeof config !== "object") {
    throw new Error("Invalid remote-mcp config");
  }
  if (config.version !== 1) {
    throw new Error("remote-mcp config version must be 1");
  }
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
  let catalog = null;

  async function closeClient() {
    const current = client;
    client = null;
    catalog = null;
    if (current) {
      try { await current.close(); } catch {}
    }
  }

  async function ensureConnected() {
    if (client) return client;
    if (connecting) return await connecting;

    connecting = (async () => {
      const headers = resolveHeaders(config);
      const nextClient = new Client({
        name: `mcp-toolhub-remote-${config.id}`,
        version: "0.1.0"
      });

      const transport = new StreamableHTTPClientTransport(config.url, {
        requestInit: { headers },
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

  async function getCatalog({ refresh = false } = {}) {
    if (refresh) await closeClient();
    if (catalog) return catalog;

    const mcp = await ensureConnected();
    const listed = await mcp.listTools();

    catalog = (listed.tools ?? [])
      .filter((tool) => toolAllowed(tool.name, config))
      .map((tool) => ({
        name: tool.name,
        title: tool.title,
        description: tool.description ?? "",
        inputSchema: tool.inputSchema ?? { type: "object", properties: {} },
        annotations: tool.annotations
      }));

    if (catalog.length === 0) {
      throw new Error(
        `remote-mcp server ${config.id} exposed no tools permitted by allow_tools`
      );
    }

    return catalog;
  }

  async function status({ refresh = false } = {}) {
    try {
      const tools = await getCatalog({ refresh });
      return {
        ok: true,
        status: "ready",
        server: config.id,
        allowed_tools: tools.length
      };
    } catch (error) {
      await closeClient();
      return {
        ok: true,
        status: "offline",
        server: config.id,
        allowed_tools: 0,
        error: errorMessage(error)
      };
    }
  }

  async function discover(input = {}) {
    const query = typeof input.query === "string" ? input.query.trim().toLowerCase() : "";
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
      server: config.id,
      count: filtered.length,
      total_allowed: tools.length,
      tools: filtered
    };
  }

  async function call(input) {
    const name = input?.tool;
    if (typeof name !== "string" || name.length === 0) {
      throw new Error("remote-mcp call requires tool");
    }

    let tools = await getCatalog();
    if (!tools.some((tool) => tool.name === name)) {
      tools = await getCatalog({ refresh: true });
    }
    if (!tools.some((tool) => tool.name === name)) {
      throw new Error(
        `remote-mcp server ${config.id} tool is unavailable or not permitted: ${name}`
      );
    }

    const args = input?.arguments ?? {};
    if (!args || typeof args !== "object" || Array.isArray(args)) {
      throw new Error("remote-mcp call arguments must be an object");
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
            `remote-mcp server ${config.id} tool disappeared after reconnect: ${name}`
          );
        }
        return await invoke();
      } catch (secondError) {
        throw new Error(
          `remote-mcp server ${config.id} call failed after reconnect: first=${errorMessage(firstError)}; retry=${errorMessage(secondError)}`
        );
      }
    }
  }

  return { status, discover, call };
}

const STATIC_ACTIONS = [
  {
    id: "status",
    title: "Remote MCP server status",
    description: "Check one configured remote MCP server, or all enabled servers when server is omitted. This tool is always present even when remote backends or credentials are unavailable.",
    inputJsonSchema: {
      type: "object",
      properties: {
        server: {
          type: "string",
          description: "Configured remote-mcp server ID. Omit to check every enabled server."
        },
        refresh: {
          type: "boolean",
          default: false,
          description: "Reconnect and refresh the selected server catalog before reporting status."
        }
      },
      additionalProperties: false
    }
  },
  {
    id: "discover",
    title: "Discover remote MCP tools",
    description: "Discover permitted tools from one configured remote MCP server. Schemas are omitted by default; set include_schema=true only for tools you intend to call.",
    inputJsonSchema: {
      type: "object",
      required: ["server"],
      properties: {
        server: {
          type: "string",
          minLength: 1,
          description: "Configured remote-mcp server ID, for example sleeprecord-server."
        },
        query: {
          type: "string",
          description: "Case-insensitive substring matched against upstream tool name, title, and description."
        },
        include_schema: {
          type: "boolean",
          default: false,
          description: "Include upstream inputSchema and annotations in results."
        },
        refresh: {
          type: "boolean",
          default: false,
          description: "Reconnect and refresh the upstream tool catalog before discovery."
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
    title: "Call a remote MCP tool",
    description: "Call one permitted tool on one configured remote MCP server by exact name. The server URL, authentication headers, and tool policy remain local ToolHub configuration.",
    inputJsonSchema: {
      type: "object",
      required: ["server", "tool"],
      properties: {
        server: {
          type: "string",
          minLength: 1,
          description: "Configured remote-mcp server ID."
        },
        tool: {
          type: "string",
          minLength: 1,
          description: "Exact upstream tool name returned by remote_mcp_discover."
        },
        arguments: {
          type: "object",
          default: {},
          additionalProperties: true,
          description: "Arguments for the selected upstream tool."
        }
      },
      additionalProperties: false
    },
    resultMode: "mcp"
  }
];

export default async function createRemoteMcpModule({ moduleId, configPath }) {
  const config = await loadConfig(configPath);
  const runtimeByServer = new Map();

  for (const serverConfig of config.servers) {
    const key = runtimeKey(configPath, serverConfig);
    let runtime = runtimes.get(key);
    if (!runtime) {
      runtime = createRuntime(serverConfig);
      runtimes.set(key, runtime);
    }
    runtimeByServer.set(serverConfig.id, runtime);
  }

  function getRuntime(serverId) {
    const runtime = runtimeByServer.get(serverId);
    if (!runtime) {
      throw new Error(`Unknown or disabled remote-mcp server: ${serverId}`);
    }
    return runtime;
  }

  return {
    async describe() {
      // Deliberately static: remote backend health or missing runtime secrets
      // must not change the connector-visible ToolHub catalog.
      return {
        id: moduleId,
        version: 1,
        actions: STATIC_ACTIONS
      };
    },

    async invoke(action, input) {
      if (action === "status") {
        const serverId = input?.server;
        if (serverId !== undefined) {
          return await getRuntime(serverId).status({ refresh: input?.refresh === true });
        }

        const servers = [];
        for (const [id, runtime] of runtimeByServer) {
          servers.push(await runtime.status({ refresh: input?.refresh === true }));
        }
        return {
          ok: true,
          status: servers.every((item) => item.status === "ready") ? "ready" : "degraded",
          servers
        };
      }

      if (action === "discover") {
        return await getRuntime(input?.server).discover(input ?? {});
      }

      if (action === "call") {
        return await getRuntime(input?.server).call(input ?? {});
      }

      throw new Error(`Unknown remote-mcp facade action: ${action}`);
    }
  };
}
