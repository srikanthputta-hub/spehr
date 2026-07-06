/**
 * Safety Alerts Engine.
 *
 * Fires the four rule-based alerts driven by the *published* value sets in
 * `custom_value_sets` (looked up by name, never by hardcoded OID):
 *
 *   1. Drug-Allergy Conflict     — Penicillin Class Drugs × Allergy Substances
 *   2. Anticoagulant Bleeding    — Anticoagulants × (Anticoagulants | NSAID)
 *   3. High-Acuity Triage        — High-Acuity ED Presentations
 *   4. Sepsis Bundle             — Sepsis Indicators
 *
 * Writes to `clinical_safety_alerts` (one row per patient / admission /
 * trigger code) and mirrors an error line into `auto_doc_logs`. Never
 * auto-resolves — clinician must dismiss manually (auto_resolve_at = null).
 */

import { supabase } from "@/integrations/supabase/client";
import { loadPublishedValueSetsForConsumer } from "@/lib/value-set-registry";

/* ------------------------------------------------------------------ */
/*  Value-set cache                                                    */
/* ------------------------------------------------------------------ */

type VsRow = {
  id: string;
  name: string;
  oid: string | null;
  vocabulary: string | null;
  type: string;
  codes: Array<{ code: string; display?: string }> | null;
  intensional_rule: any;
};

const VS_NAMES = [
  "Penicillin Class Drugs",
  "Allergy Substances",
  "Anticoagulants",
  "High-Acuity ED Presentations",
  "Sepsis Indicators",
] as const;

type VsName = (typeof VS_NAMES)[number];

let vsCache = new Map<VsName, VsRow>();
let vsLoadedAt = 0;
let vsLoadPromise: Promise<void> | null = null;
const VS_TTL_MS = 5 * 60_000;

export async function ensureValueSetsLoaded(): Promise<Map<VsName, VsRow>> {
  const fresh = Date.now() - vsLoadedAt < VS_TTL_MS && vsCache.size > 0;
  if (fresh) return vsCache;
  if (vsLoadPromise) {
    await vsLoadPromise;
    return vsCache;
  }
  vsLoadPromise = (async () => {
    const hits = await loadPublishedValueSetsForConsumer({
      consumer: "Safety Alerts Engine",
    });
    const next = new Map<VsName, VsRow>();
    for (const { value_set_name, row } of hits) {
      if ((VS_NAMES as readonly string[]).includes(value_set_name)) {
        next.set(value_set_name as VsName, row as VsRow);
      }
    }
    vsCache = next;
    vsLoadedAt = Date.now();
  })().finally(() => {
    vsLoadPromise = null;
  });
  await vsLoadPromise;
  return vsCache;
}

/* ------------------------------------------------------------------ */
/*  Membership checks                                                  */
/* ------------------------------------------------------------------ */

function extensionalContains(vs: VsRow | undefined, code: string): boolean {
  if (!vs || !Array.isArray(vs.codes)) return false;
  const c = String(code).trim();
  if (!c) return false;
  return vs.codes.some((r) => String(r?.code ?? "").trim() === c);
}

/**
 * Intensional membership via the existing UMLS validate-code proxy.
 * Returns { valid, unavailable } — on network / upstream failure the caller
 * MUST fail open (skip the rule) and log an error.
 */
async function intensionalContains(
  vs: VsRow | undefined,
  system: string,
  code: string,
): Promise<{ valid: boolean; unavailable: boolean }> {
  if (!vs || !vs.oid) return { valid: false, unavailable: false };
  try {
    const r = await fetch("/api/public/umls-validate-code", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ system, code, valueSetOid: vs.oid }),
    });
    if (!r.ok) return { valid: false, unavailable: true };
    const j = (await r.json()) as { ok?: boolean; valid?: boolean; error?: string };
    if (!j.ok) return { valid: false, unavailable: true };
    return { valid: !!j.valid, unavailable: false };
  } catch {
    return { valid: false, unavailable: true };
  }
}

/* ------------------------------------------------------------------ */
/*  NSAID whitelist — no published value set exists for this class     */
/* ------------------------------------------------------------------ */

// RxNorm SCUIs / names (lower-cased) for common NSAIDs used clinically.
const NSAID_NAMES = [
  "ibuprofen",
  "naproxen",
  "ketorolac",
  "aspirin",
  "diclofenac",
  "meloxicam",
  "celecoxib",
  "indomethacin",
  "piroxicam",
  "ketoprofen",
];

function nameLooksLikeNsaid(name: string): boolean {
  const n = (name ?? "").toLowerCase();
  return NSAID_NAMES.some((k) => n.includes(k));
}

/* ------------------------------------------------------------------ */
/*  Dedup — once per patient per admission per triggering code         */
/* ------------------------------------------------------------------ */

async function admissionAnchor(mrn: string): Promise<string | null> {
  const { data } = await supabase
    .from("patients")
    .select("admission_time")
    .eq("mrn", mrn)
    .maybeSingle();
  return (data as any)?.admission_time ?? null;
}

async function alreadyFired(
  mrn: string,
  ruleKey: string,
  triggerCode: string,
  sinceIso: string | null,
): Promise<boolean> {
  const marker = `[${ruleKey}:${triggerCode}]`;
  let q = supabase
    .from("clinical_safety_alerts")
    .select("id, family, created_at")
    .eq("mrn", mrn)
    .ilike("family", `%${marker}%`)
    .limit(1);
  if (sinceIso) q = q.gte("created_at", sinceIso);
  const { data } = await q;
  return (data?.length ?? 0) > 0;
}

/* ------------------------------------------------------------------ */
/*  Firing                                                             */
/* ------------------------------------------------------------------ */

type FireInput = {
  mrn: string;
  patient_name?: string | null;
  facility_name?: string | null;
  ruleKey: string;
  kind: "Drug-Allergy" | "Drug-Drug" | "Clinical-Acuity";
  message: string;
  severity: "HIGH" | "CRITICAL";
  triggerCode: string;
  triggerDisplay: string;
  drug: string;
  drug_b?: string | null;
  allergy_name?: string | null;
  medication_order_id?: string | null;
};

async function fireAlert(input: FireInput): Promise<void> {
  const family = `${input.message} [${input.ruleKey}:${input.triggerCode}] (${input.triggerDisplay})`;
  const severityLevel =
    input.severity === "HIGH" || input.severity === "CRITICAL" ? "high" : "medium";
  const row: Record<string, any> = {
    mrn: input.mrn,
    patient_name: input.patient_name ?? null,
    facility_name: input.facility_name ?? null,
    kind: input.kind,
    drug: input.drug,
    drug_b: input.drug_b ?? null,
    allergy_name: input.allergy_name ?? null,
    family,
    severity: severityLevel,
    status: "Pending Review",
    auto_resolve_at: new Date(Date.now() + 45_000).toISOString(),
    risk_score: riskScoreFor(input.severity),
    medication_order_id: input.medication_order_id ?? null,
    rule_id: input.ruleKey,
    created_by_type: "automation",
    updated_at: new Date().toISOString(),
  };
  // Race-safe insert: a unique index on (medication_order_id, rule_id) prevents
  // duplicates even when two concurrent callers both pass alreadyFired(). Any
  // unique-violation (23505) means another caller won the race — treat it as
  // success (no duplicate side effects) and stop before holding the order or
  // writing a duplicate audit-log line.
  const { data: inserted, error } = await supabase
    .from("clinical_safety_alerts")
    .insert(row as any)
    .select("id");
  if (error) {
    if ((error as any).code === "23505") return;
    // eslint-disable-next-line no-console
    console.warn("[safety-alerts] insert failed", error.message);
    return;
  }
  if (!inserted || inserted.length === 0) return;
  // Hold the offending medication order while the alert is pending review.
  if (input.medication_order_id) {
    await supabase
      .from("medication_orders")
      .update({ status: "HELD_SAFETY_REVIEW", updated_at: new Date().toISOString() })
      .eq("id", input.medication_order_id);
  }
  await supabase.from("auto_doc_logs").insert({
    mrn: input.mrn,
    stage: "safety-alert",
    level: "error",
    message: input.message,
    meta: {
      ruleKey: input.ruleKey,
      kind: input.kind,
      severity: input.severity,
      triggerCode: input.triggerCode,
      triggerDisplay: input.triggerDisplay,
      drug: input.drug,
      drug_b: input.drug_b ?? null,
      allergy_name: input.allergy_name ?? null,
    },
    created_by_type: "automation",
  } as any);
}

async function logProxyFailure(mrn: string, ruleKey: string, note: string) {
  try {
    await supabase.from("auto_doc_logs").insert({
      mrn,
      stage: "safety-alert",
      level: "error",
      message: `Safety alert value-set validation unavailable (${ruleKey}) — failing open`,
      meta: { ruleKey, note },
      created_by_type: "automation",
    } as any);
  } catch {
    /* ignore */
  }
}

/* ------------------------------------------------------------------ */
/*  RULE 1 & 2 — Medication order triggers                             */
/* ------------------------------------------------------------------ */

export type MedOrderEvent = {
  mrn: string;
  rxnorm_code?: string | null;
  rxnorm_display?: string | null;
  medication_name?: string | null;
  drug_name?: string | null;
  medication_order_id?: string | null;
};

function riskScoreFor(severity: string | null | undefined): number {
  const s = String(severity ?? "").toUpperCase();
  if (s === "CONTRAINDICATION" || s === "CRITICAL" || s === "HIGH") return 85;
  if (s === "CAUTION" || s === "MEDIUM" || s === "WARNING") return 55;
  if (s === "INFO" || s === "LOW") return 25;
  return 50;
}

export async function runMedicationOrderRules(evt: MedOrderEvent): Promise<void> {
  const mrn = evt.mrn;
  if (!mrn) return;
  const code = (evt.rxnorm_code ?? "").trim();
  const name = (evt.rxnorm_display ?? evt.medication_name ?? evt.drug_name ?? "").trim();
  if (!code && !name) return;

  const vs = await ensureValueSetsLoaded();
  const penicillins = vs.get("Penicillin Class Drugs");
  const allergies = vs.get("Allergy Substances");
  const anticoags = vs.get("Anticoagulants");

  // Patient meta for anchoring & row display
  const { data: pRow } = await supabase
    .from("patients")
    .select("name, first_name, last_name, facility_name, admission_time")
    .eq("mrn", mrn)
    .maybeSingle();
  const patient_name =
    (pRow as any)?.name ??
    [((pRow as any)?.first_name ?? ""), ((pRow as any)?.last_name ?? "")].join(" ").trim() ??
    null;
  const facility_name = (pRow as any)?.facility_name ?? null;
  const sinceIso = (pRow as any)?.admission_time ?? null;

  /* ---- RULE 1: Drug-Allergy Conflict ---- */
  const isPenicillin = !!code && extensionalContains(penicillins, code);
  if (isPenicillin) {
    const { data: allergyRows } = await supabase
      .from("allergies")
      .select("substance, substance_snomed")
      .eq("mrn", mrn);
    let matched: { substance: string; snomed: string } | null = null;
    let anyUnavailable = false;
    for (const a of (allergyRows ?? []) as any[]) {
      const snomed = String(a?.substance_snomed ?? "").trim();
      if (!snomed) continue;
      const res = await intensionalContains(allergies, "http://snomed.info/sct", snomed);
      if (res.unavailable) {
        anyUnavailable = true;
        continue;
      }
      if (res.valid) {
        matched = { substance: String(a?.substance ?? ""), snomed };
        break;
      }
    }
    if (matched) {
      const ruleKey = "rule1-drug-allergy";
      if (!(await alreadyFired(mrn, ruleKey, code, sinceIso))) {
        await fireAlert({
          mrn,
          patient_name,
          facility_name,
          ruleKey,
          kind: "Drug-Allergy",
          severity: "HIGH",
          message: `⚠ Allergy Conflict — ${name || code} belongs to a drug class the patient is allergic to`,
          triggerCode: code,
          triggerDisplay: name || code,
          drug: name || code,
          allergy_name: matched.substance,
          medication_order_id: evt.medication_order_id ?? null,
        });
      }
    } else if (anyUnavailable) {
      await logProxyFailure(mrn, "rule1-drug-allergy", "UMLS ancestor lookup unavailable");
    }
  }

  /* ---- RULE 2: Anticoagulant Bleeding Risk ---- */
  const isAnticoag = !!code && extensionalContains(anticoags, code);
  if (isAnticoag) {
    const { data: activeMeds } = await supabase
      .from("medication_orders")
      .select("rxnorm_code, medication_name, drug_name, status, ordered_at, created_at")
      .eq("patient_mrn", mrn);
    let conflict: { name: string; code: string; kind: "anticoag" | "nsaid" } | null = null;
    for (const m of (activeMeds ?? []) as any[]) {
      const mCode = String(m?.rxnorm_code ?? "").trim();
      const mName = String(m?.medication_name ?? m?.drug_name ?? "").trim();
      if (mCode === code && (mName || "").toLowerCase() === (name || "").toLowerCase()) continue; // self
      if (mCode && extensionalContains(anticoags, mCode) && mCode !== code) {
        conflict = { name: mName || mCode, code: mCode, kind: "anticoag" };
        break;
      }
      if (nameLooksLikeNsaid(mName)) {
        conflict = { name: mName, code: mCode, kind: "nsaid" };
        break;
      }
    }
    if (conflict) {
      const ruleKey = "rule2-anticoag-bleed";
      if (!(await alreadyFired(mrn, ruleKey, code, sinceIso))) {
        await fireAlert({
          mrn,
          patient_name,
          facility_name,
          ruleKey,
          kind: "Drug-Drug",
          severity: "HIGH",
          message: `⚠ Bleeding Risk — concurrent anticoagulant therapy detected`,
          triggerCode: code,
          triggerDisplay: name || code,
          drug: name || code,
          drug_b: conflict.name,
          medication_order_id: evt.medication_order_id ?? null,
        });
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/*  RULE 3 & 4 — NLP approval triggers                                 */
/* ------------------------------------------------------------------ */

function extractSnomedCodes(std: any): Array<{ code: string; display: string }> {
  if (!std || typeof std !== "object") return [];

  const out: Array<{ code: string; display: string }> = [];

  const seen = new Set<string>();

  // 6-stream structure: stream_a and stream_b carry SNOMED codes
  for (const key of ["stream_a", "stream_b"]) {
    const arr = (std as any)[key];
    if (!Array.isArray(arr)) continue;
    for (const item of arr) {
      const code = String(item?.snomed_code ?? "").trim();
      const display = String(item?.snomed_display ?? item?.display_text ?? item?.term ?? "").trim();
      if (!code || seen.has(code)) continue;
      seen.add(code);
      out.push({ code, display: display || code });
    }
  }

  // Legacy fallback: top-level SNOMED CT key
  for (const k of ["SNOMED CT", "snomed", "SNOMED", "snomed_ct"]) {
    const arr = (std as any)[k];
    if (!Array.isArray(arr)) continue;
    for (const item of arr) {
      const code = String(
        typeof item === "string" ? item : (item?.code ?? item?.value ?? "")
      ).trim();
      const display = String(item?.display ?? item?.name ?? "").trim();
      if (!code || seen.has(code)) continue;
      seen.add(code);
      out.push({ code, display: display || code });
    }
  }

  return out;
}

export async function runNlpApprovalRules(auditRow: {
  patient_mrn: string;
  standardized_output: any;
  status?: string | null;
}): Promise<void> {
  if (!auditRow?.patient_mrn) return;
  if ((auditRow.status ?? "").toLowerCase() !== "approved") return;
  const codes = extractSnomedCodes(auditRow.standardized_output);
  if (codes.length === 0) return;

  const vs = await ensureValueSetsLoaded();
  const highAcuity = vs.get("High-Acuity ED Presentations");
  const sepsis = vs.get("Sepsis Indicators");

  const { data: pRow } = await supabase
    .from("patients")
    .select("name, first_name, last_name, facility_name, admission_time")
    .eq("mrn", auditRow.patient_mrn)
    .maybeSingle();
  const patient_name =
    (pRow as any)?.name ??
    [((pRow as any)?.first_name ?? ""), ((pRow as any)?.last_name ?? "")].join(" ").trim() ??
    null;
  const facility_name = (pRow as any)?.facility_name ?? null;
  const sinceIso = (pRow as any)?.admission_time ?? null;

  for (const { code, display } of codes) {
    if (extensionalContains(highAcuity, code)) {
      const ruleKey = "rule3-high-acuity";
      if (!(await alreadyFired(auditRow.patient_mrn, ruleKey, code, sinceIso))) {
        await fireAlert({
          mrn: auditRow.patient_mrn,
          patient_name,
          facility_name,
          ruleKey,
          kind: "Clinical-Acuity",
          severity: "CRITICAL",
          message: `🔴 High-Acuity Presentation — immediate physician review required`,
          triggerCode: code,
          triggerDisplay: display,
          drug: display,
        });
      }
    }
    if (extensionalContains(sepsis, code)) {
      const ruleKey = "rule4-sepsis";
      if (!(await alreadyFired(auditRow.patient_mrn, ruleKey, code, sinceIso))) {
        await fireAlert({
          mrn: auditRow.patient_mrn,
          patient_name,
          facility_name,
          ruleKey,
          kind: "Clinical-Acuity",
          severity: "CRITICAL",
          message: `🔴 Sepsis Indicator — initiate 3-hour bundle protocol`,
          triggerCode: code,
          triggerDisplay: display,
          drug: display,
        });
      }
    }
  }
}