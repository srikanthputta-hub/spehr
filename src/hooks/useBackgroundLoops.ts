import { useEffect } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { getAutomationEnabled } from "@/hooks/useAutomationEnabled";
import { logLoop, isLoopLeader, type LoopKey } from "@/lib/loop-logger";
import { assignStaffToPatient, releaseStaffForPatient } from "@/lib/staff-assignment";
import { resolveIcd10, resolveSnomed, resolveRxNorm, resolveLoinc } from "@/lib/umls-client";
import { backfillInvoices } from "@/lib/auto-doc.functions";
import { runAutoDoc } from "@/lib/auto-doc.functions";
import { checkNameMatch } from "@/lib/drug-allergy-check";

/**
 * Root-mounted background loops — Parts 1-7 of the Automation Engine spec.
 *
 * All 12 loops run on intervals here so they are tab-independent: once the
 * app boots, every engine ticks regardless of which route the user is
 * viewing. The global toggle `system_settings.automation_enabled` pauses
 * every loop when OFF (spec-literal — including infra loops). Each cycle
 * writes to `automation_watchdog_logs` with its `engine` key so the
 * Watchdog UI shows real status derived from real evidence.
 */

type PatientLite = { mrn: string; facility_name: string | null; status: string | null };

async function listAdmitted(limit = 200): Promise<PatientLite[]> {
  const { data } = await supabase
    .from("patients")
    .select("mrn, facility_name, status")
    .eq("status", "Admitted")
    .not("mrn", "is", null)
    .order("admission_time", { ascending: false })
    .limit(limit);
  return ((data ?? []) as any[]).map((p) => ({
    mrn: p.mrn,
    facility_name: p.facility_name,
    status: p.status,
  }));
}

/* ===========================================================
 * Loop 1: Vitals Simulation — 3s tick, writes to vitals + clinical_alerts
 * =========================================================== */
function rand(min: number, max: number) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
function jitter(base: number, delta: number, lo: number, hi: number) {
  const next = base + rand(-delta, delta);
  return Math.max(lo, Math.min(hi, next));
}

async function vitalsTick() {
  const admitted = await listAdmitted(150);
  if (admitted.length === 0) {
    await logLoop("VITALS_SIMULATION", "NORMAL", { patients: 0 });
    return;
  }
  const rows: any[] = [];
  const alerts: any[] = [];
  // Fetch latest vitals snapshot per patient as the baseline.
  const { data: cur } = await supabase
    .from("patients")
    .select("mrn, hr, bp_systolic, bp_diastolic, spo2, rr, temp")
    .in("mrn", admitted.map((p) => p.mrn));
  const baseByMrn = new Map<string, any>();
  for (const p of (cur ?? []) as any[]) baseByMrn.set(p.mrn, p);

  for (const p of admitted) {
    const base = baseByMrn.get(p.mrn) ?? {};
    const hr = jitter(base.hr ?? 80, 3, 45, 130);
    const sbp = jitter(base.bp_systolic ?? 120, 4, 80, 190);
    const dbp = jitter(base.bp_diastolic ?? 80, 3, 50, 110);
    const spo2 = jitter(base.spo2 ?? 98, 1, 88, 100);
    const rr = jitter(base.rr ?? 16, 1, 10, 30);
    const tempF = Number(base.temp ?? 98.6);
    const tempC = Math.max(36.0, Math.min(40.5, ((tempF - 32) * 5) / 9 + (Math.random() - 0.5) * 0.2));
    rows.push({
      mrn: p.mrn,
      hr,
      bp_systolic: sbp,
      bp_diastolic: dbp,
      spo2,
      rr,
      temp_c: Number(tempC.toFixed(2)),
      source: "simulation",
    });
    // Mirror onto patients for legacy components that read it directly.
    await supabase
      .from("patients")
      .update({
        hr,
        bp_systolic: sbp,
        bp_diastolic: dbp,
        bp: `${sbp}/${dbp}`,
        spo2,
        rr,
        temp: Number(((tempC * 9) / 5 + 32).toFixed(1)),
      } as any)
      .eq("mrn", p.mrn);
    // Critical thresholds
    if (spo2 < 90) alerts.push({ mrn: p.mrn, severity: "CRITICAL", type: "SPO2_DROP", detail: { spo2 } });
    if (hr > 115 || hr < 45) alerts.push({ mrn: p.mrn, severity: "WARNING", type: "HR_ABNORMAL", detail: { hr } });
    if (sbp > 180 || sbp < 85) alerts.push({ mrn: p.mrn, severity: "WARNING", type: "BP_ABNORMAL", detail: { sbp } });
  }
  if (rows.length > 0) await supabase.from("vitals").insert(rows);
  if (alerts.length > 0) await supabase.from("clinical_alerts").insert(alerts);
  await logLoop("VITALS_SIMULATION", "NORMAL", { patients: admitted.length, alerts: alerts.length });
  if (alerts.length > 0) {
    await logLoop("CLINICAL_ALERTS", alerts.some((a) => a.severity === "CRITICAL") ? "WARNING" : "NORMAL", { new_alerts: alerts.length });
  } else {
    await logLoop("CLINICAL_ALERTS", "NORMAL", { new_alerts: 0 });
  }
}

/* ===========================================================
 * Loop 6: CDS Monitor — 60s sweep, drug × allergy + drug × condition
 * =========================================================== */
const DRUG_DISEASE_RULES: Array<{ drug: RegExp; icd: RegExp; severity: string; reason: string }> = [
  { drug: /\b(ibuprofen|naproxen|ketorolac|nsaid)\b/i, icd: /^K92\.2/, severity: "CONTRAINDICATION", reason: "NSAID with upper GI bleed" },
  { drug: /\b(metoprolol|atenolol|propranolol|bisoprolol|carvedilol)\b/i, icd: /^J45/, severity: "CONTRAINDICATION", reason: "Beta-blocker in asthma" },
  { drug: /\b(lisinopril|enalapril|ramipril|captopril)\b/i, icd: /^E87\.5/, severity: "CAUTION", reason: "ACE-I with hyperkalemia" },
  { drug: /\b(warfarin|coumadin)\b/i, icd: /.*/, severity: "CAUTION", reason: "Warfarin + NSAID interaction risk", },
];

async function cdsMonitorTick() {
  const admitted = await listAdmitted(100);
  let findings = 0;
  for (const p of admitted) {
    const [meds, allergies, conds] = await Promise.all([
      supabase.from("medication_orders").select("drug_name, medication_name, rxnorm_code, rxnorm_display").eq("patient_mrn", p.mrn).neq("status", "Discontinued").limit(40),
      supabase.from("allergies").select("substance, substance_rxcui").eq("mrn", p.mrn).limit(40),
      supabase.from("conditions").select("icd10_code, icd10_display, snomed_code").eq("mrn", p.mrn).limit(40),
    ]);
    const medList = (meds.data ?? []) as any[];
    const allergyList = (allergies.data ?? []) as any[];
    const condList = (conds.data ?? []) as any[];
    for (const m of medList) {
      const drugName = String(m.drug_name ?? m.medication_name ?? m.rxnorm_display ?? "").toLowerCase();
      if (!drugName) continue;
      for (const a of allergyList) {
        if (drugName.includes(String(a.substance ?? "").toLowerCase()) && a.substance) {
          const { data: dup } = await supabase
            .from("cds_overrides")
            .select("id")
            .eq("mrn", p.mrn)
            .eq("alert_type", "drug-allergy")
            .eq("drug_name", drugName)
            .maybeSingle();
          if (!dup) {
            await supabase.from("cds_overrides").insert({
              mrn: p.mrn,
              alert_type: "drug-allergy",
              severity: "CONTRAINDICATION",
              drug_name: drugName,
              condition_name: a.substance,
              reason: `Patient allergy to ${a.substance}`,
              physician_name: "CDS_MONITOR",
            } as any);
            findings++;
          }
        }
      }
      for (const r of DRUG_DISEASE_RULES) {
        if (!r.drug.test(drugName)) continue;
        for (const c of condList) {
          if (!c.icd10_code) continue;
          if (!r.icd.test(c.icd10_code)) continue;
          const { data: dup } = await supabase
            .from("cds_overrides")
            .select("id")
            .eq("mrn", p.mrn)
            .eq("alert_type", "drug-disease")
            .eq("drug_name", drugName)
            .eq("condition_snomed", c.snomed_code ?? c.icd10_code)
            .maybeSingle();
          if (!dup) {
            await supabase.from("cds_overrides").insert({
              mrn: p.mrn,
              alert_type: "drug-disease",
              severity: r.severity,
              drug_name: drugName,
              condition_snomed: c.snomed_code ?? c.icd10_code,
              condition_name: c.icd10_display,
              reason: r.reason,
              physician_name: "CDS_MONITOR",
            } as any);
            findings++;
          }
        }
      }
    }
  }
  await logLoop("CDS_MONITOR", "NORMAL", { patients_checked: admitted.length, new_findings: findings });
}

/* ===========================================================
 * Loop 8: Auto Discharge — 45s, picks eligible patients by target_discharge_at
 * =========================================================== */
async function autoDischargeTick() {
  const nowIso = new Date().toISOString();
  const { data } = await supabase
    .from("patients")
    .select("mrn, target_discharge_at, discharge_summary_generated")
    .eq("status", "Admitted")
    .lt("target_discharge_at", nowIso)
    .or("discharge_summary_generated.is.null,discharge_summary_generated.eq.false")
    .limit(5);
  let discharged = 0;
  for (const p of (data ?? []) as any[]) {
    try {
      await supabase.from("patients").update({ discharge_summary_generated: true } as any).eq("mrn", p.mrn);
      await runAutoDoc({ data: { mrn: p.mrn } });
      void releaseStaffForPatient(p.mrn);
      discharged++;
    } catch (e) {
      console.warn("[auto-discharge] failed", p.mrn, e);
      // Reset the flag so the next tick can retry.
      await supabase.from("patients").update({ discharge_summary_generated: false } as any).eq("mrn", p.mrn);
    }
  }
  await logLoop("AUTO_DISCHARGE", "NORMAL", { discharged, eligible: (data ?? []).length });
}

/* ===========================================================
 * Loop 10: Revenue Cycle — every 15 min
 * =========================================================== */
async function revenueCycleTick() {
  try {
    const res = await backfillInvoices();
    await logLoop("REVENUE_CYCLE", "NORMAL", { result: res });
  } catch (e) {
    await logLoop("REVENUE_CYCLE", "ERROR", { error: String(e) });
  }
}

/* ===========================================================
 * Loop 11: Staff Assignment — assign on new admissions + heartbeat
 * =========================================================== */
async function staffAssignTick() {
  const { data } = await supabase
    .from("patients")
    .select("mrn, facility_name")
    .eq("status", "Admitted")
    .not("mrn", "is", null)
    .limit(50);
  let assigned = 0;
  for (const p of (data ?? []) as any[]) {
    const { data: dup } = await supabase
      .from("patient_assignments")
      .select("mrn")
      .eq("mrn", p.mrn)
      .maybeSingle();
    if (dup) continue;
    const r = await assignStaffToPatient(p.mrn, p.facility_name);
    if (r) assigned++;
  }
  await logLoop("STAFF_ASSIGNMENT", "NORMAL", { newly_assigned: assigned });
}

/* ===========================================================
 * Loop 13 / 18: UMLS Validation + Live Query — 10 min / 5 min
 * =========================================================== */
async function umlsValidationTick() {
  let coded = 0;
  let unresolved = 0;
  const { data: conds } = await supabase
    .from("conditions")
    .select("id, display_text, snomed_code, icd10_code")
    .or("snomed_code.is.null,icd10_code.is.null")
    .limit(15);
  for (const c of (conds ?? []) as any[]) {
    const txt = c.display_text;
    if (!txt) continue;
    const [s, i] = await Promise.all([
      c.snomed_code ? Promise.resolve(null) : resolveSnomed(txt),
      c.icd10_code ? Promise.resolve(null) : resolveIcd10(txt),
    ]);
    const patch: any = { term_status: "coded" };
    if (s) { patch.snomed_code = s.code; patch.snomed_display = s.display; }
    if (i) { patch.icd10_code = i.code; patch.icd10_display = i.display; }
    if (Object.keys(patch).length > 1) {
      await supabase.from("conditions").update(patch).eq("id", c.id);
      coded++;
    } else {
      unresolved++;
    }
  }
  const { data: meds } = await supabase
    .from("medication_orders")
    .select("id, drug_name, medication_name, rxnorm_code")
    .is("rxnorm_code", null)
    .limit(15);
  for (const m of (meds ?? []) as any[]) {
    const name = m.drug_name ?? m.medication_name;
    if (!name) continue;
    const r = await resolveRxNorm(name);
    if (r) {
      await supabase.from("medication_orders").update({ rxnorm_code: r.code, rxnorm_display: r.display, term_status: "coded" } as any).eq("id", m.id);
      coded++;
    } else {
      unresolved++;
    }
  }
  const { data: labs } = await supabase
    .from("lab_orders")
    .select("id, test_type, loinc_code")
    .is("loinc_code", null)
    .limit(15);
  for (const l of (labs ?? []) as any[]) {
    if (!l.test_type) continue;
    const r = await resolveLoinc(l.test_type);
    if (r) {
      await supabase.from("lab_orders").update({ loinc_code: r.code, loinc_display: r.display, term_status: "coded" } as any).eq("id", l.id);
      coded++;
    } else {
      unresolved++;
    }
  }
  await logLoop("UMLS_VALIDATION", unresolved > coded ? "WARNING" : "NORMAL", { coded, unresolved });
  await logLoop("UMLS_LIVE_QUERY", "NORMAL", { terms_processed: coded + unresolved });
}

/* ===========================================================
 * Loop 16: Latency Ping — every 2 min
 * =========================================================== */
async function latencyPingTick() {
  const results: Record<string, { status: string; latency_ms: number | null }> = {};
  // 1. Supabase
  {
    const t = Date.now();
    try {
      await supabase.from("patients").select("mrn").limit(1);
      results.supabase = { status: "UP", latency_ms: Date.now() - t };
    } catch {
      results.supabase = { status: "DOWN", latency_ms: null };
    }
  }
  // 2. UMLS proxy
  {
    const t = Date.now();
    try {
      await supabase.functions.invoke("umls-proxy", { body: { action: "icd10", params: { string: "fever" } } });
      results.umls = { status: "UP", latency_ms: Date.now() - t };
    } catch {
      results.umls = { status: "DOWN", latency_ms: null };
    }
  }
  // 3. FHIR
  {
    const t = Date.now();
    try {
      await supabase.functions.invoke("fhir-proxy", { body: { method: "GET", path: "metadata" } });
      results.fhir = { status: "UP", latency_ms: Date.now() - t };
    } catch {
      results.fhir = { status: "DOWN", latency_ms: null };
    }
  }
  const rows = Object.entries(results).map(([service, r]) => ({
    service,
    status: r.status,
    latency_ms: r.latency_ms,
  }));
  await supabase.from("api_health_pings").insert(rows);
  const anyDown = rows.some((r) => r.status === "DOWN");
  const anySlow = rows.some((r) => (r.latency_ms ?? 0) > 3000);
  await logLoop("LATENCY_PING", anyDown ? "ERROR" : anySlow ? "WARNING" : "NORMAL", results);
}

/* ===========================================================
 * Loop 19: NLP Pipeline — every 30s, drains qa_queue
 * =========================================================== */
async function nlpPipelineTick() {
  const { data: items } = await supabase
    .from("nlp_qa_queue")
    .select("id, confidence")
    .eq("status", "pending")
    .limit(30);
  let auto_approved = 0;
  let needs_review = 0;
  let auto_rejected = 0;
  for (const r of (items ?? []) as any[]) {
    const c = Number(r.confidence);
    if (c >= 0.95) {
      await supabase.from("nlp_qa_queue").update({ status: "auto_approved", reviewed_at: new Date().toISOString(), reviewer: "NLP_PIPELINE" } as any).eq("id", r.id);
      auto_approved++;
    } else if (c < 0.55) {
      await supabase.from("nlp_qa_queue").update({ status: "auto_rejected", reviewed_at: new Date().toISOString(), reviewer: "NLP_PIPELINE" } as any).eq("id", r.id);
      auto_rejected++;
    } else {
      await supabase.from("nlp_qa_queue").update({ status: "review_required" } as any).eq("id", r.id);
      needs_review++;
    }
  }
  await logLoop("NLP_PIPELINE", "NORMAL", { auto_approved, needs_review, auto_rejected });
}

/* ===========================================================
 * Loop 20: Pre-Push Standardisation — every 60s, sample patients table
 * =========================================================== */
async function prePushStandardizationTick() {
  const { data: recent } = await supabase
    .from("patients")
    .select("mrn")
    .order("last_fhir_sync", { ascending: false, nullsFirst: false })
    .limit(5);
  let pass = 0;
  let fail = 0;
  for (const p of (recent ?? []) as any[]) {
    const [c, m, l] = await Promise.all([
      supabase.from("conditions").select("snomed_code", { count: "exact", head: true }).eq("mrn", p.mrn).is("snomed_code", null),
      supabase.from("medication_orders").select("rxnorm_code", { count: "exact", head: true }).eq("patient_mrn", p.mrn).is("rxnorm_code", null),
      supabase.from("lab_orders").select("loinc_code", { count: "exact", head: true }).eq("patient_mrn", p.mrn).is("loinc_code", null),
    ]);
    const gap = (c.count ?? 0) + (m.count ?? 0) + (l.count ?? 0);
    if (gap === 0) pass++;
    else fail++;
  }
  await logLoop("PRE_PUSH_STANDARD", fail > 0 ? "WARNING" : "NORMAL", { pass, fail });
}

/* ===========================================================
 * Loop 21: Drug Safety — every 2 min
 * =========================================================== */
async function drugSafetyTick() {
  const admitted = await listAdmitted(75);
  let new_alerts = 0;
  for (const p of admitted) {
    const [meds, allergies] = await Promise.all([
      supabase.from("medication_orders").select("drug_name, rxnorm_code").eq("patient_mrn", p.mrn).limit(30),
      supabase.from("allergies").select("substance, substance_rxcui").eq("mrn", p.mrn).limit(30),
    ]);
    for (const m of (meds.data ?? []) as any[]) {
      const drug = String(m.drug_name ?? "").toLowerCase();
      for (const a of (allergies.data ?? []) as any[]) {
        const sub = String(a.substance ?? "").toLowerCase();
        if (!drug || !sub) continue;
        const ingredientMatch = (a.substance_rxcui && m.rxnorm_code && a.substance_rxcui === m.rxnorm_code) || drug.includes(sub);
        if (ingredientMatch) {
          const { error } = await supabase.from("safety_alerts").insert({
            mrn: p.mrn,
            alert_type: "DRUG_ALLERGY_CONFLICT",
            severity: "CRITICAL",
            drug_name: m.drug_name,
            drug_rxcui: m.rxnorm_code,
            allergy_substance: a.substance,
            allergy_rxcui: a.substance_rxcui,
            detail: { detected_by: "DRUG_SAFETY_SWEEP" },
          } as any);
          // Unique-index dedupe → ignore conflict errors
          if (!error) new_alerts++;
        }
      }
    }
  }
  await logLoop("DRUG_SAFETY", new_alerts > 0 ? "WARNING" : "NORMAL", { patients_checked: admitted.length, new_alerts });
}

/* ===========================================================
 * Loop 23: NLP Confidence Gate — every 60s, enforces 120s SLA
 * =========================================================== */
async function nlpConfidenceGateTick() {
  const cutoff = new Date(Date.now() - 120_000).toISOString();
  const { data: stale } = await supabase
    .from("nlp_qa_queue")
    .select("id, confidence")
    .eq("status", "review_required")
    .lt("created_at", cutoff)
    .limit(50);
  let approved = 0;
  let rejected = 0;
  for (const r of (stale ?? []) as any[]) {
    const newStatus = Number(r.confidence) >= 0.85 ? "auto_approved" : "auto_rejected";
    await supabase
      .from("nlp_qa_queue")
      .update({ status: newStatus, reviewed_at: new Date().toISOString(), reviewer: "SLA_TIMEOUT" } as any)
      .eq("id", r.id);
    if (newStatus === "auto_approved") approved++;
    else rejected++;
    await supabase.from("terminology_audit").insert({
      action: "SLA_AUTO_RESOLVE",
      resolver: "SLA_TIMEOUT",
      confidence: Number(r.confidence),
      raw_response: { id: r.id, resolution: newStatus },
    } as any).then(() => {}, () => {});
  }
  const { count: pending } = await supabase
    .from("nlp_qa_queue")
    .select("id", { count: "exact", head: true })
    .eq("status", "review_required");
  const oldest = (stale ?? [])[0] as any;
  const status = !oldest ? "NORMAL" : approved + rejected > 0 && Number(oldest.confidence) > 0.9 ? "NORMAL" : "WARNING";
  await logLoop("NLP_CONFIDENCE_GATE", status, { auto_resolved: approved + rejected, approved, rejected, pending: pending ?? 0 });
}

/* ===========================================================
 * Realtime broadcast: clinical_alerts CRITICAL → toast everywhere
 * =========================================================== */
function wireClinicalAlertBroadcast() {
  const ch = supabase
    .channel("clinical-alerts-broadcast")
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "clinical_alerts" }, (p: any) => {
      const row = p?.new;
      if (row?.severity === "CRITICAL") {
        try {
          toast.error(`CRITICAL · ${row.type} · ${row.mrn}`, { description: JSON.stringify(row.detail ?? {}) });
        } catch {}
      }
    })
    .subscribe();
  return () => { void supabase.removeChannel(ch); };
}

/* ===========================================================
 * Mount everything
 * =========================================================== */

type LoopDef = { key: LoopKey; fn: () => Promise<void>; intervalMs: number; bootDelayMs: number };

const LOOPS: LoopDef[] = [
  { key: "VITALS_SIMULATION",  fn: vitalsTick,                  intervalMs: 3_000,        bootDelayMs: 4_000 },
  { key: "CDS_MONITOR",        fn: cdsMonitorTick,              intervalMs: 60_000,       bootDelayMs: 12_000 },
  { key: "AUTO_DISCHARGE",     fn: autoDischargeTick,           intervalMs: 45_000,       bootDelayMs: 15_000 },
  { key: "REVENUE_CYCLE",      fn: revenueCycleTick,            intervalMs: 15 * 60_000,  bootDelayMs: 20_000 },
  { key: "STAFF_ASSIGNMENT",   fn: staffAssignTick,             intervalMs: 60_000,       bootDelayMs: 10_000 },
  { key: "UMLS_VALIDATION",    fn: umlsValidationTick,          intervalMs: 5 * 60_000,   bootDelayMs: 25_000 },
  { key: "LATENCY_PING",       fn: latencyPingTick,             intervalMs: 2 * 60_000,   bootDelayMs: 6_000 },
  { key: "NLP_PIPELINE",       fn: nlpPipelineTick,             intervalMs: 30_000,       bootDelayMs: 8_000 },
  { key: "PRE_PUSH_STANDARD",  fn: prePushStandardizationTick,  intervalMs: 60_000,       bootDelayMs: 18_000 },
  { key: "DRUG_SAFETY",        fn: drugSafetyTick,              intervalMs: 2 * 60_000,   bootDelayMs: 22_000 },
  { key: "NLP_CONFIDENCE_GATE",fn: nlpConfidenceGateTick,       intervalMs: 60_000,       bootDelayMs: 14_000 },
];

export function useBackgroundLoops() {
  useEffect(() => {
    if (typeof window === "undefined") return;
    const cleanups: Array<() => void> = [];

    // Broadcast first — does not depend on automation toggle.
    cleanups.push(wireClinicalAlertBroadcast());

    for (const loop of LOOPS) {
      const wrap = async () => {
        if (!isLoopLeader()) return;
        const enabled = await getAutomationEnabled();
        if (!enabled) {
          // Spec: when global toggle is OFF, all loops pause.
          await logLoop(loop.key, "PAUSED", { global_control_status: "OFF" });
          return;
        }
        try {
          await loop.fn();
        } catch (e) {
          console.warn("[bg-loop]", loop.key, e);
          await logLoop(loop.key, "ERROR", { error: String(e) });
        }
      };
      const boot = setTimeout(() => {
        void wrap();
        const id = setInterval(() => void wrap(), loop.intervalMs);
        cleanups.push(() => clearInterval(id));
      }, loop.bootDelayMs);
      cleanups.push(() => clearTimeout(boot));
    }
    return () => { for (const c of cleanups) c(); };
  }, []);
}