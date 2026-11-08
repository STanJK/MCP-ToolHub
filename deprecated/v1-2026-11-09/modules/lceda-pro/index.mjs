import { readFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { parse } from "yaml";

const runtimes = new Map();

function normalizeActionId(name) {
  let id = String(name)
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!id) id = "tool";
  if (!/^[a-z0-9]/.test(id)) id = `tool_${id}`;
  return id;
}

async function loadConfig(configPath) {
  const raw = await readFile(configPath, "utf8");
  const config = parse(raw);
  if (!config || typeof config !== "object") throw new Error("Invalid lceda-pro config");
  if (config.version !== 1) throw new Error("lceda-pro config version must be 1");
  if (typeof config.command !== "string" || config.command.length === 0) {
    throw new Error("lceda-pro config requires command");
  }
  if (config.args !== undefined && !Array.isArray(config.args)) {
    throw new Error("lceda-pro config args must be an array");
  }
  const args = config.args ?? ["--mcp", "stdio"];
  if (args.some((arg) => typeof arg !== "string")) {
    throw new Error("lceda-pro config args must contain only strings");
  }
  const allowTools = config.allow_tools;
  if (!Array.isArray(allowTools) || allowTools.length === 0 || allowTools.some((x) => typeof x !== "string")) {
    throw new Error("lceda-pro config requires non-empty allow_tools");
  }
  const denyTools = config.deny_tools ?? [];
  if (!Array.isArray(denyTools) || denyTools.some((x) => typeof x !== "string")) {
    throw new Error("lceda-pro config deny_tools must be an array of strings");
  }
  return { command: config.command, args, allowTools, denyTools };
}

function toolAllowed(name, config) {
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
        name: "mcp-toolhub-lceda-pro-proxy",
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
        title: tool.title ?? `JLCEDA Pro: ${tool.name}`,
        description: `[Official lceda-pro MCP: ${tool.name}] ${tool.description ?? ""}`.trim(),
        inputJsonSchema: tool.inputSchema ?? { type: "object", properties: {} },
        annotations: tool.annotations,
        resultMode: "mcp"
      });
    }

    if (discovered.length === 0) {
      throw new Error("lceda-pro MCP exposed no tools permitted by allow_tools");
    }

    actions = discovered;
    return actions;
  }

  async function invoke(action, input) {
    await discover();
    const upstreamName = upstreamByAction.get(action);
    if (!upstreamName) throw new Error(`Unknown proxied lceda-pro action: ${action}`);

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
        throw new Error(`lceda-pro MCP call failed after reconnect: first=${first}; retry=${second}`);
      }
    }
  }

  return { discover, invoke };
}

export default async function createLcedaProModule({ moduleId, configPath }) {
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
        actions: await runtime.discover()
      };
    },
    async invoke(action, input) {
      return await runtime.invoke(action, input);
    }
  };
}
