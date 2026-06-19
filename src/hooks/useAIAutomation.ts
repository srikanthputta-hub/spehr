import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { getAutomationEnabled, useAutomationEnabled } from "@/hooks/useAutomationEnabled";
import { ensureNlpRulesHydrated } from "@/lib/safety-conflicts";
import {
  autoFillIntake,
  intakeToSoap,
  loadIntake,
  saveIntake,
} from "@/lib/intake-record";
import { routeDepartment } from "@/lib/chief-complaints";
import { templateForDepartment } from "@/lib/auto-doc-catalog";
import { runAutoDoc } from "@/lib/auto-doc.functions";

/* ------------------------------------------------------------------ */
/* Admission Randomizer — Staged Cascade                              */
/* ------------------------------------------------------------------ */
/* Whenever a patient is admitted (auto OR manual), schedule:         */
/*   • 3 medications — first inserted at T+20s, then 15s gap each.    */
/*     Each med cycles: ORDERED → PENDING_VERIFICATION → DISPENSED    */
/*     → ADMINISTERED with 3s between each transition.                */
/*   • 2 lab tests — first at T+20s, then 15s gap. Each cycles:       */
/*     ORDERED → PROCESSING → RESULTED (3s between transitions).      */
/* The Pharmacy and Lab boards show the live transitions in their    */
/* pending queues; everything is keyed off the patient's MRN.         */
/* ------------------------------------------------------------------ */

interface NewPatient {
  id: string;
  mrn: string | null;
  first_name: string | null;
  last_name: string | null;
  name: string | null;
  facility_name: string | null;
  chief_complaint: string | null;
  age?: number | null;
  gender?: string | null;
  dob?: string | null;
}

interface InsertedOrder {
  id: string;
  status: string | null;
  ordered_by?: string | null;
  patient_mrn?: string | null;
  mrn?: string | null;
  test_type?: string | null;
}

// Auto Doc staged admission cascade — matches the legacy timeline:
//   • meds inserted at T+20s, T+35s, T+50s
//   • labs inserted at T+20s, T+35s
//   • each row transitions through its statuses with a 3s gap.
const MED_FIRST_ORDER_DELAY_MS = 20_000;
const MED_ORDER_GAP_MS = 15_000;
const LAB_FIRST_ORDER_DELAY_MS = 20_000;
const LAB_ORDER_GAP_MS = 15_000;
const TRANSITION_GAP_MS = 3_000;

/* ------------------------------------------------------------------ */
/* Lab specimen / methodology / interpretation reference data.        */
/* Used to render an elaborative, hospital-grade report narrative     */
/* on every cascade-released lab result so the chart, lab board and   */
/* FHIR Observation exports all show the same rich clinical context.  */
/* ------------------------------------------------------------------ */
const LAB_PROFILE: Record<string, { specimen: string; method: string; tat: string; loinc?: string }> = {
  WBC: { specimen: "Whole Blood, EDTA (lavender top)", method: "Automated impedance / flow cytometry (CBC analyzer)", tat: "≤ 45 min", loinc: "6690-2" },
  Hemoglobin: { specimen: "Whole Blood, EDTA", method: "Spectrophotometry (cyanmethemoglobin)", tat: "≤ 45 min", loinc: "718-7" },
  Platelets: { specimen: "Whole Blood, EDTA", method: "Impedance count, smear confirmation if flagged", tat: "≤ 45 min", loinc: "777-3" },
  Glucose: { specimen: "Serum / Plasma (gold top SST)", method: "Hexokinase enzymatic assay", tat: "≤ 30 min", loinc: "2345-7" },
  Creatinine: { specimen: "Serum (gold top SST)", method: "Jaffe kinetic / enzymatic IDMS-traceable", tat: "≤ 60 min", loinc: "2160-0" },
  Sodium: { specimen: "Serum / Plasma", method: "Indirect ion-selective electrode (ISE)", tat: "≤ 30 min", loinc: "2951-2" },
  Potassium: { specimen: "Serum / Plasma", method: "Indirect ion-selective electrode (ISE)", tat: "≤ 30 min", loinc: "2823-3" },
  "Troponin I": { specimen: "Serum / Plasma (lithium heparin)", method: "High-sensitivity chemiluminescent immunoassay", tat: "≤ 60 min", loinc: "10839-9" },
  "Creatine Kinase": { specimen: "Serum", method: "NAC-activated enzymatic UV", tat: "≤ 60 min", loinc: "2157-6" },
  "PT/INR": { specimen: "Citrated Plasma (blue top, 3.2%)", method: "Optical clot detection, ISI-corrected", tat: "≤ 60 min", loinc: "5902-2" },
  Lactate: { specimen: "Arterial / Venous whole blood, fluoride", method: "Enzymatic amperometric (lactate oxidase)", tat: "≤ 20 min STAT", loinc: "2532-0" },
  Fibrinogen: { specimen: "Citrated Plasma (blue top)", method: "Clauss clotting method", tat: "≤ 90 min", loinc: "3255-7" },
  "Lactate Dehydrogenase": { specimen: "Serum (avoid hemolysis)", method: "Lactate-to-pyruvate UV kinetic", tat: "≤ 90 min", loinc: "14804-9" },
};

const DEFAULT_LAB_PROFILE = {
  specimen: "Per laboratory collection protocol",
  method: "Standard reference laboratory methodology",
  tat: "Per facility TAT",
};

function interpretLab(name: string, value: number, ref: string, flag: "L" | "H" | "N" | "C"): string {
  const trend =
    flag === "C"
      ? "Critical value — provider notified per facility critical-value policy. Immediate clinical correlation required."
      : flag === "H"
        ? `Result is ABOVE the reference interval (${ref}); clinical correlation recommended.`
        : flag === "L"
          ? `Result is BELOW the reference interval (${ref}); clinical correlation recommended.`
          : `Result is within the reference interval (${ref}); no acute action indicated by this analyte alone.`;
  // Light-weight, lab-specific commentary so the narrative reads like a
  // real hospital report instead of a single numeric line.
  const commentary: Record<string, string> = {
    WBC: flag === "H" ? "Leukocytosis — consider infectious / inflammatory / stress response." : flag === "L" ? "Leukopenia — consider marrow suppression, viral process, sepsis." : "",
    Hemoglobin: flag === "L" ? "Anemia — evaluate iron studies, reticulocyte count and occult blood loss." : flag === "H" ? "Polycythemia — consider dehydration vs primary erythrocytosis." : "",
    Platelets: flag === "L" ? "Thrombocytopenia — review medication list and consider peripheral smear." : flag === "H" ? "Thrombocytosis — reactive vs essential thrombocythemia." : "",
    Glucose: flag === "H" ? "Hyperglycemia — correlate with A1c and clinical hydration status." : flag === "L" ? "Hypoglycemia — repeat fingerstick and treat per hypoglycemia protocol." : "",
    Creatinine: flag === "H" ? "Reduced glomerular filtration — calculate eGFR and review nephrotoxic agents." : "",
    "Troponin I": flag === "H" || flag === "C" ? "Elevated cardiac troponin — repeat in 3 hours, obtain ECG and cardiology consult." : "",
    Lactate: flag === "H" || flag === "C" ? "Elevated lactate — assess tissue perfusion and initiate sepsis bundle if clinically indicated." : "",
    Potassium: flag === "H" ? "Hyperkalemia — obtain ECG, recheck specimen for hemolysis." : flag === "L" ? "Hypokalemia — replete IV/PO per protocol, monitor cardiac rhythm." : "",
    Sodium: flag === "H" ? "Hypernatremia — assess free water deficit." : flag === "L" ? "Hyponatremia — assess volume status and serum osmolality." : "",
    "PT/INR": flag === "H" ? "Prolonged INR — review anticoagulation, hepatic function and vitamin K status." : "",
  };
  const note = commentary[name] ?? "";
  return note ? `${trend} ${note}` : trend;
}

function buildLabReport(
  name: string,
  value: number,
  unit: string,
  ref: string,
  flag: "L" | "H" | "N" | "C",
  collectedIso: string,
  reportedIso: string,
): string {
  const profile = LAB_PROFILE[name] ?? DEFAULT_LAB_PROFILE;
  const flagWord = flag === "C" ? "CRITICAL" : flag === "H" ? "HIGH" : flag === "L" ? "LOW" : "NORMAL";
  const interp = interpretLab(name, value, ref, flag);
  const tFmt = (iso: string) => {
    try { return new Date(iso).toLocaleString(undefined, { hour12: false }); } catch { return iso; }
  };
  return [
    `${name}: ${value} ${unit} [${flagWord}]  (Reference ${ref} ${unit})`,
    `Specimen: ${profile.specimen}`,
    `Method: ${profile.method}`,
    `LOINC: ${profile.loinc ?? "—"}  •  TAT: ${profile.tat}`,
    `Collected: ${tFmt(collectedIso)}  •  Reported: ${tFmt(reportedIso)}`,
    `Interpretation: ${interp}`,
    `Performing lab: SPEHR Central Laboratory  •  Verified by: Auto Doc Pipeline`,
  ].join("\n");
}

/* ------------------------------------------------------------------ */
/* MRN-keyed timer registry — every setTimeout scheduled by the       */
/* cascade is tracked here so the hook's effect cleanup (and per-MRN  */
/* re-seed checks) can cancel anything still pending. Prevents leaks  */
/* and overlapping cascades across tab focus changes.                 */
/* ------------------------------------------------------------------ */
const mrnTimers = new Map<string, Set<ReturnType<typeof setTimeout>>>();

function trackTimer(mrn: string, t: ReturnType<typeof setTimeout>) {
  let set = mrnTimers.get(mrn);
  if (!set) {
    set = new Set();
    mrnTimers.set(mrn, set);
  }
  set.add(t);
}

function untrackTimer(mrn: string, t: ReturnType<typeof setTimeout>) {
  const set = mrnTimers.get(mrn);
  if (!set) return;
  set.delete(t);
  if (set.size === 0) mrnTimers.delete(mrn);
}

function clearAllTimers() {
  for (const set of mrnTimers.values()) {
    for (const t of set) clearTimeout(t);
  }
  mrnTimers.clear();
}

function trackedDelay(mrn: string, ms: number) {
  return new Promise<void>((res) => {
    const t = setTimeout(() => {
      untrackTimer(mrn, t);
      res();
    }, ms);
    trackTimer(mrn, t);
  });
}

/* ------------------------------------------------------------------ */
/* Bed allocation + 1-minute cleaning state machine                    */
/* ------------------------------------------------------------------ */

async function assignBedForPatient(p: NewPatient): Promise<string | null> {
  if (!p.mrn || !p.facility_name) return null;
  // Skip if this patient already has a bed.
  const { data: existing } = await supabase
    .from("bed_management")
    .select("id, room_number, bed_letter")
    .eq("current_patient_mrn", p.mrn)
    .maybeSingle();
  if (existing) {
    const room = `${existing.room_number}-${existing.bed_letter}`;
    await supabase.from("patients").update({ room } as any).eq("mrn", p.mrn);
    return room;
  }
  // Try up to 5 Available beds in order; the optimistic guard
  // (.eq("status","Available") + .is("current_patient_mrn", null))
  // ensures only one concurrent admission wins each row. If we lose
  // the race we move on to the next open bed instead of silently
  // double-booking.
  const { data: candidates } = await supabase
    .from("bed_management")
    .select("id, room_number, bed_letter")
    .eq("facility_name", p.facility_name)
    .eq("status", "Available")
    .is("current_patient_mrn", null)
    .order("room_number", { ascending: true })
    .order("bed_letter", { ascending: true })
    .limit(5);
  for (const open of candidates ?? []) {
    const { data: claimed, error } = await supabase
      .from("bed_management")
      .update({
        status: "Occupied",
        current_patient_mrn: p.mrn,
        status_updated_at: new Date().toISOString(),
      } as any)
      .eq("id", open.id)
      .eq("status", "Available")
      .is("current_patient_mrn", null) // hard guard against double-booking
      .select("id");
    if (error || !claimed || claimed.length === 0) continue; // lost race, try next
    const room = `${open.room_number}-${open.bed_letter}`;
    await supabase.from("patients").update({ room } as any).eq("mrn", p.mrn);
    return room;
  }
  // No bed available — DO NOT fabricate an ED/Triage placeholder. Caller
  // is responsible for rejecting the admission and surfacing the
  // "No empty beds available" disclaimer.
  return null;
}

async function startBedCleaningCycle(mrn: string) {
  // Find the bed currently holding this MRN and kick off the cleaning cycle.
  const { data: bed } = await supabase
    .from("bed_management")
    .select("id")
    .eq("current_patient_mrn", mrn)
    .maybeSingle();
  if (!bed) return;
  await supabase
    .from("bed_management")
    .update({
      status: "Cleaning",
      current_patient_mrn: null,
      status_updated_at: new Date().toISOString(),
    } as any)
    .eq("id", bed.id);
}

async function sweepBedCleaningCycles() {
  const now = Date.now();
  const cutoff60 = new Date(now - 60_000).toISOString();
  const cutoff120 = new Date(now - 120_000).toISOString();
  // Cleaning → Disinfecting (60s elapsed)
  await supabase
    .from("bed_management")
    .update({
      status: "Disinfecting",
      status_updated_at: new Date().toISOString(),
    } as any)
    .in("status", ["Cleaning", "Discharged - Deep Cleaning In Progress", "Discharged"])
    .lt("status_updated_at", cutoff60);
  // Disinfecting → Available (another 60s elapsed = 120s total since discharge)
  await supabase
    .from("bed_management")
    .update({
      status: "Available",
      current_patient_mrn: null,
      status_updated_at: new Date().toISOString(),
    } as any)
    .eq("status", "Disinfecting")
    .lt("status_updated_at", cutoff120);
}


async function cascadeMed(mrn: string, orderId: string) {
  // Ordered → Pending Verification → Dispensed → Administered (final).
  // The chart only surfaces the order once status === "Administered".
  await trackedDelay(mrn, TRANSITION_GAP_MS);
  const approvedAt = new Date().toISOString();
  await supabase
    .from("medication_orders")
    .update({ status: "Pending Verification", approved_at: approvedAt })
    .eq("id", orderId);
  await trackedDelay(mrn, TRANSITION_GAP_MS);
  const dispensedAt = new Date().toISOString();
  await supabase
    .from("medication_orders")
    .update({
      status: "Dispensed",
      dispensed_at: dispensedAt,
    } as any)
    .eq("id", orderId);
  await trackedDelay(mrn, TRANSITION_GAP_MS);
  const administeredAt = new Date().toISOString();
  await supabase
    .from("medication_orders")
    .update({
      status: "Administered",
      administered_at: administeredAt,
    } as any)
    .eq("id", orderId);
}

async function cascadeLab(
  mrn: string,
  orderId: string,
  resultSummary: string,
  labMeta?: {
    name: string;
    unit: string;
    referenceRange: string;
    resultExample: string;
    numericValue?: number;
    flagCode?: "L" | "H" | "N" | "C";
  },
) {
  // Ordered → Processing → Reported (final).
  const collectedAt = new Date().toISOString();
  await supabase
    .from("lab_orders")
    .update({ collected_at: collectedAt } as any)
    .eq("id", orderId);
  await trackedDelay(mrn, TRANSITION_GAP_MS);
  await supabase
    .from("lab_orders")
    .update({ status: "Processing" })
    .eq("id", orderId);
  await trackedDelay(mrn, TRANSITION_GAP_MS);
  const resultedAt = new Date().toISOString();
  // Build the elaborative narrative AT report time so timestamps in the
  // body match the actual collected/reported events on the order.
  let elaborate = resultSummary;
  if (labMeta && typeof labMeta.numericValue === "number" && labMeta.flagCode) {
    elaborate = buildLabReport(
      labMeta.name,
      labMeta.numericValue,
      labMeta.unit,
      labMeta.referenceRange,
      labMeta.flagCode,
      collectedAt,
      resultedAt,
    );
  }
  await supabase
    .from("lab_orders")
    .update({
      status: "Reported",
      result_value: elaborate,
      collected_at: collectedAt,
      resulted_at: resultedAt,
    } as any)
    .eq("id", orderId);

  // Persist the simulated result into the canonical lab_results table so it
  // survives a refresh and shows up in downstream reports/exports — not just
  // the in-memory lab_orders queue.
  if (labMeta) {
    // The result_value column in lab_results is numeric, so we MUST extract
    // only the raw number from strings like "WBC: 12.8 k/uL [HIGH]". Purely
    // textual results (e.g. "Blood Culture: No growth") have no number and
    // must be persisted as null instead of the formatted string — otherwise
    // PostgREST rejects the insert with an invalid_text_representation error.
    const sample = labMeta.resultExample ?? "";
    const numericMatch = sample.match(/-?\d+(?:\.\d+)?/);
    const result_value = numericMatch ? Number(numericMatch[0]) : null;

    const flagMatch = sample.match(/\[([^\]]+)\]/);
    const flagUpper = flagMatch ? flagMatch[1].toUpperCase() : "";
    const flag = flagUpper.includes("CRITICAL")
      ? "CRITICAL"
      : flagUpper.includes("HIGH")
        ? "HIGH"
        : flagUpper.includes("LOW")
          ? "LOW"
          : flagUpper.includes("ABNORMAL")
            ? "ABNORMAL"
            : result_value === null
              ? null
              : "NORMAL";

    // Unit: prefer the catalog unit, fall back to parsing it out of the
    // sample (e.g. "12.8 k/uL" -> "k/uL").
    let unit: string | null = labMeta.unit?.trim() || null;
    if (!unit && numericMatch) {
      const afterNumber = sample.slice(
        (numericMatch.index ?? 0) + numericMatch[0].length,
      );
      const unitMatch = afterNumber.match(/^\s*([A-Za-z%/µμ°][A-Za-z0-9%/.^*·µμ°-]*)/);
      unit = unitMatch ? unitMatch[1] : null;
    }

    const { error: labInsertError } = await supabase
      .from("lab_results")
      .insert({
        mrn,
        test_name: labMeta.name,
        panel_name: labMeta.name,
        result_value,
        unit,
        reference_range: labMeta.referenceRange || null,
        flag,
        time_drawn: resultedAt,
      } as any);
    if (labInsertError) {
      console.error("[cascadeLab] lab_results insert failed", {
        mrn,
        test_name: labMeta.name,
        result_value,
        unit,
        flag,
        sample,
        error: labInsertError,
      });
    }
  }
}

/**
 * Seed an admission with the protocol meds + labs.
 *
 * Both auto and manual admissions follow the same staged cascade:
 * first order at T+20s, 15s between subsequent orders, and each
 * order transitions through its statuses with a 3s gap. Auto
 * admissions respect the global automation switch; manual
 * admissions always seed so the queues pick the patient up.
 */
export async function seedAdmission(
  p: NewPatient,
  opts: { manual?: boolean; immediate?: boolean } = {},
) {
  if (!p.mrn) return;
  const manual = !!opts.manual;
  const immediate = !!opts.immediate;

  if (!manual && !(await getAutomationEnabled())) return;

  // Allocate a physical bed from the facility's bed_management pool.
  // Manual or auto admissions both go through here so the floor grid
  // always reflects the real bed assignment.
  let assignedRoom: string | null = null;
  try {
    assignedRoom = await assignBedForPatient(p);
  } catch (e) {
    console.warn("[seedAdmission] bed assignment failed", e);
  }
  // Hard guarantee: if no bed could be claimed for this admission, undo
  // the patient row so the network never holds a roomless ghost. The
  // floor census, bed board and "No empty beds available" disclaimer
  // stay perfectly in sync this way.
  if (!assignedRoom) {
    await supabase.from("patients").delete().eq("mrn", p.mrn);
    // Surface the same "No empty beds available" disclaimer used by the
    // manual Admit flow so the on-screen viewer sees automation rejections
    // too — but only when the failed admission is at the facility they
    // are currently viewing, to avoid cross-facility toast noise.
    try {
      const activeFacility =
        typeof window !== "undefined"
          ? localStorage.getItem("spehr.activeFacility")
          : null;
      if (
        p.facility_name &&
        (!activeFacility || activeFacility === p.facility_name)
      ) {
        toast.error("No empty beds available", {
          description: `${p.facility_name} is at full capacity. Please direct the patient to the Patient Lounge until a bed is released.`,
        });
      }
    } catch {}
    return;
  }

  const fallbackName = [p.first_name, p.last_name].filter(Boolean).join(" ");
  const patientName = p.name ?? (fallbackName || "Unknown");
  const mrn: string = p.mrn;

  // ------------------------------------------------------------------
  // Intake auto-fill — every admission (manual OR ghost) gets a full
  // structured case-history record. Manual admits from the Admit
  // modal already persist their own intake before calling
  // seedAdmission, so loadIntake() short-circuits and we skip.
  // ------------------------------------------------------------------
  try {
    if (!loadIntake(mrn)) {
      const intake = autoFillIntake({
        firstName: p.first_name ?? undefined,
        lastName: p.last_name ?? undefined,
        age: typeof p.age === "number" ? p.age : undefined,
        chiefComplaint: p.chief_complaint ?? undefined,
      });
      saveIntake(mrn, intake);
      const { data: existingNotes } = await supabase
        .from("clinical_notes")
        .select("id")
        .eq("mrn", mrn)
        .eq("note_type", "Admission Intake (SOAP)")
        .limit(1);
      if (!existingNotes || existingNotes.length === 0) {
        await supabase.from("clinical_notes").insert({
          mrn,
          note_type: "Admission Intake (SOAP)",
          content: intakeToSoap({ ...intake, mrn }),
          author: manual ? "Admitting Provider" : "Ghost AI - Admission Randomizer",
        });
      }
    }
  } catch (e) {
    console.warn("[seedAdmission] intake autofill failed", e);
  }

  // ------------------------------------------------------------------
  // Diagnostics & Medications — owned exclusively by Auto Doc, but
  // inserted through the SAME staged admission cascade timeline as the
  // legacy ghost admission flow. The headless Auto Doc pipeline (DB
  // trigger) handles notes / UMLS / FHIR / discharge; the client below
  // stages the condition-specific orders so the Pharmacy & Lab queues
  // see the live ORDERED → … → ADMINISTERED / REPORTED transitions.
  // ------------------------------------------------------------------
  const department = routeDepartment(p.chief_complaint ?? "");
  const tpl = templateForDepartment(department);

  const norm = (v: string | null | undefined) => (v ?? "").trim().toLowerCase();
  const [{ data: existingMeds }, { data: existingLabs }] = await Promise.all([
    supabase
      .from("medication_orders")
      .select("medication_name, drug_name")
      .eq("patient_mrn", mrn),
    supabase
      .from("lab_orders")
      .select("test_type")
      .eq("patient_mrn", mrn),
  ]);
  const existingMedNames = new Set(
    ((existingMeds as Array<{ medication_name?: string | null; drug_name?: string | null }> | null) ?? [])
      .map((m) => norm(m.medication_name ?? m.drug_name))
      .filter(Boolean),
  );
  const existingLabNames = new Set(
    ((existingLabs as Array<{ test_type?: string | null }> | null) ?? [])
      .map((l) => norm(l.test_type))
      .filter(Boolean),
  );

  // Persist the chosen department on the patient so Auto Doc's server-side
  // pipeline (notes / UMLS / FHIR) uses the same condition the client cascade
  // is staging — keeps the two sides perfectly in sync.
  await supabase
    .from("patients")
    .update({ assigned_department: department } as any)
    .eq("mrn", mrn);

  // Kick off the headless Auto Doc pipeline (notes + UMLS code mapping for
  // SNOMED-CT / ICD-10 / LOINC / RxNorm + FHIR + discharge). Idempotent —
  // server short-circuits if the run is already complete. Fire-and-forget
  // so it doesn't delay the staged orders cascade below.
  runAutoDoc({ data: { mrn } }).catch((e) =>
    console.warn("[seedAdmission] runAutoDoc failed", e),
  );

  // First 3 meds, first 2 labs — same shape as the legacy cascade.
  const finalMeds = tpl.meds.filter((m) => !existingMedNames.has(norm(m.name))).slice(0, 3);
  const finalLabs = tpl.labs.filter((l) => !existingLabNames.has(norm(l.name))).slice(0, 2);

  finalMeds.forEach((m, i) => {
    const t = MED_FIRST_ORDER_DELAY_MS + i * MED_ORDER_GAP_MS;
    const timer = setTimeout(async () => {
      untrackTimer(mrn, timer);
      const { data, error } = await supabase
        .from("medication_orders")
        .insert({
          patient_id: p.id,
          patient_mrn: mrn,
          mrn,
          patient_name: patientName,
          facility_name: p.facility_name,
          medication_name: m.name,
          drug_name: m.name,
          dose: m.dose,
          route: m.route,
          frequency: m.frequency,
          status: "Ordered",
          ordered_by: "Auto Doc",
        })
        .select("id")
        .single();
      if (error || !data) return; // unique-index collision → another client wins
      cascadeMed(mrn, data.id).catch((e) =>
        console.warn("[cascadeMed] failed", e),
      );
    }, t);
    trackTimer(mrn, timer);
  });

  finalLabs.forEach((l, i) => {
    const t = LAB_FIRST_ORDER_DELAY_MS + i * LAB_ORDER_GAP_MS;
    const sample = l.gen();
    const resultSummary = `${l.name}: ${sample.value} ${l.unit} [${sample.flag}] (ref ${l.ref} ${l.unit})`;
    const timer = setTimeout(async () => {
      untrackTimer(mrn, timer);
      const { data, error } = await supabase
        .from("lab_orders")
        .insert({
          patient_mrn: mrn,
          patient_name: patientName,
          facility_name: p.facility_name ?? "Memorial Hospital",
          requested_by: "Auto Doc",
          test_type: l.name,
          clinical_condition: tpl.condition,
          status: "Ordered",
          ordered_by: "Auto Doc",
        } as any)
        .select("id")
        .single();
      if (error || !data) return;
      cascadeLab(mrn, data.id, resultSummary, {
        name: l.name,
        unit: l.unit,
        referenceRange: l.ref,
        resultExample: `${sample.value} ${l.unit} [${sample.flag}]`,
        numericValue: sample.value,
        flagCode: sample.flag,
      }).catch((e) => console.warn("[cascadeLab] failed", e));
    }, t);
    trackTimer(mrn, timer);
  });
}

export function useAIAutomation() {
  const seeded = useRef<Set<string>>(new Set());
  const automationEnabled = useAutomationEnabled();

  useEffect(() => {
    if (!automationEnabled) return;
    // Hydrate NLP custom rules / banned tokens from Supabase on boot so the
    // synchronous detectBanned() cache reflects facility-specific overrides.
    ensureNlpRulesHydrated().catch(() => {});
    // Orphan sweeper — finalize only VERY stale rows (>30 min) so a
    // closed tab mid-cascade doesn't strand pending rows forever, but
    // active staged cascades (which finish in ~60s) are never touched.
    const sweepOrphans = async () => {
      const cutoff = new Date(Date.now() - 30 * 60_000).toISOString();
      const nowIso = new Date().toISOString();
      await supabase
        .from("medication_orders")
        .update({ status: "Administered", administered_at: nowIso } as any)
        .lt("created_at", cutoff)
        .in("status", [
          "Ordered", "Pending", "Pending Verification", "Dispensed",
          "ORDERED", "PENDING", "PENDING_VERIFICATION", "DISPENSED",
        ]);
      await supabase
        .from("lab_orders")
        .update({ status: "Reported", resulted_at: nowIso } as any)
        .lt("created_at", cutoff)
        .in("status", ["Ordered", "Processing", "ORDERED", "PROCESSING"]);
    };
    sweepOrphans().catch(() => {});
    const sweepInterval = setInterval(() => {
      sweepOrphans().catch(() => {});
    }, 5 * 60_000);

    // Backfill any admitted patient that has NO orders yet (e.g. admitted
    // while the tab was closed). Patients that already have orders are
    // skipped — the cascade for them is owned by whatever tab seeded them.
    const reconcileActiveAdmissions = async () => {
      const { data } = await supabase
        .from("patients")
        .select("id, mrn, first_name, last_name, name, facility_name, chief_complaint, age, gender, dob")
        .eq("status", "Admitted")
        .not("mrn", "is", null)
        .order("admission_time", { ascending: false })
        .limit(100);
      for (const p of ((data as NewPatient[] | null) ?? [])) {
        if (!p.mrn) continue;
        const [{ count: medCount }, { count: labCount }] = await Promise.all([
          supabase.from("medication_orders").select("id", { count: "exact", head: true }).eq("patient_mrn", p.mrn),
          supabase.from("lab_orders").select("id", { count: "exact", head: true }).eq("patient_mrn", p.mrn),
        ]);
        if ((medCount ?? 0) > 0 || (labCount ?? 0) > 0) continue;
        await seedAdmission(p).catch((e) =>
          console.warn("[admission-reconcile] seed failed", e),
        );
      }
    };
    reconcileActiveAdmissions().catch((e) =>
      console.warn("[admission-reconcile] failed", e),
    );

    const channel = supabase
      .channel("admission-randomizer")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "patients" },
        (payload) => {
          const p = payload.new as NewPatient;
          if (!p?.id || seeded.current.has(p.id)) return;
          seeded.current.add(p.id);
          seedAdmission(p).catch((e) =>
            console.warn("[admission-randomizer] seed failed", e),
          );
        },
      )
      .on(
        "postgres_changes",
        { event: "DELETE", schema: "public", table: "patients" },
        (payload) => {
          const mrn = (payload.old as any)?.mrn;
          if (!mrn) return;
          startBedCleaningCycle(mrn).catch((e) =>
            console.warn("[discharge] startBedCleaningCycle failed", e),
          );
        },
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "patients" },
        (payload) => {
          const newRow = payload.new as any;
          const oldRow = payload.old as any;
          if (
            (oldRow?.status ?? "").toLowerCase() === "admitted" &&
            (newRow?.status ?? "").toLowerCase() === "discharged" &&
            newRow?.mrn
          ) {
            startBedCleaningCycle(newRow.mrn).catch((e) =>
              console.warn("[discharge-update] startBedCleaningCycle failed", e),
            );
          }
        },
      )
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "medication_orders" },
        (payload) => {
          const o = payload.new as InsertedOrder;
          const mrn = o.patient_mrn ?? o.mrn;
          const source = (o.ordered_by ?? "").toLowerCase();
          if (!mrn || (o.status ?? "").toLowerCase() !== "ordered") return;
          // Only auto-cascade truly manual physician orders. Admission
          // workflow / randomizer / bedside RN orders own their own
          // staged cascade — do NOT short-circuit them here.
          if (
            source.includes("admission randomizer") ||
            source.includes("admission workflow") ||
            source.includes("bedside rn") ||
            source.includes("ghost ai") ||
            source.includes("auto doc")
          ) return;
          cascadeMed(mrn, o.id).catch((e) => console.warn("[order-cascadeMed] failed", e));
        },
      )
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "lab_orders" },
        (payload) => {
          const o = payload.new as InsertedOrder;
          const mrn = o.patient_mrn ?? o.mrn;
          const source = (o.ordered_by ?? "").toLowerCase();
          if (!mrn || (o.status ?? "").toLowerCase() !== "ordered") return;
          if (
            source.includes("admission randomizer") ||
            source.includes("admission workflow") ||
            source.includes("bedside rn") ||
            source.includes("ghost ai") ||
            source.includes("auto doc")
          ) return;
          cascadeLab(mrn, o.id, `${o.test_type ?? "Lab"}: resulted`).catch((e) =>
            console.warn("[order-cascadeLab] failed", e),
          );
        },
      )
      .subscribe();

    // Bed cleaning state machine sweeper — every 5s the active client
    // advances any bed that has crossed its 60s / 120s threshold.
    sweepBedCleaningCycles().catch(() => {});
    const bedSweep = setInterval(() => {
      sweepBedCleaningCycles().catch(() => {});
    }, 5_000);

    return () => {
      supabase.removeChannel(channel);
      clearAllTimers();
      clearInterval(sweepInterval);
      clearInterval(bedSweep);
    };
  }, [automationEnabled]);
}