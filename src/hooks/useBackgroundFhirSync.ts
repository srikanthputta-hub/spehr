import { useEffect, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import {
  buildEncounterBundle,
  splitEncounterBundle,
  assessBundleQuality,
  buildEncounterBundleAsync,
  buildInvoiceResource,
  buildChargeItemResource,
  buildRealAppointmentResource,
  type EncounterAllergy,
  type FhirQuality,
} from "@/lib/fhir-bundle";
import { useAutoApiEnabled } from "@/hooks/useAutomationEnabled";

/**
 * Background FHIR live-sync. Runs at the app root so discharged-patient
 * encounter bundles are pushed to the Medblocks FHIR endpoint regardless
 * of which page the user is on (previously the loop only ran while the
 * FHIR Interoperability panel was mounted).
 *
 * Behavior:
 *  - Loads up to 200 most-recent discharged patients on boot, then refreshes
 *    every 30s.
 *  - Subscribes to realtime changes on patients / lab_orders /
 *    medication_orders / clinical_notes and requeues the affected MRN.
 *  - An event-driven drain pushes the next queued MRN bundle via
 *    the `fhir-proxy` edge function whenever realtime signals a change.
 *    Pushes are idempotent (PUT + stable resource ids), so re-firing never
 *    duplicates resources.
 *  - Respects the user's master toggle stored at `fhir.autoLoop.enabled`
 *    (same key the on-page panel writes), defaulting to ON.
 *  - Persists per-MRN outcomes to `fhir.pushedMrns` so the panel reflects
 *    background work the moment it opens.
 */

type Status = "queued" | "syncing" | "ok" | "err";

type Row = {
  mrn: string;
  name: string | null;
  facility_name: string | null;
  admission_time: string | null;
  discharge_time: string | null;
  status: string | null;
  chief_complaint: string | null;
};

function readEnabled(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const v = window.localStorage.getItem("fhir.autoLoop.enabled");
    return v === "0" ? false : true;
  } catch {
    return true;
  }
}

function persistPushed(mrn: string, outcome: "ok" | "err") {
  if (typeof window === "undefined") return;
  try {
    const raw = window.localStorage.getItem("fhir.pushedMrns");
    const obj = raw ? JSON.parse(raw) : {};
    obj[mrn] = outcome;
    window.localStorage.setItem("fhir.pushedMrns", JSON.stringify(obj));
  } catch {
    /* ignore */
  }
  try {
    // Same-tab mirror of the localStorage write above — the browser's
    // `storage` event only fires in OTHER tabs, so any mounted page (e.g.
    // the FHIR Interoperability admin panel) needs this to learn the real
    // outcome live instead of guessing.
    window.dispatchEvent(new CustomEvent("spehr:fhir-pushed", { detail: { mrn, outcome } }));
  } catch {
    /* ignore */
  }
}

/**
 * Fix #5/#6/#7: the engine previously created BOTH old-format ids
 * (`cond-mrn-{MRN}-hpi`, `allergy-mrn-{MRN}-environment-bee-sting`, ...)
 * and new-format ids (`cond-hpi-{MRN}`, `allergy-bee-sting-{MRN}`).
 * Every resource builder now uses the new format exclusively; this
 * helper sweeps the FHIR server once per MRN to DELETE any lingering
 * old-format ghosts so the audit shows a single canonical resource per
 * clinical fact. Successful cleanups are remembered in localStorage so
 * we never replay the sweep for the same MRN.
 */
export const OLD_ID_RE = /^(?:cond|allergy|medreq|medadmin|lab|vital|obs|composition)-mrn-/i;
const CLEAN_KEY = "fhir.cleanedOldIds";

function alreadyCleaned(mrn: string): boolean {
  if (typeof window === "undefined") return true;
  try {
    const raw = window.localStorage.getItem(CLEAN_KEY);
    const obj = raw ? JSON.parse(raw) : {};
    return !!obj[mrn];
  } catch {
    return false;
  }
}

function markCleaned(mrn: string) {
  if (typeof window === "undefined") return;
  try {
    const raw = window.localStorage.getItem(CLEAN_KEY);
    const obj = raw ? JSON.parse(raw) : {};
    obj[mrn] = Date.now();
    window.localStorage.setItem(CLEAN_KEY, JSON.stringify(obj));
  } catch {
    /* ignore */
  }
}

async function deleteOldFormatResource(resourceType: string, id: string) {
  try {
    await supabase.functions.invoke("fhir-proxy", {
      body: { method: "DELETE", path: `${resourceType}/${id}` },
    });
  } catch (e) {
    console.warn("[bg-fhir-sync] DELETE old-format failed", resourceType, id, e);
  }
}

async function cleanupOldFormatIds(mrn: string) {
  if (alreadyCleaned(mrn)) return;
  const types = [
    "Condition",
    "AllergyIntolerance",
    "MedicationRequest",
    "MedicationAdministration",
    "Observation",
    "Composition",
  ];
  for (const t of types) {
    try {
      const res = await supabase.functions.invoke("fhir-proxy", {
        body: {
          method: "GET",
          path: t,
          query: { patient: mrn, _count: "200", _elements: "id" },
        },
      });
      const data: any = res.data;
      const entries: any[] = Array.isArray(data?.entry) ? data.entry : [];
      for (const e of entries) {
        const id = String(e?.resource?.id ?? "");
        if (id && OLD_ID_RE.test(id)) {
          await deleteOldFormatResource(t, id);
        }
      }
    } catch (e) {
      console.warn("[bg-fhir-sync] cleanup query failed", t, mrn, e);
    }
  }
  markCleaned(mrn);
}

function persistQuality(mrn: string, quality: FhirQuality) {
  if (typeof window === "undefined") return;
  try {
    const raw = window.localStorage.getItem("fhir.quality");
    const obj = raw ? JSON.parse(raw) : {};
    obj[mrn] = {
      ok: quality.ok,
      missing: quality.missing,
      ts: Date.now(),
    };
    window.localStorage.setItem("fhir.quality", JSON.stringify(obj));
    window.dispatchEvent(new CustomEvent("spehr:fhir-quality"));
  } catch {
    /* ignore */
  }
}

async function flagSafetyAlert(mrn: string, quality: FhirQuality) {
  if (quality.ok) return;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (supabase.from("clinical_safety_alerts") as any).insert({
      mrn,
      alert_type: "fhir_data_quality",
      severity: "medium",
      title: "FHIR Data Quality: Degraded",
      description: `AUTO API could not resolve required codes: ${quality.missing.join(", ")}`,
      source: "auto-api",
      status: "open",
    });
  } catch {
    /* ignore — table may not exist locally */
  }
}

async function buildBundleForMrn(r: Row) {
  const [patientRes, labsRes, medsRes, notesRes, condsRes, allergiesRes, reactionsRes] =
    await Promise.all([
      supabase.from("patients").select("*").eq("mrn", r.mrn).maybeSingle(),
      supabase
        .from("lab_orders")
        .select("id, test_type, result_value, status, collected_at, created_at, loinc_code")
        .eq("patient_mrn", r.mrn)
        .order("created_at", { ascending: false })
        .limit(40),
      supabase
        .from("medication_orders")
        .select(
          "id, drug_name, drug, medication_name, dose, route, status, ordering_physician, ordered_by, administered_at, approved_at, created_at, rxnorm_code, rxnorm_display",
        )
        .eq("patient_mrn", r.mrn)
        .order("created_at", { ascending: false })
        .limit(200),
      supabase
        .from("clinical_notes")
        .select("id, note_type, author, content, created_at")
        .eq("mrn", r.mrn)
        .order("created_at", { ascending: false })
        .limit(20),
      supabase
        .from("conditions")
        .select(
          "display_text, snomed_code, snomed_display, icd10_code, icd10_display, verification_status, clinical_status, coded_at",
        )
        .eq("mrn", r.mrn)
        .order("coded_at", { ascending: false })
        .limit(20),
      supabase
        .from("allergies")
        .select("id, substance, reaction, severity, substance_rxcui, substance_snomed")
        .eq("mrn", r.mrn)
        .limit(40),
      supabase
        .from("allergy_reactions")
        .select(
          "allergy_id, manifestation, severity, snomed_code, snomed_display, meddra_code, meddra_display",
        )
        .eq("mrn", r.mrn)
        .limit(80),
    ]);
  const p = (patientRes.data ?? {}) as any;
  const reactionsByAllergy = new Map<string, any[]>();
  for (const rx of ((reactionsRes as any)?.data ?? []) as any[]) {
    const arr = reactionsByAllergy.get(rx.allergy_id) ?? [];
    arr.push(rx);
    reactionsByAllergy.set(rx.allergy_id, arr);
  }
  const allergies: EncounterAllergy[] = (((allergiesRes as any)?.data ?? []) as any[]).map((a) => ({
    id: a.id,
    substance: a.substance,
    reaction: a.reaction,
    severity: a.severity,
    substance_rxcui: a.substance_rxcui,
    substance_snomed: a.substance_snomed,
    reactions: reactionsByAllergy.get(a.id) ?? [],
  }));
  return buildEncounterBundleAsync({
    patient: {
      mrn: r.mrn,
      name: p.name ?? r.name,
      first_name: p.first_name ?? null,
      last_name: p.last_name ?? null,
      dob: p.dob ?? null,
      gender: p.gender ?? null,
      biological_sex: p.biological_sex ?? null,
      address: p.address ?? null,
      phone: p.phone ?? null,
      facility_name: p.facility_name ?? r.facility_name,
      admission_time: p.admission_time ?? r.admission_time,
      discharge_time: p.discharge_time ?? r.discharge_time,
      status: p.status ?? r.status,
      chief_complaint: p.chief_complaint ?? r.chief_complaint,
      diagnosis: p.diagnosis ?? null,
      discharge_summary: p.discharge_summary ?? null,
      bp: p.bp ?? null,
      hr: p.hr ?? null,
      rr: p.rr ?? null,
      spo2: p.spo2 ?? null,
      temp: p.temp ?? null,
      allergies: p.allergies ?? null,
      past_medical_history: p.past_medical_history ?? null,
    },
    labs: (labsRes.data ?? []) as any[],
    meds: (medsRes.data ?? []) as any[],
    notes: (notesRes.data ?? []) as any[],
    conditions: (condsRes.data ?? []) as any[],
    allergies,
  }).then(async (bundle) => {
    // ---- Part A: append Invoice / ChargeItem / real Appointment
    // resources for this MRN so billing + booking round-trip to
    // Medblocks alongside the clinical encounter. Uses the same
    // idempotent PUT-with-stable-id contract as everything else.
    try {
      const [invRes, chargesRes, apptRes] = await Promise.all([
        supabase
          .from("fhir_invoices")
          .select(
            "id, invoice_no, mrn, patient_name, facility_name, status, subtotal, tax, total, currency, issued_at, paid_at",
          )
          .eq("mrn", r.mrn)
          .order("issued_at", { ascending: false })
          .limit(50),
        supabase
          .from("fhir_charge_items")
          .select(
            "id, invoice_id, mrn, charge_code, code_system, description, category, quantity, unit_price, amount, currency, service_date",
          )
          .eq("mrn", r.mrn)
          .order("service_date", { ascending: false })
          .limit(200),
        supabase
          .from("fhir_appointments")
          .select(
            "id, fhir_id, facility_name, patient_mrn, patient_name, practitioner_name, service_type, description, start_time, end_time, status, comment",
          )
          .eq("patient_mrn", r.mrn)
          .order("start_time", { ascending: false })
          .limit(50),
      ]);
      const invoices = (invRes.data ?? []) as any[];
      const invoiceNoById = new Map<string, string>(
        invoices.map((i) => [String(i.id), String(i.invoice_no)]),
      );
      const extras: any[] = [];
      for (const inv of invoices) {
        try {
          extras.push(buildInvoiceResource(inv));
        } catch (e) {
          console.warn("[bg-fhir-sync] invoice build failed", inv.invoice_no, e);
        }
      }
      for (const ch of (chargesRes.data ?? []) as any[]) {
        try {
          extras.push(buildChargeItemResource(ch, invoiceNoById.get(String(ch.invoice_id))));
        } catch (e) {
          console.warn("[bg-fhir-sync] charge build failed", ch.id, e);
        }
      }
      for (const a of (apptRes.data ?? []) as any[]) {
        try {
          extras.push(buildRealAppointmentResource(a));
        } catch (e) {
          console.warn("[bg-fhir-sync] appointment build failed", a.id, e);
        }
      }
      if (extras.length > 0) {
        const existingEntries: any[] = Array.isArray(bundle.entry) ? bundle.entry : [];
        const existingKeys = new Set(
          existingEntries.map((e) => `${e?.resource?.resourceType}/${e?.resource?.id}`),
        );
        for (const res of extras) {
          const key = `${res.resourceType}/${res.id}`;
          if (existingKeys.has(key)) continue;
          existingKeys.add(key);
          existingEntries.push({
            fullUrl: key,
            resource: res,
            request: { method: "PUT", url: key },
          });
        }
        bundle.entry = existingEntries;
      }
    } catch (e) {
      console.warn("[bg-fhir-sync] billing/appt append failed", r.mrn, e);
    }
    return bundle;
  });
}

export function useBackgroundFhirSync() {
  const autoApiEnabled = useAutoApiEnabled();
  const rowsRef = useRef<Map<string, Row>>(new Map());
  const statusRef = useRef<Map<string, Status>>(new Map());
  const inFlightRef = useRef(false);
  const enabledRef = useRef(autoApiEnabled);
  enabledRef.current = autoApiEnabled;

  useEffect(() => {
    let cancelled = false;

    const enqueue = (mrn: string) => {
      const cur = statusRef.current.get(mrn);
      if (cur === "syncing") return;
      statusRef.current.set(mrn, "queued");
    };

    const loadRows = async () => {
      const { data } = await supabase
        .from("patients")
        .select("mrn, name, facility_name, admission_time, discharge_time, status, chief_complaint")
        .not("mrn", "is", null)
        .order("admission_time", { ascending: false })
        .limit(200);
      if (cancelled) return;
      for (const p of (data ?? []) as any[]) {
        const r: Row = {
          mrn: String(p.mrn),
          name: p.name ?? null,
          facility_name: p.facility_name ?? null,
          admission_time: p.admission_time ?? null,
          discharge_time: p.discharge_time ?? null,
          status: p.status ?? null,
          chief_complaint: p.chief_complaint ?? null,
        };
        // Full live sync mode: every patient is eligible regardless of
        // admission status. PUT-with-stable-id bundles are idempotent.
        // Re-enqueue whenever an existing patient's discharge_time or
        // status changes (e.g. admitted → discharged) so a previously
        // ✓ Successful badge does NOT freeze us out of syncing the
        // discharge encounter, late labs, manual med orders, etc.
        const prev = rowsRef.current.get(r.mrn);
        const changed =
          !prev ||
          prev.status !== r.status ||
          prev.discharge_time !== r.discharge_time ||
          prev.admission_time !== r.admission_time ||
          prev.chief_complaint !== r.chief_complaint;
        rowsRef.current.set(r.mrn, r);
        if (!statusRef.current.has(r.mrn) || changed) enqueue(r.mrn);
      }
    };

    const pushNext = async () => {
      if (cancelled || inFlightRef.current) return;
      if (!readEnabled()) return;
      if (!enabledRef.current) return;
      let target: Row | null = null;
      for (const [mrn, st] of statusRef.current) {
        if (st !== "queued") continue;
        const row = rowsRef.current.get(mrn);
        if (row) {
          target = row;
          break;
        }
      }
      if (!target) return;
      inFlightRef.current = true;
      statusRef.current.set(target.mrn, "syncing");
      try {
        const bundle = await buildBundleForMrn(target);
        // FHIR Data Quality self-test: persist verdict so the banner can
        // flag "Degraded / Incomplete" when AUTO API hasn't (yet) resolved
        // the minimum required codes for the encounter.
        const quality = assessBundleQuality(bundle);
        persistQuality(target.mrn, quality);
        if (!quality.ok) void flagSafetyAlert(target.mrn, quality);
        const isDischarged =
          (target.status ?? "").toLowerCase() === "discharged" || !!target.discharge_time;
        if (isDischarged) {
          // Pre-push conformance validation. Fail-open: helper logs to
          // auto_doc_logs, persists the banner state, and never throws.
          try {
            const { validateDischargeConformance } = await import("@/lib/discharge-conformance");
            await validateDischargeConformance(bundle, target.mrn);
          } catch (e) {
            console.warn("[discharge-conformance]", target.mrn, e);
          }
          // Two-phase discharge push: persist Encounter (status=finished +
          // period.end), confirmed discharge Condition, all MedicationRequests
          // / MedicationAdministrations, labs and notes FIRST. Then re-PUT
          // the Composition so its lab / medication sections reference
          // resources that are already live on the FHIR server.
          const { primary, composition } = splitEncounterBundle(bundle);
          const first = await supabase.functions.invoke("fhir-proxy", {
            body: { mrn: target.mrn, bundle: primary },
          });
          if (first.error) throw first.error;
          if (first.data?.success === false) throw new Error(first.data?.error ?? "Sync failed");
          if (composition) {
            const second = await supabase.functions.invoke("fhir-proxy", {
              body: { mrn: target.mrn, bundle: composition },
            });
            if (second.error) throw second.error;
            if (second.data?.success === false)
              throw new Error(second.data?.error ?? "Composition sync failed");
          }
        } else {
          const { data, error } = await supabase.functions.invoke("fhir-proxy", {
            body: { mrn: target.mrn, bundle },
          });
          if (error) throw error;
          if (data?.success === false) throw new Error(data?.error ?? "Sync failed");
        }
        statusRef.current.set(target.mrn, "ok");
        persistPushed(target.mrn, "ok");
        // One-shot sweep of legacy `*-mrn-{MRN}-*` ids so the FHIR server
        // never holds parallel old + new resources for the same fact.
        void cleanupOldFormatIds(target.mrn);
      } catch (e) {
        console.warn("[bg-fhir-sync]", target.mrn, e);
        statusRef.current.set(target.mrn, "err");
        persistPushed(target.mrn, "err");
      } finally {
        inFlightRef.current = false;
      }
    };

    void loadRows();
    const refresh = setInterval(() => void loadRows(), 30_000);

    // Event-driven drain: whenever realtime enqueues an MRN (or loadRows
    // discovers a changed row), keep pushing until the queue is empty.
    // No polling — each call is triggered by an actual data change.
    const drain = async () => {
      if (cancelled) return;
      // Serialize: pushNext short-circuits when inFlight, so loop until
      // no queued row remains.
      // Guard against runaway loops with a hard cap per drain invocation.
      for (let i = 0; i < 500; i++) {
        if (cancelled || inFlightRef.current) return;
        const hasQueued = Array.from(statusRef.current.values()).some((s) => s === "queued");
        if (!hasQueued) return;
        await pushNext();
      }
    };

    const requeueByMrn = (mrn: string | null | undefined) => {
      if (!mrn) return;
      const row = rowsRef.current.get(mrn);
      if (!row) {
        // Unknown MRN — refresh the discharged set so we pick it up.
        void loadRows().then(() => void drain());
        return;
      }
      enqueue(mrn);
      void drain();
    };

    const channel = supabase
      .channel("bg-fhir-live-sync")
      .on("postgres_changes", { event: "*", schema: "public", table: "patients" }, (p: any) => {
        const mrn = p?.new?.mrn ?? p?.old?.mrn;
        // Refresh row map on any patient change so newly admitted /
        // updated patients enter the live sync queue immediately.
        void loadRows().then(() => void drain());
        requeueByMrn(mrn);
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "lab_orders" }, (p: any) =>
        requeueByMrn(p?.new?.patient_mrn ?? p?.old?.patient_mrn),
      )
      .on("postgres_changes", { event: "*", schema: "public", table: "lab_results" }, (p: any) =>
        requeueByMrn(p?.new?.patient_mrn ?? p?.old?.patient_mrn ?? p?.new?.mrn ?? p?.old?.mrn),
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "medication_orders" },
        (p: any) => requeueByMrn(p?.new?.patient_mrn ?? p?.old?.patient_mrn),
      )
      .on("postgres_changes", { event: "*", schema: "public", table: "vitals" }, (p: any) =>
        requeueByMrn(p?.new?.patient_mrn ?? p?.old?.patient_mrn ?? p?.new?.mrn ?? p?.old?.mrn),
      )
      .on("postgres_changes", { event: "*", schema: "public", table: "clinical_notes" }, (p: any) =>
        requeueByMrn(p?.new?.mrn ?? p?.old?.mrn),
      )
      .on("postgres_changes", { event: "*", schema: "public", table: "fhir_invoices" }, (p: any) =>
        requeueByMrn(p?.new?.mrn ?? p?.old?.mrn),
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "fhir_charge_items" },
        (p: any) => requeueByMrn(p?.new?.mrn ?? p?.old?.mrn),
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "fhir_appointments" },
        (p: any) => requeueByMrn(p?.new?.patient_mrn ?? p?.old?.patient_mrn),
      )
      .subscribe();

    // Initial drain after the first loadRows completes so anything
    // enqueued on boot gets pushed once, without polling.
    void (async () => {
      // small delay to let loadRows finish (it was kicked off above)
      await new Promise((r) => setTimeout(r, 500));
      void drain();
    })();

    return () => {
      cancelled = true;
      clearInterval(refresh);
      void supabase.removeChannel(channel);
    };
  }, []);
}
