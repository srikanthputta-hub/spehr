// One-shot registrar. Reads FHIR_WEBHOOK_SECRET from env, constructs the
// inbound webhook URL, and POSTs two Subscription resources to Medblocks
// via the fhir-proxy edge function. Requires the caller to be logged in
// (verify_jwt default = true). Safe to re-run: it first searches for
// existing spehr-registered subscriptions and deletes them so we always
// end up with exactly one Appointment + one PaymentNotice subscription.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const WEBHOOK_SECRET = Deno.env.get("FHIR_WEBHOOK_SECRET") ?? "";

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

async function fhirProxy(body: unknown) {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/fhir-proxy`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      apikey: ANON_KEY,
      authorization: `Bearer ${ANON_KEY}`,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown = text;
  try { parsed = JSON.parse(text); } catch { /* leave as text */ }
  return { status: res.status, body: parsed };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (!WEBHOOK_SECRET) return json({ ok: false, error: "FHIR_WEBHOOK_SECRET missing" }, 500);

  const webhookUrl =
    `${SUPABASE_URL}/functions/v1/fhir-inbound-webhook` +
    `?key=${encodeURIComponent(WEBHOOK_SECRET)}`;

  // 1. Wipe existing subscriptions tagged as ours (idempotent re-register).
  const existing = await fhirProxy({
    method: "GET",
    path: "/Subscription",
    query: { _tag: "urn:spehr:source|spehr", _count: "50" },
  });
  const removed: string[] = [];
  const entries: any[] = Array.isArray((existing.body as any)?.entry)
    ? (existing.body as any).entry
    : [];
  for (const e of entries) {
    const id = e?.resource?.id;
    if (id) {
      await fhirProxy({ method: "DELETE", path: `/Subscription/${id}` });
      removed.push(id);
    }
  }

  const meta = { tag: [{ system: "urn:spehr:source", code: "spehr" }] };
  const subscriptions = [
    {
      resourceType: "Subscription",
      status: "requested",
      reason: "spehr ← myspehr: appointments booked in the patient portal",
      criteria: "Appointment?_tag=urn:spehr:source|myspehr",
      channel: {
        type: "rest-hook",
        endpoint: webhookUrl,
        payload: "application/fhir+json",
      },
      meta,
    },
    {
      resourceType: "Subscription",
      status: "requested",
      reason: "spehr ← myspehr: patient invoice payments",
      criteria: "PaymentNotice?_tag=urn:spehr:source|myspehr",
      channel: {
        type: "rest-hook",
        endpoint: webhookUrl,
        payload: "application/fhir+json",
      },
      meta,
    },
  ];

  const created: Array<{ criteria: string; status: number; id?: string; body?: unknown }> = [];
  for (const sub of subscriptions) {
    const res = await fhirProxy({ method: "POST", path: "/Subscription", body: sub });
    created.push({
      criteria: sub.criteria,
      status: res.status,
      id: (res.body as any)?.id,
      body: res.body,
    });
  }

  return json({ ok: true, webhookUrl: webhookUrl.replace(WEBHOOK_SECRET, "***"), removed, created });
});