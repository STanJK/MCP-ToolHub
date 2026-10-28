import { invoke } from "@tauri-apps/api/core";

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

export const api = {
  dashboard: () => invoke<DashboardSnapshot>("dashboard_snapshot"),
  restartTunnel: () => invoke<TunnelSnapshot>("restart_tunnel"),
  logs: (afterSequence: number) =>
    invoke<LogEntry[]>("log_snapshot", { afterSequence }),
  clearLogs: () => invoke<void>("log_clear"),
  modules: () => invoke<ModuleSummary[]>("module_list"),
  moduleConfig: (moduleId: string) =>
    invoke<ModuleConfigView>("module_config", { moduleId }),
  saveModuleConfig: (moduleId: string, content: string) =>
    invoke<ModuleConfigView>("save_module_config", { moduleId, content }),
  probeModule: (moduleId: string) =>
    invoke<ModuleProbe>("probe_module", { moduleId }),
};
