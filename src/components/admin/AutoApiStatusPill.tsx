import { useEffect, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { Activity } from "lucide-react";
import { getAutoApiLoopStatus } from "@/lib/auto-api.functions";

type LoopStatus = "NORMAL" | "WARNING" | "ERROR";
type Loop = { key: string; label: string; group: string; status: LoopStatus; last_run: string };

const dotClass: Record<LoopStatus, string> = {
  NORMAL: "bg-emerald-500",
  WARNING: "bg-amber-500",
  ERROR: "bg-rose-500",
};

function overall(loops: Loop[]): { label: string; tone: string } {
  const errs = loops.filter((l) => l.status === "ERROR").length;
  const warns = loops.filter((l) => l.status === "WARNING").length;
  if (errs > 0)
    return { label: "AUTO API · ERROR", tone: "bg-rose-50 text-rose-700 border-rose-200" };
  if (warns >= 1 && warns <= 2)
    return { label: "AUTO API · DEGRADED", tone: "bg-amber-50 text-amber-700 border-amber-200" };
  return { label: "AUTO API · ACTIVE", tone: "bg-emerald-50 text-emerald-700 border-emerald-200" };
}

export function AutoApiStatusPill() {
  const [loops, setLoops] = useState<Loop[]>([]);
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await getAutoApiLoopStatus();
        if (!cancelled) setLoops(res.loops as Loop[]);
      } catch {
        /* ignore */
      }
    };
    void load();
    // Status pill only, not patient-safety-critical. Loosened 15s -> 30s to
    // cut Supabase egress (Free-plan bandwidth quota mitigation).
    const id = setInterval(load, 30_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);
  const ov = overall(loops);
  const dot = loops.some((l) => l.status === "ERROR")
    ? "bg-rose-500"
    : loops.some((l) => l.status === "WARNING")
      ? "bg-amber-500"
      : "bg-emerald-500";
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button
          type="button"
          className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wider ${ov.tone}`}
        >
          <span className={`h-2 w-2 rounded-full ${dot}`} />
          <Activity className="h-3 w-3" />
          {ov.label}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="bottom"
          align="end"
          sideOffset={6}
          className="z-50 w-80 rounded-lg border border-slate-200 bg-white p-3 shadow-lg"
        >
          <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500 mb-2">
            AUTO API · 7 monitored loops
          </div>
          <div className="space-y-1.5">
            {loops.map((l) => (
              <div
                key={l.key}
                className="flex items-center justify-between gap-2 rounded-md border border-slate-100 bg-slate-50 px-2 py-1.5"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span className={`h-2 w-2 rounded-full ${dotClass[l.status]}`} />
                  <span className="text-xs font-semibold text-slate-700 truncate">{l.label}</span>
                </div>
                <span className="text-[10px] font-mono text-slate-400">
                  {new Date(l.last_run).toLocaleTimeString()}
                </span>
              </div>
            ))}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
