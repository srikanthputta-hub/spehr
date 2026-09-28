// Inbound FHIR poll — fallback for when Medblocks' rest-hook subscription
// delivery isn't firing (which, as of writing, it isn't on the shared HAPI
// tenant). Runs on a pg_cron schedule (see README section in the migration
// that adds `fhir_sync_state`) and pulls any Appointment/PaymentNotice
// resources tagged `urn:spehr:source|myspehr` that were created/updated
// since the last successful poll, then feeds each one through the exact
// same shared ingest module the webhook uses.
//
// State: `public.fhir_sync_state` rows keyed
//   `appointment_last_polled_at` and `paymentnotice_last_polled_at`,
//   value `{ ts: <ISO> }`. Bootstrapped in the migration to `now() - 10m`.
//
// Auth: none — meant to be invoked by cron via pg_net. Idempotent and
// side-effect-safe (upserts on `fhir_id`), so extra invocations are cheap.
//
// Deliberately NOT here: Invoice/ChargeItem. fhir-outbound-poll pushes
// those out (pollInvoices/pollChargeItems), but spehr is the sole source
// of truth for its own billing data — no partner account originates or
// edits an Invoice/ChargeItem on the FHIR server (billing-pophealth only
// writes PaymentNotice, which IS polled below). This is intentional
// one-way sync, not a gap; see the note above pollInvoices in
// fhir-outbound-poll/index.ts before adding an inbound target for them.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { ingestFhirResource, logIngestEvent } from "../_shared/fhir-ingest.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const FHIR_SERVER_URL = (Deno.env.get("FHIR_SERVER_URL") ?? "").replace(/\/+$/, "");
const FHIR_BEARER_TOKEN = Deno.env.get("FHIR_BEARER_TOKEN") ?? "";
const FHIR_APIKEY = Deno.env.get("FHIR_APIKEY") ?? "";

const PAGE_SIZE = 50;
const MAX_PAGES = 20;

// One entry per (resourceType, source-tag) pair we want to pull inbound.
// Adding Radiology/Billing later = just append another row here.
type PollTarget = {
  resourceType: string;
  tag: string;      // full `_tag` filter (system|code)
  stateKey: string; // cursor row key in fhir_sync_state
  label: string;    // result-object key in the JSON response
};
const POLL_TARGETS: PollTarget[] = [
  { resourceType: "Appointment",    tag: "urn:spehr:source|myspehr",         stateKey: "appointment_last_polled_at",       label: "appointment" },
  { resourceType: "PaymentNotice",  tag: "urn:spehr:source|myspehr",         stateKey: "paymentnotice_last_polled_at",     label: "paymentNotice" },
  { resourceType: "PaymentNotice",  tag: "urn:spehr:source|billing-pophealth", stateKey: "billing_paymentnotice_last_polled_at", label: "billingPaymentNotice" },
  { resourceType: "Observation",    tag: "urn:spehr:source|labs-pharm-rad",  stateKey: "labs_observation_last_polled_at",  label: "labObservation" },
  { resourceType: "Medication",     tag: "urn:spehr:source|labs-pharm-rad",  stateKey: "medication_formulary_last_polled_at", label: "medicationFormulary" },
  { resourceType: "DiagnosticReport", tag: "urn:spehr:source|labs-pharm-rad", stateKey: "radiology_report_last_polled_at", label: "radiologyReport" },
];

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

function fhirHeaders(): Record<string, string> {
  const h: Record<string, string> = {
    Accept: "application/fhir+json",
    Authorization: `Bearer ${FHIR_BEARER_TOKEN}`,
  };
  if (FHIR_APIKEY) h.Apikey = FHIR_APIKEY;
  return h;
}

function toIso(ts: string): string {
  // Accept both ISO-8601 (`2026-07-05T21:02:36.276Z`) and Postgres text
  // (`2026-07-05 20:49:44.868074+00`). HAPI requires the ISO form on
  // `_lastUpdated`, so normalize before we hit the wire.
  const d = new Date(ts.includes("T") ? ts : ts.replace(" ", "T"));
  if (isNaN(d.getTime())) return new Date(Date.now() - 10 * 60 * 1000).toISOString();
  return d.toISOString();
}

async function readState(admin: any, key: string): Promise<string> {
  const { data } = await admin
    .from("fhir_sync_state")
    .select("value")
    .eq("key", key)
    .maybeSingle();
  const ts = data?.value?.ts;
  if (typeof ts === "string" && ts.length) return toIso(ts);
  // conservative fallback if bootstrap row missing
  return new Date(Date.now() - 10 * 60 * 1000).toISOString();
}

async function writeState(admin: any, key: string, ts: string) {
  await admin
    .from("fhir_sync_state")
    .upsert({ key, value: { ts: toIso(ts) } }, { onConflict: "key" });
}

async function fetchBundle(url: string): Promise<any> {
  const res = await fetch(url, { method: "GET", headers: fhirHeaders() });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`FHIR search failed ${res.status}: ${text.slice(0, 300)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("FHIR search returned non-JSON body");
  }
}

function nextLink(bundle: any): string | null {
  const links: any[] = bundle?.link ?? [];
  const next = links.find((l) => l?.relation === "next");
  return next?.url ?? null;
}

function isoMax(a: string, b: string | null | undefined): string {
  if (!b) return a;
  return new Date(a).getTime() >= new Date(b).getTime() ? a : b;
}

// Parse "Acetaminophen 500 MG Oral Tablet" → name "Acetaminophen", strength "500 MG".
function parseDisplay(display: string | null | undefined): { drugName: string | null; strength: string | null } {
  if (!display) return { drugName: null, strength: null };
  const m = display.match(/^(.*?)\s+(\d+(?:\.\d+)?\s*(?:MG|MCG|G|ML|UNIT|%)(?:\/\d+\s*ML)?)/i);
  if (m) return { drugName: m[1].trim(), strength: m[2].trim() };
  return { drugName: display.split(" ")[0] || display, strength: null };
}

function extString(resource: any, url: string): string | null {
  const hit = (resource?.extension ?? []).find((e: any) => e?.url === url);
  return hit?.valueString ?? null;
}
function extBool(resource: any, url: string): boolean | null {
  const hit = (resource?.extension ?? []).find((e: any) => e?.url === url);
  return typeof hit?.valueBoolean === "boolean" ? hit.valueBoolean : null;
}

async function upsertMedicationResource(admin: any, resource: any): Promise<{ ok: boolean; reason?: string }> {
  const coding = resource?.code?.coding ?? [];
  const rxHit = coding.find((c: any) => typeof c?.system === "string" && c.system.toLowerCase().includes("rxnorm")) ?? coding[0];
  const rxnorm = rxHit?.code ? String(rxHit.code) : null;
  if (!rxnorm) return { ok: false, reason: "missing_rxnorm" };
  const fullDisplay = resource?.code?.text ?? rxHit?.display ?? null;
  const { drugName, strength } = parseDisplay(fullDisplay);
  const row = {
    rxnorm_code: rxnorm,
    drug_name: drugName,
    strength,
    dose_form: resource?.form?.text ?? null,
    full_display: fullDisplay,
    drug_class: extString(resource, "urn:spehr:drug-class"),
    typical_route: extString(resource, "urn:spehr:typical-route"),
    typical_frequency: extString(resource, "urn:spehr:typical-frequency"),
    is_high_alert: extBool(resource, "urn:spehr:high-alert") ?? false,
    synced_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  const { error } = await admin
    .from("formulary_catalog")
    .upsert(row, { onConflict: "rxnorm_code" });
  if (error) return { ok: false, reason: error.message };
  return { ok: true };
}

async function pollType(admin: any, target: PollTarget) {
  const { resourceType, tag, stateKey } = target;
  const since = await readState(admin, stateKey);
  // guard against the future — HAPI stores timestamps in server time; use a
  // tiny slack so we don't miss anything written in the same second.
  const cutoff = new Date().toISOString();

  const base = `${FHIR_SERVER_URL}/${resourceType}`;
  const params = new URLSearchParams({
    _tag: tag,
    _lastUpdated: `gt${since}`,
    _count: String(PAGE_SIZE),
    _sort: "_lastUpdated",
  });
  let url: string | null = `${base}?${params.toString()}`;

  const stats = { fetched: 0, ingested: 0, skipped: 0, failed: 0, pages: 0 };
  let maxSeen: string = since;

  for (let page = 0; page < MAX_PAGES && url; page++) {
    stats.pages++;
    const bundle = await fetchBundle(url);
    const entries: any[] = bundle?.entry ?? [];
    for (const e of entries) {
      const resource = e?.resource;
      if (!resource) continue;
      stats.fetched++;
      const lu = resource?.meta?.lastUpdated;
      if (lu) maxSeen = isoMax(lu, maxSeen);

      if (resourceType === "Medication") {
        const res = await upsertMedicationResource(admin, resource);
        if (res.ok) stats.ingested++;
        else stats.failed++;
        await logIngestEvent(admin, {
          source: "poll",
          resourceType: "Medication",
          fhirId: resource?.id ?? null,
          outcome: res.ok ? { ok: true, action: "upserted" } : { ok: false, reason: res.reason ?? "unknown" },
        });
      } else {
        const { outcome, resourceType: rt, fhirId } = await ingestFhirResource(admin, resource);
        if (outcome.ok) {
          if ((outcome as any).skipped) stats.skipped++;
          else stats.ingested++;
        } else {
          stats.failed++;
        }
        await logIngestEvent(admin, { source: "poll", resourceType: rt, fhirId, outcome });
      }
    }
    url = nextLink(bundle);
  }

  // ── Cursor advancement (read before changing) ──────────────────────────
  // `url` is non-null here iff we stopped because of MAX_PAGES while the
  // server still had a `next` page, i.e. there is un-fetched data past
  // `maxSeen`.
  //
  // BEFORE (data-loss bug): the cursor was always set to
  // `isoMax(cutoff, maxSeen)`. `cutoff` is taken before the fetch, so it is
  // >= every lastUpdated we saw, and the cursor landed on `cutoff` even when
  // the page cap was hit. Example: since=10:00, 1,500 matching records
  // stamped 10:00–10:04, cutoff=10:05. We fetch 20×50 = 1,000 (up to about
  // 10:02:40) and write cursor=10:05. The next tick asks for
  // `_lastUpdated=gt10:05`, so the other 500 records are never fetched. They
  // are lost for good, not just delayed.
  //
  // AFTER: the cursor only jumps to `cutoff` when the poll drained the result
  // set (no `next` link left). When the cap was hit, it moves only to the last
  // record we actually processed, like `pollClinical`'s `lastAdvanced` in
  // fhir-outbound-poll. The next tick picks up where this one stopped, so a
  // spike takes several ticks instead of losing data. In the example the
  // cursor becomes about 10:02:40 and the next tick fetches the other 500.
  //
  // Tie handling: the search uses `gt`, and the page cap can fall in the
  // middle of a group of records that share the same lastUpdated (e.g. from
  // one HAPI transaction bundle). Writing `maxSeen` itself would skip the
  // unfetched members of that group. So on a capped poll we write
  // `maxSeen - 1ms`. The next tick re-reads that millisecond, and
  // re-ingesting those records is harmless because ingest upserts on
  // fhir_id / rxnorm_code. One edge case: if a whole capped run sits inside
  // a single millisecond (more than PAGE_SIZE*MAX_PAGES records with one
  // timestamp), backing off would repeat the same window forever. In that
  // case we move to `maxSeen` and log a warning. That skip is still much
  // smaller than the old one, and the log makes it visible.
  //
  // The cursor never moves backwards (it is always >= `since`).
  const truncated = url !== null;
  let nextCursor: string;
  if (!truncated) {
    // Drained: nothing left on the server up to fetch time. Advance to the
    // pre-poll wall clock so an empty poll doesn't rescan forever.
    nextCursor = isoMax(cutoff, maxSeen);
  } else {
    const sinceMs = new Date(since).getTime();
    const seenMs = new Date(maxSeen).getTime();
    const resumeMs = seenMs - 1;
    if (resumeMs > sinceMs) {
      nextCursor = new Date(resumeMs).toISOString();
    } else if (seenMs > sinceMs) {
      console.warn(
        `[fhir-inbound-poll] ${resourceType} (${tag}): >${PAGE_SIZE * MAX_PAGES} records share lastUpdated=${maxSeen}; ` +
          `force-advancing cursor to it — remaining same-timestamp records may be skipped`,
      );
      nextCursor = maxSeen;
    } else {
      // Capped but made no forward progress (e.g. empty pages with a next
      // link). Hold the cursor and retry next tick.
      nextCursor = since;
    }
  }
  await writeState(admin, stateKey, nextCursor);

  return { resourceType, tag, since, nextCursor, truncated, ...stats };
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
    const results: Record<string, unknown> = {};
    for (const target of POLL_TARGETS) {
      results[target.label] = await pollType(admin, target);
    }
    return json({ ok: true, ranAt: new Date().toISOString(), ...results });
  } catch (e) {
    console.error("[fhir-inbound-poll] error", e);
    return json({ ok: false, error: (e as Error).message }, 500);
  }
});