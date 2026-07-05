import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Bot, RefreshCw, CheckCircle2, AlertTriangle, Pause } from "lucide-react";

type LogRow = {
  id: string;
  run_at: string;
  message: string;
  value_set_id: string | null;
  confidence: number | null;
  action: string | null;
  theme: string | null;
  codes_count: number | null;
};

function actionTone(action: string | null) {
  switch (action) {
    case "drafted_for_review":
      return { Icon: CheckCircle2, cls: "text-emerald-700 bg-emerald-50 border-emerald-200" };
    case "drafted":
      return { Icon: CheckCircle2, cls: "text-sky-700 bg-sky-50 border-sky-200" };
    case "touched":
      return { Icon: RefreshCw, cls: "text-slate-600 bg-slate-50 border-slate-200" };
    case "skipped":
      return { Icon: Pause, cls: "text-amber-700 bg-amber-50 border-amber-200" };
    case "no_gaps":
      return { Icon: CheckCircle2, cls: "text-slate-600 bg-slate-50 border-slate-200" };
    case "heartbeat":
      return { Icon: RefreshCw, cls: "text-slate-500 bg-slate-50 border-slate-200" };
    default:
      return { Icon: AlertTriangle, cls: "text-slate-600 bg-slate-50 border-slate-200" };
  }
}

function formatAgo(ts: string | undefined): string {
  if (!ts) return "never";
  const diffMs = Date.now() - new Date(ts).getTime();
  const mins = Math.max(0, Math.floor(diffMs / 60_000));
  if (mins < 1) return "just now";
  if (mins === 1) return "1 minute ago";
  if (mins < 60) return `${mins} minutes ago`;
  const hrs = Math.floor(mins / 60);
  return hrs === 1 ? "1 hour ago" : `${hrs} hours ago`;
}

export function AutoTerminologistActivity() {
  const [rows, setRows] = useState<LogRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [nowTick, setNowTick] = useState(0);

  const lastRunAt = useMemo(() => rows[0]?.run_at, [rows]);
  // Recompute "X minutes ago" every 30s
  useEffect(() => {
    const id = setInterval(() => setNowTick((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, []);
  void nowTick;

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const { data } = await supabase
        .from("auto_terminologist_log" as any)
        .select("id, run_at, message, value_set_id, confidence, action, theme, codes_count")
        .order("run_at", { ascending: false })
        .limit(50);
      if (!cancelled) {
        setRows((data as any) ?? []);
        setLoading(false);
      }
    };
    load();
    const ch = supabase
      .channel("auto-term-activity")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "auto_terminologist_log" },
        (payload) => setRows((r) => [payload.new as any, ...r].slice(0, 50)),
      )
      .subscribe();
    const id = setInterval(load, 30_000);
    return () => {
      cancelled = true;
      supabase.removeChannel(ch);
      clearInterval(id);
    };
  }, []);

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-5 space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-[#0c2340]">
            <Bot className="h-5 w-5" />
            <h3 className="text-lg font-semibold">Auto Terminologist · Activity</h3>
          </div>
          <p className="text-sm text-slate-600 mt-1 max-w-3xl">
            Autonomous agent that scans the last 24 h of patient data every
            10 minutes and logs clinical concepts, grouped by theme, that are
            not yet covered by any published value set. Value set authoring
            remains manual — a human curates the surfaced gaps in the
            Authoring Workbench.
          </p>
          <p className="text-xs text-slate-500 mt-2">
            Last run: <span className="font-medium text-slate-700">{formatAgo(lastRunAt)}</span>
          </p>
        </div>
        <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-[11px] font-semibold text-emerald-700">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
          Loop active · 10 min cadence
        </span>
      </div>

      <div className="rounded-lg border border-slate-200 divide-y divide-slate-100 bg-slate-50/40">
        {loading ? (
          <div className="px-4 py-6 text-sm text-slate-500">Loading activity…</div>
        ) : rows.length === 0 ? (
          <div className="px-4 py-6 text-sm text-slate-500">
            No runs logged yet. The agent runs every 10 minutes — first entry will appear shortly after boot.
          </div>
        ) : (
          rows.map((r) => {
            const { Icon, cls } = actionTone(r.action);
            const time = new Date(r.run_at).toLocaleString([], {
              month: "short",
              day: "2-digit",
              hour: "2-digit",
              minute: "2-digit",
            });
            return (
              <div key={r.id} className="flex items-start gap-3 px-4 py-3">
                <span className={`mt-0.5 inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[10px] font-semibold ${cls}`}>
                  <Icon className="h-3 w-3" />
                  {(r.action ?? "log").replace(/_/g, " ")}
                </span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-slate-800 leading-snug">{r.message}</p>
                  <div className="mt-1 text-[11px] text-slate-500 flex flex-wrap items-center gap-x-3 gap-y-0.5">
                    <span>{time}</span>
                    {r.theme && <span>theme: <span className="font-medium text-slate-700">{r.theme}</span></span>}
                    {typeof r.confidence === "number" && (
                      <span>confidence: <span className="font-medium text-slate-700">{r.confidence.toFixed(2)}</span></span>
                    )}
                    {typeof r.codes_count === "number" && r.codes_count > 0 && (
                      <span>{r.codes_count} code{r.codes_count === 1 ? "" : "s"}</span>
                    )}
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}