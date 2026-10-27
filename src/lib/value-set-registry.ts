/**
 * Value-set dependency registry lookup.
 *
 * Single source of truth for "which published `custom_value_sets` rows does
 * consumer X depend on?". Consumers register themselves in
 * `public.value_set_dependencies` (by `consumer` label and/or
 * `consumer_file` path), each row pointing at a `custom_value_sets.id`.
 *
 * This helper resolves that registry to the underlying published value-set
 * rows so a rename/delete becomes visible in one table instead of silently
 * breaking individual callers.
 */

import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";

/**
 * The columns every caller actually selects — none of them override the
 * `columns` default below, so this matches the real shape of `row` exactly
 * (a subset of `custom_value_sets`), instead of widening it to `any`.
 */
export type PublishedValueSetRow = Pick<
  Database["public"]["Tables"]["custom_value_sets"]["Row"],
  "id" | "name" | "oid" | "vocabulary" | "type" | "codes" | "intensional_rule" | "status"
>;

export type PublishedValueSetHit = {
  value_set_name: string;
  row: PublishedValueSetRow;
};

export async function loadPublishedValueSetsForConsumer(
  key: { consumer?: string; consumer_file?: string },
  columns = "id, name, oid, vocabulary, type, codes, intensional_rule, status",
): Promise<PublishedValueSetHit[]> {
  let q = supabase
    .from("value_set_dependencies")
    .select(`value_set_name, custom_value_sets:value_set_id ( ${columns} )`);
  if (key.consumer) q = q.eq("consumer", key.consumer);
  if (key.consumer_file) q = q.eq("consumer_file", key.consumer_file);

  const { data, error } = await q;
  if (error || !data) return [];

  // `columns` is built from a runtime string, so Supabase's type-level query
  // parser can't resolve the joined row shape (it types `data` as a
  // ParserError placeholder) — cast to what the query actually returns at
  // runtime instead of widening to `any`.
  type JoinedRow = {
    value_set_name: string;
    custom_value_sets: PublishedValueSetRow | PublishedValueSetRow[] | null;
  };
  const rows = data as unknown as JoinedRow[];

  const out: PublishedValueSetHit[] = [];
  for (const dep of rows) {
    // The join can return either one row or an array depending on the FK
    // relationship Supabase infers; normalize to a single row either way.
    const joined = dep?.custom_value_sets;
    const row = Array.isArray(joined) ? joined[0] : joined;
    if (!row) continue;
    if (row.status && row.status !== "published") continue;
    const name = String(dep?.value_set_name ?? row?.name ?? "");
    if (!name) continue;
    out.push({ value_set_name: name, row });
  }
  return out;
}

/**
 * File (or extend) a governed change request against the Auto Terminologist
 * demand queue (`terminology_requests`). If a PENDING request already exists
 * for the same (requesting_consumer, requested_name), new seed codes are
 * merged into it (dedup by code) instead of creating a duplicate row — this
 * mirrors the real-world "change request" pattern where a terminologist
 * consolidates repeat asks rather than processing the same ask twice.
 */
export async function requestTerminologyUpdate(req: {
  requesting_consumer: string;
  requested_name: string;
  justification: string;
  priority?: "low" | "normal" | "high" | "urgent";
  vocabulary?: string;
  seed_codes: Array<{ code: string; display?: string }>;
  clinical_application?: string;
  related_mrn?: string | null;
}): Promise<void> {
  try {
    const { error: insertErr } = await supabase.from("terminology_requests").insert({
      requesting_consumer: req.requesting_consumer,
      requested_name: req.requested_name,
      justification: req.justification,
      priority: req.priority ?? "normal",
      vocabulary: req.vocabulary ?? null,
      seed_codes: req.seed_codes,
      clinical_application: req.clinical_application ?? null,
      related_mrn: req.related_mrn ?? null,
      status: "pending",
      request_type: "create",
      requested_at: new Date().toISOString(),
    });

    if (!insertErr) return; // fresh pending request created
    if (insertErr.code !== "23505") {
      console.warn(
        "[value-set-registry] requestTerminologyUpdate insert failed",
        insertErr.message,
      );
      return;
    }

    // Unique-violation: a pending request for this (consumer, name) already
    // exists — merge our seed codes into it instead of creating a duplicate.
    const { data: existing } = await supabase
      .from("terminology_requests")
      .select("id, seed_codes")
      .eq("requesting_consumer", req.requesting_consumer)
      .eq("requested_name", req.requested_name)
      .eq("status", "pending")
      .maybeSingle();
    if (!existing) return; // resolved/processed between our insert attempt and this read

    const prevCodes: Array<{ code: string; display?: string }> = Array.isArray(existing.seed_codes)
      ? (existing.seed_codes as Array<{ code: string; display?: string }>)
      : [];
    const seen = new Set(prevCodes.map((c) => String(c?.code ?? "")));
    const merged = [...prevCodes];
    for (const c of req.seed_codes) {
      const code = String(c?.code ?? "").trim();
      if (!code || seen.has(code)) continue;
      seen.add(code);
      merged.push(c);
    }
    if (merged.length === prevCodes.length) return; // nothing new to add
    await supabase
      .from("terminology_requests")
      .update({ seed_codes: merged, updated_at: new Date().toISOString() })
      .eq("id", existing.id);
  } catch (e) {
    console.warn("[value-set-registry] requestTerminologyUpdate failed", (e as Error)?.message);
  }
}
