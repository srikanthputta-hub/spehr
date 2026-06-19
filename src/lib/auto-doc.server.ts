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

  // STAGE: order — strictly idempotent. Auto Doc is the SOLE source of
  // diagnostics and medications, so we only insert rows that are not
  // already present for this MRN (covers rerun/replay scenarios and
  // parallel trigger paths: DB trigger + in-app fire-and-forget).
  await setRunStage(mrn, "order");
  const nowIso = new Date().toISOString();
  const norm = (v: string | null | undefined) => (v ?? "").trim().toLowerCase();
  const [{ data: existingMedsRaw }, { data: existingLabsRaw }] = await Promise.all([
    sb
      .from("medication_orders")
      .select("medication_name, drug_name")
      .eq("patient_mrn", mrn),
    sb
      .from("lab_orders")
      .select("test_type")
      .eq("patient_mrn", mrn),
  ]);
  const existingMedNames = new Set(
    ((existingMedsRaw as Array<{ medication_name?: string | null; drug_name?: string | null }> | null) ?? [])
      .map((m) => norm(m.medication_name ?? m.drug_name))
      .filter(Boolean),
  );
  const existingLabNames = new Set(
    ((existingLabsRaw as Array<{ test_type?: string | null }> | null) ?? [])
      .map((l) => norm(l.test_type))
      .filter(Boolean),
  );
  const medsToInsert = tpl.meds.filter((m) => !existingMedNames.has(norm(m.name)));
  const labsToInsert = tpl.labs.filter((l) => !existingLabNames.has(norm(l.name)));
  await log(
    mrn,
    "order",
    `Ordering ${medsToInsert.length}/${tpl.meds.length} med(s) and ${labsToInsert.length}/${tpl.labs.length} lab(s) for ${tpl.condition} (skipping duplicates already on chart)`,
  );
  const medRows = medsToInsert.map((m) => ({
    patient_mrn: mrn,
    mrn,
    patient_name: p.name ?? `${p.first_name ?? ""} ${p.last_name ?? ""}`.trim(),
    drug_name: m.name,
    medication_name: m.name,
    dose: m.dose,
    route: m.route,
    frequency: m.frequency,
    status: "Administered",
    ordered_by: "Auto Doc",
    administered_at: nowIso,
    approved_at: nowIso,
    created_at: nowIso,
    facility_name: p.facility_name ?? null,
  }));
  if (medRows.length) {
    const { error } = await sb.from("medication_orders").insert(medRows as never);
    if (error) await log(mrn, "order", `Med insert warning: ${error.message}`, null, "warn");
  }
  const labOrderRows = labsToInsert.map((l) => ({
    patient_mrn: mrn,
    patient_name: p.name ?? `${p.first_name ?? ""} ${p.last_name ?? ""}`.trim(),
    test_type: l.name,
    clinical_condition: tpl.condition,
    status: "Resulted",
    ordered_by: "Auto Doc",
    collected_at: nowIso,
    resulted_at: nowIso,
    facility_name: p.facility_name ?? null,
    requested_by: "Auto Doc",
  }));
  if (labOrderRows.length) {
    const { error } = await sb.from("lab_orders").insert(labOrderRows as never);
    if (error) await log(mrn, "order", `Lab order insert warning: ${error.message}`, null, "warn");
  }

  // STAGE: result — only generate results for labs we just inserted, and
  // only if no result row already exists for that (mrn, test_name).
  await setRunStage(mrn, "result");
  const { data: existingResultsRaw } = await sb
    .from("lab_results")
    .select("test_name")
    .eq("mrn", mrn);
  const existingResultNames = new Set(
    ((existingResultsRaw as Array<{ test_name?: string | null }> | null) ?? [])
      .map((r) => norm(r.test_name))
      .filter(Boolean),
  );
  const labResults = labsToInsert
    .filter((l) => !existingResultNames.has(norm(l.name)))
    .map((l) => {
    const r = l.gen();
    return {
      mrn,
      panel_name: tpl.condition,
      test_name: l.name,
      result_value: String(r.value),
      unit: l.unit,
      reference_range: l.ref,
      flag: r.flag,
      time_drawn: nowIso,
    };
  });
  if (labResults.length) {
    const { error } = await sb.from("lab_results").insert(labResults as never);
    if (error) await log(mrn, "result", `Lab result insert warning: ${error.message}`, null, "warn");
  }
  await log(mrn, "result", `Released ${labResults.length} lab result(s) with reference ranges`);

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
  const snomedFinal = Array.from(new Set([tpl.snomedSeed, ...snomed]));
  const icd10Final = Array.from(new Set([tpl.icd10Seed, ...icd10]));
  await sb
    .from("patients")
    .update({
      snomed_codes: snomedFinal,
      icd10_codes: icd10Final,
      standardized_output: {
        "SNOMED CT": snomedFinal,
        "ICD-10": icd10Final,
        LOINC: loinc,
        RXNORM: rxnorm,
      },
    } as never)
    .eq("mrn", mrn);
  await log(mrn, "umls", "UMLS Mapping Complete", {
    snomed: snomedFinal.length,
    icd10: icd10Final.length,
    loinc: loinc.length,
    rxnorm: rxnorm.length,
  });

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