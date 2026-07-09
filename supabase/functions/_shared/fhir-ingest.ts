// Shared FHIR-inbound ingestion. Consumed by both:
//   • supabase/functions/fhir-inbound-webhook  (Medblocks rest-hook push)
//   • supabase/functions/fhir-inbound-poll     (cron pull fallback)
//
// Handles resources written by any partner account tagged under
// `urn:spehr:source`:
//   • `myspehr`         → Appointment / PaymentNotice
//   • `labs-pharm-rad`  → Observation (laboratory) result writebacks
// Upserts into the local mirror tables and writes an audit row to
// `auto_doc_logs`. Idempotent on `fhir_id` (or lab_orders.svcreq_fhir_id).

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

function categoryIncludes(resource: any, wantedCode: string): boolean {
  const cats = resource?.category;
  if (!Array.isArray(cats)) return false;
  for (const c of cats) {
    const coding = c?.coding;
    if (!Array.isArray(coding)) continue;
    if (coding.some((x: any) => x?.code === wantedCode)) return true;
  }
  return false;
}

function loincFromResource(resource: any): string | null {
  const coding = resource?.code?.coding;
  if (!Array.isArray(coding)) return null;
  const hit = coding.find(
    (c: any) => typeof c?.system === "string" && c.system.toLowerCase().includes("loinc"),
  );
  return hit?.code ?? null;
}

function deriveFlag(resource: any): string | null {
  const value = Number(resource?.valueQuantity?.value);
  const ranges = resource?.referenceRange;
  if (!Number.isFinite(value) || !Array.isArray(ranges) || ranges.length === 0) return null;
  const rr = ranges[0] ?? {};
  const low = Number(rr?.low?.value);
  const high = Number(rr?.high?.value);
  if (Number.isFinite(low) && value < low) return "Low";
  if (Number.isFinite(high) && value > high) return "High";
  return "Normal";
}

function extractLabValueText(resource: any): string | null {
  const vq = resource?.valueQuantity;
  if (vq && (vq.value !== undefined && vq.value !== null)) {
    const unit = vq.unit ? ` ${vq.unit}` : "";
    return `${vq.value}${unit}`.trim();
  }
  if (typeof resource?.valueString === "string") return resource.valueString;
  if (resource?.valueCodeableConcept?.text) return String(resource.valueCodeableConcept.text);
  return null;
}

// Handle Observation resources written back by the Labs/Pharmacy/Radiology
// account (`urn:spehr:source|labs-pharm-rad`). Matches to a local lab_orders
// row via the ServiceRequest id SPEHR pushed as `basedOn`, falling back to
// (patient_mrn + LOINC/test_type). Inserts a new lab_orders row when no
// match exists so labs originated entirely by the partner account still
// appear in SPEHR (tagged `source = 'labs-pharm-rad'`).
async function handleLabObservation(admin: any, resource: any): Promise<IngestOutcome> {
  const fhirId = String(resource?.id ?? "");
  if (!fhirId) return { ok: false, reason: "missing_id" };

  // Only ingest labs written by the partner Labs account.
  const src = tagCode(resource, "urn:spehr:source");
  if (src === "spehr") return { ok: true, skipped: "self-tagged" };
  if (src !== "labs-pharm-rad") return { ok: true, skipped: "unsupported_source" };
  if (!categoryIncludes(resource, "laboratory")) {
    return { ok: true, skipped: "not_lab_category" };
  }

  const subjectMrn = refIdOf(resource?.subject?.reference);
  if (!subjectMrn) return { ok: false, reason: "missing_subject" };

  const svcReqRef = (resource?.basedOn ?? [])
    .map((b: any) => b?.reference)
    .find((r: string | undefined) => typeof r === "string" && r.startsWith("ServiceRequest/"));
  const svcReqId = refIdOf(svcReqRef);

  const loinc = loincFromResource(resource);
  const testText =
    resource?.code?.text ??
    resource?.code?.coding?.[0]?.display ??
    "Lab result";
  const resultText = extractLabValueText(resource);
  const unit = resource?.valueQuantity?.unit ?? null;
  const flag = deriveFlag(resource);

  // 1) Prefer match by svcreq_fhir_id.
  let matched: any = null;
  if (svcReqId) {
    const q = await admin
      .from("lab_orders")
      .select("id")
      .eq("svcreq_fhir_id", svcReqId)
      .maybeSingle();
    matched = q.data ?? null;
  }

  // 2) Fall back to (patient_mrn + LOINC) or (patient_mrn + test_type).
  if (!matched) {
    let q = admin.from("lab_orders").select("id").eq("patient_mrn", subjectMrn);
    if (loinc) q = q.eq("loinc_code", loinc);
    else q = q.eq("test_type", testText);
    const res = await q.order("created_at", { ascending: false }).limit(1).maybeSingle();
    matched = res.data ?? null;
  }

  const patch: Record<string, unknown> = {
    result_value: resultText,
    status: "resulted",
    resulted_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  if (svcReqId) patch.svcreq_fhir_id = svcReqId;
  if (flag) patch.results_data = { flag, referenceRange: resource?.referenceRange ?? null };

  if (matched) {
    const { error } = await admin.from("lab_orders").update(patch).eq("id", matched.id);
    if (error) return { ok: false, reason: error.message };
    return { ok: true, action: "updated", localId: matched.id, mrn: subjectMrn };
  }

  // 3) No match — insert a new row so partner-originated labs show up.
  const insertRow: Record<string, unknown> = {
    patient_mrn: subjectMrn,
    patient_name: "External Lab Result",
    facility_name: "Health Hub Suite",
    requested_by: "labs-pharm-rad",
    test_type: testText,
    status: "resulted",
    result_value: resultText,
    loinc_code: loinc,
    svcreq_fhir_id: svcReqId,
    source: "labs-pharm-rad",
    resulted_at: new Date().toISOString(),
    created_by_type: "system",
  };
  const ins = await admin.from("lab_orders").insert(insertRow).select("id").maybeSingle();
  if (ins.error) return { ok: false, reason: ins.error.message };
  return { ok: true, action: "inserted", localId: ins.data?.id, mrn: subjectMrn };
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
    else if (rt === "Observation") outcome = await handleLabObservation(admin, resource);
    else if (rt === "DiagnosticReport") outcome = await handleRadiologyReport(admin, resource);
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