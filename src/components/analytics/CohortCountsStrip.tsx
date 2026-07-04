import { Droplet, Wind, HeartPulse, AlertTriangle, Siren } from "lucide-react";
import { useCohortCounts, COHORTS, type CohortKey } from "@/hooks/useCohortCounts";

const ICONS: Record<CohortKey, React.ComponentType<{ className?: string }>> = {
  diabetic: Droplet,
  respiratory: Wind,
  cardiac: HeartPulse,
  sepsis: Siren,
  highAcuity: AlertTriangle,
};

export default function CohortCountsStrip({ className = "" }: { className?: string }) {
  const { counts, loading } = useCohortCounts();
  return (
    <section
      className={`grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-2 ${className}`}
      aria-label="Value-set cohort counts"
    >
      {COHORTS.map((c) => {
        const Icon = ICONS[c.key];
        const v = counts[c.key];
        const display = loading && v === null ? "…" : v === null ? "—" : String(v);
        return (
          <div
            key={c.key}
            className="rounded-md border border-slate-200 bg-white px-3 py-2 flex items-center gap-2 shadow-[0_1px_0_rgba(15,23,42,0.03)]"
            title={`${c.label} patients (from value set: ${c.vsName})`}
          >
            <Icon className="h-4 w-4 text-slate-500 flex-none" />
            <div className="flex-1 min-w-0">
              <div className="text-[10px] uppercase tracking-wider text-slate-500 truncate">
                {c.label}
              </div>
              <div className="text-lg font-semibold tabular-nums text-slate-900 leading-none">
                {display}
              </div>
            </div>
          </div>
        );
      })}
    </section>
  );
}