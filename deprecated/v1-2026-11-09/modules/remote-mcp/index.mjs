import { readFile } from "node:fs/promises";
import process from "node:process";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { parse } from "yaml";

const runtimes = new Map();
const idPattern = /^[a-z0-9][a-z0-9-]*$/;
const forbiddenHeaderNames = new Set(["content-type", "mcp-session-id", "mcp-protocol-version"]);

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function validateId(kind, id) {
  if (typeof id !== "string" || !idPattern.test(id)) {
    throw new Error(`Invalid remote-mcp ${kind} id: ${id}`);
  }
}

function validateEnabled(scope, value) {
  if (value === false) return false;
  if (value !== undefined && value !== true) {
    throw new Error(`remote-mcp ${scope} enabled must be boolean`);
  }
  return true;
}

function parseHeaderConfig(scope, rawHeaders = {}) {
  if (!rawHeaders || typeof rawHeaders !== "object" || Array.isArray(rawHeaders)) {
    throw new Error(`remote-mcp ${scope} headers must be an object`);
  }
  for (const name of Object.keys(rawHeaders)) {
    if (forbiddenHeaderNames.has(name.toLowerCase())) {
      throw new Error(
        `remote-mcp ${scope} header ${name} is transport-managed and cannot be configured`
      );
    }
  }
  return rawHeaders;
}

function mergeHeaderConfig(providerId, profileId, providerHeaders, profileHeaders) {
  const merged = { ...providerHeaders };
  const inheritedNames = new Map(
    Object.keys(providerHeaders).map((name) => [name.toLowerCase(), name])
  );
  for (const [name, value] of Object.entries(profileHeaders)) {
    const inherited = inheritedNames.get(name.toLowerCase());
    if (inherited) {
      throw new Error(
        `remote-mcp profile ${providerId}/${profileId} header ${name} duplicates provider header ${inherited}`
      );
    }
    merged[name] = value;
  }
  return merged;
}

function resolveHeaderValue(scope, name, value) {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") {
    throw new Error(
      `remote-mcp ${scope} header ${name} must be a string or { env, prefix?, suffix? }`
    );
  }
  if (typeof value.env !== "string" || value.env.length === 0) {
    throw new Error(`remote-mcp ${scope} header ${name} env reference is missing env`);
  }

  const secret = process.env[value.env];
  if (typeof secret !== "string" || secret.length === 0) {
    throw new Error(
      `remote-mcp ${scope} header ${name} requires environment variable ${value.env}`
    );
  }

  const prefix = value.prefix ?? "";
  const suffix = value.suffix ?? "";
  if (typeof prefix !== "string" || typeof suffix !== "string") {
    throw new Error(`remote-mcp ${scope} header ${name} prefix/suffix must be strings`);
  }

  return `${prefix}${secret}${suffix}`;
}

function resolveHeaders(targetConfig) {
  const headers = {};
  for (const [name, value] of Object.entries(targetConfig.headerConfig)) {
    headers[name] = resolveHeaderValue(targetConfig.target, name, value);
  }
  return headers;
}

function parseToolPolicy(scope, profile, provider = {}) {
  const allowTools = profile.allow_tools ?? provider.allow_tools;
  if (
    !Array.isArray(allowTools) ||
    allowTools.length === 0 ||
    allowTools.some((x) => typeof x !== "string")
  ) {
    throw new Error(`remote-mcp ${scope} requires non-empty allow_tools`);
  }

  const denyTools = profile.deny_tools ?? provider.deny_tools ?? [];
  if (!Array.isArray(denyTools) || denyTools.some((x) => typeof x !== "string")) {
    throw new Error(`remote-mcp ${scope} deny_tools must be an array of strings`);
  }

  return { allowTools, denyTools };
}

function parseTargetConfig(providerId, profileId, rawProvider, rawProfile, legacyServerId = null) {
  validateId("provider", providerId);
  validateId("profile", profileId);
  const scope = `profile ${providerId}/${profileId}`;

  if (!rawProfile || typeof rawProfile !== "object" || Array.isArray(rawProfile)) {
    throw new Error(`remote-mcp ${scope} must be an object`);
  }
  if (!validateEnabled(scope, rawProfile.enabled)) return null;
  if (typeof rawProfile.url !== "string" || rawProfile.url.length === 0) {
    throw new Error(`remote-mcp ${scope} requires url`);
  }

  let url;
  try {
    url = new URL(rawProfile.url);
  } catch {
    throw new Error(`remote-mcp ${scope} url must be a valid absolute URL`);
  }

  const allowInsecure = rawProfile.allow_insecure_http ?? rawProvider.allow_insecure_http ?? false;
  if (typeof allowInsecure !== "boolean") {
    throw new Error(`remote-mcp ${scope} allow_insecure_http must be boolean`);
  }
  if (url.protocol !== "https:" && allowInsecure !== true) {
    throw new Error(`remote-mcp ${scope} requires https unless allow_insecure_http: true is explicitly set`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`remote-mcp ${scope} url must use http or https`);
  }

  const providerHeaders = parseHeaderConfig(`provider ${providerId}`, rawProvider.headers ?? {});
  const profileHeaders = parseHeaderConfig(scope, rawProfile.headers ?? {});
  const headerConfig = mergeHeaderConfig(providerId, profileId, providerHeaders, profileHeaders);
  const { allowTools, denyTools } = parseToolPolicy(scope, rawProfile, rawProvider);
  const target = `${providerId}/${profileId}`;

  return {
    providerId,
    profileId,
    target,
    legacyServerId,
    url,
    headerConfig,
    allowTools,
    denyTools,
    source: {
      provider: providerId,
      profile: profileId,
      target,
      legacyServerId,
      url: rawProfile.url,
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

  const targets = [];
  if (config.providers !== undefined) {
    if (!config.providers || typeof config.providers !== "object" || Array.isArray(config.providers)) {
      throw new Error("remote-mcp config providers must be an object");
    }

    for (const [providerId, rawProvider] of Object.entries(config.providers)) {
      validateId("provider", providerId);
      if (!rawProvider || typeof rawProvider !== "object" || Array.isArray(rawProvider)) {
        throw new Error(`remote-mcp provider ${providerId} must be an object`);
      }
      if (!validateEnabled(`provider ${providerId}`, rawProvider.enabled)) continue;
      parseHeaderConfig(`provider ${providerId}`, rawProvider.headers ?? {});

      if (!rawProvider.profiles || typeof rawProvider.profiles !== "object" || Array.isArray(rawProvider.profiles)) {
        throw new Error(`remote-mcp provider ${providerId} requires profiles object`);
      }

      for (const [profileId, rawProfile] of Object.entries(rawProvider.profiles)) {
        const parsed = parseTargetConfig(providerId, profileId, rawProvider, rawProfile);
        if (parsed) targets.push(parsed);
      }
    }
  }

  // Compatibility bridge for pre-provider local configs. Existing server IDs remain
  // callable through the deprecated server selector and also appear as legacy/<id>.
  if (config.servers !== undefined) {
    if (!config.servers || typeof config.servers !== "object" || Array.isArray(config.servers)) {
      throw new Error("remote-mcp config servers must be an object");
    }
    for (const [serverId, rawServer] of Object.entries(config.servers)) {
      validateId("server", serverId);
      if (!rawServer || typeof rawServer !== "object" || Array.isArray(rawServer)) {
        throw new Error(`remote-mcp server ${serverId} must be an object`);
      }
      if (rawServer.enabled === false) continue;
      const parsed = parseTargetConfig("legacy", serverId, {}, rawServer, serverId);
      if (parsed) targets.push(parsed);
    }
  }

  if (targets.length === 0) {
    throw new Error("remote-mcp config has no enabled provider profiles or legacy servers");
  }

  const seenTargets = new Set();
  const seenLegacyServers = new Set();
  for (const target of targets) {
    if (seenTargets.has(target.target)) {
      throw new Error(`duplicate remote-mcp target: ${target.target}`);
    }
    seenTargets.add(target.target);
    if (target.legacyServerId) {
      if (seenLegacyServers.has(target.legacyServerId)) {
        throw new Error(`duplicate remote-mcp legacy server: ${target.legacyServerId}`);
      }
      seenLegacyServers.add(target.legacyServerId);
    }
  }

  return { targets };
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
        name: `mcp-toolhub-remote-${config.providerId}-${config.profileId}`,
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
      throw new Error(`remote-mcp target ${config.target} exposed no tools permitted by allow_tools`);
    }

    return catalog;
  }

  function identity() {
    return {
      provider: config.providerId,
      profile: config.profileId,
      target: config.target,
      ...(config.legacyServerId ? { server: config.legacyServerId } : {})
    };
  }

  async function status({ refresh = false } = {}) {
    try {
      const tools = await getCatalog({ refresh });
      return {
        ok: true,
        status: "ready",
        ...identity(),
        allowed_tools: tools.length
      };
    } catch (error) {
      await closeClient();
      return {
        ok: true,
        status: "offline",
        ...identity(),
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
          ? { inputSchema: tool.inputSchema, annotations: tool.annotations }
          : {})
      }));

    return {
      ok: true,
      status: "ready",
      ...identity(),
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
      throw new Error(`remote-mcp target ${config.target} tool is unavailable or not permitted: ${name}`);
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
          throw new Error(`remote-mcp target ${config.target} tool disappeared after reconnect: ${name}`);
        }
        return await invoke();
      } catch (secondError) {
        throw new Error(
          `remote-mcp target ${config.target} call failed after reconnect: first=${errorMessage(firstError)}; retry=${errorMessage(secondError)}`
        );
      }
    }
  }

  return { status, discover, call };
}

const selectorProperties = {
  provider: {
    type: "string",
    minLength: 1,
    description: "Configured remote-mcp provider ID, for example cloudbase."
  },
  profile: {
    type: "string",
    minLength: 1,
    description: "Profile ID within the selected provider, for example sleep-record or edu-pulse-dev."
  },
  server: {
    type: "string",
    minLength: 1,
    description: "Deprecated legacy server selector for pre-provider configs."
  }
};

const STATIC_ACTIONS = [
  {
    id: "status",
    title: "Remote MCP provider/profile status",
    description: "Check one provider/profile, all profiles under a provider, or every enabled remote MCP profile when no selector is supplied.",
    inputJsonSchema: {
      type: "object",
      properties: {
        ...selectorProperties,
        refresh: {
          type: "boolean",
          default: false,
          description: "Reconnect and refresh selected profile catalogs before reporting status."
        }
      },
      additionalProperties: false
    }
  },
  {
    id: "discover",
    title: "Discover remote MCP tools",
    description: "Discover permitted tools from one configured provider/profile. Prefer provider+profile; server is accepted only for legacy configs.",
    inputJsonSchema: {
      type: "object",
      anyOf: [
        { required: ["provider", "profile"] },
        { required: ["server"] }
      ],
      properties: {
        ...selectorProperties,
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
          description: "Reconnect and refresh the selected profile catalog before discovery."
        },
        limit: { type: "integer", minimum: 1, maximum: 200, default: 64 }
      },
      additionalProperties: false
    }
  },
  {
    id: "call",
    title: "Call a remote MCP tool",
    description: "Call one permitted tool on one configured provider/profile. Provider/profile selection fixes URL, authentication, and environment routing locally.",
    inputJsonSchema: {
      type: "object",
      anyOf: [
        { required: ["provider", "profile", "tool"] },
        { required: ["server", "tool"] }
      ],
      properties: {
        ...selectorProperties,
        tool: {
          type: "string",
          minLength: 1,
          description: "Exact upstream tool name returned by remote_mcp_discover."
        },
        arguments: {
          type: "object",
          default: {},
          additionalProperties: true,
          description: "Arguments for the selected upstream tool. Environment selection is not supplied here."
        }
      },
      additionalProperties: false
    },
    resultMode: "mcp"
  }
];

export default async function createRemoteMcpModule({ moduleId, configPath }) {
  const config = await loadConfig(configPath);
  const runtimeByTarget = new Map();
  const runtimeByLegacyServer = new Map();

  for (const targetConfig of config.targets) {
    const key = runtimeKey(configPath, targetConfig);
    let runtime = runtimes.get(key);
    if (!runtime) {
      runtime = createRuntime(targetConfig);
      runtimes.set(key, runtime);
    }
    runtimeByTarget.set(targetConfig.target, runtime);
    if (targetConfig.legacyServerId) {
      runtimeByLegacyServer.set(targetConfig.legacyServerId, runtime);
    }
  }

  function selectRuntime(input, { requireProfile = true } = {}) {
    const legacyServer = input?.server;
    if (legacyServer !== undefined) {
      if (input?.provider !== undefined || input?.profile !== undefined) {
        throw new Error("remote-mcp selector must use provider/profile or legacy server, not both");
      }
      const runtime = runtimeByLegacyServer.get(legacyServer);
      if (!runtime) throw new Error(`Unknown or disabled remote-mcp legacy server: ${legacyServer}`);
      return runtime;
    }

    const provider = input?.provider;
    const profile = input?.profile;
    if (provider === undefined && profile === undefined && !requireProfile) return null;
    if (typeof provider !== "string" || provider.length === 0) {
      throw new Error("remote-mcp selector requires provider");
    }
    if (typeof profile !== "string" || profile.length === 0) {
      if (!requireProfile) return null;
      throw new Error("remote-mcp selector requires profile");
    }

    const runtime = runtimeByTarget.get(`${provider}/${profile}`);
    if (!runtime) throw new Error(`Unknown or disabled remote-mcp profile: ${provider}/${profile}`);
    return runtime;
  }

  async function status(input = {}) {
    if (input.server !== undefined || input.profile !== undefined) {
      return await selectRuntime(input).status({ refresh: input.refresh === true });
    }

    const providerFilter = input.provider;
    if (providerFilter !== undefined && (typeof providerFilter !== "string" || providerFilter.length === 0)) {
      throw new Error("remote-mcp status provider must be a non-empty string");
    }

    const grouped = new Map();
    for (const targetConfig of config.targets) {
      if (providerFilter !== undefined && targetConfig.providerId !== providerFilter) continue;
      const runtime = runtimeByTarget.get(targetConfig.target);
      const result = await runtime.status({ refresh: input.refresh === true });
      if (!grouped.has(targetConfig.providerId)) grouped.set(targetConfig.providerId, []);
      grouped.get(targetConfig.providerId).push(result);
    }

    if (providerFilter !== undefined && grouped.size === 0) {
      throw new Error(`Unknown or disabled remote-mcp provider: ${providerFilter}`);
    }

    const providers = [...grouped.entries()].map(([provider, profiles]) => ({
      provider,
      status: profiles.every((item) => item.status === "ready") ? "ready" : "degraded",
      profiles
    }));
    const allProfiles = providers.flatMap((provider) => provider.profiles);
    return {
      ok: true,
      status: allProfiles.every((item) => item.status === "ready") ? "ready" : "degraded",
      providers
    };
  }

  return {
    async describe() {
      return { id: moduleId, version: 1, actions: STATIC_ACTIONS };
    },

    async invoke(action, input) {
      if (action === "status") return await status(input ?? {});
      if (action === "discover") return await selectRuntime(input ?? {}).discover(input ?? {});
      if (action === "call") return await selectRuntime(input ?? {}).call(input ?? {});
      throw new Error(`Unknown remote-mcp facade action: ${action}`);
    }
  };
}
