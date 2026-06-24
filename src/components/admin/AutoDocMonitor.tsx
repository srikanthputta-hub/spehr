import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Activity, ChevronDown } from "lucide-react";

/**
 * Automation Pipeline Monitor — admin-only Watch Dog panel that streams
 * background-agent activity. Logs are sourced from `auto_doc_logs` and
 * classified into the three parent agents (Auto Doc / Auto Admin / Auto IT)
 * by their `stage` tag. Caps each agent's in-memory buffer at 50 entries to
 * keep the DOM lightweight.
 */

interface LogRow {
  id: string;
  mrn: string;
  stage: string;
  level: string;
  message: string;
  created_at: string;
}

type AgentId = "auto-doc" | "auto-admin" | "auto-it";

const MAX_PER_AGENT = 50;

const AGENT_TABS: { id: AgentId; label: string; stages: string[] }[] = [
  {
    id: "auto-doc",
    label: "Auto Doc Logs",
    stages: ["analyze", "order", "result", "document", "complete", "error"],
  },
  {
    id: "auto-admin",
    label: "Auto Admin Logs",
    stages: ["discharge"],
  },
  {
    id: "auto-it",
    label: "Auto IT Logs",
    stages: ["umls", "fhir"],
  },
];

function classifyAgent(stage: string): AgentId {
  const tab = AGENT_TABS.find((t) => t.stages.includes(stage));
  return tab?.id ?? "auto-doc";
}

function stageBadge(stage: string) {
  const ok = stage === "complete";
  const err = stage === "error";
  const color = err
    ? "bg-red-100 text-red-700 border-red-200"
    : ok
      ? "bg-emerald-100 text-emerald-700 border-emerald-200"
      : "bg-sky-100 text-sky-700 border-sky-200";
  return (
    <span className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider ${color}`}>
      {stage}
    </span>
  );
}

export function AutoDocMonitor() {
  const [open, setOpen] = useState(false);
  const [logs, setLogs] = useState<LogRow[]>([]);
  const [activeAgent, setActiveAgent] = useState<AgentId>("auto-doc");

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const { data: l } = await supabase
        .from("auto_doc_logs")
        .select("id, mrn, stage, level, message, created_at")
        .order("created_at", { ascending: false })
        .limit(MAX_PER_AGENT * AGENT_TABS.length);
      if (cancelled) return;
      if (l) setLogs(l as LogRow[]);
    };
    load();
    const ch = supabase
      .channel("auto-doc-logs")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "auto_doc_logs" },
        (payload) =>
          setLogs((prev) =>
            [payload.new as LogRow, ...prev].slice(0, MAX_PER_AGENT * AGENT_TABS.length),
          ),
      )
      .subscribe();
    const poll = setInterval(load, 15_000);
    return () => {
      cancelled = true;
      supabase.removeChannel(ch);
      clearInterval(poll);
    };
  }, []);

  // Bucket logs by agent and cap each bucket at MAX_PER_AGENT (newest first).
  const buckets = useMemo(() => {
    const out: Record<AgentId, LogRow[]> = {
      "auto-doc": [],
      "auto-admin": [],
      "auto-it": [],
    };
    for (const row of logs) {
      const aid = classifyAgent(row.stage);
      if (out[aid].length < MAX_PER_AGENT) out[aid].push(row);
    }
    return out;
  }, [logs]);

  const visible = buckets[activeAgent];
  const latest = logs[0];
  const statusText = latest
    ? `Latest: ${latest.stage} · MRN-${latest.mrn}`
    : "Waiting for activity…";

  return (
    <div className="mb-4 rounded-xl border border-slate-200 bg-white shadow-sm overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between gap-4 px-6 py-4 hover:bg-slate-50"
      >
        <div className="flex items-center gap-3 min-w-0">
          <div className="grid place-items-center h-10 w-10 rounded-lg bg-indigo-50 text-indigo-600">
            <Activity className="h-5 w-5" />
          </div>
          <div className="text-left min-w-0">
            <div className="text-[10px] font-semibold uppercase tracking-[0.22em] text-slate-500">
              Systematic Health Check Cycle
            </div>
            <div className="text-sm font-semibold text-slate-900">
              Automation Pipeline Monitor
            </div>
            <div className="text-[11px] text-slate-500 mt-0.5">
              Multi-agent backbone (Auto Doc · Auto Admin · Auto IT) · {statusText}
            </div>
          </div>
        </div>
        <ChevronDown className={`h-4 w-4 text-slate-400 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div className="border-t border-slate-200">
          <div className="flex items-center gap-1 border-b border-slate-200 bg-slate-50/60 px-3 pt-2">
            {AGENT_TABS.map((t) => {
              const isActive = activeAgent === t.id;
              const count = buckets[t.id].length;
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setActiveAgent(t.id)}
                  className={`relative px-3 py-2 text-[11px] font-semibold uppercase tracking-wider transition ${
                    isActive
                      ? "text-indigo-700"
                      : "text-slate-500 hover:text-slate-700"
                  }`}
                >
                  {t.label}
                  <span
                    className={`ml-1.5 inline-flex items-center rounded px-1.5 py-0.5 text-[9px] font-bold ${
                      isActive
                        ? "bg-indigo-100 text-indigo-700"
                        : "bg-slate-200 text-slate-600"
                    }`}
                  >
                    {count}
                  </span>
                  {isActive && (
                    <span className="absolute left-0 right-0 -bottom-px h-0.5 bg-indigo-600 rounded-full" />
                  )}
                </button>
              );
            })}
          </div>
          <div className="px-6 py-3 max-h-72 overflow-y-auto">
            <div className="text-[10px] font-semibold uppercase tracking-[0.22em] text-slate-500 mb-2">
              Live Pipeline Log · {AGENT_TABS.find((t) => t.id === activeAgent)?.label}
              <span className="ml-2 text-slate-400 normal-case tracking-normal">
                (capped at {MAX_PER_AGENT} most recent)
              </span>
            </div>
            {visible.length === 0 && (
              <div className="text-[11px] text-slate-500 italic">
                Waiting for activity from this agent…
              </div>
            )}
            <ul className="space-y-1 font-mono text-[11px]">
              {visible.map((l) => (
                <li key={l.id} className="flex items-start gap-2">
                  <span className="text-slate-400 shrink-0">
                    {new Date(l.created_at).toLocaleTimeString()}
                  </span>
                  {stageBadge(l.stage)}
                  <span className="text-slate-700 font-sans">
                    <span className="font-semibold">MRN-{l.mrn}</span>{" "}
                    {l.message}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}