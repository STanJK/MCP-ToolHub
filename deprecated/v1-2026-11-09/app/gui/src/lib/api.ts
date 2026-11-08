export type TunnelSnapshot = {
  phase: string;
  connection: string;
  pid: number | null;
  startedAtMs: number | null;
  lastExitCode: number | null;
  lastError: string | null;
};

export type DashboardSnapshot = {
  overallStatus: string;
  version: string;
  configPath: string;
  tunnelName: string | null;
  tunnelId: string | null;
  moduleCount: number;
  enabledModuleCount: number;
  tunnel: TunnelSnapshot;
};

export type LogEntry = {
  sequence: number;
  timestampMs: number;
  level: string;
  target: string;
  message: string;
};

export type ModuleSummary = {
  id: string;
  enabled: boolean;
  configPath: string | null;
  configExists: boolean;
};

export type ModuleConfigView = {
  moduleId: string;
  path: string;
  content: string;
};

export type ToolView = {
  name: string;
  title?: string | null;
  description?: string | null;
};

export type ModuleProbe = {
  ok: boolean;
  moduleId: string;
  status: string;
  message: string;
  tools: ToolView[];
  detail: unknown;
};

function isTauriHost() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

async function tauriInvoke<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(command, args);
}

async function ccRequest<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch("/api/modules/toolhub" + path, {
    ...init,
    headers: {
      accept: "application/json",
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...(init?.headers ?? {}),
    },
  });

  const text = await response.text();
  let payload: unknown = null;

  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }

  if (!response.ok) {
    const message =
      typeof payload === "object" &&
      payload !== null &&
      "error" in payload
        ? String((payload as { error: unknown }).error)
        : String(response.status) + " " + response.statusText;
    throw new Error(message);
  }

  return payload as T;
}

async function call<T>(
  tauriCommand: string,
  ccPath: string,
  tauriArgs?: Record<string, unknown>,
  ccInit?: RequestInit,
): Promise<T> {
  return isTauriHost()
    ? tauriInvoke<T>(tauriCommand, tauriArgs)
    : ccRequest<T>(ccPath, ccInit);
}

export const api = {
  dashboard: () =>
    call<DashboardSnapshot>("dashboard_snapshot", "/dashboard"),

  restartTunnel: () =>
    call<TunnelSnapshot>(
      "restart_tunnel",
      "/tunnel/restart",
      undefined,
      { method: "POST" },
    ),

  logs: (afterSequence: number) =>
    call<LogEntry[]>(
      "log_snapshot",
      "/logs?afterSequence=" + encodeURIComponent(afterSequence),
      { afterSequence },
    ),

  clearLogs: () =>
    call<void>(
      "log_clear",
      "/logs/clear",
      undefined,
      { method: "POST" },
    ),

  modules: () =>
    call<ModuleSummary[]>("module_list", "/modules"),

  moduleConfig: (moduleId: string) =>
    call<ModuleConfigView>(
      "module_config",
      "/modules/" + encodeURIComponent(moduleId) + "/config",
      { moduleId },
    ),

  saveModuleConfig: (moduleId: string, content: string) =>
    call<ModuleConfigView>(
      "save_module_config",
      "/modules/" + encodeURIComponent(moduleId) + "/config",
      { moduleId, content },
      {
        method: "PUT",
        body: JSON.stringify({ content }),
      },
    ),

  probeModule: (moduleId: string) =>
    call<ModuleProbe>(
      "probe_module",
      "/modules/" + encodeURIComponent(moduleId) + "/probe",
      { moduleId },
      { method: "POST" },
    ),
};
