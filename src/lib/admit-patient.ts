import { supabase } from "@/integrations/supabase/client";
import {
  seedAdmission,
  claimBedForAdmission,
  releaseBedForAdmission,
} from "@/hooks/useAIAutomation";
import { saveAudit, type NlpResult } from "@/lib/nlp-engine";
import { intakeToSoap, saveIntake, type IntakeRecord } from "@/lib/intake-record";
import type { CodeStatus } from "@/lib/patients";
import { runSixStreamPipeline, upsertCondition } from "@/lib/coding-pipeline";
import { crosswalkSnomedToIcd10 } from "@/lib/umls-client";
import { lookupAllergenSnomed } from "@/lib/allergen-map";
import { recommendDefinitionType, suggestedRootConceptForStorage } from "@/lib/value-set-registry";
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

  // Write real codes the user already confirmed in the admission form
  // (chronic illnesses / drug allergies / medications picked via the
  // UMLS-backed TerminologyCombobox, plus env/food allergies matched
  // against the static allergen map) DIRECTLY into the coded tables, here,
  // synchronously. This must not depend on the fire-and-forget six-stream
  // pipeline below ever running successfully — the whole point is that the
  // concept the user explicitly picked is the one that lands, not whatever
  // the pipeline might independently re-derive from the plain-text name.
  const it2 = input.intake;
  if (it2) {
    try {
      await writeConfirmedAdmissionCodes({
        mrn,
        patientName: data.name ?? null,
        facilityName: data.facility_name ?? null,
        intake: it2,
      });
    } catch (e) {
      console.warn("[admit] writing confirmed codes failed", e);
    }
  }

  // Fire-and-forget six-stream coding pipeline. Never blocks admission.
  // Pass form-time snapshot so Streams C/D/E/F don't depend on empty tables.
  // Pre-coded entries above are echoed back in here (rxnorm_code /
  // substance_rxcui / substance_snomed) so the pipeline trusts them as-is
  // (see Streams B/C/D in coding-pipeline.ts) instead of re-resolving.
  const tempC =
    typeof payload.temp === "number"
      ? +(((payload.temp as number) - 32) * (5 / 9)).toFixed(1)
      : null;
  const codedChronicDisplays = new Set((it2?.chronicIllnessCodes ?? []).map((c) => c.display));
  const admissionData = {
    medications: (it2?.currentMeds ?? [])
      .map((m) => ({
        name: (m.name ?? "").trim(),
        dose: (m.dose ?? "").trim() || undefined,
        frequency: (m.freq ?? "").trim() || undefined,
        rxnorm_code: m.code?.code,
        rxnorm_display: m.code?.display,
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
        .map((a) => {
          const substance = (a.code?.display || a.name || "").trim();
          return {
            substance,
            reaction: (a.reaction ?? "").trim() || null,
            type: "drug",
            substance_rxcui: a.code?.code ?? null,
            substance_snomed: a.code ? (lookupAllergenSnomed(substance)?.snomed ?? null) : null,
          };
        })
        .filter((a) => a.substance),
      ...(it2?.envAllergies ?? [])
        .map((s) => {
          const substance = String(s ?? "").trim();
          return {
            substance,
            reaction: null,
            type: "environmental",
            substance_rxcui: null as string | null,
            substance_snomed: substance ? (lookupAllergenSnomed(substance)?.snomed ?? null) : null,
          };
        })
        .filter((a) => a.substance),
    ],
    // Only the chronic illnesses that did NOT get a confirmed code above —
    // Stream B's own PMH_MAP matching must stick to those (see doc on
    // `pmhUncodedText` in coding-pipeline.ts).
    pmhUncodedText: (it2?.chronicIllnesses ?? [])
      .filter((name) => !codedChronicDisplays.has(name))
      .join(", "),
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

/**
 * Write every code the clinician/intake staff already confirmed in the
 * admission form directly into the coded tables, before the six-stream
 * pipeline ever runs. See the module comment above `admitPatient()` for why:
 * the picker already resolved a real UMLS concept, so this must land that
 * exact code rather than leave it to be re-derived from plain text later.
 *
 * Environmental/Food Allergies judgement call (documented here + in the PR
 * description): that field stays a quick-pick chip list, not a live
 * TerminologyCombobox — it's a small, closed, fixed vocabulary (10 options:
 * latex, iodine, peanuts, …), unlike the open-ended conditions/drug fields,
 * so a live UMLS search would be overkill. But every one of those 10
 * options already has an exact static SNOMED mapping in `allergen-map.ts`
 * (used by the pipeline's own Stream D), so we use that same static map to
 * attach a real code here at write time too, rather than leaving env
 * allergies as the one field with literally no coding path.
 */
async function writeConfirmedAdmissionCodes(args: {
  mrn: string;
  patientName: string | null;
  facilityName: string | null;
  intake: IntakeRecord;
}): Promise<void> {
  const { mrn, patientName, facilityName, intake } = args;

  // Chronic illnesses picked via TerminologyCombobox (SNOMED CT).
  const codedIllnesses = intake.chronicIllnessCodes ?? [];
  await Promise.all(
    codedIllnesses.map(async (hit) => {
      let icd10Code: string | null = null;
      let icd10Display: string | null = null;
      try {
        const cw = await crosswalkSnomedToIcd10(hit.code);
        icd10Code = cw?.code ?? null;
        icd10Display = cw?.display ?? null;
      } catch (e) {
        console.warn("[admit] ICD-10 crosswalk failed for", hit.code, e);
      }
      try {
        await upsertCondition({
          mrn,
          patient_name: patientName,
          display_text: hit.display,
          snomed_code: hit.code,
          snomed_display: hit.display,
          icd10_code: icd10Code,
          icd10_display: icd10Display,
          category: "medical-history",
          source_section: "pmh",
          coding_source: "admission-intake-picker",
          created_by_type: "human",
        });
      } catch (e) {
        console.warn("[admit] condition write failed for", hit.code, e);
      }
    }),
  );

  // Drug allergies picked via TerminologyCombobox (RxNorm).
  for (const a of intake.drugAllergies ?? []) {
    const name = (a.name ?? "").trim();
    if (!name || !a.code) continue;
    const substance = a.code.display || name;
    // Also attach the drug-CLASS SNOMED code (e.g. "Penicillin" for a
    // picked RxNorm concept like amoxicillin) when the static allergen map
    // recognizes it — same cross-reactivity-family mapping the six-stream
    // pipeline already attaches to every drug allergy, and the only field
    // Stream D's own $validate-code gate checks for allergies. The real
    // RxNorm code the user picked still lands in substance_rxcui either way.
    const classHit = lookupAllergenSnomed(substance);
    await upsertAllergyCode({
      mrn,
      substance,
      reaction: (a.reaction ?? "").trim() || null,
      substanceRxcui: a.code.code,
      substanceSnomed: classHit?.snomed ?? null,
    });
  }

  // Environmental/food allergies — closed vocabulary, static SNOMED map
  // (see function doc above).
  for (const s of intake.envAllergies ?? []) {
    const substance = String(s ?? "").trim();
    if (!substance) continue;
    const hit = lookupAllergenSnomed(substance);
    if (!hit) continue;
    await upsertAllergyCode({
      mrn,
      substance,
      reaction: null,
      substanceRxcui: null,
      substanceSnomed: hit.snomed,
    });
  }

  // Current medications picked via TerminologyCombobox (RxNorm).
  for (const m of intake.currentMeds ?? []) {
    const name = (m.name ?? "").trim();
    if (!name || !m.code) continue;
    await upsertMedicationOrderCode({
      mrn,
      patientName,
      facilityName,
      drugName: m.code.display || name,
      dose: (m.dose ?? "").trim() || null,
      frequency: (m.freq ?? "").trim() || null,
      rxnormCode: m.code.code,
      rxnormDisplay: m.code.display,
    });
  }
}

/** Idempotent (mrn + substance) upsert for a pre-confirmed allergy code. */
async function upsertAllergyCode(args: {
  mrn: string;
  substance: string;
  reaction: string | null;
  substanceRxcui: string | null;
  substanceSnomed: string | null;
}): Promise<void> {
  try {
    const { data: existing } = await supabase
      .from("allergies")
      .select("id")
      .eq("mrn", args.mrn)
      .eq("substance", args.substance)
      .maybeSingle();
    const patch: Database["public"]["Tables"]["allergies"]["Insert"] = {
      mrn: args.mrn,
      substance: args.substance,
      reaction: args.reaction,
      substance_rxcui: args.substanceRxcui,
      substance_snomed: args.substanceSnomed,
      status: "active",
      coding_source: "admission-intake-picker",
      coded_at: new Date().toISOString(),
      created_by_type: "human",
    };
    if (existing?.id) {
      await supabase.from("allergies").update(patch).eq("id", existing.id);
    } else {
      await supabase.from("allergies").insert(patch);
    }
  } catch (e) {
    console.warn("[admit] allergy code write failed for", args.substance, e);
  }
}

/** Idempotent (patient_mrn + medication_name) upsert for a pre-confirmed drug code. */
async function upsertMedicationOrderCode(args: {
  mrn: string;
  patientName: string | null;
  facilityName: string | null;
  drugName: string;
  dose: string | null;
  frequency: string | null;
  rxnormCode: string;
  rxnormDisplay: string;
}): Promise<void> {
  try {
    const { data: existing } = await supabase
      .from("medication_orders")
      .select("id")
      .eq("patient_mrn", args.mrn)
      .eq("medication_name", args.drugName)
      .maybeSingle();
    const row: Database["public"]["Tables"]["medication_orders"]["Insert"] = {
      mrn: args.mrn,
      patient_mrn: args.mrn,
      patient_name: args.patientName,
      facility_name: args.facilityName,
      ordering_physician: "Admission Intake",
      drug_name: args.drugName,
      medication_name: args.drugName,
      dose: args.dose,
      route: "PO",
      frequency: args.frequency,
      rxnorm_code: args.rxnormCode,
      rxnorm_display: args.rxnormDisplay,
      coding_source: "admission-intake-picker",
      coded_at: new Date().toISOString(),
      term_status: "pending",
      status: "PENDING_PHARMACY",
      created_by_type: "human",
    };
    if (existing?.id) {
      await supabase.from("medication_orders").update(row).eq("id", existing.id);
    } else {
      await supabase.from("medication_orders").insert(row);
    }
  } catch (e) {
    console.warn("[admit] medication code write failed for", args.drugName, e);
  }
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
  const justification =
    "Need a governed value set of HRRP-tracked diagnoses to flag admissions for enhanced discharge planning";
  const recommendation = await recommendDefinitionType({
    vocabulary: "ICD-10",
    candidates: seedCodes,
    requestedName: HRRP_REQUEST_NAME,
    justification,
    context: { clinicalApplication: "Billing", requestingConsumer: "Auto Admin" },
  });
  await supabase.from("terminology_requests").insert({
    requesting_consumer: "Auto Admin",
    requested_name: HRRP_REQUEST_NAME,
    justification,
    vocabulary: "ICD-10",
    clinical_application: "Billing",
    priority: "high",
    request_type: "create",
    requested_at: new Date().toISOString(),
    status: "pending",
    seed_codes: seedCodes,
    recommended_type: recommendation.recommendedType,
    reasoning: recommendation.reasoning,
    suggested_root_concept: suggestedRootConceptForStorage(recommendation),
    recommended_binding_strength: recommendation.recommendedBindingStrength,
    possible_existing_match: recommendation.possibleExistingMatch,
    clinical_focus: recommendation.clinicalFocus,
    data_element_scope: recommendation.dataElementScope,
    inclusion_criteria: recommendation.inclusionCriteria,
    exclusion_criteria: recommendation.exclusionCriteria,
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
