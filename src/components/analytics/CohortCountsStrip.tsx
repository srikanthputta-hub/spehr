import { AlertTriangle } from "lucide-react";
import { useHighAcuityCount, HIGH_ACUITY_VS_NAME } from "@/hooks/useCohortCounts";
import { InfoHint } from "@/components/ui/info-hint";

/**
 * Compact single-tile strip — shows currently-admitted patients whose
 * active conditions match the published High-Acuity ED Presentations
 * value set (chest pain, stroke, cardiac arrest, MI, anaphylaxis,
 * acute respiratory failure, GI hemorrhage, altered mental status).
 */
export default function CohortCountsStrip({ className = "" }: { className?: string }) {
  const { count, loading } = useHighAcuityCount();
  const display = loading && count === null ? "…" : count === null ? "—" : String(count);
  return (
    <section
      className={`flex ${className}`}
      aria-label="Currently admitted high-acuity patients"
    >
      <div className="inline-flex items-center gap-2.5 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 shadow-[0_1px_0_rgba(15,23,42,0.03)]">
        <AlertTriangle className="h-4 w-4 text-rose-600 flex-none" />
        <div className="flex flex-col leading-none">
          <div className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-rose-700 font-semibold">
            Admitted · High-Acuity
            <InfoHint
              className="ml-0.5"
              text={`Currently admitted patients (patients.status = "Admitted") who have at least one active condition coded to the published "${HIGH_ACUITY_VS_NAME}" value set (chest pain, ischemic stroke, cardiac arrest, acute MI, anaphylaxis, acute respiratory failure, GI hemorrhage, altered mental status, cerebrovascular accident). Scoped to live census — does not include already-discharged patients.`}
            />
          </div>
          <div className="text-lg font-bold tabular-nums text-rose-900">{display}</div>
        </div>
      </div>
    </section>
  );
}