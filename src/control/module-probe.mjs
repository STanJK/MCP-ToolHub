import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import process from "node:process";

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { parse } from "yaml";

import { loadToolHubConfig } from "../core/config.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const moduleId = process.argv[2];

function fail(message, detail = null) {
  return { ok: false, moduleId: moduleId ?? "", status: "error", message, tools: [], detail };
}

function toolView(tool, prefix = "") {
  return {
    name: prefix ? `${prefix}/${tool.name}` : tool.name,
    title: tool.title ?? null,
    description: String(tool.description ?? "").slice(0, 320) || null
  };
}

function allowed(name, allowTools, denyTools) {
  if (denyTools.includes(name)) return false;
  return allowTools.includes("*") || allowTools.includes(name);
}

function idaHardDenied(name) {
  const normalized = String(name).toLowerCase();
  if (normalized === "py_eval" || normalized === "py_exec_file") return true;
  return /(^|[_-])(?:py|python)(?:[_-]|$)/i.test(normalized);
}

async function withTimeout(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function listStdio(command, args, allowTools, denyTools, hardDeny = () => false) {
  const client = new Client({ name: "mcp-toolhub-gui-probe", version: "0.1.0" });
  const transport = new StdioClientTransport({ command, args });
  try {
    await withTimeout(client.connect(transport), 8000, "MCP connect");
    const listed = await withTimeout(client.listTools(), 8000, "tools/list");
    return (listed.tools ?? [])
      .filter((tool) => !hardDeny(tool.name))
      .filter((tool) => allowed(tool.name, allowTools, denyTools));
  } finally {
    try { await withTimeout(client.close(), 1500, "MCP close"); } catch {}
  }
}

async function listHttp(url, headers, allowTools, denyTools) {
  const client = new Client({ name: "mcp-toolhub-gui-probe", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers },
    redirectPolicy: "same-origin"
  });
  try {
    await withTimeout(client.connect(transport), 8000, "MCP connect");
    const listed = await withTimeout(client.listTools(), 8000, "tools/list");
    return (listed.tools ?? []).filter((tool) => allowed(tool.name, allowTools, denyTools));
  } finally {
    try { await withTimeout(client.close(), 1500, "MCP close"); } catch {}
  }
}

function resolveHeaderValue(serverId, name, value) {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object" || typeof value.env !== "string") {
    throw new Error(`remote-mcp server ${serverId} header ${name} has invalid env reference`);
  }
  const secret = process.env[value.env];
  if (!secret) {
    throw new Error(`remote-mcp server ${serverId} header ${name} requires ${value.env}`);
  }
  return `${value.prefix ?? ""}${secret}${value.suffix ?? ""}`;
}

async function probeLocalBuild(configPath) {
  const imported = await import(pathToFileURL(path.join(repoRoot, "modules", "local-build", "index.mjs")).href);
  const instance = await imported.default({ moduleId: "local-build", configPath });
  const descriptor = await instance.describe();
  return {
    ok: true,
    moduleId,
    status: "ready",
    message: "Local Build module loaded. Project/operation YAML is read on invocation.",
    tools: descriptor.actions.map((action) => ({
      name: action.id,
      title: action.title ?? null,
      description: action.description ?? null
    })),
    detail: { actions: descriptor.actions.length }
  };
}

async function probeLceda(configPath) {
  const cfg = parse(await readFile(configPath, "utf8"));
  const tools = await listStdio(
    cfg.command,
    cfg.args ?? ["--mcp", "stdio"],
    cfg.allow_tools ?? [],
    cfg.deny_tools ?? []
  );
  return {
    ok: true,
    moduleId,
    status: "ready",
    message: `JLCEDA backend reachable; ${tools.length} permitted upstream tools.`,
    tools: tools.map((tool) => toolView(tool)),
    detail: { backend: "lceda-pro", allowedTools: tools.length }
  };
}

async function probeIda(configPath) {
  const cfg = parse(await readFile(configPath, "utf8"));
  const tools = await listStdio(
    cfg.command,
    cfg.args ?? ["--transport", "stdio"],
    cfg.allow_tools ?? [],
    cfg.deny_tools ?? [],
    idaHardDenied
  );
  return {
    ok: true,
    moduleId,
    status: "ready",
    message: `IDA backend reachable; ${tools.length} permitted upstream tools.`,
    tools: tools.map((tool) => toolView(tool)),
    detail: { backend: "ida-pro-mcp", allowedTools: tools.length, hardDeniedPythonExecution: true }
  };
}

async function probeJadx(configPath) {
  const cfg = parse(await readFile(configPath, "utf8"));
  const url = new URL(cfg.url);
  if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname)) {
    throw new Error("jadx-mcp GUI probe refuses non-loopback endpoints");
  }
  const tools = await listHttp(cfg.url, {}, cfg.allow_tools ?? [], cfg.deny_tools ?? []);
  return {
    ok: true,
    moduleId,
    status: "ready",
    message: `JADX backend reachable at ${cfg.url}; ${tools.length} permitted tools.`,
    tools: tools.map((tool) => toolView(tool)),
    detail: { backend: "jadx-mcp", endpoint: cfg.url, allowedTools: tools.length }
  };
}

async function probeRemote(configPath) {
  const cfg = parse(await readFile(configPath, "utf8"));
  const targets = [];

  if (cfg.providers && typeof cfg.providers === "object" && !Array.isArray(cfg.providers)) {
    for (const [providerId, provider] of Object.entries(cfg.providers)) {
      if (provider?.enabled === false) continue;
      for (const [profileId, profile] of Object.entries(provider?.profiles ?? {})) {
        if (profile?.enabled === false) {
          targets.push({
            provider: providerId,
            profile: profileId,
            id: `${providerId}/${profileId}`,
            status: "disabled",
            toolCount: 0
          });
          continue;
        }

        targets.push({
          provider: providerId,
          profile: profileId,
          id: `${providerId}/${profileId}`,
          url: profile?.url,
          headers: { ...(provider?.headers ?? {}), ...(profile?.headers ?? {}) },
          allowTools: profile?.allow_tools ?? provider?.allow_tools ?? [],
          denyTools: profile?.deny_tools ?? provider?.deny_tools ?? []
        });
      }
    }
  }

  // Backward-compatible view for pre-provider local configs.
  if (cfg.servers && typeof cfg.servers === "object" && !Array.isArray(cfg.servers)) {
    for (const [serverId, server] of Object.entries(cfg.servers)) {
      if (server?.enabled === false) {
        targets.push({
          provider: "legacy",
          profile: serverId,
          id: `legacy/${serverId}`,
          legacyServer: serverId,
          status: "disabled",
          toolCount: 0
        });
        continue;
      }
      targets.push({
        provider: "legacy",
        profile: serverId,
        id: `legacy/${serverId}`,
        legacyServer: serverId,
        url: server?.url,
        headers: server?.headers ?? {},
        allowTools: server?.allow_tools ?? [],
        denyTools: server?.deny_tools ?? []
      });
    }
  }

  const profiles = [];
  const allTools = [];

  for (const target of targets) {
    if (target.status === "disabled") {
      profiles.push(target);
      continue;
    }

    try {
      const headers = {};
      for (const [name, value] of Object.entries(target.headers ?? {})) {
        headers[name] = resolveHeaderValue(target.id, name, value);
      }
      const tools = await listHttp(
        target.url,
        headers,
        target.allowTools,
        target.denyTools
      );
      profiles.push({
        provider: target.provider,
        profile: target.profile,
        id: target.id,
        ...(target.legacyServer ? { legacyServer: target.legacyServer } : {}),
        status: "ready",
        toolCount: tools.length
      });
      allTools.push(...tools.map((tool) => toolView(tool, target.id)));
    } catch (error) {
      profiles.push({
        provider: target.provider,
        profile: target.profile,
        id: target.id,
        ...(target.legacyServer ? { legacyServer: target.legacyServer } : {}),
        status: "offline",
        toolCount: 0,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  const enabled = profiles.filter((profile) => profile.status !== "disabled");
  const ready = enabled.filter((profile) => profile.status === "ready").length;
  const status = enabled.length === 0
    ? "offline"
    : ready === enabled.length
      ? "ready"
      : ready > 0
        ? "degraded"
        : "offline";

  const providers = [...new Set(profiles.map((profile) => profile.provider))].map((provider) => ({
    provider,
    profiles: profiles.filter((profile) => profile.provider === provider)
  }));

  return {
    ok: status !== "offline",
    moduleId,
    status,
    message: `Remote MCP: ${ready}/${enabled.length} enabled profiles reachable.`,
    tools: allTools,
    detail: { providers }
  };
}

async function probeChromeMcp(configPath) {
  const imported = await import(
    pathToFileURL(path.join(repoRoot, "modules", "chrome-mcp", "index.mjs")).href
  );
  const instance = await imported.default({ moduleId: "chrome-mcp", configPath });
  const descriptor = await instance.describe();
  const snapshot = await instance.invoke("status", {});
  return {
    ok: true,
    moduleId,
    status: snapshot.status === "ready" ? "ready" : "stopped",
    message: "Chrome MCP module loaded. Browser projects are started only on explicit start/discover/call.",
    tools: descriptor.actions.map((action) => ({
      name: action.id,
      title: action.title ?? null,
      description: action.description ?? null
    })),
    detail: snapshot
  };
}

async function probeGeneric(configPath) {
  const imported = await import(pathToFileURL(path.join(repoRoot, "modules", moduleId, "index.mjs")).href);
  const instance = await imported.default({ moduleId, configPath });
  const descriptor = await instance.describe();
  return {
    ok: true,
    moduleId,
    status: "ready",
    message: `Module descriptor loaded; ${descriptor.actions.length} connector-visible actions.`,
    tools: descriptor.actions.map((action) => ({
      name: action.id,
      title: action.title ?? null,
      description: action.description ?? null
    })),
    detail: { actions: descriptor.actions.length }
  };
}

async function main() {
  if (!moduleId) return fail("Usage: node src/control/module-probe.mjs <module-id>");
  const config = await loadToolHubConfig();
  const registration = config.modules[moduleId];
  if (!registration) return fail(`Unknown ToolHub module: ${moduleId}`);
  if (!registration.enabled) {
    return {
      ok: true,
      moduleId,
      status: "disabled",
      message: "Module is disabled in toolhub.local.yaml.",
      tools: [],
      detail: null
    };
  }

  const configPath = path.resolve(config.__meta.configDir, registration.config);
  switch (moduleId) {
    case "local-build": return await probeLocalBuild(configPath);
    case "lceda-pro": return await probeLceda(configPath);
    case "ida-pro": return await probeIda(configPath);
    case "jadx-mcp": return await probeJadx(configPath);
    case "remote-mcp": return await probeRemote(configPath);
    case "chrome-mcp": return await probeChromeMcp(configPath);
    default: return await probeGeneric(configPath);
  }
}

let result;
try {
  result = await main();
} catch (error) {
  result = fail(
    error instanceof Error ? error.message : String(error),
    { stack: error instanceof Error ? error.stack ?? null : null }
  );
}
process.stdout.write(JSON.stringify(result));
