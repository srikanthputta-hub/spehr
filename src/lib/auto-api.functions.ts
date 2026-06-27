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
  return createClient<Database>(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_PUBLISHABLE_KEY!,
    {
      auth: {
        storage: undefined,
        persistSession: false,
        autoRefreshToken: false,
      },
    },
  );
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

/* ─────────────────────────── QA Governance Queue ─────────────────────── */

export const getQaQueue = createServerFn({ method: "GET" }).handler(
  async () => {
    const { data, error } = await client()
      .from("nlp_qa_queue")
      .select("*")
      .eq("status", "pending")
      .order("created_at", { ascending: false })
      .limit(20);
    if (error) return { items: [], error: error.message };
    return { items: data ?? [], error: null as string | null };
  },
);

export const approveQaItem = createServerFn({ method: "POST" })
  .inputValidator((d: { id: string; reviewer?: string }) => d)
  .handler(async ({ data }) => {
    const sb = client();
    const { data: row } = await sb
      .from("nlp_qa_queue")
      .select("*")
      .eq("id", data.id)
      .maybeSingle();
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
      const existing = ((patient as any)?.standardized_output ?? {}) as Record<
        string,
        any
      >;
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

export const flushQaQueue = createServerFn({ method: "POST" }).handler(
  async () => {
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
  },
);

/* ─────────────────────────── Custom Value Sets ───────────────────────── */

export const listValueSets = createServerFn({ method: "GET" }).handler(
  async () => {
    const { data } = await client()
      .from("custom_value_sets")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(50);
    return { items: data ?? [] };
  },
);

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

export const getAutoApiLoopStatus = createServerFn({ method: "GET" }).handler(
  async () => {
    const sb = client();
    // Derive real status from automation_watchdog_logs (engine + created_at).
    // Each loop's max age (seconds before WARNING).
    const SLA: Record<string, { label: string; group: string; maxAge: number }> = {
      UMLS_LIVE_QUERY:      { label: "UMLS Live Query",                     group: "Terminology", maxAge: 360 },
      NLP_PIPELINE:         { label: "NLP Pipeline",                        group: "Coding",      maxAge: 45 },
      PRE_PUSH_STANDARD:    { label: "Pre-Push Code Standardisation",       group: "Interop",     maxAge: 90 },
      DRUG_SAFETY:          { label: "Drug Safety · RxNorm × Allergy",      group: "Safety",      maxAge: 130 },
      FHIR_SYNC:            { label: "FHIR Server Sync · API Heartbeat",    group: "Interop",     maxAge: 10 },
      NLP_CONFIDENCE_GATE:  { label: "NLP Confidence Gate",                 group: "Governance",  maxAge: 70 },
    };
    const keys = Object.keys(SLA);
    const since = new Date(Date.now() - 30 * 60_000).toISOString();
    const { data: logs } = await sb
      .from("automation_watchdog_logs")
      .select("engine, status, created_at, payload")
      .in("engine", keys)
      .gte("created_at", since)
      .order("created_at", { ascending: false });
    const latest: Record<string, any> = {};
    for (const l of (logs ?? []) as any[]) {
      if (!latest[l.engine]) latest[l.engine] = l;
    }
    const loops = keys.map((k) => {
      const def = SLA[k];
      const row = latest[k];
      let status: "NORMAL" | "WARNING" | "ERROR" | "INACTIVE" = "INACTIVE";
      let last_run = new Date(0).toISOString();
      if (row) {
        last_run = row.created_at;
        const ageSec = (Date.now() - new Date(row.created_at).getTime()) / 1000;
        if (row.status === "PAUSED") status = "INACTIVE";
        else if (row.status === "ERROR" || ageSec > def.maxAge * 2) status = "ERROR";
        else if (row.status === "WARNING" || ageSec > def.maxAge) status = "WARNING";
        else status = "NORMAL";
      }
      return { key: k, label: def.label, group: def.group, status, last_run, payload: row?.payload ?? {} };
    });
    const qaPending = await sb
      .from("nlp_qa_queue")
      .select("id", { count: "exact", head: true })
      .eq("status", "review_required");
    const recentEvents = await sb
      .from("auto_api_events")
      .select("event_type, created_at")
      .gte("created_at", new Date(Date.now() - 5 * 60_000).toISOString())
      .order("created_at", { ascending: false })
      .limit(50);
    return {
      loops,
      pending_qa: qaPending.count ?? 0,
      recent_events: (recentEvents.data as any[]) ?? [],
      recent_overrides: 0,
    };
  },
);

/**
 * Unified loop status across all 4 Watchdog agent groups. Reads
 * `automation_watchdog_logs` keyed by engine + created_at and returns
 * NORMAL / WARNING / ERROR / INACTIVE / PAUSED for each loop.
 */
export const getAllLoopStatuses = createServerFn({ method: "GET" }).handler(
  async () => {
    const sb = client();
    const SLA: Record<string, { label: string; group: string; maxAge: number }> = {
      VITALS_SIMULATION:    { label: "Vitals Simulation",                   group: "Auto Doc",   maxAge: 10 },
      CLINICAL_ALERTS:      { label: "Clinical Alerts",                     group: "Auto Doc",   maxAge: 30 },
      CDS_MONITOR:          { label: "Clinical Decision Support",           group: "Auto Doc",   maxAge: 90 },
      AUTO_DISCHARGE:       { label: "Auto Discharge Engine",               group: "Auto Doc",   maxAge: 60 },
      REVENUE_CYCLE:        { label: "Revenue Cycle",                       group: "Auto Admin", maxAge: 1200 },
      STAFF_ASSIGNMENT:     { label: "Staff Assignment",                    group: "Auto Admin", maxAge: 300 },
      UMLS_VALIDATION:      { label: "UMLS Terminology Validation",         group: "Auto IT",    maxAge: 900 },
      LATENCY_PING:         { label: "Latency & API Health Ping",           group: "Auto IT",    maxAge: 130 },
      FHIR_SYNC:            { label: "FHIR Server Sync",                    group: "Auto IT",    maxAge: 10 },
      WATCHDOG_HEARTBEAT:   { label: "Watchdog Heartbeat",                  group: "Auto IT",    maxAge: 70 },
      UMLS_LIVE_QUERY:      { label: "UMLS Live Query",                     group: "AUTO API",   maxAge: 360 },
      NLP_PIPELINE:         { label: "NLP Pipeline",                        group: "AUTO API",   maxAge: 45 },
      PRE_PUSH_STANDARD:    { label: "Pre-Push Code Standardisation",       group: "AUTO API",   maxAge: 90 },
      DRUG_SAFETY:          { label: "Drug Safety Monitor",                 group: "AUTO API",   maxAge: 130 },
      NLP_CONFIDENCE_GATE:  { label: "NLP Confidence Gate",                 group: "AUTO API",   maxAge: 70 },
    };
    const keys = Object.keys(SLA);
    const since = new Date(Date.now() - 60 * 60_000).toISOString();
    const { data: logs } = await sb
      .from("automation_watchdog_logs")
      .select("engine, status, created_at, payload")
      .in("engine", keys)
      .gte("created_at", since)
      .order("created_at", { ascending: false });
    const latest: Record<string, any> = {};
    for (const l of (logs ?? []) as any[]) {
      if (!latest[l.engine]) latest[l.engine] = l;
    }
    const loops = keys.map((k) => {
      const def = SLA[k];
      const row = latest[k];
      let status: "NORMAL" | "WARNING" | "ERROR" | "INACTIVE" | "PAUSED" = "INACTIVE";
      let last_run: string | null = null;
      if (row) {
        last_run = row.created_at;
        const ageSec = (Date.now() - new Date(row.created_at).getTime()) / 1000;
        if (row.status === "PAUSED") status = "PAUSED";
        else if (row.status === "ERROR" || ageSec > def.maxAge * 2) status = "ERROR";
        else if (row.status === "WARNING" || ageSec > def.maxAge) status = "WARNING";
        else status = "NORMAL";
      }
      return { key: k, label: def.label, group: def.group, status, last_run, payload: row?.payload ?? null };
    });
    // Latest latency ping snapshot for the AUTO IT card
    const { data: pings } = await sb
      .from("api_health_pings")
      .select("service, status, latency_ms, created_at")
      .order("created_at", { ascending: false })
      .limit(9);
    const latencyByService: Record<string, any> = {};
    for (const p of (pings ?? []) as any[]) {
      if (!latencyByService[p.service]) latencyByService[p.service] = p;
    }
    return { loops, latency: latencyByService };
  },
);

export const listAutoApiEvents = createServerFn({ method: "GET" }).handler(
  async () => {
    const { data } = await client()
      .from("auto_api_events")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(100);
    return { items: data ?? [] };
  },
);

/* ─────────────────────────── Population Health ───────────────────────── */

export const runPopulationQuery = createServerFn({ method: "POST" })
  .inputValidator(
    (d: {
      condition_keyword?: string;
      loinc_keyword?: string;
      facilities?: string[];
      since_iso?: string;
    }) => d,
  )
  .handler(async ({ data }) => {
    const sb = client();
    // ── 1. Coded MRN gates (Part 6: terminology-driven cohort) ──────────
    // If a LOINC keyword is given, narrow to MRNs that have a matching
    // pre-coded lab_orders row (via loinc_code or loinc_display). If a
    // SNOMED-style condition keyword is given, also collect MRNs with a
    // matching coded conditions row so the cohort isn't limited to the
    // free-text chief_complaint match alone.
    let labMrns: Set<string> | null = null;
    let condMrns: Set<string> | null = null;
    const topLoinc: Record<string, number> = {};
    const topSnomed: Record<string, number> = {};

    if (data.loinc_keyword) {
      const k = data.loinc_keyword.trim();
      const { data: lab } = await sb
        .from("lab_orders")
        .select("patient_mrn, loinc_code, loinc_display")
        .or(`loinc_display.ilike.%${k}%,loinc_code.ilike.%${k}%,test_type.ilike.%${k}%`)
        .limit(2000);
      labMrns = new Set();
      for (const r of (lab as any[]) ?? []) {
        if (r.patient_mrn) labMrns.add(r.patient_mrn);
        const key = r.loinc_display
          ? `${r.loinc_code ?? "?"} · ${r.loinc_display}`
          : r.loinc_code ?? "uncoded";
        topLoinc[key] = (topLoinc[key] ?? 0) + 1;
      }
    }

    if (data.condition_keyword) {
      const k = data.condition_keyword.trim();
      const { data: cond } = await sb
        .from("conditions")
        .select("patient_mrn, snomed_code, snomed_display, icd10_code, icd10_display, display_text")
        .or(
          `snomed_display.ilike.%${k}%,icd10_display.ilike.%${k}%,display_text.ilike.%${k}%`,
        )
        .limit(2000);
      condMrns = new Set();
      for (const r of (cond as any[]) ?? []) {
        if (r.patient_mrn) condMrns.add(r.patient_mrn);
        const key = r.snomed_display
          ? `${r.snomed_code ?? "?"} · ${r.snomed_display}`
          : r.icd10_display
          ? `${r.icd10_code ?? "?"} · ${r.icd10_display}`
          : r.display_text ?? "uncoded";
        topSnomed[key] = (topSnomed[key] ?? 0) + 1;
      }
    }

    // ── 2. Patient query (preserves chief_complaint ilike as fallback) ──
    let q = sb
      .from("patients")
      .select(
        "mrn, name, age, gender, facility_name, chief_complaint, admission_time, standardized_output",
      )
      .order("admission_time", { ascending: false })
      .limit(500);
    if (data.facilities && data.facilities.length > 0) {
      q = q.in("facility_name", data.facilities);
    }
    if (data.since_iso) {
      q = q.gte("admission_time", data.since_iso);
    }
    const { data: rows } = await q;
    let filtered = (rows as any[]) ?? [];

    if (data.condition_keyword) {
      const k = data.condition_keyword.toLowerCase();
      filtered = filtered.filter(
        (r) =>
          (condMrns && condMrns.has(r.mrn)) ||
          (r.chief_complaint ?? "").toLowerCase().includes(k),
      );
    }
    if (data.loinc_keyword) {
      const k = data.loinc_keyword.toLowerCase();
      filtered = filtered.filter((r) => {
        if (labMrns && labMrns.has(r.mrn)) return true;
        const loinc = (r.standardized_output?.LOINC as any[]) ?? [];
        return loinc.some((c) => String(c).toLowerCase().includes(k));
      });
    }

    const ages = filtered.map((r) => Number(r.age)).filter((n) => !isNaN(n));
    const avgAge =
      ages.length > 0 ? Math.round(ages.reduce((a, b) => a + b, 0) / ages.length) : 0;
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
    await logEvent("POPULATION_QUERY", {
      condition: data.condition_keyword ?? null,
      loinc: data.loinc_keyword ?? null,
      facilities: data.facilities ?? null,
      cohort_size: filtered.length,
    });
    return {
      total: filtered.length,
      avg_age: avgAge,
      gender_distribution: genderCount,
      top_loinc: topN(topLoinc),
      top_snomed: topN(topSnomed),
      rows: filtered.slice(0, 100),
    };
  });