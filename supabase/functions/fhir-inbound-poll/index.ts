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

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { ingestFhirResource, logIngestEvent } from "../_shared/fhir-ingest.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const FHIR_SERVER_URL = (Deno.env.get("FHIR_SERVER_URL") ?? "").replace(/\/+$/, "");
const FHIR_BEARER_TOKEN = Deno.env.get("FHIR_BEARER_TOKEN") ?? "";
const FHIR_APIKEY = Deno.env.get("FHIR_APIKEY") ?? "";

const MYSPEHR_TAG = "urn:spehr:source|myspehr";
const PAGE_SIZE = 50;
const MAX_PAGES = 20;

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

async function pollType(admin: any, resourceType: "Appointment" | "PaymentNotice", stateKey: string) {
  const since = await readState(admin, stateKey);
  // guard against the future — HAPI stores timestamps in server time; use a
  // tiny slack so we don't miss anything written in the same second.
  const cutoff = new Date().toISOString();

  const base = `${FHIR_SERVER_URL}/${resourceType}`;
  const params = new URLSearchParams({
    _tag: MYSPEHR_TAG,
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

      const { outcome, resourceType: rt, fhirId } = await ingestFhirResource(admin, resource);
      if (outcome.ok) {
        if ((outcome as any).skipped) stats.skipped++;
        else stats.ingested++;
      } else {
        stats.failed++;
      }
      await logIngestEvent(admin, { source: "poll", resourceType: rt, fhirId, outcome });
    }
    url = nextLink(bundle);
  }

  // Persist the newest lastUpdated we processed. Fall back to the pre-poll
  // wall clock so an empty poll still advances the cursor and we don't
  // re-scan the same window forever.
  const nextCursor = isoMax(cutoff, maxSeen);
  await writeState(admin, stateKey, nextCursor);

  return { resourceType, since, nextCursor, ...stats };
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
    const appt = await pollType(admin, "Appointment", "appointment_last_polled_at");
    const pay = await pollType(admin, "PaymentNotice", "paymentnotice_last_polled_at");
    return json({ ok: true, ranAt: new Date().toISOString(), appointment: appt, paymentNotice: pay });
  } catch (e) {
    console.error("[fhir-inbound-poll] error", e);
    return json({ ok: false, error: (e as Error).message }, 500);
  }
});