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

/**
 * Fixes #3 / #4: distill a free-text chief complaint into a clinically
 * search-worthy phrase before sending to UMLS. Strips duration, onset and
 * timing fragments ("for 4 days", "since yesterday", "this morning",
 * "x 3 days", "started 2 hours ago"), leaving the working-diagnosis core
 * (e.g. "Productive cough and shortness of breath"). The result is used
 * as BOTH the UMLS search string and Condition.code.text so the two
 * always agree.
 */
export function distillClinicalText(raw: string | null | undefined): string {
  const src = (raw ?? "").trim();
  if (!src) return "";
  let s = ` ${src} `;
  const patterns: RegExp[] = [
    /\bfor\s+(?:the\s+)?(?:past\s+)?\d+\s*(?:day|days|week|weeks|hour|hours|hr|hrs|month|months|year|years)\b/gi,
    /\bsince\s+(?:yesterday|last\s+\w+|this\s+morning|this\s+afternoon|this\s+evening|last\s+night|\d+\s*(?:day|days|week|weeks|hour|hours|hr|hrs)\s+ago)\b/gi,
    /\bthis\s+(?:morning|afternoon|evening)\b/gi,
    /\blast\s+night\b/gi,
    /\b(?:yesterday|today|tonight)\b/gi,
    /\bx\s*\d+\s*(?:d|day|days|h|hr|hrs|hour|hours|w|wk|week|weeks)\b/gi,
    /\bover\s+the\s+(?:past|last)\s+\w+\s+\w+\b/gi,
    /\b(?:past|last)\s+\d+\s*(?:day|days|week|weeks|hour|hours|hr|hrs)\b/gi,
    /\b\d+\s*(?:day|days|week|weeks|hour|hours|hr|hrs|month|months)\s+ago\b/gi,
    /\b(?:onset|started|began|beginning|noticed)\s+\w+(?:\s+\w+){0,3}\b/gi,
    /\bgradual(?:ly)?\s+(?:worsening|onset)\b/gi,
    /\bsudden(?:ly)?\s+onset\b/gi,
  ];
  for (const re of patterns) s = s.replace(re, " ");
  return s
    .replace(/[,;]\s*(?:and|with)?\s*\./g, ".")
    .replace(/\s+/g, " ")
    .replace(/\s*([,.;:])\s*/g, "$1 ")
    .replace(/^\s*[,.;:]+\s*/, "")
    .replace(/\s*[,.;:]+\s*$/, "")
    .trim();
}

/**
 * Defensive per-entry builder. If a single resource throws (malformed
 * manual order, missing required field, etc.) it is logged and skipped
 * so the rest of the bundle still ships. Bug-4 safety net.
 */
function safeMap<T>(
  items: T[],
  build: (item: T) => any,
  kind: string,
  mrn: string,
): any[] {
  const out: any[] = [];
  for (const item of items) {
    try {
      out.push(build(item));
    } catch (e) {
      console.warn(
        `[fhir-bundle] skipping malformed ${kind} for ${mrn}:`,
        item,
        e,
      );
    }
  }
  return out;
}

export const stableIds = {
  patient: (mrn: string) => mrn,
  encounter: (mrn: string) => `enc-${mrn}`,
  relatedPerson: (mrn: string) => `relp-${mrn}-econ`,
  vital: (loinc: string, mrn: string) => `vital-${loinc}-${mrn}`,
  // FHIR R4 IDs must match [A-Za-z0-9\-\.]{1,64}. Prefer a LOINC code when
  // available (always short, always safe); otherwise fall back to a hard-
  // capped slug of the test name. Never let free-text LOINC display names
  // produce IDs > 64 chars — HAPI rejects them with HAPI-0521.
  lab: (testName: string, mrn: string, loincCode?: string | null) => {
    if (loincCode) {
      const code = String(loincCode).replace(/[^A-Za-z0-9\-\.]/g, "").slice(0, 40);
      if (code) return `lab-${code}-${mrn}`;
    }
    const slug = (testName ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .substring(0, 40) || "unknown";
    return `lab-${slug}-${mrn}`;
  },
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

/* ------------------------------------------------------------------ */
/*  Billing + real Appointment resource builders (Part A push)         */
/*                                                                     */
/*  Every resource is tagged `urn:spehr:source|spehr` so the reverse    */
/*  Subscription (`_tag=urn:spehr:source|myspehr`) will NOT loop them   */
/*  back into our inbound webhook.                                     */
/* ------------------------------------------------------------------ */

export const SPEHR_SOURCE_TAG = {
  system: "urn:spehr:source",
  code: "spehr",
} as const;

function withSpehrSource<T extends Record<string, any>>(resource: T): T {
  const existingTags: any[] = Array.isArray(resource?.meta?.tag) ? resource.meta.tag : [];
  const hasSpehr = existingTags.some(
    (t) => t?.system === SPEHR_SOURCE_TAG.system && t?.code === SPEHR_SOURCE_TAG.code,
  );
  return {
    ...resource,
    meta: {
      ...(resource.meta ?? {}),
      tag: hasSpehr ? existingTags : [...existingTags, { ...SPEHR_SOURCE_TAG }],
    },
  };
}

function fhirSafeId(input: string): string {
  return String(input ?? "")
    .replace(/[^A-Za-z0-9\-\.]/g, "-")
    .slice(0, 64) || "unknown";
}

export type InvoiceRow = {
  id: string;
  invoice_no: string;
  mrn: string;
  patient_name?: string | null;
  facility_name?: string | null;
  status?: string | null;
  subtotal?: number | string | null;
  tax?: number | string | null;
  total?: number | string | null;
  currency?: string | null;
  issued_at?: string | null;
  paid_at?: string | null;
};

export function buildInvoiceResource(row: InvoiceRow) {
  const status =
    (row.status ?? "").toLowerCase() === "balanced" ? "balanced" : "issued";
  const currency = row.currency ?? "USD";
  const subtotal = Number(row.subtotal ?? 0);
  const total = Number(row.total ?? subtotal);
  return withSpehrSource({
    resourceType: "Invoice",
    id: fhirSafeId(row.invoice_no),
    identifier: [
      { system: "urn:spehr:invoice-no", value: row.invoice_no },
      { system: "urn:spehr:invoice-uuid", value: row.id },
    ],
    status,
    subject: { reference: `Patient/${row.mrn}` },
    recipient: { reference: `Patient/${row.mrn}` },
    date: row.issued_at ?? undefined,
    issuer: row.facility_name ? { display: row.facility_name } : undefined,
    totalNet: { value: subtotal, currency },
    totalGross: { value: total, currency },
    paymentTerms:
      status === "balanced" && row.paid_at
        ? `Paid ${row.paid_at}`
        : undefined,
  });
}

export type ChargeItemRow = {
  id: string;
  invoice_id: string;
  mrn: string;
  charge_code: string;
  code_system?: string | null;
  description: string;
  category?: string | null;
  quantity?: number | string | null;
  unit_price?: number | string | null;
  amount?: number | string | null;
  currency?: string | null;
  service_date?: string | null;
};

export function buildChargeItemResource(
  row: ChargeItemRow,
  invoiceNo?: string | null,
) {
  const currency = row.currency ?? "USD";
  const quantity = Number(row.quantity ?? 1);
  const unitPrice = Number(row.unit_price ?? 0);
  const amount = Number(row.amount ?? unitPrice * quantity);
  const codeSystem =
    row.code_system && row.code_system !== "internal"
      ? row.code_system
      : "urn:spehr:charge-code";
  return withSpehrSource({
    resourceType: "ChargeItem",
    id: fhirSafeId(`charge-${row.id}`),
    identifier: [{ system: "urn:spehr:charge-uuid", value: row.id }],
    status: "billable",
    code: {
      coding: [
        { system: codeSystem, code: row.charge_code, display: row.description },
      ],
      text: row.description,
    },
    subject: { reference: `Patient/${row.mrn}` },
    // FHIR R4: ChargeItem.context is Encounter|EpisodeOfCare only. Link
    // to the Invoice via supportingInformation instead (HAPI-0931).
    supportingInformation: invoiceNo
      ? [{ reference: `Invoice/${fhirSafeId(invoiceNo)}` }]
      : undefined,
    occurrenceDateTime: row.service_date ?? undefined,
    quantity: { value: quantity },
    priceOverride: { value: unitPrice, currency },
    totalPriceComponent: {
      type: "base",
      amount: { value: amount, currency },
    },
    extension: [
      {
        url: "urn:spehr:charge-category",
        valueString: row.category ?? "uncategorized",
      },
      ...(row.invoice_id
        ? [
            {
              url: "urn:spehr:invoice-uuid",
              valueString: row.invoice_id,
            },
          ]
        : []),
    ],
  });
}

export type AppointmentRow = {
  id: string;
  facility_name?: string | null;
  patient_mrn?: string | null;
  patient_name?: string | null;
  practitioner_name?: string | null;
  service_type?: string | null;
  description?: string | null;
  start_time: string;
  end_time: string;
  status?: string | null;
  comment?: string | null;
};

export function buildRealAppointmentResource(row: AppointmentRow) {
  const status = (row.status ?? "booked").toLowerCase();
  const participants: any[] = [];
  if (row.patient_mrn) {
    participants.push({
      actor: {
        reference: `Patient/${row.patient_mrn}`,
        display: row.patient_name ?? undefined,
      },
      status: "accepted",
    });
  }
  if (row.practitioner_name) {
    participants.push({
      actor: { display: row.practitioner_name },
      status: "accepted",
    });
  }
  return withSpehrSource({
    resourceType: "Appointment",
    id: fhirSafeId(`appt-${row.id}`),
    identifier: [{ system: "urn:spehr:appointment-uuid", value: row.id }],
    status,
    description: row.description ?? row.service_type ?? undefined,
    comment: row.comment ?? undefined,
    start: row.start_time,
    end: row.end_time,
    serviceType: row.service_type
      ? [{ text: row.service_type }]
      : undefined,
    participant:
      participants.length > 0
        ? participants
        : [{ status: "needs-action", actor: { display: "Unknown" } }],
    ...(row.facility_name
      ? { location: [{ display: row.facility_name }] }
      : {}),
  });
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
  past_medical_history?: string | null;
};


export type EncounterLab = {
  id?: string;
  test_type?: string | null;
  result_value?: string | null;
  status?: string | null;
  collected_at?: string | null;
  created_at?: string | null;
  loinc_code?: string | null;
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
  rxnorm_code?: string | null;
  rxnorm_display?: string | null;
};

export type EncounterNote = {
  id?: string;
  note_type?: string | null;
  author?: string | null;
  content?: string | null;
  created_at?: string | null;
};

export type EncounterCondition = {
  display_text?: string | null;
  snomed_code?: string | null;
  snomed_display?: string | null;
  icd10_code?: string | null;
  icd10_display?: string | null;
  verification_status?: string | null;
  clinical_status?: string | null;
  recorded_date?: string | null;
  coded_at?: string | null;
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

// Common LOINC codes for in-app lab tests. Lets us emit short stable IDs
// (`lab-{loinc}-{mrn}`) and a proper code.coding even when the upstream
// row didn't carry a loinc_code column.
const LAB_LOINC_BY_NAME: Record<string, string> = {
  "hemoglobin": "718-7",
  "hgb": "718-7",
  "wbc": "6690-2",
  "white blood cell count": "6690-2",
  "glucose": "2345-7",
  "creatinine": "2160-0",
  "troponin t": "89579-7",
  "troponin t hs": "89579-7",
  "high sensitivity troponin t": "89579-7",
  "creatine kinase": "2157-6",
  "ck": "2157-6",
};
function loincForLabName(name: string | null | undefined): string | null {
  if (!name) return null;
  const n = name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  if (LAB_LOINC_BY_NAME[n]) return LAB_LOINC_BY_NAME[n];
  for (const k of Object.keys(LAB_LOINC_BY_NAME)) {
    if (n.includes(k)) return LAB_LOINC_BY_NAME[k];
  }
  return null;
}

/**
 * Block hallucinated lab entries from reaching the FHIR bundle. A real
 * ordered lab always has either a short clinical name or an explicit LOINC
 * code; sprawling 60+ char names like "Conditions related to mental
 * retardation and developmental..." originate from the NLP pipeline and
 * have no business in the patient's record.
 */
function isPlausibleLab(l: EncounterLab): boolean {
  const loinc = l.loinc_code ?? loincForLabName(l.test_type);
  if (loinc) return true;
  const name = (l.test_type ?? "").trim();
  return name.length > 0 && name.length <= 40;
}

function labObservation(mrn: string, l: EncounterLab) {
  const loinc = l.loinc_code ?? loincForLabName(l.test_type);
  const id = stableIds.lab(l.test_type ?? l.id ?? "unknown", mrn, loinc);
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
    code: loinc
      ? {
          coding: [{ system: "http://loinc.org", code: loinc, display: l.test_type ?? undefined }],
          text: l.test_type ?? "Lab",
        }
      : { text: l.test_type ?? "Lab" },
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
  // FHIR R4 mandates a coding array for machine-readable interoperability.
  // Use the RxNorm code emitted by AUTO API when available; fall back to
  // text-only when AUTO API hasn't (yet) resolved this drug.
  const medCC = m.rxnorm_code
    ? {
        coding: [
          {
            system: FHIR_SYSTEM_URI.RxNorm,
            code: m.rxnorm_code,
            display: m.rxnorm_display ?? drug,
          },
        ],
        text: `${drug}${m.dose ? ` ${m.dose}` : ""}`,
      }
    : { text: `${drug}${m.dose ? ` ${m.dose}` : ""}` };
  return {
    resourceType: "MedicationRequest",
    id: stableIds.medRequest(`${drug}${m.dose ? `-${m.dose}` : ""}`, mrn),
    status,
    intent: "order",
    medicationCodeableConcept: medCC,
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
  const medCC = m.rxnorm_code
    ? {
        coding: [
          {
            system: FHIR_SYSTEM_URI.RxNorm,
            code: m.rxnorm_code,
            display: m.rxnorm_display ?? drug,
          },
        ],
        text: `${drug}${m.dose ? ` ${m.dose}` : ""}`,
      }
    : { text: `${drug}${m.dose ? ` ${m.dose}` : ""}` };
  return {
    resourceType: "MedicationAdministration",
    id: stableIds.medAdmin(`${drug}${m.dose ? `-${m.dose}` : ""}`, mrn),
    status: "completed",
    medicationCodeableConcept: medCC,
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
function encounterConditions(
  p: EncounterPatient,
  coded: EncounterCondition[] = [],
): any[] {
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
  // Find the best AUTO API-coded condition for the working diagnosis (HPI).
  const primaryCoded = coded.find(
    (c) => c.snomed_code || c.icd10_code,
  );
  if (p.chief_complaint) {
    const codingArr: Array<{ system: string; code: string; display: string }> = [];
    // Fix #3: distill the verbatim chief-complaint free text into a
    // search-worthy working diagnosis before any UMLS lookup. The
    // distilled string is also written to code.text so the resource's
    // textual label and the UMLS search input are guaranteed identical.
    const hpiText = distillClinicalText(p.chief_complaint) || p.chief_complaint;
    if (primaryCoded?.snomed_code)
      codingArr.push({
        system: FHIR_SYSTEM_URI["SNOMED CT"],
        code: primaryCoded.snomed_code,
        display: primaryCoded.snomed_display ?? hpiText,
      });
    if (primaryCoded?.icd10_code)
      codingArr.push({
        system: FHIR_SYSTEM_URI["ICD-10"],
        code: primaryCoded.icd10_code,
        display: primaryCoded.icd10_display ?? hpiText,
      });
    out.push({
      resourceType: "Condition",
      id: stableIds.condition("hpi", p.mrn),
      clinicalStatus: clinicalActive,
      verificationStatus: verif("provisional"),
      category,
      code:
        codingArr.length > 0
          ? { coding: codingArr, text: hpiText }
          : { text: hpiText },
      subject,
      encounter,
      recordedDate: p.admission_time ?? undefined,
    });
  }
  if (p.discharge_time && p.diagnosis) {
    // Fix #4: discharge Condition.code.text MUST be the discharge
    // diagnosis itself (e.g. "Community-Acquired Pneumonia"), never the
    // chief complaint. The text below is exactly what the async builder
    // will resend to UMLS for ICD-10 + SNOMED resolution.
    const dxText = (p.diagnosis ?? "").trim();
    // Discharge diagnosis: prefer a coded condition that matches the
    // discharge text, otherwise reuse the primary coded one.
    const dischargeCoded =
      coded.find(
        (c) =>
          c.display_text &&
          p.diagnosis &&
          c.display_text.toLowerCase().includes(p.diagnosis.toLowerCase().slice(0, 12)),
      ) ?? primaryCoded;
    const codingArr: Array<{ system: string; code: string; display: string }> = [];
    if (dischargeCoded?.snomed_code)
      codingArr.push({
        system: FHIR_SYSTEM_URI["SNOMED CT"],
        code: dischargeCoded.snomed_code,
        display: dischargeCoded.snomed_display ?? dxText,
      });
    if (dischargeCoded?.icd10_code)
      codingArr.push({
        system: FHIR_SYSTEM_URI["ICD-10"],
        code: dischargeCoded.icd10_code,
        display: dischargeCoded.icd10_display ?? dxText,
      });
    out.push({
      resourceType: "Condition",
      id: stableIds.condition("discharge", p.mrn),
      clinicalStatus: clinicalActive,
      verificationStatus: verif("confirmed"),
      category,
      code:
        codingArr.length > 0
          ? { coding: codingArr, text: dxText }
          : { text: dxText },
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
  conditions?: EncounterCondition[];
}) {
  const { patient } = opts;
  const patientRes = fullPatient(patient);
  const encounterRes = buildEncounterResource(patient);
  const vitals = vitalsObservations(patient);
  const conditions = encounterConditions(patient, opts.conditions ?? []);
  // Lab collapse: keep the latest event per test slug. This prevents
  // HAPI-0534 "Transaction bundle contains multiple resources with ID"
  // when a patient has both an ordered (registered) and resulted (final)
  // observation for the same test (e.g. creatinine, hemoglobin).
  const labTime = (l: EncounterLab) =>
    new Date(l.collected_at ?? l.created_at ?? 0).getTime() || 0;
  const labsByTest = new Map<string, EncounterLab>();
  for (const l of opts.labs ?? []) {
    if (!isPlausibleLab(l)) {
      console.warn(
        `[fhir-bundle] dropping implausible lab for ${patient.mrn}: ${l.test_type}`,
      );
      continue;
    }
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

  // Fix #9: discharged encounters get the dedicated Discharge Summary
  // Composition (LOINC 18842-5) under a stable id of
  // `composition-{MRN}-discharge`. In-progress encounters keep the
  // legacy `summary-{MRN}` id with LOINC 34133-9 so admission-time
  // pushes remain backwards compatible with the rest of the pipeline.
  const isDischarged =
    (patient.status ?? "").toLowerCase() === "discharged" ||
    !!patient.discharge_time;
  const compositionId = isDischarged
    ? `composition-${patient.mrn}-discharge`
    : stableIds.composition(patient.mrn);
  const compositionTypeCoding = isDischarged
    ? { system: "http://loinc.org", code: "18842-5", display: "Discharge summary" }
    : { system: "http://loinc.org", code: "34133-9", display: "Summary of episode note" };
  const compositionTitle = isDischarged
    ? `Discharge summary — ${patient.name ?? patient.mrn}`
    : `Encounter summary — ${patient.name ?? patient.mrn}`;

  const composition = {
    resourceType: "Composition",
    id: compositionId,
    status: "final",
    type: {
      coding: [compositionTypeCoding],
      text: isDischarged ? "Discharge Summary" : "S.P.E.H.R Encounter Summary",
    },
    subject: { reference: `Patient/${patient.mrn}` },
    encounter: { reference: `Encounter/enc-${patient.mrn}` },
    date: new Date().toISOString(),
    author: [{ display: "S.P.E.H.R AI Coding Engine" }],
    title: compositionTitle,
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

/**
 * FHIR Data-Quality self-test. Walks an encounter bundle and confirms the
 * minimum required machine-readable codes are present: the primary
 * diagnosis must carry a SNOMED CT or ICD-10 coding, and every active
 * MedicationRequest must carry an RxNorm coding. Returns a structured
 * verdict the sync banner uses to flag "Degraded / Incomplete".
 */
export type FhirQuality = {
  ok: boolean;
  missing: string[];
  primaryHasCode: boolean;
  medsTotal: number;
  medsCoded: number;
  labsTotal: number;
  labsCoded: number;
};

export function assessBundleQuality(bundle: any): FhirQuality {
  const entries: any[] = Array.isArray(bundle?.entry) ? bundle.entry : [];
  const conditions = entries
    .map((e) => e?.resource)
    .filter((r) => r?.resourceType === "Condition");
  const meds = entries
    .map((e) => e?.resource)
    .filter(
      (r) =>
        r?.resourceType === "MedicationRequest" &&
        ["active", "completed", "draft"].includes(r.status),
    );
  const labs = entries
    .map((e) => e?.resource)
    .filter(
      (r) =>
        r?.resourceType === "Observation" &&
        Array.isArray(r.category) &&
        r.category.some((c: any) =>
          c?.coding?.some((cc: any) => cc?.code === "laboratory"),
        ),
    );
  const primary = conditions[0];
  const primaryHasCode =
    !!primary?.code?.coding?.length;
  const medsCoded = meds.filter(
    (m) => !!m?.medicationCodeableConcept?.coding?.length,
  ).length;
  const labsCoded = labs.filter((l) => !!l?.code?.coding?.length).length;
  const missing: string[] = [];
  if (conditions.length > 0 && !primaryHasCode) missing.push("primary diagnosis SNOMED/ICD-10");
  if (meds.length > 0 && medsCoded < meds.length) missing.push(`${meds.length - medsCoded} med RxNorm`);
  return {
    ok: missing.length === 0,
    missing,
    primaryHasCode,
    medsTotal: meds.length,
    medsCoded,
    labsTotal: labs.length,
    labsCoded,
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
/* ------------------------------------------------------------------ */
/*  Async, UMLS-coded encounter bundle                                  */
/*                                                                      */
/*  Wraps buildEncounterBundle() then live-resolves any missing coding  */
/*  via the umls-proxy (cache-first) so EVERY Condition,                */
/*  MedicationRequest, MedicationAdministration, Observation (lab) and  */
/*  AllergyIntolerance pushed to the FHIR server carries a populated    */
/*  coding[] sourced from a real UMLS / RxNav call.                     */
/* ------------------------------------------------------------------ */

export type EncounterAllergy = {
  id?: string;
  substance: string;
  reaction?: string | null;
  severity?: string | null;
  category?: "medication" | "environment" | "food" | "biologic" | "unknown" | string | null;
  substance_rxcui?: string | null;
  substance_snomed?: string | null;
  reactions?: Array<{
    manifestation: string;
    meddra_code?: string | null;
    meddra_display?: string | null;
    snomed_code?: string | null;
    snomed_display?: string | null;
  }>;
};

function inferAllergyCategory(
  raw: string | null | undefined,
  substance: string,
): "medication" | "environment" | "food" | "biologic" | "unknown" {
  const c = (raw ?? "").toLowerCase();
  if (c.startsWith("med")) return "medication";
  if (c.startsWith("env")) return "environment";
  if (c.startsWith("food")) return "food";
  if (c.startsWith("biol")) return "biologic";
  // Heuristic on substance name when category is missing.
  const s = (substance ?? "").toLowerCase();
  if (/(penicillin|sulfa|codeine|morphine|cefazolin|aspirin|nsaid|ibuprofen|acetaminophen|amoxicillin)/.test(s))
    return "medication";
  if (/(peanut|nut|shellfish|egg|milk|soy|wheat|gluten)/.test(s)) return "food";
  if (/(latex|iodine|contrast|pollen|bee|dust|mold)/.test(s)) return "environment";
  return "unknown";
}

function parsePmhItems(text: string | null | undefined): string[] {
  if (!text) return [];
  return String(text)
    .split(/[,;]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s.toLowerCase() !== "none" && s.toLowerCase() !== "nkda")
    .slice(0, 20);
}

function escapeHtml(s: string): string {
  return (s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Async UMLS-coded encounter bundle builder. Returns the same structure
 * as buildEncounterBundle but with every clinical resource fully coded
 * via live UMLS / RxNav calls (transparent to the caller, cache-first).
 */
export async function buildEncounterBundleAsync(opts: {
  patient: EncounterPatient;
  labs?: EncounterLab[];
  meds?: EncounterMed[];
  notes?: EncounterNote[];
  conditions?: EncounterCondition[];
  allergies?: EncounterAllergy[];
}): Promise<any> {
  // Lazy import to avoid a circular module load order with umls-client
  // (which imports the supabase client, which only exists in the browser).
  const {
    buildConditionCoding,
    buildMedicationCoding,
    buildAllergySubstanceCoding,
    buildReactionCoding,
    resolveLabUcumUnit,
    UCUM_SYSTEM,
  } = await import("@/lib/fhir-coding");

  const bundle = buildEncounterBundle({
    patient: opts.patient,
    labs: opts.labs,
    meds: opts.meds,
    notes: opts.notes,
    conditions: opts.conditions,
  });
  const entries: any[] = Array.isArray(bundle.entry) ? bundle.entry : [];
  const mrn = opts.patient.mrn;

  /* ---- 1. Conditions: backfill ICD-10 + SNOMED on any coding-less entry */
  await Promise.all(
    entries
      .filter((e) => e.resource?.resourceType === "Condition")
      .map(async (e) => {
        const r = e.resource;
        if (Array.isArray(r.code?.coding) && r.code.coding.length > 0) return;
        const text = r.code?.text ?? "";
        if (!text) return;
        const cc = await buildConditionCoding(text);
        if (cc.coding.length === 0) return;
        r.code = { coding: cc.coding, text };
      }),
  );

  /* ---- 2. PMH problem-list Conditions (each comma-separated item) */
  const pmh = parsePmhItems(opts.patient.past_medical_history ?? null);
  const pmhResources: any[] = [];
  await Promise.all(
    pmh.map(async (item, idx) => {
      const cc = await buildConditionCoding(item);
      const tokenBase = item
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 20);
      const token = `pmh-${tokenBase || String(idx + 1)}`;
      pmhResources.push({
        resourceType: "Condition",
        id: stableIds.condition(token, mrn),
        clinicalStatus: {
          coding: [
            {
              system: "http://terminology.hl7.org/CodeSystem/condition-clinical",
              code: "active",
            },
          ],
        },
        verificationStatus: {
          coding: [
            {
              system: "http://terminology.hl7.org/CodeSystem/condition-ver-status",
              code: "confirmed",
            },
          ],
        },
        category: [
          {
            coding: [
              {
                system: "http://terminology.hl7.org/CodeSystem/condition-category",
                code: "problem-list-item",
                display: "Problem List Item",
              },
            ],
          },
        ],
        code:
          cc.coding.length > 0
            ? { coding: cc.coding, text: item }
            : { text: item },
        subject: { reference: `Patient/${mrn}` },
        recordedDate: opts.patient.admission_time ?? undefined,
      });
    }),
  );

  /* ---- 3. Medications: backfill RxNorm on Request + Administration */
  await Promise.all(
    entries
      .filter(
        (e) =>
          e.resource?.resourceType === "MedicationRequest" ||
          e.resource?.resourceType === "MedicationAdministration",
      )
      .map(async (e) => {
        const r = e.resource;
        const cc = r.medicationCodeableConcept;
        if (Array.isArray(cc?.coding) && cc.coding.length > 0) return;
        const text = cc?.text ?? "";
        if (!text) return;
        const built = await buildMedicationCoding(text);
        if (built.coding.length === 0) return;
        r.medicationCodeableConcept = { coding: built.coding, text };
      }),
  );

  /* ---- 4. Lab observations: ensure code.coding and UCUM units */
  await Promise.all(
    entries
      .filter((e) => {
        const r = e.resource;
        if (r?.resourceType !== "Observation") return false;
        return r.category?.some((c: any) =>
          c?.coding?.some((cc: any) => cc?.code === "laboratory"),
        );
      })
      .map(async (e) => {
        const r = e.resource;
        const text = r.code?.text ?? "";
        // Ensure LOINC coding[]
        if (!Array.isArray(r.code?.coding) || r.code.coding.length === 0) {
          if (text) {
            const { resolveLoinc } = await import("@/lib/umls-client");
            const lo = await resolveLoinc(text);
            if (lo) {
              r.code = {
                coding: [
                  {
                    system: FHIR_SYSTEM_URI.LOINC,
                    code: lo.code,
                    display: lo.display,
                  },
                ],
                text,
              };
            }
          }
        }
        // UCUM unit on valueQuantity
        if (r.valueQuantity && r.valueQuantity.value !== undefined) {
          const haveSystem = !!r.valueQuantity.system;
          if (!haveSystem) {
            const fallback =
              typeof r.valueQuantity.unit === "string"
                ? r.valueQuantity.unit
                : null;
            const unit = await resolveLabUcumUnit(text, fallback);
            if (unit) {
              r.valueQuantity = {
                ...r.valueQuantity,
                unit,
                system: UCUM_SYSTEM,
                code: unit,
              };
            }
          }
        }
      }),
  );

  /* ---- 5. Allergies: build resources + reaction.manifestation MedDRA */
  const allergyResources: any[] = [];
  for (const a of opts.allergies ?? []) {
    if (!a?.substance) continue;
    const category = inferAllergyCategory(a.category, a.substance);
    const substanceCC = await buildAllergySubstanceCoding(a.substance, category);
    const reactionEntries: any[] = [];
    const reactionList =
      a.reactions && a.reactions.length > 0
        ? a.reactions
        : a.reaction
          ? [{ manifestation: a.reaction }]
          : [];
    for (const rx of reactionList) {
      if (!rx?.manifestation) continue;
      const manCC = await buildReactionCoding(rx.manifestation);
      reactionEntries.push({
        manifestation: [
          manCC.coding.length > 0
            ? { coding: manCC.coding, text: rx.manifestation }
            : { text: rx.manifestation },
        ],
        severity:
          (a.severity ?? "").toLowerCase() === "severe"
            ? "severe"
            : (a.severity ?? "").toLowerCase() === "mild"
              ? "mild"
              : "moderate",
      });
    }
    allergyResources.push({
      resourceType: "AllergyIntolerance",
      id: stableIds.allergy(a.substance, mrn),
      clinicalStatus: {
        coding: [
          {
            system: "http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical",
            code: "active",
          },
        ],
      },
      verificationStatus: {
        coding: [
          {
            system: "http://terminology.hl7.org/CodeSystem/allergyintolerance-verification",
            code: "confirmed",
          },
        ],
      },
      type: "allergy",
      category:
        category === "medication"
          ? ["medication"]
          : category === "food"
            ? ["food"]
            : category === "environment"
              ? ["environment"]
              : category === "biologic"
                ? ["biologic"]
                : undefined,
      criticality:
        (a.severity ?? "").toLowerCase() === "severe" ? "high" : "low",
      code:
        substanceCC.coding.length > 0
          ? { coding: substanceCC.coding, text: a.substance }
          : { text: a.substance },
      patient: { reference: `Patient/${mrn}` },
      reaction: reactionEntries.length > 0 ? reactionEntries : undefined,
    });
  }

  /* ---- 6. Append new resources to the bundle (PMH + Allergies) */
  for (const r of [...pmhResources, ...allergyResources]) {
    entries.push({
      fullUrl: `${r.resourceType}/${r.id}`,
      resource: r,
      request: { method: "PUT", url: `${r.resourceType}/${r.id}` },
    });
  }

  /* ---- 7. Composition: ground discharge sections in ACTUAL resources */
  const composition = entries.find(
    (e) => e.resource?.resourceType === "Composition",
  )?.resource;
  if (composition) {
    const labRes = entries
      .map((e) => e.resource)
      .filter(
        (r) =>
          r?.resourceType === "Observation" &&
          r.category?.some((c: any) =>
            c?.coding?.some((cc: any) => cc?.code === "laboratory"),
          ),
      );
    const medReqRes = entries
      .map((e) => e.resource)
      .filter((r) => r?.resourceType === "MedicationRequest");
    const allergyRes = entries
      .map((e) => e.resource)
      .filter((r) => r?.resourceType === "AllergyIntolerance");

    const labRows = labRes.length
      ? labRes
          .map((o: any) => {
            const name = o.code?.text ?? o.code?.coding?.[0]?.display ?? "Lab";
            const v =
              o.valueQuantity?.value !== undefined
                ? `${o.valueQuantity.value}${o.valueQuantity.unit ? " " + o.valueQuantity.unit : ""}`
                : (o.valueString ?? "—");
            return `<p>${escapeHtml(name)}: ${escapeHtml(String(v))}</p>`;
          })
          .join("")
      : "<p>No laboratory observations recorded for this encounter.</p>";
    const medRows = medReqRes.length
      ? medReqRes
          .map((m: any) => {
            const name = m.medicationCodeableConcept?.text ?? "Medication";
            const route =
              m.dosageInstruction?.[0]?.route?.text ?? "";
            return `<p>${escapeHtml(name)}${route ? " — " + escapeHtml(route) : ""}</p>`;
          })
          .join("")
      : "<p>No discharge medications prescribed for this encounter.</p>";
    const allergyRows = allergyRes.length
      ? allergyRes
          .map((a: any) => {
            const s = a.code?.text ?? "Substance";
            const reactions = (a.reaction ?? [])
              .map(
                (r: any) =>
                  r.manifestation?.[0]?.text ??
                  r.manifestation?.[0]?.coding?.[0]?.display ??
                  "reaction",
              )
              .join(", ");
            return `<p>${escapeHtml(s)}${reactions ? " — " + escapeHtml(reactions) : ""}</p>`;
          })
          .join("")
      : "<p>No known allergies recorded for this encounter.</p>";

    const sections: any[] = Array.isArray(composition.section)
      ? composition.section
      : [];
    const setSectionText = (title: string, html: string) => {
      const sec = sections.find((s) => s.title === title);
      const text = {
        status: "generated",
        div: `<div xmlns="http://www.w3.org/1999/xhtml">${html}</div>`,
      };
      if (sec) sec.text = text;
      else sections.push({ title, text });
    };
    setSectionText("Pertinent Laboratory Findings", labRows);
    setSectionText("Discharge Medications", medRows);
    setSectionText("Allergies", allergyRows);
    composition.section = sections;
  }

  /* ---- 8. CarePlan: regenerate description grounded in actuals only */
  const carePlan = entries.find(
    (e) => e.resource?.resourceType === "CarePlan",
  )?.resource;
  if (carePlan) {
    const medNames = entries
      .map((e) => e.resource)
      .filter((r) => r?.resourceType === "MedicationRequest")
      .map((m) => m.medicationCodeableConcept?.text)
      .filter(Boolean) as string[];
    const labNames = entries
      .map((e) => e.resource)
      .filter(
        (r) =>
          r?.resourceType === "Observation" &&
          r.category?.some((c: any) =>
            c?.coding?.some((cc: any) => cc?.code === "laboratory"),
          ),
      )
      .map((o) => o.code?.text)
      .filter(Boolean) as string[];
    const dxRes = entries
      .map((e) => e.resource)
      .find(
        (r) =>
          r?.resourceType === "Condition" &&
          r.verificationStatus?.coding?.[0]?.code === "confirmed",
      );
    const dxText = dxRes?.code?.text ?? opts.patient.diagnosis ?? null;
    const summaryParts: string[] = [];
    if (dxText) summaryParts.push(`Discharge diagnosis: ${dxText}.`);
    summaryParts.push(
      medNames.length > 0
        ? `Medications administered/prescribed this encounter: ${medNames.join(", ")}.`
        : "No medications administered or prescribed during this encounter.",
    );
    summaryParts.push(
      labNames.length > 0
        ? `Laboratory tests collected: ${labNames.join(", ")}.`
        : "No laboratory tests collected during this encounter.",
    );
    summaryParts.push(
      "Follow-up appointment scheduled per Appointment resource. Discharge instructions provided.",
    );
    carePlan.description = summaryParts.join(" ");
  }

  /* ---- 9. Re-dedupe (PMH / allergies may collide with prior pushes) */
  const seen = new Map<string, any>();
  for (const e of entries) {
    const r = e.resource;
    const key = `${r.resourceType}/${r.id}`;
    seen.set(key, e); // last write wins (newer enrichment)
  }
  bundle.entry = Array.from(seen.values());
  return bundle;
}
