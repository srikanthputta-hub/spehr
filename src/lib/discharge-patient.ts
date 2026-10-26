// Single client-side entry point for every manual discharge UI action.
//
// Delegates to the `ghost-discharge-worker` edge function, which is the ONE
// place that:
//   1. Builds the rich narrative via shared `buildDischargeMarkdown`
//   2. INSERTs the `DISCHARGE_SUMMARY` clinical_notes row
//   3. UPDATEs `patients.status='Discharged'` + discharge_time +
//      discharge_summary
//   4. Frees the bed via `bed_management`
//   5. Rebuilds the FHIR Composition/DocumentReference with real per-encounter
//      meds/labs and pushes to Medblocks headlessly (no browser tab required)
//
// UI paths must NOT do raw `patients` updates for discharge anymore — that
// bypasses the note + FHIR Composition pipeline.
import { supabase } from "@/integrations/supabase/client";

export interface DischargePatientOptions {
  mrn: string;
  /**
   * Optional clinician-authored discharge summary text (e.g. from a chart
   * dialog textarea). When provided AND non-empty, it becomes the
   * DISCHARGE_SUMMARY note content + patients.discharge_summary — the FHIR
   * Composition still comes from real DB rows. When omitted, the worker
   * auto-generates a full narrative from real meds/labs/allergies.
   */
  clinicianSummary?: string | null;
}

export interface DischargePatientResult {
  ok: boolean;
  mrn: string;
  reason?: string;
  note_id?: string;
  summary_len?: number;
  composition_push?: { ok: boolean; status: number };
}

export async function dischargePatientViaWorker({
  mrn,
  clinicianSummary,
}: DischargePatientOptions): Promise<DischargePatientResult> {
  const body: Record<string, unknown> = { mrn };
  const trimmed = typeof clinicianSummary === "string" ? clinicianSummary.trim() : "";
  if (trimmed.length > 0) {
    body.discharge_summary_override = trimmed;
  }
  const { data, error } = await supabase.functions.invoke("ghost-discharge-worker", {
    body,
  });
  if (error) {
    return { ok: false, mrn, reason: error.message };
  }
  const first = Array.isArray((data as any)?.results) ? (data as any).results[0] : null;
  if (!first) return { ok: false, mrn, reason: "worker_returned_no_result" };
  return first as DischargePatientResult;
}
