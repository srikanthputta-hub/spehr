import { describe, expect, it } from "vitest";
import {
  ADMISSION_DIAGNOSIS_CONSUMER,
  matchAdmissionDiagnosisToPublishedValueSet,
} from "./diagnosis-value-set-map";

type FakeCode = { code: string; display: string; system: string };
type FakeValueSetRow = {
  id: string;
  name: string;
  oid: string | null;
  vocabulary: string | null;
  type: string;
  codes: FakeCode[] | null;
  intensional_rule: unknown;
  status: string;
};

/**
 * Fakes the exact shape `loadPublishedValueSetsForConsumer()` queries:
 * `client.from("value_set_dependencies").select(...).eq("consumer", ...)`
 * resolving to `{ value_set_name, custom_value_sets }` rows.
 */
function makeClient(rows: Array<{ value_set_name: string; custom_value_sets: FakeValueSetRow }>) {
  return {
    // Unused by matchAdmissionDiagnosisToPublishedValueSet (it never calls
    // umls-proxy), but required by the shared MinimalUmlsClient shape.
    functions: { invoke: async () => ({ data: null, error: new Error("not used in this test") }) },
    from: (_table: string) => ({
      select: (_cols: string) => ({
        eq: (_col: string, _val: string) => Promise.resolve({ data: rows, error: null }),
      }),
    }),
  };
}

const PNEUMONIA_ROW: FakeValueSetRow = {
  id: "vs-pneumonia",
  name: "CAP Pneumonia Diagnostic",
  oid: "2.16.840.1.113762.1.4.1264.24",
  vocabulary: "ICD-10-CM",
  type: "extensional",
  status: "published",
  intensional_rule: null,
  codes: [
    {
      code: "A37.01",
      display: "Whooping cough due to Bordetella pertussis with pneumonia",
      system: "ICD-10-CM",
    },
    { code: "J18.9", display: "Pneumonia, unspecified organism", system: "ICD-10-CM" },
  ],
};

const AFIB_ROW: FakeValueSetRow = {
  id: "vs-afib",
  name: "AHA GWTG Atrial Fibrillation",
  oid: "2.16.840.1.113762.1.4.1178.121",
  vocabulary: "SNOMED CT",
  type: "grouping",
  status: "published",
  intensional_rule: null,
  codes: [
    {
      code: "1010405004",
      display: "Paroxysmal atrial fibrillation with rapid ventricular response (disorder)",
      system: "SNOMED CT",
    },
    { code: "I48.91", display: "Unspecified atrial fibrillation", system: "ICD-10-CM" },
  ],
};

describe("matchAdmissionDiagnosisToPublishedValueSet", () => {
  it("matches 'Pneumonia' free text to the published CAP value set's real ICD-10-CM code", async () => {
    const client = makeClient([
      { value_set_name: PNEUMONIA_ROW.name, custom_value_sets: PNEUMONIA_ROW },
    ]);
    const match = await matchAdmissionDiagnosisToPublishedValueSet(
      "Community-acquired pneumonia, right lower lobe",
      client,
    );
    expect(match).toEqual({
      valueSetId: "vs-pneumonia",
      valueSetName: "CAP Pneumonia Diagnostic",
      oid: "2.16.840.1.113762.1.4.1264.24",
      code: "J18.9",
      display: "Pneumonia, unspecified organism",
      vocabulary: "ICD-10-CM",
    });
  });

  it("matches the 'afib' synonym to the AHA GWTG value set's ICD-10-CM entry inside its mixed SNOMED/ICD-10 codes array", async () => {
    const client = makeClient([{ value_set_name: AFIB_ROW.name, custom_value_sets: AFIB_ROW }]);
    const match = await matchAdmissionDiagnosisToPublishedValueSet("New onset AFib", client);
    expect(match?.code).toBe("I48.91");
    expect(match?.valueSetName).toBe("AHA GWTG Atrial Fibrillation");
  });

  it("is case-insensitive and matches whole words only (no false hit inside an unrelated word)", async () => {
    const client = makeClient([
      { value_set_name: PNEUMONIA_ROW.name, custom_value_sets: PNEUMONIA_ROW },
    ]);
    expect(await matchAdmissionDiagnosisToPublishedValueSet("PNEUMONIA", client)).not.toBeNull();
    // "cap" is a keyword, but must not match inside "capable"/"capillary".
    expect(
      await matchAdmissionDiagnosisToPublishedValueSet("Capillary refill delayed", client),
    ).toBeNull();
  });

  it("returns null for diagnosis text matching none of the five diagnoses", async () => {
    const client = makeClient([
      { value_set_name: PNEUMONIA_ROW.name, custom_value_sets: PNEUMONIA_ROW },
    ]);
    expect(
      await matchAdmissionDiagnosisToPublishedValueSet("Fall with hip fracture", client),
    ).toBeNull();
    expect(await matchAdmissionDiagnosisToPublishedValueSet("", client)).toBeNull();
  });

  it("honestly returns null (no fabrication) when the dependency isn't linked to a published value set yet", async () => {
    const client = makeClient([]); // no value_set_dependencies rows for this consumer
    expect(await matchAdmissionDiagnosisToPublishedValueSet("Pneumonia", client)).toBeNull();
  });

  it("honestly returns null when the matched value set's codes array no longer contains the target code (e.g. re-synced away)", async () => {
    const resyncedRow: FakeValueSetRow = {
      ...PNEUMONIA_ROW,
      codes: [{ code: "A37.01", display: "Whooping cough with pneumonia", system: "ICD-10-CM" }],
    };
    const client = makeClient([
      { value_set_name: resyncedRow.name, custom_value_sets: resyncedRow },
    ]);
    expect(await matchAdmissionDiagnosisToPublishedValueSet("Pneumonia", client)).toBeNull();
  });

  it("uses the module's documented consumer name for the dependency lookup", () => {
    expect(ADMISSION_DIAGNOSIS_CONSUMER).toBe("Admission Diagnosis Coding");
  });
});
