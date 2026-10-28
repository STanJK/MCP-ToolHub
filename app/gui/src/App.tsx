import {
  Activity,
  Cable,
  CircleDot,
  FileCode2,
  Logs,
  RefreshCw,
  RotateCcw,
  Save,
  ServerCog,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  type DashboardSnapshot,
  type LogEntry,
  type ModuleConfigView,
  type ModuleProbe,
  type ModuleSummary,
} from "./lib/api";

type Tone = "neutral" | "info" | "success" | "warning" | "danger";

function toneFor(status?: string | null): Tone {
  const value = (status ?? "").toLowerCase();
  if (["ready", "running", "connected", "completed"].includes(value)) return "success";
  if (["starting", "checking", "observing", "external"].includes(value)) return "info";
  if (["degraded", "offline", "external", "unknown"].includes(value)) return "warning";
  if (["error", "failed", "faulted", "blocked"].includes(value)) return "danger";
  return "neutral";
}

function StatusPill({ status }: { status?: string | null }) {
  const tone = toneFor(status);
  const classes: Record<Tone, string> = {
    neutral: "border-slate-700 bg-slate-800/70 text-slate-300",
    info: "border-sky-500/40 bg-sky-500/10 text-sky-300",
    success: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
    warning: "border-amber-500/40 bg-amber-500/10 text-amber-300",
    danger: "border-rose-500/40 bg-rose-500/10 text-rose-300",
  };
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ${classes[tone]}`}>
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {status ?? "unknown"}
    </span>
  );
}

function Pane({
  title,
  icon,
  actions,
  children,
}: {
  title: string;
  icon?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="flex min-h-0 flex-col border border-slate-800 bg-[#0d1117]">
      <header className="flex h-11 shrink-0 items-center justify-between border-b border-slate-800 px-3">
        <div className="flex min-w-0 items-center gap-2 text-sm font-semibold text-slate-200">
          {icon}
          <span className="truncate">{title}</span>
        </div>
        <div className="flex items-center gap-2">{actions}</div>
      </header>
      <div className="min-h-0 flex-1">{children}</div>
    </section>
  );
}

function SmallButton({
  children,
  onClick,
  disabled,
  title,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className="inline-flex h-8 items-center gap-1.5 rounded-md border border-slate-700 bg-slate-900 px-2.5 text-xs font-medium text-slate-200 transition hover:border-slate-600 hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
    >
      {children}
    </button>
  );
}

function StatCard({
  label,
  value,
  subtext,
  icon,
}: {
  label: string;
  value: string;
  subtext?: string;
  icon: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-1 items-center gap-3 rounded-lg border border-slate-800 bg-slate-950/55 p-3">
      <div className="grid h-9 w-9 shrink-0 place-items-center rounded-md border border-slate-800 bg-slate-900 text-slate-400">
        {icon}
      </div>
      <div className="min-w-0">
        <div className="text-[11px] uppercase tracking-[0.14em] text-slate-500">{label}</div>
        <div className="mt-1 flex items-center gap-2">
          <StatusPill status={value} />
          {subtext && <span className="truncate text-xs text-slate-500">{subtext}</span>}
        </div>
      </div>
    </div>
  );
}

function formatTime(timestampMs: number) {
  return new Date(timestampMs).toLocaleTimeString([], {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function App() {
  const [dashboard, setDashboard] = useState<DashboardSnapshot | null>(null);
  const [modules, setModules] = useState<ModuleSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [configView, setConfigView] = useState<ModuleConfigView | null>(null);
  const [configDraft, setConfigDraft] = useState("");
  const [configDirty, setConfigDirty] = useState(false);
  const [probe, setProbe] = useState<ModuleProbe | null>(null);
  const [probeBusy, setProbeBusy] = useState(false);
  const [tunnelBusy, setTunnelBusy] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const lastSequence = useRef(0);
  const logRef = useRef<HTMLDivElement>(null);

  const refreshDashboard = useCallback(async () => {
    try {
      setDashboard(await api.dashboard());
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  const refreshModules = useCallback(async () => {
    try {
      const next = await api.modules();
      setModules(next);
      setSelectedId((current) => current ?? next.find((m) => m.enabled)?.id ?? next[0]?.id ?? null);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  const loadConfig = useCallback(async (moduleId: string) => {
    try {
      const next = await api.moduleConfig(moduleId);
      setConfigView(next);
      setConfigDraft(next.content);
      setConfigDirty(false);
      setError(null);
    } catch (e) {
      setConfigView(null);
      setConfigDraft("");
      setConfigDirty(false);
      setError(String(e));
    }
  }, []);

  const refreshProbe = useCallback(async (moduleId: string) => {
    setProbeBusy(true);
    try {
      const next = await api.probeModule(moduleId);
      setProbe(next);
      setError(null);
    } catch (e) {
      setProbe({
        ok: false,
        moduleId,
        status: "error",
        message: String(e),
        tools: [],
        detail: null,
      });
    } finally {
      setProbeBusy(false);
    }
  }, []);

  useEffect(() => {
    void refreshDashboard();
    void refreshModules();
    const timer = window.setInterval(() => void refreshDashboard(), 1000);
    return () => window.clearInterval(timer);
  }, [refreshDashboard, refreshModules]);

  useEffect(() => {
    if (!selectedId) return;
    setProbe(null);
    void loadConfig(selectedId);
    void refreshProbe(selectedId);
  }, [selectedId, loadConfig, refreshProbe]);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const next = await api.logs(lastSequence.current);
        if (cancelled || next.length === 0) return;
        lastSequence.current = next.at(-1)?.sequence ?? lastSequence.current;
        setLogs((previous) => [...previous, ...next].slice(-2000));
      } catch {}
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 350);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: "auto" });
  }, [logs]);

  const selected = useMemo(
    () => modules.find((module) => module.id === selectedId) ?? null,
    [modules, selectedId],
  );

  const restartTunnel = async () => {
    setTunnelBusy(true);
    try {
      await api.restartTunnel();
      await refreshDashboard();
    } catch (e) {
      setError(String(e));
    } finally {
      setTunnelBusy(false);
    }
  };

  const saveConfig = async () => {
    if (!selectedId) return;
    try {
      const next = await api.saveModuleConfig(selectedId, configDraft);
      setConfigView(next);
      setConfigDraft(next.content);
      setConfigDirty(false);
      await refreshProbe(selectedId);
    } catch (e) {
      setError(String(e));
    }
  };

  const clearLogs = async () => {
    setLogs([]);
    lastSequence.current = 0;
    try {
      await api.clearLogs();
    } catch (e) {
      setError(String(e));
    }
  };

  const tunnelPhase = dashboard?.tunnel.phase ?? "unknown";
  const restartLabel = tunnelPhase === "running" ? "Restart tunnel" : "Start tunnel";

  return (
    <main className="h-screen w-screen overflow-hidden bg-[#090c11] text-slate-200">
      <div className="grid h-full grid-rows-[25%_75%] gap-2 p-2">
        <div className="grid min-h-0 grid-cols-2 gap-2">
          <Pane
            title="ToolHub Control"
            icon={<ServerCog size={16} />}
            actions={
              <SmallButton onClick={() => void restartTunnel()} disabled={tunnelBusy}>
                <RotateCcw size={13} className={tunnelBusy ? "animate-spin" : ""} />
                {restartLabel}
              </SmallButton>
            }
          >
            <div className="flex h-full flex-col gap-3 p-3">
              <div className="flex min-h-0 flex-1 gap-3">
                <StatCard
                  label="Overall"
                  value={dashboard?.overallStatus ?? "unknown"}
                  subtext={dashboard ? `${dashboard.enabledModuleCount}/${dashboard.moduleCount} modules enabled` : undefined}
                  icon={<Activity size={17} />}
                />
                <StatCard
                  label="Tunnel"
                  value={tunnelPhase}
                  subtext={dashboard?.tunnel.pid ? `PID ${dashboard.tunnel.pid}` : dashboard?.tunnelName ?? undefined}
                  icon={<CircleDot size={17} />}
                />
                <StatCard
                  label="Connection"
                  value={dashboard?.tunnel.connection ?? "unknown"}
                  subtext={dashboard?.tunnelId ?? undefined}
                  icon={<Cable size={17} />}
                />
              </div>
              <div className="flex shrink-0 items-center justify-between border-t border-slate-800 pt-2 text-[11px] text-slate-500">
                <span className="truncate">{dashboard?.configPath ?? "Loading configuration..."}</span>
                <span>MCP-ToolHub GUI {dashboard?.version ?? "0.1.0"}</span>
              </div>
              {error && (
                <div className="shrink-0 truncate rounded-md border border-rose-500/30 bg-rose-500/10 px-2 py-1 text-xs text-rose-300">
                  {error}
                </div>
              )}
            </div>
          </Pane>

          <Pane
            title="Live Log"
            icon={<Logs size={16} />}
            actions={<SmallButton onClick={() => void clearLogs()}>Clear</SmallButton>}
          >
            <div ref={logRef} className="h-full overflow-auto bg-[#080b10] p-2 font-mono text-[11px] leading-5">
              {logs.length === 0 && <div className="text-slate-600">No ToolHub GUI logs yet.</div>}
              {logs.map((entry) => (
                <div key={entry.sequence} className="grid grid-cols-[64px_48px_120px_1fr] gap-2 border-b border-slate-900/70 py-0.5">
                  <span className="text-slate-600">{formatTime(entry.timestampMs)}</span>
                  <span className={
                    entry.level === "ERROR" ? "text-rose-400" :
                    entry.level === "WARN" ? "text-amber-400" :
                    entry.level === "DEBUG" ? "text-sky-400" :
                    "text-emerald-400"
                  }>{entry.level}</span>
                  <span className="truncate text-slate-500">{entry.target.split("::").at(-1)}</span>
                  <span className="whitespace-pre-wrap break-all text-slate-300">{entry.message}</span>
                </div>
              ))}
            </div>
          </Pane>
        </div>

        <div className="grid min-h-0 grid-cols-3 gap-2">
          <Pane
            title="Modules"
            icon={<ServerCog size={16} />}
            actions={
              <SmallButton onClick={() => void refreshModules()}>
                <RefreshCw size={13} />
                Reload
              </SmallButton>
            }
          >
            <div className="h-full overflow-auto p-2">
              <div className="space-y-1">
                {modules.map((module) => (
                  <button
                    type="button"
                    key={module.id}
                    onClick={() => setSelectedId(module.id)}
                    className={`w-full rounded-md border px-3 py-2.5 text-left transition ${
                      module.id === selectedId
                        ? "border-sky-500/50 bg-sky-500/10"
                        : "border-slate-800 bg-slate-950/40 hover:bg-slate-900"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono text-sm text-slate-200">{module.id}</span>
                      <StatusPill status={module.enabled ? "ready" : "disabled"} />
                    </div>
                    <div className="mt-1.5 truncate text-xs text-slate-500">
                      {module.configPath ?? "No config path"}
                    </div>
                    {!module.configExists && module.enabled && (
                      <div className="mt-1 text-xs text-rose-400">Config file missing</div>
                    )}
                  </button>
                ))}
              </div>
            </div>
          </Pane>

          <Pane
            title={selected ? `${selected.id} · Config` : "Module Config"}
            icon={<FileCode2 size={16} />}
            actions={
              <>
                <SmallButton onClick={() => selectedId && void loadConfig(selectedId)} disabled={!selectedId}>
                  <RefreshCw size={13} />
                  Reload
                </SmallButton>
                <SmallButton onClick={() => void saveConfig()} disabled={!selectedId || !configDirty}>
                  <Save size={13} />
                  Save
                </SmallButton>
              </>
            }
          >
            <div className="flex h-full min-h-0 flex-col">
              <div className="shrink-0 border-b border-slate-800 px-3 py-2 font-mono text-[11px] text-slate-500">
                {configView?.path ?? "Select a module"}
              </div>
              <textarea
                value={configDraft}
                disabled={!configView}
                spellCheck={false}
                onChange={(event) => {
                  setConfigDraft(event.target.value);
                  setConfigDirty(event.target.value !== configView?.content);
                }}
                className="min-h-0 flex-1 resize-none border-0 bg-[#080b10] p-3 font-mono text-xs leading-5 text-slate-300 outline-none disabled:text-slate-700"
                placeholder="Select a module to inspect its local YAML."
              />
              <div className="flex h-8 shrink-0 items-center justify-between border-t border-slate-800 px-3 text-[11px] text-slate-500">
                <span>{configDirty ? "Modified" : "Saved"}</span>
                <span>{configDraft.length} chars</span>
              </div>
            </div>
          </Pane>

          <Pane
            title={selected ? `${selected.id} · Runtime` : "Module Runtime"}
            icon={<Activity size={16} />}
            actions={
              <SmallButton
                onClick={() => selectedId && void refreshProbe(selectedId)}
                disabled={!selectedId || probeBusy}
              >
                <RefreshCw size={13} className={probeBusy ? "animate-spin" : ""} />
                Retry / Refresh
              </SmallButton>
            }
          >
            <div className="flex h-full min-h-0 flex-col">
              <div className="shrink-0 border-b border-slate-800 p-3">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-xs uppercase tracking-[0.14em] text-slate-500">Backend status</div>
                    <div className="mt-2"><StatusPill status={probeBusy ? "checking" : probe?.status ?? "unknown"} /></div>
                  </div>
                  <div className="text-right text-xs text-slate-500">
                    <div>{probe?.tools.length ?? 0} visible tools</div>
                    <div className="mt-1">{selected?.enabled ? "enabled" : "disabled"}</div>
                  </div>
                </div>
                <div className="mt-3 whitespace-pre-wrap text-xs leading-5 text-slate-400">
                  {probeBusy ? "Probing module backend..." : probe?.message ?? "Select a module."}
                </div>
              </div>

              <div className="min-h-0 flex-1 overflow-auto p-2">
                <div className="mb-2 px-1 text-[11px] uppercase tracking-[0.14em] text-slate-600">Available tools</div>
                <div className="space-y-1">
                  {probe?.tools.map((tool) => (
                    <div key={tool.name} className="rounded-md border border-slate-800 bg-slate-950/40 px-2.5 py-2">
                      <div className="font-mono text-xs text-slate-200">{tool.name}</div>
                      {(tool.title || tool.description) && (
                        <div className="mt-1 line-clamp-2 text-[11px] leading-4 text-slate-500">
                          {tool.title && <span className="text-slate-400">{tool.title}: </span>}
                          {tool.description}
                        </div>
                      )}
                    </div>
                  ))}
                  {!probeBusy && (probe?.tools.length ?? 0) === 0 && (
                    <div className="rounded-md border border-dashed border-slate-800 px-3 py-8 text-center text-xs text-slate-600">
                      No tools reported.
                    </div>
                  )}
                </div>
              </div>

              {probe?.detail != null && (
                <details className="shrink-0 border-t border-slate-800 bg-slate-950/40">
                  <summary className="cursor-pointer px-3 py-2 text-xs text-slate-500">Raw module detail</summary>
                  <pre className="max-h-40 overflow-auto border-t border-slate-800 p-3 font-mono text-[10px] text-slate-500">
                    {JSON.stringify(probe.detail, null, 2)}
                  </pre>
                </details>
              )}
            </div>
          </Pane>
        </div>
      </div>
    </main>
  );
}
