import { supabase } from "@/integrations/supabase/client";
import { seedAdmission } from "@/hooks/useAIAutomation";
import { saveAudit, type NlpResult } from "@/lib/nlp-engine";
import { intakeToSoap, saveIntake, type IntakeRecord } from "@/lib/intake-record";
import { assignStaffToPatient } from "@/lib/staff-assignment";
import type { CodeStatus } from "@/lib/patients";

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
  patient?: any;
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
  const drugAllergiesText = it?.drugAllergies
    ?.map((a) => [a.name?.trim(), a.reaction?.trim() ? `(${a.reaction.trim()})` : ""].filter(Boolean).join(" "))
    .filter(Boolean)
    .join("; ") || null;
  const currentMedicationsText = it?.currentMeds
    ?.map((m) => [m.name?.trim(), m.dose?.trim(), m.freq?.trim()].filter(Boolean).join(" "))
    .filter(Boolean)
    .join("; ") || null;
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
    room: input.room.trim() || null,
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
  if (error) return { ok: false, error: error.message };

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
        name: (data as any).name ?? null,
        facility_name: data.facility_name,
        chief_complaint: (data as any).chief_complaint ?? null,
      },
      { manual: true },
    );
  } catch (e: any) {
    console.warn("[admit] seedAdmission failed", e);
  }

  // Assign nurse + physician synchronously at admission so the chart and
  // FHIR Encounter/CareTeam resources have the care-team on day one.
  try {
    await assignStaffToPatient(data.mrn ?? mrn, data.facility_name ?? facility);
  } catch (e) {
    console.warn("[admit] assignStaffToPatient failed", e);
  }

  const { data: bedCheck } = await supabase
    .from("bed_management")
    .select("id")
    .eq("current_patient_mrn", mrn)
    .maybeSingle();
  if (!bedCheck) {
    return { ok: false, error: "No empty beds — admission was rolled back." };
  }

  return { ok: true, patient: data };
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
    (b: any) => b.current_patient_mrn && (b.status ?? "").toLowerCase().startsWith("occupied"),
  );
  if (occupied.length === 0) return;
  const mrns = Array.from(new Set(occupied.map((b: any) => b.current_patient_mrn as string)));
  const { data: active } = await supabase.from("patients").select("mrn, status").in("mrn", mrns);
  const activeSet = new Set(
    (active ?? [])
      .filter((p: any) => (p.status ?? "").toLowerCase() === "admitted")
      .map((p: any) => p.mrn),
  );
  const orphanIds = occupied
    .filter((b: any) => !activeSet.has(b.current_patient_mrn))
    .map((b: any) => b.id);
  if (orphanIds.length === 0) return;
  await supabase
    .from("bed_management")
    .update({
      status: "Available",
      current_patient_mrn: null,
      status_updated_at: new Date().toISOString(),
    } as any)
    .in("id", orphanIds);
}