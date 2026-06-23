import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import { buildEncounterBundle } from "@/lib/fhir-bundle";

/**
 * Background event-driven FHIR sync hook (Auto IT).
 *
 * Invoked by Postgres triggers on patients / lab_orders / medication_orders /
 * clinical_notes for every INSERT, UPDATE, or DELETE. For each affected MRN
 * the hook:
 *   1. Re-reads the full longitudinal record from the database (idempotent).
 *   2. Rebuilds the canonical FHIR R4 encounter Bundle.
 *   3. Forwards it through the secure `fhir-proxy` edge function — the
 *      bundle entries already carry `request.method = PUT` with stable
 *      resource IDs (and DELETE directives for voided rows downstream),
 *      guaranteeing zero duplicates on the external FHIR server.
 *   4. Writes `patients.last_fhir_sync = now()` on success so the dashboard
 *      can render the live timestamp.
 *
 * Runs entirely on the server — the dashboard never participates.
 */
export const Route = createFileRoute("/api/public/hooks/fhir-auto-sync")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let body: any = null;
        try {
          body = await request.json();
        } catch {
          return new Response(JSON.stringify({ error: "Invalid JSON body" }), { status: 400 });
        }
        const mrn = String(body?.mrn ?? "").trim();
        const event = String(body?.event ?? "UPDATE").toUpperCase();
        const table = String(body?.table ?? "");
        if (!mrn) {
          return new Response(JSON.stringify({ error: "mrn required" }), { status: 400 });
        }

        const SUPABASE_URL = process.env.SUPABASE_URL!;
        const SERVICE_KEY =
          process.env.SUPABASE_SERVICE_ROLE_KEY ||
          process.env.SUPABASE_PUBLISHABLE_KEY!;
        const ANON_KEY =
          process.env.SUPABASE_PUBLISHABLE_KEY ||
          process.env.SUPABASE_ANON_KEY ||
          SERVICE_KEY;

        const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
          auth: { persistSession: false, autoRefreshToken: false },
        });

        try {
          // 1) Read the patient. If the patient row was deleted, push a
          //    DELETE directive to remove the Patient resource upstream.
          const { data: patient } = await admin
            .from("patients")
            .select("*")
            .eq("mrn", mrn)
            .maybeSingle();

          if (!patient && table === "patients" && event === "DELETE") {
            await fetch(`${SUPABASE_URL}/functions/v1/fhir-proxy`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                apikey: ANON_KEY,
                Authorization: `Bearer ${ANON_KEY}`,
              },
              body: JSON.stringify({ method: "DELETE", path: `/Patient/${mrn}` }),
            }).catch(() => null);
            return new Response(JSON.stringify({ ok: true, deleted: true }), {
              headers: { "Content-Type": "application/json" },
            });
          }
          if (!patient) {
            return new Response(JSON.stringify({ ok: true, skipped: "patient_missing" }), {
              headers: { "Content-Type": "application/json" },
            });
          }

          // 2) Re-read related rows
          const [labsRes, medsRes, notesRes] = await Promise.all([
            admin
              .from("lab_orders")
              .select("id, test_type, result_value, status, collected_at, created_at")
              .eq("patient_mrn", mrn)
              .order("created_at", { ascending: false })
              .limit(80),
            admin
              .from("medication_orders")
              .select(
                "id, drug_name, drug, medication_name, dose, route, status, ordering_physician, ordered_by, administered_at, approved_at, created_at",
              )
              .eq("patient_mrn", mrn)
              .order("created_at", { ascending: false })
              .limit(80),
            admin
              .from("clinical_notes")
              .select("id, note_type, author, content, created_at")
              .eq("mrn", mrn)
              .order("created_at", { ascending: false })
              .limit(40),
          ]);

          // 3) Build canonical bundle
          const bundle = buildEncounterBundle({
            patient: {
              mrn,
              name: (patient as any).name ?? null,
              first_name: (patient as any).first_name ?? null,
              last_name: (patient as any).last_name ?? null,
              dob: (patient as any).dob ?? null,
              gender: (patient as any).gender ?? null,
              biological_sex: (patient as any).biological_sex ?? null,
              address: (patient as any).address ?? null,
              phone: (patient as any).phone ?? null,
              facility_name: (patient as any).facility_name ?? null,
              admission_time: (patient as any).admission_time ?? null,
              discharge_time: (patient as any).discharge_time ?? null,
              status: (patient as any).status ?? null,
              chief_complaint: (patient as any).chief_complaint ?? null,
              diagnosis: (patient as any).diagnosis ?? null,
              discharge_summary: (patient as any).discharge_summary ?? null,
              bp: (patient as any).bp ?? null,
              hr: (patient as any).hr ?? null,
              rr: (patient as any).rr ?? null,
              spo2: (patient as any).spo2 ?? null,
              temp: (patient as any).temp ?? null,
              allergies: (patient as any).allergies ?? null,
            },
            labs: (labsRes.data ?? []) as any[],
            meds: (medsRes.data ?? []) as any[],
            notes: (notesRes.data ?? []) as any[],
          });

          // 4) Push via secure proxy (PUT-with-stable-id bundle = idempotent)
          const upstream = await fetch(`${SUPABASE_URL}/functions/v1/fhir-proxy`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              apikey: ANON_KEY,
              Authorization: `Bearer ${ANON_KEY}`,
            },
            body: JSON.stringify({ mrn, bundle }),
          });
          const raw = await upstream.text();
          let resBody: any = raw;
          try { resBody = JSON.parse(raw); } catch { /* keep text */ }
          const ok = upstream.ok && resBody?.success !== false;

          // 5) Stamp last_fhir_sync on success
          if (ok) {
            await admin
              .from("patients")
              .update({ last_fhir_sync: new Date().toISOString() })
              .eq("mrn", mrn);
          }

          return new Response(
            JSON.stringify({ ok, mrn, event, table, upstream: resBody }),
            { headers: { "Content-Type": "application/json" } },
          );
        } catch (e) {
          console.error("[fhir-auto-sync hook]", mrn, e);
          return new Response(
            JSON.stringify({ ok: false, error: (e as Error).message }),
            { status: 500, headers: { "Content-Type": "application/json" } },
          );
        }
      },
    },
  },
});