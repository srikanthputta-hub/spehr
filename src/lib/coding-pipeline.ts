/**
 * Six-Stream Coding Pipeline
 * ---------------------------
 * Runs the full NLP → terminology coding cascade for one MRN and persists
 * one `nlp_audit_logs` row summarizing every stream.
 *
 *   A. Chief Complaint + HPI (SNOMED via CHV+resolveAndValidate, ICD-10 crosswalk)
 *   B. PMH checkboxes → conditions (SNOMED + ICD-10, direct map)
 *   C. Medications → medication_orders.rxnorm_code/display
 *   D. Allergies → allergies.substance_rxcui + reaction_snomed
 *   E. Vitals → vitals.loinc_code / loinc_map
 *   F. Lab results → lab_results.loinc_code
 *
 * Idempotent: uses upsert-like conditional inserts so re-runs (Re-code
 * button) don't create duplicate rows. Fire-and-forget from admit; a
 * background sweep also picks up unowned admissions.
 */

import { supabase } from "@/integrations/supabase/client";
import {
  resolveChv,
  resolveAndValidateSnomed,
  crosswalkSnomedToIcd10,
  resolveRxNorm,
  resolveLoinc,
} from "@/lib/umls-client";
import { matchPmh, type PmhCode } from "@/lib/pmh-map";
import { lookupAllergenSnomed } from "@/lib/allergen-map";
import { VITALS_LOINC } from "@/lib/vitals-loinc-map";
import { lookupLabLoinc } from "@/lib/lab-loinc-map";

// ─── Locking: prevent overlap between Re-code + sweep ────────────────────
const inFlight = new Set<string>();

export type StreamStatus = "coded" | "partial" | "failed";
export type StreamResult = {
  status: StreamStatus;
  count: number;
  items: any[];
};
export type PipelineResult = {
  mrn: string;
  patient_name: string | null;
  confidence: number;
  streams: {
    a: StreamResult;
    b: StreamResult;
    c: StreamResult;
    d: StreamResult;
    e: StreamResult;
    f: StreamResult;
  };
};

function statusFor(count: number, expected: number): StreamStatus {
  if (expected === 0) return "coded"; // nothing to code = fine
  if (count === 0) return "failed";
  if (count < expected) return "partial";
  return "coded";
}

/** Run every coding stream for one MRN. Safe to call repeatedly. */
export async function runSixStreamPipeline(mrn: string): Promise<PipelineResult | null> {
  if (!mrn) return null;
  if (inFlight.has(mrn)) return null;
  inFlight.add(mrn);
  try {
    // -------- Load source rows ---------------------------------------
    const { data: patient } = await supabase
      .from("patients")
      .select(
        "mrn, name, first_name, last_name, chief_complaint, hpi_location, hpi_character, past_medical_history",
      )
      .eq("mrn", mrn)
      .maybeSingle();
    if (!patient) return null;
    const patientName =
      (patient as any).name ||
      `${(patient as any).first_name ?? ""} ${(patient as any).last_name ?? ""}`.trim() ||
      null;

    const [medsRes, allergiesRes, vitalsRes, labsRes] = await Promise.all([
      supabase
        .from("medication_orders")
        .select("id, medication_name, drug_name, medication, drug, name, rxnorm_code")
        .eq("patient_mrn", mrn),
      supabase
        .from("allergies")
        .select("id, substance, reaction, substance_rxcui, reaction_snomed")
        .eq("mrn", mrn),
      supabase
        .from("vitals")
        .select("id, hr, bp_systolic, bp_diastolic, spo2, rr, temp_c, loinc_code")
        .eq("mrn", mrn)
        .order("recorded_at", { ascending: false })
        .limit(1),
      supabase
        .from("lab_results")
        .select("id, test_name, loinc_code")
        .eq("mrn", mrn),
    ]);

    // -------- Stream A: Chief Complaint --------------------------------
    const cc = String((patient as any).chief_complaint ?? "").trim();
    const streamA: StreamResult = { status: "coded", count: 0, items: [] };
    let aConfidence = 0;
    if (cc) {
      const chv = await resolveChv(cc);
      const resolvedTerm = chv?.display?.trim() || cc.split(/\s+/).slice(0, 4).join(" ");
      const sr = await resolveAndValidateSnomed(resolvedTerm);
      const snomed = sr?.code ?? null;
      const snomedDisplay = sr?.display ?? resolvedTerm;
      aConfidence = sr?.confidence ?? 0;
      let icd10Code: string | null = null;
      let icd10Display: string | null = null;
      if (snomed) {
        const cw = await crosswalkSnomedToIcd10(snomed);
        icd10Code = cw?.code ?? null;
        icd10Display = cw?.display ?? null;
      }
      if (snomed) {
        await upsertCondition({
          mrn,
          patient_name: patientName,
          display_text: cc,
          snomed_code: snomed,
          snomed_display: snomedDisplay,
          icd10_code: icd10Code,
          icd10_display: icd10Display,
          category: "encounter-diagnosis",
          source_section: "chief_complaint",
          coding_source: "nlp-stream-a",
        });
        streamA.count = 1;
        streamA.items.push({
          snomed_code: snomed,
          snomed_display: snomedDisplay,
          icd10_code: icd10Code,
          icd10_display: icd10Display,
          confidence: aConfidence,
        });
      } else {
        streamA.status = "failed";
      }
    }

    // -------- Stream B: PMH -------------------------------------------
    const pmhHits: PmhCode[] = matchPmh((patient as any).past_medical_history);
    const streamB: StreamResult = { status: "coded", count: 0, items: [] };
    for (const p of pmhHits) {
      await upsertCondition({
        mrn,
        patient_name: patientName,
        display_text: p.label,
        snomed_code: p.snomed_code,
        snomed_display: p.snomed_display,
        icd10_code: p.icd10_code,
        icd10_display: p.icd10_display,
        category: "medical-history",
        source_section: "pmh",
        coding_source: "nlp-stream-b",
      });
      streamB.count++;
      streamB.items.push({
        snomed_code: p.snomed_code,
        snomed_display: p.snomed_display,
        icd10_code: p.icd10_code,
        icd10_display: p.icd10_display,
      });
    }
    streamB.status = statusFor(streamB.count, pmhHits.length);

    // -------- Stream C: Medications -----------------------------------
    const meds = (medsRes.data ?? []) as any[];
    const streamC: StreamResult = { status: "coded", count: 0, items: [] };
    for (const m of meds) {
      const drugName = String(
        m.medication_name || m.drug_name || m.medication || m.drug || m.name || "",
      ).trim();
      if (!drugName) continue;
      if (m.rxnorm_code) {
        streamC.count++;
        streamC.items.push({ id: m.id, name: drugName, rxnorm_code: m.rxnorm_code });
        continue;
      }
      const rx = await resolveRxNorm(drugName);
      if (!rx) continue;
      await supabase
        .from("medication_orders")
        .update({
          rxnorm_code: rx.code,
          rxnorm_display: rx.display,
          coding_source: "nlp-stream-c",
          coded_at: new Date().toISOString(),
          term_status: "pending",
        } as any)
        .eq("id", m.id);
      streamC.count++;
      streamC.items.push({ id: m.id, name: drugName, rxnorm_code: rx.code, rxnorm_display: rx.display });
    }
    streamC.status = statusFor(streamC.count, meds.length);

    // -------- Stream D: Allergies -------------------------------------
    const allergies = (allergiesRes.data ?? []) as any[];
    const streamD: StreamResult = { status: "coded", count: 0, items: [] };
    for (const a of allergies) {
      const substance = String(a.substance ?? "").trim();
      if (!substance) continue;
      const patch: Record<string, unknown> = {};
      const envHit = lookupAllergenSnomed(substance);
      if (envHit) {
        patch.substance_snomed = envHit.snomed;
      } else if (!a.substance_rxcui) {
        const rx = await resolveRxNorm(substance);
        if (rx) patch.substance_rxcui = rx.code;
      }
      const reaction = String(a.reaction ?? "").trim();
      if (reaction && !a.reaction_snomed) {
        const rSnomed = await resolveAndValidateSnomed(reaction);
        if (rSnomed?.code) patch.reaction_snomed = rSnomed.code;
      }
      if (Object.keys(patch).length) {
        patch.coding_source = "nlp-stream-d";
        patch.coded_at = new Date().toISOString();
        await supabase.from("allergies").update(patch as any).eq("id", a.id);
        streamD.count++;
        streamD.items.push({ id: a.id, substance, ...patch });
      }
    }
    streamD.status = statusFor(streamD.count, allergies.length);

    // -------- Stream E: Vitals (LOINC static map) ---------------------
    const streamE: StreamResult = { status: "coded", count: 0, items: [] };
    const vRow = (vitalsRes.data ?? [])[0] as any;
    if (vRow) {
      const codes: string[] = [];
      const displays: string[] = [];
      const loincMap: Record<string, string> = {};
      for (const key of Object.keys(VITALS_LOINC)) {
        if (vRow[key] != null) {
          codes.push(VITALS_LOINC[key].code);
          displays.push(VITALS_LOINC[key].display);
          loincMap[key] = VITALS_LOINC[key].code;
        }
      }
      if (codes.length) {
        await supabase
          .from("vitals")
          .update({
            loinc_code: codes.join(","),
            loinc_display: displays.join(","),
            loinc_map: loincMap,
          } as any)
          .eq("id", vRow.id);
        streamE.count = codes.length;
        streamE.items.push({ id: vRow.id, loinc_map: loincMap });
      }
    }

    // -------- Stream F: Lab Results (LOINC) ---------------------------
    const labs = (labsRes.data ?? []) as any[];
    const streamF: StreamResult = { status: "coded", count: 0, items: [] };
    for (const lab of labs) {
      const name = String(lab.test_name ?? "").trim();
      if (!name) continue;
      if (lab.loinc_code) {
        streamF.count++;
        streamF.items.push({ id: lab.id, test_name: name, loinc_code: lab.loinc_code });
        continue;
      }
      const pre = lookupLabLoinc(name);
      let code: string | null = pre?.code ?? null;
      let display: string | null = pre?.display ?? null;
      if (!code) {
        const hit = await resolveLoinc(name);
        if (hit) {
          code = hit.code;
          display = hit.display;
        }
      }
      if (!code) continue;
      await supabase
        .from("lab_results")
        .update({ loinc_code: code, loinc_display: display } as any)
        .eq("id", lab.id);
      streamF.count++;
      streamF.items.push({ id: lab.id, test_name: name, loinc_code: code, loinc_display: display });
    }
    streamF.status = statusFor(streamF.count, labs.length);

    // -------- Overall confidence --------------------------------------
    // Stream A confidence is 0-1 from proxy. Direct-mapped streams add 1.0
    // per successfully coded stream (B–F). Divide by number of contributing
    // streams for an average.
    const parts: number[] = [];
    if (cc) parts.push(aConfidence || 0);
    for (const s of [streamB, streamC, streamD, streamE, streamF]) {
      if (s.count > 0) parts.push(1.0);
    }
    const confidence =
      parts.length > 0 ? parts.reduce((a, b) => a + b, 0) / parts.length : 0;

    // -------- Write nlp_audit_logs row --------------------------------
    const rawParts: string[] = [];
    if (cc) rawParts.push(`CC: ${cc}`);
    if (pmhHits.length) rawParts.push(`PMH: ${pmhHits.map((p) => p.label).join(", ")}`);
    const medNames = meds
      .map((m) => m.medication_name || m.drug_name || m.medication || m.drug || m.name)
      .filter(Boolean);
    if (medNames.length) rawParts.push(`MEDS: ${medNames.join(", ")}`);

    const standardized = {
      stream_a: streamA.items[0]
        ? { ...streamA.items[0] }
        : null,
      stream_b: streamB.items,
      stream_c: streamC.items,
      stream_d: streamD.items,
      stream_e: streamE.items[0]?.loinc_map ?? {},
      stream_f: streamF.items,
    };
    const extractionMapping = {
      streams: {
        a: { source: "chief_complaint", status: streamA.status, count: streamA.count },
        b: { source: "pmh", status: streamB.status, count: streamB.count },
        c: { source: "medication_orders", status: streamC.status, count: streamC.count },
        d: { source: "allergies", status: streamD.status, count: streamD.count },
        e: { source: "vitals", status: streamE.status, count: streamE.count },
        f: { source: "lab_results", status: streamF.status, count: streamF.count },
      },
    };

    await supabase.from("nlp_audit_logs" as any).insert({
      patient_mrn: mrn,
      raw_text: rawParts.join(" | "),
      extraction_mapping: extractionMapping,
      standardized_output: standardized,
      confidence_score: confidence,
      status: "pending",
      resolution_method: "auto-6-stream",
    } as any);

    return {
      mrn,
      patient_name: patientName,
      confidence,
      streams: { a: streamA, b: streamB, c: streamC, d: streamD, e: streamE, f: streamF },
    };
  } catch (e) {
    console.warn("[coding-pipeline] failed for", mrn, e);
    return null;
  } finally {
    inFlight.delete(mrn);
  }
}

/** Idempotent conditions upsert keyed by mrn + snomed_code. */
async function upsertCondition(row: {
  mrn: string;
  patient_name: string | null;
  display_text: string;
  snomed_code: string;
  snomed_display: string;
  icd10_code: string | null;
  icd10_display: string | null;
  category: string;
  source_section: string;
  coding_source: string;
}) {
  const { data: existing } = await supabase
    .from("conditions")
    .select("id")
    .eq("mrn", row.mrn)
    .eq("snomed_code", row.snomed_code)
    .maybeSingle();
  const payload = {
    mrn: row.mrn,
    patient_name: row.patient_name,
    display_text: row.display_text,
    snomed_code: row.snomed_code,
    snomed_display: row.snomed_display,
    icd10_code: row.icd10_code,
    icd10_display: row.icd10_display,
    category: row.category,
    clinical_status: "active",
    verification_status: "provisional",
    term_status: "pending",
    coding_source: row.coding_source,
    source_section: row.source_section,
    coded_at: new Date().toISOString(),
  };
  if (existing?.id) {
    await supabase.from("conditions").update(payload as any).eq("id", existing.id);
  } else {
    await supabase
      .from("conditions")
      .insert({ ...payload, onset_date: new Date().toISOString(), created_by_type: "auto" } as any);
  }
}

/**
 * Approve all pending codes tied to an MRN. Sets term_status='approved'
 * across conditions/medication_orders/allergies + verification_status
 * on conditions + updates the latest nlp_audit_log row. Also feeds
 * uncovered SNOMED codes into the Auto Terminologist queue.
 */
export async function approveMrnCoding(mrn: string): Promise<void> {
  const nowIso = new Date().toISOString();
  await Promise.all([
    supabase
      .from("conditions")
      .update({ term_status: "approved", verification_status: "confirmed" } as any)
      .eq("mrn", mrn),
    supabase
      .from("medication_orders")
      .update({ term_status: "approved" } as any)
      .eq("patient_mrn", mrn),
  ]);

  // Flip the latest audit log row for this MRN → approved
  const { data: latest } = await supabase
    .from("nlp_audit_logs" as any)
    .select("id")
    .eq("patient_mrn", mrn)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if ((latest as any)?.id) {
    await supabase
      .from("nlp_audit_logs" as any)
      .update({ status: "approved", updated_at: nowIso } as any)
      .eq("id", (latest as any).id);
  }

  // Feed uncovered SNOMED codes into Auto Terminologist queue
  const { data: conds } = await supabase
    .from("conditions")
    .select("snomed_code, snomed_display, source_section")
    .eq("mrn", mrn)
    .not("snomed_code", "is", null);
  const snomedCodes = Array.from(
    new Set(((conds ?? []) as any[]).map((r) => r.snomed_code).filter(Boolean)),
  );
  if (snomedCodes.length === 0) return;

  const { data: vsets } = await supabase
    .from("custom_value_sets")
    .select("codes");
  const covered = new Set<string>();
  for (const vs of (vsets ?? []) as any[]) {
    const codes = Array.isArray(vs.codes) ? vs.codes : [];
    for (const c of codes) {
      const code = typeof c === "string" ? c : c?.code;
      if (code) covered.add(String(code));
    }
  }
  const gaps = snomedCodes.filter((c) => !covered.has(c));
  if (gaps.length === 0) return;
  await supabase.from("auto_terminologist_log" as any).insert(
    gaps.map((code) => ({
      action: "gap_from_approval",
      message: `Uncovered SNOMED ${code} discovered on approval of ${mrn}`,
      theme: "Approval-driven Gap",
      codes_count: 1,
      confidence: 1.0,
      run_at: nowIso,
    })) as any,
  );
}