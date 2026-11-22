/**
 * Shared duplicate-order guard (QA finding H2).
 *
 * A second click on a submit button that hadn't visibly disabled yet (the
 * "Submitting…" label only appeared on the SECOND click in the reported
 * case) can silently fire a second, identical insert before the first one
 * has confirmed — same patient, same drug/test/exam, a few seconds or
 * minutes apart, each billed separately. This helper looks for a recent,
 * clinically-identical order before a new one is inserted so every
 * order-entry flow (medication / lab / imaging) can surface the same
 * "looks like a duplicate" confirmation instead of silently double-ordering.
 *
 * This is deliberately a best-effort, client-side pre-check (read-then-
 * insert), not a database constraint — a true server-side unique guard
 * would need a generated/normalized column and a partial unique index,
 * which is a bigger schema change than this fix set calls for. Paired with
 * the synchronous submit-button lock (see callers), it closes the actual
 * reported double-click/double-submit path.
 */
import { supabase } from "@/integrations/supabase/client";

export type DuplicateOrderTable = "medication_orders" | "lab_orders" | "radiology_orders";

export interface DuplicateOrderCheck {
  mrn: string;
  table: DuplicateOrderTable;
  /**
   * Exact-match columns that identify "the same clinical order" (e.g.
   * `{ drug_name, dose, route, frequency }` for a medication, `{ test_type }`
   * for a lab, `{ exam_type }` for an imaging study). Null/empty values are
   * skipped rather than matched against.
   */
  matchColumns: Record<string, string | null | undefined>;
  /** How far back to look for a duplicate. Defaults to 5 minutes. */
  windowMinutes?: number;
}

export interface DuplicateOrderResult {
  isDuplicate: boolean;
  /** Age of the matching prior order, in whole seconds. */
  ageSeconds?: number;
}

export async function findRecentDuplicateOrder(
  check: DuplicateOrderCheck,
): Promise<DuplicateOrderResult> {
  const { mrn, table, matchColumns, windowMinutes = 5 } = check;
  if (!mrn) return { isDuplicate: false };
  try {
    const sinceIso = new Date(Date.now() - windowMinutes * 60_000).toISOString();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- table name is a runtime union across three distinct generated row types
    let query = (supabase.from(table) as any)
      .select("id, created_at")
      .eq("patient_mrn", mrn)
      .gte("created_at", sinceIso)
      .order("created_at", { ascending: false })
      .limit(1);
    for (const [col, val] of Object.entries(matchColumns)) {
      const v = (val ?? "").toString().trim();
      if (!v) continue;
      query = query.eq(col, v);
    }
    const { data, error } = await query;
    if (error || !data || data.length === 0) return { isDuplicate: false };
    const row = data[0] as { id: string; created_at: string };
    const ageSeconds = Math.max(
      0,
      Math.round((Date.now() - new Date(row.created_at).getTime()) / 1000),
    );
    return { isDuplicate: true, ageSeconds };
  } catch (e) {
    // Never let the duplicate check itself block a legitimate order.
    console.warn("[duplicate-order-guard] check failed", e);
    return { isDuplicate: false };
  }
}

function formatAge(ageSeconds: number): string {
  if (ageSeconds < 90) return `${ageSeconds} second${ageSeconds === 1 ? "" : "s"}`;
  const minutes = Math.round(ageSeconds / 60);
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

/**
 * Standard confirmation copy for a detected duplicate. Returns true if the
 * orderer explicitly confirmed they want to proceed anyway, false if they
 * backed out — in which case the caller must NOT submit the order.
 */
export function confirmDuplicateOrder(ageSeconds: number): boolean {
  return window.confirm(
    `This looks like a duplicate of an order placed ${formatAge(ageSeconds)} ago for this patient. Submit it again anyway?`,
  );
}
