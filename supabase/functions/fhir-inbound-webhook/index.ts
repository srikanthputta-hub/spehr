// Inbound FHIR webhook — receives resources pushed FROM Medblocks by the
// two Subscription resources we register (Appointment and PaymentNotice
// tagged `urn:spehr:source|myspehr`). Upserts into local mirror tables so
// the finance / booking UI reflects what the MySPEHR patient portal did.
//
// Auth: query-string `?key=<FHIR_WEBHOOK_SECRET>`. Missing/wrong → 401.
// Body: a full FHIR resource JSON (Subscription.channel.payload =
//   "application/fhir+json"), NOT a Bundle.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const WEBHOOK_SECRET = Deno.env.get("FHIR_WEBHOOK_SECRET") ?? "";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "content-type": "application/json" },
  });
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function refIdOf(ref: string | undefined | null): string | null {
  if (!ref) return null;
  const parts = String(ref).split("/");
  return parts[parts.length - 1] || null;
}

function tagCode(resource: any, system: string): string | null {
  const tags = resource?.meta?.tag;
  if (!Array.isArray(tags)) return null;
  const hit = tags.find((t: any) => t?.system === system);
  return hit?.code ?? null;
}

async function logEvent(admin: any, params: {
  mrn: string;
  message: string;
  level?: "info" | "warn" | "error";
  meta?: Record<string, unknown>;
}) {
  try {
    await admin.from("auto_doc_logs").insert({
      mrn: params.mrn || "unknown",
      stage: "fhir-inbound-webhook",
      level: params.level ?? "info",
      message: params.message,
      meta: params.meta ?? null,
      created_by_type: "system",
    });
  } catch (e) {
    console.warn("[fhir-inbound-webhook] log insert failed", e);
  }
}

async function handleAppointment(admin: any, resource: any) {
  const fhirId = String(resource?.id ?? "");
  if (!fhirId) return { ok: false, reason: "missing_id" };

  // Skip our own writes
  if (tagCode(resource, "urn:spehr:source") === "spehr") {
    return { ok: true, skipped: "self-tagged" };
  }

  let patientMrn: string | null = null;
  let patientName: string | null = null;
  let practitionerName: string | null = null;
  for (const p of (resource?.participant ?? []) as any[]) {
    const ref: string = p?.actor?.reference ?? "";
    if (ref.startsWith("Patient/") && !patientMrn) {
      patientMrn = refIdOf(ref);
      patientName = p?.actor?.display ?? patientName;
    } else if (ref.startsWith("Practitioner/") && !practitionerName) {
      practitionerName = p?.actor?.display ?? null;
    } else if (!ref && p?.actor?.display && !practitionerName) {
      practitionerName = p?.actor?.display;
    }
  }

  const start = resource?.start ?? null;
  const end = resource?.end ?? resource?.start ?? null;
  if (!start || !end) return { ok: false, reason: "missing_time" };

  const row = {
    fhir_id: fhirId,
    facility_name:
      resource?.location?.[0]?.display ??
      resource?.location?.[0]?.reference ??
      "MySPEHR Portal",
    patient_mrn: patientMrn,
    patient_name: patientName ?? "MySPEHR Patient",
    practitioner_name: practitionerName,
    service_type:
      resource?.serviceType?.[0]?.text ??
      resource?.serviceType?.[0]?.coding?.[0]?.display ??
      null,
    description: resource?.description ?? null,
    start_time: start,
    end_time: end,
    status: resource?.status ?? "booked",
    comment: resource?.comment ?? null,
  };

  const { data, error } = await admin
    .from("fhir_appointments")
    .upsert(row, { onConflict: "fhir_id" })
    .select("id")
    .maybeSingle();

  if (error) return { ok: false, reason: error.message };
  return { ok: true, action: "upserted", localId: data?.id, mrn: patientMrn };
}

async function handlePaymentNotice(admin: any, resource: any) {
  const fhirId = String(resource?.id ?? "");
  if (!fhirId) return { ok: false, reason: "missing_id" };

  if (tagCode(resource, "urn:spehr:source") === "spehr") {
    return { ok: true, skipped: "self-tagged" };
  }

  // Resolve the referenced Invoice.
  const invoiceRef: string =
    resource?.request?.reference ??
    resource?.paymentReference?.reference ??
    "";
  const invoiceKey = refIdOf(invoiceRef);

  let invoiceRow: any = null;
  if (invoiceKey) {
    // Try invoice_no (that's what we push as the FHIR Invoice id),
    // then fall back to matching payload.id and finally the local uuid.
    const byNo = await admin
      .from("fhir_invoices")
      .select("id, mrn, invoice_no")
      .eq("invoice_no", invoiceKey)
      .maybeSingle();
    invoiceRow = byNo.data ?? null;

    if (!invoiceRow) {
      const byPayloadId = await admin
        .from("fhir_invoices")
        .select("id, mrn, invoice_no")
        .filter("payload->>id", "eq", invoiceKey)
        .maybeSingle();
      invoiceRow = byPayloadId.data ?? null;
    }
    if (!invoiceRow) {
      // last-chance uuid match
      const looksUuid = /^[0-9a-f-]{36}$/i.test(invoiceKey);
      if (looksUuid) {
        const byId = await admin
          .from("fhir_invoices")
          .select("id, mrn, invoice_no")
          .eq("id", invoiceKey)
          .maybeSingle();
        invoiceRow = byId.data ?? null;
      }
    }
  }

  if (!invoiceRow) {
    return { ok: false, reason: "invoice_not_found", invoiceRef };
  }

  const amountValue = Number(resource?.amount?.value ?? 0);
  const currency = resource?.amount?.currency ?? "USD";
  const status =
    resource?.paymentStatus?.coding?.[0]?.code ??
    resource?.paymentStatus?.text ??
    "paid";
  const created = resource?.created ?? new Date().toISOString();

  const row = {
    fhir_id: fhirId,
    invoice_id: invoiceRow.id,
    mrn: invoiceRow.mrn,
    amount: amountValue,
    currency,
    status,
    payment_date: created,
    payment_method:
      resource?.paymentMethod?.text ??
      resource?.paymentMethod?.coding?.[0]?.display ??
      null,
    payload: resource,
  };

  const { data, error } = await admin
    .from("fhir_payment_notices")
    .upsert(row, { onConflict: "fhir_id" })
    .select("id")
    .maybeSingle();

  if (error) return { ok: false, reason: error.message };
  return {
    ok: true,
    action: "upserted",
    localId: data?.id,
    mrn: invoiceRow.mrn,
    invoiceNo: invoiceRow.invoice_no,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);

  if (!WEBHOOK_SECRET) {
    console.error("[fhir-inbound-webhook] FHIR_WEBHOOK_SECRET is not configured");
    return json({ ok: false, error: "server_not_configured" }, 500);
  }
  const url = new URL(req.url);
  const providedKey = url.searchParams.get("key") ?? "";
  if (!timingSafeEqual(providedKey, WEBHOOK_SECRET)) {
    return json({ ok: false, error: "unauthorized" }, 401);
  }

  let resource: any;
  try {
    resource = await req.json();
  } catch {
    return json({ ok: false, error: "invalid_json" }, 400);
  }
  const rt = resource?.resourceType;
  if (!rt) return json({ ok: false, error: "missing_resourceType" }, 400);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  let outcome: any = { ok: true, skipped: "unsupported_type" };
  try {
    if (rt === "Appointment") outcome = await handleAppointment(admin, resource);
    else if (rt === "PaymentNotice") outcome = await handlePaymentNotice(admin, resource);
  } catch (e) {
    outcome = { ok: false, reason: (e as Error).message };
  }

  const mrn = outcome?.mrn ?? "unknown";
  await logEvent(admin, {
    mrn,
    level: outcome?.ok ? "info" : "warn",
    message: `inbound ${rt}/${resource?.id ?? "?"} → ${
      outcome?.ok ? outcome?.action ?? outcome?.skipped ?? "ok" : outcome?.reason
    }`,
    meta: { resourceType: rt, fhirId: resource?.id, outcome },
  });

  return json({ received: rt, id: resource?.id, outcome }, outcome?.ok ? 200 : 202);
});