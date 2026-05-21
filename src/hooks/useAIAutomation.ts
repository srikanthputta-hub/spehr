import { useEffect, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import {
  MEDICATION_CATALOG,
  LAB_CATALOG,
  type MedicationCatalogEntry,
  type LabCatalogEntry,
} from "@/constants/clinical-catalog";

/* ------------------------------------------------------------------ */
/* Admission Randomizer                                                */
/* ------------------------------------------------------------------ */
/* Listens for new rows on `patients` and seeds each one with         */
/*   • 3 unique medications (status: Administered)                    */
/*   • 2 unique lab tests   (status: Resulted, mock numeric value)    */
/* drawn from the Master Clinical Catalog.                            */
/* ------------------------------------------------------------------ */

function pickUnique<T>(arr: readonly T[], n: number): T[] {
  const copy = [...arr];
  const out: T[] = [];
  for (let i = 0; i < n && copy.length; i++) {
    const idx = Math.floor(Math.random() * copy.length);
    out.push(copy.splice(idx, 1)[0]);
  }
  return out;
}

/** Generate a plausible mock result string for a given reference range. */
function mockResultFor(lab: LabCatalogEntry): string {
  const rng = lab.referenceRange.trim();
  if (/negative/i.test(rng)) return "Negative";

  // "<0.04" style
  const ltMatch = rng.match(/^<\s*([\d.]+)/);
  if (ltMatch) {
    const hi = parseFloat(ltMatch[1]);
    const v = Math.random() * hi;
    return `${v.toFixed(2)}${lab.unit ? ` ${lab.unit}` : ""}`;
  }

  // "70–110" / "70-110" / "1.005–1.030"
  const rangeMatch = rng.match(/([\d.]+)\s*[–-]\s*([\d.]+)/);
  if (rangeMatch) {
    const lo = parseFloat(rangeMatch[1]);
    const hi = parseFloat(rangeMatch[2]);
    const v = lo + Math.random() * (hi - lo);
    const decimals = (rangeMatch[1].split(".")[1]?.length ?? 0) || 1;
    return `${v.toFixed(decimals)}${lab.unit ? ` ${lab.unit}` : ""}`;
  }

  return `${(Math.random() * 10).toFixed(1)}${lab.unit ? ` ${lab.unit}` : ""}`;
}

interface NewPatient {
  id: string;
  mrn: string | null;
  first_name: string | null;
  last_name: string | null;
  name: string | null;
  facility_name: string | null;
}

async function seedAdmission(p: NewPatient) {
  if (!p.mrn) return;

  // Guard against double-seeding (realtime can fire on reconnect).
  const { data: existing } = await supabase
    .from("medication_orders")
    .select("id")
    .eq("patient_mrn", p.mrn)
    .limit(1);
  if (existing && existing.length > 0) return;

  const fallbackName = [p.first_name, p.last_name].filter(Boolean).join(" ");
  const patientName = p.name ?? (fallbackName || "Unknown");
  const mrn: string = p.mrn;

  const meds = pickUnique(MEDICATION_CATALOG, 3);
  const labs = pickUnique(LAB_CATALOG, 2);

  const medRows = meds.map((m: MedicationCatalogEntry) => ({
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

  const labRows = labs.map((l: LabCatalogEntry) => ({
    patient_mrn: mrn,
    patient_name: patientName,
    facility_name: p.facility_name ?? "Srik Health Clinic",
    requested_by: "Ghost AI - Admission Randomizer",
    test_type: l.name,
    status: "Resulted",
    result_value: `${l.name}: ${mockResultFor(l)} (ref ${l.referenceRange}${l.unit ? ` ${l.unit}` : ""})`,
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