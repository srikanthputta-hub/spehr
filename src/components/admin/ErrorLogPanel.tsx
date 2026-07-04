import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { AlertCircle } from "lucide-react";

/**
 * Error Log panel — shows only error-level rows across the four agent
 * pipelines. Replaces the old Watchdog Status widget and Automation
 * Pipeline Monitor. Refreshes every 60s.
 */

type TabId = "auto-doc" | "auto-admin" | "auto-it" | "auto-api";

interface ErrorRow {
  id: string;
  created_at: string;
  mrn: string | null;
  stage: string;
  message: string;
}

const TABS: { id: TabId; label: string; stages?: string[] }[] = [
  { id: "auto-doc", label: "Auto Doc", stages: ["analyze", "order", "result", "document", "complete", "error"] },
  { id: "auto-admin", label: "Auto Admin", stages: ["discharge"] },
  { id: "auto-it", label: "Auto IT", stages: ["umls", "fhir"] },
  { id: "auto-api", label: "Auto API" },
];

const MAX_ROWS = 50;

async function loadErrors(tab: TabId): Promise<ErrorRow[]> {
  if (tab === "auto-api") {
    const { data } = await supabase
      .from("auto_api_events")
      .select("id, created_at, mrn, event_type, payload")
      .or("event_type.ilike.%error%,payload->>level.eq.error")
      .order("created_at", { ascending: false })
      .limit(MAX_ROWS);
    return (data ?? []).map((r: any) => ({
      id: r.id,
      created_at: r.created_at,
      mrn: r.mrn,
      stage: r.event_type,
      message:
        (r.payload && (r.payload.message || r.payload.error)) ||
        r.event_type,
    }));
  }
  const stages = TABS.find((t) => t.id === tab)?.stages ?? [];
  const { data } = await supabase
    .from("auto_doc_logs")
    .select("id, created_at, mrn, stage, message, level")
    .eq("level", "error")
    .in("stage", stages)
    .order("created_at", { ascending: false })
    .limit(MAX_ROWS);
  return (data ?? []) as ErrorRow[];
}

export function ErrorLogPanel() {
  const [tab, setTab] = useState<TabId>("auto-doc");
  const [rows, setRows] = useState<ErrorRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const r = await loadErrors(tab);
      if (!cancelled) {
        setRows(r);
        setLoading(false);
      }
    };
    setLoading(true);
    load();
    const id = setInterval(load, 60_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [tab]);

  return (
    <div className="mb-4 rounded-xl border border-slate-200 bg-white shadow-sm overflow-hidden">
      <div className="flex items-center gap-3 px-6 py-4 border-b border-slate-200">
        <div className="grid place-items-center h-10 w-10 rounded-lg bg-red-50 text-red-600">
          <AlertCircle className="h-5 w-5" />
        </div>
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-[0.22em] text-slate-500">
            Diagnostics
          </div>
          <div className="text-sm font-semibold text-slate-900">Error Log</div>
          <div className="text-[11px] text-slate-500 mt-0.5">
            Error-level entries only · refreshes every 60s · capped at {MAX_ROWS} per tab
          </div>
        </div>
      </div>
      <div className="flex items-center gap-1 border-b border-slate-200 bg-slate-50/60 px-3 pt-2">
        {TABS.map((t) => {
          const active = tab === t.id;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={`relative px-3 py-2 text-[11px] font-semibold uppercase tracking-wider transition ${
                active ? "text-red-700" : "text-slate-500 hover:text-slate-700"
              }`}
            >
              {t.label}
              {active && (
                <span className="absolute left-0 right-0 -bottom-px h-0.5 bg-red-600 rounded-full" />
              )}
            </button>
          );
        })}
      </div>
      <div className="px-6 py-3 max-h-80 overflow-y-auto">
        {loading ? (
          <div className="text-[11px] text-slate-500 italic">Loading…</div>
        ) : rows.length === 0 ? (
          <div className="text-[11px] text-slate-500 italic">No errors</div>
        ) : (
          <ul className="space-y-1 font-mono text-[11px]">
            {rows.map((r) => (
              <li key={r.id} className="flex items-start gap-2">
                <span className="text-slate-400 shrink-0">
                  {new Date(r.created_at).toLocaleTimeString()}
                </span>
                {r.mrn && (
                  <span className="font-semibold text-slate-700 shrink-0">
                    MRN-{r.mrn}
                  </span>
                )}
                <span className="inline-flex items-center rounded border border-red-200 bg-red-100 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-red-700 shrink-0">
                  {r.stage}
                </span>
                <span className="text-slate-700 font-sans">{r.message}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}