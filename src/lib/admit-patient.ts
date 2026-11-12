import { supabase } from "@/integrations/supabase/client";
import {
  seedAdmission,
  claimBedForAdmission,
  releaseBedForAdmission,
} from "@/hooks/useAIAutomation";
import { saveAudit, type NlpResult } from "@/lib/nlp-engine";
import { intakeToSoap, saveIntake, type IntakeRecord } from "@/lib/intake-record";
import type { CodeStatus } from "@/lib/patients";
import { runSixStreamPipeline } from "@/lib/coding-pipeline";
import { recommendDefinitionType } from "@/lib/value-set-registry";
import type { Database } from "@/integrations/supabase/types";

export interface AdmitInput {
  name: string;
  age: number;
  gender: "M" | "F";
  room: string;
  code_status: CodeStatus;
  diagnosis: string;
  mrn?: string;
  nlp?: NlpResult;
  intake?: IntakeRecord;
}

export interface AdmitResult {
  ok: boolean;
  error?: string;
  patient?: Database["public"]["Tables"]["patients"]["Row"];
}

export function genMRN() {
  return `MRN-${Math.floor(100000 + Math.random() * 900000)}`;
}

export function normalizeFhirGender(
  value: string | null | undefined,
): "male" | "female" | "other" | "unknown" {
  const raw = (value ?? "").toString().trim().toLowerCase();
  if (raw === "m" || raw === "male" || raw === "man") return "male";
  if (raw === "f" || raw === "female" || raw === "woman") return "female";
  if (raw === "o" || raw === "other" || raw === "non-binary" || raw === "nonbinary") return "other";
  return "unknown";
}

export function safeDob(rawDob: string | null | undefined, age: number): string {
  if (rawDob && /^\d{4}-\d{2}-\d{2}$/.test(rawDob)) return rawDob;
  const years = Number.isFinite(age) ? Math.max(0, Math.min(120, Math.floor(age))) : 0;
  const d = new Date();
  d.setFullYear(d.getFullYear() - years);
  return d.toISOString().slice(0, 10);
}

/**
 * Shared admission writer used by the Nurse and Admissions/Reception boards.
 * Performs the patient INSERT, NLP audit save, intake/SOAP persistence,
 * Auto-Doc seed, and verifies a bed was claimed. Pure data side effects —
 * UI/toast handling lives in the caller.
 */
export async function admitPatient(facility: string, input: AdmitInput): Promise<AdmitResult> {
  const mrn = input.mrn?.trim() || genMRN();
  const [first_name, ...rest] = input.name.trim().split(/\s+/);
  const last_name = rest.join(" ") || "—";
  const fhirGender = normalizeFhirGender(input.intake?.sex ?? input.gender);
  const genderIdentity = normalizeFhirGender(input.intake?.genderIdentity ?? fhirGender);
  const it = input.intake;
  const familyHistoryText = it
    ? [it.familyConditions?.join(", "), it.familyNotes].filter(Boolean).join(" — ") || null
    : null;
  const drugAllergiesText =
    it?.drugAllergies
      ?.map((a) =>
        [a.name?.trim(), a.reaction?.trim() ? `(${a.reaction.trim()})` : ""]
          .filter(Boolean)
          .join(" "),
      )
      .filter(Boolean)
      .join("; ") || null;
  const currentMedicationsText =
    it?.currentMeds
      ?.map((m) => [m.name?.trim(), m.dose?.trim(), m.freq?.trim()].filter(Boolean).join(" "))
      .filter(Boolean)
      .join("; ") || null;

  // Reserve-then-insert: atomically claim a bed BEFORE writing the
  // `patients` row. If the facility has 0 truly-Available beds (or we
  // lose a race to a concurrent admission), bail out here — no patient
  // row is ever created, so the "no empty beds" error below is always
  // true and there is no orphaned admitted-with-no-bed patient left
  // behind. See claimBedForAdmission() in useAIAutomation.ts.
  const claimedRoom = await claimBedForAdmission(facility, mrn);
  if (!claimedRoom) {
    return { ok: false, error: "No empty beds — admission was not created." };
  }

  const payload = {
    mrn,
    first_name,
    last_name,
    name: `${first_name} ${last_name}`,
    age: input.age,
    gender: fhirGender,
    dob: safeDob(input.intake?.dob, input.age),
    biological_sex: fhirGender,
    gender_identity: genderIdentity,
    phone: input.intake?.phone?.trim() || null,
    room: claimedRoom,
    code_status: input.code_status,
    chief_complaint: input.diagnosis.trim(),
    hr: 76,
    bp_systolic: 120,
    bp_diastolic: 78,
    temp: 98.6,
    spo2: 98,
    status: "Admitted",
    facility_name: facility,
    admission_time: new Date().toISOString(),
    occupation: it?.occupation?.trim() || null,
    address: it?.address?.trim() || null,
    emergency_contact_name: it?.emergencyName?.trim() || null,
    emergency_contact_relationship: it?.emergencyRelationship || null,
    emergency_contact_phone: it?.emergencyPhone?.trim() || null,
    insurance_provider: it?.insuranceProvider?.trim() || null,
    insurance_policy_number: it?.insurancePolicy?.trim() || null,
    guarantor: it?.guarantor?.trim() || null,
    primary_care_physician: it?.pcp?.trim() || null,
    hpi_onset: it?.hpiOnset?.trim() || null,
    hpi_location: it?.hpiLocation?.trim() || null,
    hpi_duration: it?.hpiDuration || null,
    hpi_character: it?.hpiCharacter?.length ? it.hpiCharacter.join(", ") : null,
    hpi_aggravating_factors: it?.hpiAggravating?.trim() || null,
    hpi_alleviating_factors: it?.hpiAlleviating?.trim() || null,
    hpi_severity: it?.hpiSeverity != null ? `${it.hpiSeverity}/10` : null,
    past_medical_history: it?.chronicIllnesses?.length ? it.chronicIllnesses.join(", ") : null,
    past_surgical_history: it?.priorSurgeries?.trim() || null,
    past_hospitalizations: it?.pastHospitalizations?.trim() || null,
    family_history: familyHistoryText,
    environmental_allergies: it?.envAllergies?.length ? it.envAllergies.join(", ") : null,
    allergies: drugAllergiesText,
    current_medications: currentMedicationsText,
  };

  const { data, error } = await supabase.from("patients").insert(payload).select().single();
  if (error) {
    // The bed was already claimed above; release it back to Available so
    // a failed insert never leaks a bed that's Occupied with no patient.
    await releaseBedForAdmission(mrn).catch(() => {});
    return { ok: false, error: error.message };
  }

  if (input.nlp) {
    try {
      saveAudit(input.nlp, {
        mrn: data.mrn,
        patient_name: `${data.first_name} ${data.last_name}`,
        facility_name: data.facility_name,
      });
    } catch (e) {
      console.warn("[admit] saveAudit failed", e);
    }
  }

  if (input.intake) {
    try {
      const mrnSafe = data.mrn ?? mrn;
      saveIntake(mrnSafe, { ...input.intake, mrn: mrnSafe });
      const soap = intakeToSoap({ ...input.intake, mrn: mrnSafe });
      await supabase.from("clinical_notes").insert({
        mrn: mrnSafe,
        note_type: "Admission Intake (SOAP)",
        content: soap,
        author: "Admitting Provider",
      });
    } catch (e) {
      console.warn("[admit] intake persist failed", e);
    }
  }

  try {
    await seedAdmission(
      {
        id: data.id,
        mrn: data.mrn,
        first_name: data.first_name,
        last_name: data.last_name,
        name: data.name ?? null,
        facility_name: data.facility_name,
        chief_complaint: data.chief_complaint ?? null,
      },
      { manual: true },
    );
  } catch (e) {
    console.warn("[admit] seedAdmission failed", e);
  }

  // Bed was already atomically claimed above (before insert), so there is
  // no post-hoc "did we actually get a bed?" check needed here anymore.

  // Fire-and-forget six-stream coding pipeline. Never blocks admission.
  // Pass form-time snapshot so Streams C/D/E/F don't depend on empty tables.
  const it2 = input.intake;
  const tempC =
    typeof payload.temp === "number"
      ? +(((payload.temp as number) - 32) * (5 / 9)).toFixed(1)
      : null;
  const admissionData = {
    medications: (it2?.currentMeds ?? [])
      .map((m) => ({
        name: (m.name ?? "").trim(),
        dose: (m.dose ?? "").trim() || undefined,
        frequency: (m.freq ?? "").trim() || undefined,
      }))
      .filter((m) => m.name),
    vitals: {
      bp_systolic: payload.bp_systolic ?? null,
      bp_diastolic: payload.bp_diastolic ?? null,
      hr: payload.hr ?? null,
      spo2: payload.spo2 ?? null,
      temp_c: tempC,
    },
    labs: [] as Array<{ test_name: string }>,
    allergies: [
      ...(it2?.drugAllergies ?? [])
        .map((a) => ({
          substance: (a.name ?? "").trim(),
          reaction: (a.reaction ?? "").trim() || null,
          type: "drug",
        }))
        .filter((a) => a.substance),
      ...(it2?.envAllergies ?? [])
        .map((s) => ({ substance: String(s ?? "").trim(), reaction: null, type: "environmental" }))
        .filter((a) => a.substance),
    ],
  };
  void runSixStreamPipeline(mrn, admissionData).catch((e) =>
    console.warn("[admit] coding pipeline failed", e),
  );

  // Auto Admin → Auto Terminologist: request an HRRP tracked-conditions
  // value set the first time an admission runs through this codepath.
  // Dedupe by requested_name so it's only ever submitted once.
  void requestHrrpValueSet().catch((e) => console.warn("[admit] HRRP request failed", e));

  return { ok: true, patient: data };
}

const HRRP_REQUEST_NAME = "CMS Hospital Readmissions Reduction Program (HRRP) Conditions";

async function requestHrrpValueSet(): Promise<void> {
  const { data: existing } = await supabase
    .from("terminology_requests")
    .select("id")
    .eq("requested_name", HRRP_REQUEST_NAME)
    .in("status", ["pending", "drafted", "published"])
    .limit(1);
  if (existing && existing.length > 0) return;
  const seedCodes = [
    { code: "I50.9", display: "Heart failure, unspecified", vocabulary: "ICD-10" },
    {
      code: "J44.9",
      display: "Chronic obstructive pulmonary disease, unspecified",
      vocabulary: "ICD-10",
    },
    { code: "J18.9", display: "Pneumonia, unspecified organism", vocabulary: "ICD-10" },
    { code: "I21.9", display: "Acute myocardial infarction, unspecified", vocabulary: "ICD-10" },
    { code: "Z96.641", display: "Presence of right artificial hip joint", vocabulary: "ICD-10" },
    { code: "Z96.652", display: "Presence of left artificial knee joint", vocabulary: "ICD-10" },
  ];
  const recommendation = await recommendDefinitionType({
    vocabulary: "ICD-10",
    candidates: seedCodes,
  });
  await supabase.from("terminology_requests").insert({
    requesting_consumer: "Auto Admin",
    requested_name: HRRP_REQUEST_NAME,
    justification:
      "Need a governed value set of HRRP-tracked diagnoses to flag admissions for enhanced discharge planning",
    vocabulary: "ICD-10",
    clinical_application: "Billing",
    priority: "high",
    request_type: "create",
    requested_at: new Date().toISOString(),
    status: "pending",
    seed_codes: seedCodes,
    recommended_type: recommendation.recommendedType,
    reasoning: recommendation.reasoning,
    suggested_root_concept: recommendation.suggestedRootConcept ?? null,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
}

/**
 * Release any beds whose `current_patient_mrn` no longer maps to an
 * actively admitted patient. Shared with the bed-management board.
 */
export async function reconcileOrphanedBeds(facility: string): Promise<void> {
  if (!facility) return;
  const { data: beds } = await supabase
    .from("bed_management")
    .select("id, current_patient_mrn, status")
    .eq("facility_name", facility);
  if (!beds || beds.length === 0) return;
  const occupied = beds.filter(
    (b) => b.current_patient_mrn && (b.status ?? "").toLowerCase().startsWith("occupied"),
  );
  if (occupied.length === 0) return;
  const mrns = Array.from(new Set(occupied.map((b) => b.current_patient_mrn as string)));
  const { data: active } = await supabase.from("patients").select("mrn, status").in("mrn", mrns);
  const activeSet = new Set(
    (active ?? []).filter((p) => (p.status ?? "").toLowerCase() === "admitted").map((p) => p.mrn),
  );
  const orphanIds = occupied
    .filter((b) => !activeSet.has(b.current_patient_mrn ?? ""))
    .map((b) => b.id);
  if (orphanIds.length === 0) return;
  await supabase
    .from("bed_management")
    .update({
      status: "Available",
      current_patient_mrn: null,
      status_updated_at: new Date().toISOString(),
    })
    .in("id", orphanIds);
}
