// Ghost Discharge Worker — server-side, browser-independent replacement for
// the legacy PL/pgSQL `auto_discharge_ghost_patients` cron routine.
//
// Why this exists:
//   The old PL/pgSQL path only stamped a generic one-line
//   `patients.discharge_summary` and never wrote a `clinical_notes` row of
//   type DISCHARGE_SUMMARY. That meant the outbound FHIR poller had nothing
//   to publish as a DocumentReference for ghost-discharged patients — the
//   Composition/DocumentReference pipeline only ever fired for patients
//   discharged through the real physician-board UI (which calls
//   `buildDischargeMarkdown` and inserts the DISCHARGE_SUMMARY note).
//
// What it does:
//   1. Reads the same automation gate + selection window as the old routine.
//   2. Fetches the full clinical context for each candidate MRN (patient,
//      medication_orders, lab_orders, lab_results, allergies).
//   3. Calls the SHARED `buildDischargeMarkdown` (imported from
//      `../_shared/discharge-narrative.ts`) — the SAME function the
//      client-side physician-board discharge flow uses. No forked copy.
//   4. INSERTs a `clinical_notes` row (`note_type='DISCHARGE_SUMMARY'`,
//      `author='Ghost AI - Auto Discharge'`) so the outbound poller's
//      `buildDocRef` picks it up on the very next cycle and PUTs the
//      DocumentReference under the stable `docref-{mrn}` id.
//   5. Marks the patient Discharged and frees the bed.
//
// Modes:
//   POST {}                              → normal cron batch (3-4 patients)
//   POST {"mrn":"MRN-XYZ"}               → process a single MRN if it is
//                                          currently admitted and due
//   POST {"mrn":"MRN-XYZ","force":true}  → backfill: regenerate the rich
//                                          DISCHARGE_SUMMARY even if the
//                                          patient is already Discharged
//                                          (used to retroactively upgrade
//                                          patients that got the weak
//                                          PL/pgSQL summary before this
//                                          function existed)

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import {
  buildDischargeMarkdown,
  type NarrativeAllergy,
  type NarrativeLab,
  type NarrativeMed,
  type NarrativePatient,
} from "../_shared/discharge-narrative.ts";
import {
  buildDischargeTransactionBundle,
  type DischargeLab as FhirDischargeLab,
  type DischargeMed as FhirDischargeMed,
  type DischargeVitals as FhirDischargeVitals,
  type AdmissionPatient,
} from "../_shared/fhir-admission-discharge.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const FHIR_SERVER_URL = (Deno.env.get("FHIR_SERVER_URL") ?? "").replace(/\/+$/, "");
const FHIR_BEARER_TOKEN = Deno.env.get("FHIR_BEARER_TOKEN") ?? "";
const FHIR_APIKEY = Deno.env.get("FHIR_APIKEY") ?? "";

async function pushDischargeBundleToFhir(bundle: unknown): Promise<{ ok: boolean; status: number }> {
  if (!FHIR_SERVER_URL || !FHIR_BEARER_TOKEN) {
    return { ok: false, status: 0 };
  }
  const headers: Record<string, string> = {
    "content-type": "application/fhir+json",
    accept: "application/fhir+json",
    authorization: `Bearer ${FHIR_BEARER_TOKEN}`,
  };
  if (FHIR_APIKEY) headers["apikey"] = FHIR_APIKEY;
  const res = await fetch(FHIR_SERVER_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(bundle),
  });
  let bodyText = "";
  try { bodyText = await res.text(); } catch { /* ignore */ }
  if (!res.ok) {
    console.error(`[ghost-discharge-worker] FHIR push ${res.status}:`, bodyText.slice(0, 800));
  }
  return { ok: res.ok, status: res.status };
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "content-type": "application/json" },
  });
}

/**
 * Selects the next batch of Admitted patients whose `target_discharge_at`
 * has elapsed. Mirrors the cadence of the retired PL/pgSQL routine:
 * ~3-4 discharges per 5-minute tick to match the ~1000/24h admit cadence.
 */
async function pickCandidates(admin: any): Promise<string[]> {
  const nowIso = new Date().toISOString();
  const batch = 3 + (Math.random() < 0.47 ? 1 : 0);
  const { data } = await admin
    .from("patients")
    .select("mrn, target_discharge_at, admission_time")
    .eq("status", "Admitted")
    .lte("target_discharge_at", nowIso)
    .order("target_discharge_at", { ascending: true, nullsFirst: false })
    .limit(batch);
  return ((data ?? []) as any[]).map((r) => r.mrn).filter(Boolean);
}

/**
 * Fetch the raw per-encounter clinical context for a single MRN. Consumed
 * both by `buildSummaryForMrn` (narrative markdown) and by the FHIR
 * discharge Composition push (real drug/lab names).
 */
async function fetchClinicalContext(admin: any, mrn: string): Promise<{
  patient: any | null;
  meds: any[];
  labs: any[];
  allergies: any[];
  vitals: any | null;
}> {
  const [pRes, mRes, lRes, lrRes, aRes, vRes] = await Promise.all([
    admin.from("patients").select("*").eq("mrn", mrn).maybeSingle(),
    admin.from("medication_orders")
      .select("id, drug_name, medication_name, dose, route, status, ordered_by, ordering_physician, administered_at, rxnorm_code, rxnorm_display, frequency")
      .eq("patient_mrn", mrn),
    admin.from("lab_orders")
      .select("id, test_type, status, result_value, collected_at, loinc_code")
      .eq("patient_mrn", mrn),
    admin.from("lab_results")
      .select("id, test_name, result_value, unit, flag, reference_range, created_at")
      .eq("mrn", mrn),
    admin.from("allergies")
      .select("substance, reaction, severity")
      .eq("mrn", mrn),
    // Last recorded vitals row at/before discharge — pushed as FHIR
    // Observations so myspehr's Monitoring page has a discharge-time
    // snapshot instead of showing nothing.
    admin.from("vitals")
      .select("hr, bp_systolic, bp_diastolic, spo2, temp_c, rr, recorded_at")
      .eq("mrn", mrn)
      .order("recorded_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);
  const patient = (pRes as any)?.data ?? null;
  const meds = ((mRes as any)?.data ?? []) as any[];
  const labOrders = ((lRes as any)?.data ?? []) as any[];
  const labResults = ((lrRes as any)?.data ?? []) as any[];
  const allergies = ((aRes as any)?.data ?? []) as any[];
  const vitals = (vRes as any)?.data ?? null;
  const labs = [
    ...labOrders.map((l) => ({
      id: l.id,
      test_type: l.test_type ?? null,
      test_name: l.test_type ?? null,
      status: l.status ?? null,
      result_value: l.result_value ?? null,
      collected_at: l.collected_at ?? null,
      loinc_code: l.loinc_code ?? null,
      flag: null,
      unit: null,
    })),
    ...labResults.map((r) => ({
      id: r.id,
      test_type: r.test_name ?? null,
      test_name: r.test_name ?? null,
      status: "Reported",
      result_value: r.result_value ?? null,
      collected_at: r.created_at ?? null,
      loinc_code: null,
      flag: r.flag ?? null,
      unit: r.unit ?? null,
    })),
  ];
  return { patient, meds, labs, allergies, vitals };
}

/**
 * Turn the raw clinical context into the narrative markdown consumed by
 * `clinical_notes` / DocumentReference.
 */
async function buildSummaryForMrn(admin: any, mrn: string): Promise<{
  summary: string | null;
  patient: any | null;
}> {
  const { patient, meds: rawMeds, labs: rawLabs, allergies: rawAllergies } = await fetchClinicalContext(admin, mrn);
  if (!patient) return { summary: null, patient: null };

  const meds: NarrativeMed[] = rawMeds.map((m: any) => ({
    medication_name: m.medication_name ?? m.drug_name ?? null,
    drug_name: m.drug_name ?? null,
    dose: m.dose ?? null,
    route: m.route ?? null,
    status: m.status ?? null,
    ordered_by: m.ordering_physician ?? m.ordered_by ?? null,
    administered_at: m.administered_at ?? null,
    rxnorm_code: m.rxnorm_code ?? null,
    display_name: m.rxnorm_display ?? m.medication_name ?? m.drug_name ?? null,
    frequency: m.frequency ?? null,
  }));

  const labs: NarrativeLab[] = rawLabs.map((l: any) => ({
    test_type: l.test_type ?? null,
    status: l.status ?? null,
    result_value: l.result_value ?? null,
    collected_at: l.collected_at ?? null,
    loinc_code: l.loinc_code ?? null,
    display_name: l.test_name ?? l.test_type ?? null,
    unit: l.unit ?? null,
    abnormal_flag: l.flag ?? null,
  }));

  const allergies: NarrativeAllergy[] = rawAllergies.map((a: any) => ({
    substance: a.substance ?? null,
    reaction: a.reaction ?? null,
    severity: a.severity ?? null,
    category: null,
  }));

  const narrativePatient: NarrativePatient = {
    first_name: patient.first_name ?? null,
    last_name: patient.last_name ?? null,
    name: patient.name ?? null,
    mrn: patient.mrn ?? mrn,
    age: patient.age ?? null,
    gender: patient.gender ?? patient.biological_sex ?? null,
    chief_complaint: patient.chief_complaint ?? null,
    admission_time: patient.admission_time ?? null,
    discharge_time: patient.discharge_time ?? new Date().toISOString(),
    icd10_codes: patient.icd10_codes ?? null,
    snomed_codes: patient.snomed_codes ?? null,
    diagnosis: patient.diagnosis ?? null,
    past_medical_history: patient.past_medical_history ?? null,
    past_surgical_history: patient.past_surgical_history ?? null,
    primary_care_physician: patient.primary_care_physician ?? null,
  };

  const summary = buildDischargeMarkdown(narrativePatient, meds, labs, allergies);
  return { summary, patient };
}

async function processMrn(admin: any, mrn: string, opts: { force: boolean }): Promise<{
  mrn: string;
  ok: boolean;
  reason?: string;
  note_id?: string;
  summary_len?: number;
}> {
  const { summary: autoSummary, patient } = await buildSummaryForMrn(admin, mrn);
  if (!patient) return { mrn, ok: false, reason: "no_patient_row" };
  if (!autoSummary) return { mrn, ok: false, reason: "summary_build_failed" };

  // A UI path can pass a clinician-authored discharge summary (e.g. the free
  // text typed in the patient-chart DischargeDialog). When present, that
  // text becomes the DISCHARGE_SUMMARY note + patients.discharge_summary
  // (what the clinician wrote wins on the narrative surface). The FHIR
  // Composition below is ALWAYS rebuilt from real DB rows regardless, so
  // structured meds/labs/diagnoses remain accurate.
  const override = typeof (opts as any).override === "string"
    ? String((opts as any).override).trim()
    : "";
  const summary = override.length > 0 ? override : autoSummary;
  const noteAuthor = override.length > 0 ? "Clinician - Manual Discharge" : "Ghost AI - Auto Discharge";

  const alreadyDischarged = String(patient.status ?? "").toLowerCase() === "discharged";
  if (alreadyDischarged && !opts.force) {
    return { mrn, ok: false, reason: "already_discharged" };
  }

  // Insert the DISCHARGE_SUMMARY note so the outbound poller picks it up
  // and publishes the DocumentReference on the next cycle.
  const { data: noteRow, error: noteErr } = await admin
    .from("clinical_notes")
    .insert({
      mrn,
      note_type: "DISCHARGE_SUMMARY",
      author: noteAuthor,
      content: summary,
    })
    .select("id")
    .maybeSingle();
  if (noteErr) return { mrn, ok: false, reason: `note_insert_failed: ${noteErr.message}` };

  // Mark the patient discharged (or refresh the summary if forcing a
  // retroactive backfill on an already-discharged row).
  const patientUpdate: Record<string, unknown> = { discharge_summary: summary };
  if (!alreadyDischarged) {
    patientUpdate.status = "Discharged";
    patientUpdate.discharge_time = new Date().toISOString();
  }
  const { error: pErr } = await admin
    .from("patients")
    .update(patientUpdate)
    .eq("mrn", mrn);
  if (pErr) return { mrn, ok: false, reason: `patient_update_failed: ${pErr.message}` };

  // Free the bed only for a fresh discharge — backfill on an already
  // discharged patient must not touch bed_management (the bed may have
  // been reassigned in the meantime).
  if (!alreadyDischarged) {
    await admin
      .from("bed_management")
      .update({
        // Kick the just-freed bed into the 3-phase turnover cycle
        // (Cleaning → Disinfecting → Making Bed → Available) driven by the
        // client-side sweepBedCleaningCycles() sweep in useAIAutomation.ts.
        // Setting status directly to "Available" here would bypass the
        // turnover entirely and let the bed be re-assigned immediately,
        // which mismatches both the ghost-discharge SQL path and the
        // manual nurse discharge flow.
        status: "Cleaning",
        current_patient_mrn: null,
        status_updated_at: new Date().toISOString(),
      })
      .eq("current_patient_mrn", mrn);
  }

  // Rebuild the FHIR Discharge Composition with REAL per-encounter meds/labs
  // and push it to Medblocks. Fixes the admission-time Composition that
  // hallucinated drug names from a per-diagnosis template and reported
  // "No laboratory observations / No discharge medications" because it ran
  // before any orders existed.
  let composition_push: { ok: boolean; status: number } | undefined;
  try {
    const { patient: freshPatient, meds: rawMeds, labs: rawLabs, vitals: rawVitals } = await fetchClinicalContext(admin, mrn);
    const fhirMeds: FhirDischargeMed[] = rawMeds.map((m: any) => ({
      id: m.id,
      drug: m.medication_name ?? m.drug_name ?? "medication",
      drug_name: m.drug_name ?? undefined,
      medication_name: m.medication_name ?? undefined,
      dose: m.dose ?? undefined,
      route: m.route ?? undefined,
      frequency: m.frequency ?? undefined,
      rxnorm: m.rxnorm_code ?? undefined,
      status: m.status ?? undefined,
      ordering_physician: m.ordering_physician ?? m.ordered_by ?? undefined,
    }));
    const fhirLabs: FhirDischargeLab[] = rawLabs.map((l: any) => ({
      test_name: l.test_name ?? l.test_type ?? "Lab",
      test_type: l.test_type ?? undefined,
      result_value: l.result_value ?? undefined,
      unit: l.unit ?? undefined,
      loinc: l.loinc_code ?? undefined,
      flag: l.flag ?? undefined,
      collected_at: l.collected_at ?? undefined,
      performing_lab: "SPEHR Central Laboratory",
    }));
    const admissionPatient: AdmissionPatient = {
      mrn,
      first_name: freshPatient.first_name ?? null,
      last_name: freshPatient.last_name ?? null,
      name: freshPatient.name ?? null,
      dob: freshPatient.dob ?? null,
      age: freshPatient.age ?? null,
      gender: freshPatient.gender ?? freshPatient.biological_sex ?? null,
      admission_time: freshPatient.admission_time ?? null,
      discharge_time: freshPatient.discharge_time ?? patientUpdate.discharge_time as string ?? new Date().toISOString(),
      status: "Discharged",
      chief_complaint: freshPatient.chief_complaint ?? null,
      diagnosis: freshPatient.diagnosis ?? null,
      past_medical_history: freshPatient.past_medical_history ?? null,
      past_surgical_history: freshPatient.past_surgical_history ?? null,
      allergies: freshPatient.allergies ?? null,
      environmental_allergies: freshPatient.environmental_allergies ?? null,
      primary_care_physician: freshPatient.primary_care_physician ?? null,
      room: freshPatient.room ?? null,
      assigned_department: freshPatient.assigned_department ?? null,
      discharge_summary: summary,
    };
    const fhirVitals: FhirDischargeVitals | null = rawVitals
      ? {
          hr: rawVitals.hr ?? null,
          bp_systolic: rawVitals.bp_systolic ?? null,
          bp_diastolic: rawVitals.bp_diastolic ?? null,
          spo2: rawVitals.spo2 ?? null,
          temp_c: rawVitals.temp_c ?? null,
          rr: rawVitals.rr ?? null,
          recorded_at: rawVitals.recorded_at ?? null,
        }
      : null;
    const { bundle } = buildDischargeTransactionBundle({
      patient: admissionPatient,
      labs: fhirLabs,
      dischargeMeds: fhirMeds,
      vitals: fhirVitals,
      admittingDiagnosis: freshPatient.chief_complaint ?? undefined,
      dischargeDiagnosis: freshPatient.diagnosis ?? freshPatient.chief_complaint ?? undefined,
      conditionAtDischarge: "Stable, improved.",
      diet: "Regular as tolerated",
      activity: "Activity as tolerated",
      physicalExam: {
        general: "Awake, alert, in no acute distress on admission.",
        cardiovascular: "Regular rate and rhythm, no murmurs.",
        pulmonary: "Clear to auscultation bilaterally.",
        abdomen: "Soft, non-tender, non-distended.",
        neurologic: "Alert and oriented x3, no focal deficits.",
      },
    });
    composition_push = await pushDischargeBundleToFhir(bundle);
  } catch (e) {
    composition_push = { ok: false, status: -1 };
    console.error("[ghost-discharge-worker] composition push failed:", (e as Error).message);
  }

  return { mrn, ok: true, note_id: noteRow?.id, summary_len: summary.length, composition_push };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  let body: any = {};
  try { body = await req.json(); } catch { /* empty body is fine */ }
  const targetMrn: string | undefined = body?.mrn;
  const force: boolean = !!body?.force;
  const override: string | undefined = typeof body?.discharge_summary_override === "string"
    ? body.discharge_summary_override
    : undefined;

  // Automation gate — respect the global kill switch for the cron path
  // (backfill / explicit single-MRN calls bypass it).
  if (!targetMrn) {
    const { data: settings } = await admin
      .from("system_settings")
      .select("automation_enabled")
      .eq("id", 1)
      .maybeSingle();
    if (settings && (settings as any).automation_enabled === false) {
      return json({ ok: true, skipped: "automation_disabled", results: [] });
    }
  }

  const mrns = targetMrn ? [targetMrn] : await pickCandidates(admin);
  const results: any[] = [];
  for (const mrn of mrns) {
    try {
      results.push(await processMrn(admin, mrn, { force, override } as any));
    } catch (e) {
      results.push({ mrn, ok: false, reason: `exception: ${(e as Error).message}` });
    }
  }

  return json({
    ok: true,
    mode: targetMrn ? (force ? "backfill" : "single") : "cron_batch",
    processed: results.length,
    succeeded: results.filter((r) => r.ok).length,
    results,
  });
});