import { supabase } from "@/integrations/supabase/client";

/**
 * Assign the least-loaded available nurse and physician at a facility to a
 * newly admitted patient. Writes to `patient_assignments` and increments
 * `staff_roster.assigned_patient_count`. Idempotent on (mrn).
 */
export async function assignStaffToPatient(
  mrn: string,
  facility: string,
): Promise<{ nurse?: string; physician?: string } | null> {
  if (!mrn || !facility) return null;
  // Skip if already assigned.
  const { data: existing } = await supabase
    .from("patient_assignments")
    .select("mrn")
    .eq("mrn", mrn)
    .maybeSingle();
  if (existing) return null;

  const [nurseRes, docRes] = await Promise.all([
    supabase
      .from("staff_roster")
      .select("id, name, assigned_patient_count")
      .eq("facility", facility)
      .eq("role", "nurse")
      .eq("active", true)
      .order("assigned_patient_count", { ascending: true })
      .limit(1),
    supabase
      .from("staff_roster")
      .select("id, name, assigned_patient_count")
      .eq("facility", facility)
      .eq("role", "physician")
      .eq("active", true)
      .order("assigned_patient_count", { ascending: true })
      .limit(1),
  ]);
  const nurse = (nurseRes.data ?? [])[0] as any;
  const physician = (docRes.data ?? [])[0] as any;
  if (!nurse && !physician) return null;

  await supabase.from("patient_assignments").insert({
    mrn,
    facility,
    nurse_id: nurse?.id ?? null,
    nurse_name: nurse?.name ?? null,
    physician_id: physician?.id ?? null,
    physician_name: physician?.name ?? null,
  } as any);

  if (nurse) {
    await supabase
      .from("staff_roster")
      .update({ assigned_patient_count: (nurse.assigned_patient_count ?? 0) + 1 } as any)
      .eq("id", nurse.id);
  }
  if (physician) {
    await supabase
      .from("staff_roster")
      .update({ assigned_patient_count: (physician.assigned_patient_count ?? 0) + 1 } as any)
      .eq("id", physician.id);
  }
  return { nurse: nurse?.name, physician: physician?.name };
}

/** Release an assignment on discharge — decrements staff load counters. */
export async function releaseStaffForPatient(mrn: string): Promise<void> {
  const { data: row } = await supabase
    .from("patient_assignments")
    .select("id, nurse_id, physician_id, released_at")
    .eq("mrn", mrn)
    .maybeSingle();
  if (!row || (row as any).released_at) return;
  await supabase
    .from("patient_assignments")
    .update({ released_at: new Date().toISOString() } as any)
    .eq("id", (row as any).id);
  for (const sid of [(row as any).nurse_id, (row as any).physician_id]) {
    if (!sid) continue;
    const { data: s } = await supabase
      .from("staff_roster")
      .select("assigned_patient_count")
      .eq("id", sid)
      .maybeSingle();
    if (s) {
      await supabase
        .from("staff_roster")
        .update({
          assigned_patient_count: Math.max(0, ((s as any).assigned_patient_count ?? 1) - 1),
        } as any)
        .eq("id", sid);
    }
  }
}