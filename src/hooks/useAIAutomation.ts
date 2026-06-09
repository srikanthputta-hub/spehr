import { useEffect, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import {
  medsForComplaint,
  labsForComplaint,
} from "@/lib/complaint-protocols";
import { getAutomationEnabled, useAutomationEnabled } from "@/hooks/useAutomationEnabled";

/* ------------------------------------------------------------------ */
/* Admission Randomizer — Staged Cascade                              */
/* ------------------------------------------------------------------ */
/* Whenever a patient is admitted (auto OR manual), schedule:         */
/*   • 3 medications — first inserted at T+20s, then 15s gap each.    */
/*     Each med cycles: ORDERED → PENDING_VERIFICATION → DISPENSED    */
/*     → ADMINISTERED with 3s between each transition.                */
/*   • 2 lab tests — first at T+20s, then 15s gap. Each cycles:       */
/*     ORDERED → PROCESSING → RESULTED (3s between transitions).      */
/* The Pharmacy and Lab boards show the live transitions in their    */
/* pending queues; everything is keyed off the patient's MRN.         */
/* ------------------------------------------------------------------ */

interface NewPatient {
  id: string;
  mrn: string | null;
  first_name: string | null;
  last_name: string | null;
  name: string | null;
  facility_name: string | null;
  chief_complaint: string | null;
}

interface InsertedOrder {
  id: string;
  status: string | null;
  ordered_by?: string | null;
  patient_mrn?: string | null;
  mrn?: string | null;
  test_type?: string | null;
}

// Medication cascade — orders placed at T+20, T+35, T+50.
const MED_FIRST_ORDER_DELAY_MS = 20_000;
const MED_ORDER_GAP_MS = 15_000;
// Lab cascade — orders placed at T+25 and T+45.
const LAB_FIRST_ORDER_DELAY_MS = 25_000;
const LAB_ORDER_GAP_MS = 20_000;
// 3 seconds between status transitions for both engines.
const TRANSITION_GAP_MS = 3_000;

/* ------------------------------------------------------------------ */
/* MRN-keyed timer registry — every setTimeout scheduled by the       */
/* cascade is tracked here so the hook's effect cleanup (and per-MRN  */
/* re-seed checks) can cancel anything still pending. Prevents leaks  */
/* and overlapping cascades across tab focus changes.                 */
/* ------------------------------------------------------------------ */
const mrnTimers = new Map<string, Set<ReturnType<typeof setTimeout>>>();

function trackTimer(mrn: string, t: ReturnType<typeof setTimeout>) {
  let set = mrnTimers.get(mrn);
  if (!set) {
    set = new Set();
    mrnTimers.set(mrn, set);
  }
  set.add(t);
}

function untrackTimer(mrn: string, t: ReturnType<typeof setTimeout>) {
  const set = mrnTimers.get(mrn);
  if (!set) return;
  set.delete(t);
  if (set.size === 0) mrnTimers.delete(mrn);
}

function clearAllTimers() {
  for (const set of mrnTimers.values()) {
    for (const t of set) clearTimeout(t);
  }
  mrnTimers.clear();
}

function trackedDelay(mrn: string, ms: number) {
  return new Promise<void>((res) => {
    const t = setTimeout(() => {
      untrackTimer(mrn, t);
      res();
    }, ms);
    trackTimer(mrn, t);
  });
}

async function cascadeMed(mrn: string, orderId: string) {
  // Ordered → Pending Verification → Dispensed → Administered (final).
  // The chart only surfaces the order once status === "Administered".
  await trackedDelay(mrn, TRANSITION_GAP_MS);
  const approvedAt = new Date().toISOString();
  await supabase
    .from("medication_orders")
    .update({ status: "Pending Verification", approved_at: approvedAt })
    .eq("id", orderId);
  await trackedDelay(mrn, TRANSITION_GAP_MS);
  const dispensedAt = new Date().toISOString();
  await supabase
    .from("medication_orders")
    .update({
      status: "Dispensed",
      dispensed_at: dispensedAt,
    } as any)
    .eq("id", orderId);
  await trackedDelay(mrn, TRANSITION_GAP_MS);
  const administeredAt = new Date().toISOString();
  await supabase
    .from("medication_orders")
    .update({
      status: "Administered",
      administered_at: administeredAt,
    } as any)
    .eq("id", orderId);
}

async function cascadeLab(
  mrn: string,
  orderId: string,
  resultSummary: string,
) {
  // Ordered → Processing → Reported (final).
  await trackedDelay(mrn, TRANSITION_GAP_MS);
  await supabase
    .from("lab_orders")
    .update({ status: "Processing" })
    .eq("id", orderId);
  await trackedDelay(mrn, TRANSITION_GAP_MS);
  const resultedAt = new Date().toISOString();
  await supabase
    .from("lab_orders")
    .update({
      status: "Reported",
      result_value: resultSummary,
      collected_at: resultedAt,
      resulted_at: resultedAt,
    } as any)
    .eq("id", orderId);
}

/**
 * Seed an admission with the protocol meds + labs.
 *
 * Both auto and manual admissions follow the same staged cascade:
 * first order at T+20s, 15s between subsequent orders, and each
 * order transitions through its statuses with a 3s gap. Auto
 * admissions respect the global automation switch; manual
 * admissions always seed so the queues pick the patient up.
 */
export async function seedAdmission(
  p: NewPatient,
  opts: { manual?: boolean; immediate?: boolean } = {},
) {
  if (!p.mrn) return;
  const manual = !!opts.manual;
  const immediate = !!opts.immediate;

  if (!manual && !(await getAutomationEnabled())) return;

  const fallbackName = [p.first_name, p.last_name].filter(Boolean).join(" ");
  const patientName = p.name ?? (fallbackName || "Unknown");
  const mrn: string = p.mrn;
  const orderedBy = manual
    ? "Bedside RN"
    : "Ghost AI - Admission Randomizer";

  const meds = medsForComplaint(p.chief_complaint);
  const labs = labsForComplaint(p.chief_complaint);
  const norm = (v: string | null | undefined) => (v ?? "").trim().toLowerCase();

  const [{ data: existingMeds }, { data: existingLabs }] = await Promise.all([
    supabase
      .from("medication_orders")
      .select("medication_name, drug_name")
      .eq("patient_mrn", mrn),
    supabase
      .from("lab_orders")
      .select("test_type")
      .eq("patient_mrn", mrn),
  ]);

  const existingMedNames = new Set(
    ((existingMeds as Array<{ medication_name?: string | null; drug_name?: string | null }> | null) ?? [])
      .map((m) => norm(m.medication_name ?? m.drug_name))
      .filter(Boolean),
  );
  const existingLabNames = new Set(
    ((existingLabs as Array<{ test_type?: string | null }> | null) ?? [])
      .map((l) => norm(l.test_type))
      .filter(Boolean),
  );

  // Schedule meds: T+20s, T+35s, T+50s
  meds.slice(0, 3).filter((m) => !existingMedNames.has(norm(m.name))).forEach((m, i) => {
    const t = immediate ? i * 500 : MED_FIRST_ORDER_DELAY_MS + i * MED_ORDER_GAP_MS;
    const timer = setTimeout(async () => {
      untrackTimer(mrn, timer);
      const { data, error } = await supabase
        .from("medication_orders")
        .insert({
          patient_id: p.id,
          patient_mrn: mrn,
          mrn,
          patient_name: patientName,
          facility_name: p.facility_name,
          medication_name: m.name,
          drug_name: m.name,
          dose: m.dose,
          route: m.route,
          frequency: "Once",
          status: "Ordered",
          ordered_by: orderedBy,
        })
        .select("id")
        .single();
      if (error || !data) {
        // Partial-unique index collision: another tab/worker already seeded
        // this (MRN, drug) pair. Silently skip — the winning insert owns
        // the cascade for this order.
        return;
      }
      cascadeMed(mrn, data.id).catch((e) =>
        console.warn("[cascadeMed] failed", e),
      );
    }, t);
    trackTimer(mrn, timer);
  });

  // Schedule labs: T+25s, T+45s
  labs.slice(0, 2).filter((l) => !existingLabNames.has(norm(l.name))).forEach((l, i) => {
    const t = immediate ? i * 500 : LAB_FIRST_ORDER_DELAY_MS + i * LAB_ORDER_GAP_MS;
    const resultSummary = `${l.name}: ${l.resultExample} (ref ${l.referenceRange}${
      l.unit ? ` ${l.unit}` : ""
    })`;
    const timer = setTimeout(async () => {
      untrackTimer(mrn, timer);
      const { data, error } = await supabase
        .from("lab_orders")
        .insert({
          patient_mrn: mrn,
          patient_name: patientName,
          facility_name: p.facility_name ?? "Memorial Hospital",
          requested_by: orderedBy,
          test_type: l.name,
          status: "Ordered",
          ordered_by: orderedBy,
        })
        .select("id")
        .single();
      if (error || !data) return; // unique-index collision → another tab wins
      cascadeLab(mrn, data.id, resultSummary).catch((e) =>
        console.warn("[cascadeLab] failed", e),
      );
    }, t);
    trackTimer(mrn, timer);
  });
}

export function useAIAutomation() {
  const seeded = useRef<Set<string>>(new Set());
  const automationEnabled = useAutomationEnabled();

  useEffect(() => {
    if (!automationEnabled) return;
    // Orphan sweeper — any pharmacy/lab order stuck in a non-terminal state
    // for >90s (page reload mid-cascade, closed tab, crashed worker) is
    // finalized so the live boards don't grow stale rows across every
    // facility. Mirrors the one-shot DB cleanup but keeps running.
    const sweepOrphans = async () => {
      const cutoff = new Date(Date.now() - 90_000).toISOString();
      const nowIso = new Date().toISOString();
      await supabase
        .from("medication_orders")
        .update({
          status: "Administered",
          administered_at: nowIso,
        } as any)
        .lt("created_at", cutoff)
        .in("status", [
          "Ordered",
          "Pending",
          "Pending Verification",
          "Dispensed",
          "DUE",
          "ORDERED",
          "PENDING",
          "PENDING_PHARMACY",
          "PENDING_VERIFICATION",
          "DISPENSED",
        ]);
      await supabase
        .from("lab_orders")
        .update({
          status: "Reported",
          resulted_at: nowIso,
        } as any)
        .lt("created_at", cutoff)
        .in("status", [
          "Ordered",
          "Processing",
          "Pending Collection",
          "Completed",
          "ORDERED",
          "PROCESSING",
        ]);
    };
    sweepOrphans().catch((e) => console.warn("[orphan-sweep] failed", e));
    const sweepInterval = setInterval(() => {
      sweepOrphans().catch(() => {});
    }, 30_000);

    const reconcileActiveAdmissions = async () => {
      const { data } = await supabase
        .from("patients")
        .select("id, mrn, first_name, last_name, name, facility_name, chief_complaint")
        .eq("status", "Admitted")
        .not("mrn", "is", null)
        .order("admission_time", { ascending: false })
        .limit(100);
      for (const p of ((data as NewPatient[] | null) ?? [])) {
        await seedAdmission(p, { immediate: true }).catch((e) =>
          console.warn("[admission-reconcile] seed failed", e),
        );
      }
    };
    reconcileActiveAdmissions().catch((e) =>
      console.warn("[admission-reconcile] failed", e),
    );

    const channel = supabase
      .channel("admission-randomizer")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "patients" },
        (payload) => {
          const p = payload.new as NewPatient;
          if (!p?.id || seeded.current.has(p.id)) return;
          seeded.current.add(p.id);
          seedAdmission(p).catch((e) =>
            console.warn("[admission-randomizer] seed failed", e),
          );
        },
      )
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "medication_orders" },
        (payload) => {
          const o = payload.new as InsertedOrder;
          const mrn = o.patient_mrn ?? o.mrn;
          const source = (o.ordered_by ?? "").toLowerCase();
          if (!mrn || (o.status ?? "").toLowerCase() !== "ordered") return;
          if (source.includes("admission randomizer") || source.includes("bedside rn")) return;
          cascadeMed(mrn, o.id).catch((e) => console.warn("[order-cascadeMed] failed", e));
        },
      )
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "lab_orders" },
        (payload) => {
          const o = payload.new as InsertedOrder;
          const mrn = o.patient_mrn ?? o.mrn;
          const source = (o.ordered_by ?? "").toLowerCase();
          if (!mrn || (o.status ?? "").toLowerCase() !== "ordered") return;
          if (source.includes("admission randomizer") || source.includes("bedside rn")) return;
          cascadeLab(mrn, o.id, `${o.test_type ?? "Lab"}: resulted`).catch((e) =>
            console.warn("[order-cascadeLab] failed", e),
          );
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
      clearAllTimers();
      clearInterval(sweepInterval);
    };
  }, [automationEnabled]);
}