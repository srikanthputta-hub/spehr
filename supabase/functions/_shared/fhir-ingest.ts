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
  | {
      ok: true;
      action?: string;
      skipped?: string;
      localId?: string;
      mrn?: string;
      invoiceNo?: string;
    }
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

function hasTag(resource: any, system: string, code: string): boolean {
  const tags = resource?.meta?.tag;
  if (!Array.isArray(tags)) return false;
  return tags.some((t: any) => t?.system === system && t?.code === code);
}

// Body-level extension (not `meta.tag`) — see buildAppointment in
// fhir-outbound-poll/index.ts, which stamps `urn:spehr:last-writer` on
// every appointment it PUTs. `meta.tag` carry-forward across HAPI resource
// versions is unverified, so this is a second, independent signal for the
// self-echo check below.
function extCode(resource: any, url: string): string | null {
  const exts = resource?.extension;
  if (!Array.isArray(exts)) return null;
  const hit = exts.find((e: any) => e?.url === url);
  return hit?.valueCode ?? null;
}

// FHIR Appointment.status rank for the monotonicity check in
// handleAppointment. Terminal statuses (cancelled/noshow/entered-in-error)
// are handled separately, not via this rank.
//
// `waitlist` (a request that couldn't be immediately booked and is queued
// for a slot) ranks just below `pending`, per FHIR's own guidance that it's
// roughly equivalent-to-or-prior-to `pending` in the request lifecycle.
// `checked-in` gets its own rank distinct from `arrived` — FHIR defines
// them as separate statuses, and clinically arriving at the facility
// precedes being checked in, which in turn precedes the visit itself
// (`fulfilled`).
const APPOINTMENT_STATUS_RANK: Record<string, number> = {
  proposed: 1,
  waitlist: 2,
  pending: 3,
  booked: 4,
  arrived: 5,
  "checked-in": 6,
  fulfilled: 7,
};
const TERMINAL_APPOINTMENT_STATUSES = new Set(["cancelled", "noshow", "entered-in-error"]);

async function handleAppointment(admin: any, resource: any): Promise<IngestOutcome> {
  const fhirId = String(resource?.id ?? "");
  if (!fhirId) return { ok: false, reason: "missing_id" };

  // Skip our own writes so we never echo-loop. Three independent signals,
  // any of which is sufficient:
  //  1. The classic single-tag check (`meta.tag` system=source code=spehr).
  //  2. The body-level `urn:spehr:last-writer` extension spehr stamps on
  //     every push — survives even if HAPI drops/rewrites `meta.tag` across
  //     versions, which is unverified behavior on this tenant.
  //  3. Has the spehr source tag AND does NOT have the myspehr source tag —
  //     covers a HAPI that carries tags forward additively (both present)
  //     vs. one that replaces them outright.
  const hasSpehrTag = hasTag(resource, "urn:spehr:source", "spehr");
  const hasMyspehrTag = hasTag(resource, "urn:spehr:source", "myspehr");
  if (
    tagCode(resource, "urn:spehr:source") === "spehr" ||
    extCode(resource, "urn:spehr:last-writer") === "spehr" ||
    (hasSpehrTag && !hasMyspehrTag)
  ) {
    return { ok: true, skipped: "self-tagged" };
  }

  // Look up the existing local row (if any) by fhir_id for the
  // monotonicity check and the facility-name / origin preservation below.
  const { data: existing } = await admin
    .from("fhir_appointments")
    .select("id, status, origin, facility_name")
    .eq("fhir_id", fhirId)
    .maybeSingle();

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

  let facilityName: string =
    resource?.location?.[0]?.display ?? resource?.location?.[0]?.reference ?? "";
  if (!facilityName && patientMrn) {
    try {
      const { data: pat } = await admin
        .from("patients")
        .select("facility_name")
        .eq("mrn", patientMrn)
        .limit(1)
        .maybeSingle();
      if (pat?.facility_name) facilityName = pat.facility_name;
    } catch (_) {
      /* ignore */
    }
  }
  if (!facilityName) {
    // Don't clobber a real local facility_name with the generic portal
    // fallback just because THIS particular FHIR write didn't carry a
    // location — e.g. a myspehr status-only PUT that omits `location`.
    facilityName =
      existing?.facility_name && existing.facility_name !== "MySPEHR Portal"
        ? existing.facility_name
        : "MySPEHR Portal";
  }

  // Monotonic status: a stale FHIR read arriving after a local change (e.g.
  // reception already confirmed `booked`, then an out-of-order webhook
  // delivery re-delivers the patient's earlier `proposed` write) must not
  // regress the local record. Terminal statuses are always accepted as an
  // exception, UNLESS the local appointment already reached `fulfilled`
  // (a completed visit can't un-complete).
  const incomingStatus = String(resource?.status ?? "booked").toLowerCase();
  const existingStatus = existing?.status ? String(existing.status).toLowerCase() : null;
  let finalStatus = incomingStatus;
  let needsFhirPush = false;
  if (existingStatus) {
    const isTerminal = TERMINAL_APPOINTMENT_STATUSES.has(incomingStatus);
    if (isTerminal) {
      if (existingStatus === "fulfilled") {
        // Local already completed — keep it, and push it back out so FHIR
        // reconciles to `fulfilled` instead of the stale terminal status.
        finalStatus = existingStatus;
        needsFhirPush = true;
      } else {
        finalStatus = incomingStatus;
      }
    } else {
      const existingRank = APPOINTMENT_STATUS_RANK[existingStatus] ?? 0;
      const incomingRank = APPOINTMENT_STATUS_RANK[incomingStatus] ?? 0;
      if (existingRank > 0 && incomingRank > 0 && incomingRank < existingRank) {
        // Stale/regressive write — keep the local (higher-ranked) status,
        // but flag it dirty so the next outbound push reconciles FHIR back
        // up to the correct status.
        finalStatus = existingStatus;
        needsFhirPush = true;
      } else {
        finalStatus = incomingStatus;
      }
    }
  }

  const row: Record<string, unknown> = {
    fhir_id: fhirId,
    facility_name: facilityName,
    patient_mrn: patientMrn,
    patient_name: patientName ?? "MySPEHR Patient",
    practitioner_name: practitionerName,
    service_type:
      resource?.serviceType?.[0]?.text ?? resource?.serviceType?.[0]?.coding?.[0]?.display ?? null,
    description: resource?.description ?? null,
    start_time: start,
    end_time: end,
    status: finalStatus,
    comment: resource?.comment ?? null,
    last_ingested_status: incomingStatus,
    last_ingested_at: new Date().toISOString(),
    origin: existing?.origin ?? "myspehr",
  };
  if (needsFhirPush) row.needs_fhir_push = true;

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
    resource?.request?.reference ?? resource?.paymentReference?.reference ?? "";
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
    resource?.paymentStatus?.coding?.[0]?.code ?? resource?.paymentStatus?.text ?? "paid";
  const created = resource?.created ?? new Date().toISOString();

  // Derive payment_origin from the inbound resource's own source tag —
  // 'myspehr' means the patient actually paid through the portal,
  // 'billing-pophealth' is the billing/pop-health partner account. Any
  // other/absent tag is left null so the `set_payment_notice_origin` DB
  // trigger falls back to 'staff'. (This ingest path only ever sees
  // resources NOT self-tagged 'spehr' — see the early return above — so
  // it never re-classifies our own auto-pay-timeout notices, which are
  // inserted directly by auto_pay_overdue_invoices(), not ingested here.)
  const sourceTag = tagCode(resource, "urn:spehr:source");
  const paymentOrigin: string | null =
    sourceTag === "myspehr"
      ? "patient-portal"
      : sourceTag === "billing-pophealth"
        ? "billing-pophealth"
        : null;

  const row = {
    fhir_id: fhirId,
    invoice_id: invoiceRow.id,
    mrn: invoiceRow.mrn,
    amount: amountValue,
    currency,
    status,
    payment_date: created,
    payment_method:
      resource?.paymentMethod?.text ?? resource?.paymentMethod?.coding?.[0]?.display ?? null,
    payment_origin: paymentOrigin,
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
  if (vq && vq.value !== undefined && vq.value !== null) {
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
  const testText = resource?.code?.text ?? resource?.code?.coding?.[0]?.display ?? "Lab result";
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

// ---- DiagnosticReport (radiology) ingestion ----
//
// Accepts inbound DiagnosticReport resources written by the partner
// Imaging/Radiology account (`urn:spehr:source|labs-pharm-rad`). Matches to
// a local `radiology_orders` row by `basedOn` ServiceRequest reference
// (svcreq_fhir_id) with a fallback to (patient_mrn + exam_type). Category
// detection is intentionally permissive — HL7 uses "RAD", DICOM often
// uses "imaging", some senders use "radiology" — we accept any of them
// case-insensitively in either code or text.

function isImagingReport(resource: any): boolean {
  const cats = resource?.category;
  if (!Array.isArray(cats)) return false;
  const needle = /(imag|radiolog|rad|dxi)/i;
  for (const c of cats) {
    if (typeof c?.text === "string" && needle.test(c.text)) return true;
    for (const coding of c?.coding ?? []) {
      if (typeof coding?.code === "string" && needle.test(coding.code)) return true;
      if (typeof coding?.display === "string" && needle.test(coding.display)) return true;
    }
  }
  return false;
}

function base64DecodeSafe(input: string | null | undefined): string | null {
  if (!input) return null;
  try {
    // Deno + browsers both expose atob; DiagnosticReport.presentedForm.data is base64.
    return atob(input);
  } catch {
    return null;
  }
}

async function handleRadiologyReport(admin: any, resource: any): Promise<IngestOutcome> {
  const fhirId = String(resource?.id ?? "");
  if (!fhirId) return { ok: false, reason: "missing_id" };

  const src = tagCode(resource, "urn:spehr:source");
  if (src === "spehr") return { ok: true, skipped: "self-tagged" };
  if (src !== "labs-pharm-rad") return { ok: true, skipped: "unsupported_source" };
  if (!isImagingReport(resource)) {
    return { ok: true, skipped: "not_imaging_category" };
  }

  const subjectMrn = refIdOf(resource?.subject?.reference);
  if (!subjectMrn) return { ok: false, reason: "missing_subject" };

  const svcReqRef = (resource?.basedOn ?? [])
    .map((b: any) => b?.reference)
    .find((r: string | undefined) => typeof r === "string" && r.startsWith("ServiceRequest/"));
  const svcReqId = refIdOf(svcReqRef);

  const codeText = resource?.code?.text ?? resource?.code?.coding?.[0]?.display ?? "Imaging study";
  const snomedHit = (resource?.code?.coding ?? []).find(
    (c: any) => typeof c?.system === "string" && c.system.toLowerCase().includes("snomed"),
  );
  const snomedCode = snomedHit?.code ?? null;

  const conclusion: string | null = resource?.conclusion ?? null;
  const presentedB64: string | null = resource?.presentedForm?.[0]?.data ?? null;
  const reportText = conclusion ?? base64DecodeSafe(presentedB64);

  // Scan presentedForm for an image entry (contentType image/*, url set).
  const presentedForms: any[] = Array.isArray(resource?.presentedForm)
    ? resource.presentedForm
    : [];
  const imageEntry = presentedForms.find(
    (p: any) =>
      typeof p?.contentType === "string" &&
      p.contentType.toLowerCase().startsWith("image/") &&
      typeof p?.url === "string" &&
      p.url,
  );
  const imageUrl: string | null = imageEntry?.url ?? null;

  // 1) Prefer match by svcreq_fhir_id.
  let matched: any = null;
  if (svcReqId) {
    const q = await admin
      .from("radiology_orders")
      .select("id")
      .eq("svcreq_fhir_id", svcReqId)
      .maybeSingle();
    matched = q.data ?? null;
  }

  // 2) Fallback: (patient_mrn + exam_type).
  if (!matched) {
    const res = await admin
      .from("radiology_orders")
      .select("id")
      .eq("patient_mrn", subjectMrn)
      .eq("exam_type", codeText)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    matched = res.data ?? null;
  }

  const patch: Record<string, unknown> = {
    status: "resulted",
    resulted_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  if (reportText) patch.report_text = reportText;
  if (conclusion) patch.impression = conclusion;
  if (svcReqId) patch.svcreq_fhir_id = svcReqId;
  if (imageUrl) patch.image_url = imageUrl;

  if (matched) {
    const { error } = await admin.from("radiology_orders").update(patch).eq("id", matched.id);
    if (error) return { ok: false, reason: error.message };
    return { ok: true, action: "updated", localId: matched.id, mrn: subjectMrn };
  }

  const insertRow: Record<string, unknown> = {
    patient_mrn: subjectMrn,
    patient_name: "External Imaging Result",
    facility_name: "Health Hub Suite",
    requested_by: "labs-pharm-rad",
    exam_type: codeText,
    snomed_code: snomedCode,
    snomed_display: snomedHit?.display ?? codeText,
    status: "resulted",
    report_text: reportText,
    impression: conclusion,
    svcreq_fhir_id: svcReqId,
    source: "labs-pharm-rad",
    resulted_at: new Date().toISOString(),
    created_by_type: "system",
  };
  if (imageUrl) insertRow.image_url = imageUrl;
  const ins = await admin.from("radiology_orders").insert(insertRow).select("id").maybeSingle();
  if (ins.error) return { ok: false, reason: ins.error.message };
  return { ok: true, action: "inserted", localId: ins.data?.id, mrn: subjectMrn };
}

export async function ingestFhirResource(
  admin: any,
  resource: any,
): Promise<{
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

export async function logIngestEvent(
  admin: any,
  params: {
    source: "webhook" | "poll";
    resourceType: string | null;
    fhirId: string | null;
    outcome: IngestOutcome;
  },
) {
  const mrn = (params.outcome as any)?.mrn ?? "unknown";
  const okAction = params.outcome.ok
    ? ((params.outcome as any).action ?? (params.outcome as any).skipped ?? "ok")
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
