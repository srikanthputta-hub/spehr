import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Activity, ChevronDown } from "lucide-react";

/**
 * Auto Doc Pipeline Monitor — admin-only Watch Dog panel that streams the
 * headless clinical reasoning agent's stage logs. Purely observational; the
 * Auto Doc agent has no chat surface, no avatar, no clinical-side UI.
 */

interface LogRow {
  id: string;
  mrn: string;
  stage: string;
  level: string;
  message: string;
  created_at: string;
}

const STAGE_ORDER = [
  "analyze",
  "order",
  "result",
  "document",
  "umls",
  "fhir",
  "discharge",
  "complete",
];

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
  const [open, setOpen] = useState(true);
  const [logs, setLogs] = useState<LogRow[]>([]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const { data: l } = await supabase
        .from("auto_doc_logs")
        .select("id, mrn, stage, level, message, created_at")
        .order("created_at", { ascending: false })
        .limit(100);
      if (cancelled) return;
      if (l) setLogs(l as any);
    };
    load();
    const ch = supabase
      .channel("auto-doc-logs")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "auto_doc_logs" },
        (payload) =>
          setLogs((prev) => [payload.new as any, ...prev].slice(0, 100)),
      )
      .subscribe();
    const poll = setInterval(load, 15_000);
    return () => {
      cancelled = true;
      supabase.removeChannel(ch);
      clearInterval(poll);
    };
  }, []);

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
              Auto Doc Pipeline Monitor
            </div>
            <div className="text-[11px] text-slate-500 mt-0.5">
              Headless clinical reasoning agent · {statusText}
            </div>
          </div>
        </div>
        <ChevronDown className={`h-4 w-4 text-slate-400 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div className="border-t border-slate-200">
          <div className="px-6 py-3 max-h-72 overflow-y-auto">
            <div className="text-[10px] font-semibold uppercase tracking-[0.22em] text-slate-500 mb-2">
              Live Pipeline Log
            </div>
            {logs.length === 0 && (
              <div className="text-[11px] text-slate-500 italic">
                Waiting for Auto Doc activity…
              </div>
            )}
            <ul className="space-y-1 font-mono text-[11px]">
              {logs.map((l) => (
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