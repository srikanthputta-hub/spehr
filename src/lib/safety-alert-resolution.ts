import { supabase } from "@/integrations/supabase/client";

/**
 * Auto-decision threshold for safety alerts.
 *
 *   risk_score >= SAFETY_AUTO_REJECT_THRESHOLD → auto-Reject
 *   risk_score <  SAFETY_AUTO_REJECT_THRESHOLD → auto-Override
 *
 * Keep this in sync with the literal value baked into the Postgres
 * function `public.sweep_stalled_clinical_orders()` — search for
 * "SAFETY_AUTO_REJECT_THRESHOLD" in the migration folder.
 */
export const SAFETY_AUTO_REJECT_THRESHOLD = 50;

export type DbSafetyAlert = {
  id: string;
  mrn: string;
  patient_name: string | null;
  facility_name: string | null;
  kind: "Drug-Allergy" | "Drug-Drug";
  drug: string;
  drug_b: string | null;
  allergy_name: string | null;
  family: string;
  severity: string | null;
  status: "Pending Review" | "Overridden" | "Rejected";
  decided_by: string | null;
  decided_at: string | null;
  rationale: string | null;
  created_at: string;
  auto_resolve_at: string | null;
  resolved_by: string | null;
  resolution_rationale: string | null;
  risk_score: number | null;
  medication_order_id: string | null;
};

/* ------------------------------------------------------------------ */
/*  Genuine clinical rationale generator                              */
/* ------------------------------------------------------------------ */
export function buildSafetyRationale(
  c: Pick<DbSafetyAlert, "kind" | "drug" | "drug_b" | "allergy_name" | "family" | "severity">,
  decision: "Overridden" | "Rejected",
  actor: "AI Safety Engine" | "Pharmacist" = "AI Safety Engine",
): string {
  const drugA = (c.drug ?? "").trim();
  const drugB = (c.drug_b ?? "").trim();
  const fam = (c.family ?? "").toLowerCase();
  const allergy = (c.allergy_name ?? "").trim();
  const sev = c.severity ?? (c.kind === "Drug-Drug" ? "Major" : null);

  type Plan = { monitor: string; substitute: string };
  const plan: Plan = (() => {
    if (/serotonin/.test(fam))
      return {
        monitor:
          "q2h neuro checks (clonus, hyperreflexia, agitation), continuous vitals; hold second serotonergic agent until psychiatry consult",
        substitute:
          "switch tramadol → scheduled acetaminophen 650 mg PO q6h ± hydrocodone 5 mg PO q4h prn; continue SSRI",
      };
    if (/hyperkalemia/.test(fam))
      return {
        monitor:
          "baseline BMP within 4 h, repeat K+ q12h × 48 h, daily Cr; hold ACE-I if K+ ≥ 5.5 mEq/L",
        substitute:
          "discontinue spironolactone; substitute hydrochlorothiazide 25 mg PO daily and continue ACE-I",
      };
    if (/bleeding|antiplatelet|anticoagulant/.test(fam))
      return {
        monitor:
          "daily CBC, INR q24h, stool guaiac, monitor for ecchymosis/GI bleed; PPI prophylaxis",
        substitute:
          "discontinue NSAID; substitute acetaminophen 650 mg PO q6h prn pain; continue warfarin per anticoag service",
      };
    if (/inr|warfarin potentiation/.test(fam))
      return {
        monitor: "INR at 48 h and 96 h; empirically reduce warfarin dose 20–30 %",
        substitute:
          "swap TMP-SMX → cephalexin 500 mg PO QID if culture-appropriate; continue warfarin",
      };
    if (/lactic acidosis|contrast/.test(fam))
      return {
        monitor:
          "hold metformin from contrast administration through 48 h post; eGFR + lactate at 48 h before resuming",
        substitute:
          "bridge with insulin sliding scale; resume metformin once renal function confirmed stable",
      };
    if (/cyp2c19|clopidogrel/.test(fam))
      return {
        monitor: "no acute coag derangement expected; review at next med rec",
        substitute: "switch omeprazole → pantoprazole 40 mg PO daily (minimal CYP2C19 effect)",
      };
    if (/rhabdomyolysis|statin/.test(fam))
      return {
        monitor: "CK + LFTs at 72 h; counsel on muscle pain/dark urine",
        substitute:
          "hold statin for the duration of macrolide/azole course; resume on day 8",
      };
    if (/digoxin/.test(fam))
      return {
        monitor: "digoxin level at 48 h, ECG for AV block, K+ + Mg q24h",
        substitute: "empirically halve digoxin dose for the duration of interacting agent",
      };
    if (/respiratory depression|opioid \+ benzodiazepine/.test(fam))
      return {
        monitor:
          "continuous SpO₂ + capnography, q1h RASS, naloxone 0.4 mg + flumazenil 0.2 mg at bedside",
        substitute:
          "discontinue benzodiazepine; substitute hydroxyzine 25 mg PO q6h prn anxiety",
      };
    if (/penicillin|β-lactam|beta-lactam|cephalosporin/.test(fam))
      return {
        monitor:
          "first dose under observation × 30 min, epinephrine 0.3 mg IM + diphenhydramine 50 mg IV at bedside",
        substitute:
          "if reaction was rash only → desensitize or use cefazolin (low cross-reactivity, <2 %); if anaphylaxis → switch to vancomycin 15 mg/kg IV q12h",
      };
    if (/sulfonamide/.test(fam))
      return {
        monitor: "skin survey q4h × 24 h for SJS/TEN prodrome (mucosal lesions, target rash)",
        substitute:
          "switch TMP-SMX → nitrofurantoin 100 mg PO BID (UTI) or doxycycline 100 mg PO BID (broad coverage)",
      };
    if (/nsaid/.test(fam))
      return {
        monitor: "renal panel + BP at 24 h; watch for bronchospasm if asthma history",
        substitute: "switch to acetaminophen 1 g PO q6h (max 3 g/day) ± topical diclofenac",
      };
    if (/opioid/.test(fam))
      return {
        monitor: "SpO₂ + sedation score (RASS) q1h × 4 h after first dose",
        substitute:
          "if pseudoallergy (pruritus only) → pretreat with diphenhydramine 25 mg IV; if true allergy → switch to fentanyl 25 mcg IV q1h prn (different opioid class)",
      };
    if (/contrast|iodinated/.test(fam))
      return {
        monitor: "premedicate methylprednisolone 32 mg PO at 12 h and 2 h pre-scan + diphenhydramine 50 mg IV",
        substitute: "if life-threatening reaction history → switch to gadolinium MR or non-contrast study",
      };
    if (/statin/.test(fam))
      return {
        monitor: "CK + AST/ALT at 6 weeks",
        substitute: "rotate within class to pravastatin 40 mg PO qHS (non-CYP3A4 metabolism)",
      };
    if (/latex/.test(fam))
      return {
        monitor: "schedule as first case of day in latex-free OR; flag bed/chart",
        substitute: "use non-latex gloves, tubing, tourniquets; vinyl/nitrile alternatives",
      };
    return {
      monitor: "q4h vitals, daily focused exam for end-organ effects, document tolerance at 24 h",
      substitute: "discontinue offending agent; consult pharmacy for therapeutic alternative",
    };
  })();

  const pair =
    c.kind === "Drug-Drug"
      ? `${drugA || "drug A"} + ${drugB || "drug B"}`
      : `${drugA || "ordered drug"} in patient with ${allergy || "documented allergy"}`;
  const mech = c.family || "documented cross-reactivity";
  const sevTag = sev ? `${sev}-severity ` : "";

  if (decision === "Overridden") {
    return (
      `${actor === "AI Safety Engine" ? "AI Safety Engine override" : "Pharmacist override"}: ` +
      `${sevTag}${mech} (${pair}). Benefit judged to outweigh risk on this admission — ` +
      `${plan.monitor}. Reassess at 24 h; escalate to attending if any criteria above are met.`
    );
  }
  return (
    `${actor === "AI Safety Engine" ? "AI Safety Engine rejection" : "Pharmacist rejection"}: ` +
    `${sevTag}${mech} (${pair}). Risk exceeds benefit — order canceled. ` +
    `Recommended alternative: ${plan.substitute}.`
  );
}

/* ------------------------------------------------------------------ */
/*  Structured alternate medication for a rejected order.             */
/* ------------------------------------------------------------------ */
export function buildAlternateMed(
  c: Pick<DbSafetyAlert, "kind" | "drug" | "drug_b" | "allergy_name" | "family">,
): { medication_name: string; dose: string; route: string; frequency: string } {
  const fam = (c.family ?? "").toLowerCase();
  if (/penicillin|β-lactam|beta-lactam|cephalosporin/.test(fam))
    return { medication_name: "Vancomycin", dose: "15 mg/kg", route: "IV", frequency: "q12h" };
  if (/sulfonamide/.test(fam))
    return { medication_name: "Nitrofurantoin", dose: "100 mg", route: "PO", frequency: "BID" };
  if (/nsaid|bleeding|antiplatelet|anticoagulant/.test(fam))
    return { medication_name: "Acetaminophen", dose: "650 mg", route: "PO", frequency: "q6h prn pain" };
  if (/opioid|respiratory depression/.test(fam))
    return { medication_name: "Hydroxyzine", dose: "25 mg", route: "PO", frequency: "q6h prn" };
  if (/serotonin/.test(fam))
    return { medication_name: "Acetaminophen", dose: "650 mg", route: "PO", frequency: "q6h" };
  if (/cyp2c19|clopidogrel/.test(fam))
    return { medication_name: "Pantoprazole", dose: "40 mg", route: "PO", frequency: "Daily" };
  if (/hyperkalemia/.test(fam))
    return { medication_name: "Hydrochlorothiazide", dose: "25 mg", route: "PO", frequency: "Daily" };
  if (/inr|warfarin potentiation/.test(fam))
    return { medication_name: "Cephalexin", dose: "500 mg", route: "PO", frequency: "QID" };
  if (/lactic acidosis|contrast/.test(fam))
    return { medication_name: "Insulin sliding scale", dose: "per protocol", route: "SubQ", frequency: "AC & HS" };
  if (/rhabdomyolysis|statin/.test(fam))
    return { medication_name: "Pravastatin", dose: "40 mg", route: "PO", frequency: "qHS" };
  if (/digoxin/.test(fam))
    return { medication_name: "Digoxin (dose-reduced)", dose: "0.125 mg", route: "PO", frequency: "Daily" };
  if (/contrast|iodinated/.test(fam))
    return { medication_name: "Gadolinium MR contrast", dose: "0.1 mmol/kg", route: "IV", frequency: "once" };
  return { medication_name: "Acetaminophen", dose: "650 mg", route: "PO", frequency: "q6h prn" };
}

/* ------------------------------------------------------------------ */
/*  Look up ordering physician for the linked medication order.        */
/* ------------------------------------------------------------------ */
export async function lookupOrderingPhysician(medOrderId: string | null): Promise<string> {
  if (!medOrderId) return "Attending Physician";
  const { data } = await supabase
    .from("medication_orders")
    .select("ordering_physician")
    .eq("id", medOrderId)
    .maybeSingle();
  const name = (data as any)?.ordering_physician;
  return name && String(name).trim() ? String(name) : "Attending Physician";
}

/* ------------------------------------------------------------------ */
/*  Side-effects when an alert resolves (manual or SLA auto).          */
/* ------------------------------------------------------------------ */
export async function resolveAlertSideEffects(
  c: DbSafetyAlert,
  status: "Overridden" | "Rejected",
  physicianName: string,
  rationale: string,
): Promise<void> {
  const decidedAt = new Date().toISOString();

  try {
    await supabase.from("cds_overrides").insert({
      mrn: c.mrn,
      alert_type: c.kind,
      severity: c.severity ?? "high",
      drug_name: c.drug,
      condition_name:
        c.kind === "Drug-Drug" ? (c.drug_b ?? null) : (c.allergy_name ?? null),
      reason: rationale,
      physician_name: physicianName,
      fired_at: decidedAt,
      decision: status,
      patient_name: c.patient_name,
      facility_name: c.facility_name,
      risk_score: c.risk_score,
    } as any);
  } catch (e: any) {
    console.warn("[safety] cds_overrides insert failed", e?.message);
  }

  if (!c.medication_order_id) return;

  if (status === "Overridden") {
    await supabase
      .from("medication_orders")
      .update({ status: "PENDING_PHARMACY", updated_at: decidedAt })
      .eq("id", c.medication_order_id);
    return;
  }

  const { data: original } = await supabase
    .from("medication_orders")
    .select("patient_mrn, mrn, patient_name, facility_name, drug_name, medication_name")
    .eq("id", c.medication_order_id)
    .maybeSingle();

  await supabase
    .from("medication_orders")
    .update({ status: "REJECTED_SAFETY_ALERT", updated_at: decidedAt })
    .eq("id", c.medication_order_id);

  if (!original) return;
  const alt = buildAlternateMed(c);
  const originalName =
    (original as any).drug_name ??
    (original as any).medication_name ??
    c.drug ??
    "prior order";
  const displayName = `${alt.medication_name} (auto-substitute for rejected ${originalName})`;
  try {
    await supabase.from("medication_orders").insert({
      patient_mrn: (original as any).patient_mrn ?? (original as any).mrn ?? c.mrn,
      mrn: (original as any).mrn ?? c.mrn,
      patient_name: (original as any).patient_name ?? c.patient_name,
      facility_name: (original as any).facility_name ?? c.facility_name,
      drug_name: displayName,
      medication_name: displayName,
      dose: alt.dose,
      route: alt.route,
      frequency: alt.frequency,
      status: "PENDING_PHARMACY",
      ordering_physician: physicianName,
      coding_source: "safety-substitution",
      term_status: `Auto-substituted alternate for rejected order: ${originalName}`,
      created_by_type: "automation",
    } as any);
  } catch (e: any) {
    console.warn("[safety] alternate med insert failed", e?.message);
  }
}