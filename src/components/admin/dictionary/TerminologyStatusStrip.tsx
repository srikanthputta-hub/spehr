import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Activity, Database, Gauge, Clock } from "lucide-react";

// Renders "just now" / "3m ago" / "2h ago" from a real timestamp. Never
// invents a value — the caller passes `null` when there is no real
// `terminology_audit` row yet, and we render "—" for that case.
function formatRelative(iso: string | null): string {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return "just now";
  const sec = Math.round(ms / 1000);
  if (sec < 60) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  return `${day}d ago`;
}

export function TerminologyStatusStrip() {
  const [umlsMs, setUmlsMs] = useState<number | null>(null);
  const [umlsOk, setUmlsOk] = useState(true);
  const [vsCounts, setVsCounts] = useState({ published: 0, review: 0, draft: 0 });
  // Real cache-hit-rate + last-resolved timestamp, both derived from
  // `terminology_audit` (written by `terminology-resolver.ts` on every
  // resolution attempt, with a genuine `cache_hit` boolean per row) — not a
  // synthetic random walk. `null` means "no audit rows yet", rendered as "—".
  const [cacheHit, setCacheHit] = useState<number | null>(null);
  const [cacheSampleSize, setCacheSampleSize] = useState(0);
  const [lastResolvedAt, setLastResolvedAt] = useState<string | null>(null);
  const [, forceTick] = useState(0);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      // Value set counts
      const { data: vs } = await supabase
        .from("custom_value_sets")
        .select("status");
      if (vs && alive) {
        const c = { published: 0, review: 0, draft: 0 };
        vs.forEach((r: any) => {
          if (r.status === "published") c.published++;
          else if (r.status === "review") c.review++;
          else if (r.status === "draft") c.draft++;
        });
        setVsCounts(c);
      }

      // UMLS ping via cheapest possible call
      const t0 = performance.now();
      const { error } = await supabase.functions.invoke("umls-proxy", {
        body: { action: "snomed", params: { string: "hypertension", pageSize: 1 } },
      });
      if (!alive) return;
      if (error) { setUmlsOk(false); setUmlsMs(null); }
      else {
        setUmlsOk(true);
        setUmlsMs(Math.round(performance.now() - t0));
      }

      // Real cache-hit rate + last-resolved time, sampled from the most
      // recent resolver audit rows — every one written with a genuine
      // cache_hit flag by terminology-resolver.ts.
      const { data: auditRows } = await supabase
        .from("terminology_audit")
        .select("cache_hit, created_at")
        .order("created_at", { ascending: false })
        .limit(200);
      if (!alive) return;
      const list = (auditRows ?? []) as Array<{ cache_hit: boolean | null; created_at: string }>;
      if (list.length > 0) {
        const hits = list.filter((r) => r.cache_hit).length;
        setCacheHit(Math.round((hits / list.length) * 100));
        setCacheSampleSize(list.length);
        setLastResolvedAt(list[0].created_at);
      } else {
        setCacheHit(null);
        setCacheSampleSize(0);
        setLastResolvedAt(null);
      }
    };
    tick();
    const id = setInterval(tick, 30000);
    // Re-render every 30s even between fetches so "Last resolved" keeps
    // advancing ("2m ago" → "3m ago") without a fresh query.
    const clockId = setInterval(() => forceTick((n) => n + 1), 30000);
    return () => { alive = false; clearInterval(id); clearInterval(clockId); };
  }, []);

  return (
    <div className="rounded-md border border-slate-200 bg-gradient-to-r from-slate-50 to-white px-4 py-2.5 flex flex-wrap items-center gap-x-6 gap-y-2 text-[11px]">
      <div className="flex items-center gap-2">
        <span className="font-semibold text-slate-900">🔬 S.P.E.H.R. Terminology Services</span>
        <span className="text-slate-400">·</span>
        <span className="text-slate-500">VSAC-aligned · UMLS-powered · FHIR R4</span>
      </div>
      <div className="flex items-center gap-1.5">
        <Activity className="h-3 w-3 text-emerald-600" />
        <span className="text-slate-500">UMLS API</span>
        <span className={`font-semibold ${umlsOk ? "text-emerald-700" : "text-rose-700"}`}>
          ● {umlsOk ? "Live" : "Down"}
        </span>
        {umlsMs != null && <span className="font-mono text-slate-600">{umlsMs}ms</span>}
      </div>
      <div className="flex items-center gap-1.5">
        <Database className="h-3 w-3 text-slate-500" />
        <span className="text-slate-500">Value Sets</span>
        <span className="font-semibold text-emerald-700">{vsCounts.published} published</span>
        <span className="text-slate-400">·</span>
        <span className="font-semibold text-amber-700">{vsCounts.review} in review</span>
        <span className="text-slate-400">·</span>
        <span className="font-semibold text-slate-700">{vsCounts.draft} draft</span>
      </div>
      <div className="flex items-center gap-1.5">
        <Gauge className="h-3 w-3 text-slate-500" />
        <span className="text-slate-500">Cache</span>
        <span className="font-semibold text-slate-800">
          {cacheHit != null ? `${cacheHit}% hit rate (n=${cacheSampleSize})` : "not yet tracked"}
        </span>
      </div>
      <div className="flex items-center gap-1.5">
        <Clock className="h-3 w-3 text-slate-500" />
        <span className="text-slate-500">Last resolved:</span>
        <span className="font-semibold text-slate-800">{formatRelative(lastResolvedAt)}</span>
      </div>
    </div>
  );
}