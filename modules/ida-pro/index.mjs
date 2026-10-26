import { readFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { parse } from "yaml";

const runtimes = new Map();

const hardDeniedToolNames = new Set([
  "py_eval",
  "py_exec_file"
]);

function isHardDeniedTool(name) {
  const normalized = String(name).toLowerCase();
  if (hardDeniedToolNames.has(normalized)) return true;

  // Fail closed for future upstream Python execution surfaces.
  return /(^|[_-])(?:py|python)(?:[_-]|$)/i.test(normalized);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

async function loadConfig(configPath) {
  const raw = await readFile(configPath, "utf8");
  const config = parse(raw);
  if (!config || typeof config !== "object") throw new Error("Invalid ida-pro config");
  if (config.version !== 1) throw new Error("ida-pro config version must be 1");
  if (typeof config.command !== "string" || config.command.length === 0) {
    throw new Error("ida-pro config requires command");
  }
  if (config.args !== undefined && !Array.isArray(config.args)) {
    throw new Error("ida-pro config args must be an array");
  }
  const args = config.args ?? ["--transport", "stdio"];
  if (args.some((arg) => typeof arg !== "string")) {
    throw new Error("ida-pro config args must contain only strings");
  }

  const allowTools = config.allow_tools;
  if (!Array.isArray(allowTools) || allowTools.length === 0 || allowTools.some((x) => typeof x !== "string")) {
    throw new Error("ida-pro config requires non-empty allow_tools");
  }

  const denyTools = config.deny_tools ?? [];
  if (!Array.isArray(denyTools) || denyTools.some((x) => typeof x !== "string")) {
    throw new Error("ida-pro config deny_tools must be an array of strings");
  }

  return { command: config.command, args, allowTools, denyTools };
}

function toolAllowed(name, config) {
  if (isHardDeniedTool(name)) return false;
  if (config.denyTools.includes(name)) return false;
  return config.allowTools.includes("*") || config.allowTools.includes(name);
}

function runtimeKey(configPath, config) {
  return JSON.stringify({
    configPath,
    command: config.command,
    args: config.args,
    allowTools: config.allowTools,
    denyTools: config.denyTools
  });
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
        name: "mcp-toolhub-ida-pro-facade",
        version: "0.1.0"
      });
      const transport = new StdioClientTransport({
        command: config.command,
        args: config.args
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
    if (refresh) {
      await closeClient();
    }
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

    return catalog;
  }

  async function status() {
    try {
      const tools = await getCatalog();
      return {
        ok: true,
        status: "ready",
        backend: "ida-pro-mcp",
        allowed_tools: tools.length,
        hard_denied_tools: [...hardDeniedToolNames]
      };
    } catch (error) {
      await closeClient();
      return {
        ok: true,
        status: "offline",
        backend: "ida-pro-mcp",
        allowed_tools: 0,
        error: errorMessage(error)
      };
    }
  }

  async function discover(input = {}) {
    const query = typeof input.query === "string" ? input.query.trim().toLowerCase() : "";
    const includeSchema = input.include_schema === true;
    const limit = Number.isInteger(input.limit) ? Math.max(1, Math.min(input.limit, 200)) : 64;
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
    const upstreamName = input?.tool;
    if (typeof upstreamName !== "string" || upstreamName.length === 0) {
      throw new Error("ida-pro call requires tool");
    }
    if (isHardDeniedTool(upstreamName)) {
      throw new Error(`ida-pro-mcp tool ${upstreamName} is hard-denied by ToolHub policy`);
    }

    let tools = await getCatalog();
    if (!tools.some((tool) => tool.name === upstreamName)) {
      // Refresh once in case the upstream extension set changed after startup.
      tools = await getCatalog({ refresh: true });
    }

    if (!tools.some((tool) => tool.name === upstreamName)) {
      throw new Error(`ida-pro-mcp tool is unavailable or not permitted: ${upstreamName}`);
    }

    const args = input?.arguments ?? {};
    if (!args || typeof args !== "object" || Array.isArray(args)) {
      throw new Error("ida-pro call arguments must be an object");
    }

    const invoke = async () => {
      const mcp = await ensureConnected();
      return await mcp.callTool({ name: upstreamName, arguments: args });
    };

    try {
      return await invoke();
    } catch (firstError) {
      await closeClient();
      try {
        // Revalidate the tool against a fresh catalog after reconnect.
        const refreshed = await getCatalog();
        if (!refreshed.some((tool) => tool.name === upstreamName)) {
          throw new Error(`ida-pro-mcp tool disappeared after reconnect: ${upstreamName}`);
        }
        return await invoke();
      } catch (secondError) {
        const first = errorMessage(firstError);
        const second = errorMessage(secondError);
        throw new Error(`ida-pro-mcp call failed after reconnect: first=${first}; retry=${second}`);
      }
    }
  }

  return { status, discover, call };
}

const STATIC_ACTIONS = [
  {
    id: "status",
    title: "IDA Pro backend status",
    description: "Check whether the configured IDA Pro MCP backend is currently reachable. This tool is always present even when IDA is closed.",
    inputJsonSchema: {
      type: "object",
      properties: {},
      additionalProperties: false
    }
  },
  {
    id: "discover",
    title: "Discover IDA Pro tools",
    description: "Discover permitted upstream IDA MCP tools at runtime. Use query to narrow results. Schemas are omitted by default; set include_schema=true only for tools you intend to call.",
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
          description: "Include upstream inputSchema and annotations in results. Leave false for low-context discovery."
        },
        refresh: {
          type: "boolean",
          default: false,
          description: "Reconnect and refresh the upstream IDA tool catalog before discovery."
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
    title: "Call an IDA Pro tool",
    description: "Call one permitted upstream IDA MCP tool by exact name. Use ida_pro_discover first when the tool name or arguments are unknown. Python execution tools are hard-denied regardless of configuration.",
    inputJsonSchema: {
      type: "object",
      required: ["tool"],
      properties: {
        tool: {
          type: "string",
          minLength: 1,
          description: "Exact upstream IDA MCP tool name returned by ida_pro_discover."
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

export default async function createIdaProModule({ moduleId, configPath }) {
  const config = await loadConfig(configPath);
  const key = runtimeKey(configPath, config);

  let runtime = runtimes.get(key);
  if (!runtime) {
    runtime = createRuntime(config);
    runtimes.set(key, runtime);
  }

  return {
    async describe() {
      // Deliberately static: IDA being closed must never change ToolHub's
      // connector-visible tool catalog or degrade ToolHub startup.
      return {
        id: moduleId,
        version: 1,
        actions: STATIC_ACTIONS
      };
    },

    async invoke(action, input) {
      if (action === "status") return await runtime.status();
      if (action === "discover") return await runtime.discover(input ?? {});
      if (action === "call") return await runtime.call(input ?? {});
      throw new Error(`Unknown ida-pro facade action: ${action}`);
    }
  };
}
