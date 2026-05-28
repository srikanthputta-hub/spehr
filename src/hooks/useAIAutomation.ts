import { useEffect, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import {
  medsForComplaint,
  labsForComplaint,
} from "@/lib/complaint-protocols";

/* ------------------------------------------------------------------ */
/* Admission Randomizer                                                */
/* ------------------------------------------------------------------ */
/* Listens for new rows on `patients` and seeds each one with         */
/*   • 3 medications (status: Administered)                           */
/*   • 2 lab tests   (status: Resulted)                               */
/* chosen from the chief-complaint protocol so chart, MAR, lab board, */
/* and discharge summary all reflect the same exact items.            */
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

export async function seedAdmission(p: NewPatient) {
  if (!p.mrn) return;

  // Guard against duplicate seeding (realtime can fire on reconnect, and the
  // DB cron may have already inserted the same protocol rows). We only skip
  // if the patient already has the full 3-med protocol seeded.
  const { data: existing } = await supabase
    .from("medication_orders")
    .select("id")
    .eq("patient_mrn", p.mrn);
  if (existing && existing.length >= 3) return;

  const fallbackName = [p.first_name, p.last_name].filter(Boolean).join(" ");
  const patientName = p.name ?? (fallbackName || "Unknown");
  const mrn: string = p.mrn;

  const meds = medsForComplaint(p.chief_complaint);
  const labs = labsForComplaint(p.chief_complaint);

  const medRows = meds.map((m) => ({
    patient_id: p.id,
    patient_mrn: mrn,
    patient_name: patientName,
    facility_name: p.facility_name,
    medication_name: m.name,
    drug_name: m.name,
    dose: m.dose,
    route: m.route,
    status: "Administered",
    ordered_by: "Ghost AI - Admission Randomizer",
    administered_at: new Date().toISOString(),
  }));

  const labRows = labs.map((l) => ({
    patient_mrn: mrn,
    patient_name: patientName,
    facility_name: p.facility_name ?? "Srik Health Clinic",
    requested_by: "Ghost AI - Admission Randomizer",
    test_type: l.name,
    status: "Resulted",
    result_value: `${l.name}: ${l.resultExample} (ref ${l.referenceRange}${l.unit ? ` ${l.unit}` : ""})`,
    ordered_by: "Ghost AI - Admission Randomizer",
    collected_at: new Date().toISOString(),
  }));

  await Promise.all([
    supabase.from("medication_orders").insert(medRows),
    supabase.from("lab_orders").insert(labRows),
  ]);
}

export function useAIAutomation() {
  const seeded = useRef<Set<string>>(new Set());

  useEffect(() => {
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
  }, []);
}