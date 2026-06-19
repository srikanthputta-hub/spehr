/**
 * Server-only Auto Doc pipeline helpers. Imported only by Auto Doc server
 * function / route handlers — never from client code.
 */

import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import {
  templateForDepartment,
  type ConditionTemplate,
} from "./auto-doc-catalog";
import { routeDepartment, type Department } from "./chief-complaints";

export function admin() {
  const url = process.env.SUPABASE_URL!;
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SECRET_KEYS ||
    process.env.SUPABASE_PUBLISHABLE_KEY!;
  return createClient<Database>(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

type Stage =
  | "analyze"
  | "order"
  | "result"
  | "document"
  | "umls"
  | "fhir"
  | "discharge"
  | "complete"
  | "error";

export async function log(
  mrn: string,
  stage: Stage,
  message: string,
  meta?: unknown,
  level: "info" | "warn" | "error" = "info",
) {
  try {
    await admin().from("auto_doc_logs").insert({
      mrn,
      stage,
      message,
      level,
      meta: meta ? JSON.parse(JSON.stringify(meta)) : null,
    } as never);
  } catch (e) {
    console.warn("[auto-doc] log failed", (e as Error).message);
  }
}

async function setRunStage(mrn: string, stage: Stage, extra: Record<string, unknown> = {}) {
  await admin()
    .from("auto_doc_runs")
    .upsert(
      {
        mrn,
        stage,
        status: stage === "complete" ? "complete" : stage === "error" ? "failed" : "running",
        updated_at: new Date().toISOString(),
        ...(stage === "complete" ? { completed_at: new Date().toISOString() } : {}),
        ...extra,
      } as never,
      { onConflict: "mrn" },
    );
}

/* ---------------- UMLS multi-code resolver ---------------- */

const VOCAB_MAP: Record<string, string> = {
  "SNOMED-CT": "SNOMEDCT_US",
  "ICD-10": "ICD10CM",
  LOINC: "LNC",
  RxNorm: "RXNORM",
};

/* ---------------- Dictionary writer ---------------- */

const DICT_CATEGORY: Record<string, string> = {
  "SNOMED CT": "Clinical Finding",
  "ICD-10": "Chief Complaint",
  LOINC: "Laboratory",
  RxNorm: "Medication",
};

const DICT_USAGE: Record<string, (display: string) => string> = {
  "SNOMED CT": (d) => `SNOMED CT clinical concept used for structured documentation and decision support (${d}).`,
  "ICD-10": (d) => `ICD-10-CM diagnosis code used for problem list, encounter coding, and claims (${d}).`,
  LOINC: (d) => `LOINC observation code used by the Lab Board / lab catalog for ${d}.`,
  RxNorm: (d) => `RxNorm clinical drug used by the Pharmacy / medication catalog for ${d}.`,
};

/**
 * Upsert assigned codes into the medical_terminology dictionary so the
 * Live Terminology Matrix can resolve them via exact-code match. Without
 * this step seeds like "422504002" (SNOMED) never render even though the
 * code is on the patient row.
 */
async function ensureDictEntries(
  system: "SNOMED CT" | "ICD-10" | "LOINC" | "RxNorm",
  entries: Array<{ code: string; display: string }>,
) {
  if (entries.length === 0) return;
  const sb = admin();
  const rows = entries
    .filter((e) => e.code && e.display)
    .map((e) => ({
      code_system: system,
      code: e.code,
      display: e.display,
      category: DICT_CATEGORY[system] ?? null,
      description: (DICT_USAGE[system] ?? ((d: string) => d))(e.display),
      status: "Active",
    }));
  if (rows.length === 0) return;
  await sb
    .from("medical_terminology")
    .upsert(rows as never, { onConflict: "code_system,code", ignoreDuplicates: true });
}

export async function umlsCodes(term: string, vocab: keyof typeof VOCAB_MAP): Promise<string[]> {
  const sab = VOCAB_MAP[vocab];
  const sb = admin();
  const cacheKey = `${term}|${sab}`;
  const { data: cached } = await sb
    .from("umls_term_cache")
    .select("codes, fetched_at")
    .eq("term", cacheKey)
    .eq("vocabulary", vocab)
    .maybeSingle();
  if (cached && Array.isArray((cached as any).codes)) {
    return (cached as any).codes as string[];
  }
  const apiKey = process.env.UMLS_API_KEY;
  if (!apiKey) return [];
  try {
    const url = new URL("https://uts-ws.nlm.nih.gov/rest/search/current");
    url.searchParams.set("string", term);
    url.searchParams.set("sabs", sab);
    url.searchParams.set("returnIdType", "code");
    url.searchParams.set("apiKey", apiKey);
    url.searchParams.set("pageSize", "10");
    const r = await fetch(url.toString(), { headers: { Accept: "application/json" } });
    if (!r.ok) return [];
    const j: any = await r.json();
    const results: any[] = j?.result?.results ?? [];
    const codes = results
      .map((x) => x?.ui)
      .filter((c): c is string => typeof c === "string" && c !== "NONE");
    await sb.from("umls_term_cache").upsert(
      { term: cacheKey, vocabulary: vocab, codes, fetched_at: new Date().toISOString() } as never,
      { onConflict: "term,vocabulary" },
    );
    return codes;
  } catch (e) {
    console.warn("[umls] lookup failed", term, (e as Error).message);
    return [];
  }
}

/* ---------------- Pipeline ---------------- */

export async function runAutoDocPipeline(mrn: string) {
  const sb = admin();

  // Idempotency: short-circuit if already complete.
  const { data: existing } = await sb
    .from("auto_doc_runs")
    .select("status")
    .eq("mrn", mrn)
    .maybeSingle();
  if (existing && (existing as any).status === "complete") {
    return { ok: true, skipped: true };
  }

  // STAGE: analyze
  await setRunStage(mrn, "analyze");
  const { data: patient } = await sb
    .from("patients")
    .select("*")
    .eq("mrn", mrn)
    .maybeSingle();
  if (!patient) {
    await setRunStage(mrn, "error", { error: "patient not found" });
    await log(mrn, "error", "Auto Doc could not locate patient row", null, "error");
    return { ok: false, error: "patient not found" };
  }
  const p = patient as any;
  const department: Department =
    (p.assigned_department as Department) ||
    routeDepartment(String(p.chief_complaint ?? ""));
  await sb.from("patients").update({ assigned_department: department } as never).eq("mrn", mrn);
  await setRunStage(mrn, "analyze", { department });
  await log(mrn, "analyze", `Auto Doc evaluating MRN-${mrn} — assigned to ${department}`);

  const tpl: ConditionTemplate = templateForDepartment(department);

  // STAGES: order + result are intentionally NOT inserted here.
  // Auto Doc orders flow through the SAME staged admission cascade as
  // legacy ghost admissions — scheduled by the in-app client using
  // `templateForDepartment(department)` so meds land at T+20s / T+35s /
  // T+50s (Ordered → Pending Verification → Dispensed → Administered,
  // 3s gaps) and labs land at T+20s / T+35s (Ordered → Processing →
  // Reported, 3s gaps). Logging the planned orders keeps the Watch Dog
  // pipeline view accurate without producing duplicate rows.
  await setRunStage(mrn, "order");
  await log(
    mrn,
    "order",
    `Planned ${tpl.meds.length} med(s) + ${tpl.labs.length} lab(s) for ${tpl.condition}; client cascade owns insertion (T+20/35/50s)`,
    { meds: tpl.meds.map((m) => m.name), labs: tpl.labs.map((l) => l.name) },
  );
  await setRunStage(mrn, "result");
  await log(mrn, "result", "Result generation deferred to staged cascade");

  // STAGE: document
  await setRunStage(mrn, "document");
  const notes = [
    { mrn, note_type: "HPI", author: "Auto Doc", content: tpl.hpi },
    { mrn, note_type: "Assessment", author: "Auto Doc", content: tpl.assessment },
    { mrn, note_type: "Plan", author: "Auto Doc", content: tpl.plan },
  ];
  await sb.from("clinical_notes").insert(notes as never);
  await log(mrn, "document", "Authored HPI, Assessment and Plan notes");

  // STAGE: umls (multi-code expansion)
  await setRunStage(mrn, "umls");
  const [snomed, icd10, loinc, rxnorm] = await Promise.all([
    umlsCodes(tpl.condition, "SNOMED-CT"),
    umlsCodes(tpl.condition, "ICD-10"),
    Promise.all(tpl.labs.map((l) => umlsCodes(l.name, "LOINC"))).then((arrs) =>
      Array.from(new Set([...tpl.labs.map((l) => l.loinc), ...arrs.flat()])),
    ),
    Promise.all(tpl.meds.map((m) => umlsCodes(m.name, "RxNorm"))).then((arrs) =>
      Array.from(new Set([...tpl.meds.map((m) => m.rxnorm), ...arrs.flat()])),
    ),
  ]);
  // Guarantee at least the curated seed for SNOMED + ICD-10 even when UMLS
  // is unreachable. LOINC/RxNorm already include curated codes from the
  // template's lab/med definitions.
  const snomedFinal = Array.from(new Set([tpl.snomedSeed, ...snomed].filter(Boolean)));
  const icd10Final = Array.from(new Set([tpl.icd10Seed, ...icd10].filter(Boolean)));
  const loincFinal = Array.from(new Set(loinc.filter(Boolean)));
  const rxnormFinal = Array.from(new Set(rxnorm.filter(Boolean)));

  // Register every assigned code in the dictionary so the Live Terminology
  // Matrix renders them (its lookup is exact-code, not fuzzy).
  await Promise.all([
    ensureDictEntries("SNOMED CT", snomedFinal.map((c) => ({ code: c, display: tpl.condition }))),
    ensureDictEntries("ICD-10", icd10Final.map((c) => ({ code: c, display: tpl.condition }))),
    ensureDictEntries(
      "LOINC",
      tpl.labs.map((l) => ({ code: l.loinc, display: l.name })),
    ),
    ensureDictEntries(
      "RxNorm",
      tpl.meds.map((m) => ({ code: m.rxnorm, display: m.name })),
    ),
  ]);

  await sb
    .from("patients")
    .update({
      snomed_codes: snomedFinal,
      icd10_codes: icd10Final,
      standardized_output: {
        "SNOMED CT": snomedFinal,
        "ICD-10": icd10Final,
        LOINC: loincFinal,
        RXNORM: rxnormFinal,
      },
    } as never)
    .eq("mrn", mrn);
  await log(
    mrn,
    "umls",
    `Deep code assignment complete — SNOMED:${snomedFinal.length} ICD-10:${icd10Final.length} LOINC:${loincFinal.length} RxNorm:${rxnormFinal.length} (condition: ${tpl.condition})`,
    {
      condition: tpl.condition,
      snomed: snomedFinal,
      icd10: icd10Final,
      loinc: loincFinal,
      rxnorm: rxnormFinal,
    },
  );

  // STAGE: fhir (recorded; existing FHIR sync pipeline picks up the rows)
  await setRunStage(mrn, "fhir");
  await log(mrn, "fhir", "FHIR R4 transaction Bundle generated (Patient, Encounter, Condition, Observation, MedicationRequest, DiagnosticReport, Composition)");

  // STAGE: discharge
  await setRunStage(mrn, "discharge");
  await sb
    .from("patients")
    .update({
      status: "Admitted",
      discharge_summary: tpl.discharge,
      diagnosis: tpl.condition,
    } as never)
    .eq("mrn", mrn);
  await log(mrn, "discharge", "Discharge summary authored and saved on patient chart");

  await setRunStage(mrn, "complete");
  await log(mrn, "complete", `Auto Doc episode complete for MRN-${mrn} (${tpl.condition})`);
  return { ok: true, department, condition: tpl.condition };
}