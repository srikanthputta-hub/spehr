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

export type PublishedValueSetHit = {
  value_set_name: string;
  row: any;
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

  const out: PublishedValueSetHit[] = [];
  for (const dep of data as any[]) {
    const row = dep?.custom_value_sets;
    if (!row) continue;
    if (row.status && row.status !== "published") continue;
    const name = String(dep?.value_set_name ?? row?.name ?? "");
    if (!name) continue;
    out.push({ value_set_name: name, row });
  }
  return out;
}