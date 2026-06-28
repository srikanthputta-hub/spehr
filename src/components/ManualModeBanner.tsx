import { AlertTriangle } from "lucide-react";
import { useAutomationEnabled } from "@/hooks/useAutomationEnabled";

/**
 * Amber banner shown across every clinical workspace whenever the global
 * automation toggle is OFF. Reminds clinicians that medication / lab
 * orders require manual verification because the AI cascade is paused.
 * Patient-safety surfaces (vitals, CDS, drug-allergy sweep) still run.
 */
export function ManualModeBanner({ context }: { context?: string } = {}) {
  const enabled = useAutomationEnabled();
  if (enabled) return null;
  return (
    <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 flex items-start gap-3">
      <AlertTriangle className="h-4 w-4 text-amber-700 mt-0.5 shrink-0" />
      <div className="text-xs">
        <div className="font-bold text-amber-900 uppercase tracking-wider">
          Manual Mode Active
        </div>
        <div className="text-amber-800 mt-0.5">
          AI clinical engines are paused. Medication orders, lab orders and
          discharges require manual verification.
          {context ? ` ${context}` : ""}{" "}
          Patient-safety monitoring (vitals, CDS, drug-allergy sweep) remains active.
        </div>
      </div>
    </div>
  );
}