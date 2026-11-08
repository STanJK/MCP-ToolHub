import { readFile } from "node:fs/promises";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { parse } from "yaml";

const runtimes = new Map();

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function isLoopbackHost(hostname) {
  const normalized = String(hostname).toLowerCase();
  return normalized === "127.0.0.1" ||
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized === "[::1]";
}

async function loadConfig(configPath) {
  const raw = await readFile(configPath, "utf8");
  const config = parse(raw);

  if (!config || typeof config !== "object") {
    throw new Error("Invalid jadx-mcp config");
  }
  if (config.version !== 1) {
    throw new Error("jadx-mcp config version must be 1");
  }
  if (typeof config.url !== "string" || config.url.length === 0) {
    throw new Error("jadx-mcp config requires url");
  }

  let url;
  try {
    url = new URL(config.url);
  } catch {
    throw new Error("jadx-mcp url must be a valid absolute URL");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("jadx-mcp url must use http or https");
  }
  if (!isLoopbackHost(url.hostname)) {
    throw new Error("jadx-mcp url must use a loopback host (127.0.0.1, localhost, or ::1)");
  }

  const allowTools = config.allow_tools;
  if (
    !Array.isArray(allowTools) ||
    allowTools.length === 0 ||
    allowTools.some((x) => typeof x !== "string")
  ) {
    throw new Error("jadx-mcp config requires non-empty allow_tools");
  }

  const denyTools = config.deny_tools ?? [];
  if (!Array.isArray(denyTools) || denyTools.some((x) => typeof x !== "string")) {
    throw new Error("jadx-mcp config deny_tools must be an array of strings");
  }

  return {
    url,
    allowTools,
    denyTools,
    source: {
      url: config.url,
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
      const nextClient = new Client({
        name: "mcp-toolhub-jadx-mcp",
        version: "0.1.0"
      });

      const transport = new StreamableHTTPClientTransport(config.url, {
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
      throw new Error("jadx-mcp exposed no tools permitted by allow_tools");
    }

    return catalog;
  }

  async function status({ refresh = false } = {}) {
    try {
      const tools = await getCatalog({ refresh });
      return {
        ok: true,
        status: "ready",
        backend: "jadx-mcp",
        endpoint: config.url.href,
        allowed_tools: tools.length
      };
    } catch (error) {
      await closeClient();
      return {
        ok: true,
        status: "offline",
        backend: "jadx-mcp",
        endpoint: config.url.href,
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
        return tool.name.toLowerCase().includes(query) ||
          (tool.title ?? "").toLowerCase().includes(query) ||
          tool.description.toLowerCase().includes(query);
      })
      .slice(0, limit)
      .map((tool) => ({
        name: tool.name,
        ...(tool.title ? { title: tool.title } : {}),
        description: tool.description,
        ...(includeSchema ? {
          inputSchema: tool.inputSchema,
          annotations: tool.annotations
        } : {})
      }));

    return {
      ok: true,
      status: "ready",
      count: filtered.length,
      total_allowed: tools.length,
      tools: filtered
    };
  }

  async function call(input) {
    const name = input?.tool;
    if (typeof name !== "string" || name.length === 0) {
      throw new Error("jadx-mcp call requires tool");
    }

    let tools = await getCatalog();
    if (!tools.some((tool) => tool.name === name)) {
      tools = await getCatalog({ refresh: true });
    }
    if (!tools.some((tool) => tool.name === name)) {
      throw new Error(`jadx-mcp tool is unavailable or not permitted: ${name}`);
    }

    const args = input?.arguments ?? {};
    if (!args || typeof args !== "object" || Array.isArray(args)) {
      throw new Error("jadx-mcp call arguments must be an object");
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
          throw new Error(`jadx-mcp tool disappeared after reconnect: ${name}`);
        }
        return await invoke();
      } catch (secondError) {
        throw new Error(
          `jadx-mcp call failed after reconnect: first=${errorMessage(firstError)}; retry=${errorMessage(secondError)}`
        );
      }
    }
  }

  return { status, discover, call };
}

const STATIC_ACTIONS = [
  {
    id: "status",
    title: "JADX MCP backend status",
    description: "Check whether the configured local JADX GUI MCP backend is reachable. This tool remains present when JADX is closed.",
    inputJsonSchema: {
      type: "object",
      properties: {
        refresh: {
          type: "boolean",
          default: false,
          description: "Reconnect and refresh the upstream JADX tool catalog before reporting status."
        }
      },
      additionalProperties: false
    }
  },
  {
    id: "discover",
    title: "Discover JADX MCP tools",
    description: "Discover permitted tools from the local JADX GUI MCP backend. Schemas are omitted by default; request them only for tools you intend to call.",
    inputJsonSchema: {
      type: "object",
      properties: {
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
          description: "Reconnect and refresh the upstream JADX tool catalog before discovery."
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
    title: "Call a JADX MCP tool",
    description: "Call one permitted upstream JADX MCP tool by exact name. Use jadx_mcp_discover first when the tool name or arguments are unknown.",
    inputJsonSchema: {
      type: "object",
      required: ["tool"],
      properties: {
        tool: {
          type: "string",
          minLength: 1,
          description: "Exact upstream JADX MCP tool name returned by jadx_mcp_discover."
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

export default async function createJadxMcpModule({ moduleId, configPath }) {
  const config = await loadConfig(configPath);
  const key = runtimeKey(configPath, config);

  let runtime = runtimes.get(key);
  if (!runtime) {
    runtime = createRuntime(config);
    runtimes.set(key, runtime);
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
      if (action === "status") return await runtime.status(input ?? {});
      if (action === "discover") return await runtime.discover(input ?? {});
      if (action === "call") return await runtime.call(input ?? {});
      throw new Error(`Unknown jadx-mcp facade action: ${action}`);
    }
  };
}
