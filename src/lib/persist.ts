import { supabase } from "@/integrations/supabase/client";

export type ProvenanceOrigin = "human" | "automation" | "system" | "unknown";

export interface PersistOptions {
  origin?: ProvenanceOrigin;
  authorId?: string | null;
  authorLabel?: string | null;
  onConflict?: string;
}

const LOCAL_OUTBOX_KEY = "spehr.pending_writes.v1";

function stamp(row: Record<string, unknown>, opts: PersistOptions) {
  const now = new Date().toISOString();
  return {
    ...row,
    created_by_type: opts.origin ?? "human",
    author_id: opts.authorId ?? row.author_id ?? null,
    updated_at: now,
    ...(row.created_at ? {} : { created_at: now }),
  };
}

function archiveLocally(
  table: string,
  op: string,
  payload: unknown,
  opts: PersistOptions,
  error: string,
) {
  try {
    const raw = localStorage.getItem(LOCAL_OUTBOX_KEY);
    const list = raw ? JSON.parse(raw) : [];
    list.push({ table, op, payload, opts, error, at: new Date().toISOString() });
    localStorage.setItem(LOCAL_OUTBOX_KEY, JSON.stringify(list).slice(0, 2_000_000));
  } catch {
    /* storage full — best-effort */
  }
}

async function recordOutbox(
  table: string,
  op: string,
  payload: unknown,
  opts: PersistOptions,
  error: string,
) {
  archiveLocally(table, op, payload, opts, error);
  try {
    await supabase.from("pending_writes").insert({
      table_name: table,
      operation: op,
      payload: payload as never,
      origin: opts.origin ?? "unknown",
      author_id: opts.authorId ?? null,
      last_error: error,
    });
  } catch {
    /* swallowed — local archive already has it */
  }
}

async function recordProvenance(
  table: string,
  rowId: string | null,
  op: string,
  opts: PersistOptions,
  payload: unknown,
) {
  try {
    await supabase.from("data_provenance").insert({
      table_name: table,
      row_id: rowId,
      operation: op,
      origin: opts.origin ?? "unknown",
      author_id: opts.authorId ?? null,
      author_label: opts.authorLabel ?? null,
      payload: payload as never,
    });
  } catch {
    /* non-fatal */
  }
}

/**
 * Write-through insert: tries the DB first, archives to outbox + local
 * storage on failure, and always records provenance.
 */
export async function persistInsert<T extends Record<string, unknown>>(
  table: string,
  row: T,
  opts: PersistOptions = {},
) {
  const stamped = stamp(row, opts);
  const q = supabase
    .from(table as never)
    .insert(stamped as never)
    .select()
    .maybeSingle();
  const { data, error } = await q;
  if (error) {
    await recordOutbox(table, "INSERT", stamped, opts, error.message);
    return { data: null, error };
  }
  const rowId = (data as { id?: string | number } | null)?.id;
  await recordProvenance(table, rowId != null ? String(rowId) : null, "INSERT", opts, stamped);
  return { data, error: null };
}

export async function persistUpsert<T extends Record<string, unknown>>(
  table: string,
  row: T,
  opts: PersistOptions = {},
) {
  const stamped = stamp(row, opts);
  const builder = supabase
    .from(table as never)
    .upsert(stamped as never, opts.onConflict ? { onConflict: opts.onConflict } : undefined);
  const { data, error } = await builder.select().maybeSingle();
  if (error) {
    await recordOutbox(table, "UPSERT", stamped, opts, error.message);
    return { data: null, error };
  }
  const rowId = (data as { id?: string | number } | null)?.id;
  await recordProvenance(table, rowId != null ? String(rowId) : null, "UPSERT", opts, stamped);
  return { data, error: null };
}

/**
 * Persist any FHIR resource (known or brand-new type) to the catch-all
 * fhir_resources table via the persist_fhir_resource() RPC. No schema
 * change needed for new resource types — Immunization, CarePlan,
 * ImagingStudy, etc. all land safely.
 */
export async function persistFhirResource(input: {
  resourceType: string;
  resourceId?: string | null;
  mrn?: string | null;
  payload: unknown;
  source?: string;
  origin?: ProvenanceOrigin;
  authorId?: string | null;
}) {
  const args = {
    _resource_type: input.resourceType,
    _resource_id: input.resourceId ?? "",
    _mrn: input.mrn ?? "",
    _payload: input.payload,
    _source: input.source ?? "app",
    _origin: input.origin ?? "automation",
    _author_id: input.authorId ?? "",
  } as never;
  const { data, error } = await supabase.rpc("persist_fhir_resource", args);
  if (error) {
    await recordOutbox(
      "fhir_resources",
      "UPSERT",
      input,
      { origin: input.origin, authorId: input.authorId },
      error.message,
    );
    return { data: null, error };
  }
  return { data, error: null };
}

/** Drain the local outbox after reconnect (call on app boot / online event). */
export async function flushLocalOutbox() {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(LOCAL_OUTBOX_KEY);
  } catch {
    return;
  }
  if (!raw) return;
  let list: Array<{
    table: string;
    op: string;
    payload: Record<string, unknown>;
    opts: PersistOptions;
  }>;
  try {
    list = JSON.parse(raw);
  } catch {
    return;
  }
  const remaining: typeof list = [];
  for (const item of list) {
    try {
      const res =
        item.op === "UPSERT"
          ? await persistUpsert(item.table, item.payload, item.opts)
          : await persistInsert(item.table, item.payload, item.opts);
      if (res.error) remaining.push(item);
    } catch {
      remaining.push(item);
    }
  }
  try {
    if (remaining.length === 0) localStorage.removeItem(LOCAL_OUTBOX_KEY);
    else localStorage.setItem(LOCAL_OUTBOX_KEY, JSON.stringify(remaining));
  } catch {
    /* ignore */
  }
}

if (typeof window !== "undefined") {
  window.addEventListener("online", () => {
    void flushLocalOutbox();
  });
}
