/**
 * CDS suggestions watcher. Mount once from `src/routes/__root.tsx`.
 *
 * Listens for the `nlp:approved` window event (already fired by the NLP
 * approval trail), reads the latest approved SNOMED codes for the MRN,
 * matches them against CDS triggers, and persists per-MRN suggestions to
 * `localStorage["spehr.cds.suggestions.${mrn}"]`. Fires a `spehr:cds`
 * window event so open chart views update immediately.
 *
 * One suggestion per trigger per admission. A new admission for the same
 * MRN clears prior entries (detected via `patients.admission_time`).
 */

import { useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { ensureValueSetsLoaded } from "@/lib/safety-alerts-engine";
import { matchTriggers, ORDER_SETS, firstTriggerCode, CODE_DISPLAY, setAcsCodes } from "@/lib/cds-order-sets";
import { loadPublishedValueSetsForConsumer } from "@/lib/value-set-registry";

let acsHydrated = false;
let acsHydratePromise: Promise<void> | null = null;
async function hydrateAcsCodes(): Promise<void> {
  if (acsHydrated) return;
  if (acsHydratePromise) return acsHydratePromise;
  acsHydratePromise = (async () => {
    const hits = await loadPublishedValueSetsForConsumer({ consumer: "CDS Order Sets" });
    const acs = hits.find((h) => h.value_set_name === "Acute Coronary Syndrome Presentations");
    const codes: string[] = [];
    for (const c of (acs?.row?.codes ?? []) as any[]) {
      const code = String(c?.code ?? "").trim();
      if (code) codes.push(code);
    }
    setAcsCodes(codes);
    acsHydrated = codes.length > 0;
  })().finally(() => { acsHydratePromise = null; });
  return acsHydratePromise;
}

type StoredSuggestion = {
  id: string;
  firedAt: string;
  dismissed?: boolean;
  triggerCode?: string;
  triggerDisplay?: string;
};

type StoredPayload = {
  version: 1;
  admissionKey: string | null;
  suggestions: StoredSuggestion[];
};

function storageKey(mrn: string) {
  return `spehr.cds.suggestions.${mrn}`;
}

function readStored(mrn: string): StoredPayload | null {
  try {
    const raw = window.localStorage.getItem(storageKey(mrn));
    if (!raw) return null;
    const j = JSON.parse(raw);
    if (j?.version !== 1) return null;
    return j as StoredPayload;
  } catch {
    return null;
  }
}

function writeStored(mrn: string, payload: StoredPayload) {
  try {
    window.localStorage.setItem(storageKey(mrn), JSON.stringify(payload));
    window.dispatchEvent(new CustomEvent("spehr:cds", { detail: { mrn } }));
  } catch {
    /* noop */
  }
}

async function processMrn(mrn: string) {
  // 1. Value sets (cached in the safety-alerts engine).
  await Promise.all([ensureValueSetsLoaded(), hydrateAcsCodes()]);
  const vs = await ensureValueSetsLoaded();
  const sepsis = new Set<string>();
  const highAcuity = new Set<string>();
  for (const row of vs.get("Sepsis Indicators")?.codes ?? []) {
    if (row?.code) sepsis.add(String(row.code).trim());
  }
  for (const row of vs.get("High-Acuity ED Presentations")?.codes ?? []) {
    if (row?.code) highAcuity.add(String(row.code).trim());
  }

  // 2. Approved SNOMED codes for this MRN.
  const { data: audit } = await supabase
    .from("nlp_audit_logs")
    .select("standardized_output")
    .eq("patient_mrn", mrn)
    .eq("status", "approved")
    .order("updated_at", { ascending: false })
    .limit(5);
  const codes = new Set<string>();
  for (const row of (audit ?? []) as Array<{ standardized_output: any }>) {
    const so = row.standardized_output ?? {};
    const arr = (Array.isArray(so["SNOMED CT"])
      ? so["SNOMED CT"]
      : Array.isArray(so.snomed)
        ? so.snomed
        : []) as unknown[];
    for (const c of arr) if (typeof c === "string") codes.add(c.trim());
  }
  if (codes.size === 0) return;

  // 3. Admission anchor — clears stale suggestions when MRN is re-admitted.
  const { data: pat } = await supabase
    .from("patients")
    .select("admission_time")
    .eq("mrn", mrn)
    .order("admission_time", { ascending: false })
    .limit(1)
    .maybeSingle();
  const admissionKey = (pat?.admission_time as string | null | undefined) ?? null;

  // 4. Merge with stored payload (dedupe per trigger per admission).
  const fired = matchTriggers(Array.from(codes), sepsis, highAcuity);
  if (fired.length === 0) return;

  const prior = readStored(mrn);
  const base: StoredPayload =
    prior && prior.admissionKey === admissionKey
      ? prior
      : { version: 1, admissionKey, suggestions: [] };
  const existing = new Set(base.suggestions.map((s) => s.id));
  let changed = base !== prior;
  const now = new Date().toISOString();
  const codeList = Array.from(codes);
  for (const id of fired) {
    if (!ORDER_SETS[id]) continue;
    if (existing.has(id)) continue;
    const trigCode = firstTriggerCode(codeList, id, sepsis, highAcuity);
    const trigDisplay = trigCode ? CODE_DISPLAY[trigCode] : undefined;
    base.suggestions.push({
      id,
      firedAt: now,
      ...(trigCode ? { triggerCode: trigCode } : {}),
      ...(trigDisplay ? { triggerDisplay: trigDisplay } : {}),
    });
    existing.add(id);
    changed = true;
  }
  // Septic Shock supersedes Sepsis Bundle even if the base was stored earlier.
  if (existing.has("septic-shock") && existing.has("sepsis-bundle")) {
    base.suggestions = base.suggestions.filter((s) => s.id !== "sepsis-bundle");
    changed = true;
  }
  if (changed) writeStored(mrn, base);
}

export function useCdsSuggestionsWatcher() {
  useEffect(() => {
    void ensureValueSetsLoaded().catch(() => {});
    void hydrateAcsCodes().catch(() => {});
    const onApproved = (e: Event) => {
      const mrn = (e as CustomEvent).detail?.mrn;
      if (!mrn) return;
      void processMrn(String(mrn)).catch((err) =>
        console.warn("[cds] processMrn failed", err),
      );
    };
    window.addEventListener("nlp:approved", onApproved as EventListener);
    return () =>
      window.removeEventListener("nlp:approved", onApproved as EventListener);
  }, []);
}