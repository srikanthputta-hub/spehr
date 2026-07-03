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
import {
  buildChargeItemResource,
  buildInvoiceResource,
  buildPaymentNoticeResource,
  composeCharges,
  makeInvoiceNo,
  summarizeCharges,
  type BuildChargesInput,
} from "./billing-pricing";

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
  // Idempotent: re-running Auto Doc updates the same HPI/Assessment/Plan
  // notes instead of stacking duplicates. Backed by the partial unique
  // index uq_clinical_notes_mrn_type_auto_author.
  await sb
    .from("clinical_notes")
    .upsert(notes as never, { onConflict: "mrn,note_type,author" });
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

  /* ------------------------------------------------------------------
   * Per-row code resolvers. The flattened `labCodesFinal` /
   * `medCodesFinal` arrays above are correct for the global terminology
   * registry (every code that COULD apply to this condition), but they
   * MUST NOT be indexed by an unrelated row position when stamping the
   * loinc_code / rxnorm_code on a specific observation or medication
   * request — that was the source of the Bufotenine / ALPHANINE SD style
   * hallucinations: the lab/med row sitting at index N inherited the
   * Nth code from a flattened multi-term UMLS dump. We instead resolve
   * the code from the actual test/drug name against the template, and
   * leave the field null when there is no clinically relevant match.
   * ---------------------------------------------------------------- */
  const norm = (s: string) =>
    s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const loincForLab = (testType: string | null | undefined): string | null => {
    const t = norm(testType ?? "");
    if (!t) return null;
    const hit = tpl.labs.find((l) => {
      const n = norm(l.name);
      return n === t || n.includes(t) || t.includes(n);
    });
    return hit?.loinc ?? null;
  };
  const rxnormForMed = (drugName: string | null | undefined): string | null => {
    const t = norm(drugName ?? "");
    if (!t) return null;
    const hit = tpl.meds.find((m) => {
      const n = norm(m.name);
      return n === t || n.includes(t) || t.includes(n);
    });
    return hit?.rxnorm ?? null;
  };

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
      // NOTE: `standardized_output` is DEPRECATED. We no longer write the
      // flattened blob from Auto Doc — discrete relational rows are now
      // persisted to public.observations / public.medication_requests below.
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
    /* -------------------------------------------------------------------
     * Phase C — Auto IT Await
     * Single, unified `await Promise.all` over EVERY discrete resource
     * that the Composition text + PDF + downstream FHIR push need.
     * The narrative summary and the FHIR Composition both consume this
     * exact dataset, so the two views can never diverge. We also pull
     * the freshly-updated patient row so the Composition gets the AI
     * deduced `diagnosis` and PMH/allergies recorded at admission.
     * ----------------------------------------------------------------- */
    const [
      { data: patientRow },
      { data: labRows },
      { data: medRows },
      { data: allergyRows },
    ] = await Promise.all([
      sb.from("patients").select("*").eq("mrn", mrn).maybeSingle(),
      sb.from("lab_orders").select("id,test_type,result_value,collected_at,status").eq("patient_mrn", mrn).limit(50),
      sb.from("medication_orders").select("id,drug,drug_name,medication_name,dose,route,frequency,ordering_physician,status").eq("patient_mrn", mrn).limit(50),
      sb.from("allergies").select("substance,reaction,severity,status").eq("mrn", mrn).limit(50),
    ]);
    const patientForBundle: AdmissionPatient = {
      ...((patientRow ?? p) as AdmissionPatient),
      discharge_summary: tpl.discharge,
      diagnosis: tpl.condition,
    };
    const patientUuid = (patientRow ?? p)?.id as string | undefined;

    /* -----------------------------------------------------------------
     * STRUCTURED INSERT — write discrete rows into the new relational
     * tables (`observations`, `medication_requests`). These are the
     * canonical source of truth for downstream FHIR export and the
     * Discharge Summary PDF (no more flattened JSON blobs).
     * --------------------------------------------------------------- */
    if (patientUuid) {
      const obsRows = (labRows ?? []).map((l: any, idx: number) => {
        const valStr = typeof l.result_value === "string" ? l.result_value : null;
        const numMatch = valStr ? valStr.match(/-?\d+(\.\d+)?/) : null;
        const numeric = numMatch ? Number(numMatch[0]) : null;
        const abnormal = valStr && /CRITICAL|HIGH|LOW|ABNORMAL/i.test(valStr) ? "H" : null;
        return {
          patient_id: patientUuid,
          patient_mrn: mrn,
          loinc_code: loincForLab(l.test_type),
          display_name: l.test_type ?? "Lab observation",
          value: valStr,
          value_numeric: Number.isFinite(numeric as number) ? numeric : null,
          unit: null,
          abnormal_flag: abnormal,
          status: /resulted|reported|final/i.test(String(l.status ?? "")) ? "final" : "registered",
          recorded_at: l.collected_at ?? new Date().toISOString(),
          source: "auto-doc",
        };
      });
      if (obsRows.length > 0) {
        // Idempotent: same LOINC for the same patient + source overwrites
        // the previous row instead of inserting a duplicate.
        const { error: obsErr } = await sb
          .from("observations")
          .upsert(obsRows as never, { onConflict: "patient_id,loinc_code,source" });
        if (obsErr) await log(mrn, "fhir", `observations insert failed: ${obsErr.message}`, null, "warn");
      }

      const medReqRows = (medRows ?? []).map((m: any, idx: number) => ({
        patient_id: patientUuid,
        patient_mrn: mrn,
        rxnorm_code: rxnormForMed(m.drug ?? m.drug_name ?? m.medication_name),
        display_name: m.drug ?? m.drug_name ?? m.medication_name ?? "Medication",
        dosage: m.dose ?? null,
        route: m.route ?? "PO",
        frequency: m.frequency ?? null,
        status: String(m.status ?? "active").toLowerCase().includes("administ") ? "completed" : "active",
        intent: "order",
        ordered_at: new Date().toISOString(),
        requester: m.ordering_physician ?? "Auto Doc Attending",
        source: "auto-doc",
      }));
      if (medReqRows.length > 0) {
        // Idempotent: same RxNorm for the same patient + source overwrites
        // the previous row instead of inserting a duplicate.
        const { error: mrErr } = await sb
          .from("medication_requests")
          .upsert(medReqRows as never, { onConflict: "patient_id,rxnorm_code,source" });
        if (mrErr) await log(mrn, "fhir", `medication_requests insert failed: ${mrErr.message}`, null, "warn");
      }

      await log(mrn, "fhir", "Structured FHIR rows persisted", {
        observations: obsRows.length,
        medication_requests: medReqRows.length,
      });
    }

    /* -----------------------------------------------------------------
     * Re-query the structured tables. The FHIR Bundle and discharge PDF
     * are now derived from these relational rows — never from the
     * legacy flattened `standardized_output` blob.
     *
     * Race-condition guard: the staged admission cascade inserts
     * lab_orders / medication_orders on a delayed timer (T+20/35/50s).
     * If Auto Doc fires before the cascade has produced any discrete
     * rows, the upserts above wrote nothing and the Composition would
     * narrate "0 observations / 0 medications" — even though the rows
     * land milliseconds later. Poll the discrete tables until at least
     * one row of each exists (or we time out at ~60s), THEN build the
     * narrative. This makes DB-Save → Wait → Build-Context →
     * Generate-Narrative strictly sequential.
     * --------------------------------------------------------------- */
    let structuredObs: any[] | null = null;
    let structuredMedReqs: any[] | null = null;
    const expectObs = tpl.labs.length > 0;
    const expectMeds = tpl.meds.length > 0;
    const maxAttempts = 12; // 12 × 5s = 60s upper bound
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const [{ data: obs }, { data: mrs }] = await Promise.all([
        sb.from("observations").select("*").eq("patient_mrn", mrn).order("recorded_at", { ascending: true }),
        sb.from("medication_requests").select("*").eq("patient_mrn", mrn).order("ordered_at", { ascending: true }),
      ]);
      structuredObs = obs as any[] | null;
      structuredMedReqs = mrs as any[] | null;
      const obsOk = !expectObs || (structuredObs?.length ?? 0) > 0;
      const medOk = !expectMeds || (structuredMedReqs?.length ?? 0) > 0;
      if (obsOk && medOk) break;

      // Re-pull the upstream cascade tables and re-upsert any newly
      // landed rows so the next poll sees structured data.
      const [{ data: freshLabs }, { data: freshMeds }] = await Promise.all([
        sb.from("lab_orders").select("id,test_type,result_value,collected_at,status").eq("patient_mrn", mrn).limit(50),
        sb.from("medication_orders").select("id,drug,drug_name,medication_name,dose,route,frequency,ordering_physician,status").eq("patient_mrn", mrn).limit(50),
      ]);
      if (patientUuid && (freshLabs?.length ?? 0) > 0) {
        const rows = (freshLabs ?? []).map((l: any, idx: number) => {
          const valStr = typeof l.result_value === "string" ? l.result_value : null;
          const numMatch = valStr ? valStr.match(/-?\d+(\.\d+)?/) : null;
          const numeric = numMatch ? Number(numMatch[0]) : null;
          const abnormal = valStr && /CRITICAL|HIGH|LOW|ABNORMAL/i.test(valStr) ? "H" : null;
          return {
            patient_id: patientUuid,
            patient_mrn: mrn,
            loinc_code: loincForLab(l.test_type),
            display_name: l.test_type ?? "Lab observation",
            value: valStr,
            value_numeric: Number.isFinite(numeric as number) ? numeric : null,
            unit: null,
            abnormal_flag: abnormal,
            status: /resulted|reported|final/i.test(String(l.status ?? "")) ? "final" : "registered",
            recorded_at: l.collected_at ?? new Date().toISOString(),
            source: "auto-doc",
          };
        });
        await sb.from("observations").upsert(rows as never, { onConflict: "patient_id,loinc_code,source" });
      }
      if (patientUuid && (freshMeds?.length ?? 0) > 0) {
        const rows = (freshMeds ?? []).map((m: any, idx: number) => ({
          patient_id: patientUuid,
          patient_mrn: mrn,
          rxnorm_code: rxnormForMed(m.drug ?? m.drug_name ?? m.medication_name),
          display_name: m.drug ?? m.drug_name ?? m.medication_name ?? "Medication",
          dosage: m.dose ?? null,
          route: m.route ?? "PO",
          frequency: m.frequency ?? null,
          status: String(m.status ?? "active").toLowerCase().includes("administ") ? "completed" : "active",
          intent: "order",
          ordered_at: new Date().toISOString(),
          requester: m.ordering_physician ?? "Auto Doc Attending",
          source: "auto-doc",
        }));
        await sb.from("medication_requests").upsert(rows as never, { onConflict: "patient_id,rxnorm_code,source" });
      }

      await log(
        mrn,
        "discharge",
        `Waiting for discrete clinical data to land (attempt ${attempt + 1}/${maxAttempts}) — obs:${structuredObs?.length ?? 0} meds:${structuredMedReqs?.length ?? 0}`,
      );
      await new Promise((r) => setTimeout(r, 5000));
    }
    await log(mrn, "discharge", "Discrete clinical data committed — building Composition narrative", {
      observations: structuredObs?.length ?? 0,
      medication_requests: structuredMedReqs?.length ?? 0,
    });

    const labs: DischargeLab[] = ((structuredObs ?? []).length > 0
      ? (structuredObs ?? []).map((o: any) => ({
          id: o.id,
          test_name: o.display_name ?? "Lab",
          test_type: o.display_name ?? undefined,
          result_value: o.value ?? (o.value_numeric != null ? String(o.value_numeric) : undefined),
          loinc: o.loinc_code ?? undefined,
          collected_at: o.recorded_at ?? undefined,
          performing_lab: "SPEHR Central Laboratory",
          flag: o.abnormal_flag === "H" ? "HIGH" : undefined,
        }))
      : (labRows ?? []).map((l: any, idx: number) => ({
      id: l.id,
      test_name: l.test_type ?? "Lab",
      test_type: l.test_type ?? undefined,
      result_value: l.result_value ?? undefined,
      loinc: loincForLab(l.test_type) ?? undefined,
      collected_at: l.collected_at ?? undefined,
      performing_lab: "SPEHR Central Laboratory",
      flag: typeof l.result_value === "string" && /CRITICAL|HIGH/i.test(l.result_value) ? "HIGH" : undefined,
    })));
    const meds: DischargeMed[] = ((structuredMedReqs ?? []).length > 0
      ? (structuredMedReqs ?? []).map((m: any) => ({
          id: m.id,
          drug: m.display_name ?? "medication",
          dose: m.dosage ?? undefined,
          route: m.route ?? "PO",
          frequency: m.frequency ?? "Daily",
          rxnorm: m.rxnorm_code ?? undefined,
          status: m.status ?? "active",
          ordering_physician: m.requester ?? "Auto Doc Attending",
        }))
      : (medRows ?? []).map((m: any, idx: number) => ({
      id: m.id,
      drug: m.drug ?? m.drug_name ?? m.medication_name ?? "medication",
      dose: m.dose ?? undefined,
      route: m.route ?? "PO",
      frequency: m.frequency ?? "Daily",
      rxnorm: rxnormForMed(m.drug ?? m.drug_name ?? m.medication_name) ?? undefined,
      status: m.status ?? "active",
      ordering_physician: m.ordering_physician ?? "Auto Doc Attending",
    })));
    // Allergy summary line is rendered into the Composition so the
    // narrative section is sourced from AllergyIntolerance, not boilerplate.
    const allergyList = (allergyRows ?? []) as Array<{
      substance: string | null;
      reaction: string | null;
      severity: string | null;
    }>;
    const allergyText = allergyList.length === 0
      ? "NKDA — No known drug allergies."
      : allergyList
          .map((a) => {
            const sub = a.substance?.trim() || "Unspecified substance";
            const r = a.reaction?.trim();
            return r ? `${sub} (${r})` : sub;
          })
          .join("; ");
    const dischargeMedsText = `${meds.length} medication(s) prescribed on discharge.`;
    const labsText = `${labs.length} laboratory observation(s) performed by SPEHR Central Laboratory.`;

    const discharge = buildDischargeTransactionBundle({
      patient: patientForBundle,
      labs,
      dischargeMeds: meds,
      hospitalCourse: tpl.discharge,
      admittingDiagnosis: tpl.condition,
      dischargeDiagnosis: tpl.condition,
      conditionAtDischarge: "Stable, improved.",
      diet: "Regular as tolerated",
      activity: "Activity as tolerated",
      followUp: patientForBundle.primary_care_physician
        ? `Follow up with ${patientForBundle.primary_care_physician} within 7 days.`
        : "Follow up with PCP within 7 days.",
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

    /* -------------------------------------------------------------------
     * Phase C cross-check — verify the Composition text counts match the
     * discrete FHIR arrays in the same Bundle before pushing to the
     * external Medblocks server. If counts diverge, abort the push so
     * the local copy stays as the source of truth and the watchdog can
     * surface the mismatch for manual review.
     * ----------------------------------------------------------------- */
    const entries = (discharge.bundle.entry ?? []) as Array<{ resource?: { resourceType?: string } }>;
    const obsCount = entries.filter((e) => e.resource?.resourceType === "Observation").length;
    const medCount = entries.filter((e) => e.resource?.resourceType === "MedicationRequest").length;
    const crossCheckOk = obsCount === labs.length && medCount === meds.length;
    if (!crossCheckOk) {
      await log(
        mrn,
        "discharge",
        `Cross-check FAILED — Bundle has ${obsCount} Observation / ${medCount} MedicationRequest vs queried ${labs.length} labs / ${meds.length} meds. Skipping external push.`,
        { obsCount, medCount, queriedLabs: labs.length, queriedMeds: meds.length },
        "error",
      );
    } else {
      await log(mrn, "discharge", "Cross-check passed: Composition counts match discrete FHIR arrays", {
        labs: labs.length,
        meds: meds.length,
        allergies: allergyList.length,
        allergyText,
        labsText,
        dischargeMedsText,
      });
    }

    await sb.rpc("persist_fhir_resource" as never, {
      _resource_type: "Bundle",
      _resource_id: `discharge-${mrn}`,
      _mrn: mrn,
      _payload: discharge.bundle as never,
      _source: "auto-doc:discharge",
      _origin: "automation",
      _author_id: "auto-doc",
    } as never);
    if (crossCheckOk) {
      const pushed = await pushBundle(discharge.bundle, mrn);
      await log(mrn, "discharge", "Discharge Composition + transaction Bundle pushed to Medblocks", {
        entries: discharge.bundle.entry?.length ?? 0,
        pushed: pushed.ok,
        status: pushed.status,
      });
    }
  } catch (e) {
    await log(mrn, "discharge", `Discharge Bundle build/push failed: ${(e as Error).message}`, null, "warn");
  }

  await setRunStage(mrn, "complete");
  await log(mrn, "complete", `Auto Doc episode complete for MRN-${mrn} (${tpl.condition})`);

  // Billing: if the patient is already discharged at completion time, issue the
  // FHIR Invoice immediately. Otherwise it will be issued by the periodic
  // Finance backfill (or the dashboard's auto-backfill on mount) once the
  // discharge transition lands.
  try {
    const { data: latest } = await sb
      .from("patients")
      .select("status")
      .eq("mrn", mrn)
      .maybeSingle();
    if (latest && String((latest as any).status ?? "").toLowerCase() === "discharged") {
      const inv = await generateInvoiceForPatient(mrn);
      if (inv.ok && !inv.skipped) {
        await log(mrn, "complete", `Auto Doc billing issued Invoice ${inv.invoiceNo}`, {
          total: inv.total,
        });
      }
    }
  } catch (e) {
    await log(mrn, "complete", `Auto Doc billing issue failed: ${(e as Error).message}`, null, "warn");
  }

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

/* ---------------- Billing / FHIR Invoice generation ---------------- */

function safeFullName(p: any): string {
  return (
    p?.name ||
    [p?.first_name, p?.last_name].filter(Boolean).join(" ") ||
    p?.mrn ||
    "Unknown"
  );
}

export async function generateInvoiceForPatient(mrn: string): Promise<{
  ok: boolean;
  invoiceId?: string;
  invoiceNo?: string;
  total?: number;
  error?: string;
  skipped?: boolean;
}> {
  const sb = admin();

  const { data: patient, error: pErr } = await sb
    .from("patients")
    .select(
      "id,mrn,name,first_name,last_name,room,facility_name,status,admission_time,discharge_time",
    )
    .eq("mrn", mrn)
    .maybeSingle();
  if (pErr || !patient) return { ok: false, error: "patient not found" };
  const p = patient as any;

  // Pull clinical course
  const [{ data: medRows }, { data: labRows }] = await Promise.all([
    sb
      .from("medication_orders")
      .select("medication_name,drug_name,drug,status,administered_at")
      .eq("patient_mrn", mrn),
    sb
      .from("lab_orders")
      .select("test_type,status,collected_at")
      .eq("patient_mrn", mrn),
  ]);

  const meds = (medRows ?? [])
    .filter((m: any) => String(m.status ?? "").toLowerCase() === "administered")
    .map((m: any) => ({
      rxnorm: null,
      name: m.medication_name || m.drug_name || m.drug || "Medication",
      administered_at: m.administered_at ?? null,
    }));
  const labs = (labRows ?? [])
    .filter((l: any) => /resulted|reported|final/i.test(String(l.status ?? "")))
    .map((l: any) => ({
      loinc: null,
      name: l.test_type ?? "Lab",
      collected_at: l.collected_at ?? null,
    }));

  const input: BuildChargesInput = {
    admissionTime: p.admission_time,
    dischargeTime: p.discharge_time,
    room: p.room,
    meds,
    labs,
  };
  const charges = composeCharges(input);
  const { subtotal, tax, total } = summarizeCharges(charges);
  const invoiceNo = makeInvoiceNo(mrn, p.discharge_time);

  // Idempotency: replace previous invoice for this discharge if it exists
  const { data: existing } = await sb
    .from("fhir_invoices")
    .select("id,invoice_no,status")
    .eq("mrn", mrn)
    .order("issued_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  // Don't overwrite a balanced invoice
  if (existing && (existing as any).status === "balanced") {
    return { ok: true, invoiceId: (existing as any).id, invoiceNo: (existing as any).invoice_no, skipped: true };
  }

  let invoiceId: string;
  if (existing) {
    invoiceId = (existing as any).id;
    await sb
      .from("fhir_invoices")
      .update({
        invoice_no: invoiceNo,
        patient_name: safeFullName(p),
        facility_name: p.facility_name,
        encounter_id: `enc-${mrn}`,
        status: "issued",
        subtotal,
        tax,
        total,
        currency: "USD",
        issued_at: new Date().toISOString(),
        paid_at: null,
        payload: {} as any,
      } as never)
      .eq("id", invoiceId);
    await sb.from("fhir_charge_items").delete().eq("invoice_id", invoiceId);
  } else {
    const { data: ins, error: insErr } = await sb
      .from("fhir_invoices")
      .insert({
        invoice_no: invoiceNo,
        mrn,
        patient_name: safeFullName(p),
        encounter_id: `enc-${mrn}`,
        facility_name: p.facility_name,
        status: "issued",
        subtotal,
        tax,
        total,
        currency: "USD",
        payload: {} as any,
      } as never)
      .select("id")
      .single();
    if (insErr || !ins) return { ok: false, error: insErr?.message ?? "insert failed" };
    invoiceId = (ins as any).id;
  }

  // Insert ChargeItems
  const chargeRows = charges.map((c, idx) => {
    const ciId = `${invoiceId.slice(0, 8)}-${idx + 1}`;
    return {
      id: ciId,
      payload: buildChargeItemResource({ id: ciId, mrn, encounterId: `enc-${mrn}`, c }),
      row: {
        invoice_id: invoiceId,
        mrn,
        encounter_id: `enc-${mrn}`,
        charge_code: c.code,
        code_system: c.codeSystem,
        description: c.description,
        category: c.category,
        quantity: c.quantity,
        unit_price: c.unitPrice,
        amount: c.amount,
        currency: "USD",
        service_date: c.serviceDate ?? null,
        payload: buildChargeItemResource({ id: ciId, mrn, encounterId: `enc-${mrn}`, c }) as never,
      },
    };
  });
  if (chargeRows.length > 0) {
    await sb.from("fhir_charge_items").insert(chargeRows.map((r) => r.row) as never);
  }

  // Build + persist the master Invoice resource
  const invoiceResource = buildInvoiceResource({
    id: invoiceId,
    invoiceNo,
    mrn,
    encounterId: `enc-${mrn}`,
    patientName: safeFullName(p),
    chargeItems: chargeRows.map((r) => ({ id: r.id, c: charges[chargeRows.indexOf(r)] })),
    subtotal,
    tax,
    total,
    status: "issued",
  });
  await sb
    .from("fhir_invoices")
    .update({ payload: invoiceResource as never } as never)
    .eq("id", invoiceId);

  // Mirror into the canonical local FHIR resource cache (best-effort)
  try {
    await sb.rpc("persist_fhir_resource" as never, {
      _resource_type: "Invoice",
      _resource_id: invoiceId,
      _mrn: mrn,
      _payload: invoiceResource as never,
      _source: "auto-doc:billing",
      _origin: "automation",
      _author_id: "auto-doc",
    } as never);
  } catch (e) {
    console.warn("[billing] persist_fhir_resource (Invoice) failed", (e as Error).message);
  }

  await log(mrn, "complete", `Auto Doc billing: Invoice ${invoiceNo} issued`, {
    lineItems: chargeRows.length,
    subtotal,
    tax,
    total,
  });

  return { ok: true, invoiceId, invoiceNo, total };
}

export async function backfillMissingInvoices(): Promise<{ ok: true; generated: number; skipped: number }> {
  const sb = admin();
  const { data: discharged } = await sb
    .from("patients")
    .select("mrn,status")
    .ilike("status", "discharged")
    .limit(500);
  const list = (discharged ?? []) as Array<{ mrn: string | null }>;
  let generated = 0;
  let skipped = 0;
  for (const row of list) {
    if (!row.mrn) {
      skipped++;
      continue;
    }
    const { data: existing } = await sb
      .from("fhir_invoices")
      .select("id")
      .eq("mrn", row.mrn)
      .limit(1)
      .maybeSingle();
    if (existing) {
      skipped++;
      continue;
    }
    const res = await generateInvoiceForPatient(row.mrn);
    if (res.ok) generated++;
  }
  return { ok: true, generated, skipped };
}

export async function payInvoiceById(
  invoiceId: string,
  method?: string,
): Promise<{ ok: boolean; error?: string; paymentNoticeId?: string }> {
  const sb = admin();
  const { data: inv, error } = await sb
    .from("fhir_invoices")
    .select("id,invoice_no,mrn,total,status")
    .eq("id", invoiceId)
    .maybeSingle();
  if (error || !inv) return { ok: false, error: "invoice not found" };
  const i = inv as any;
  if (i.status === "balanced") return { ok: true };

  const { data: noticeRow, error: nErr } = await sb
    .from("fhir_payment_notices")
    .insert({
      invoice_id: i.id,
      mrn: i.mrn,
      amount: i.total,
      currency: "USD",
      status: "active",
      payment_method: method ?? "Card · Patient Portal",
      payload: {} as any,
    } as never)
    .select("id")
    .single();
  if (nErr || !noticeRow) return { ok: false, error: nErr?.message ?? "payment notice failed" };
  const noticeId = (noticeRow as any).id as string;

  const notice = buildPaymentNoticeResource({
    id: noticeId,
    invoiceId: i.id,
    invoiceNo: i.invoice_no,
    mrn: i.mrn,
    amount: Number(i.total),
    method,
  });
  await sb
    .from("fhir_payment_notices")
    .update({ payload: notice as never } as never)
    .eq("id", noticeId);

  await sb
    .from("fhir_invoices")
    .update({ status: "balanced", paid_at: new Date().toISOString() } as never)
    .eq("id", i.id);

  try {
    await sb.rpc("persist_fhir_resource" as never, {
      _resource_type: "PaymentNotice",
      _resource_id: noticeId,
      _mrn: i.mrn,
      _payload: notice as never,
      _source: "patient-portal:payment",
      _origin: "patient",
      _author_id: "patient-portal",
    } as never);
  } catch (e) {
    console.warn("[billing] persist_fhir_resource (PaymentNotice) failed", (e as Error).message);
  }

  return { ok: true, paymentNoticeId: noticeId };
}