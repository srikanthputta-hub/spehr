import { useCallback, useEffect, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { Activity, Power } from "lucide-react";
import { getAllLoopStatuses } from "@/lib/auto-api.functions";
import { supabase } from "@/integrations/supabase/client";
import { useAutomationEnabled } from "@/hooks/useAutomationEnabled";

type LoopStatus = "NORMAL" | "WARNING" | "ERROR" | "INACTIVE" | "PAUSED";
type Loop = {
  key: string;
  label: string;
  group: string; // agent name
  category: string;
  status: LoopStatus;
  last_run: string | null;
  sla_seconds: number;
};

const dotClass: Record<LoopStatus, string> = {
  NORMAL:   "bg-emerald-500",
  WARNING:  "bg-amber-500",
  ERROR:    "bg-rose-500",
  INACTIVE: "bg-slate-300",
  PAUSED:   "bg-slate-400",
};

const AGENT_ORDER = ["Auto Doc", "Auto Admin", "Auto IT", "AUTO API"] as const;

const agentAccent: Record<string, string> = {
  "Auto Doc":  "bg-indigo-50 text-indigo-700 border-indigo-200",
  "Auto Admin":"bg-emerald-50 text-emerald-700 border-emerald-200",
  "Auto IT":   "bg-sky-50 text-sky-700 border-sky-200",
  "AUTO API":  "bg-violet-50 text-violet-700 border-violet-200",
};

function worstStatus(list: Loop[]): LoopStatus {
  if (list.some((l) => l.status === "ERROR")) return "ERROR";
  if (list.some((l) => l.status === "WARNING")) return "WARNING";
  if (list.every((l) => l.status === "PAUSED")) return "PAUSED";
  if (list.every((l) => l.status === "INACTIVE")) return "INACTIVE";
  return "NORMAL";
}

function formatSla(sec: number): string {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  return `${Math.round(sec / 3600)}h`;
}

function formatAgo(iso: string | null): string {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return "now";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

export function AutoApiStatusPill() {
  const [loops, setLoops] = useState<Loop[]>([]);
  const automationOn = useAutomationEnabled();
  const [toggling, setToggling] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await getAllLoopStatuses();
      setLoops(res.loops as Loop[]);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    void load();
    const id = setInterval(load, 15_000);
    return () => clearInterval(id);
  }, [load]);

  // Re-fetch immediately when the global toggle flips so dots flip without waiting for the next 15s tick.
  useEffect(() => {
    void load();
  }, [automationOn, load]);

  const counts = loops.reduce(
    (acc, l) => {
      acc[l.status] = (acc[l.status] ?? 0) + 1;
      return acc;
    },
    {} as Record<LoopStatus, number>,
  );
  const normal = counts.NORMAL ?? 0;
  const warning = counts.WARNING ?? 0;
  const error = counts.ERROR ?? 0;
  const paused = counts.PAUSED ?? 0;

  const overallTone = !automationOn
    ? "bg-slate-50 text-slate-600 border-slate-200"
    : error > 0
      ? "bg-rose-50 text-rose-700 border-rose-200"
      : warning > 0
        ? "bg-amber-50 text-amber-700 border-amber-200"
        : "bg-emerald-50 text-emerald-700 border-emerald-200";

  const overallDot = !automationOn
    ? "bg-slate-400"
    : error > 0
      ? "bg-rose-500"
      : warning > 0
        ? "bg-amber-500"
        : "bg-emerald-500";

  const headerLabel = !automationOn
    ? `Engines Paused · ${loops.length || 23} loops`
    : `✓ ${normal} NORMAL · ⚠ ${warning} WARNING · ✗ ${error} ERROR`;

  async function toggleAutomation() {
    setToggling(true);
    try {
      await supabase
        .from("system_settings")
        .update({ automation_enabled: !automationOn } as any)
        .eq("id", 1);
    } finally {
      setToggling(false);
    }
  }

  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button
          type="button"
          className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wider ${overallTone}`}
          title="Watchdog · 23 loops"
        >
          <span className={`h-2 w-2 rounded-full ${overallDot}`} />
          <Activity className="h-3 w-3" />
          {headerLabel}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="bottom"
          align="end"
          sideOffset={6}
          className="z-50 w-[420px] max-h-[78vh] overflow-y-auto rounded-lg border border-slate-200 bg-white p-3 shadow-xl"
        >
          {/* Global control row */}
          <div className="mb-3 flex items-center justify-between gap-3 rounded-md border border-slate-200 bg-slate-50 px-3 py-2">
            <div className="flex items-center gap-2 min-w-0">
              <Power
                className={`h-4 w-4 ${automationOn ? "text-emerald-600" : "text-slate-500"}`}
              />
              <div className="min-w-0">
                <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                  Global Engines
                </div>
                <div
                  className={`text-xs font-bold ${automationOn ? "text-emerald-700" : "text-slate-600"}`}
                >
                  {automationOn ? "ON · All loops live" : "OFF · All loops paused"}
                </div>
              </div>
            </div>
            <button
              type="button"
              onClick={toggleAutomation}
              disabled={toggling}
              className={`inline-flex items-center gap-1 rounded-md border px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider transition disabled:opacity-50 ${
                automationOn
                  ? "border-rose-200 bg-white text-rose-700 hover:bg-rose-50"
                  : "border-emerald-200 bg-white text-emerald-700 hover:bg-emerald-50"
              }`}
            >
              {automationOn ? "Pause" : "Resume"}
            </button>
          </div>

          {/* Counts strip */}
          <div className="mb-3 grid grid-cols-4 gap-1.5 text-center">
            <div className="rounded-md border border-emerald-200 bg-emerald-50 px-2 py-1.5">
              <div className="text-[9px] font-semibold uppercase tracking-wider text-emerald-700">Normal</div>
              <div className="text-sm font-bold text-emerald-800 tabular-nums">{normal}</div>
            </div>
            <div className="rounded-md border border-amber-200 bg-amber-50 px-2 py-1.5">
              <div className="text-[9px] font-semibold uppercase tracking-wider text-amber-700">Warning</div>
              <div className="text-sm font-bold text-amber-800 tabular-nums">{warning}</div>
            </div>
            <div className="rounded-md border border-rose-200 bg-rose-50 px-2 py-1.5">
              <div className="text-[9px] font-semibold uppercase tracking-wider text-rose-700">Error</div>
              <div className="text-sm font-bold text-rose-800 tabular-nums">{error}</div>
            </div>
            <div className="rounded-md border border-slate-200 bg-slate-50 px-2 py-1.5">
              <div className="text-[9px] font-semibold uppercase tracking-wider text-slate-600">Paused</div>
              <div className="text-sm font-bold text-slate-700 tabular-nums">{paused}</div>
            </div>
          </div>

          {/* Agent groups */}
          <div className="space-y-3">
            {AGENT_ORDER.map((agent) => {
              const list = loops.filter((l) => l.group === agent);
              if (list.length === 0) return null;
              const overall = worstStatus(list);
              const accent = agentAccent[agent] ?? "bg-slate-50 text-slate-700 border-slate-200";
              return (
                <div key={agent} className="rounded-lg border border-slate-200 bg-white">
                  <div className="flex items-center justify-between gap-2 border-b border-slate-200 px-3 py-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider ${accent}`}>
                        {agent}
                      </span>
                      <span className="text-[10px] font-semibold text-slate-500">
                        {list.length} loops
                      </span>
                    </div>
                    <span className="inline-flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-slate-600">
                      <span className={`h-2 w-2 rounded-full ${dotClass[overall]}`} />
                      {overall}
                    </span>
                  </div>
                  <ul className="divide-y divide-slate-100">
                    {list.map((l) => (
                      <li
                        key={l.key}
                        className="flex items-center justify-between gap-2 px-3 py-1.5"
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          <span className={`h-2 w-2 rounded-full shrink-0 ${dotClass[l.status]}`} />
                          <div className="min-w-0">
                            <div className="text-xs font-semibold text-slate-800 truncate">
                              {l.label}
                            </div>
                            <div className="text-[10px] text-slate-500 truncate">
                              {l.category} · SLA {formatSla(l.sla_seconds)}
                            </div>
                          </div>
                        </div>
                        <div className="text-right shrink-0">
                          <div className="text-[10px] font-bold uppercase tracking-wider text-slate-600">
                            {l.status}
                          </div>
                          <div className="text-[10px] font-mono text-slate-400 tabular-nums">
                            {formatAgo(l.last_run)}
                          </div>
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>

          <div className="mt-3 text-[10px] text-slate-500">
            Auto-refreshes every 15s · status derived from automation_watchdog_logs
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}