/**
 * Discharge FHIR bundle conformance validation.
 *
 * Runs before the discharge bundle is pushed to Medblocks. Fail-open: every
 * failure branch (missing value set, endpoint error, thrown exception) is
 * logged to `auto_doc_logs` and the caller is expected to proceed with the
 * push anyway. Never throws.
 *
 * Bindings validated:
 *   Condition (encounter-diagnosis) → "ED Chief Complaints"    (SNOMED)
 *   Condition (problem-list-item)   → "Chronic Conditions"     (SNOMED)
 *   MedicationRequest / Med.Admin   → "Medicinal Products"     (RxNorm, SNOMED)
 *   AllergyIntolerance              → "Allergy Substances"     (SNOMED)
 *   Observation (vital-signs)       → "Vital Signs Observations" (LOINC)
 *   Observation (laboratory)        → "ED Lab Panels"          (LOINC)
 */

import { supabase } from "@/integrations/supabase/client";

/* ------------------------------------------------------------------ */
/*  Value-set OID cache (by name)                                      */
/* ------------------------------------------------------------------ */

const VS_NAMES = [
  "ED Chief Complaints",
  "Chronic Conditions",
  "Medicinal Products",
  "Allergy Substances",
  "Vital Signs Observations",
  "ED Lab Panels",
] as const;
type VsName = (typeof VS_NAMES)[number];

const VS_TTL_MS = 5 * 60_000;
let vsCache = new Map<VsName, string>();
let vsLoadedAt = 0;
let vsLoadPromise: Promise<void> | null = null;

async function ensureVsOids(): Promise<Map<VsName, string>> {
  if (Date.now() - vsLoadedAt < VS_TTL_MS && vsCache.size > 0) return vsCache;
  if (vsLoadPromise) {
    await vsLoadPromise;
    return vsCache;
  }
  vsLoadPromise = (async () => {
    const { data } = await supabase
      .from("custom_value_sets")
      .select("name, oid")
      .in("name", VS_NAMES as unknown as string[])
      .eq("status", "published");
    const next = new Map<VsName, string>();
    for (const row of (data ?? []) as Array<{ name: string; oid: string | null }>) {
      if (row.oid && (VS_NAMES as readonly string[]).includes(row.name)) {
        next.set(row.name as VsName, String(row.oid));
      }
    }
    vsCache = next;
    vsLoadedAt = Date.now();
  })().finally(() => {
    vsLoadPromise = null;
  });
  await vsLoadPromise;
  return vsCache;
}

/* ------------------------------------------------------------------ */
/*  System matching                                                    */
/* ------------------------------------------------------------------ */

function isSnomed(sys: string | undefined): boolean {
  return !!sys && /snomed\.info\/sct/i.test(sys);
}
function isRxNorm(sys: string | undefined): boolean {
  return !!sys && /rxnorm/i.test(sys);
}
function isLoinc(sys: string | undefined): boolean {
  return !!sys && /loinc/i.test(sys);
}

/* ------------------------------------------------------------------ */
/*  Coded-element extraction from a FHIR transaction bundle            */
/* ------------------------------------------------------------------ */

type Check = {
  code: string;
  display?: string;
  system: string;
  element: string;
  valueSetName: VsName;
};

function categoryTokens(res: any): string[] {
  const cats = Array.isArray(res?.category) ? res.category : [];
  const out: string[] = [];
  for (const c of cats) {
    for (const cc of c?.coding ?? []) {
      if (cc?.code) out.push(String(cc.code).toLowerCase());
    }
    if (typeof c?.text === "string") out.push(c.text.toLowerCase());
  }
  return out;
}

function pushCoding(
  out: Check[],
  cc: any,
  element: string,
  valueSetName: VsName,
  systemMatch: (s: string | undefined) => boolean,
) {
  const codings: any[] = Array.isArray(cc?.coding) ? cc.coding : [];
  for (const c of codings) {
    const code = c?.code ? String(c.code).trim() : "";
    if (!code) continue;
    if (!systemMatch(c?.system)) continue;
    out.push({
      code,
      display: c?.display ? String(c.display) : undefined,
      system: String(c.system),
      element,
      valueSetName,
    });
  }
}

function extractChecks(bundle: any): Check[] {
  const out: Check[] = [];
  const entries: any[] = Array.isArray(bundle?.entry) ? bundle.entry : [];
  for (const e of entries) {
    const res = e?.resource;
    if (!res) continue;
    switch (res.resourceType) {
      case "Condition": {
        const cats = categoryTokens(res);
        const isPmh = cats.some((t) => t.includes("problem-list-item"));
        const isEnc = cats.some((t) => t.includes("encounter-diagnosis"));
        const vs: VsName | null = isPmh
          ? "Chronic Conditions"
          : isEnc
            ? "ED Chief Complaints"
            : "ED Chief Complaints"; // default binding
        pushCoding(out, res.code, "Condition.code", vs, isSnomed);
        break;
      }
      case "MedicationRequest":
      case "MedicationAdministration": {
        pushCoding(
          out,
          res.medicationCodeableConcept,
          `${res.resourceType}.medicationCodeableConcept`,
          "Medicinal Products",
          (s) => isRxNorm(s) || isSnomed(s),
        );
        break;
      }
      case "AllergyIntolerance": {
        pushCoding(out, res.code, "AllergyIntolerance.code", "Allergy Substances", isSnomed);
        break;
      }
      case "Observation": {
        const cats = categoryTokens(res);
        const isVital = cats.some((t) => t.includes("vital-signs"));
        const isLab = cats.some((t) => t.includes("laboratory"));
        if (isVital) {
          pushCoding(out, res.code, "Observation.code", "Vital Signs Observations", isLoinc);
        } else if (isLab) {
          pushCoding(out, res.code, "Observation.code", "ED Lab Panels", isLoinc);
        }
        break;
      }
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/*  Per-code memo (system|code|oid → boolean)                          */
/* ------------------------------------------------------------------ */

const memo = new Map<string, boolean>();

async function validateOne(
  code: string,
  system: string,
  oid: string,
): Promise<{ valid: boolean; error?: string }> {
  const key = `${system}|${code}|${oid}`;
  const cached = memo.get(key);
  if (cached !== undefined) return { valid: cached };
  const res = await fetch("/api/public/umls-validate-code", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, system, valueSetOid: oid }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j: any = await res.json();
  if (j?.ok !== true) throw new Error(String(j?.error ?? "validate failed"));
  const valid = !!j.valid;
  memo.set(key, valid);
  return { valid };
}

/* ------------------------------------------------------------------ */
/*  Logging                                                            */
/* ------------------------------------------------------------------ */

async function logRow(mrn: string, message: string) {
  try {
    await supabase.from("auto_doc_logs").insert({
      level: "error",
      stage: "discharge-conformance",
      message,
      mrn,
    } as any);
  } catch (e) {
    console.warn("[discharge-conformance] log failed", e);
  }
}

/* ------------------------------------------------------------------ */
/*  Banner persistence                                                 */
/* ------------------------------------------------------------------ */

function bannerKey(mrn: string) {
  return `spehr.discharge.conformance.${mrn}`;
}

function persistBanner(mrn: string, count: number) {
  try {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(
      bannerKey(mrn),
      JSON.stringify({ count, at: new Date().toISOString(), dismissed: false }),
    );
    window.dispatchEvent(new CustomEvent("spehr:conformance", { detail: { mrn } }));
  } catch {
    /* noop */
  }
}

/* ------------------------------------------------------------------ */
/*  Public entry                                                       */
/* ------------------------------------------------------------------ */

export type InvalidCode = {
  code: string;
  display?: string;
  system: string;
  element: string;
  valueSetName: string;
};

export async function validateDischargeConformance(
  bundle: any,
  mrn: string,
): Promise<{ ok: boolean; invalid: InvalidCode[] }> {
  try {
    const checks = extractChecks(bundle);
    if (checks.length === 0) return { ok: true, invalid: [] };

    const oids = await ensureVsOids();
    const runnable = checks.filter((c) => oids.has(c.valueSetName));
    if (runnable.length === 0) return { ok: true, invalid: [] };

    const results = await Promise.allSettled(
      runnable.map((c) => validateOne(c.code, c.system, oids.get(c.valueSetName)!)),
    );

    const invalid: InvalidCode[] = [];
    let endpointFailures = 0;
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      const c = runnable[i];
      if (r.status === "fulfilled") {
        if (!r.value.valid) {
          invalid.push({
            code: c.code,
            display: c.display,
            system: c.system,
            element: c.element,
            valueSetName: c.valueSetName,
          });
        }
      } else {
        endpointFailures++;
      }
    }

    // Log each non-conformant code (spec message).
    for (const inv of invalid) {
      await logRow(
        mrn,
        `Non-conformant code ${inv.code} in ${inv.element} for MRN ${mrn} — not in value set ${inv.valueSetName}`,
      );
    }

    if (endpointFailures > 0) {
      await logRow(
        mrn,
        `umls-validate-code unavailable for ${endpointFailures} code(s) — discharge push proceeded without validation for MRN ${mrn}`,
      );
    }

    persistBanner(mrn, invalid.length);
    return { ok: invalid.length === 0, invalid };
  } catch (e) {
    await logRow(
      mrn,
      `umls-validate-code unavailable — discharge push proceeded without validation for MRN ${mrn}: ${(e as Error)?.message ?? "unknown"}`,
    );
    return { ok: true, invalid: [] };
  }
}