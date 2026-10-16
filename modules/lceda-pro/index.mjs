import { readFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { parse } from "yaml";

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

export default async function createLcedaProModule({ moduleId, configPath }) {
  const config = await loadConfig(configPath);
  let client = null;
  let transport = null;
  let connecting = null;
  const upstreamByAction = new Map();
  let descriptor = null;

  async function closeClient() {
    const current = client;
    client = null;
    transport = null;
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
      const nextTransport = new StdioClientTransport({
        command: config.command,
        args: config.args
      });
      try {
        await nextClient.connect(nextTransport);
        client = nextClient;
        transport = nextTransport;
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
    const mcp = await ensureConnected();
    const listed = await mcp.listTools();
    upstreamByAction.clear();
    const used = new Set();
    const actions = [];

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

      actions.push({
        id: actionId,
        title: tool.title ?? `JLCEDA Pro: ${tool.name}`,
        description: `[Official lceda-pro MCP: ${tool.name}] ${tool.description ?? ""}`.trim(),
        inputJsonSchema: tool.inputSchema ?? { type: "object", properties: {} },
        annotations: tool.annotations,
        resultMode: "mcp"
      });
    }

    if (actions.length === 0) {
      throw new Error("lceda-pro MCP exposed no tools permitted by allow_tools");
    }

    descriptor = { id: moduleId, version: 1, actions };
    return descriptor;
  }

  async function callUpstream(action, input) {
    const upstreamName = upstreamByAction.get(action);
    if (!upstreamName) throw new Error(`Unknown proxied lceda-pro action: ${action}`);

    const invoke = async () => {
      const mcp = await ensureConnected();
      return await mcp.callTool({
        name: upstreamName,
        arguments: input ?? {}
      });
    };

    try {
      return await invoke();
    } catch (firstError) {
      await closeClient();
      try {
        return await invoke();
      } catch (secondError) {
        const first = firstError instanceof Error ? firstError.message : String(firstError);
        const second = secondError instanceof Error ? secondError.message : String(secondError);
        throw new Error(`lceda-pro MCP call failed after reconnect: first=${first}; retry=${second}`);
      }
    }
  }

  return {
    async describe() {
      return descriptor ?? await discover();
    },
    async invoke(action, input) {
      return await callUpstream(action, input);
    }
  };
}
