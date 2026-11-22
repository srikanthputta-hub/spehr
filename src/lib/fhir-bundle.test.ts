import { describe, expect, it } from "vitest";
import { buildEncounterBundle, type RadiologyOrderRow } from "./fhir-bundle";

/**
 * Regression tests for the FHIR export QA sweep (H1):
 *   1. AllergyIntolerance is built for every documented allergy — it was
 *      never queried/built at all by the sync `buildEncounterBundle` path
 *      used by the "View / Export JSON" dialog.
 *   2. A lab order whose test_type is a long, real LOINC "Long Common
 *      Name" (e.g. the standard Procalcitonin assay name) is no longer
 *      dropped as "implausible" just for being >40 characters.
 *   3. Every radiology order gets its own ServiceRequest / DiagnosticReport
 *      — two distinct orders for the same exam type (e.g. two chest
 *      X-rays) must not collide onto a single resource id.
 */

const basePatient = {
  mrn: "MRN-658927",
  name: "Patricia QATest",
  dob: "1977-03-03",
  status: "Discharged",
  admission_time: "2026-11-21T17:28:47Z",
  discharge_time: "2026-11-21T17:40:08Z",
  chief_complaint: "Persistent fever and productive cough for 4 days",
};

function entriesOf(bundle: any, resourceType: string): any[] {
  return (bundle.entry ?? [])
    .map((e: any) => e.resource)
    .filter((r: any) => r?.resourceType === resourceType);
}

describe("buildEncounterBundle — allergies", () => {
  it("builds an AllergyIntolerance resource for every documented allergy", () => {
    const bundle = buildEncounterBundle({
      patient: basePatient,
      allergies: [
        { substance: "Penicillin", reaction: "Anaphylaxis", substance_snomed: "764146007" },
        { substance: "Eggs", substance_snomed: "102263004" },
      ],
    });
    const allergies = entriesOf(bundle, "AllergyIntolerance");
    expect(allergies).toHaveLength(2);
    const penicillin = allergies.find((a) => a.code?.text === "Penicillin");
    expect(penicillin).toBeTruthy();
    expect(penicillin.reaction?.[0]?.manifestation?.[0]?.text).toBe("Anaphylaxis");
    expect(penicillin.code.coding[0]).toMatchObject({ code: "764146007" });
  });

  it("omits allergies entirely when none are documented (never fabricates one)", () => {
    const bundle = buildEncounterBundle({ patient: basePatient, allergies: [] });
    expect(entriesOf(bundle, "AllergyIntolerance")).toHaveLength(0);
  });
});

describe("buildEncounterBundle — lab plausibility filter", () => {
  it("keeps a real, long LOINC long-common-name lab order", () => {
    const bundle = buildEncounterBundle({
      patient: basePatient,
      labs: [
        {
          id: "lab-1",
          test_type: "Procalcitonin [Mass/volume] in Serum or Plasma by Immunoassay",
          result_value: "0.08 ng/mL",
          status: "Reported",
          created_at: "2026-11-21T17:32:51Z",
        },
      ],
    });
    expect(entriesOf(bundle, "Observation").map((o) => o.code?.text)).toContain(
      "Procalcitonin [Mass/volume] in Serum or Plasma by Immunoassay",
    );
    expect(entriesOf(bundle, "ServiceRequest").map((s) => s.code?.text)).toContain(
      "Procalcitonin [Mass/volume] in Serum or Plasma by Immunoassay",
    );
  });

  it("still drops a free-text NLP sentence masquerading as a lab name", () => {
    const bundle = buildEncounterBundle({
      patient: basePatient,
      labs: [
        {
          id: "lab-2",
          test_type:
            "Conditions related to mental retardation and developmental disorders affecting cognition",
          created_at: "2026-11-21T17:32:51Z",
        },
      ],
    });
    expect(entriesOf(bundle, "Observation")).toHaveLength(0);
  });

  it("keeps short, ordinary lab names as before", () => {
    const bundle = buildEncounterBundle({
      patient: basePatient,
      labs: [
        { id: "lab-3", test_type: "Hemoglobin", created_at: "2026-11-21T17:29:00Z" },
        { id: "lab-4", test_type: "WBC", created_at: "2026-11-21T17:29:07Z" },
      ],
    });
    expect(entriesOf(bundle, "Observation")).toHaveLength(2);
  });
});

describe("buildEncounterBundle — radiology orders", () => {
  const twoChestXrays: RadiologyOrderRow[] = [
    {
      id: "rad-1",
      patient_mrn: basePatient.mrn,
      exam_type: "Chest X-ray",
      snomed_code: "399208008",
      snomed_display: "Plain chest X-ray",
      clinical_indication: "r/o pneumonia",
      report_text: "FINDINGS: no acute abnormality.",
      impression: "No acute chest abnormality identified.",
      ordered_at: "2026-11-21T17:31:04Z",
      resulted_at: "2026-11-21T17:31:10Z",
    },
    {
      id: "rad-2",
      patient_mrn: basePatient.mrn,
      exam_type: "Chest X-ray",
      snomed_code: "399208008",
      snomed_display: "Plain chest X-ray",
      clinical_indication: "Community-Acquired Pneumonia",
      report_text: "FINDINGS: no acute abnormality.",
      impression: "No acute chest abnormality identified.",
      ordered_at: "2026-11-21T17:28:48Z",
      resulted_at: "2026-11-21T17:28:55Z",
    },
  ];

  it("emits a separate ServiceRequest for each order, even with the same exam type", () => {
    const bundle = buildEncounterBundle({ patient: basePatient, radiologyOrders: twoChestXrays });
    const requests = entriesOf(bundle, "ServiceRequest");
    const ids = new Set(requests.map((r) => r.id));
    expect(requests).toHaveLength(2);
    expect(ids.size).toBe(2);
    const indications = requests.map((r) => r.reasonCode?.[0]?.text).sort();
    expect(indications).toEqual(["Community-Acquired Pneumonia", "r/o pneumonia"]);
  });

  it("emits a DiagnosticReport per reported study, basedOn its own ServiceRequest", () => {
    const bundle = buildEncounterBundle({ patient: basePatient, radiologyOrders: twoChestXrays });
    const requests = entriesOf(bundle, "ServiceRequest");
    const reports = entriesOf(bundle, "DiagnosticReport");
    expect(reports).toHaveLength(2);
    const srIds = new Set(requests.map((r) => r.id));
    for (const report of reports) {
      const basedOnRef = report.basedOn?.[0]?.reference as string;
      expect(basedOnRef).toBeTruthy();
      expect(srIds.has(basedOnRef.replace(/^ServiceRequest\//, ""))).toBe(true);
    }
  });

  it("does not build a DiagnosticReport for an order with no report yet", () => {
    const bundle = buildEncounterBundle({
      patient: basePatient,
      radiologyOrders: [{ id: "rad-3", patient_mrn: basePatient.mrn, exam_type: "MRI Brain" }],
    });
    expect(entriesOf(bundle, "DiagnosticReport")).toHaveLength(0);
    expect(entriesOf(bundle, "ServiceRequest")).toHaveLength(1);
  });
});
