import { useEffect, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import { buildEncounterBundle } from "@/lib/fhir-bundle";

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
 *  - A 400ms heartbeat picks the next queued MRN and pushes its bundle via
 *    the `fhir-proxy` edge function. Pushes are idempotent (PUT + stable
 *    resource ids), so re-firing never duplicates resources.
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
}

async function buildBundleForMrn(r: Row) {
  const [patientRes, labsRes, medsRes, notesRes] = await Promise.all([
    supabase.from("patients").select("*").eq("mrn", r.mrn).maybeSingle(),
    supabase
      .from("lab_orders")
      .select("id, test_type, result_value, status, collected_at, created_at")
      .eq("patient_mrn", r.mrn)
      .order("created_at", { ascending: false })
      .limit(40),
    supabase
      .from("medication_orders")
      .select(
        "id, drug_name, drug, medication_name, dose, route, status, ordering_physician, ordered_by, administered_at, approved_at, created_at",
      )
      .eq("patient_mrn", r.mrn)
      .order("created_at", { ascending: false })
      .limit(40),
    supabase
      .from("clinical_notes")
      .select("id, note_type, author, content, created_at")
      .eq("mrn", r.mrn)
      .order("created_at", { ascending: false })
      .limit(20),
  ]);
  const p = (patientRes.data ?? {}) as any;
  return buildEncounterBundle({
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
    },
    labs: (labsRes.data ?? []) as any[],
    meds: (medsRes.data ?? []) as any[],
    notes: (notesRes.data ?? []) as any[],
  });
}

export function useBackgroundFhirSync() {
  const rowsRef = useRef<Map<string, Row>>(new Map());
  const statusRef = useRef<Map<string, Status>>(new Map());
  const inFlightRef = useRef(false);

  useEffect(() => {
    let cancelled = false;

    const isDischarged = (r: Row) =>
      (r.status ?? "").toLowerCase() === "discharged" || !!r.discharge_time;

    const enqueue = (mrn: string) => {
      const cur = statusRef.current.get(mrn);
      if (cur === "syncing") return;
      statusRef.current.set(mrn, "queued");
    };

    const loadRows = async () => {
      const { data } = await supabase
        .from("patients")
        .select(
          "mrn, name, facility_name, admission_time, discharge_time, status, chief_complaint",
        )
        .eq("status", "Discharged")
        .not("mrn", "is", null)
        .order("discharge_time", { ascending: false })
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
        if (!isDischarged(r)) continue;
        rowsRef.current.set(r.mrn, r);
        if (!statusRef.current.has(r.mrn)) enqueue(r.mrn);
      }
    };

    const pushNext = async () => {
      if (cancelled || inFlightRef.current) return;
      if (!readEnabled()) return;
      let target: Row | null = null;
      for (const [mrn, st] of statusRef.current) {
        if (st !== "queued") continue;
        const row = rowsRef.current.get(mrn);
        if (row) { target = row; break; }
      }
      if (!target) return;
      inFlightRef.current = true;
      statusRef.current.set(target.mrn, "syncing");
      try {
        const bundle = await buildBundleForMrn(target);
        const { data, error } = await supabase.functions.invoke("fhir-proxy", {
          body: { mrn: target.mrn, bundle },
        });
        if (error) throw error;
        if (data?.success === false) throw new Error(data?.error ?? "Sync failed");
        statusRef.current.set(target.mrn, "ok");
        persistPushed(target.mrn, "ok");
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
    const heartbeat = setInterval(() => void pushNext(), 400);

    const requeueByMrn = (mrn: string | null | undefined) => {
      if (!mrn) return;
      const row = rowsRef.current.get(mrn);
      if (!row) {
        // Unknown MRN — refresh the discharged set so we pick it up.
        void loadRows();
        return;
      }
      enqueue(mrn);
    };

    const channel = supabase
      .channel("bg-fhir-live-sync")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "patients" },
        (p: any) => {
          const mrn = p?.new?.mrn ?? p?.old?.mrn;
          const status = (p?.new?.status ?? "").toLowerCase();
          if (status === "discharged") {
            // Newly discharged — make sure row map knows about them.
            void loadRows();
          }
          requeueByMrn(mrn);
        },
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "lab_orders" },
        (p: any) => requeueByMrn(p?.new?.patient_mrn ?? p?.old?.patient_mrn),
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "medication_orders" },
        (p: any) => requeueByMrn(p?.new?.patient_mrn ?? p?.old?.patient_mrn),
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "clinical_notes" },
        (p: any) => requeueByMrn(p?.new?.mrn ?? p?.old?.mrn),
      )
      .subscribe();

    return () => {
      cancelled = true;
      clearInterval(refresh);
      clearInterval(heartbeat);
      void supabase.removeChannel(channel);
    };
  }, []);
}