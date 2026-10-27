// Transfer-Out Delete Worker — server-side, service-role replacement for the
// direct anon `patients.delete()` call in admin-dashboard's approveTransfer().
//
// Why this exists:
//   The app runs entirely as Postgres `anon` (no auth). `public.patients` has
//   RLS enabled with SELECT/INSERT/UPDATE policies open to `{public}`, but the
//   only DELETE policy ("Authenticated users can discharge patients") is
//   scoped to `{authenticated}`. An anon DELETE therefore matches zero rows
//   and PostgREST returns 0 affected rows with NO error — so the caller's
//   `if (error) throw` never fires and the UI shows a false success toast
//   while the patient row is left completely untouched.
//
//   Rather than opening a broad anon DELETE policy on a table holding patient
//   records (a much larger blast radius for a table that otherwise has no
//   anon delete surface at all), this permanently deletes the patient here,
//   server-side, with the service-role key (which bypasses RLS safely) —
//   mirroring the same pattern `ghost-discharge-worker` already uses for the
//   other irreversible, service-role-gated action in this app (discharge).
//
//   This is intentionally a separate function rather than folded into
//   `ghost-discharge-worker`: that worker's whole job is discharging a
//   patient in place (write a DISCHARGE_SUMMARY note, flip
//   status='Discharged', free the bed, push a discharge FHIR Composition).
//   An outside-network transfer is the opposite of a discharge — the patient
//   isn't being discharged, they're leaving this facility's system entirely,
//   and the record is deleted outright with no discharge narrative to write.
//   Forcing that through the discharge worker's validation/branching would
//   just be confusing; a small, focused, analogous function is the better
//   fit.
//
// What it does:
//   1. Requires both `mrn` and `transfer_id` in the request body.
//   2. Loads the `patient_transfers` row by `transfer_id` and verifies it:
//        - exists
//        - belongs to the given `mrn`
//        - has status 'Approved' (the admin-dashboard CAS update to
//          'Approved' must have already committed before this is called)
//      This is a defense-in-depth check — the frontend has already decided
//      the destination is outside the in-network set before calling this —
//      so a stray/forged call can't delete a patient with no matching
//      approved transfer behind it.
//   3. Deletes the `patients` row for that `mrn` using the service-role
//      client (bypasses RLS, so — unlike the anon call it replaces — this
//      actually deletes the row).
//   4. Returns a clear { ok, mrn, deleted, reason? } result the frontend
//      must check before showing any success toast.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  let body: any = {};
  try {
    body = await req.json();
  } catch {
    /* empty/invalid body handled by validation below */
  }

  const mrn: string | undefined = typeof body?.mrn === "string" ? body.mrn : undefined;
  const transferId: string | undefined =
    typeof body?.transfer_id === "string" ? body.transfer_id : undefined;

  if (!mrn || !transferId) {
    return json(
      { ok: false, mrn: mrn ?? null, deleted: false, reason: "missing_mrn_or_transfer_id" },
      400,
    );
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: transfer, error: transferErr } = await admin
    .from("patient_transfers")
    .select("id, patient_mrn, status, destination_facility")
    .eq("id", transferId)
    .maybeSingle();

  if (transferErr) {
    return json(
      { ok: false, mrn, deleted: false, reason: `transfer_lookup_failed: ${transferErr.message}` },
      500,
    );
  }
  if (!transfer) {
    return json({ ok: false, mrn, deleted: false, reason: "transfer_not_found" }, 404);
  }
  if (transfer.patient_mrn !== mrn) {
    return json({ ok: false, mrn, deleted: false, reason: "transfer_mrn_mismatch" }, 409);
  }
  if (transfer.status !== "Approved") {
    return json(
      {
        ok: false,
        mrn,
        deleted: false,
        reason: `transfer_not_approved (status=${transfer.status})`,
      },
      409,
    );
  }

  const { data: deletedRows, error: delErr } = await admin
    .from("patients")
    .delete()
    .eq("mrn", mrn)
    .select("mrn");

  if (delErr) {
    return json(
      { ok: false, mrn, deleted: false, reason: `patient_delete_failed: ${delErr.message}` },
      500,
    );
  }
  if (!deletedRows || deletedRows.length === 0) {
    return json(
      { ok: false, mrn, deleted: false, reason: "patient_not_found_or_already_deleted" },
      404,
    );
  }

  return json({ ok: true, mrn, deleted: true });
});
