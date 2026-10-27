import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { AlertTriangle } from "lucide-react";
import { InfoHint } from "@/components/ui/info-hint";

type TabId = "auto-doc" | "auto-admin" | "auto-it" | "auto-api";

interface ErrorRow {
  id: string;
  created_at: string;
  mrn?: string | null;
  stage: string;
  message: string;
}

const TABS: { id: TabId; label: string }[] = [
  { id: "auto-doc", label: "Auto Doc" },
  { id: "auto-admin", label: "Auto Admin" },
  { id: "auto-it", label: "Auto IT" },
  { id: "auto-api", label: "Auto API" },
];

const AUTO_DOC_STAGES = ["analyze", "order", "result", "document", "complete", "error"];
const AUTO_ADMIN_STAGES = ["discharge", "billing"];
const AUTO_IT_STAGES = ["umls", "fhir"];

async function fetchErrors(tab: TabId): Promise<ErrorRow[]> {
  if (tab === "auto-api") {
    const { data } = await supabase
      .from("auto_api_events")
      .select("id, created_at, mrn, event_type, payload")
      .ilike("event_type", "%error%")
      .order("created_at", { ascending: false })
      .limit(50);
    return (data ?? []).map((r: any) => ({
      id: r.id,
      created_at: r.created_at,
      mrn: r.mrn,
      stage: r.event_type,
      message:
        (r.payload && (r.payload.message || r.payload.error)) || JSON.stringify(r.payload ?? {}),
    }));
  }
  const stages =
    tab === "auto-doc"
      ? AUTO_DOC_STAGES
      : tab === "auto-admin"
        ? AUTO_ADMIN_STAGES
        : AUTO_IT_STAGES;
  const { data } = await supabase
    .from("auto_doc_logs")
    .select("id, created_at, mrn, stage, message, level")
    .eq("level", "error")
    .in("stage", stages)
    .order("created_at", { ascending: false })
    .limit(50);
  return (data ?? []).map((r: any) => ({
    id: r.id,
    created_at: r.created_at,
    mrn: r.mrn,
    stage: r.stage,
    message: r.message,
  }));
}

export function ErrorLogPanel() {
  const [tab, setTab] = useState<TabId>("auto-doc");
  const [rows, setRows] = useState<ErrorRow[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      try {
        const r = await fetchErrors(tab);
        if (!cancelled) setRows(r);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
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
        <div className="grid place-items-center h-10 w-10 rounded-lg bg-rose-50 text-rose-600">
          <AlertTriangle className="h-5 w-5" />
        </div>
        <div>
          <div className="text-sm font-semibold text-slate-900 flex items-center gap-1.5">
            Error Log
            <InfoHint
              className="ml-1"
              text="Shows only error-level events from the four autonomous engines (Auto Doc, Auto Admin, Auto IT, Auto API) — informational and warning-level activity is filtered out so real failures aren't buried."
            />
          </div>
          <div className="text-[11px] text-slate-500">50 most recent · refreshes every 60s</div>
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
                active ? "text-rose-700" : "text-slate-500 hover:text-slate-700"
              }`}
            >
              {t.label}
              {active && (
                <span className="absolute left-0 right-0 -bottom-px h-0.5 bg-rose-600 rounded-full" />
              )}
            </button>
          );
        })}
      </div>
      <div className="px-6 py-3 max-h-72 overflow-y-auto">
        {loading && rows.length === 0 ? (
          <div className="text-[11px] text-slate-500 italic">Loading…</div>
        ) : rows.length === 0 ? (
          <div className="text-[11px] text-slate-500 italic">No errors</div>
        ) : (
          <ul className="space-y-1 font-mono text-[11px]">
            {rows.map((r) => (
              <li key={r.id} className="flex items-start gap-2">
                <span className="text-slate-400 shrink-0">
                  {new Date(r.created_at).toLocaleString()}
                </span>
                <span className="inline-flex items-center rounded border border-rose-200 bg-rose-50 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-rose-700">
                  {r.stage}
                </span>
                <span className="text-slate-700 font-sans">
                  {r.mrn ? <span className="font-semibold">MRN-{r.mrn} </span> : null}
                  {r.message}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
