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
  type NarrativeImaging,
  type NarrativeLab,
  type NarrativeMed,
  type NarrativePatient,
  type NarrativeProcedure,
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
const SPEHR_APP_URL = (Deno.env.get("SPEHR_APP_URL") ?? "https://www.spehr.live").replace(
  /\/+$/,
  "",
);

// Phase D: recall/follow-up appointment settings, read fresh per discharge
// (cheap single-row lookup) rather than cached, since an operator may flip
// `recall_enabled`/`recall_rate` between worker invocations.
async function fetchRecallSettings(admin: any): Promise<{
  recall_enabled: boolean;
  recall_rate: number;
  recall_offset_min_hours: number;
  recall_offset_max_hours: number;
}> {
  const { data } = await admin
    .from("system_settings")
    .select("recall_enabled, recall_rate, recall_offset_min_hours, recall_offset_max_hours")
    .eq("id", 1)
    .maybeSingle();
  return {
    recall_enabled: !!(data as any)?.recall_enabled,
    recall_rate: Number((data as any)?.recall_rate ?? 0.3),
    recall_offset_min_hours: Number((data as any)?.recall_offset_min_hours ?? 26),
    recall_offset_max_hours: Number((data as any)?.recall_offset_max_hours ?? 32),
  };
}

/** FHIR id constraint: [A-Za-z0-9-.]{1,64}. */
function sanitizeFhirId(id: string): string {
  return id.replace(/[^A-Za-z0-9-.]/g, "-").slice(0, 64);
}

/** Round a Date to the nearest 15 minutes. */
function roundToNearest15Min(d: Date): Date {
  const ms = 15 * 60_000;
  return new Date(Math.round(d.getTime() / ms) * ms);
}

/**
 * Decide whether this discharge earns a recall appointment and, if so,
 * insert the local `fhir_appointments` row for it (with `needs_fhir_push:
 * false` — the discharge bundle transaction pushes it directly, in the same
 * atomic bundle as the Composition, so the outbound poller must not also
 * try). Returns the id + timing to pass into `buildDischargeTransactionBundle`,
 * or null when no recall was scheduled. Never throws — any failure here is
 * logged and swallowed so it can never block the actual discharge.
 */
async function maybeScheduleRecall(
  admin: any,
  mrn: string,
  patient: any,
  dischargeTimeMs: number,
  compositionId: string | undefined,
): Promise<{
  id: string;
  start: string;
  end: string;
  practitioner?: string;
  facility?: string;
  description?: string;
} | null> {
  try {
    const settings = await fetchRecallSettings(admin);
    if (!settings.recall_enabled) return null;
    if (!(Math.random() < settings.recall_rate)) return null;
    // Chain-breaker: a patient currently admitted BECAUSE of a recall does
    // not get another recall scheduled on this discharge.
    if (patient.admission_source === "recall") return null;
    const facility = patient.facility_name as string | null;
    if (!facility) return null;

    const minH = settings.recall_offset_min_hours;
    const maxH = settings.recall_offset_max_hours;
    const offsetHours = minH + Math.random() * Math.max(0, maxH - minH);
    const start = roundToNearest15Min(new Date(dischargeTimeMs + offsetHours * 3_600_000));
    const end = new Date(start.getTime() + 30 * 60_000);

    const id = sanitizeFhirId(`recall-${mrn}-${Math.floor(dischargeTimeMs / 1000)}`);
    const patientName =
      [patient.first_name, patient.last_name].filter(Boolean).join(" ") || patient.name || mrn;
    const description = `Post-discharge follow-up for ${patient.chief_complaint ?? "recent admission"}`;

    const { error } = await admin.from("fhir_appointments").insert({
      fhir_id: id,
      origin: "recall",
      status: "proposed",
      facility_name: facility,
      patient_mrn: mrn,
      patient_name: patientName,
      practitioner_name: patient.primary_care_physician ?? null,
      service_type: "Post-discharge follow-up",
      description,
      start_time: start.toISOString(),
      end_time: end.toISOString(),
      comment: "Auto-scheduled from discharge summary",
      source_composition_id: compositionId ?? null,
      needs_fhir_push: false,
    });
    if (error) {
      console.error(
        `[ghost-discharge-worker] recall appointment insert failed for ${mrn}:`,
        error.message,
      );
      return null;
    }

    return {
      id,
      start: start.toISOString(),
      end: end.toISOString(),
      practitioner: patient.primary_care_physician ?? undefined,
      facility,
      description,
    };
  } catch (e) {
    console.error(
      `[ghost-discharge-worker] maybeScheduleRecall exception for ${mrn}:`,
      (e as Error).message,
    );
    return null;
  }
}

/** If the discharge bundle push failed, flag the recall row dirty so Phase
 * B's outbound poller retries it independently on the next tick instead of
 * it being silently lost (it was inserted with needs_fhir_push:false on the
 * assumption the bundle push would succeed). */
async function markRecallDirtyIfBundlePushFailed(
  admin: any,
  recallFhirId: string | undefined,
  pushOk: boolean,
) {
  if (!recallFhirId || pushOk) return;
  const { error } = await admin
    .from("fhir_appointments")
    .update({ needs_fhir_push: true })
    .eq("fhir_id", recallFhirId);
  if (error) {
    console.error(
      `[ghost-discharge-worker] failed to mark recall appt ${recallFhirId} dirty:`,
      error.message,
    );
  }
}

// Fire-and-forget: ask the app to generate the FHIR Invoice for this MRN
// right away, instead of waiting for the next backfill-invoices-every-10min
// cron tick. Best-effort only — a failure here must never block or fail
// the discharge itself, so every branch of this is swallowed.
async function triggerInvoiceGeneration(mrn: string): Promise<void> {
  try {
    await fetch(`${SPEHR_APP_URL}/api/public/hooks/generate-invoice`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mrn }),
      signal: AbortSignal.timeout(8000),
    });
  } catch (e) {
    console.warn(
      `[ghost-discharge-worker] generate-invoice hook failed for ${mrn}:`,
      (e as Error).message,
    );
  }
}

async function pushDischargeBundleToFhir(
  bundle: unknown,
): Promise<{ ok: boolean; status: number }> {
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
  try {
    bodyText = await res.text();
  } catch {
    /* ignore */
  }
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
interface RawImagingRow {
  exam_type: string | null;
  modality: string | null;
  body_part: string | null;
  status: string | null;
  report_text: string | null;
  impression: string | null;
  ordered_at: string | null;
  resulted_at: string | null;
  snomed_display: string | null;
}

interface RawProcedureRow {
  display_text: string | null;
  status: string | null;
  performed_at: string | null;
  cpt_code: string | null;
  cpt_display: string | null;
  snomed_display: string | null;
  performed_by: string | null;
}

async function fetchClinicalContext(
  admin: any,
  mrn: string,
): Promise<{
  patient: any | null;
  meds: any[];
  labs: any[];
  allergies: any[];
  imaging: RawImagingRow[];
  procedures: RawProcedureRow[];
  vitals: any | null;
}> {
  const [pRes, mRes, lRes, lrRes, aRes, vRes, radRes, procRes] = await Promise.all([
    admin.from("patients").select("*").eq("mrn", mrn).maybeSingle(),
    admin
      .from("medication_orders")
      .select(
        "id, drug_name, medication_name, dose, route, status, ordered_by, ordering_physician, administered_at, rxnorm_code, rxnorm_display, frequency",
      )
      .eq("patient_mrn", mrn),
    admin
      .from("lab_orders")
      .select("id, test_type, status, result_value, collected_at, loinc_code")
      .eq("patient_mrn", mrn),
    admin
      .from("lab_results")
      .select("id, test_name, result_value, unit, flag, reference_range, created_at")
      .eq("mrn", mrn),
    admin.from("allergies").select("substance, reaction, severity").eq("mrn", mrn),
    // Last recorded vitals row at/before discharge — pushed as FHIR
    // Observations so myspehr's Monitoring page has a discharge-time
    // snapshot instead of showing nothing.
    admin
      .from("vitals")
      .select("hr, bp_systolic, bp_diastolic, spo2, temp_c, rr, recorded_at")
      .eq("mrn", mrn)
      .order("recorded_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    // Reported imaging — same table the radiology board writes to. Needed
    // so the auto-discharge narrative (this worker) matches the manual
    // physician-board discharge narrative, which also now includes imaging.
    admin
      .from("radiology_orders")
      .select(
        "exam_type, modality, body_part, status, report_text, impression, ordered_at, resulted_at, snomed_display",
      )
      .eq("patient_mrn", mrn),
    // Real procedures — drives "Procedures Performed" instead of a
    // hardcoded negative claim.
    admin
      .from("procedures")
      .select(
        "display_text, status, performed_at, cpt_code, cpt_display, snomed_display, performed_by",
      )
      .eq("mrn", mrn),
  ]);
  const patient = (pRes as any)?.data ?? null;
  const meds = ((mRes as any)?.data ?? []) as any[];
  const labOrders = ((lRes as any)?.data ?? []) as any[];
  const labResults = ((lrRes as any)?.data ?? []) as any[];
  const allergies = ((aRes as any)?.data ?? []) as any[];
  const vitals = (vRes as any)?.data ?? null;
  const imaging = (radRes?.data ?? []) as RawImagingRow[];
  const procedures = (procRes?.data ?? []) as RawProcedureRow[];
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
  return { patient, meds, labs, allergies, imaging, procedures, vitals };
}

/**
 * Turn the raw clinical context into the narrative markdown consumed by
 * `clinical_notes` / DocumentReference.
 */
async function buildSummaryForMrn(
  admin: any,
  mrn: string,
): Promise<{
  summary: string | null;
  patient: any | null;
}> {
  const {
    patient,
    meds: rawMeds,
    labs: rawLabs,
    allergies: rawAllergies,
    imaging: rawImaging,
    procedures: rawProcedures,
  } = await fetchClinicalContext(admin, mrn);
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

  const imaging: NarrativeImaging[] = rawImaging.map((i) => ({
    exam_type: i.exam_type ?? null,
    modality: i.modality ?? null,
    body_part: i.body_part ?? null,
    status: i.status ?? null,
    report_text: i.report_text ?? null,
    impression: i.impression ?? null,
    ordered_at: i.ordered_at ?? null,
    resulted_at: i.resulted_at ?? null,
    snomed_display: i.snomed_display ?? null,
  }));

  const procedures: NarrativeProcedure[] = rawProcedures.map((p) => ({
    display_text: p.display_text ?? null,
    status: p.status ?? null,
    performed_at: p.performed_at ?? null,
    cpt_code: p.cpt_code ?? null,
    cpt_display: p.cpt_display ?? null,
    snomed_display: p.snomed_display ?? null,
    performed_by: p.performed_by ?? null,
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

  const summary = buildDischargeMarkdown(
    narrativePatient,
    meds,
    labs,
    allergies,
    imaging,
    procedures,
  );
  return { summary, patient };
}

async function processMrn(
  admin: any,
  mrn: string,
  opts: { force: boolean },
): Promise<{
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
  const override =
    typeof (opts as any).override === "string" ? String((opts as any).override).trim() : "";
  const summary = override.length > 0 ? override : autoSummary;
  const noteAuthor =
    override.length > 0 ? "Clinician - Manual Discharge" : "Ghost AI - Auto Discharge";

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
  const { error: pErr } = await admin.from("patients").update(patientUpdate).eq("mrn", mrn);
  if (pErr) return { mrn, ok: false, reason: `patient_update_failed: ${pErr.message}` };

  // Phase D: independent of the invoice hook below — a configurable chance
  // of a real recall/follow-up Appointment, only for a genuine new discharge
  // (never on a force-backfill re-run of an already-discharged patient).
  // Populated below; passed into buildDischargeTransactionBundle further
  // down so the Appointment rides the SAME atomic FHIR transaction as the
  // Composition.
  let recallAppt: Awaited<ReturnType<typeof maybeScheduleRecall>> = null;

  // Free the bed only for a fresh discharge — backfill on an already
  // discharged patient must not touch bed_management (the bed may have
  // been reassigned in the meantime).
  if (!alreadyDischarged) {
    // Prompt Auto Doc to bill this discharge immediately (myspehr's
    // billing section should show it promptly, not wait up to 10 minutes
    // for the next backfill-invoices cron tick). Awaited so its own
    // 8s timeout bounds this call, but any failure is swallowed inside
    // triggerInvoiceGeneration and never blocks/fails the discharge.
    await triggerInvoiceGeneration(mrn);

    // Independent of the invoice hook above: maybe schedule a recall
    // appointment. Never blocks/fails the discharge (all errors swallowed
    // inside maybeScheduleRecall).
    const dischargeTimeMs = new Date(patientUpdate.discharge_time as string).getTime();
    recallAppt = await maybeScheduleRecall(admin, mrn, patient, dischargeTimeMs, undefined);

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
    const {
      patient: freshPatient,
      meds: rawMeds,
      labs: rawLabs,
      vitals: rawVitals,
    } = await fetchClinicalContext(admin, mrn);
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
      discharge_time:
        freshPatient.discharge_time ??
        (patientUpdate.discharge_time as string) ??
        new Date().toISOString(),
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
    // Phase D: compressed-timeline follow-up text. Default stays "within 2
    // days" (the confirmed simulated-timeline decision) whether or not a
    // real appointment exists; when one does, name it explicitly so the
    // patient knows to confirm it in MySPEHR.
    const pcpText = admissionPatient.primary_care_physician ?? "your PCP";
    const followUpText = recallAppt
      ? (() => {
          const hours = Math.max(
            1,
            (new Date(recallAppt!.start).getTime() -
              new Date(admissionPatient.discharge_time ?? Date.now()).getTime()) /
              3_600_000,
          );
          const startUtc = new Date(recallAppt!.start).toISOString();
          return `Follow up with ${pcpText} within ${Math.ceil(hours / 24)} day(s). Hospital follow-up appointment scheduled for ${startUtc} at ${recallAppt!.facility ?? "your facility"} — confirm it in MySPEHR.`;
        })()
      : `Follow up with ${pcpText} within 2 days.`;

    const { bundle, compositionId: pushedCompositionId } = buildDischargeTransactionBundle({
      patient: admissionPatient,
      labs: fhirLabs,
      dischargeMeds: fhirMeds,
      vitals: fhirVitals,
      admittingDiagnosis: freshPatient.chief_complaint ?? undefined,
      dischargeDiagnosis: freshPatient.diagnosis ?? freshPatient.chief_complaint ?? undefined,
      conditionAtDischarge: "Stable, improved.",
      diet: "Regular as tolerated",
      activity: "Activity as tolerated",
      followUp: followUpText,
      physicalExam: {
        general: "Awake, alert, in no acute distress on admission.",
        cardiovascular: "Regular rate and rhythm, no murmurs.",
        pulmonary: "Clear to auscultation bilaterally.",
        abdomen: "Soft, non-tender, non-distended.",
        neurologic: "Alert and oriented x3, no focal deficits.",
      },
      followUpAppointment: recallAppt ?? undefined,
    });
    composition_push = await pushDischargeBundleToFhir(bundle);

    // Backfill the recall row's source_composition_id now that we know it
    // (deterministic, but only computed inside buildDischargeTransactionBundle).
    if (recallAppt && pushedCompositionId) {
      await admin
        .from("fhir_appointments")
        .update({ source_composition_id: pushedCompositionId })
        .eq("fhir_id", recallAppt.id);
    }

    // If the bundle push failed, the recall Appointment (inserted with
    // needs_fhir_push:false on the assumption this same-transaction push
    // would carry it) never reached FHIR — flag it dirty so Phase B's
    // outbound poller retries it independently on the next tick.
    if (recallAppt) {
      await markRecallDirtyIfBundlePushFailed(admin, recallAppt.id, composition_push.ok);
    }
  } catch (e) {
    composition_push = { ok: false, status: -1 };
    console.error("[ghost-discharge-worker] composition push failed:", (e as Error).message);
    if (recallAppt) {
      await markRecallDirtyIfBundlePushFailed(admin, recallAppt.id, false);
    }
  }

  return { mrn, ok: true, note_id: noteRow?.id, summary_len: summary.length, composition_push };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  let body: any = {};
  try {
    body = await req.json();
  } catch {
    /* empty body is fine */
  }
  const targetMrn: string | undefined = body?.mrn;
  const force: boolean = !!body?.force;
  const override: string | undefined =
    typeof body?.discharge_summary_override === "string"
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
