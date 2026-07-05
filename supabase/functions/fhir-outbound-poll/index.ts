// Outbound FHIR poll — server-side, browser-independent push of
// clinical + billing/appointment resources to Medblocks.
//
// Runs on a pg_cron schedule (every ~30-45s). Reads the three durable
// cursors from `public.fhir_sync_state`:
//    outbound_invoice_last_synced_at
//    outbound_chargeitem_last_synced_at
//    outbound_appointment_last_synced_at
//    outbound_clinical_last_synced_at   <-- covers meds / labs / notes /
//                                            conditions / patient demographics
//                                            on a single per-MRN cursor
// Queries each source table for rows changed since that cursor, builds
// FHIR R4 resources with STABLE ids and the `urn:spehr:source|spehr` tag,
// and POSTs them as a `type=transaction` bundle of PUT entries to the
// upstream FHIR server (idempotent — safe to co-exist with the
// client-side `useBackgroundFhirSync` fast-path).
//
// Notes on scoping:
//  • fhir_charge_items has no `updated_at` — we use `created_at`.
//  • fhir_appointments rows with a non-null `fhir_id` originated on the
//    myspehr side (already live on the server), so we skip them here to
//    avoid needlessly re-writing them under a `spehr`-source id.
//  • Clinical push does NOT gate on discharge status. Matches the client
//    hook (`useBackgroundFhirSync` line 385-390: "Full live sync mode:
//    every patient is eligible regardless of admission status.").

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const FHIR_SERVER_URL = (Deno.env.get("FHIR_SERVER_URL") ?? "").replace(/\/+$/, "");
const FHIR_BEARER_TOKEN = Deno.env.get("FHIR_BEARER_TOKEN") ?? "";
const FHIR_APIKEY = Deno.env.get("FHIR_APIKEY") ?? "";

const BATCH_LIMIT = 200;
// Distinct MRNs handled per clinical poll cycle. A single MRN with a
// full slate of meds/labs/notes/conditions produces ~20-40 FHIR entries;
// 25 MRNs per cycle × ~30 entries ≈ well under Medblocks' bundle limits.
const CLINICAL_MRN_LIMIT = 25;

function isoMax(a: string, b: string): string {
  const ai = toIso(a), bi = toIso(b);
  return new Date(ai).getTime() >= new Date(bi).getTime() ? ai : bi;
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "content-type": "application/json" },
  });
}

function fhirHeaders(): Record<string, string> {
  const h: Record<string, string> = {
    "Content-Type": "application/fhir+json",
    Accept: "application/fhir+json",
    Authorization: `Bearer ${FHIR_BEARER_TOKEN}`,
  };
  if (FHIR_APIKEY) h.Apikey = FHIR_APIKEY;
  return h;
}

function toIso(ts: string | null | undefined): string {
  if (!ts) return new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const d = new Date(ts.includes("T") ? ts : ts.replace(" ", "T"));
  if (isNaN(d.getTime())) return new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  return d.toISOString();
}

async function readState(admin: any, key: string): Promise<string> {
  const { data } = await admin
    .from("fhir_sync_state")
    .select("value")
    .eq("key", key)
    .maybeSingle();
  // Preserve raw postgres text (with microsecond precision) so `.gt()`
  // doesn't re-match the same row after we already pushed it. Fall back to
  // a 24h window if the cursor row is missing.
  const ts = data?.value?.ts;
  if (typeof ts === "string" && ts.length) return ts;
  return new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
}

async function writeState(admin: any, key: string, ts: string) {
  await admin
    .from("fhir_sync_state")
    .upsert({ key, value: { ts } }, { onConflict: "key" });
}

/* ---------------- Builders (server-side copies of src/lib/fhir-bundle.ts) --- */

const SPEHR_TAG = { system: "urn:spehr:source", code: "spehr" };

function fhirSafeId(input: string): string {
  return String(input ?? "")
    .replace(/[^A-Za-z0-9\-\.]/g, "-")
    .slice(0, 64) || "unknown";
}

function tagged<T extends Record<string, any>>(r: T): T {
  return { ...r, meta: { ...(r.meta ?? {}), tag: [{ ...SPEHR_TAG }] } };
}

function buildInvoice(row: any) {
  const status = String(row.status ?? "").toLowerCase() === "balanced" ? "balanced" : "issued";
  const currency = row.currency ?? "USD";
  const subtotal = Number(row.subtotal ?? 0);
  const total = Number(row.total ?? subtotal);
  return tagged({
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
    paymentTerms: status === "balanced" && row.paid_at ? `Paid ${row.paid_at}` : undefined,
  });
}

function buildChargeItem(row: any, invoiceNo?: string | null) {
  const currency = row.currency ?? "USD";
  const quantity = Number(row.quantity ?? 1);
  const unitPrice = Number(row.unit_price ?? 0);
  const amount = Number(row.amount ?? unitPrice * quantity);
  const codeSystem =
    row.code_system && row.code_system !== "internal" ? row.code_system : "urn:spehr:charge-code";
  return tagged({
    resourceType: "ChargeItem",
    id: fhirSafeId(`charge-${row.id}`),
    identifier: [{ system: "urn:spehr:charge-uuid", value: row.id }],
    status: "billable",
    code: {
      coding: [{ system: codeSystem, code: row.charge_code, display: row.description }],
      text: row.description,
    },
    subject: { reference: `Patient/${row.mrn}` },
    // FHIR R4: ChargeItem.context is Encounter|EpisodeOfCare only.
    // Link back to the Invoice via supportingInformation instead.
    supportingInformation: invoiceNo
      ? [{ reference: `Invoice/${fhirSafeId(invoiceNo)}` }]
      : undefined,
    occurrenceDateTime: row.service_date ?? undefined,
    quantity: { value: quantity },
    priceOverride: { value: unitPrice, currency },
    totalPriceComponent: { type: "base", amount: { value: amount, currency } },
    extension: [
      { url: "urn:spehr:charge-category", valueString: row.category ?? "uncategorized" },
      ...(row.invoice_id ? [{ url: "urn:spehr:invoice-uuid", valueString: row.invoice_id }] : []),
    ],
  });
}

function buildAppointment(row: any) {
  const status = String(row.status ?? "booked").toLowerCase();
  const participants: any[] = [];
  if (row.patient_mrn) {
    participants.push({
      actor: { reference: `Patient/${row.patient_mrn}`, display: row.patient_name ?? undefined },
      status: "accepted",
    });
  }
  if (row.practitioner_name) {
    participants.push({ actor: { display: row.practitioner_name }, status: "accepted" });
  }
  return tagged({
    resourceType: "Appointment",
    id: fhirSafeId(`appt-${row.id}`),
    identifier: [{ system: "urn:spehr:appointment-uuid", value: row.id }],
    status,
    description: row.description ?? row.service_type ?? undefined,
    comment: row.comment ?? undefined,
    start: row.start_time,
    end: row.end_time,
    serviceType: row.service_type ? [{ text: row.service_type }] : undefined,
    participant:
      participants.length > 0
        ? participants
        : [{ status: "needs-action", actor: { display: "Unknown" } }],
    ...(row.facility_name ? { location: [{ display: row.facility_name }] } : {}),
  });
}

/* ---------------- Clinical builders (mirror src/lib/fhir-bundle.ts) ------ */
//
// Every stable ID below matches the client-side `stableIds` map so both
// paths PUT the SAME resource id and re-applications are idempotent.
// Reference: src/lib/fhir-bundle.ts lines 248-291.

function slugify(input: string): string {
  return String(input ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40) || "unknown";
}

const LAB_LOINC_BY_NAME: Record<string, string> = {
  "hemoglobin": "718-7", "hgb": "718-7",
  "wbc": "6690-2", "white blood cell count": "6690-2",
  "glucose": "2345-7", "creatinine": "2160-0",
  "troponin t": "89579-7", "troponin t hs": "89579-7",
  "creatine kinase": "2157-6", "ck": "2157-6",
  "platelets": "777-3", "hematocrit": "4544-3",
  "sodium": "2951-2", "potassium": "2823-3",
};
function loincForLabName(name: string | null | undefined): string | null {
  if (!name) return null;
  const n = name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  if (LAB_LOINC_BY_NAME[n]) return LAB_LOINC_BY_NAME[n];
  for (const k of Object.keys(LAB_LOINC_BY_NAME)) if (n.includes(k)) return LAB_LOINC_BY_NAME[k];
  return null;
}

const stableIds = {
  patient: (mrn: string) => mrn,
  encounter: (mrn: string) => `enc-${mrn}`,
  medRequest: (drug: string, mrn: string) => `medreq-${slugify(drug)}-${mrn}`,
  medAdmin: (drug: string, mrn: string) => `medadmin-${slugify(drug)}-${mrn}`,
  lab: (name: string, mrn: string, loinc?: string | null) => {
    if (loinc) {
      const code = String(loinc).replace(/[^A-Za-z0-9\-\.]/g, "").slice(0, 40);
      if (code) return `lab-${code}-${mrn}`;
    }
    return `lab-${slugify(name)}-${mrn}`;
  },
  condition: (type: string, mrn: string) => `cond-${slugify(type).slice(0, 30) || "unknown"}-${mrn}`,
  docRef: (mrn: string) => `docref-${mrn}`,
};

function buildPatientResource(p: any) {
  const name = p.name ?? [p.first_name, p.last_name].filter(Boolean).join(" ");
  const [given, ...rest] = String(name ?? "").split(" ");
  const family = rest.join(" ") || given || "";
  const g = String(p.gender ?? p.biological_sex ?? "").toLowerCase();
  return tagged({
    resourceType: "Patient",
    id: stableIds.patient(p.mrn),
    identifier: [{ system: "urn:spehr:mrn", value: p.mrn }],
    name: name ? [{ use: "official", given: given ? [given] : [], family }] : undefined,
    gender: g.startsWith("m") ? "male" : g.startsWith("f") ? "female" : "unknown",
    birthDate: p.dob ?? undefined,
    telecom: p.phone ? [{ system: "phone", value: p.phone }] : undefined,
    address: p.address ? [{ text: p.address }] : undefined,
    managingOrganization: p.facility_name ? { display: p.facility_name } : undefined,
  });
}

function buildEncounterResource(p: any) {
  const status =
    String(p.status ?? "").toLowerCase() === "discharged" || p.discharge_time
      ? "finished"
      : "in-progress";
  return tagged({
    resourceType: "Encounter",
    id: stableIds.encounter(p.mrn),
    identifier: [{ system: "urn:spehr:encounter", value: stableIds.encounter(p.mrn) }],
    status,
    class: {
      system: "http://terminology.hl7.org/CodeSystem/v3-ActCode",
      code: "EMER",
      display: "Emergency",
    },
    subject: { reference: `Patient/${p.mrn}` },
    period: { start: p.admission_time ?? undefined, end: p.discharge_time ?? undefined },
    reasonCode: p.chief_complaint ? [{ text: p.chief_complaint }] : undefined,
    serviceProvider: p.facility_name ? { display: p.facility_name } : undefined,
  });
}

function buildMedRequest(mrn: string, m: any) {
  const drug = m.drug_name ?? m.medication_name ?? m.drug ?? "medication";
  const raw = String(m.status ?? "").toLowerCase();
  const status =
    raw === "administered" || raw === "completed" || raw === "given"
      ? "completed"
      : raw === "pending" || raw === "draft" || raw === "pending verification" || raw === "pending_pharmacy"
        ? "draft"
        : raw === "cancelled" || raw === "canceled"
          ? "cancelled"
          : raw === "stopped" || raw === "discontinued"
            ? "stopped"
            : "active";
  const medCC = m.rxnorm_code
    ? {
        coding: [{ system: "http://www.nlm.nih.gov/research/umls/rxnorm", code: m.rxnorm_code, display: m.rxnorm_display ?? drug }],
        text: `${drug}${m.dose ? ` ${m.dose}` : ""}`,
      }
    : { text: `${drug}${m.dose ? ` ${m.dose}` : ""}` };
  return tagged({
    resourceType: "MedicationRequest",
    id: stableIds.medRequest(`${drug}${m.dose ? `-${m.dose}` : ""}`, mrn),
    status,
    intent: "order",
    medicationCodeableConcept: medCC,
    subject: { reference: `Patient/${mrn}` },
    encounter: { reference: `Encounter/${stableIds.encounter(mrn)}` },
    authoredOn: m.created_at ?? undefined,
    requester: m.ordered_by || m.ordering_physician ? { display: m.ordering_physician ?? m.ordered_by } : undefined,
    dosageInstruction: m.route
      ? [{ route: { text: m.route }, text: `${m.dose ?? ""} ${m.route}`.trim() }]
      : undefined,
  });
}

function buildMedAdmin(mrn: string, m: any) {
  const drug = m.drug_name ?? m.medication_name ?? m.drug ?? "medication";
  const medCC = m.rxnorm_code
    ? {
        coding: [{ system: "http://www.nlm.nih.gov/research/umls/rxnorm", code: m.rxnorm_code, display: m.rxnorm_display ?? drug }],
        text: `${drug}${m.dose ? ` ${m.dose}` : ""}`,
      }
    : { text: `${drug}${m.dose ? ` ${m.dose}` : ""}` };
  return tagged({
    resourceType: "MedicationAdministration",
    id: stableIds.medAdmin(`${drug}${m.dose ? `-${m.dose}` : ""}`, mrn),
    status: "completed",
    medicationCodeableConcept: medCC,
    subject: { reference: `Patient/${mrn}` },
    context: { reference: `Encounter/${stableIds.encounter(mrn)}` },
    effectiveDateTime: m.administered_at ?? m.updated_at ?? m.created_at ?? undefined,
    performer:
      m.ordering_physician || m.ordered_by
        ? [{ actor: { display: m.ordering_physician ?? m.ordered_by } }]
        : undefined,
  });
}

function buildLabObservation(mrn: string, l: any) {
  const loinc = l.loinc_code ?? loincForLabName(l.test_type ?? l.test_name);
  const id = stableIds.lab(l.test_type ?? l.test_name ?? l.id ?? "unknown", mrn, loinc);
  const value = l.result_value ?? "";
  const numeric = value ? Number((String(value).match(/-?\d+(\.\d+)?/) ?? [])[0]) : NaN;
  return tagged({
    resourceType: "Observation",
    id,
    status:
      String(l.status ?? "").toLowerCase() === "resulted" ||
      String(l.status ?? "").toLowerCase() === "reported" ||
      value
        ? "final"
        : "registered",
    category: [
      {
        coding: [
          { system: "http://terminology.hl7.org/CodeSystem/observation-category", code: "laboratory", display: "Laboratory" },
        ],
      },
    ],
    code: loinc
      ? { coding: [{ system: "http://loinc.org", code: loinc, display: l.test_type ?? l.test_name ?? undefined }], text: l.test_type ?? l.test_name ?? "Lab" }
      : { text: l.test_type ?? l.test_name ?? "Lab" },
    subject: { reference: `Patient/${mrn}` },
    encounter: { reference: `Encounter/${stableIds.encounter(mrn)}` },
    effectiveDateTime: l.collected_at ?? l.created_at ?? undefined,
    ...(Number.isFinite(numeric)
      ? { valueQuantity: { value: numeric, unit: l.unit ?? undefined } }
      : value
        ? { valueString: String(value) }
        : {}),
  });
}

function buildCondition(mrn: string, c: any, opts: { type: string; verification: "provisional" | "confirmed"; recordedDate?: string | null }) {
  const coding: any[] = [];
  if (c.snomed_code)
    coding.push({ system: "http://snomed.info/sct", code: c.snomed_code, display: c.snomed_display ?? c.display_text ?? undefined });
  if (c.icd10_code)
    coding.push({ system: "http://hl7.org/fhir/sid/icd-10-cm", code: c.icd10_code, display: c.icd10_display ?? c.display_text ?? undefined });
  const text = c.display_text ?? c.snomed_display ?? c.icd10_display ?? opts.type;
  return tagged({
    resourceType: "Condition",
    id: stableIds.condition(opts.type, mrn),
    clinicalStatus: {
      coding: [
        { system: "http://terminology.hl7.org/CodeSystem/condition-clinical", code: (c.clinical_status ?? "active") },
      ],
    },
    verificationStatus: {
      coding: [
        { system: "http://terminology.hl7.org/CodeSystem/condition-ver-status", code: c.verification_status ?? opts.verification },
      ],
    },
    category: [
      {
        coding: [
          { system: "http://terminology.hl7.org/CodeSystem/condition-category", code: "encounter-diagnosis", display: "Encounter Diagnosis" },
        ],
      },
    ],
    code: coding.length > 0 ? { coding, text } : { text },
    subject: { reference: `Patient/${mrn}` },
    encounter: { reference: `Encounter/${stableIds.encounter(mrn)}` },
    recordedDate: opts.recordedDate ?? c.coded_at ?? c.created_at ?? undefined,
  });
}

// Encode UTF-8 → base64 without depending on Buffer (Deno friendly).
function b64encode(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function buildDocRef(mrn: string, n: any) {
  return tagged({
    resourceType: "DocumentReference",
    id: stableIds.docRef(mrn),
    status: "current",
    type: { text: n.note_type ?? "Clinical note" },
    subject: { reference: `Patient/${mrn}` },
    context: { encounter: [{ reference: `Encounter/${stableIds.encounter(mrn)}` }] },
    date: n.created_at ?? undefined,
    author: n.author ? [{ display: n.author }] : undefined,
    content: [
      {
        attachment: {
          contentType: "text/plain",
          data: b64encode(n.content ?? ""),
          title: n.note_type ?? "Clinical note",
        },
      },
    ],
  });
}

/* ---------------- Transaction bundle push -------------------------------- */

async function pushBundle(entries: any[]): Promise<{ ok: boolean; status: number; body: any }> {
  const bundle = { resourceType: "Bundle", type: "transaction", entry: entries };
  const res = await fetch(FHIR_SERVER_URL, {
    method: "POST",
    headers: fhirHeaders(),
    body: JSON.stringify(bundle),
  });
  const text = await res.text();
  let body: any = text;
  try { body = JSON.parse(text); } catch { /* keep text */ }
  return { ok: res.ok, status: res.status, body };
}

function entryFor(res: any) {
  const url = `${res.resourceType}/${res.id}`;
  return { fullUrl: url, resource: res, request: { method: "PUT", url } };
}

/* ---------------- Poll implementations ----------------------------------- */

async function pollInvoices(admin: any) {
  const since = await readState(admin, "outbound_invoice_last_synced_at");
  const cutoff = new Date().toISOString();
  const { data, error } = await admin
    .from("fhir_invoices")
    .select("id, invoice_no, mrn, patient_name, facility_name, status, subtotal, tax, total, currency, issued_at, paid_at, updated_at")
    .gt("updated_at", since)
    .order("updated_at", { ascending: true })
    .limit(BATCH_LIMIT);
  if (error) throw new Error(`invoice query: ${error.message}`);
  const rows = (data ?? []) as any[];
  const stats: any = { since, cutoff, fetched: rows.length, pushed: 0, failed: 0 };
  if (rows.length === 0) {
    await writeState(admin, "outbound_invoice_last_synced_at", cutoff);
    return stats;
  }
  const entries = rows.map((r) => entryFor(buildInvoice(r)));
  const result = await pushBundle(entries);
  if (!result.ok) { stats.failed = rows.length; stats.error = result.body; return stats; }
  stats.pushed = rows.length;
  // Rows sorted asc; last row is newest updated_at (raw postgres text —
  // full microsecond precision, so .gt won't re-match it next run).
  await writeState(admin, "outbound_invoice_last_synced_at", rows[rows.length - 1].updated_at);
  return stats;
}

async function pollChargeItems(admin: any) {
  const since = await readState(admin, "outbound_chargeitem_last_synced_at");
  const cutoff = new Date().toISOString();
  const { data, error } = await admin
    .from("fhir_charge_items")
    .select("id, invoice_id, mrn, charge_code, code_system, description, category, quantity, unit_price, amount, currency, service_date, created_at")
    .gt("created_at", since)
    .order("created_at", { ascending: true })
    .limit(BATCH_LIMIT);
  if (error) throw new Error(`chargeitem query: ${error.message}`);
  const rows = (data ?? []) as any[];
  const stats: any = { since, cutoff, fetched: rows.length, pushed: 0, failed: 0 };
  if (rows.length === 0) {
    await writeState(admin, "outbound_chargeitem_last_synced_at", cutoff);
    return stats;
  }
  // Resolve invoice_no for each row (for `context` reference).
  const invIds = [...new Set(rows.map((r) => r.invoice_id).filter(Boolean))];
  const invMap = new Map<string, string>();
  if (invIds.length > 0) {
    const { data: invs } = await admin
      .from("fhir_invoices").select("id, invoice_no").in("id", invIds);
    for (const i of (invs ?? []) as any[]) invMap.set(String(i.id), String(i.invoice_no));
  }
  const entries = rows.map((r) => entryFor(buildChargeItem(r, invMap.get(String(r.invoice_id)))));
  const result = await pushBundle(entries);
  if (!result.ok) { stats.failed = rows.length; stats.error = result.body; return stats; }
  stats.pushed = rows.length;
  await writeState(admin, "outbound_chargeitem_last_synced_at", rows[rows.length - 1].created_at);
  return stats;
}

async function pollAppointments(admin: any) {
  const since = await readState(admin, "outbound_appointment_last_synced_at");
  const cutoff = new Date().toISOString();
  const { data, error } = await admin
    .from("fhir_appointments")
    .select("id, facility_name, patient_mrn, patient_name, practitioner_name, service_type, description, start_time, end_time, status, comment, updated_at, fhir_id")
    .gt("updated_at", since)
    .is("fhir_id", null) // skip myspehr-originated rows
    .order("updated_at", { ascending: true })
    .limit(BATCH_LIMIT);
  if (error) throw new Error(`appointment query: ${error.message}`);
  const rows = (data ?? []) as any[];
  const stats: any = { since, cutoff, fetched: rows.length, pushed: 0, failed: 0 };
  if (rows.length === 0) {
    await writeState(admin, "outbound_appointment_last_synced_at", cutoff);
    return stats;
  }
  const entries = rows.map((r) => entryFor(buildAppointment(r)));
  const result = await pushBundle(entries);
  if (!result.ok) { stats.failed = rows.length; stats.error = result.body; return stats; }
  stats.pushed = rows.length;
  await writeState(admin, "outbound_appointment_last_synced_at", rows[rows.length - 1].updated_at);
  return stats;
}

/* ---------------- Clinical: per-MRN sweep --------------------------------- */

// Larger scan so a single high-traffic table (e.g. ghost medication cascades)
// can't monopolise the mrn set and starve slower tables like patients/notes.
const CLINICAL_SCAN_LIMIT = 2000;

type MrnRow = { mrn: string; oldest: string; newest: string };

// Collect distinct MRNs touched by any clinical change since the cursor,
// tracking each MRN's OLDEST and NEWEST updated_at across all clinical
// tables. Returned MRNs are sorted by oldest ts ASC — oldest changes get
// pushed first, which matches the cursor-advance guarantee below.
async function collectChangedMrns(
  admin: any,
  since: string,
): Promise<{ selected: MrnRow[]; totalDiscovered: number; firstSkippedOldest: string | null }> {
  const byMrn = new Map<string, MrnRow>();

  const bump = (rows: any[]) => {
    for (const r of rows) {
      const mrn = String(r.mrn ?? r.patient_mrn ?? "");
      const ts = r.updated_at as string | undefined;
      if (!mrn || typeof ts !== "string") continue;
      const cur = byMrn.get(mrn);
      if (!cur) byMrn.set(mrn, { mrn, oldest: ts, newest: ts });
      else {
        if (ts < cur.oldest) cur.oldest = ts;
        if (ts > cur.newest) cur.newest = ts;
      }
    }
  };

  const [meds, labs, results, notes, conds, pats] = await Promise.all([
    admin.from("medication_orders").select("patient_mrn, updated_at").gt("updated_at", since).order("updated_at", { ascending: true }).limit(CLINICAL_SCAN_LIMIT),
    admin.from("lab_orders").select("patient_mrn, updated_at").gt("updated_at", since).order("updated_at", { ascending: true }).limit(CLINICAL_SCAN_LIMIT),
    admin.from("lab_results").select("mrn, updated_at").gt("updated_at", since).order("updated_at", { ascending: true }).limit(CLINICAL_SCAN_LIMIT),
    admin.from("clinical_notes").select("mrn, updated_at").gt("updated_at", since).order("updated_at", { ascending: true }).limit(CLINICAL_SCAN_LIMIT),
    admin.from("conditions").select("mrn, updated_at").gt("updated_at", since).order("updated_at", { ascending: true }).limit(CLINICAL_SCAN_LIMIT),
    admin.from("patients").select("mrn, updated_at").gt("updated_at", since).order("updated_at", { ascending: true }).limit(CLINICAL_SCAN_LIMIT),
  ]);

  if (meds.error) throw new Error(`meds change scan: ${meds.error.message}`);
  if (labs.error) throw new Error(`labs change scan: ${labs.error.message}`);
  if (results.error) throw new Error(`lab_results change scan: ${results.error.message}`);
  if (notes.error) throw new Error(`notes change scan: ${notes.error.message}`);
  if (conds.error) throw new Error(`conditions change scan: ${conds.error.message}`);
  if (pats.error) throw new Error(`patients change scan: ${pats.error.message}`);

  bump((meds.data ?? []) as any[]);
  bump((labs.data ?? []) as any[]);
  bump((results.data ?? []) as any[]);
  bump((notes.data ?? []) as any[]);
  bump((conds.data ?? []) as any[]);
  bump((pats.data ?? []) as any[]);

  const all = [...byMrn.values()].sort((a, b) => (a.oldest < b.oldest ? -1 : a.oldest > b.oldest ? 1 : 0));
  const selected = all.slice(0, CLINICAL_MRN_LIMIT);
  const firstSkippedOldest = all.length > CLINICAL_MRN_LIMIT ? all[CLINICAL_MRN_LIMIT].oldest : null;
  return { selected, totalDiscovered: all.length, firstSkippedOldest };
}

// Build the full FHIR entry list for a single MRN by fetching all of its
// active clinical rows and mapping them through the builders above.
async function buildEntriesForMrn(admin: any, mrn: string): Promise<{ entries: any[]; skipped: string | null }> {
  const [patientRes, medsRes, labsRes, resultsRes, notesRes, condsRes] = await Promise.all([
    admin.from("patients").select("mrn, name, first_name, last_name, dob, gender, biological_sex, phone, address, facility_name, admission_time, discharge_time, status, chief_complaint, diagnosis").eq("mrn", mrn).maybeSingle(),
    admin.from("medication_orders")
      .select("id, drug_name, medication_name, dose, route, status, ordering_physician, ordered_by, administered_at, created_at, updated_at, rxnorm_code, rxnorm_display")
      .eq("patient_mrn", mrn).order("created_at", { ascending: false }).limit(200),
    admin.from("lab_orders")
      .select("id, test_type, result_value, status, collected_at, created_at, loinc_code")
      .eq("patient_mrn", mrn).order("created_at", { ascending: false }).limit(80),
    admin.from("lab_results")
      .select("id, test_name, result_value, unit, reference_range, flag, created_at")
      .eq("mrn", mrn).order("created_at", { ascending: false }).limit(80),
    admin.from("clinical_notes")
      .select("id, note_type, author, content, created_at")
      .eq("mrn", mrn).order("created_at", { ascending: false }).limit(20),
    admin.from("conditions")
      .select("display_text, snomed_code, snomed_display, icd10_code, icd10_display, verification_status, clinical_status, coded_at, created_at")
      .eq("mrn", mrn).order("coded_at", { ascending: false }).limit(20),
  ]);

  const patient = (patientRes as any)?.data;
  if (!patient) return { entries: [], skipped: "no_patient_row" };

  const entries: any[] = [];
  entries.push(entryFor(buildPatientResource(patient)));
  entries.push(entryFor(buildEncounterResource(patient)));

  // Chief-complaint / HPI Condition (mirrors client's `cond-hpi-{mrn}`).
  if (patient.chief_complaint) {
    entries.push(
      entryFor(
        buildCondition(mrn, {
          display_text: patient.chief_complaint,
          verification_status: "provisional",
          coded_at: patient.admission_time,
        }, { type: "hpi", verification: "provisional", recordedDate: patient.admission_time ?? null }),
      ),
    );
  }

  // Additional coded conditions from the `conditions` table.
  let condCounter = 0;
  for (const c of ((condsRes as any)?.data ?? []) as any[]) {
    const token = c.snomed_code ? `snomed-${String(c.snomed_code).replace(/[^A-Za-z0-9]/g, "").slice(0, 20)}`
      : c.icd10_code ? `icd-${String(c.icd10_code).replace(/[^A-Za-z0-9]/g, "").slice(0, 20)}`
      : `pmh-${++condCounter}`;
    entries.push(entryFor(buildCondition(mrn, c, { type: token, verification: "confirmed", recordedDate: c.coded_at ?? c.created_at ?? null })));
  }

  // Medications: emit BOTH MedicationRequest (order intent) AND
  // MedicationAdministration (for rows that reached "Administered"). Dedupe
  // by drug+dose to avoid two identical Requests when the same admission
  // template inserts the same row twice.
  const seenMed = new Set<string>();
  for (const m of ((medsRes as any)?.data ?? []) as any[]) {
    const drug = m.drug_name ?? m.medication_name ?? m.drug ?? "medication";
    const key = `${drug}|${m.dose ?? ""}`.toLowerCase();
    if (seenMed.has(key)) continue;
    seenMed.add(key);
    entries.push(entryFor(buildMedRequest(mrn, m)));
    const raw = String(m.status ?? "").toLowerCase();
    if (raw === "administered" || raw === "completed" || raw === "given") {
      entries.push(entryFor(buildMedAdmin(mrn, m)));
    }
  }

  // Labs: prefer the reported row on lab_orders when it has a result_value,
  // and additionally emit any lab_results rows keyed by their own test_name.
  const seenLab = new Set<string>();
  for (const l of ((labsRes as any)?.data ?? []) as any[]) {
    const key = `${(l.test_type ?? "").toLowerCase()}|${l.loinc_code ?? ""}`;
    if (seenLab.has(key)) continue;
    seenLab.add(key);
    entries.push(entryFor(buildLabObservation(mrn, l)));
  }
  for (const r of ((resultsRes as any)?.data ?? []) as any[]) {
    const key = `${(r.test_name ?? "").toLowerCase()}|`;
    if (seenLab.has(key)) continue;
    seenLab.add(key);
    entries.push(entryFor(buildLabObservation(mrn, r)));
  }

  // Notes: the client hook writes a single DocumentReference keyed
  // `docref-{mrn}` (most recent note wins). Match that.
  const latestNote = (((notesRes as any)?.data ?? []) as any[])[0];
  if (latestNote) entries.push(entryFor(buildDocRef(mrn, latestNote)));

  return { entries, skipped: null };
}

async function pollClinical(admin: any) {
  const since = await readState(admin, "outbound_clinical_last_synced_at");
  const cutoff = new Date().toISOString();
  const stats: any = {
    since, cutoff, discovered: 0, mrns: 0, entries: 0,
    pushed: 0, failed: 0, skipped: [] as any[],
  };

  const { selected, totalDiscovered, firstSkippedOldest } = await collectChangedMrns(admin, since);
  stats.discovered = totalDiscovered;
  stats.mrns = selected.length;
  if (selected.length === 0) {
    // No changes since `since`. Advance to `cutoff` so we don't re-scan
    // the same empty window on every tick.
    await writeState(admin, "outbound_clinical_last_synced_at", cutoff);
    stats.cursorTo = cutoff;
    return stats;
  }

  // Push oldest-first so a single bad MRN doesn't fail the whole batch and
  // so the cursor-advance rule below is monotonic.
  let lastFullyProcessedNewest: string | null = null;
  for (const row of selected) {
    const mrn = row.mrn;
    let built: { entries: any[]; skipped: string | null } | null = null;
    try {
      built = await buildEntriesForMrn(admin, mrn);
    } catch (e) {
      stats.failed += 1;
      stats.skipped.push({ mrn, reason: `build_error: ${(e as Error).message}` });
      continue;
    }
    if (built.skipped || built.entries.length === 0) {
      stats.skipped.push({ mrn, reason: built.skipped ?? "no_entries" });
      // No push needed — safe to advance the cursor past this MRN.
      lastFullyProcessedNewest = row.newest;
      continue;
    }
    stats.entries += built.entries.length;
    const result = await pushBundle(built.entries);
    if (!result.ok) {
      stats.failed += 1;
      stats.skipped.push({ mrn, reason: `push_${result.status}`, body: result.body });
      // Do NOT advance past a failed push — next run retries this MRN.
      continue;
    }
    stats.pushed += 1;
    lastFullyProcessedNewest = row.newest;
  }

  // Cursor-advance rule:
  //  • If any MRN was skipped past the per-cycle CLINICAL_MRN_LIMIT, NEVER
  //    advance past that MRN's oldest touched ts, or we'd permanently miss
  //    it. Set cursor to just before that ts (1µs earlier) so next run's
  //    `.gt()` picks it up.
  //  • Otherwise advance to the newest ts we processed to completion,
  //    falling back to `since` (never regressing).
  let newCursor: string;
  if (firstSkippedOldest) {
    const rewind = subtractOneMicrosecond(firstSkippedOldest);
    newCursor = lastFullyProcessedNewest && rewind < lastFullyProcessedNewest ? rewind : rewind;
  } else if (lastFullyProcessedNewest) {
    newCursor = lastFullyProcessedNewest;
  } else {
    newCursor = since;
  }
  if (newCursor < since) newCursor = since;
  await writeState(admin, "outbound_clinical_last_synced_at", newCursor);
  stats.cursorTo = newCursor;
  return stats;
}

// Postgres text ts has microsecond precision. Subtract 1µs so the next scan's
// `.gt()` re-includes the row at `ts`.
function subtractOneMicrosecond(ts: string): string {
  const m = /^(.*\.)(\d{1,6})(.*)$/.exec(ts);
  if (!m) {
    const d = new Date(ts);
    return isNaN(d.getTime()) ? ts : new Date(d.getTime() - 1).toISOString();
  }
  const digits = m[2].padEnd(6, "0");
  const n = BigInt(digits) - 1n;
  if (n < 0n) {
    const d = new Date(ts);
    return isNaN(d.getTime()) ? ts : new Date(d.getTime() - 1).toISOString();
  }
  return `${m[1]}${n.toString().padStart(6, "0")}${m[3]}`;
}

/* ---------------- Entry point ------------------------------------------- */

async function logEvent(admin: any, payload: any) {
  try {
    await admin.from("auto_doc_logs").insert({
      run_id: `fhir-outbound-poll-${Date.now()}`,
      step: "fhir-outbound-poll",
      status: payload.ok ? "success" : "error",
      payload,
    });
  } catch { /* best-effort */ }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST" && req.method !== "GET") {
    return json({ ok: false, error: "method_not_allowed" }, 405);
  }
  if (!FHIR_SERVER_URL || !FHIR_BEARER_TOKEN) {
    return json({ ok: false, error: "FHIR_SERVER_URL/FHIR_BEARER_TOKEN not configured" }, 500);
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  try {
    const invoice = await pollInvoices(admin);
    const chargeItem = await pollChargeItems(admin);
    const appointment = await pollAppointments(admin);
    // Clinical push runs last so a slow/blocked FHIR write on many entries
    // never delays billing (which is the tighter demo dependency).
    const clinical = await pollClinical(admin);
    const result = { ok: true, ranAt: new Date().toISOString(), invoice, chargeItem, appointment, clinical };
    await logEvent(admin, result);
    return json(result);
  } catch (e) {
    const err = { ok: false, error: (e as Error).message };
    console.error("[fhir-outbound-poll]", e);
    await logEvent(admin, err);
    return json(err, 500);
  }
});