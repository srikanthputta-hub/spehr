/**
 * NLP stream $validate-code gate.
 *
 * Loads the 6 stream value set OIDs from `custom_value_sets` (cached in
 * memory), then validates coded concepts against them via the
 * `/api/public/umls-validate-code` proxy.
 *
 * Fail-open: if every validation call for a stream errors, we log one row
 * to `auto_doc_logs` (level='error') and treat the stream as valid.
 */

import { supabase } from "@/integrations/supabase/client";

export type StreamKey = "a" | "b" | "c" | "d" | "e" | "f";

const STREAM_VS_NAME: Record<StreamKey, string> = {
  a: "ED Chief Complaints",
  b: "Chronic Conditions",
  c: "Medicinal Products",
  d: "Allergy Substances",
  e: "Vital Signs Observations",
  f: "ED Lab Panels",
};

type VsInfo = { oid: string; vocabulary: string; type: string };

let vsCache: Partial<Record<StreamKey, VsInfo>> | null = null;
let vsCachePromise: Promise<Partial<Record<StreamKey, VsInfo>>> | null = null;

async function loadValueSets(): Promise<Partial<Record<StreamKey, VsInfo>>> {
  if (vsCache) return vsCache;
  if (vsCachePromise) return vsCachePromise;
  vsCachePromise = (async () => {
    const names = Object.values(STREAM_VS_NAME);
    const { data } = await supabase
      .from("custom_value_sets")
      .select("name, oid, vocabulary, type, status")
      .in("name", names)
      .eq("status", "published");
    const byName = new Map<string, VsInfo>();
    for (const row of (data ?? []) as any[]) {
      if (row?.oid) byName.set(row.name, { oid: row.oid, vocabulary: row.vocabulary, type: row.type });
    }
    const out: Partial<Record<StreamKey, VsInfo>> = {};
    for (const k of Object.keys(STREAM_VS_NAME) as StreamKey[]) {
      const info = byName.get(STREAM_VS_NAME[k]);
      if (info) out[k] = info;
    }
    vsCache = out;
    return out;
  })();
  try {
    return await vsCachePromise;
  } finally {
    vsCachePromise = null;
  }
}

// In-run cache so identical codes aren't re-validated across streams / calls.
const runCache = new Map<string, { valid: boolean; reason?: string }>();

async function validateOne(
  code: string,
  system: string,
  oid: string,
): Promise<{ valid: boolean; reason?: string; errored?: boolean }> {
  const key = `${oid}::${code}`;
  const hit = runCache.get(key);
  if (hit) return hit;
  try {
    const r = await fetch("/api/public/umls-validate-code", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, system, valueSetOid: oid }),
    });
    if (!r.ok) return { valid: true, errored: true };
    const j: any = await r.json();
    if (j?.ok === false) return { valid: true, errored: true };
    const out = { valid: Boolean(j?.valid), reason: j?.reason };
    runCache.set(key, out);
    return out;
  } catch {
    return { valid: true, errored: true };
  }
}

export type CodeInput = { system: string; code: string };
export type GateResult = {
  perCode: Record<string, { valid: boolean; reason?: string }>;
  gateStatus: "ok" | "needs_review" | "unavailable" | "not_configured";
};

export async function validateStreamCodes(
  streamKey: StreamKey,
  codes: CodeInput[],
  mrn: string,
): Promise<GateResult> {
  const vsMap = await loadValueSets();
  const info = vsMap[streamKey];
  if (!info) return { perCode: {}, gateStatus: "not_configured" };
  if (codes.length === 0) return { perCode: {}, gateStatus: "ok" };

  const unique = Array.from(
    new Map(codes.filter((c) => c.code).map((c) => [c.code, c] as const)).values(),
  );
  const results = await Promise.all(
    unique.map((c) => validateOne(c.code, c.system, info.oid).then((r) => [c.code, r] as const)),
  );
  const perCode: Record<string, { valid: boolean; reason?: string }> = {};
  let allErrored = true;
  let anyInvalid = false;
  for (const [code, r] of results) {
    perCode[code] = { valid: r.valid, reason: r.reason };
    if (!r.errored) allErrored = false;
    if (!r.errored && !r.valid) anyInvalid = true;
  }

  if (allErrored) {
    try {
      await supabase.from("auto_doc_logs").insert({
        mrn,
        stage: "nlp-validate",
        level: "error",
        message: `Value set $validate-code proxy unavailable for stream ${streamKey}`,
        meta: { stream: streamKey, value_set_oid: info.oid, code_count: unique.length } as any,
      } as any);
    } catch { /* non-fatal */ }
    return { perCode, gateStatus: "unavailable" };
  }

  return { perCode, gateStatus: anyInvalid ? "needs_review" : "ok" };
}