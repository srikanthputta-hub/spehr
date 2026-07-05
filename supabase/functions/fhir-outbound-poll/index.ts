// Outbound FHIR poll — server-side, browser-independent push of
// billing/appointment resources to Medblocks.
//
// Runs on a pg_cron schedule (every ~30-45s). Reads the three durable
// cursors from `public.fhir_sync_state`:
//    outbound_invoice_last_synced_at
//    outbound_chargeitem_last_synced_at
//    outbound_appointment_last_synced_at
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

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const FHIR_SERVER_URL = (Deno.env.get("FHIR_SERVER_URL") ?? "").replace(/\/+$/, "");
const FHIR_BEARER_TOKEN = Deno.env.get("FHIR_BEARER_TOKEN") ?? "";
const FHIR_APIKEY = Deno.env.get("FHIR_APIKEY") ?? "";

const BATCH_LIMIT = 200;

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
    const result = { ok: true, ranAt: new Date().toISOString(), invoice, chargeItem, appointment };
    await logEvent(admin, result);
    return json(result);
  } catch (e) {
    const err = { ok: false, error: (e as Error).message };
    console.error("[fhir-outbound-poll]", e);
    await logEvent(admin, err);
    return json(err, 500);
  }
});