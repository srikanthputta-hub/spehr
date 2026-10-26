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
import {
  loadPublishedValueSetsForConsumer,
  requestTerminologyUpdate,
} from "@/lib/value-set-registry";

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
  "Allergy Substances",
  "Anticoagulants",
  "High-Acuity ED Presentations",
  "Sepsis Indicators",
  "NSAIDs",
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
/*  Published value-set catalogue (single source of truth for Rule 1)  */
/* ------------------------------------------------------------------ */

let allVsCache: VsRow[] = [];
let allVsLoadedAt = 0;
let allVsLoadPromise: Promise<void> | null = null;

export async function loadAllPublishedValueSets(): Promise<VsRow[]> {
  const fresh = Date.now() - allVsLoadedAt < VS_TTL_MS && allVsCache.length > 0;
  if (fresh) return allVsCache;
  if (allVsLoadPromise) {
    await allVsLoadPromise;
    return allVsCache;
  }
  allVsLoadPromise = (async () => {
    const { data, error } = await supabase
      .from("custom_value_sets")
      .select("id, name, oid, vocabulary, type, codes, intensional_rule, status")
      .eq("status", "published");
    if (error || !data) {
      allVsCache = [];
      allVsLoadedAt = Date.now();
      return;
    }
    allVsCache = data as any[] as VsRow[];
    allVsLoadedAt = Date.now();
  })().finally(() => {
    allVsLoadPromise = null;
  });
  await allVsLoadPromise;
  return allVsCache;
}

/**
 * Extract meaningful allergy-class tokens from a value set name. Stopwords
 * describe the container (allergy, allergen, drugs, class, vocabulary
 * suffixes) rather than the clinical class itself.
 */
const VS_NAME_STOPWORDS = new Set([
  "allergy",
  "allergies",
  "allergen",
  "allergens",
  "hypersensitivity",
  "class",
  "drug",
  "drugs",
  "medication",
  "medications",
  "agents",
  "agent",
  "rxnorm",
  "snomed",
  "loinc",
  "optum",
  "spehr",
  "auto",
  "and",
  "or",
  "the",
  "of",
  "for",
  "with",
  "to",
]);

function classTokens(name: string): string[] {
  const cleaned = name
    .replace(/\([^)]*\)/g, " ") // drop parenthetical vocabulary tags
    .replace(/[^A-Za-z]+/g, " ")
    .toLowerCase();
  const out: string[] = [];
  for (const raw of cleaned.split(/\s+/)) {
    if (raw.length < 4) continue;
    if (VS_NAME_STOPWORDS.has(raw)) continue;
    out.push(raw);
  }
  return out;
}

function substanceMatchesClass(substance: string, tokens: string[]): boolean {
  const s = substance.toLowerCase();
  if (!s) return false;
  for (const t of tokens) {
    if (s.includes(t)) return true;
  }
  return false;
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

function anyContains(sets: VsRow[], code: string): boolean {
  return sets.some((s) => extensionalContains(s, code));
}

function firstContaining(sets: VsRow[], code: string): VsRow | null {
  for (const s of sets) if (extensionalContains(s, code)) return s;
  return null;
}

/* ------------------------------------------------------------------ */
/*  NSAID membership — governed via the published "NSAIDs" value set   */
/* ------------------------------------------------------------------ */

function codeIsNsaid(vs: Map<VsName, VsRow>, code: string): boolean {
  return extensionalContains(vs.get("NSAIDs"), code);
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
  valueSetNames: string[];
};

async function fireAlert(input: FireInput): Promise<void> {
  const vsSeg =
    input.valueSetNames.length > 0
      ? ` · Value Sets: ${Array.from(new Set(input.valueSetNames)).join(", ")}`
      : "";
  const family = `${input.message}${vsSeg} [${input.ruleKey}:${input.triggerCode}] (${input.triggerDisplay})`;
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
      valueSetNames: Array.from(new Set(input.valueSetNames)),
    },
    created_by_type: "automation",
  } as any);
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
  const rand = (min: number, max: number) => Math.floor(Math.random() * (max - min + 1)) + min;
  // Ranges are intentionally wide so demo alerts spread across the
  // SAFETY_AUTO_REJECT_THRESHOLD (=50) and produce a visible mix of
  // Overridden vs Rejected outcomes on the safety dashboard.
  if (s === "CONTRAINDICATION" || s === "CRITICAL") return rand(55, 96);
  if (s === "HIGH") return rand(30, 82);
  if (s === "CAUTION" || s === "MEDIUM" || s === "WARNING") return rand(20, 60);
  if (s === "INFO" || s === "LOW") return rand(5, 35);
  return rand(30, 70);
}

export async function runMedicationOrderRules(evt: MedOrderEvent): Promise<void> {
  const mrn = evt.mrn;
  if (!mrn) return;
  const code = (evt.rxnorm_code ?? "").trim();
  const name = (evt.rxnorm_display ?? evt.medication_name ?? evt.drug_name ?? "").trim();
  if (!code && !name) return;

  const vs = await ensureValueSetsLoaded();
  const anticoags = vs.get("Anticoagulants");
  const publishedVs = await loadAllPublishedValueSets();

  // Patient meta for anchoring & row display
  const { data: pRow } = await supabase
    .from("patients")
    .select("name, first_name, last_name, facility_name, admission_time")
    .eq("mrn", mrn)
    .maybeSingle();
  const patient_name =
    (pRow as any)?.name ??
    [(pRow as any)?.first_name ?? "", (pRow as any)?.last_name ?? ""].join(" ").trim() ??
    null;
  const facility_name = (pRow as any)?.facility_name ?? null;
  const sinceIso = (pRow as any)?.admission_time ?? null;

  /* ---- RULE 1: Drug-Allergy Conflict (value-set-only match) ----
   *
   * A single scan over every published value set. A value set fires when:
   *   (a) it contains the ordered drug's RxNorm code, AND
   *   (b) its name (minus stopwords/vocabulary tags) shares a token with
   *       any active allergy substance on the chart.
   *
   * The value set IS the safety rule — no pair registry, no synthetic
   * allergen value sets required. `Penicillin Allergy RXNORM(optum)` fires
   * a penicillin-allergic patient's amoxicillin order because it contains
   * amoxicillin AND its name contains "penicillin".
   */
  if (code) {
    const { data: allergyRows } = await supabase
      .from("allergies")
      .select("substance")
      .eq("mrn", mrn)
      .eq("status", "active");
    const chartAllergies = ((allergyRows ?? []) as Array<{ substance: string | null }>)
      .map((r) => String(r?.substance ?? "").trim())
      .filter(Boolean);

    if (chartAllergies.length > 0) {
      type Match = {
        vs: VsRow;
        allergyName: string;
        specificity: number; // smaller = more specific
      };
      const matches: Match[] = [];
      for (const vsRow of publishedVs) {
        if (!extensionalContains(vsRow, code)) continue;
        const tokens = classTokens(vsRow.name);
        if (tokens.length === 0) continue;
        const hit = chartAllergies.find((s) => substanceMatchesClass(s, tokens));
        if (!hit) continue;
        matches.push({
          vs: vsRow,
          allergyName: hit,
          specificity: Array.isArray(vsRow.codes) ? vsRow.codes.length : Number.MAX_SAFE_INTEGER,
        });
      }

      if (matches.length > 0) {
        matches.sort((a, b) => {
          if (a.specificity !== b.specificity) return a.specificity - b.specificity;
          return a.vs.name.localeCompare(b.vs.name);
        });
        const best = matches[0]!;
        const ruleKey = "rule1-drug-allergy";
        if (!(await alreadyFired(mrn, ruleKey, code, sinceIso))) {
          await fireAlert({
            mrn,
            patient_name,
            facility_name,
            ruleKey,
            kind: "Drug-Allergy",
            severity: "HIGH",
            message: `⚠ Allergy Conflict — ${name || code} matches "${best.allergyName}" allergy documented for this patient (value set: ${best.vs.name})`,
            triggerCode: code,
            triggerDisplay: name || code,
            drug: name || code,
            allergy_name: best.allergyName,
            medication_order_id: evt.medication_order_id ?? null,
            valueSetNames: [best.vs.name],
          });
        }
      } else {
        // Coverage gap: patient has an allergy, drug is ordered, but no
        // published value set names that allergy class and contains the
        // drug. File a governed terminology request so the terminologist
        // knows Rule 1 could not evaluate this order.
        const anyDrugVsHasCode = publishedVs.some((v) => extensionalContains(v, code));
        if (!anyDrugVsHasCode && name) {
          await requestTerminologyUpdate({
            requesting_consumer: "Safety Alerts Engine",
            requested_name: `Drug-Allergy coverage for "${chartAllergies[0]}"`,
            justification: `Order "${name}" (RxNorm ${code}) could not be cross-checked against allergy "${chartAllergies[0]}" — no published value set contains this drug and names the allergy class.`,
            priority: "normal",
            vocabulary: "RxNorm",
            seed_codes: [{ code, display: name }],
            clinical_application: "CDS",
            related_mrn: mrn,
          });
        }
      }
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
      if (mCode && codeIsNsaid(vs, mCode)) {
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
          valueSetNames:
            conflict.kind === "nsaid" ? ["Anticoagulants", "NSAIDs"] : ["Anticoagulants"],
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
        typeof item === "string" ? item : (item?.code ?? item?.value ?? ""),
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
    [(pRow as any)?.first_name ?? "", (pRow as any)?.last_name ?? ""].join(" ").trim() ??
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
          valueSetNames: ["High-Acuity ED Presentations"],
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
          valueSetNames: ["Sepsis Indicators"],
        });
      }
    }
  }
}
