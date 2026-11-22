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
   * Optional clinician-authored discharge note text (e.g. from the
   * "Confirm Discharge" dialog textarea). When provided AND non-empty, it
   * is woven into the generated narrative as its own verbatim "Clinician's
   * Discharge Note" section — in both the DISCHARGE_SUMMARY note content /
   * patients.discharge_summary AND the FHIR Composition (H7). It is never
   * discarded, and it never wholesale replaces the real structured
   * sections (meds/labs/procedures/safety flags) built from the chart —
   * both still come from real DB rows regardless. When omitted, the worker
   * auto-generates the full narrative from real meds/labs/allergies with
   * no clinician-note section.
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
  const { data, error } = await supabase.functions.invoke<{
    results?: DischargePatientResult[];
  }>("ghost-discharge-worker", {
    body,
  });
  if (error) {
    return { ok: false, mrn, reason: error.message };
  }
  const first = Array.isArray(data?.results) ? data.results[0] : null;
  if (!first) return { ok: false, mrn, reason: "worker_returned_no_result" };
  return first;
}
