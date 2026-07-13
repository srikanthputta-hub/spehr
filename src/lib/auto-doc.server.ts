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
  type AdmissionPatient,
} from "./fhir-admission-discharge";
import {
  buildChargeItemResource,
  buildInvoiceResource,
  buildPaymentNoticeResource,
  composeCharges,
  makeInvoiceNo,
  summarizeCharges,
  matchBillingValueSets,
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
  | "billing"
  | "complete"
  | "error";

export async function log(
  mrn: string,
  stage: Stage,
  message: string,
  meta?: unknown,
  level: "info" | "warn" | "error" = "info",
) {
  // HARD GATE: only error-level rows are ever persisted to auto_doc_logs.
  // Every other level (info, warn, progress ticks, completions, heartbeats)
  // is dropped unconditionally, regardless of stage. Do not loosen — this is
  // the sole insert path for this table and the contract is error-only.
  if (level !== "error") return;
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

  // Radiology / imaging orders — insert into public.radiology_orders (the
  // same table `RadiologyOrderPanel.tsx` writes into) and push a FHIR
  // ServiceRequest to the shared Medblocks server so the sibling Health
  // Hub Suite imaging pipeline picks it up. Idempotent: stable id per
  // (mrn, exam) and DB-side dedup by (patient_mrn, exam_type, source).
  try {
    const imgOut = await orderImagingForMrn(mrn, tpl, p);
    if (imgOut.results.length > 0) {
      await log(
        mrn,
        "order",
        `Auto Doc ordered ${imgOut.results.map((r) => r.examType).join(", ")} for ${tpl.condition}`,
        { imaging: imgOut.results, inserted: imgOut.inserted, errors: imgOut.errors },
      );
    }
  } catch (e) {
    await log(mrn, "order", `Radiology order failed: ${(e as Error).message}`, null, "warn");
  }

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

  // Clinical coverage-gap detection (Auto Doc as a requesting consumer):
  // if none of the resolved SNOMED CT concepts for tpl.condition are
  // covered by a currently-published SNOMED CT value set, file (or extend)
  // a terminology_requests row so the Auto Terminologist / human steward
  // can close the gap. Mirrors the Billing Engine gap-request pattern
  // below in generateInvoiceForPatient. Wrapped in try/catch so any
  // failure here NEVER blocks the fhir / discharge / complete stages.
  try {
    if (snomedFinal.length > 0) {
      const wanted = new Set(snomedFinal.map((c) => String(c).trim()).filter(Boolean));
      const { data: publishedSets } = await sb
        .from("custom_value_sets")
        .select("codes")
        .eq("vocabulary", "SNOMED CT")
        .eq("status", "published");
      let covered = false;
      for (const row of ((publishedSets ?? []) as any[])) {
        const rowCodes: any[] = Array.isArray(row?.codes) ? row.codes : [];
        for (const c of rowCodes) {
          const k = String(c?.code ?? "").trim();
          if (k && wanted.has(k)) { covered = true; break; }
        }
        if (covered) break;
      }

      if (!covered) {
        const seedCodes = snomedFinal.map((code) => ({
          code,
          display: tpl.condition,
          vocabulary: "SNOMED CT",
        }));

        // Extend an existing unresolved Auto Doc request for the same
        // condition rather than filing a duplicate.
        const { data: existingReq } = await sb
          .from("terminology_requests" as any)
          .select("id, seed_codes, status")
          .eq("requesting_consumer", "Auto Doc")
          .eq("requested_name", tpl.condition)
          .in("status", ["pending", "umls-suggested"])
          .maybeSingle();

        if (existingReq) {
          const prevCodes: Array<{ code: string; display?: string; vocabulary?: string }> =
            Array.isArray((existingReq as any).seed_codes)
              ? (existingReq as any).seed_codes
              : [];
          const seen = new Set(prevCodes.map((c) => String(c?.code ?? "").trim()));
          const merged = [...prevCodes];
          for (const c of seedCodes) {
            const code = String(c?.code ?? "").trim();
            if (!code || seen.has(code)) continue;
            seen.add(code);
            merged.push(c);
          }
          if (merged.length !== prevCodes.length) {
            await sb
              .from("terminology_requests" as any)
              .update({ seed_codes: merged, updated_at: new Date().toISOString() } as any)
              .eq("id", (existingReq as any).id);
          }
        } else {
          await sb.from("terminology_requests" as any).insert({
            requesting_consumer: "Auto Doc",
            requested_name: tpl.condition,
            justification: `No published SNOMED CT value set currently covers "${tpl.condition}" — ${snomedFinal.length} concept(s) resolved for ${mrn} with no governed coverage.`,
            priority: "normal",
            vocabulary: "SNOMED CT",
            seed_codes: seedCodes,
            clinical_application: "CDS",
            related_mrn: mrn,
            status: "pending",
          } as any);
        }
      }
    }
  } catch (e) {
    console.warn("[auto-doc] terminology coverage-gap request failed", (e as Error).message);
  }

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
      diagnosis: tpl.condition,
    } as never)
    .eq("mrn", mrn);
  await log(
    mrn,
    "discharge",
    "Admission-time discharge stage: diagnosis recorded; no discharge_summary written and no Composition pushed (real discharge owns that)",
  );

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
     * Drug-Allergy pair coverage-gap detection (Auto Doc as requesting
     * consumer). For each of this patient's coded allergies that maps
     * to a known Safety Alerts Engine · Drug-Allergy pair, check the
     * allergen-side registry row. If the pair's allergen-side value set
     * hasn't been authored yet (no `custom_value_sets` row by that
     * exact name, any status), file/merge a `terminology_requests` row
     * so the Auto Terminologist / human steward can close the gap and
     * activate Rule 1 for this pair going forward. Mirrors the merge-or-
     * insert pattern used by the clinical + billing gap detectors above.
     * ---------------------------------------------------------------- */
    try {
      const PAIR_SUBSTANCE_TERMS: Record<string, string[]> = {
        penicillin: ["penicillin", "amoxicillin", "product containing penicillin"],
        cephalosporin: ["cefazolin"],
        sulfa: ["sulfa"],
        "iodine-contrast": ["iodine", "contrast dye"],
        codeine: ["codeine"],
        // nsaid-hypersensitivity intentionally omitted — no chart data yet
      };
      const matchPairId = (substance: string): string | null => {
        const s = substance.toLowerCase();
        for (const [pairId, terms] of Object.entries(PAIR_SUBSTANCE_TERMS)) {
          if (terms.some((t) => s.includes(t))) return pairId;
        }
        return null;
      };

      const seenPairs = new Set<string>();
      for (const row of (allergyRows ?? []) as any[]) {
        const substance = String(row?.substance ?? "").trim();
        if (!substance) continue;
        const pairId = matchPairId(substance);
        if (!pairId || seenPairs.has(pairId)) continue;
        seenPairs.add(pairId);

        const substanceSnomed = row?.substance_snomed ? String(row.substance_snomed).trim() : "";
        if (!substanceSnomed) continue; // nothing usable to seed with

        // Look up the registry row for this pair's allergen side.
        const { data: depRow } = await sb
          .from("value_set_dependencies")
          .select("id, value_set_id, value_set_name")
          .eq("consumer", "Safety Alerts Engine · Drug-Allergy")
          .eq("purpose", pairId)
          .eq("lookup_mode", "allergen")
          .maybeSingle();
        if (!depRow) continue;
        const dep = depRow as any;
        if (dep.value_set_id) continue; // already linked — nothing to file
        const requestedName = String(dep.value_set_name ?? "").trim();
        if (!requestedName) continue;

        // If a value set with this exact name already exists (any status),
        // it's already being handled — skip.
        const { data: existingVs } = await sb
          .from("custom_value_sets")
          .select("id")
          .eq("name", requestedName)
          .maybeSingle();
        if (existingVs) continue;

        const seedCode = {
          code: substanceSnomed,
          display: substance,
          vocabulary: "SNOMED CT",
        };
        const justification = `Drug-Allergy pair '${pairId}' has no allergen-side value set yet — needed to activate Rule 1 for this pair. Seeded from this patient's coded allergy.`;

        // Merge-or-insert against any unresolved Auto Doc request for the
        // same requested_name to avoid duplicate rows on repeat patients.
        const { data: existingReq } = await sb
          .from("terminology_requests" as any)
          .select("id, seed_codes, status")
          .eq("requesting_consumer", "Auto Doc")
          .eq("requested_name", requestedName)
          .in("status", ["pending", "umls-suggested"])
          .maybeSingle();

        if (existingReq) {
          const prevCodes: Array<{ code: string; display?: string; vocabulary?: string }> =
            Array.isArray((existingReq as any).seed_codes)
              ? (existingReq as any).seed_codes
              : [];
          const seen = new Set(prevCodes.map((c) => String(c?.code ?? "").trim()));
          if (!seen.has(seedCode.code)) {
            await sb
              .from("terminology_requests" as any)
              .update({
                seed_codes: [...prevCodes, seedCode],
                updated_at: new Date().toISOString(),
              } as any)
              .eq("id", (existingReq as any).id);
          }
        } else {
          await sb.from("terminology_requests" as any).insert({
            requesting_consumer: "Auto Doc",
            request_type: "create",
            requested_name: requestedName,
            justification,
            priority: "normal",
            vocabulary: "SNOMED CT",
            seed_codes: [seedCode],
            clinical_application: "CDS",
            related_mrn: mrn,
            status: "pending",
          } as any);
        }
      }
    } catch (e) {
      console.warn("[auto-doc] drug-allergy pair gap-request failed", (e as Error).message);
    }
    // NOTE: Building or pushing a Discharge Summary Composition at admission
    // time was removed intentionally. That was a false-signal data-fabrication
    // bug: a Composition with status="final" was landing on the external
    // FHIR server (and `patients.discharge_summary` was being populated)
    // while the patient was still actively admitted. The real discharge
    // Composition is produced by `ghost-discharge-worker` (and any
    // physician-driven discharge flow) once the patient is actually
    // discharged. Do not re-introduce a Composition push here.
  } catch (e) {
    await log(mrn, "discharge", `Admission structured-data upsert failed: ${(e as Error).message}`, null, "warn");
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
    await log(mrn, "billing", `Auto Doc billing issue failed: ${(e as Error).message}`, null, "error");
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

async function putFhirResource(
  path: string,
  resource: unknown,
  mrn: string,
): Promise<{ ok: boolean; status?: number; error?: string }> {
  const url = process.env.FHIR_SERVER_URL;
  const token = process.env.FHIR_BEARER_TOKEN;
  if (!url || !token) {
    console.warn("[auto-doc] FHIR endpoint not configured; resource persisted locally only", { mrn, path });
    return { ok: false, error: "FHIR endpoint not configured" };
  }
  try {
    const base = url.replace(/\/+$/, "");
    const suffix = path.startsWith("/") ? path : `/${path}`;
    const r = await fetch(base + suffix, {
      method: "PUT",
      headers: {
        "Content-Type": "application/fhir+json",
        Accept: "application/fhir+json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(resource),
    });
    return { ok: r.ok, status: r.status };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/* ---------------- Radiology / imaging orders ---------------- */

function slugifyExam(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function modalityFor(examType: string): "XR" | "CT" | "MRI" | "US" {
  const s = examType.toLowerCase();
  if (s.includes("mri")) return "MRI";
  if (s.includes("ultrasound")) return "US";
  if (s.includes("ct ")) return "CT";
  return "XR";
}

function bodyPartFor(examType: string): string {
  const s = examType.toLowerCase();
  if (s.includes("chest")) return "Chest";
  if (s.includes("head")) return "Head";
  if (s.includes("brain")) return "Brain";
  if (s.includes("abdomen") || s.includes("abdominal")) return s.includes("pelvis") ? "Abdomen/Pelvis" : "Abdomen";
  if (s.includes("spine")) return "Spine";
  if (s.includes("knee")) return "Knee";
  return "General";
}

function buildServiceRequest(input: {
  id: string;
  mrn: string;
  examType: string;
  snomed: string;
  snomedDisplay: string;
  reason: string;
  authoredOn: string;
}) {
  return {
    resourceType: "ServiceRequest",
    id: input.id,
    meta: { tag: [{ system: "urn:spehr:source", code: "spehr" }] },
    status: "active",
    intent: "order",
    category: [
      {
        coding: [
          { system: "http://snomed.info/sct", code: "363679005", display: "Imaging" },
        ],
      },
    ],
    code: {
      coding: [
        { system: "http://snomed.info/sct", code: input.snomed, display: input.snomedDisplay },
      ],
      text: input.examType,
    },
    subject: { reference: `Patient/${input.mrn}` },
    reasonCode: [{ text: input.reason }],
    authoredOn: input.authoredOn,
    requester: { display: "Auto Doc" },
  };
}

async function orderImagingForMrn(
  mrn: string,
  tpl: ConditionTemplate,
  p: any,
): Promise<{
  results: Array<{ examType: string; svcId: string; pushed: boolean; status?: number }>;
  inserted: number;
  errors: string[];
}> {
  const imaging = tpl.imaging ?? [];
  if (imaging.length === 0) return { results: [], inserted: 0, errors: [] };
  const sb = admin();
  const nowIso = new Date().toISOString();
  const results: Array<{ examType: string; svcId: string; pushed: boolean; status?: number }> = [];
  const errors: string[] = [];
  let inserted = 0;
  const patientName =
    p?.name || [p?.first_name, p?.last_name].filter(Boolean).join(" ") || null;

  for (const img of imaging) {
    const svcId = `radsvc-${mrn}-${slugifyExam(img.examType)}`;
    // Skip if we already ordered this exam for this MRN (idempotency).
    const { data: existing } = await sb
      .from("radiology_orders")
      .select("id, svcreq_fhir_id")
      .eq("patient_mrn", mrn)
      .eq("exam_type", img.examType)
      .maybeSingle();

    if (!existing) {
      const { error: insErr } = await sb.from("radiology_orders").insert({
        patient_mrn: mrn,
        patient_name: patientName,
        facility_name: p?.facility_name ?? null,
        requested_by: "Auto Doc",
        exam_type: img.examType,
        modality: modalityFor(img.examType),
        body_part: bodyPartFor(img.examType),
        clinical_indication: tpl.condition,
        status: "ordered",
        snomed_code: img.snomed,
        snomed_display: img.snomedDisplay,
        svcreq_fhir_id: svcId,
        source: "auto-doc",
        created_by_type: "automation",
        ordered_at: nowIso,
      } as never);
      if (insErr) {
        const msg = `${(insErr as any).code ?? ""} ${insErr.message ?? ""} ${(insErr as any).details ?? ""}`.trim();
        console.warn("[auto-doc] radiology_orders insert failed", msg);
        try {
          await log(mrn, "order", `radiology_orders insert failed: ${msg}`, insErr as any, "error");
        } catch {
          /* ignore */
        }
        errors.push(msg);
      } else {
        inserted++;
      }
    } else if (!(existing as any).svcreq_fhir_id) {
      await sb
        .from("radiology_orders")
        .update({ svcreq_fhir_id: svcId } as never)
        .eq("id", (existing as any).id);
    }

    const svcReq = buildServiceRequest({
      id: svcId,
      mrn,
      examType: img.examType,
      snomed: img.snomed,
      snomedDisplay: img.snomedDisplay,
      reason: tpl.condition,
      authoredOn: nowIso,
    });

    try {
      await sb.rpc("persist_fhir_resource" as never, {
        _resource_type: "ServiceRequest",
        _resource_id: svcId,
        _mrn: mrn,
        _payload: svcReq as never,
        _source: "auto-doc:imaging",
        _origin: "automation",
        _author_id: "auto-doc",
      } as never);
    } catch (e) {
      console.warn("[auto-doc] persist_fhir_resource(ServiceRequest) failed", (e as Error).message);
    }

    const pushed = await putFhirResource(`/ServiceRequest/${svcId}`, svcReq, mrn);
    results.push({ examType: img.examType, svcId, pushed: pushed.ok, status: pushed.status });
  }
  return { results, inserted, errors };
}

/* ---------------- Radiology backfill ---------------- */

export async function backfillMissingRadiologyOrders(): Promise<{
  ok: true;
  processed: number;
  ordersCreated: number;
  skipped: number;
  errors: string[];
}> {
  const sb = admin();
  const { data: patientsList } = await sb
    .from("patients")
    .select("mrn, assigned_department, chief_complaint")
    .not("mrn", "is", null)
    .limit(1000);
  const rows = (patientsList ?? []) as Array<{
    mrn: string | null;
    assigned_department: string | null;
    chief_complaint: string | null;
  }>;
  let processed = 0;
  let ordersCreated = 0;
  let skipped = 0;
  const errorCounts = new Map<string, number>();

  for (const row of rows) {
    if (!row.mrn) {
      skipped++;
      continue;
    }
    // Skip if this patient already has any radiology_orders row.
    const { data: existing } = await sb
      .from("radiology_orders")
      .select("id")
      .eq("patient_mrn", row.mrn)
      .limit(1)
      .maybeSingle();
    if (existing) {
      skipped++;
      continue;
    }

    const dept: Department =
      (row.assigned_department as Department) ||
      routeDepartment(String(row.chief_complaint ?? ""));
    const tpl = templateForDepartment(dept);
    if (!tpl.imaging || tpl.imaging.length === 0) {
      skipped++;
      continue;
    }

    // Need a fuller patient row for facility/name.
    const { data: patientRow } = await sb
      .from("patients")
      .select("*")
      .eq("mrn", row.mrn)
      .maybeSingle();

    const out = await orderImagingForMrn(row.mrn, tpl, patientRow ?? row);
    processed++;
    ordersCreated += out.inserted;
    for (const e of out.errors) errorCounts.set(e, (errorCounts.get(e) ?? 0) + 1);
  }
  const errors = [...errorCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([msg, n]) => `(${n}x) ${msg}`);
  return { ok: true, processed, ordersCreated, skipped, errors };
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
  const [{ data: medRows }, { data: labRows }, { data: radRows }] = await Promise.all([
    sb
      .from("medication_orders")
      .select("medication_name,drug_name,drug,rxnorm_code,status,administered_at")
      .eq("patient_mrn", mrn),
    sb
      .from("lab_orders")
      .select("test_type,loinc_code,status,collected_at")
      .eq("patient_mrn", mrn),
    sb
      .from("radiology_orders")
      .select("snomed_code,exam_type,modality,body_part,status,ordered_at,indication_icd10_code,indication_icd10_display")
      .eq("patient_mrn", mrn),
  ]);

  const meds = (medRows ?? [])
    .filter((m: any) => String(m.status ?? "").toLowerCase() === "administered")
    .map((m: any) => ({
      rxnorm: m.rxnorm_code ?? null,
      name: m.medication_name || m.drug_name || m.drug || "Medication",
      administered_at: m.administered_at ?? null,
    }));
  const labs = (labRows ?? [])
    .filter((l: any) => /resulted|reported|final/i.test(String(l.status ?? "")))
    .map((l: any) => ({
      loinc: l.loinc_code ?? null,
      name: l.test_type ?? "Lab",
      collected_at: l.collected_at ?? null,
    }));
  // Bill for every imaging study that made it past "requested" — i.e.,
  // ordered, in-progress, resulted, or reported. (Cancelled/draft skipped.)
  const imagingOrders = ((radRows ?? []) as any[])
    .filter((r) => {
      const s = String(r?.status ?? "").toLowerCase();
      return /order|progress|resulted|reported|final|complete/.test(s);
    })
    .map((r) => ({
      snomed: r.snomed_code ?? null,
      exam_type: r.exam_type ?? null,
      modality: r.modality ?? null,
      body_part: r.body_part ?? null,
      ordered_at: r.ordered_at ?? null,
      indication_icd10_code: r.indication_icd10_code ?? null,
      indication_icd10_display: r.indication_icd10_display ?? null,
    }));

  // Pull ICD-10 codes for this MRN — prefer discrete conditions rows; fall
  // back to the denormalised patients.icd10_codes array when empty.
  const { data: condRows } = await sb
    .from("conditions")
    .select("icd10_code, icd10_display, onset_date, created_at, clinical_status")
    .eq("mrn", mrn)
    .order("onset_date", { ascending: true, nullsFirst: false })
    .order("created_at", { ascending: true });
  const condsWithIcd10 = ((condRows ?? []) as any[]).filter(
    (r) => typeof r?.icd10_code === "string" && r.icd10_code.length > 0,
  );
  let icd10Codes: string[] = condsWithIcd10.map((r) => r.icd10_code as string);
  // Primary diagnosis = earliest recorded active condition with an ICD-10 code
  // (first non-'resolved' row after ordering by onset then created_at).
  const primaryCond =
    condsWithIcd10.find(
      (r) => String(r?.clinical_status ?? "active").toLowerCase() !== "resolved",
    ) ?? condsWithIcd10[0] ?? null;
  const primaryIcd10: string | null = primaryCond?.icd10_code ?? null;
  const primaryIcd10Display: string | null =
    primaryCond?.icd10_display ?? null;
  if (icd10Codes.length === 0) {
    const { data: pRow } = await sb
      .from("patients")
      .select("icd10_codes")
      .eq("mrn", mrn)
      .maybeSingle();
    const arr = (pRow as any)?.icd10_codes;
    if (Array.isArray(arr)) {
      icd10Codes = arr.filter((c: unknown): c is string => typeof c === "string" && c.length > 0);
    }
  }
  icd10Codes = Array.from(new Set(icd10Codes));

  // Fetch published Billing value sets and compute matches.
  const { data: billingVs } = await sb
    .from("custom_value_sets")
    .select("name, codes, clinical_application, status")
    .eq("status", "published")
    .eq("clinical_application", "Billing");

  // Locate the Charge Master value set — used to substitute real CPT / UB-04
  // Revenue codes on room/board, nursing, physician time, pharmacy, and lab
  // charge lines. Kept as a separate concern from ICD-10 risk-adjustment
  // matching so both remain independently governable.
  const chargeMasterVs = ((billingVs ?? []) as any[]).find((v) =>
    /charge\s*master/i.test(String(v?.name ?? "")),
  );
  const chargeMaster: Array<{
    code: string;
    display?: string;
    system?: string;
    internal_category?: string;
  }> = Array.isArray(chargeMasterVs?.codes)
    ? (chargeMasterVs.codes as any[]).map((e) => ({
        code: String(e?.code ?? ""),
        display: e?.display ? String(e.display) : undefined,
        system: e?.system ? String(e.system) : undefined,
        internal_category: e?.internal_category
          ? String(e.internal_category)
          : undefined,
      }))
    : [];

  const billingMatches = matchBillingValueSets(
    icd10Codes,
    ((billingVs ?? []) as any[]).map((v) => ({
      name: String(v.name ?? "Billing value set"),
      codes: Array.isArray(v.codes) ? v.codes : [],
    })),
  );

  const invoiceNo = makeInvoiceNo(mrn, p.discharge_time);

  // Coverage-gap detection: any ICD-10 code on this patient with no match
  // in a published Billing value set means the invoice is being charged
  // without a governed risk-adjustment/coverage mapping. File (or extend)
  // a change request directly against terminology_requests using the
  // admin client — mirrors the real-world "billing/quality team flags a
  // missing code" change-request trigger.
  const matchedIcd10 = new Set(billingMatches.map((m) => m.icd10));
  const unmatchedIcd10 = icd10Codes.filter((c) => !matchedIcd10.has(c));
  if (unmatchedIcd10.length > 0) {
    try {
      const { data: dictRows } = await sb
        .from("medical_terminology")
        .select("code, display")
        .eq("code_system", "ICD-10")
        .in("code", unmatchedIcd10);
      const displayByCode = new Map(((dictRows ?? []) as any[]).map((r) => [r.code, r.display]));
      const seedCodes = unmatchedIcd10.map((c) => ({ code: c, display: displayByCode.get(c) ?? c }));

      const { error: insertErr } = await sb.from("terminology_requests" as any).insert({
        requesting_consumer: "Auto Admin",
        requested_name: "Billing Coverage Gaps",
        justification: `Invoice ${invoiceNo} for MRN-${mrn} includes ${unmatchedIcd10.length} ICD-10 diagnosis code(s) with no match in any published Billing value set — these codes are being charged without a governed coverage/risk-adjustment mapping.`,
        priority: "normal",
        vocabulary: "ICD-10",
        seed_codes: seedCodes,
        clinical_application: "Billing",
        related_mrn: mrn,
        status: "pending",
      } as any);

      if (!insertErr) {
        // fresh pending request created
      } else if ((insertErr as any).code === "23505") {
        // Unique-violation: a pending request already exists — merge seed codes.
        const { data: existingReq } = await sb
          .from("terminology_requests" as any)
          .select("id, seed_codes")
          .eq("requesting_consumer", "Auto Admin")
          .eq("requested_name", "Billing Coverage Gaps")
          .eq("status", "pending")
          .maybeSingle();
        if (existingReq) {
          const prevCodes: Array<{ code: string; display?: string }> = Array.isArray(
            (existingReq as any).seed_codes,
          )
            ? (existingReq as any).seed_codes
            : [];
          const seen = new Set(prevCodes.map((c) => String(c?.code ?? "")));
          const merged = [...prevCodes];
          for (const c of seedCodes) {
            const code = String(c?.code ?? "").trim();
            if (!code || seen.has(code)) continue;
            seen.add(code);
            merged.push(c);
          }
          if (merged.length !== prevCodes.length) {
            await sb
              .from("terminology_requests" as any)
              .update({ seed_codes: merged, updated_at: new Date().toISOString() } as any)
              .eq("id", (existingReq as any).id);
          }
        }
      } else {
        console.warn("[billing] terminology gap request insert failed", insertErr.message);
      }
    } catch (e) {
      console.warn("[billing] terminology gap request failed", (e as Error).message);
    }
  }

  const input: BuildChargesInput = {
    admissionTime: p.admission_time,
    dischargeTime: p.discharge_time,
    room: p.room,
    meds,
    labs,
    billingMatches,
    chargeMaster,
    imagingOrders,
  };
  const charges = composeCharges(input);
  const { subtotal, tax, total } = summarizeCharges(charges);

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
        primary_diagnosis_icd10: primaryIcd10,
        primary_diagnosis_display: primaryIcd10Display,
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
        primary_diagnosis_icd10: primaryIcd10,
        primary_diagnosis_display: primaryIcd10Display,
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
  // Pull every discharged patient and every mrn that already has an
  // invoice, then compute the set difference. The previous version capped
  // the query at 500 rows, which meant that once the first 500 discharged
  // MRNs (by arbitrary order) each had an invoice, the backfill produced
  // 0 new invoices and every subsequent discharge stalled indefinitely.
  const [{ data: discharged }, { data: invoiced }] = await Promise.all([
    sb.from("patients").select("mrn").ilike("status", "discharged"),
    sb.from("fhir_invoices").select("mrn"),
  ]);
  const invoicedMrns = new Set(
    ((invoiced ?? []) as Array<{ mrn: string | null }>)
      .map((r) => r.mrn)
      .filter((m): m is string => !!m),
  );
  const list = ((discharged ?? []) as Array<{ mrn: string | null }>)
    .filter((r) => r.mrn && !invoicedMrns.has(r.mrn));
  let generated = 0;
  let skipped = 0;
  // Cap per-invocation work to keep the cron under the request budget.
  const MAX_PER_RUN = 200;
  const batch = list.slice(0, MAX_PER_RUN);
  skipped += list.length - batch.length;
  for (const row of batch) {
    if (!row.mrn) {
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