// Auto Terminologist Cycle — server-side, browser-independent trigger for
// the Auto Terminologist 10-minute background cycle.
//
// Why this exists:
//   The cycle (demand-queue processing, VSAC publication polling,
//   Drug-Allergy pair auto-linking, the proactive sweep, value-set
//   staleness flagging) used to run ONLY from
//   `src/hooks/useAutoTerminologist.ts`, a client-side React
//   `setInterval` — so it went completely silent for ~28.7h (confirmed
//   via `auto_terminologist_log`'s heartbeat gap: 2026-11-16 14:28 ->
//   2026-11-17 19:11, the exact moment a browser tab was reopened)
//   whenever nobody had the app open. The "Loop active · 10 min cadence"
//   badge in the UI was misleading — it was only ever active while a tab
//   was open.
//
// What it does:
//   Scheduled by `pg_cron` every 10 minutes
//   (supabase/migrations/20261117201000_auto_terminologist_server_side_cycle.sql),
//   independent of any open tab. Calls the SAME shared cycle
//   (`../_shared/auto-terminologist-cycle.ts`) the React hook calls — no
//   forked copy — using a service-role client. Races the open-tab hook
//   for the same DB-backed `auto_terminologist` lease (claimLease), keyed
//   by a holder id unique to this invocation, so the two trigger paths
//   can never double-run a cycle; whichever claims it for a given
//   ~10-minute window runs it.
//
// Mode: POST {} — the only mode. No per-MRN/force options (unlike
// ghost-discharge-worker) since this isn't patient-scoped.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import {
  claimLease,
  heartbeatLease,
  runAutoTerminologistCycle,
} from "../_shared/auto-terminologist-cycle.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Unique per invocation so a heartbeat from one overlapping invocation
  // (e.g. the previous cron tick still finishing when the next one fires)
  // can never renew a lease a *different* invocation now holds.
  const holder = `edge-fn:${crypto.randomUUID()}`;

  const claimed = await claimLease(admin, holder);
  if (!claimed) {
    return json({ ok: true, ran: false, reason: "lease-held-elsewhere-or-cadence-not-elapsed" });
  }

  try {
    await admin.from("auto_terminologist_log").insert({
      message: `${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} — Cycle started (edge function).`,
      action: "heartbeat",
    });

    const summary = await runAutoTerminologistCycle(admin, holder);
    return json({ ok: true, ...summary });
  } catch (e) {
    console.error("[auto-terminologist-cycle] cycle failed", e);
    return json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 500);
  } finally {
    // Release the lease (negative lease -> leased_until moves into the
    // past) so the next scheduled run — or the open-tab hook — doesn't
    // have to wait out the full TTL. Awaited here (unlike the hook's
    // fire-and-forget `releaseLeaseBestEffort`) since the function
    // instance can be torn down right after this handler returns.
    await heartbeatLease(admin, holder, -1000);
  }
});
