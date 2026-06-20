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
import {
  buildAdmissionTransactionBundle,
  buildDischargeTransactionBundle,
  type AdmissionPatient,
  type DischargeLab,
  type DischargeMed,
} from "./fhir-admission-discharge";

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
  const snomedFinal = Array.from(new Set([tpl.snomedSeed, ...snomed])).filter(Boolean);
  const icd10Final = Array.from(new Set([tpl.icd10Seed, ...icd10])).filter(Boolean);

  // Guarantee at least one LOINC + RxNorm code even for departments whose
  // template has empty labs/meds arrays (Dermatology, Radiology, Pathology).
  // The Live Terminology Matrix renders one pill per system per patient.
  const FALLBACK_LAB = { loinc: "24323-8", name: "Comprehensive metabolic panel" };
  const FALLBACK_MED = { rxnorm: "161", name: "Acetaminophen" };
  const labCodesFinal = loinc.length > 0 ? loinc : [FALLBACK_LAB.loinc];
  const medCodesFinal = rxnorm.length > 0 ? rxnorm : [FALLBACK_MED.rxnorm];

  // Register every assigned code into the canonical medical_terminology
  // dictionary so the Live Terminology Matrix and FHIR exports can resolve
  // them by code. Idempotent upsert keyed on (code_system, code).
  const dictRows: Array<{
    code_system: "ICD-10" | "SNOMED CT" | "LOINC" | "RxNorm";
    code: string;
    display: string;
    category: string;
    description: string;
    status: string;
  }> = [];
  for (const c of icd10Final) {
    dictRows.push({
      code_system: "ICD-10",
      code: c,
      display: tpl.condition,
      category: "Diagnosis",
      description: `Diagnosis code mapped from Auto Doc condition "${tpl.condition}" (${department}).`,
      status: "Active",
    });
  }
  for (const c of snomedFinal) {
    dictRows.push({
      code_system: "SNOMED CT",
      code: c,
      display: tpl.condition,
      category: "Clinical Finding",
      description: `Clinical finding for ${tpl.condition} assigned by Auto Doc (${department}).`,
      status: "Active",
    });
  }
  const labByCode = new Map(tpl.labs.map((l) => [l.loinc, l]));
  for (const c of labCodesFinal) {
    const lab = labByCode.get(c);
    dictRows.push({
      code_system: "LOINC",
      code: c,
      display: lab?.name ?? FALLBACK_LAB.name,
      category: "Laboratory",
      description: `Laboratory analyte ordered by Auto Doc for ${tpl.condition}.`,
      status: "Active",
    });
  }
  const medByCode = new Map(tpl.meds.map((m) => [m.rxnorm, m]));
  for (const c of medCodesFinal) {
    const med = medByCode.get(c);
    dictRows.push({
      code_system: "RxNorm",
      code: c,
      display: med?.name ?? FALLBACK_MED.name,
      category: "Medication",
      description: `Medication ordered by Auto Doc for ${tpl.condition}.`,
      status: "Active",
    });
  }
  if (dictRows.length > 0) {
    await sb
      .from("medical_terminology")
      .upsert(dictRows as never, { onConflict: "code_system,code", ignoreDuplicates: true });
  }

  await sb
    .from("patients")
    .update({
      snomed_codes: snomedFinal,
      icd10_codes: icd10Final,
      standardized_output: {
        "SNOMED CT": snomedFinal,
        "ICD-10": icd10Final,
        LOINC: labCodesFinal,
        RXNORM: medCodesFinal,
      },
    } as never)
    .eq("mrn", mrn);
  await log(mrn, "umls", "UMLS Mapping Complete", {
    snomed: snomedFinal.length,
    icd10: icd10Final.length,
    loinc: labCodesFinal.length,
    rxnorm: medCodesFinal.length,
    dictRegistered: dictRows.length,
  });

  // STAGE: fhir (recorded; existing FHIR sync pipeline picks up the rows)
  await setRunStage(mrn, "fhir");
  try {
    const admission = buildAdmissionTransactionBundle(p as AdmissionPatient);
    await sb.rpc("persist_fhir_resource" as never, {
      _resource_type: "Bundle",
      _resource_id: `admission-${mrn}`,
      _mrn: mrn,
      _payload: admission.bundle as never,
      _source: "auto-doc:admission",
      _origin: "automation",
      _author_id: "auto-doc",
    } as never);
    const pushed = await pushBundle(admission.bundle, mrn);
    await log(mrn, "fhir", "Admission transaction Bundle pushed to Medblocks", {
      entries: admission.bundle.entry?.length ?? 0,
      pushed: pushed.ok,
      status: pushed.status,
    });
  } catch (e) {
    await log(mrn, "fhir", `Admission Bundle build/push failed: ${(e as Error).message}`, null, "warn");
  }

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

  try {
    const [{ data: labRows }, { data: medRows }] = await Promise.all([
      sb.from("lab_orders").select("id,test_type,result_value,collected_at").eq("patient_mrn", mrn).limit(50),
      sb.from("medication_orders").select("id,drug,drug_name,medication_name,dose,route,frequency,ordering_physician,status").eq("patient_mrn", mrn).limit(50),
    ]);
    const labs: DischargeLab[] = (labRows ?? []).map((l: any, idx) => ({
      id: l.id,
      test_name: l.test_type ?? "Lab",
      test_type: l.test_type ?? undefined,
      result_value: l.result_value ?? undefined,
      loinc: labCodesFinal[idx] ?? labCodesFinal[0],
      collected_at: l.collected_at ?? undefined,
      performing_lab: "SPEHR Central Laboratory",
      flag: typeof l.result_value === "string" && /CRITICAL|HIGH/i.test(l.result_value) ? "HIGH" : undefined,
    }));
    const meds: DischargeMed[] = (medRows ?? []).map((m: any, idx) => ({
      id: m.id,
      drug: m.drug ?? m.drug_name ?? m.medication_name ?? "medication",
      dose: m.dose ?? undefined,
      route: m.route ?? "PO",
      frequency: m.frequency ?? "Daily",
      rxnorm: medCodesFinal[idx] ?? medCodesFinal[0],
      status: m.status ?? "active",
      ordering_physician: m.ordering_physician ?? "Auto Doc Attending",
    }));
    const discharge = buildDischargeTransactionBundle({
      patient: { ...(p as AdmissionPatient), discharge_summary: tpl.discharge, diagnosis: tpl.condition },
      labs,
      dischargeMeds: meds,
      hospitalCourse: tpl.discharge,
      admittingDiagnosis: tpl.condition,
      dischargeDiagnosis: tpl.condition,
      conditionAtDischarge: "Stable, improved.",
      diet: "Regular as tolerated",
      activity: "Activity as tolerated",
      followUp: p.primary_care_physician ? `Follow up with ${p.primary_care_physician} within 7 days.` : "Follow up with PCP within 7 days.",
      returnPrecautions: "Return for worsening symptoms, chest pain, shortness of breath, fever > 101.5°F, or new neurological deficits.",
      patientEducation: `Patient educated on ${tpl.condition} diagnosis, medication adherence and follow-up plan.`,
      physicalExam: {
        general: "Awake, alert, in no acute distress on admission.",
        cardiovascular: "Regular rate and rhythm, no murmurs.",
        pulmonary: "Clear to auscultation bilaterally.",
        abdomen: "Soft, non-tender, non-distended.",
        neurologic: "Alert and oriented x3, no focal deficits.",
      },
    });
    await sb.rpc("persist_fhir_resource" as never, {
      _resource_type: "Bundle",
      _resource_id: `discharge-${mrn}`,
      _mrn: mrn,
      _payload: discharge.bundle as never,
      _source: "auto-doc:discharge",
      _origin: "automation",
      _author_id: "auto-doc",
    } as never);
    const pushed = await pushBundle(discharge.bundle, mrn);
    await log(mrn, "discharge", "Discharge Composition + transaction Bundle pushed to Medblocks", {
      entries: discharge.bundle.entry?.length ?? 0,
      pushed: pushed.ok,
      status: pushed.status,
    });
  } catch (e) {
    await log(mrn, "discharge", `Discharge Bundle build/push failed: ${(e as Error).message}`, null, "warn");
  }

  await setRunStage(mrn, "complete");
  await log(mrn, "complete", `Auto Doc episode complete for MRN-${mrn} (${tpl.condition})`);
  return { ok: true, department, condition: tpl.condition };
}

/* ---------------- FHIR push helper ---------------- */

async function pushBundle(bundle: unknown, mrn: string): Promise<{ ok: boolean; status?: number; error?: string }> {
  const url = process.env.FHIR_SERVER_URL;
  const token = process.env.FHIR_BEARER_TOKEN;
  if (!url || !token) {
    console.warn("[auto-doc] FHIR endpoint not configured; bundle persisted locally only", { mrn });
    return { ok: false, error: "FHIR endpoint not configured" };
  }
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/fhir+json",
        Accept: "application/fhir+json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(bundle),
    });
    return { ok: r.ok, status: r.status };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}