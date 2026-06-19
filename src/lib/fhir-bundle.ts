/**
 * FHIR R4 helpers — CodeableConcept builders and Bundle assembly used by the
 * Medical Dictionary dashboards (Live Terminology Matrix, NLP Audit Logs
 * "Standard Report", and Safety Alerts) so every code surfaced in the EHR
 * carries the canonical {system, code, display} triple required for
 * interoperability with external FHIR servers.
 */

export const FHIR_SYSTEM_URI: Record<string, string> = {
  "ICD-10": "http://hl7.org/fhir/sid/icd-10-cm",
  "SNOMED CT": "http://snomed.info/sct",
  LOINC: "http://loinc.org",
  RxNorm: "http://www.nlm.nih.gov/research/umls/rxnorm",
  VSAC: "http://cts.nlm.nih.gov/fhir/",
};

export type CodeableConcept = {
  coding: Array<{ system: string; code: string; display: string }>;
  text: string;
};

export function toCodeableConcept(
  system: string,
  code: string,
  display: string,
): CodeableConcept {
  return {
    coding: [
      {
        system: FHIR_SYSTEM_URI[system] ?? `urn:spehr:${system.toLowerCase()}`,
        code,
        display,
      },
    ],
    text: display,
  };
}

/* ------------------------------------------------------------------ */
/*  Resource builders                                                  */
/* ------------------------------------------------------------------ */

export function buildPatientResource(p: {
  mrn: string;
  name?: string | null;
  facility?: string | null;
}) {
  const [given, ...rest] = (p.name ?? "").split(" ");
  const family = rest.join(" ");
  return {
    resourceType: "Patient",
    id: p.mrn,
    identifier: [
      {
        system: "urn:spehr:mrn",
        value: p.mrn,
      },
    ],
    name: p.name
      ? [{ use: "official", given: given ? [given] : [], family: family || given || "" }]
      : undefined,
    managingOrganization: p.facility
      ? { display: p.facility }
      : undefined,
  };
}

export function buildCondition(
  mrn: string,
  cc: CodeableConcept,
  opts: { id?: string; clinicalStatus?: "active" | "resolved" } = {},
) {
  return {
    resourceType: "Condition",
    id: opts.id ?? `cond-${cc.coding[0]?.code}`,
    clinicalStatus: {
      coding: [
        {
          system: "http://terminology.hl7.org/CodeSystem/condition-clinical",
          code: opts.clinicalStatus ?? "active",
        },
      ],
    },
    code: cc,
    subject: { reference: `Patient/${mrn}` },
  };
}

export function buildObservation(
  mrn: string,
  cc: CodeableConcept,
  opts: { id?: string; value?: string | number; unit?: string; status?: string } = {},
) {
  return {
    resourceType: "Observation",
    id: opts.id ?? `obs-${cc.coding[0]?.code}`,
    status: opts.status ?? "registered",
    category: [
      {
        coding: [
          {
            system: "http://terminology.hl7.org/CodeSystem/observation-category",
            code: "laboratory",
            display: "Laboratory",
          },
        ],
      },
    ],
    code: cc,
    subject: { reference: `Patient/${mrn}` },
    valueQuantity:
      typeof opts.value === "number"
        ? { value: opts.value, unit: opts.unit }
        : undefined,
    valueString:
      typeof opts.value === "string" ? opts.value : undefined,
  };
}

export function buildMedicationRequest(
  mrn: string,
  cc: CodeableConcept,
  opts: { id?: string; status?: string; intent?: string } = {},
) {
  return {
    resourceType: "MedicationRequest",
    id: opts.id ?? `medreq-${cc.coding[0]?.code}`,
    status: opts.status ?? "active",
    intent: opts.intent ?? "order",
    medicationCodeableConcept: cc,
    subject: { reference: `Patient/${mrn}` },
  };
}

export function buildAllergyIntolerance(
  mrn: string,
  cc: CodeableConcept,
  opts: { id?: string; criticality?: "low" | "high" | "unable-to-assess" } = {},
) {
  return {
    resourceType: "AllergyIntolerance",
    id: opts.id ?? `allergy-${cc.coding[0]?.code}`,
    clinicalStatus: {
      coding: [
        {
          system: "http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical",
          code: "active",
        },
      ],
    },
    type: "allergy",
    criticality: opts.criticality ?? "high",
    code: cc,
    patient: { reference: `Patient/${mrn}` },
  };
}

/* ------------------------------------------------------------------ */
/*  Bundle assembly                                                    */
/* ------------------------------------------------------------------ */

export type FhirEntry = { fullUrl?: string; resource: any };

function urn(resource: any): string {
  return `urn:uuid:${resource.resourceType}-${resource.id ?? Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Build a FHIR R4 Bundle of type=`document` containing a Composition that
 * references every approved Condition / Observation / MedicationRequest for
 * the patient. This is the exact JSON payload pushed to the external FHIR
 * server by the push_to_fhir edge function.
 */
export function buildPatientBundle(opts: {
  mrn: string;
  patientName?: string | null;
  facility?: string | null;
  conditions: CodeableConcept[];
  observations: CodeableConcept[];
  medicationRequests: CodeableConcept[];
  allergies?: CodeableConcept[];
  title?: string;
}) {
  const patient = buildPatientResource({
    mrn: opts.mrn,
    name: opts.patientName,
    facility: opts.facility,
  });
  const conditions = opts.conditions.map((c, i) =>
    buildCondition(opts.mrn, c, { id: `cond-${i + 1}-${c.coding[0]?.code}` }),
  );
  const observations = opts.observations.map((c, i) =>
    buildObservation(opts.mrn, c, { id: `obs-${i + 1}-${c.coding[0]?.code}` }),
  );
  const meds = opts.medicationRequests.map((c, i) =>
    buildMedicationRequest(opts.mrn, c, { id: `medreq-${i + 1}-${c.coding[0]?.code}` }),
  );
  const allergies = (opts.allergies ?? []).map((c, i) =>
    buildAllergyIntolerance(opts.mrn, c, { id: `allergy-${i + 1}-${c.coding[0]?.code}` }),
  );

  const composition = {
    resourceType: "Composition",
    id: `composition-${opts.mrn}`,
    status: "final",
    type: {
      coding: [
        { system: "http://loinc.org", code: "11488-4", display: "Consult note" },
      ],
      text: opts.title ?? "S.P.E.H.R Admission Summary",
    },
    subject: { reference: `Patient/${opts.mrn}` },
    date: new Date().toISOString(),
    author: [{ display: "S.P.E.H.R AI Coding Engine" }],
    title: opts.title ?? `Admission summary — ${opts.patientName ?? opts.mrn}`,
    section: [
      {
        title: "Problem List",
        entry: conditions.map((c) => ({ reference: `Condition/${c.id}` })),
      },
      {
        title: "Diagnostic Observations",
        entry: observations.map((c) => ({ reference: `Observation/${c.id}` })),
      },
      {
        title: "Medication Orders",
        entry: meds.map((c) => ({ reference: `MedicationRequest/${c.id}` })),
      },
      ...(allergies.length
        ? [
            {
              title: "Allergies",
              entry: allergies.map((c) => ({ reference: `AllergyIntolerance/${c.id}` })),
            },
          ]
        : []),
    ],
  };

  const allResources = [composition, patient, ...conditions, ...observations, ...meds, ...allergies];
  const entries: FhirEntry[] = allResources.map((r) => ({
    fullUrl: urn(r),
    resource: r,
  }));

  return {
    resourceType: "Bundle",
    id: `bundle-${opts.mrn}-${Date.now()}`,
    type: "document",
    timestamp: new Date().toISOString(),
    entry: entries,
  };
}

/** Crosswalk bundle (type=collection) for the Live Terminology Matrix. */
export function buildCrosswalkBundle(opts: {
  mrn: string;
  patientName?: string | null;
  facility?: string | null;
  concepts: CodeableConcept[];
}) {
  const patient = buildPatientResource({
    mrn: opts.mrn,
    name: opts.patientName,
    facility: opts.facility,
  });
  const resources = opts.concepts.map((c) => {
    const system = c.coding[0]?.system ?? "";
    if (system === FHIR_SYSTEM_URI.RxNorm) return buildMedicationRequest(opts.mrn, c);
    if (system === FHIR_SYSTEM_URI.LOINC) return buildObservation(opts.mrn, c);
    return buildCondition(opts.mrn, c);
  });
  return {
    resourceType: "Bundle",
    id: `crosswalk-${opts.mrn}-${Date.now()}`,
    type: "collection",
    timestamp: new Date().toISOString(),
    entry: [patient, ...resources].map((r) => ({
      fullUrl: urn(r),
      resource: r,
    })),
  };
}

/** Trigger a JSON download in the browser. */
export function downloadJson(filename: string, payload: unknown) {
  if (typeof window === "undefined") return;
  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: "application/fhir+json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}