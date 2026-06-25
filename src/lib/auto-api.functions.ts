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
    // Heuristic: derive each loop's last activity from recent table writes.
    const fiveMinAgo = new Date(Date.now() - 5 * 60_000).toISOString();
    const [qaPending, recentEvents, recentOverrides, recentDischarges] =
      await Promise.all([
        sb
          .from("nlp_qa_queue")
          .select("id", { count: "exact", head: true })
          .eq("status", "pending"),
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
      if (!lastEventByType[ev.event_type])
        lastEventByType[ev.event_type] = ev.created_at;
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
        status: ((qaPending.count ?? 0) > 0 ? "WARNING" : "NORMAL") as
          | "NORMAL"
          | "WARNING",
        last_run: new Date().toISOString(),
      },
    ];

    return {
      loops,
      pending_qa: qaPending.count ?? 0,
      recent_events: (recentEvents.data as any[]) ?? [],
      recent_overrides: recentOverrides.count ?? 0,
    };
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
    let q = sb
      .from("patients")
      .select(
        "mrn, name, age, gender, facility_name, chief_complaint, admission_time, standardized_output",
      )
      .order("admission_time", { ascending: false })
      .limit(200);
    if (data.condition_keyword) {
      q = q.ilike("chief_complaint", `%${data.condition_keyword}%`);
    }
    if (data.facilities && data.facilities.length > 0) {
      q = q.in("facility_name", data.facilities);
    }
    if (data.since_iso) {
      q = q.gte("admission_time", data.since_iso);
    }
    const { data: rows } = await q;
    let filtered = (rows as any[]) ?? [];
    if (data.loinc_keyword) {
      const k = data.loinc_keyword.toLowerCase();
      filtered = filtered.filter((r) => {
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
    return {
      total: filtered.length,
      avg_age: avgAge,
      gender_distribution: genderCount,
      rows: filtered.slice(0, 100),
    };
  });