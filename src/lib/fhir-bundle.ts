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

/* ------------------------------------------------------------------ */
/*  Deterministic stable-ID helpers                                    */
/*  Every clinical fact maps to the SAME FHIR resource id every time,  */
/*  so PUT /ResourceType/{stableId} performs an idempotent UPSERT and  */
/*  the Medblocks server can never accumulate duplicates.              */
/* ------------------------------------------------------------------ */

export function slugify(input: string): string {
  return (input ?? "")
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60) || "unknown";
}

export const stableIds = {
  patient: (mrn: string) => mrn,
  encounter: (mrn: string) => `enc-${mrn}`,
  relatedPerson: (mrn: string) => `relp-${mrn}-econ`,
  vital: (loinc: string, mrn: string) => `vital-${loinc}-${mrn}`,
  lab: (testName: string, mrn: string) => `lab-${slugify(testName)}-${mrn}`,
  medRequest: (drug: string, mrn: string) => `medreq-${slugify(drug)}-${mrn}`,
  medAdmin: (drug: string, mrn: string) => `medadmin-${slugify(drug)}-${mrn}`,
  allergy: (allergen: string, mrn: string) => `allergy-${slugify(allergen)}-${mrn}`,
  // FHIR R4 IDs must match [A-Za-z0-9\-\.]{1,64}. The semantic token is
  // hard-capped at 30 chars so `cond-{token}-{mrn}` is always ≤ 64.
  // Never pass free-text complaints here — use fixed tokens like "hpi",
  // "discharge", "pmh-gerd", "pmh-htn", "pmh-1", "phx-1". Free text
  // belongs in Condition.code.text / Condition.note[].text.
  condition: (type: string, mrn: string) => {
    const safe = (type ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .substring(0, 30) || "unknown";
    return `cond-${safe}-${mrn}`;
  },
  carePlan: (mrn: string) => `careplan-${mrn}`,
  composition: (mrn: string) => `summary-${mrn}`,
  appointment: (mrn: string) => `appt-followup-${mrn}`,
  docRef: (mrn: string) => `docref-${mrn}`,
};

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

/* ------------------------------------------------------------------ */
/*  Encounter (longitudinal) bundle — used by the FHIR Interoperability */
/*  dashboard. Contains the full per-admission record: Patient,        */
/*  Encounter, Observations (vitals + labs), MedicationRequest /       */
/*  MedicationAdministration, DocumentReference (clinical notes), and  */
/*  CarePlan + Appointment (recalls / discharge instructions).         */
/* ------------------------------------------------------------------ */

export type EncounterPatient = {
  mrn: string;
  name?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  dob?: string | null;
  gender?: string | null;
  biological_sex?: string | null;
  address?: string | null;
  phone?: string | null;
  facility_name?: string | null;
  admission_time?: string | null;
  discharge_time?: string | null;
  status?: string | null;
  chief_complaint?: string | null;
  diagnosis?: string | null;
  discharge_summary?: string | null;
  bp?: string | null;
  hr?: number | null;
  rr?: number | null;
  spo2?: number | null;
  temp?: number | null;
  allergies?: string | null;
};

export type EncounterLab = {
  id?: string;
  test_type?: string | null;
  result_value?: string | null;
  status?: string | null;
  collected_at?: string | null;
  created_at?: string | null;
};

export type EncounterMed = {
  id?: string;
  drug_name?: string | null;
  drug?: string | null;
  medication_name?: string | null;
  dose?: string | null;
  route?: string | null;
  status?: string | null;
  ordered_by?: string | null;
  ordering_physician?: string | null;
  administered_at?: string | null;
  approved_at?: string | null;
  created_at?: string | null;
};

export type EncounterNote = {
  id?: string;
  note_type?: string | null;
  author?: string | null;
  content?: string | null;
  created_at?: string | null;
};

function fullPatient(p: EncounterPatient) {
  const name =
    p.name ??
    [p.first_name, p.last_name].filter(Boolean).join(" ") ??
    null;
  const [given, ...rest] = (name ?? "").split(" ");
  const family = rest.join(" ") || given || "";
  return {
    resourceType: "Patient",
    id: p.mrn,
    identifier: [{ system: "urn:spehr:mrn", value: p.mrn }],
    name: name ? [{ use: "official", given: given ? [given] : [], family }] : undefined,
    gender:
      (p.gender ?? p.biological_sex ?? "").toLowerCase().startsWith("m")
        ? "male"
        : (p.gender ?? p.biological_sex ?? "").toLowerCase().startsWith("f")
        ? "female"
        : "unknown",
    birthDate: p.dob ?? undefined,
    telecom: p.phone ? [{ system: "phone", value: p.phone }] : undefined,
    address: p.address ? [{ text: p.address }] : undefined,
    managingOrganization: p.facility_name ? { display: p.facility_name } : undefined,
  };
}

function buildEncounterResource(p: EncounterPatient) {
  const status =
    (p.status ?? "").toLowerCase() === "discharged" || p.discharge_time
      ? "finished"
      : "in-progress";
  return {
    resourceType: "Encounter",
    id: `enc-${p.mrn}`,
    identifier: [
      { system: "urn:spehr:encounter", value: `enc-${p.mrn}` },
    ],
    status,
    class: {
      system: "http://terminology.hl7.org/CodeSystem/v3-ActCode",
      code: "EMER",
      display: "Emergency",
    },
    subject: { reference: `Patient/${p.mrn}` },
    period: {
      start: p.admission_time ?? undefined,
      end: p.discharge_time ?? undefined,
    },
    reasonCode: p.chief_complaint
      ? [{ text: p.chief_complaint }]
      : undefined,
    serviceProvider: p.facility_name ? { display: p.facility_name } : undefined,
  };
}

function vitalsObservations(p: EncounterPatient) {
  const ref = { reference: `Patient/${p.mrn}` };
  const enc = { reference: `Encounter/enc-${p.mrn}` };
  const out: any[] = [];
  const push = (
    loinc: string,
    code: { code: string; display: string },
    value: { value: number; unit: string } | { valueString: string },
  ) => {
    out.push({
      resourceType: "Observation",
      id: stableIds.vital(loinc, p.mrn),
      status: "final",
      category: [
        {
          coding: [
            {
              system: "http://terminology.hl7.org/CodeSystem/observation-category",
              code: "vital-signs",
              display: "Vital Signs",
            },
          ],
        },
      ],
      code: {
        coding: [{ system: "http://loinc.org", code: code.code, display: code.display }],
        text: code.display,
      },
      subject: ref,
      encounter: enc,
      effectiveDateTime: p.admission_time ?? undefined,
      ...("value" in value
        ? { valueQuantity: value }
        : { valueString: value.valueString }),
    });
  };
  if (typeof p.hr === "number") push("8867-4", { code: "8867-4", display: "Heart rate" }, { value: p.hr, unit: "/min" });
  if (typeof p.rr === "number") push("9279-1", { code: "9279-1", display: "Respiratory rate" }, { value: p.rr, unit: "/min" });
  if (typeof p.spo2 === "number") push("59408-5", { code: "59408-5", display: "Oxygen saturation" }, { value: p.spo2, unit: "%" });
  if (typeof p.temp === "number") push("8310-5", { code: "8310-5", display: "Body temperature" }, { value: p.temp, unit: "Cel" });
  if (p.bp) push("85354-9", { code: "85354-9", display: "Blood pressure panel" }, { valueString: p.bp });
  return out;
}

function labObservation(mrn: string, l: EncounterLab) {
  const id = stableIds.lab(l.test_type ?? l.id ?? "unknown", mrn);
  const numeric = l.result_value ? Number((l.result_value.match(/-?\d+(\.\d+)?/) ?? [])[0]) : NaN;
  return {
    resourceType: "Observation",
    id,
    status:
      (l.status ?? "").toLowerCase() === "resulted" || l.result_value
        ? "final"
        : "registered",
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
    code: { text: l.test_type ?? "Lab" },
    subject: { reference: `Patient/${mrn}` },
    encounter: { reference: `Encounter/enc-${mrn}` },
    effectiveDateTime: l.collected_at ?? l.created_at ?? undefined,
    ...(Number.isFinite(numeric)
      ? { valueQuantity: { value: numeric } }
      : l.result_value
      ? { valueString: l.result_value }
      : {}),
  };
}

function medRequest(mrn: string, m: EncounterMed) {
  const drug = m.drug_name ?? m.drug ?? m.medication_name ?? "medication";
  const raw = (m.status ?? "").toLowerCase();
  // FHIR R4 MedicationRequest.status: active|on-hold|cancelled|completed|entered-in-error|stopped|draft|unknown
  const status =
    raw === "administered" || raw === "completed" || raw === "given"
      ? "completed"
      : raw === "pending verification" || raw === "draft" || raw === "pending"
        ? "draft"
        : raw === "cancelled" || raw === "canceled"
          ? "cancelled"
          : raw === "on-hold" || raw === "held"
            ? "on-hold"
            : raw === "stopped" || raw === "discontinued"
              ? "stopped"
              : "active";
  return {
    resourceType: "MedicationRequest",
    id: stableIds.medRequest(`${drug}${m.dose ? `-${m.dose}` : ""}`, mrn),
    status,
    intent: "order",
    medicationCodeableConcept: { text: `${drug}${m.dose ? ` ${m.dose}` : ""}` },
    subject: { reference: `Patient/${mrn}` },
    encounter: { reference: `Encounter/enc-${mrn}` },
    authoredOn: m.created_at ?? undefined,
    requester: m.ordering_physician || m.ordered_by ? { display: m.ordering_physician ?? m.ordered_by ?? "" } : undefined,
    dosageInstruction: m.route
      ? [{ route: { text: m.route }, text: `${m.dose ?? ""} ${m.route}`.trim() }]
      : undefined,
  };
}

function medAdministration(mrn: string, m: EncounterMed) {
  const drug = m.drug_name ?? m.drug ?? m.medication_name ?? "medication";
  return {
    resourceType: "MedicationAdministration",
    id: stableIds.medAdmin(`${drug}${m.dose ? `-${m.dose}` : ""}`, mrn),
    status: "completed",
    medicationCodeableConcept: { text: `${drug}${m.dose ? ` ${m.dose}` : ""}` },
    subject: { reference: `Patient/${mrn}` },
    context: { reference: `Encounter/enc-${mrn}` },
    effectiveDateTime: m.administered_at ?? undefined,
    performer: m.ordering_physician || m.ordered_by
      ? [{ actor: { display: m.ordering_physician ?? m.ordered_by ?? "" } }]
      : undefined,
  };
}

function docReference(mrn: string, n: EncounterNote) {
  return {
    resourceType: "DocumentReference",
    id: stableIds.docRef(mrn),
    status: "current",
    type: { text: n.note_type ?? "Clinical note" },
    subject: { reference: `Patient/${mrn}` },
    context: { encounter: [{ reference: `Encounter/enc-${mrn}` }] },
    date: n.created_at ?? undefined,
    author: n.author ? [{ display: n.author }] : undefined,
    content: [
      {
        attachment: {
          contentType: "text/plain",
          data:
            typeof globalThis.btoa === "function"
              ? globalThis.btoa(unescape(encodeURIComponent(n.content ?? "")))
              : undefined,
          title: n.note_type ?? "Clinical note",
        },
      },
    ],
  };
}

function carePlanFromDischarge(p: EncounterPatient) {
  if (!p.discharge_summary && !p.diagnosis) return null;
  return {
    resourceType: "CarePlan",
    id: stableIds.carePlan(p.mrn),
    status: p.discharge_time ? "completed" : "active",
    intent: "plan",
    title: "Discharge instructions & follow-up",
    subject: { reference: `Patient/${p.mrn}` },
    encounter: { reference: `Encounter/enc-${p.mrn}` },
    period: {
      start: p.admission_time ?? undefined,
      end: p.discharge_time ?? undefined,
    },
    description: p.discharge_summary ?? p.diagnosis ?? undefined,
  };
}

function followUpAppointment(p: EncounterPatient) {
  if (!p.discharge_time) return null;
  const start = new Date(p.discharge_time);
  if (Number.isNaN(start.getTime())) return null;
  start.setDate(start.getDate() + 14);
  return {
    resourceType: "Appointment",
    id: stableIds.appointment(p.mrn),
    status: "proposed",
    description: "Post-discharge follow-up / recall",
    start: start.toISOString(),
    participant: [
      { actor: { reference: `Patient/${p.mrn}` }, status: "needs-action" },
    ],
  };
}

/**
 * Build the encounter-level Condition resources. The admitting working
 * diagnosis (chief complaint at intake) is recorded as `provisional`. On
 * discharge the final working diagnosis is recorded as a separate
 * `confirmed` Condition so the discharge diagnosis is preserved alongside
 * — not in place of — the admitting provisional diagnosis.
 */
function encounterConditions(p: EncounterPatient): any[] {
  const out: any[] = [];
  const subject = { reference: `Patient/${p.mrn}` };
  const encounter = { reference: `Encounter/enc-${p.mrn}` };
  const category = [
    {
      coding: [
        {
          system: "http://terminology.hl7.org/CodeSystem/condition-category",
          code: "encounter-diagnosis",
          display: "Encounter Diagnosis",
        },
      ],
    },
  ];
  const clinicalActive = {
    coding: [
      {
        system: "http://terminology.hl7.org/CodeSystem/condition-clinical",
        code: "active",
      },
    ],
  };
  const verif = (code: "provisional" | "confirmed") => ({
    coding: [
      {
        system: "http://terminology.hl7.org/CodeSystem/condition-ver-status",
        code,
      },
    ],
  });
  if (p.chief_complaint) {
    out.push({
      resourceType: "Condition",
      id: stableIds.condition("hpi", p.mrn),
      clinicalStatus: clinicalActive,
      verificationStatus: verif("provisional"),
      category,
      code: { text: p.chief_complaint },
      subject,
      encounter,
      recordedDate: p.admission_time ?? undefined,
    });
  }
  if (p.discharge_time && p.diagnosis) {
    out.push({
      resourceType: "Condition",
      id: stableIds.condition("discharge", p.mrn),
      clinicalStatus: clinicalActive,
      verificationStatus: verif("confirmed"),
      category,
      code: { text: p.diagnosis },
      subject,
      encounter,
      recordedDate: p.discharge_time ?? undefined,
    });
  }
  return out;
}

export function buildEncounterBundle(opts: {
  patient: EncounterPatient;
  labs?: EncounterLab[];
  meds?: EncounterMed[];
  notes?: EncounterNote[];
}) {
  const { patient } = opts;
  const patientRes = fullPatient(patient);
  const encounterRes = buildEncounterResource(patient);
  const vitals = vitalsObservations(patient);
  const conditions = encounterConditions(patient);
  // Lab collapse: keep the latest event per test slug. This prevents
  // HAPI-0534 "Transaction bundle contains multiple resources with ID"
  // when a patient has both an ordered (registered) and resulted (final)
  // observation for the same test (e.g. creatinine, hemoglobin).
  const labTime = (l: EncounterLab) =>
    new Date(l.collected_at ?? l.created_at ?? 0).getTime() || 0;
  const labsByTest = new Map<string, EncounterLab>();
  for (const l of opts.labs ?? []) {
    const slug = slugify(l.test_type ?? l.id ?? "unknown");
    const prev = labsByTest.get(slug);
    if (!prev) {
      labsByTest.set(slug, l);
      continue;
    }
    const prevHasResult = !!prev.result_value;
    const curHasResult = !!l.result_value;
    if (curHasResult && !prevHasResult) labsByTest.set(slug, l);
    else if (curHasResult === prevHasResult && labTime(l) > labTime(prev))
      labsByTest.set(slug, l);
  }
  const labs = safeMap(
    Array.from(labsByTest.values()),
    (l) => labObservation(patient.mrn, l),
    "lab",
    patient.mrn,
  );

  // Meds collapse: keep latest per stable id for both requests and admins.
  const medTime = (m: EncounterMed) =>
    new Date(m.administered_at ?? m.approved_at ?? m.created_at ?? 0).getTime() || 0;
  const reqByKey = new Map<string, EncounterMed>();
  for (const m of opts.meds ?? []) {
    const drug = m.drug_name ?? m.drug ?? m.medication_name ?? "medication";
    const key = slugify(`${drug}${m.dose ? `-${m.dose}` : ""}`);
    const prev = reqByKey.get(key);
    if (!prev || medTime(m) > medTime(prev)) reqByKey.set(key, m);
  }
  const medReqs = safeMap(
    Array.from(reqByKey.values()),
    (m) => medRequest(patient.mrn, m),
    "medication request",
    patient.mrn,
  );
  const admByKey = new Map<string, EncounterMed>();
  for (const m of opts.meds ?? []) {
    if (!m.administered_at) continue;
    const drug = m.drug_name ?? m.drug ?? m.medication_name ?? "medication";
    const key = slugify(`${drug}${m.dose ? `-${m.dose}` : ""}`);
    const prev = admByKey.get(key);
    if (!prev || medTime(m) > medTime(prev)) admByKey.set(key, m);
  }
  const medAdms = safeMap(
    Array.from(admByKey.values()),
    (m) => medAdministration(patient.mrn, m),
    "medication administration",
    patient.mrn,
  );
  const docs = safeMap(
    opts.notes ?? [],
    (n) => docReference(patient.mrn, n),
    "clinical note",
    patient.mrn,
  );
  const carePlan = carePlanFromDischarge(patient);
  const appt = followUpAppointment(patient);

  const composition = {
    resourceType: "Composition",
    id: stableIds.composition(patient.mrn),
    status: "final",
    type: {
      coding: [
        { system: "http://loinc.org", code: "34133-9", display: "Summary of episode note" },
      ],
      text: "S.P.E.H.R Encounter Summary",
    },
    subject: { reference: `Patient/${patient.mrn}` },
    encounter: { reference: `Encounter/enc-${patient.mrn}` },
    date: new Date().toISOString(),
    author: [{ display: "S.P.E.H.R AI Coding Engine" }],
    title: `Encounter summary — ${patient.name ?? patient.mrn}`,
    section: [
      { title: "Encounter", entry: [{ reference: `Encounter/enc-${patient.mrn}` }] },
      { title: "Diagnoses", entry: conditions.map((c: any) => ({ reference: `Condition/${c.id}` })) },
      { title: "Vital Signs", entry: vitals.map((o) => ({ reference: `Observation/${o.id}` })) },
      { title: "Laboratory", entry: labs.map((o) => ({ reference: `Observation/${o.id}` })) },
      { title: "Medication Orders", entry: medReqs.map((m) => ({ reference: `MedicationRequest/${m.id}` })) },
      { title: "Medication Administrations", entry: medAdms.map((m) => ({ reference: `MedicationAdministration/${m.id}` })) },
      { title: "Clinical Notes", entry: docs.map((d) => ({ reference: `DocumentReference/${d.id}` })) },
      ...(carePlan ? [{ title: "Care Plan", entry: [{ reference: `CarePlan/${carePlan.id}` }] }] : []),
      ...(appt ? [{ title: "Follow-up", entry: [{ reference: `Appointment/${appt.id}` }] }] : []),
    ],
  };

  // Every resource is PUT with its deterministic stable ID. This is the
  // FHIR UPSERT contract: the same clinical fact always maps to the same
  // resource id, so re-pushing can never create duplicates.
  const requestFor = (r: any): { method: string; url: string } => ({
    method: "PUT",
    url: `${r.resourceType}/${r.id}`,
  });

  const all: any[] = [
    composition,
    patientRes,
    encounterRes,
    ...conditions,
    ...vitals,
    ...labs,
    ...medReqs,
    ...medAdms,
    ...docs,
    ...(carePlan ? [carePlan] : []),
    ...(appt ? [appt] : []),
  ];

  // Final safety net: deduplicate by stable id so a single transaction
  // bundle never contains two entries that resolve to the same client
  // assigned id. Keeps the latest by effectiveDateTime / authoredOn /
  // meta.lastUpdated when a collision slips through earlier collapses.
  const seen = new Map<string, any>();
  for (const r of all) {
    const key = `${r.resourceType}/${r.id}`;
    const prev = seen.get(key);
    if (!prev) {
      seen.set(key, r);
      continue;
    }
    if (getResourceTimestamp(r) >= getResourceTimestamp(prev)) seen.set(key, r);
  }
  const deduped = Array.from(seen.values());

  return {
    resourceType: "Bundle",
    id: `encounter-${patient.mrn}-${Date.now()}`,
    type: "transaction",
    timestamp: new Date().toISOString(),
    // For client-assigned PUT upserts, fullUrl must be the absolute
    // resource path (ResourceType/id) so HAPI matches it against the
    // request.url and performs an UPSERT instead of a create-with-id.
    entry: deduped.map((r) => ({
      fullUrl: `${r.resourceType}/${r.id}`,
      resource: r,
      request: requestFor(r),
    })),
  };
}

function getResourceTimestamp(resource: any): number {
  if (!resource) return 0;
  return _getResourceTimestamp(resource);
}

function _getResourceTimestamp(resource: any): number {
  if (!resource) return 0;
  if (resource.effectiveDateTime)
    return new Date(resource.effectiveDateTime).getTime() || 0;
  if (resource.authoredOn)
    return new Date(resource.authoredOn).getTime() || 0;
  if (resource.period?.end)
    return new Date(resource.period.end).getTime() || 0;
  if (resource.period?.start)
    return new Date(resource.period.start).getTime() || 0;
  if (resource.date) return new Date(resource.date).getTime() || 0;
  if (resource.meta?.lastUpdated)
    return new Date(resource.meta.lastUpdated).getTime() || 0;
  return 0;
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

/**
 * Split an encounter bundle into a primary bundle (everything except the
 * Composition) and a composition-only bundle. On discharge the sync engine
 * pushes the primary bundle first, then re-PUTs the Composition so its
 * section references point at resources that have already been persisted
 * on the FHIR server (no dangling references on a partial transaction).
 */
export function splitEncounterBundle(bundle: any): {
  primary: any;
  composition: any | null;
} {
  const entries: any[] = Array.isArray(bundle?.entry) ? bundle.entry : [];
  const compEntry = entries.find(
    (e) => e?.resource?.resourceType === "Composition",
  );
  const rest = entries.filter(
    (e) => e?.resource?.resourceType !== "Composition",
  );
  return {
    primary: { ...bundle, entry: rest },
    composition: compEntry
      ? {
          resourceType: "Bundle",
          id: `composition-${bundle?.id ?? Date.now()}`,
          type: "transaction",
          timestamp: new Date().toISOString(),
          entry: [compEntry],
        }
      : null,
  };
}