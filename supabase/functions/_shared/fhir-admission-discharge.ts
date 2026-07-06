/**
 * Comprehensive FHIR R4 mapping for Auto Doc.
 *
 * Phase 1 — `buildAdmissionTransactionBundle`: Maps the full Admission Case
 * History (demographics, emergency contact, insurance, code status, CC/HPI,
 * PMH/PSH, allergies, current meds, family history) into a transaction
 * Bundle of Patient, RelatedPerson, Coverage, Consent, Encounter, Condition,
 * AllergyIntolerance, MedicationStatement, and FamilyMemberHistory.
 *
 * Phase 2 — `buildDischargeTransactionBundle`: Generates a LOINC 18842-5
 * Discharge Summary Composition that references the patient's Observations
 * (labs), MedicationRequests (discharge meds), Encounter, and includes
 * narrative sections for HPI, PMH, exam, hospital course, procedures,
 * discharge instructions, follow-up and return precautions.
 *
 * Both bundles are FHIR R4 `transaction` Bundles ready to POST to the
 * Medblocks FHIR endpoint.
 */

type AnyRecord = Record<string, unknown>;

export interface AdmissionPatient {
  mrn: string;
  first_name?: string | null;
  last_name?: string | null;
  name?: string | null;
  dob?: string | null;
  age?: number | null;
  gender?: string | null;
  biological_sex?: string | null;
  gender_identity?: string | null;
  phone?: string | null;
  address?: string | null;
  occupation?: string | null;
  facility_name?: string | null;
  admission_time?: string | null;
  discharge_time?: string | null;
  status?: string | null;
  code_status?: string | null;

  // Emergency contact
  emergency_contact_name?: string | null;
  emergency_contact_relationship?: string | null;
  emergency_contact_phone?: string | null;

  // Coverage
  insurance_provider?: string | null;
  insurance_policy_number?: string | null;
  guarantor?: string | null;
  primary_care_physician?: string | null;

  // CC + HPI
  chief_complaint?: string | null;
  hpi_onset?: string | null;
  hpi_location?: string | null;
  hpi_duration?: string | null;
  hpi_character?: string | null;
  hpi_aggravating_factors?: string | null;
  hpi_alleviating_factors?: string | null;
  hpi_severity?: number | null;

  // History
  past_medical_history?: string | null;
  past_surgical_history?: string | null;
  past_hospitalizations?: string | null;
  family_history?: string | null;
  environmental_allergies?: string | null;
  allergies?: string | null;
  current_medications?: string | null;

  // Final dx + discharge
  diagnosis?: string | null;
  discharge_summary?: string | null;
}

export interface DischargeLab {
  id?: string;
  test_name?: string | null;
  test_type?: string | null;
  result_value?: string | null;
  unit?: string | null;
  reference_range?: string | null;
  flag?: string | null; // HIGH | LOW | CRITICAL
  loinc?: string | null;
  collected_at?: string | null;
  performing_lab?: string | null;
}

export interface DischargeMed {
  id?: string;
  drug?: string | null;
  drug_name?: string | null;
  medication_name?: string | null;
  dose?: string | null;
  route?: string | null;
  frequency?: string | null;
  rxnorm?: string | null;
  status?: string | null;
  ordering_physician?: string | null;
}

/* ------------------------------ helpers ------------------------------ */

const HL7 = {
  CONDITION_CLINICAL: "http://terminology.hl7.org/CodeSystem/condition-clinical",
  CONDITION_VERIFICATION: "http://terminology.hl7.org/CodeSystem/condition-ver-status",
  CONDITION_CATEGORY: "http://terminology.hl7.org/CodeSystem/condition-category",
  ALLERGY_CLINICAL: "http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical",
  OBS_CATEGORY: "http://terminology.hl7.org/CodeSystem/observation-category",
  V3_ACT_CODE: "http://terminology.hl7.org/CodeSystem/v3-ActCode",
  V3_ROLE_CODE: "http://terminology.hl7.org/CodeSystem/v3-RoleCode",
  CONSENT_SCOPE: "http://terminology.hl7.org/CodeSystem/consentscope",
  CONSENT_CATEGORY: "http://terminology.hl7.org/CodeSystem/consentcategorycodes",
  GENDER_IDENTITY_EXT: "http://hl7.org/fhir/StructureDefinition/patient-genderIdentity",
};

const LOINC = "http://loinc.org";
const SNOMED = "http://snomed.info/sct";
const RXNORM = "http://www.nlm.nih.gov/research/umls/rxnorm";
const ICD10 = "http://hl7.org/fhir/sid/icd-10-cm";

function uuid() {
  // Deterministic enough for an in-bundle fullUrl
  return "uuid-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function fhirId(prefix: string, value: string) {
  return `${prefix}-${value}`.replace(/[^A-Za-z0-9-.]/g, "-").slice(0, 64);
}

/**
 * Deterministic resource ID derived from a stable input string.
 * Used so repeated pipeline runs produce the SAME FHIR resource IDs
 * and PUT requests upsert instead of duplicating on the FHIR server.
 */
function stableId(prefix: string, ...parts: Array<string | null | undefined>) {
  const joined = parts
    .filter((p): p is string => !!p && typeof p === "string")
    .join("|")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50) || "x";
  return `${prefix}-${joined}`.slice(0, 64);
}

function urn(id: string) {
  return `urn:uuid:${id}`;
}

function normalizeGender(p: AdmissionPatient): "male" | "female" | "other" | "unknown" {
  const raw = (p.gender ?? p.biological_sex ?? p.gender_identity ?? "").toLowerCase();
  if (raw.startsWith("m")) return "male";
  if (raw.startsWith("f")) return "female";
  if (raw.startsWith("o")) return "other";
  return "unknown";
}

function fullName(p: AdmissionPatient) {
  if (p.first_name || p.last_name)
    return { given: p.first_name ? [p.first_name] : [], family: p.last_name ?? "" };
  const [given, ...rest] = (p.name ?? "").split(" ");
  return { given: given ? [given] : [], family: rest.join(" ") };
}

function splitList(value?: string | null): string[] {
  if (!value) return [];
  return value
    .split(/[,;\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function codeStatusToCoding(status?: string | null) {
  if (!status) return null;
  const s = status.toLowerCase();
  // SNOMED code-status concepts
  if (s.includes("full")) return { system: SNOMED, code: "304253006", display: "Not for resuscitation (situation)" };
  if (s.includes("dnr")) return { system: SNOMED, code: "304253006", display: "DNR — Not for resuscitation" };
  if (s.includes("dni")) return { system: SNOMED, code: "304251008", display: "DNI — Not for intubation" };
  if (s.includes("comfort")) return { system: SNOMED, code: "133918004", display: "Comfort measures only" };
  return { system: SNOMED, code: "304253006", display: status };
}

/* ------------------------------ builders ------------------------------ */

function buildPatient(p: AdmissionPatient, id: string) {
  const name = fullName(p);
  const res: AnyRecord = {
    resourceType: "Patient",
    id,
    identifier: [
      { use: "official", system: "urn:spehr:mrn", value: p.mrn },
    ],
    active: true,
    name: [{ use: "official", given: name.given, family: name.family || name.given[0] || "" }],
    gender: normalizeGender(p),
    birthDate: p.dob ?? undefined,
    telecom: p.phone ? [{ system: "phone", value: p.phone, use: "home" }] : undefined,
    address: p.address ? [{ use: "home", text: p.address }] : undefined,
    managingOrganization: p.facility_name ? { display: p.facility_name } : undefined,
  };
  if (p.gender_identity) {
    res.extension = [
      {
        url: HL7.GENDER_IDENTITY_EXT,
        valueCodeableConcept: { text: p.gender_identity },
      },
    ];
  }
  if (p.emergency_contact_name) {
    res.contact = [
      {
        relationship: [
          {
            coding: [
              {
                system: HL7.V3_ROLE_CODE,
                code: "C",
                display: p.emergency_contact_relationship ?? "Emergency Contact",
              },
            ],
            text: p.emergency_contact_relationship ?? "Emergency Contact",
          },
        ],
        name: { text: p.emergency_contact_name },
        telecom: p.emergency_contact_phone
          ? [{ system: "phone", value: p.emergency_contact_phone, use: "mobile" }]
          : undefined,
      },
    ];
  }
  return res;
}

function buildRelatedPersonEmergencyContact(p: AdmissionPatient, patientId: string, id: string) {
  if (!p.emergency_contact_name) return null;
  return {
    resourceType: "RelatedPerson",
    id,
    patient: { reference: urn(patientId) },
    relationship: [
      {
        coding: [{ system: HL7.V3_ROLE_CODE, code: "ECON", display: p.emergency_contact_relationship ?? "Emergency contact" }],
        text: p.emergency_contact_relationship ?? "Emergency contact",
      },
    ],
    name: [{ text: p.emergency_contact_name }],
    telecom: p.emergency_contact_phone ? [{ system: "phone", value: p.emergency_contact_phone }] : undefined,
  };
}

function buildCoverage(p: AdmissionPatient, patientId: string, id: string) {
  if (!p.insurance_provider && !p.insurance_policy_number) return null;
  return {
    resourceType: "Coverage",
    id,
    status: "active",
    beneficiary: { reference: urn(patientId) },
    subscriberId: p.insurance_policy_number ?? undefined,
    policyHolder: p.guarantor ? { display: p.guarantor } : { reference: urn(patientId) },
    payor: [{ display: p.insurance_provider ?? "Unknown payor" }],
    relationship: { text: p.guarantor && p.guarantor !== "Self" ? p.guarantor : "self" },
  };
}

function buildCodeStatusConsent(p: AdmissionPatient, patientId: string, id: string) {
  const coding = codeStatusToCoding(p.code_status);
  if (!coding) return null;
  return {
    resourceType: "Consent",
    id,
    status: "active",
    scope: {
      coding: [{ system: HL7.CONSENT_SCOPE, code: "treatment", display: "Treatment" }],
    },
    category: [
      {
        coding: [{ system: HL7.CONSENT_CATEGORY, code: "dnr", display: "Do Not Resuscitate" }],
        text: p.code_status ?? "Code status",
      },
    ],
    patient: { reference: urn(patientId) },
    dateTime: p.admission_time ?? new Date().toISOString(),
    provision: {
      type: "permit",
      code: [{ coding: [coding], text: p.code_status ?? coding.display }],
    },
  };
}

function buildEncounter(p: AdmissionPatient, patientId: string, id: string) {
  const isFinished = (p.status ?? "").toLowerCase() === "discharged" || !!p.discharge_time;
  return {
    resourceType: "Encounter",
    id,
    identifier: [{ system: "urn:spehr:encounter", value: `enc-${p.mrn}` }],
    status: isFinished ? "finished" : "in-progress",
    class: { system: HL7.V3_ACT_CODE, code: "EMER", display: "Emergency" },
    subject: { reference: urn(patientId) },
    period: { start: p.admission_time ?? undefined, end: p.discharge_time ?? undefined },
    reasonCode: p.chief_complaint ? [{ text: p.chief_complaint }] : undefined,
    serviceProvider: p.facility_name ? { display: p.facility_name } : undefined,
  };
}

function buildHpiCondition(p: AdmissionPatient, patientId: string, encounterId: string, id: string) {
  if (!p.chief_complaint) return null;
  const hpiBits = [
    p.hpi_onset && `Onset: ${p.hpi_onset}`,
    p.hpi_location && `Location: ${p.hpi_location}`,
    p.hpi_duration && `Duration: ${p.hpi_duration}`,
    p.hpi_character && `Character: ${p.hpi_character}`,
    p.hpi_aggravating_factors && `Aggravating: ${p.hpi_aggravating_factors}`,
    p.hpi_alleviating_factors && `Alleviating: ${p.hpi_alleviating_factors}`,
    typeof p.hpi_severity === "number" && `Severity: ${p.hpi_severity}/10`,
  ]
    .filter(Boolean)
    .join("; ");
  return {
    resourceType: "Condition",
    id,
    clinicalStatus: { coding: [{ system: HL7.CONDITION_CLINICAL, code: "active" }] },
    verificationStatus: { coding: [{ system: HL7.CONDITION_VERIFICATION, code: "provisional" }] },
    category: [
      { coding: [{ system: HL7.CONDITION_CATEGORY, code: "encounter-diagnosis", display: "Encounter Diagnosis" }] },
    ],
    code: { text: p.chief_complaint },
    subject: { reference: urn(patientId) },
    encounter: { reference: urn(encounterId) },
    onsetString: p.hpi_onset ?? undefined,
    severity: typeof p.hpi_severity === "number"
      ? { text: `${p.hpi_severity}/10` }
      : undefined,
    bodySite: p.hpi_location ? [{ text: p.hpi_location }] : undefined,
    note: hpiBits ? [{ text: hpiBits }] : undefined,
    recordedDate: p.admission_time ?? new Date().toISOString(),
  };
}

function buildPmhConditions(p: AdmissionPatient, patientId: string) {
  type PmhItem = { text: string; kind: "problem-list-item" | "encounter-diagnosis"; status: "active" | "resolved"; note?: string };
  const items: PmhItem[] = [
    ...splitList(p.past_medical_history).map((t): PmhItem => ({ text: t, kind: "problem-list-item", status: "active" })),
    ...splitList(p.past_surgical_history).map((t): PmhItem => ({ text: t, kind: "problem-list-item", status: "resolved", note: "Past surgical" })),
    ...splitList(p.past_hospitalizations).map((t): PmhItem => ({ text: t, kind: "encounter-diagnosis", status: "resolved", note: "Prior hospitalization" })),
  ];
  return items.map((item) => {
    const cid = stableId("cond", p.mrn, item.kind, item.text);
    return ({
    id: cid,
    resource: {
      resourceType: "Condition",
      id: cid,
      clinicalStatus: { coding: [{ system: HL7.CONDITION_CLINICAL, code: item.status }] },
      verificationStatus: { coding: [{ system: HL7.CONDITION_VERIFICATION, code: "confirmed" }] },
      category: [{ coding: [{ system: HL7.CONDITION_CATEGORY, code: item.kind }] }],
      code: { text: item.text },
      subject: { reference: urn(patientId) },
      note: item.note ? [{ text: item.note }] : undefined,
    } as AnyRecord,
  });
  });
}

function buildAllergies(p: AdmissionPatient, patientId: string) {
  const drug = splitList(p.allergies).filter((s) => s.toUpperCase() !== "NKDA");
  const env = splitList(p.environmental_allergies);
  const make = (text: string, category: "medication" | "environment") => {
    const aid = stableId("allergy", p.mrn, category, text);
    return ({
    id: aid,
    resource: {
      resourceType: "AllergyIntolerance",
      id: aid,
      clinicalStatus: { coding: [{ system: HL7.ALLERGY_CLINICAL, code: "active" }] },
      type: "allergy",
      category: [category],
      criticality: "high",
      code: { text: text.replace(/\s*\(.*?\)\s*$/, "") }, // strip parenthetical reaction
      patient: { reference: urn(patientId) },
      reaction: /\(.*?\)/.test(text)
        ? [{ manifestation: [{ text: (text.match(/\((.*?)\)/) ?? [, ""])[1]! }] }]
        : undefined,
    } as AnyRecord,
  });
  };
  return [...drug.map((d) => make(d, "medication")), ...env.map((e) => make(e, "environment"))];
}

function buildMedicationStatements(p: AdmissionPatient, patientId: string) {
  return splitList(p.current_medications).map((med) => {
    const mid = stableId("medstmt", p.mrn, med);
    return ({
    id: mid,
    resource: {
      resourceType: "MedicationStatement",
      id: mid,
      status: "active",
      medicationCodeableConcept: { text: med },
      subject: { reference: urn(patientId) },
      effectiveDateTime: p.admission_time ?? undefined,
      dosage: [{ text: med }],
    } as AnyRecord,
  });
  });
}

function buildFamilyHistory(p: AdmissionPatient, patientId: string) {
  const items = splitList(p.family_history);
  if (items.length === 0) return [];
  const fid = stableId("famhx", p.mrn);
  return [
    {
      id: fid,
      resource: {
        resourceType: "FamilyMemberHistory",
        id: fid,
        status: "completed",
        patient: { reference: urn(patientId) },
        relationship: { text: "Family (unspecified blood relative)" },
        condition: items.map((c) => ({ code: { text: c } })),
      } as AnyRecord,
    },
  ];
}

/* ------------------------- bundle assemblers ------------------------- */

function wrapTransaction(entries: AnyRecord[]) {
  return {
    resourceType: "Bundle",
    type: "transaction",
    timestamp: new Date().toISOString(),
    entry: entries,
  };
}

function entryFor(fullUrl: string, resource: AnyRecord) {
  const rt = resource.resourceType as string;
  // Every resource carries a stable, deterministic id so PUT-by-id makes the
  // transaction idempotent — reruns update the same resource instead of
  // creating duplicates on the FHIR server.
  const request = { method: "PUT", url: `${rt}/${resource.id}` };
  return { fullUrl, resource, request };
}

export function buildAdmissionTransactionBundle(p: AdmissionPatient) {
  // Unified ID convention: Patient = the MRN itself (already begins with
  // "MRN-"); Encounter = "enc-<mrn>". Matches enc-${mrn} used by billing
  // and the legacy `Patient/<mrn>` references in DB SQL helpers.
  const patientId = fhirId("", p.mrn).replace(/^-/, "");
  const encounterId = `enc-${patientId}`;

  const patient = buildPatient(p, patientId);
  const encounter = buildEncounter(p, patientId, encounterId);
  const relatedPerson = buildRelatedPersonEmergencyContact(p, patientId, stableId("relp", patientId, "econ"));
  const coverage = buildCoverage(p, patientId, stableId("coverage", patientId));
  const consent = buildCodeStatusConsent(p, patientId, stableId("consent", patientId, "codestatus"));
  const hpi = buildHpiCondition(p, patientId, encounterId, stableId("cond", patientId, "hpi"));
  const pmh = buildPmhConditions(p, patientId);
  const allergies = buildAllergies(p, patientId);
  const meds = buildMedicationStatements(p, patientId);
  const family = buildFamilyHistory(p, patientId);

  const entries: AnyRecord[] = [
    entryFor(urn(patientId), patient),
    entryFor(urn(encounterId), encounter),
    ...(relatedPerson ? [entryFor(urn(relatedPerson.id as string), relatedPerson)] : []),
    ...(coverage ? [entryFor(urn(coverage.id as string), coverage)] : []),
    ...(consent ? [entryFor(urn(consent.id as string), consent)] : []),
    ...(hpi ? [entryFor(urn(hpi.id as string), hpi)] : []),
    ...pmh.map((c) => entryFor(urn(c.id), c.resource)),
    ...allergies.map((a) => entryFor(urn(a.id), a.resource)),
    ...meds.map((m) => entryFor(urn(m.id), m.resource)),
    ...family.map((f) => entryFor(urn(f.id), f.resource)),
  ];

  return { bundle: wrapTransaction(entries), patientId, encounterId };
}

/* ----------------------------- Discharge ----------------------------- */

function buildLabObservation(p: AdmissionPatient, patientId: string, encounterId: string, l: DischargeLab) {
  const id = stableId("obs", p.mrn, l.loinc, l.test_name ?? l.test_type);
  const numeric = l.result_value ? Number((l.result_value.match(/-?\d+(\.\d+)?/) ?? [])[0]) : NaN;
  const interpretation = l.flag
    ? [
        {
          coding: [
            {
              system: "http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation",
              code: l.flag.toUpperCase().startsWith("H") ? "H" : l.flag.toUpperCase().startsWith("L") ? "L" : "A",
              display: l.flag,
            },
          ],
          text: l.flag,
        },
      ]
    : undefined;
  return {
    id,
    resource: {
      resourceType: "Observation",
      id,
      status: "final",
      category: [{ coding: [{ system: HL7.OBS_CATEGORY, code: "laboratory", display: "Laboratory" }] }],
      code: {
        coding: l.loinc ? [{ system: LOINC, code: l.loinc, display: l.test_name ?? l.test_type ?? "Lab" }] : undefined,
        text: l.test_name ?? l.test_type ?? "Lab",
      },
      subject: { reference: urn(patientId) },
      encounter: { reference: urn(encounterId) },
      effectiveDateTime: l.collected_at ?? p.admission_time ?? undefined,
      performer: l.performing_lab ? [{ display: l.performing_lab }] : [{ display: "SPEHR Central Laboratory" }],
      ...(Number.isFinite(numeric)
        ? { valueQuantity: { value: numeric, unit: l.unit ?? undefined } }
        : l.result_value
          ? { valueString: l.result_value }
          : {}),
      referenceRange: l.reference_range ? [{ text: l.reference_range }] : undefined,
      interpretation,
      specimen: { display: "Whole blood / Serum (auto-derived)" },
    } as AnyRecord,
  };
}

function buildDischargeMedRequest(patientId: string, encounterId: string, m: DischargeMed) {
  const name = m.drug ?? m.drug_name ?? m.medication_name ?? "medication";
  // patientId is already the bare MRN under the unified convention.
  const id = stableId("medreq", patientId, m.rxnorm, name);
  return {
    id,
    resource: {
      resourceType: "MedicationRequest",
      id,
      status: "active",
      intent: "discharge",
      medicationCodeableConcept: {
        coding: m.rxnorm ? [{ system: RXNORM, code: m.rxnorm, display: name }] : undefined,
        text: `${name}${m.dose ? ` ${m.dose}` : ""}`,
      },
      subject: { reference: urn(patientId) },
      encounter: { reference: urn(encounterId) },
      requester: m.ordering_physician ? { display: m.ordering_physician } : undefined,
      dosageInstruction: [
        {
          text: [m.dose, m.route, m.frequency].filter(Boolean).join(" "),
          route: m.route ? { text: m.route } : undefined,
          timing: m.frequency ? { code: { text: m.frequency } } : undefined,
        },
      ],
    } as AnyRecord,
  };
}

function narrativeSection(title: string, text: string, refs: Array<{ reference: string }> = []) {
  if (!text && refs.length === 0) return null;
  return {
    title,
    text: {
      status: "generated",
      div: `<div xmlns="http://www.w3.org/1999/xhtml"><p>${escapeXml(text)}</p></div>`,
    },
    entry: refs.length ? refs : undefined,
  };
}

function escapeXml(s: string) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Compose the "Hospital Course" narrative from the ACTUAL per-encounter
 * medication list. Never mentions a drug that was not passed in — this
 * replaces the pre-fix behaviour of piping in a per-diagnosis template
 * string (e.g. "ceftriaxone/azithromycin" for CAP) which named drugs the
 * patient was never given.
 *
 * Falls back to the caller-provided `hospitalCourse` framing only when
 * BOTH meds and labs are empty (nothing patient-specific to render).
 */
function composeHospitalCourse(
  meds: DischargeMed[],
  labs: DischargeLab[],
  admittingDiagnosis: string | undefined,
  dischargeDiagnosis: string | undefined,
  fallback: string,
): string {
  if (meds.length === 0 && labs.length === 0) return fallback;
  const dx = dischargeDiagnosis || admittingDiagnosis;
  const parts: string[] = [];
  if (dx) parts.push(`Managed for ${dx}.`);
  if (meds.length > 0) {
    const medPhrases = meds.map((m) => {
      const name = m.drug ?? m.drug_name ?? m.medication_name ?? "medication";
      const detail = [m.dose, m.route, m.frequency].filter(Boolean).join(" ");
      return detail ? `${name} ${detail}` : name;
    });
    parts.push(`Treated during admission with ${medPhrases.join("; ")}.`);
  }
  if (labs.length > 0) {
    const labNames = Array.from(new Set(labs.map((l) => l.test_name ?? l.test_type ?? "lab").filter(Boolean)));
    parts.push(`Diagnostic workup: ${labNames.join(", ")}.`);
  }
  parts.push("Patient clinically stable at discharge with appropriate follow-up planned.");
  return parts.join(" ");
}

export function buildDischargeTransactionBundle(opts: {
  patient: AdmissionPatient;
  labs?: DischargeLab[];
  dischargeMeds?: DischargeMed[];
  hospitalCourse?: string;
  physicalExam?: {
    general?: string;
    cardiovascular?: string;
    pulmonary?: string;
    abdomen?: string;
    neurologic?: string;
  };
  procedures?: string[];
  diet?: string;
  activity?: string;
  followUp?: string;
  returnPrecautions?: string;
  patientEducation?: string;
  admittingDiagnosis?: string;
  dischargeDiagnosis?: string;
  conditionAtDischarge?: string;
}) {
  const { patient: p } = opts;
  const patientId = fhirId("", p.mrn).replace(/^-/, "");
  const encounterId = `enc-${patientId}`;
  const compositionId = stableId("composition", patientId, "discharge");

  const patient = buildPatient(p, patientId);
  const encounter = buildEncounter(p, patientId, encounterId);

  const labEntries = (opts.labs ?? []).map((l) => buildLabObservation(p, patientId, encounterId, l));
  const medEntries = (opts.dischargeMeds ?? []).map((m) => buildDischargeMedRequest(patientId, encounterId, m));

  const exam = opts.physicalExam ?? {};
  const examText = [
    exam.general && `General: ${exam.general}`,
    exam.cardiovascular && `Cardiovascular: ${exam.cardiovascular}`,
    exam.pulmonary && `Pulmonary: ${exam.pulmonary}`,
    exam.abdomen && `Abdomen: ${exam.abdomen}`,
    exam.neurologic && `Neurologic: ${exam.neurologic}`,
  ]
    .filter(Boolean)
    .join("\n");

  const hpiText = [
    p.chief_complaint && `Chief complaint: ${p.chief_complaint}.`,
    p.hpi_onset && `Onset ${p.hpi_onset}.`,
    p.hpi_location && `Location: ${p.hpi_location}.`,
    p.hpi_character && `Character: ${p.hpi_character}.`,
    typeof p.hpi_severity === "number" && `Severity ${p.hpi_severity}/10.`,
    p.hpi_aggravating_factors && `Aggravated by ${p.hpi_aggravating_factors}.`,
    p.hpi_alleviating_factors && `Relieved by ${p.hpi_alleviating_factors}.`,
  ]
    .filter(Boolean)
    .join(" ");

  const pmhText = [
    p.past_medical_history && `PMH: ${p.past_medical_history}.`,
    p.past_surgical_history && `PSH: ${p.past_surgical_history}.`,
    p.allergies && `Allergies: ${p.allergies}.`,
    p.environmental_allergies && `Environmental: ${p.environmental_allergies}.`,
  ]
    .filter(Boolean)
    .join(" ");

  const composition: AnyRecord = {
    resourceType: "Composition",
    id: compositionId,
    status: "final",
    type: {
      coding: [{ system: LOINC, code: "18842-5", display: "Discharge Summary" }],
      text: "Discharge Summary",
    },
    subject: { reference: urn(patientId) },
    encounter: { reference: urn(encounterId) },
    date: p.discharge_time ?? new Date().toISOString(),
    author: [{ display: "S.P.E.H.R Auto Doc AI Pipeline" }],
    title: `Discharge Summary — ${p.name ?? p.mrn}`,
    event: [
      {
        period: { start: p.admission_time ?? undefined, end: p.discharge_time ?? undefined },
        code: opts.admittingDiagnosis || opts.dischargeDiagnosis
          ? [{ text: `Admitting: ${opts.admittingDiagnosis ?? "—"}; Discharge: ${opts.dischargeDiagnosis ?? p.diagnosis ?? "—"}` }]
          : undefined,
      },
    ],
    section: [
      narrativeSection("Chief Complaint & History of Present Illness", hpiText || p.chief_complaint || ""),
      narrativeSection("Past Medical History & Allergies", pmhText),
      narrativeSection("Physical Examination on Admission", examText),
      narrativeSection(
        "Hospital Course",
        composeHospitalCourse(
          opts.dischargeMeds ?? [],
          opts.labs ?? [],
          opts.admittingDiagnosis ?? undefined,
          opts.dischargeDiagnosis ?? p.diagnosis ?? undefined,
          opts.hospitalCourse ?? p.discharge_summary ?? "",
        ),
      ),
      narrativeSection("Procedures Performed", (opts.procedures ?? []).join("; ")),
      narrativeSection(
        "Pertinent Laboratory Findings",
        labEntries.length === 0
          ? "No laboratory observations recorded for this encounter."
          : `${labEntries.length} laboratory observation(s) performed by SPEHR Central Laboratory:\n` +
            (opts.labs ?? [])
              .map((l) => {
                const name = l.test_name ?? l.test_type ?? "Observation";
                const code = l.loinc ? ` [LOINC ${l.loinc}]` : "";
                const val = l.result_value ?? "Pending";
                const flag = l.flag ? ` (${l.flag})` : "";
                return `• ${name}${code}: ${val}${flag}`;
              })
              .join("\n"),
        labEntries.map((l) => ({ reference: urn(l.id) })),
      ),
      narrativeSection(
        "Discharge Medications",
        medEntries.length === 0
          ? "No discharge medications prescribed for this encounter."
          : `${medEntries.length} medication(s) prescribed on discharge:\n` +
            (opts.dischargeMeds ?? [])
              .map((m) => {
                const name = m.drug ?? "Medication";
                const code = m.rxnorm ? ` [RxNorm ${m.rxnorm}]` : "";
                const detail = [m.dose, m.route, m.frequency].filter(Boolean).join(" ");
                return `• ${name}${code}${detail ? ` — ${detail}` : ""}`;
              })
              .join("\n"),
        medEntries.map((m) => ({ reference: urn(m.id) })),
      ),
      narrativeSection("Diet & Activity", [opts.diet && `Diet: ${opts.diet}`, opts.activity && `Activity: ${opts.activity}`].filter(Boolean).join(" ")),
      narrativeSection("Follow-Up Care", opts.followUp ?? (p.primary_care_physician ? `Follow up with ${p.primary_care_physician} within 7 days.` : "Follow up with PCP within 7 days.")),
      narrativeSection("Return Precautions", opts.returnPrecautions ?? "Return immediately for worsening symptoms, chest pain, shortness of breath, fever > 101.5°F, or new neurological deficits."),
      narrativeSection("Patient Education", opts.patientEducation ?? "Educated on diagnosis, medication adherence, and follow-up plan."),
      narrativeSection("Condition at Discharge", opts.conditionAtDischarge ?? "Stable, improved."),
    ].filter(Boolean) as AnyRecord[],
  };

  const entries: AnyRecord[] = [
    entryFor(urn(compositionId), composition),
    entryFor(urn(patientId), patient),
    entryFor(urn(encounterId), encounter),
    ...labEntries.map((l) => entryFor(urn(l.id), l.resource)),
    ...medEntries.map((m) => entryFor(urn(m.id), m.resource)),
  ];

  return { bundle: wrapTransaction(entries), compositionId, patientId, encounterId };
}