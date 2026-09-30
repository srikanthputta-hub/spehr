// Single client-side entry point for permanently deleting a patient record
// when an approved transfer's destination is outside this app's in-network
// facility set.
//
// Delegates to the `transfer-delete-worker` edge function, which runs with
// the service-role key and so actually bypasses RLS to perform the delete —
// unlike a direct anon `.from("patients").delete()` call, which RLS silently
// reduces to 0 affected rows with no error (see admin-dashboard.tsx history).
import { supabase } from "@/integrations/supabase/client";

export interface TransferDeletePatientOptions {
  mrn: string;
  transferId: string;
}

export interface TransferDeletePatientResult {
  ok: boolean;
  mrn: string;
  deleted: boolean;
  reason?: string;
}

export async function transferDeletePatientViaWorker({
  mrn,
  transferId,
}: TransferDeletePatientOptions): Promise<TransferDeletePatientResult> {
  const { data, error } = await supabase.functions.invoke("transfer-delete-worker", {
    body: { mrn, transfer_id: transferId },
  });
  if (error) {
    return { ok: false, mrn, deleted: false, reason: error.message };
  }
  if (!data) {
    return { ok: false, mrn, deleted: false, reason: "worker_returned_no_result" };
  }
  return data as TransferDeletePatientResult;
}
