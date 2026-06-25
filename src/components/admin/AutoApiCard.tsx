import { useEffect, useState } from "react";
import { Activity, RefreshCw, Trash2 } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { supabase } from "@/integrations/supabase/client";
import { getAutoApiLoopStatus, flushQaQueue } from "@/lib/auto-api.functions";

type LoopStatus = "NORMAL" | "WARNING" | "ERROR";
type Loop = {
  key: string;
  label: string;
  group: string;
  status: LoopStatus;
  last_run: string;
};

const dotClass: Record<LoopStatus, string> = {
  NORMAL: "bg-emerald-500",
  WARNING: "bg-amber-500",
  ERROR: "bg-rose-500",
};

export function AutoApiCard() {
  const [enabled, setEnabled] = useState<boolean>(true);
  const [loops, setLoops] = useState<Loop[]>([]);
  const [busy, setBusy] = useState(false);
  const [forceMsg, setForceMsg] = useState<string | null>(null);

  const loadEnabled = async () => {
    const { data } = await supabase
      .from("system_settings")
      .select("auto_api_enabled")
      .eq("id", 1)
      .maybeSingle();
    setEnabled(Boolean((data as any)?.auto_api_enabled ?? true));
  };
  const loadLoops = async () => {
    try {
      const res = await getAutoApiLoopStatus();
      setLoops(res.loops as Loop[]);
    } catch {
      /* ignore */
    }
  };

  useEffect(() => {
    void loadEnabled();
    void loadLoops();
    const id = setInterval(loadLoops, 15_000);
    return () => clearInterval(id);
  }, []);

  const toggle = async (next: boolean) => {
    setEnabled(next);
    await supabase
      .from("system_settings")
      .update({ auto_api_enabled: next } as any)
      .eq("id", 1);
  };

  const forceSync = async () => {
    setBusy(true);
    try {
      // Bump the localStorage key the background sync hook watches → it
      // will pick up new discharged MRNs on its next 30s refresh.
      if (typeof window !== "undefined") {
        window.localStorage.setItem("fhir.autoLoop.enabled", "1");
        window.dispatchEvent(new Event("fhir.force-sync"));
      }
      setForceMsg("Force-sync triggered · next 400 ms heartbeat will pick up the queue.");
      setTimeout(() => setForceMsg(null), 4000);
    } finally {
      setBusy(false);
    }
  };

  const flush = async () => {
    setBusy(true);
    try {
      await flushQaQueue();
      setForceMsg("NLP confidence-gate queue flushed.");
      setTimeout(() => setForceMsg(null), 4000);
    } finally {
      setBusy(false);
    }
  };

  const hasErr = loops.some((l) => l.status === "ERROR");
  const hasWarn = loops.some((l) => l.status === "WARNING");

  return (
    <div className="rounded-xl border border-slate-200 bg-white shadow-sm overflow-hidden">
      <div className="flex items-center justify-between gap-3 border-b border-slate-100 bg-gradient-to-r from-violet-50 to-fuchsia-50 px-4 py-3">
        <div className="flex items-center gap-2 min-w-0">
          <div className="grid place-items-center h-9 w-9 rounded-lg bg-violet-100 text-violet-700">
            <Activity className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <div className="text-sm font-bold text-slate-900">AUTO API</div>
            <div className="text-[11px] text-slate-500">
              API Orchestration · UMLS · FHIR · Drug Safety · NLP Governance
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Badge
            variant="outline"
            className={
              !enabled
                ? "bg-slate-100 text-slate-600 border-slate-300"
                : hasErr
                  ? "bg-rose-50 text-rose-700 border-rose-200"
                  : hasWarn
                    ? "bg-amber-50 text-amber-700 border-amber-200"
                    : "bg-emerald-50 text-emerald-700 border-emerald-200"
            }
          >
            {!enabled ? "DISABLED" : hasErr ? "ERROR" : hasWarn ? "WARNING" : "ACTIVE"}
          </Badge>
          <Switch checked={enabled} onCheckedChange={toggle} />
        </div>
      </div>
      <div className="p-4 space-y-2">
        {loops.map((l) => (
          <div
            key={l.key}
            className="flex items-center justify-between gap-2 rounded-lg border border-slate-100 bg-slate-50/60 px-3 py-2"
          >
            <div className="flex items-center gap-2 min-w-0">
              <span className={`h-2 w-2 rounded-full ${dotClass[l.status]}`} />
              <div className="min-w-0">
                <div className="text-xs font-semibold text-slate-700 truncate">{l.label}</div>
                <div className="text-[10px] uppercase tracking-wider text-slate-400">{l.group}</div>
              </div>
            </div>
            <div className="text-right">
              <div className="text-[10px] font-mono text-slate-500">
                {new Date(l.last_run).toLocaleTimeString()}
              </div>
              <div className="text-[10px] uppercase tracking-wider text-slate-400">last run</div>
            </div>
          </div>
        ))}
      </div>
      <div className="flex items-center justify-between gap-2 border-t border-slate-100 bg-slate-50/60 px-4 py-3">
        <div className="text-[11px] text-slate-500 min-h-[16px]">{forceMsg}</div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" disabled={busy || !enabled} onClick={forceSync}>
            <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
            Force Sync
          </Button>
          <Button size="sm" variant="outline" disabled={busy || !enabled} onClick={flush}>
            <Trash2 className="h-3.5 w-3.5 mr-1.5" />
            Flush NLP Queue
          </Button>
        </div>
      </div>
    </div>
  );
}