import { AlertTriangle } from "lucide-react";
import { useAutoApiEnabled } from "@/hooks/useAutomationEnabled";

export function AutoApiManualBanner() {
  const enabled = useAutoApiEnabled();
  if (enabled) return null;
  return (
    <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 flex items-start gap-3">
      <AlertTriangle className="h-4 w-4 text-amber-700 mt-0.5 shrink-0" />
      <div className="text-xs">
        <div className="font-bold text-amber-900 uppercase tracking-wider">
          AUTO API · Manual Mode
        </div>
        <div className="text-amber-800 mt-0.5">
          UMLS live query, NLP confidence gate, 400 ms FHIR sync, and RxNorm drug-safety checks are
          paused. Semantic Autocomplete in CPOE and plain-English translations in MySpehr are also
          disabled until AUTO API is re-enabled.
        </div>
      </div>
    </div>
  );
}
