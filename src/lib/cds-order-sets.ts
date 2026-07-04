/**
 * Condition-triggered CDS order-set catalog + matcher.
 *
 * Display-only: no auto-ordering, no writes to order tables. Consumed by
 * `useCdsSuggestionsWatcher` which persists suggestions to localStorage,
 * and by `CdsSuggestionsBanners` which renders them on the patient chart.
 */

export type Severity = "critical" | "red" | "amber";

export type OrderSet = {
  id: string;
  label: string;
  severity: Severity;
  items: string[];
};

export const ORDER_SETS: Record<string, OrderSet> = {
  "sepsis-bundle": {
    id: "sepsis-bundle",
    label: "🔴 Sepsis Protocol — 3-hour bundle suggested",
    severity: "red",
    items: [
      "Blood cultures x2",
      "Serum lactate",
      "IV fluid bolus (30 ml/kg)",
      "Broad-spectrum antibiotics",
      "Urine output monitoring",
      "Repeat vitals every 30 min",
    ],
  },
  "acs": {
    id: "acs",
    label: "🔴 ACS Protocol — immediate workup suggested",
    severity: "red",
    items: [
      "12-lead ECG immediately",
      "Troponin I + Troponin T",
      "Aspirin 300 mg",
      "Chest X-ray",
      "IV access + bloods",
      "Cardiology consult",
    ],
  },
  "septic-shock": {
    id: "septic-shock",
    label: "🔴 Septic Shock — escalated protocol suggested",
    severity: "critical",
    items: [
      "Blood cultures x2",
      "Serum lactate",
      "IV fluid bolus (30 ml/kg)",
      "Broad-spectrum antibiotics",
      "Urine output monitoring",
      "Repeat vitals every 30 min",
      "Vasopressors (Norepinephrine)",
      "ICU referral",
      "Central venous access",
      "Arterial line",
    ],
  },
  "infection-workup": {
    id: "infection-workup",
    label: "⚠ Infection Workup — suggested order set",
    severity: "amber",
    items: [
      "Blood cultures x2 before antibiotics",
      "FBC, CRP, Procalcitonin",
      "Urine MC&S",
      "Chest X-ray",
      "Antibiotics per local protocol",
    ],
  },
};

const ACS_CODES = new Set([
  "57054005",
  "413444003",
  "194828000",
  "425677008",
  "4568003",
  "59139008",
  "29857009",
]);
const INFECTION_CODES = new Set(["5758002", "91302008"]);
const SEPTIC_SHOCK_CODE = "76571007";

/**
 * Match approved SNOMED codes against CDS triggers.
 *
 * @param codes            SNOMED codes flattened from an approved NLP audit row
 * @param sepsisIndicators  Codes in the `Sepsis Indicators` value set
 * @param highAcuity        Codes in the `High-Acuity ED Presentations` value set
 */
export function matchTriggers(
  codes: string[],
  sepsisIndicators: Set<string>,
  highAcuity: Set<string>,
): string[] {
  const fired = new Set<string>();
  for (const raw of codes) {
    const c = String(raw ?? "").trim();
    if (!c) continue;
    if (c === SEPTIC_SHOCK_CODE) fired.add("septic-shock");
    if (INFECTION_CODES.has(c)) fired.add("infection-workup");
    if (sepsisIndicators.has(c)) fired.add("sepsis-bundle");
    if (highAcuity.has(c) && ACS_CODES.has(c)) fired.add("acs");
  }
  // Septic Shock supersedes the base Sepsis Bundle.
  if (fired.has("septic-shock")) fired.delete("sepsis-bundle");
  // Order by severity: critical → red → amber.
  const order = ["septic-shock", "acs", "sepsis-bundle", "infection-workup"];
  return order.filter((id) => fired.has(id));
}