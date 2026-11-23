import { describe, expect, it } from "vitest";
import {
  buildAdmissionTransactionBundle,
  buildDischargeTransactionBundle,
  type AdmissionPatient,
} from "./fhir-admission-discharge";

/**
 * Regression tests for the FHIR export coding gap: the Condition /
 * MedicationStatement / MedicationRequest / AllergyIntolerance resources
 * built from the Admission Case History free-text fields (and the
 * discharge diagnosis) previously never carried a `coding` entry at all —
 * only `code.text` — even when the SAME clinical fact already had a real
 * SNOMED/ICD-10/RxNorm code captured in the `conditions` / `medication_
 * orders` / `allergies` tables. These tests assert:
 *   1. A free-text item that exactly matches an already-coded row is now
 *      exported with a real `coding` entry.
 *   2. A free-text item with NO matching coded row is still exported
 *      text-only — never a fabricated code.
 */

function entriesOf(bundle: any, resourceType: string): any[] {
  return (bundle.entry ?? [])
    .map((e: any) => e.resource)
    .filter((r: any) => r?.resourceType === resourceType);
}

const basePatient: AdmissionPatient = {
  mrn: "MRN-342037",
  name: "Test Patient",
  chief_complaint: "Sharp lower back pain after a fall this afternoon",
  past_medical_history: "Hypertension, Asthma",
  current_medications: "Lisinopril 10 mg PO Daily",
  allergies: "Sulfa (Hives)",
  admission_time: "2026-11-23T14:00:00Z",
};

describe("buildAdmissionTransactionBundle — coding wiring", () => {
  it("attaches real SNOMED/ICD-10 coding to a PMH Condition that matches an already-coded row", () => {
    const { bundle } = buildAdmissionTransactionBundle(basePatient, {
      conditions: [{ display_text: "Hypertension", snomed_code: "38341003", icd10_code: "I10" }],
    });
    const conditions = entriesOf(bundle, "Condition");
    const htn = conditions.find((c) => c.code?.text === "Hypertension");
    expect(htn).toBeTruthy();
    expect(htn.code.coding).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "38341003", system: "http://snomed.info/sct" }),
        expect.objectContaining({ code: "I10", system: "http://hl7.org/fhir/sid/icd-10-cm" }),
      ]),
    );
  });

  it("leaves a PMH Condition text-only when no coded row matches (never fabricates a code)", () => {
    const { bundle } = buildAdmissionTransactionBundle(basePatient, {
      conditions: [{ display_text: "Hypertension", snomed_code: "38341003", icd10_code: "I10" }],
    });
    const conditions = entriesOf(bundle, "Condition");
    const asthma = conditions.find((c) => c.code?.text === "Asthma");
    expect(asthma).toBeTruthy();
    expect(asthma.code.coding).toBeUndefined();
  });

  it("codes the HPI Condition when the chief complaint exactly matches a coded row", () => {
    const { bundle } = buildAdmissionTransactionBundle(basePatient, {
      conditions: [
        {
          display_text: "Sharp lower back pain after a fall this afternoon",
          snomed_code: "161891005",
          icd10_code: "M54.50",
        },
      ],
    });
    const hpi = entriesOf(bundle, "Condition").find(
      (c) => c.code?.text === "Sharp lower back pain after a fall this afternoon",
    );
    expect(hpi.code.coding?.[0]).toMatchObject({ code: "161891005" });
  });

  it("attaches a real RxNorm code to a MedicationStatement whose free-text item starts with a coded drug name", () => {
    const { bundle } = buildAdmissionTransactionBundle(basePatient, {
      medications: [
        { drug_name: "Lisinopril", rxnorm_code: "29046", rxnorm_display: "Lisinopril" },
      ],
    });
    const meds = entriesOf(bundle, "MedicationStatement");
    expect(meds).toHaveLength(1);
    expect(meds[0].medicationCodeableConcept.coding?.[0]).toMatchObject({
      code: "29046",
      system: "http://www.nlm.nih.gov/research/umls/rxnorm",
    });
    expect(meds[0].medicationCodeableConcept.text).toBe("Lisinopril 10 mg PO Daily");
  });

  it("leaves a MedicationStatement text-only when no medication_orders row matches", () => {
    const { bundle } = buildAdmissionTransactionBundle(basePatient, { medications: [] });
    const meds = entriesOf(bundle, "MedicationStatement");
    expect(meds[0].medicationCodeableConcept.coding).toBeUndefined();
    expect(meds[0].medicationCodeableConcept.text).toBe("Lisinopril 10 mg PO Daily");
  });

  it("attaches a real SNOMED code to an AllergyIntolerance whose substance matches an already-coded allergy row", () => {
    const { bundle } = buildAdmissionTransactionBundle(basePatient, {
      allergies: [{ substance: "Sulfa", substance_snomed: "416897008" }],
    });
    const allergy = entriesOf(bundle, "AllergyIntolerance").find((a) => a.code?.text === "Sulfa");
    expect(allergy).toBeTruthy();
    expect(allergy.code.coding?.[0]).toMatchObject({ code: "416897008" });
    // Reaction manifestation parsing from the "(Hives)" parenthetical is unaffected.
    expect(allergy.reaction?.[0]?.manifestation?.[0]?.text).toBe("Hives");
  });

  it("builds a fully text-only admission bundle when no coded rows are supplied at all (back-compat)", () => {
    const { bundle } = buildAdmissionTransactionBundle(basePatient);
    const conditions = entriesOf(bundle, "Condition");
    expect(conditions.length).toBeGreaterThan(0);
    for (const c of conditions) expect(c.code.coding).toBeUndefined();
  });
});

describe("buildDischargeTransactionBundle — discharge diagnosis Condition", () => {
  it("emits a discrete, coded Condition resource for the discharge diagnosis when it matches a coded row", () => {
    const { bundle } = buildDischargeTransactionBundle({
      patient: {
        ...basePatient,
        diagnosis: "Lumbar strain",
        discharge_time: "2026-11-24T10:00:00Z",
      },
      admittingDiagnosis: "Sharp lower back pain after a fall this afternoon",
      dischargeDiagnosis: "Lumbar strain",
      codedConditions: [
        {
          display_text: "Sharp lower back pain after a fall this afternoon",
          snomed_code: "161891005",
          icd10_code: "M54.50",
        },
      ],
    });
    const conditions = entriesOf(bundle, "Condition");
    expect(conditions).toHaveLength(1);
    expect(conditions[0].code.text).toBe("Lumbar strain");
    // No exact text match on "Lumbar strain" itself, but it correctly falls
    // back to the real code already resolved for the same encounter's
    // admitting complaint rather than exporting text-only or guessing.
    expect(conditions[0].code.coding?.[0]).toMatchObject({ code: "161891005" });
  });

  it("exports the discharge diagnosis Condition as text-only when nothing on file is coded (never fabricates)", () => {
    const { bundle } = buildDischargeTransactionBundle({
      patient: {
        ...basePatient,
        diagnosis: "Lumbar strain",
        discharge_time: "2026-11-24T10:00:00Z",
      },
      admittingDiagnosis: "Sharp lower back pain after a fall this afternoon",
      dischargeDiagnosis: "Lumbar strain",
      codedConditions: [],
    });
    const conditions = entriesOf(bundle, "Condition");
    expect(conditions).toHaveLength(1);
    expect(conditions[0].code).toEqual({ text: "Lumbar strain" });
  });

  it("omits the diagnosis Condition entirely when there is no diagnosis text anywhere (never fabricates one)", () => {
    const { bundle } = buildDischargeTransactionBundle({
      patient: { mrn: "MRN-000001", discharge_time: "2026-11-24T10:00:00Z" },
    });
    expect(entriesOf(bundle, "Condition")).toHaveLength(0);
  });
});
