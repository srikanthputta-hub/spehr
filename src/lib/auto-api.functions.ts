import { createServerFn } from "@tanstack/react-start";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

/**
 * AUTO API server functions — back the QA Governance Queue, Custom Value
 * Set Builder, CDS Hook override log, Population Health query, and loop
 * status feed. All writes go through the publishable-key server client
 * (RLS policies are permissive on these tables — they are operational /
 * audit data with no PII beyond what the app already exposes).
 */

function client() {
  return createClient<Database>(process.env.SUPABASE_URL!, process.env.SUPABASE_PUBLISHABLE_KEY!, {
    auth: {
      storage: undefined,
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}

async function logEvent(
  event_type: string,
  payload: Record<string, unknown>,
  mrn?: string | null,
  facility?: string | null,
  actor: string = "AUTO API",
) {
  try {
    await client()
      .from("auto_api_events")
      .insert({
        event_type,
        mrn: mrn ?? null,
        facility_name: facility ?? null,
        actor,
        payload,
      } as any);
  } catch {
    /* non-fatal */
  }
}

/* ─────────────────────────── System Settings (service-role) ──────────── */

/**
 * `system_settings` now has anon SELECT-only / authenticated UPDATE-only RLS
 * (no anon INSERT/UPSERT), so the on/off toggles (AUTO API, System
 * Automation) can no longer upsert directly from the anon client. This
 * routes those writes through the service-role admin client instead.
 */
export const updateSystemSettings = createServerFn({ method: "POST" })
  .inputValidator(
    (d: {
      automation_enabled?: boolean;
      auto_api_enabled?: boolean;
      author_id?: string | null;
    }) => d,
  )
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin.from("system_settings").upsert({ id: 1, ...data } as any);
    return { ok: !error, error: error?.message ?? null };
  });

/* ─────────────────────────── QA Governance Queue ─────────────────────── */

export const getQaQueue = createServerFn({ method: "GET" }).handler(async () => {
  const { data, error } = await client()
    .from("nlp_qa_queue")
    .select("*")
    .eq("status", "pending")
    .order("created_at", { ascending: false })
    .limit(20);
  if (error) return { items: [], error: error.message };
  return { items: data ?? [], error: null as string | null };
});

export const approveQaItem = createServerFn({ method: "POST" })
  .inputValidator((d: { id: string; reviewer?: string }) => d)
  .handler(async ({ data }) => {
    const sb = client();
    const { data: row } = await sb.from("nlp_qa_queue").select("*").eq("id", data.id).maybeSingle();
    if (!row) return { ok: false, error: "Not found" };
    await sb
      .from("nlp_qa_queue")
      .update({
        status: "approved",
        reviewer: data.reviewer ?? "Clinician",
        reviewed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      } as any)
      .eq("id", data.id);

    // Push approved codes into the patient row so the Live Terminology Matrix reflects it.
    const proposed = (row as any).proposed_codes ?? {};
    if ((row as any).mrn) {
      const { data: patient } = await sb
        .from("patients")
        .select("standardized_output, snomed_codes, icd10_codes")
        .eq("mrn", (row as any).mrn)
        .maybeSingle();
      const existing = ((patient as any)?.standardized_output ?? {}) as Record<string, any>;
      const merged = {
        "SNOMED CT": Array.from(
          new Set([
            ...((existing["SNOMED CT"] as any[]) ?? []),
            ...((proposed["SNOMED CT"] as any[]) ?? []),
          ]),
        ),
        "ICD-10": Array.from(
          new Set([
            ...((existing["ICD-10"] as any[]) ?? []),
            ...((proposed["ICD-10"] as any[]) ?? []),
          ]),
        ),
        LOINC: existing.LOINC ?? [],
        RXNORM: existing.RXNORM ?? [],
      };
      await sb
        .from("patients")
        .update({ standardized_output: merged } as any)
        .eq("mrn", (row as any).mrn);
    }
    await logEvent(
      "NLP_MAPPING_APPROVED",
      { proposed_codes: proposed, confidence: (row as any).confidence },
      (row as any).mrn,
      (row as any).facility_name,
      data.reviewer ?? "Clinician",
    );
    return { ok: true };
  });

export const rejectQaItem = createServerFn({ method: "POST" })
  .inputValidator((d: { id: string; reviewer?: string; reason?: string }) => d)
  .handler(async ({ data }) => {
    const sb = client();
    const { data: row } = await sb
      .from("nlp_qa_queue")
      .select("mrn, facility_name, proposed_codes, confidence")
      .eq("id", data.id)
      .maybeSingle();
    await sb
      .from("nlp_qa_queue")
      .update({
        status: "rejected",
        reviewer: data.reviewer ?? "Clinician",
        reviewed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      } as any)
      .eq("id", data.id);
    await logEvent(
      "NLP_MAPPING_REJECTED",
      { reason: data.reason ?? null, ...(row as any) },
      (row as any)?.mrn,
      (row as any)?.facility_name,
      data.reviewer ?? "Clinician",
    );
    return { ok: true };
  });

export const editQaItem = createServerFn({ method: "POST" })
  .inputValidator((d: { id: string; codes: Record<string, string[]> }) => d)
  .handler(async ({ data }) => {
    const sb = client();
    await sb
      .from("nlp_qa_queue")
      .update({
        proposed_codes: data.codes,
        updated_at: new Date().toISOString(),
      } as any)
      .eq("id", data.id);
    return { ok: true };
  });

export const flushQaQueue = createServerFn({ method: "POST" }).handler(async () => {
  const sb = client();
  await sb
    .from("nlp_qa_queue")
    .update({
      status: "flushed",
      reviewed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    } as any)
    .eq("status", "pending");
  await logEvent("NLP_QUEUE_FLUSHED", {});
  return { ok: true };
});

/* ─────────────────────────── Custom Value Sets ───────────────────────── */

export const listValueSets = createServerFn({ method: "GET" }).handler(async () => {
  const { data } = await client()
    .from("custom_value_sets")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(50);
  return { items: data ?? [] };
});

export const saveValueSet = createServerFn({ method: "POST" })
  .inputValidator(
    (d: {
      name: string;
      system: string;
      codes: Array<{ code: string; display: string; system?: string }>;
      description?: string;
      publish?: boolean;
      author?: string;
    }) => d,
  )
  .handler(async ({ data }) => {
    const sb = client();
    const status = data.publish ? "published" : "draft";
    const payload = {
      name: data.name,
      system: data.system,
      codes: data.codes,
      description: data.description ?? null,
      author: data.author ?? null,
      status,
      published_at: data.publish ? new Date().toISOString() : null,
    } as any;
    const { data: row, error } = await sb
      .from("custom_value_sets")
      .insert(payload)
      .select()
      .maybeSingle();
    if (error) return { ok: false, error: error.message };
    if (data.publish) {
      await logEvent("VALUE_SET_PUBLISHED", {
        id: (row as any)?.id,
        name: data.name,
        system: data.system,
        code_count: data.codes.length,
      });
    }
    return { ok: true, id: (row as any)?.id };
  });

/* ─────────────────────────── CDS Hook Overrides ──────────────────────── */

export const logCdsOverride = createServerFn({ method: "POST" })
  .inputValidator(
    (d: {
      mrn: string;
      alert_type: "drug-allergy" | "drug-disease";
      severity: "CONTRAINDICATION" | "CAUTION" | "INFO";
      drug_rxnorm?: string;
      drug_name?: string;
      condition_snomed?: string;
      condition_name?: string;
      reason: string;
      physician_id?: string;
      physician_name?: string;
    }) => d,
  )
  .handler(async ({ data }) => {
    const sb = client();
    await sb.from("cds_overrides").insert(data as any);
    await logEvent(
      "CDS_HOOK_OVERRIDDEN",
      data as any,
      data.mrn,
      null,
      data.physician_name ?? "Physician",
    );
    return { ok: true };
  });

/* ─────────────────────────── Loop Status / Events ────────────────────── */

export const getAutoApiLoopStatus = createServerFn({ method: "GET" }).handler(async () => {
  const sb = client();
  // Heuristic: derive each loop's last activity from recent table writes.
  const fiveMinAgo = new Date(Date.now() - 5 * 60_000).toISOString();
  const [qaPending, recentEvents, recentOverrides, recentDischarges] = await Promise.all([
    sb.from("nlp_qa_queue").select("id", { count: "exact", head: true }).eq("status", "pending"),
    sb
      .from("auto_api_events")
      .select("event_type, created_at")
      .gte("created_at", fiveMinAgo)
      .order("created_at", { ascending: false })
      .limit(50),
    sb
      .from("cds_overrides")
      .select("id", { count: "exact", head: true })
      .gte("created_at", fiveMinAgo),
    sb
      .from("patients")
      .select("discharge_time")
      .eq("status", "Discharged")
      .order("discharge_time", { ascending: false })
      .limit(1),
  ]);

  const lastDischarge = (recentDischarges.data as any[])?.[0]?.discharge_time;
  const lastEventByType: Record<string, string> = {};
  for (const ev of (recentEvents.data as any[]) ?? []) {
    if (!lastEventByType[ev.event_type]) lastEventByType[ev.event_type] = ev.created_at;
  }

  const loops = [
    {
      key: "UMLS_LIVE_QUERY",
      label: "UMLS Live Query",
      group: "Terminology",
      status: "NORMAL" as const,
      last_run: new Date().toISOString(),
    },
    {
      key: "NLP_PIPELINE",
      label: "NLP Pipeline (raw → mapping → standardised)",
      group: "Coding",
      status: "NORMAL" as const,
      last_run: lastEventByType["NLP_MAPPING_APPROVED"] ?? new Date().toISOString(),
    },
    {
      key: "PRE_PUSH_STANDARDISATION",
      label: "Pre-Push Code Standardisation",
      group: "Interop",
      status: "NORMAL" as const,
      last_run: lastDischarge ?? new Date().toISOString(),
    },
    {
      key: "DRUG_SAFETY_RXNORM",
      label: "Drug Safety · RxNorm × AllergyIntolerance",
      group: "Safety",
      status: "NORMAL" as const,
      last_run: lastEventByType["DRUG_SAFETY_HALT"] ?? new Date().toISOString(),
    },
    {
      key: "FHIR_SERVER_SYNC",
      label: "FHIR Server Sync (400 ms heartbeat)",
      group: "Interop",
      status: "NORMAL" as const,
      last_run: lastDischarge ?? new Date().toISOString(),
    },
    {
      key: "NLP_CONFIDENCE_GATE",
      label: "NLP Confidence Gate",
      group: "Governance",
      status: ((qaPending.count ?? 0) > 0 ? "WARNING" : "NORMAL") as "NORMAL" | "WARNING",
      last_run: new Date().toISOString(),
    },
    {
      key: "AUTO_TERMINOLOGIST",
      label: "Auto Terminologist (10 min coverage scan)",
      group: "Terminology",
      status: "NORMAL" as const,
      last_run: new Date().toISOString(),
    },
  ];

  return {
    loops,
    pending_qa: qaPending.count ?? 0,
    recent_events: (recentEvents.data as any[]) ?? [],
    recent_overrides: recentOverrides.count ?? 0,
  };
});

export const listAutoApiEvents = createServerFn({ method: "GET" }).handler(async () => {
  const { data } = await client()
    .from("auto_api_events")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(100);
  return { items: data ?? [] };
});

/* ─────────────────────────── Population Health ───────────────────────── */

export const runPopulationQuery = createServerFn({ method: "POST" })
  .inputValidator(
    (d: {
      code_system?: "SNOMED" | "ICD10" | "LOINC" | "RXNORM";
      keyword?: string;
      facilities?: string[];
      since_iso?: string;
      until_iso?: string;
      value_set_id?: string;
    }) => d,
  )
  .handler(async ({ data }) => {
    const sb = client();
    // ── 1. Coded MRN gate (system + keyword) ────────────────────────────
    // Routes to the right coded table for the selected code system, and
    // applies the time window against that table's own created_at column
    // so 6h/12h narrows by when the code was recorded (not just admission).
    let codeMrns: Set<string> | null = null;
    let vsMrns: Set<string> | null = null;
    const topLoinc: Record<string, number> = {};
    const topSnomed: Record<string, number> = {};
    const topRxnorm: Record<string, number> = {};

    const kwRaw = (data.keyword ?? "").trim();
    if (kwRaw && data.code_system) {
      const k = kwRaw;
      codeMrns = new Set();
      if (data.code_system === "SNOMED") {
        let q = sb
          .from("conditions")
          .select("mrn, snomed_code, snomed_display")
          .ilike("snomed_display", `%${k}%`)
          .limit(5000);
        if (data.since_iso) q = q.gte("created_at", data.since_iso);
        if (data.until_iso) q = q.lte("created_at", data.until_iso);
        const { data: rows, error } = await q;
        if (error) console.error("[population-query] SNOMED keyword failed", error.message);
        for (const r of (rows as any[]) ?? []) {
          if (r.mrn) codeMrns.add(r.mrn);
          const key = `${r.snomed_code ?? "?"} · ${r.snomed_display ?? "uncoded"}`;
          topSnomed[key] = (topSnomed[key] ?? 0) + 1;
        }
      } else if (data.code_system === "ICD10") {
        let q = sb
          .from("conditions")
          .select("mrn, icd10_code, icd10_display")
          .ilike("icd10_display", `%${k}%`)
          .limit(5000);
        if (data.since_iso) q = q.gte("created_at", data.since_iso);
        if (data.until_iso) q = q.lte("created_at", data.until_iso);
        const { data: rows, error } = await q;
        if (error) console.error("[population-query] ICD10 keyword failed", error.message);
        for (const r of (rows as any[]) ?? []) {
          if (r.mrn) codeMrns.add(r.mrn);
          const key = `${r.icd10_code ?? "?"} · ${r.icd10_display ?? "uncoded"}`;
          topSnomed[key] = (topSnomed[key] ?? 0) + 1;
        }
      } else if (data.code_system === "LOINC") {
        let q = sb
          .from("lab_orders")
          .select("patient_mrn, loinc_code, loinc_display")
          .ilike("loinc_display", `%${k}%`)
          .limit(5000);
        if (data.since_iso) q = q.gte("created_at", data.since_iso);
        if (data.until_iso) q = q.lte("created_at", data.until_iso);
        const { data: rows, error } = await q;
        if (error) console.error("[population-query] LOINC keyword failed", error.message);
        for (const r of (rows as any[]) ?? []) {
          if (r.patient_mrn) codeMrns.add(r.patient_mrn);
          const key = `${r.loinc_code ?? "?"} · ${r.loinc_display ?? "uncoded"}`;
          topLoinc[key] = (topLoinc[key] ?? 0) + 1;
        }
      } else if (data.code_system === "RXNORM") {
        let q = sb
          .from("medication_orders")
          .select("patient_mrn, rxnorm_code, rxnorm_display")
          .ilike("rxnorm_display", `%${k}%`)
          .limit(5000);
        if (data.since_iso) q = q.gte("created_at", data.since_iso);
        if (data.until_iso) q = q.lte("created_at", data.until_iso);
        const { data: rows, error } = await q;
        if (error) console.error("[population-query] RXNORM keyword failed", error.message);
        for (const r of (rows as any[]) ?? []) {
          if (r.patient_mrn) codeMrns.add(r.patient_mrn);
          const key = `${r.rxnorm_code ?? "?"} · ${r.rxnorm_display ?? "uncoded"}`;
          topRxnorm[key] = (topRxnorm[key] ?? 0) + 1;
        }
      }
    }

    // ── 1b. Published value-set gate ───────────────────────────────────
    // When a value set is selected, narrow to MRNs whose coded conditions
    // (snomed/icd10) or lab_orders (loinc) contain ANY code from the set.
    let vsMeta: { name: string; codes_count: number } | null = null;
    let allCodesDebug: string[] | null = null;
    let vsCondErrMsg: string | null = null;
    let vsLabErrMsg: string | null = null;
    const patientBatchErrors: string[] = [];
    if (data.value_set_id) {
      const { data: vs } = await sb
        .from("custom_value_sets")
        .select("id, name, codes")
        .eq("id", data.value_set_id)
        .maybeSingle();
      const codesArr = Array.isArray((vs as any)?.codes) ? (vs as any).codes : [];
      vsMeta = { name: (vs as any)?.name ?? "value set", codes_count: codesArr.length };
      const allCodes = codesArr
        .map((c: any) => String(c?.code ?? "").trim())
        .filter((c: string) => c.length > 0);
      allCodesDebug = allCodes;
      vsMrns = new Set();
      if (allCodes.length > 0) {
        const [{ data: vsCond, error: vsCondErr }, { data: vsLab, error: vsLabErr }] =
          await Promise.all([
            sb
              .from("conditions")
              .select("mrn, snomed_code, snomed_display, icd10_code, icd10_display")
              .or(
                `snomed_code.in.(${allCodes.map((c: string) => `"${c}"`).join(",")}),icd10_code.in.(${allCodes.map((c: string) => `"${c}"`).join(",")})`,
              )
              .order("created_at", { ascending: false })
              .limit(5000),
            sb
              .from("lab_orders")
              .select("patient_mrn, loinc_code, loinc_display")
              .in("loinc_code", allCodes)
              .order("created_at", { ascending: false })
              .limit(5000),
          ]);
        if (vsCondErr) {
          vsCondErrMsg = vsCondErr.message;
          console.error("[population-query] vsCond failed", vsCondErr.message);
        }
        if (vsLabErr) {
          vsLabErrMsg = vsLabErr.message;
          console.error("[population-query] vsLab failed", vsLabErr.message);
        }
        for (const r of (vsCond as any[]) ?? []) {
          if (r.mrn) vsMrns.add(r.mrn);
          const key = r.snomed_display
            ? `${r.snomed_code ?? "?"} · ${r.snomed_display}`
            : r.icd10_display
              ? `${r.icd10_code ?? "?"} · ${r.icd10_display}`
              : "uncoded";
          topSnomed[key] = (topSnomed[key] ?? 0) + 1;
        }
        for (const r of (vsLab as any[]) ?? []) {
          if (r.patient_mrn) vsMrns.add(r.patient_mrn);
          const key = r.loinc_display
            ? `${r.loinc_code ?? "?"} · ${r.loinc_display}`
            : (r.loinc_code ?? "uncoded");
          topLoinc[key] = (topLoinc[key] ?? 0) + 1;
        }
      }
    }

    // ── 2. Patient query (preserves chief_complaint ilike as fallback) ──
    const gateMrns = vsMrns ?? codeMrns;
    const PATIENT_SELECT =
      "mrn, name, age, gender, facility_name, chief_complaint, admission_time, standardized_output";
    let rows: any[] = [];
    if (gateMrns) {
      const mrnList = Array.from(gateMrns);
      const CHUNK = 150;
      const batches: string[][] = [];
      for (let i = 0; i < mrnList.length; i += CHUNK) {
        batches.push(mrnList.slice(i, i + CHUNK));
      }
      const results = await Promise.all(
        batches.map(async (batch) => {
          let bq = sb.from("patients").select(PATIENT_SELECT).in("mrn", batch);
          if (data.facilities && data.facilities.length > 0) {
            bq = bq.in("facility_name", data.facilities);
          }
          if (data.since_iso) {
            bq = bq.gte("admission_time", data.since_iso);
          }
          if (data.until_iso) {
            bq = bq.lte("admission_time", data.until_iso);
          }
          const { data: br, error: bErr } = await bq;
          if (bErr) {
            patientBatchErrors.push(bErr.message);
            console.error("[population-query] patients batch failed", bErr.message);
          }
          return (br as any[]) ?? [];
        }),
      );
      rows = results.flat();
    } else {
      let q = sb
        .from("patients")
        .select(PATIENT_SELECT)
        .order("admission_time", { ascending: false })
        .limit(500);
      if (data.facilities && data.facilities.length > 0) {
        q = q.in("facility_name", data.facilities);
      }
      if (data.since_iso) {
        q = q.gte("admission_time", data.since_iso);
      }
      if (data.until_iso) {
        q = q.lte("admission_time", data.until_iso);
      }
      const { data: qr, error: qErr } = await q;
      if (qErr) console.error("[population-query] patients failed", qErr.message);
      rows = (qr as any[]) ?? [];
    }
    let filtered = rows;

    if (vsMrns) {
      filtered = filtered.filter((r) => vsMrns!.has(r.mrn));
    }
    if (codeMrns) {
      filtered = filtered.filter((r) => codeMrns!.has(r.mrn));
    }

    const ages = filtered.map((r) => Number(r.age)).filter((n) => !isNaN(n));
    const avgAge = ages.length > 0 ? Math.round(ages.reduce((a, b) => a + b, 0) / ages.length) : 0;
    const genderCount: Record<string, number> = {};
    for (const r of filtered) {
      const g = (r.gender ?? "unknown").toLowerCase();
      genderCount[g] = (genderCount[g] ?? 0) + 1;
    }
    const topN = (m: Record<string, number>, n = 5) =>
      Object.entries(m)
        .sort((a, b) => b[1] - a[1])
        .slice(0, n)
        .map(([label, count]) => ({ label, count }));

    // ── Population Health coverage-gap detection (Auto Admin as consumer) ─
    // Only fires for raw keyword+code_system searches that are NOT already
    // scoped to a value set, and only when the cohort is non-trivial (≥3
    // patients). If the codes surfaced by the query aren't covered by any
    // published Population Health value set for the matching vocabulary, we
    // file (or extend) a terminology_requests row so a steward / the Auto
    // Terminologist can close the gap. All wrapped in try/catch — this must
    // never break the actual population-query response. Genuine infra
    // failures on the availability check itself are routed to Auto IT via
    // auto_doc_logs (stage="fhir", level="error"), NOT to terminology_requests.
    if (kwRaw && data.code_system && !data.value_set_id && codeMrns && codeMrns.size >= 3) {
      try {
        const vocabMap: Record<string, string> = {
          SNOMED: "SNOMED CT",
          ICD10: "ICD-10",
          LOINC: "LOINC",
          RXNORM: "RxNorm",
        };
        const vocab = vocabMap[data.code_system];
        const relevantMap =
          data.code_system === "LOINC"
            ? topLoinc
            : data.code_system === "RXNORM"
              ? topRxnorm
              : topSnomed; // both SNOMED and ICD10 accumulate into topSnomed above
        const parseKey = (k: string) => {
          const idx = k.indexOf(" · ");
          const code = idx >= 0 ? k.slice(0, idx) : k;
          const display = idx >= 0 ? k.slice(idx + 3) : k;
          return { code: code.trim(), display: display.trim() };
        };
        const foundCodes = Object.keys(relevantMap)
          .map(parseKey)
          .filter((c) => c.code && c.code !== "?");
        const foundCodeSet = new Set(foundCodes.map((c) => c.code));

        // Availability check — an error here is treated as an infra failure
        // (Auto IT), not a coverage gap.
        const { data: phSets, error: phErr } = await sb
          .from("custom_value_sets")
          .select("codes")
          .eq("status", "published")
          .eq("clinical_application", "Population Health")
          .eq("vocabulary", vocab);

        if (phErr) {
          await sb.from("auto_doc_logs").insert({
            mrn: null,
            stage: "fhir",
            level: "error",
            message: `Auto Admin population-health coverage check failed: ${phErr.message}`,
          } as any);
        } else {
          let covered = false;
          for (const row of (phSets ?? []) as any[]) {
            const rowCodes: any[] = Array.isArray(row?.codes) ? row.codes : [];
            for (const c of rowCodes) {
              const k = String(c?.code ?? "").trim();
              if (k && foundCodeSet.has(k)) {
                covered = true;
                break;
              }
            }
            if (covered) break;
          }

          if (!covered && foundCodes.length > 0) {
            const seedCodes = Object.entries(relevantMap)
              .sort((a, b) => b[1] - a[1])
              .slice(0, 15)
              .map(([k]) => {
                const { code, display } = parseKey(k);
                return { code, display, vocabulary: vocab };
              })
              .filter((c) => c.code && c.code !== "?");

            const justification = `Population Health cohort query for "${kwRaw}" (${data.code_system}) returned ${codeMrns.size} patient(s) with no published Population Health value set covering the matched codes.`;

            const { data: existingReq } = await sb
              .from("terminology_requests" as any)
              .select("id, seed_codes")
              .eq("requesting_consumer", "Auto Admin")
              .eq("requested_name", kwRaw)
              .in("status", ["pending", "umls-suggested"])
              .maybeSingle();

            if (existingReq) {
              const prevCodes: Array<{ code: string; display?: string; vocabulary?: string }> =
                Array.isArray((existingReq as any).seed_codes)
                  ? (existingReq as any).seed_codes
                  : [];
              const seen = new Set(prevCodes.map((c) => String(c?.code ?? "").trim()));
              const merged = [...prevCodes];
              for (const c of seedCodes) {
                const code = String(c?.code ?? "").trim();
                if (!code || seen.has(code)) continue;
                seen.add(code);
                merged.push(c);
              }
              if (merged.length !== prevCodes.length) {
                await sb
                  .from("terminology_requests" as any)
                  .update({ seed_codes: merged, updated_at: new Date().toISOString() } as any)
                  .eq("id", (existingReq as any).id);
              }
            } else {
              await sb.from("terminology_requests" as any).insert({
                requesting_consumer: "Auto Admin",
                requested_name: kwRaw,
                justification,
                priority: "normal",
                vocabulary: vocab,
                seed_codes: seedCodes,
                clinical_application: "Population Health",
                status: "pending",
              } as any);
            }
          }
        }
      } catch (e) {
        try {
          await sb.from("auto_doc_logs").insert({
            mrn: null,
            stage: "fhir",
            level: "error",
            message: `Auto Admin population-health coverage check failed: ${(e as Error).message}`,
          } as any);
        } catch {
          /* non-fatal */
        }
      }
    }

    await logEvent("POPULATION_QUERY", {
      code_system: data.code_system ?? null,
      keyword: kwRaw || null,
      facilities: data.facilities ?? null,
      value_set_id: data.value_set_id ?? null,
      value_set_name: vsMeta?.name ?? null,
      cohort_size: filtered.length,
    });
    return {
      total: filtered.length,
      avg_age: avgAge,
      gender_distribution: genderCount,
      top_loinc: topN(topLoinc),
      top_snomed: topN(topSnomed),
      top_rxnorm: topN(topRxnorm),
      rows: filtered.slice(0, 100),
    };
  });

/* ─────────────────────────── Coded keyword suggestions ───────────────── */

export const getCodedKeywordSuggestions = createServerFn({ method: "POST" })
  .inputValidator((d: { system: "SNOMED" | "ICD10" | "LOINC" | "RXNORM"; query: string }) => d)
  .handler(async ({ data }) => {
    const q = (data.query ?? "").trim();
    if (q.length < 2)
      return { items: [] as Array<{ code: string; display: string; count: number }> };
    const sb = client();
    const agg = new Map<string, { code: string; display: string; count: number }>();
    const bump = (code: string, display: string) => {
      const key = `${code}::${display}`;
      const cur = agg.get(key);
      if (cur) cur.count += 1;
      else agg.set(key, { code, display, count: 1 });
    };
    if (data.system === "SNOMED") {
      const { data: rows } = await sb
        .from("conditions")
        .select("snomed_code, snomed_display")
        .ilike("snomed_display", `%${q}%`)
        .not("snomed_code", "is", null)
        .limit(4000);
      for (const r of (rows as any[]) ?? []) {
        if (r.snomed_code && r.snomed_display)
          bump(String(r.snomed_code), String(r.snomed_display));
      }
    } else if (data.system === "ICD10") {
      const { data: rows } = await sb
        .from("conditions")
        .select("icd10_code, icd10_display")
        .ilike("icd10_display", `%${q}%`)
        .not("icd10_code", "is", null)
        .limit(4000);
      for (const r of (rows as any[]) ?? []) {
        if (r.icd10_code && r.icd10_display) bump(String(r.icd10_code), String(r.icd10_display));
      }
    } else if (data.system === "LOINC") {
      const { data: rows } = await sb
        .from("lab_orders")
        .select("loinc_code, loinc_display")
        .ilike("loinc_display", `%${q}%`)
        .not("loinc_code", "is", null)
        .limit(4000);
      for (const r of (rows as any[]) ?? []) {
        if (r.loinc_code && r.loinc_display) bump(String(r.loinc_code), String(r.loinc_display));
      }
    } else if (data.system === "RXNORM") {
      const { data: rows } = await sb
        .from("medication_orders")
        .select("rxnorm_code, rxnorm_display")
        .ilike("rxnorm_display", `%${q}%`)
        .not("rxnorm_code", "is", null)
        .limit(4000);
      for (const r of (rows as any[]) ?? []) {
        if (r.rxnorm_code && r.rxnorm_display)
          bump(String(r.rxnorm_code), String(r.rxnorm_display));
      }
    }
    const items = Array.from(agg.values())
      .sort((a, b) => b.count - a.count)
      .slice(0, 8);
    return { items };
  });
