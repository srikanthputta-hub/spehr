// Shared FHIR-inbound ingestion. Consumed by both:
//   • supabase/functions/fhir-inbound-webhook  (Medblocks rest-hook push)
//   • supabase/functions/fhir-inbound-poll     (cron pull fallback)
//
// Given a single FHIR resource (Appointment or PaymentNotice tagged
// `urn:spehr:source|myspehr`), upserts into the local mirror tables and
// writes an audit row to `auto_doc_logs`. Idempotent on `fhir_id`.

export type IngestOutcome =
  | { ok: true; action?: string; skipped?: string; localId?: string; mrn?: string; invoiceNo?: string }
  | { ok: false; reason: string; [key: string]: unknown };

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

async function handleAppointment(admin: any, resource: any): Promise<IngestOutcome> {
  const fhirId = String(resource?.id ?? "");
  if (!fhirId) return { ok: false, reason: "missing_id" };

  // Skip our own writes so we never echo-loop.
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
  return { ok: true, action: "upserted", localId: data?.id, mrn: patientMrn ?? undefined };
}

async function handlePaymentNotice(admin: any, resource: any): Promise<IngestOutcome> {
  const fhirId = String(resource?.id ?? "");
  if (!fhirId) return { ok: false, reason: "missing_id" };

  if (tagCode(resource, "urn:spehr:source") === "spehr") {
    return { ok: true, skipped: "self-tagged" };
  }

  const invoiceRef: string =
    resource?.request?.reference ??
    resource?.paymentReference?.reference ??
    "";
  const invoiceKey = refIdOf(invoiceRef);

  let invoiceRow: any = null;
  if (invoiceKey) {
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

export async function ingestFhirResource(admin: any, resource: any): Promise<{
  outcome: IngestOutcome;
  resourceType: string | null;
  fhirId: string | null;
}> {
  const rt = resource?.resourceType ?? null;
  const fhirId = resource?.id ?? null;
  let outcome: IngestOutcome = { ok: true, skipped: "unsupported_type" };
  try {
    if (rt === "Appointment") outcome = await handleAppointment(admin, resource);
    else if (rt === "PaymentNotice") outcome = await handlePaymentNotice(admin, resource);
  } catch (e) {
    outcome = { ok: false, reason: (e as Error).message };
  }
  return { outcome, resourceType: rt, fhirId };
}

export async function logIngestEvent(admin: any, params: {
  source: "webhook" | "poll";
  resourceType: string | null;
  fhirId: string | null;
  outcome: IngestOutcome;
}) {
  const mrn = (params.outcome as any)?.mrn ?? "unknown";
  const okAction =
    params.outcome.ok
      ? (params.outcome as any).action ?? (params.outcome as any).skipped ?? "ok"
      : (params.outcome as any).reason;
  try {
    await admin.from("auto_doc_logs").insert({
      mrn: mrn || "unknown",
      stage: `fhir-inbound-${params.source}`,
      level: params.outcome.ok ? "info" : "warn",
      message: `${params.source} ${params.resourceType ?? "?"}/${params.fhirId ?? "?"} → ${okAction}`,
      meta: {
        source: params.source,
        resourceType: params.resourceType,
        fhirId: params.fhirId,
        outcome: params.outcome,
      },
      created_by_type: "system",
    });
  } catch (e) {
    console.warn("[fhir-ingest] log insert failed", e);
  }
}