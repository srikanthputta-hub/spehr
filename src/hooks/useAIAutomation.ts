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

const FIRST_ORDER_DELAY_MS = 20_000; // first order placed 20s after admit
const ORDER_GAP_MS = 15_000;         // 15s between successive orders
const TRANSITION_GAP_MS = 3_000;     // 3s between status transitions

function delay(ms: number) {
  return new Promise<void>((res) => setTimeout(res, ms));
}

async function cascadeMed(orderId: string) {
  // ORDERED → PENDING_VERIFICATION → DISPENSED → ADMINISTERED
  await delay(TRANSITION_GAP_MS);
  await supabase
    .from("medication_orders")
    .update({ status: "PENDING_VERIFICATION" })
    .eq("id", orderId);
  await delay(TRANSITION_GAP_MS);
  await supabase
    .from("medication_orders")
    .update({ status: "DISPENSED" })
    .eq("id", orderId);
  await delay(TRANSITION_GAP_MS);
  await supabase
    .from("medication_orders")
    .update({
      status: "Administered",
      administered_at: new Date().toISOString(),
    })
    .eq("id", orderId);
}

async function cascadeLab(
  orderId: string,
  resultSummary: string,
) {
  // ORDERED → PROCESSING → RESULTED
  await delay(TRANSITION_GAP_MS);
  await supabase
    .from("lab_orders")
    .update({ status: "PROCESSING" })
    .eq("id", orderId);
  await delay(TRANSITION_GAP_MS);
  await supabase
    .from("lab_orders")
    .update({
      status: "Resulted",
      result_value: resultSummary,
      collected_at: new Date().toISOString(),
    })
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
  opts: { manual?: boolean } = {},
) {
  if (!p.mrn) return;
  const manual = !!opts.manual;

  if (!manual && !(await getAutomationEnabled())) return;

  // De-dupe: if any meds already exist for this MRN, another tab/run is
  // handling the cascade — bail out.
  const { data: existing } = await supabase
    .from("medication_orders")
    .select("id")
    .eq("patient_mrn", p.mrn)
    .limit(1);
  if (existing && existing.length > 0) return;

  const fallbackName = [p.first_name, p.last_name].filter(Boolean).join(" ");
  const patientName = p.name ?? (fallbackName || "Unknown");
  const mrn: string = p.mrn;
  const orderedBy = manual
    ? "Bedside RN"
    : "Ghost AI - Admission Randomizer";

  const meds = medsForComplaint(p.chief_complaint);
  const labs = labsForComplaint(p.chief_complaint);

  // Schedule meds: T+20s, T+35s, T+50s
  meds.slice(0, 3).forEach((m, i) => {
    const t = FIRST_ORDER_DELAY_MS + i * ORDER_GAP_MS;
    setTimeout(async () => {
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
          status: "ORDERED",
          ordered_by: orderedBy,
        })
        .select("id")
        .single();
      if (error || !data) return;
      cascadeMed(data.id).catch((e) =>
        console.warn("[cascadeMed] failed", e),
      );
    }, t);
  });

  // Schedule labs: T+20s, T+35s
  labs.slice(0, 2).forEach((l, i) => {
    const t = FIRST_ORDER_DELAY_MS + i * ORDER_GAP_MS;
    const resultSummary = `${l.name}: ${l.resultExample} (ref ${l.referenceRange}${
      l.unit ? ` ${l.unit}` : ""
    })`;
    setTimeout(async () => {
      const { data, error } = await supabase
        .from("lab_orders")
        .insert({
          patient_mrn: mrn,
          patient_name: patientName,
          facility_name: p.facility_name ?? "Srik Health Clinic",
          requested_by: orderedBy,
          test_type: l.name,
          status: "ORDERED",
          ordered_by: orderedBy,
        })
        .select("id")
        .single();
      if (error || !data) return;
      cascadeLab(data.id, resultSummary).catch((e) =>
        console.warn("[cascadeLab] failed", e),
      );
    }, t);
  });
}

export function useAIAutomation() {
  const seeded = useRef<Set<string>>(new Set());
  const automationEnabled = useAutomationEnabled();

  useEffect(() => {
    if (!automationEnabled) return;
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
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [automationEnabled]);
}