import { useEffect, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import {
  medsForComplaint,
  labsForComplaint,
} from "@/lib/complaint-protocols";
import { getAutomationEnabled, useAutomationEnabled } from "@/hooks/useAutomationEnabled";
import { ensureTerminology } from "@/lib/ensure-terminology";
import {
  autoFillIntake,
  intakeToSoap,
  loadIntake,
  saveIntake,
} from "@/lib/intake-record";

/* ------------------------------------------------------------------ */
/* Admission Randomizer — Staged Cascade                              */
/* ------------------------------------------------------------------ */
/* Whenever a patient is admitted (auto OR manual), schedule:         */
/*   • 3 medications — first inserted at T+20s, then 15s gap each.    */
/*     Each med cycles: ORDERED → PENDING_VERIFICATION → DISPENSED    */
/*     → ADMINISTERED with 3s between each transition.                */
/*   • 2 lab tests — first at T+20s, then 15s gap. Each cycles:       */
/*     ORDERED → PROCESSING → RESULTED (3s between transitions).      */
/* The Pharmacy and Lab boards show the live transitions in their    */
/* pending queues; everything is keyed off the patient's MRN.         */
/* ------------------------------------------------------------------ */

interface NewPatient {
  id: string;
  mrn: string | null;
  first_name: string | null;
  last_name: string | null;
  name: string | null;
  facility_name: string | null;
  chief_complaint: string | null;
  age?: number | null;
  gender?: string | null;
  dob?: string | null;
}

interface InsertedOrder {
  id: string;
  status: string | null;
  ordered_by?: string | null;
  patient_mrn?: string | null;
  mrn?: string | null;
  test_type?: string | null;
}

// Medication cascade — orders placed at T+20, T+35, T+50.
const MED_FIRST_ORDER_DELAY_MS = 20_000;
const MED_ORDER_GAP_MS = 15_000;
// Lab cascade — orders placed at T+20 and T+35.
const LAB_FIRST_ORDER_DELAY_MS = 20_000;
const LAB_ORDER_GAP_MS = 15_000;
// 3 seconds between status transitions for both engines.
const TRANSITION_GAP_MS = 3_000;

/* ------------------------------------------------------------------ */
/* MRN-keyed timer registry — every setTimeout scheduled by the       */
/* cascade is tracked here so the hook's effect cleanup (and per-MRN  */
/* re-seed checks) can cancel anything still pending. Prevents leaks  */
/* and overlapping cascades across tab focus changes.                 */
/* ------------------------------------------------------------------ */
const mrnTimers = new Map<string, Set<ReturnType<typeof setTimeout>>>();

function trackTimer(mrn: string, t: ReturnType<typeof setTimeout>) {
  let set = mrnTimers.get(mrn);
  if (!set) {
    set = new Set();
    mrnTimers.set(mrn, set);
  }
  set.add(t);
}

function untrackTimer(mrn: string, t: ReturnType<typeof setTimeout>) {
  const set = mrnTimers.get(mrn);
  if (!set) return;
  set.delete(t);
  if (set.size === 0) mrnTimers.delete(mrn);
}

function clearAllTimers() {
  for (const set of mrnTimers.values()) {
    for (const t of set) clearTimeout(t);
  }
  mrnTimers.clear();
}

function trackedDelay(mrn: string, ms: number) {
  return new Promise<void>((res) => {
    const t = setTimeout(() => {
      untrackTimer(mrn, t);
      res();
    }, ms);
    trackTimer(mrn, t);
  });
}

async function cascadeMed(mrn: string, orderId: string) {
  // Ordered → Pending Verification → Dispensed → Administered (final).
  // The chart only surfaces the order once status === "Administered".
  await trackedDelay(mrn, TRANSITION_GAP_MS);
  const approvedAt = new Date().toISOString();
  await supabase
    .from("medication_orders")
    .update({ status: "Pending Verification", approved_at: approvedAt })
    .eq("id", orderId);
  await trackedDelay(mrn, TRANSITION_GAP_MS);
  const dispensedAt = new Date().toISOString();
  await supabase
    .from("medication_orders")
    .update({
      status: "Dispensed",
      dispensed_at: dispensedAt,
    } as any)
    .eq("id", orderId);
  await trackedDelay(mrn, TRANSITION_GAP_MS);
  const administeredAt = new Date().toISOString();
  await supabase
    .from("medication_orders")
    .update({
      status: "Administered",
      administered_at: administeredAt,
    } as any)
    .eq("id", orderId);
}

async function cascadeLab(
  mrn: string,
  orderId: string,
  resultSummary: string,
) {
  // Ordered → Processing → Reported (final).
  await trackedDelay(mrn, TRANSITION_GAP_MS);
  await supabase
    .from("lab_orders")
    .update({ status: "Processing" })
    .eq("id", orderId);
  await trackedDelay(mrn, TRANSITION_GAP_MS);
  const resultedAt = new Date().toISOString();
  await supabase
    .from("lab_orders")
    .update({
      status: "Reported",
      result_value: resultSummary,
      collected_at: resultedAt,
      resulted_at: resultedAt,
    } as any)
    .eq("id", orderId);
}

/**
 * Seed an admission with the protocol meds + labs.
 *
 * Both auto and manual admissions follow the same staged cascade:
 * first order at T+20s, 15s between subsequent orders, and each
 * order transitions through its statuses with a 3s gap. Auto
 * admissions respect the global automation switch; manual
 * admissions always seed so the queues pick the patient up.
 */
export async function seedAdmission(
  p: NewPatient,
  opts: { manual?: boolean; immediate?: boolean } = {},
) {
  if (!p.mrn) return;
  const manual = !!opts.manual;
  const immediate = !!opts.immediate;

  if (!manual && !(await getAutomationEnabled())) return;

  const fallbackName = [p.first_name, p.last_name].filter(Boolean).join(" ");
  const patientName = p.name ?? (fallbackName || "Unknown");
  const mrn: string = p.mrn;
  const orderedBy = manual
    ? "Bedside RN"
    : "Ghost AI - Admission Randomizer";

  // ------------------------------------------------------------------
  // Intake auto-fill — every admission (manual OR ghost) gets a full
  // structured case-history record. Manual admits from the Admit
  // modal already persist their own intake before calling
  // seedAdmission, so loadIntake() short-circuits and we skip.
  // ------------------------------------------------------------------
  try {
    if (!loadIntake(mrn)) {
      const intake = autoFillIntake({
        firstName: p.first_name ?? undefined,
        lastName: p.last_name ?? undefined,
        age: typeof p.age === "number" ? p.age : undefined,
        chiefComplaint: p.chief_complaint ?? undefined,
      });
      saveIntake(mrn, intake);
      const { data: existingNotes } = await supabase
        .from("clinical_notes")
        .select("id")
        .eq("mrn", mrn)
        .eq("note_type", "Admission Intake (SOAP)")
        .limit(1);
      if (!existingNotes || existingNotes.length === 0) {
        await supabase.from("clinical_notes").insert({
          mrn,
          note_type: "Admission Intake (SOAP)",
          content: intakeToSoap({ ...intake, mrn }),
          author: manual ? "Admitting Provider" : "Ghost AI - Admission Randomizer",
        });
      }
    }
  } catch (e) {
    console.warn("[seedAdmission] intake autofill failed", e);
  }

  const meds = medsForComplaint(p.chief_complaint);
  const labs = labsForComplaint(p.chief_complaint);

  // ------------------------------------------------------------------
  // Dynamic sourcing — pull live RxNorm + LOINC rows from the
  // medical_terminology dictionary instead of the static fallback
  // arrays. The fallback (complaint-protocols) is only used when the
  // dictionary has fewer than 3 meds / 2 labs configured.
  // ------------------------------------------------------------------
  const complaintTokens = (p.chief_complaint ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3);

  const pickRandom = <T,>(arr: T[], n: number): T[] => {
    const pool = [...arr];
    const out: T[] = [];
    while (out.length < n && pool.length > 0) {
      out.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
    }
    return out;
  };

  const [{ data: rxDict }, { data: loincDict }, { data: icdDict }, { data: snomedDict }] = await Promise.all([
    supabase
      .from("medical_terminology")
      .select("code, display, category, description")
      .eq("code_system", "RxNorm")
      .eq("status", "active")
      .limit(200),
    supabase
      .from("medical_terminology")
      .select("code, display, category, description")
      .eq("code_system", "LOINC")
      .eq("status", "active")
      .limit(200),
    supabase
      .from("medical_terminology")
      .select("code, display, category, description")
      .eq("code_system", "ICD-10")
      .eq("status", "active")
      .limit(200),
    supabase
      .from("medical_terminology")
      .select("code, display, category, description")
      .eq("code_system", "SNOMED CT")
      .eq("status", "active")
      .limit(200),
  ]);

  type DictRow = { code: string; display: string; category: string | null; description: string | null };
  const rxRows = (rxDict ?? []) as DictRow[];
  const loincRows = (loincDict ?? []) as DictRow[];
  const icdRows = (icdDict ?? []) as DictRow[];
  const snomedRows = (snomedDict ?? []) as DictRow[];

  const scoreRow = (r: DictRow) => {
    const hay = `${r.display} ${r.description ?? ""}`.toLowerCase();
    return complaintTokens.reduce((s, t) => (hay.includes(t) ? s + 1 : s), 0);
  };

  const rankByComplaint = (rows: DictRow[]): DictRow[] => {
    if (complaintTokens.length === 0) return rows;
    const scored = rows.map((r) => ({ r, s: scoreRow(r) }));
    scored.sort((a, b) => b.s - a.s);
    return scored.map((x) => x.r);
  };

  // Parse "Drug 5 mg PO" → { name, dose, route } when possible.
  const ROUTE_RE = /\b(PO|IV|IM|SQ|SC|SL|PR|TOP|INH|Nebulizer|Topical|Subq)\b/i;
  const DOSE_RE = /(\d+(?:\.\d+)?\s*(?:mg|mcg|g|ml|mL|units?|IU|mEq|tabs?|puffs?|L))/i;
  const parseMed = (display: string) => {
    const dose = display.match(DOSE_RE)?.[1] ?? "1 dose";
    const route = display.match(ROUTE_RE)?.[1] ?? "PO";
    const name = display
      .replace(DOSE_RE, "")
      .replace(ROUTE_RE, "")
      .replace(/\s{2,}/g, " ")
      .trim() || display;
    return { name, dose, route };
  };

  // Build candidate meds: dictionary-first, complaint-fallback to fill.
  const ranked = rankByComplaint(rxRows);
  const dictMeds = (ranked.length >= 6 ? pickRandom(ranked.slice(0, 12), 3) : ranked.slice(0, 3))
    .map((r) => ({ ...parseMed(r.display), rxcui: r.code }));
  const protocolMeds = meds.map((m) => ({ name: m.name, dose: m.dose, route: m.route, rxcui: null as string | null }));
  const finalMeds = [...dictMeds, ...protocolMeds].slice(0, 3);

  // Labs: dictionary-first, complaint-fallback to fill.
  const rankedLabs = rankByComplaint(loincRows);
  const dictLabs = (rankedLabs.length >= 4 ? pickRandom(rankedLabs.slice(0, 8), 2) : rankedLabs.slice(0, 2)).map((r) => ({
    name: r.display,
    unit: "",
    referenceRange: "",
    resultExample: `${r.display}: resulted`,
    loinc: r.code,
  }));
  const protocolLabs = labs.map((l) => ({ ...l, loinc: null as string | null }));
  const finalLabs = [...dictLabs, ...protocolLabs].slice(0, 2);

  // ------------------------------------------------------------------
  // Baseline diagnostic codes: pick at least one ICD-10 + one SNOMED CT
  // row matching the chief complaint and persist them on the patient.
  // ------------------------------------------------------------------
  const pickDiagnosticCodes = (rows: DictRow[], n: number): string[] => {
    const ranked = rankByComplaint(rows);
    if (ranked.length === 0) return [];
    const top = ranked.slice(0, Math.max(n, 4));
    return pickRandom(top, Math.min(n, top.length)).map((r) => r.code);
  };
  const icdCodes = pickDiagnosticCodes(icdRows, 1);
  const snomedCodes = pickDiagnosticCodes(snomedRows, 1);
  if (icdCodes.length || snomedCodes.length) {
    await supabase
      .from("patients")
      .update({
        icd10_codes: icdCodes,
        snomed_codes: snomedCodes,
      } as any)
      .eq("mrn", mrn);
  }

  // Auto-grow the dictionary for the chief complaint itself (ICD-10).
  if (p.chief_complaint?.trim()) {
    ensureTerminology("ICD-10", { display: p.chief_complaint.trim() }).catch(() => {});
  }

  const norm = (v: string | null | undefined) => (v ?? "").trim().toLowerCase();

  const [{ data: existingMeds }, { data: existingLabs }] = await Promise.all([
    supabase
      .from("medication_orders")
      .select("medication_name, drug_name")
      .eq("patient_mrn", mrn),
    supabase
      .from("lab_orders")
      .select("test_type")
      .eq("patient_mrn", mrn),
  ]);

  const existingMedNames = new Set(
    ((existingMeds as Array<{ medication_name?: string | null; drug_name?: string | null }> | null) ?? [])
      .map((m) => norm(m.medication_name ?? m.drug_name))
      .filter(Boolean),
  );
  const existingLabNames = new Set(
    ((existingLabs as Array<{ test_type?: string | null }> | null) ?? [])
      .map((l) => norm(l.test_type))
      .filter(Boolean),
  );

  // Schedule meds: T+20s, T+35s, T+50s
  finalMeds.filter((m) => !existingMedNames.has(norm(m.name))).forEach((m, i) => {
    const t = MED_FIRST_ORDER_DELAY_MS + i * MED_ORDER_GAP_MS;
    const timer = setTimeout(async () => {
      untrackTimer(mrn, timer);
      const { data, error } = await supabase
        .from("medication_orders")
        .insert({
          patient_id: p.id,
          patient_mrn: mrn,
          mrn,
          patient_name: patientName,
          facility_name: p.facility_name,
          medication_name: m.name,
          drug_name: m.name,
          dose: m.dose,
          route: m.route,
          frequency: "Once",
          status: "Ordered",
          ordered_by: orderedBy,
        })
        .select("id")
        .single();
      if (error || !data) {
        // Partial-unique index collision: another tab/worker already seeded
        // this (MRN, drug) pair. Silently skip — the winning insert owns
        // the cascade for this order.
        return;
      }
      cascadeMed(mrn, data.id).catch((e) =>
        console.warn("[cascadeMed] failed", e),
      );
    }, t);
    trackTimer(mrn, timer);
  });

  // Schedule labs: T+25s, T+45s
  finalLabs.filter((l) => !existingLabNames.has(norm(l.name))).forEach((l, i) => {
    const t = LAB_FIRST_ORDER_DELAY_MS + i * LAB_ORDER_GAP_MS;
    const resultSummary = `${l.name}: ${l.resultExample} (ref ${l.referenceRange}${
      l.unit ? ` ${l.unit}` : ""
    })`;
    const timer = setTimeout(async () => {
      untrackTimer(mrn, timer);
      const { data, error } = await supabase
        .from("lab_orders")
        .insert({
          patient_mrn: mrn,
          patient_name: patientName,
          facility_name: p.facility_name ?? "Memorial Hospital",
          requested_by: orderedBy,
          test_type: l.name,
          status: "Ordered",
          ordered_by: orderedBy,
        })
        .select("id")
        .single();
      if (error || !data) return; // unique-index collision → another tab wins
      cascadeLab(mrn, data.id, resultSummary).catch((e) =>
        console.warn("[cascadeLab] failed", e),
      );
    }, t);
    trackTimer(mrn, timer);
  });
}

export function useAIAutomation() {
  const seeded = useRef<Set<string>>(new Set());
  const automationEnabled = useAutomationEnabled();

  useEffect(() => {
    if (!automationEnabled) return;
    // Orphan sweeper — finalize only VERY stale rows (>30 min) so a
    // closed tab mid-cascade doesn't strand pending rows forever, but
    // active staged cascades (which finish in ~60s) are never touched.
    const sweepOrphans = async () => {
      const cutoff = new Date(Date.now() - 30 * 60_000).toISOString();
      const nowIso = new Date().toISOString();
      await supabase
        .from("medication_orders")
        .update({ status: "Administered", administered_at: nowIso } as any)
        .lt("created_at", cutoff)
        .in("status", [
          "Ordered", "Pending", "Pending Verification", "Dispensed",
          "ORDERED", "PENDING", "PENDING_VERIFICATION", "DISPENSED",
        ]);
      await supabase
        .from("lab_orders")
        .update({ status: "Reported", resulted_at: nowIso } as any)
        .lt("created_at", cutoff)
        .in("status", ["Ordered", "Processing", "ORDERED", "PROCESSING"]);
    };
    sweepOrphans().catch(() => {});
    const sweepInterval = setInterval(() => {
      sweepOrphans().catch(() => {});
    }, 5 * 60_000);

    // Backfill any admitted patient that has NO orders yet (e.g. admitted
    // while the tab was closed). Patients that already have orders are
    // skipped — the cascade for them is owned by whatever tab seeded them.
    const reconcileActiveAdmissions = async () => {
      const { data } = await supabase
        .from("patients")
        .select("id, mrn, first_name, last_name, name, facility_name, chief_complaint, age, gender, dob")
        .eq("status", "Admitted")
        .not("mrn", "is", null)
        .order("admission_time", { ascending: false })
        .limit(100);
      for (const p of ((data as NewPatient[] | null) ?? [])) {
        if (!p.mrn) continue;
        const [{ count: medCount }, { count: labCount }] = await Promise.all([
          supabase.from("medication_orders").select("id", { count: "exact", head: true }).eq("patient_mrn", p.mrn),
          supabase.from("lab_orders").select("id", { count: "exact", head: true }).eq("patient_mrn", p.mrn),
        ]);
        if ((medCount ?? 0) > 0 || (labCount ?? 0) > 0) continue;
        await seedAdmission(p).catch((e) =>
          console.warn("[admission-reconcile] seed failed", e),
        );
      }
    };
    reconcileActiveAdmissions().catch((e) =>
      console.warn("[admission-reconcile] failed", e),
    );

    const channel = supabase
      .channel("admission-randomizer")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "patients" },
        (payload) => {
          const p = payload.new as NewPatient;
          if (!p?.id || seeded.current.has(p.id)) return;
          seeded.current.add(p.id);
          seedAdmission(p).catch((e) =>
            console.warn("[admission-randomizer] seed failed", e),
          );
        },
      )
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "medication_orders" },
        (payload) => {
          const o = payload.new as InsertedOrder;
          const mrn = o.patient_mrn ?? o.mrn;
          const source = (o.ordered_by ?? "").toLowerCase();
          if (!mrn || (o.status ?? "").toLowerCase() !== "ordered") return;
          // Only auto-cascade truly manual physician orders. Admission
          // workflow / randomizer / bedside RN orders own their own
          // staged cascade — do NOT short-circuit them here.
          if (
            source.includes("admission randomizer") ||
            source.includes("admission workflow") ||
            source.includes("bedside rn") ||
            source.includes("ghost ai")
          ) return;
          cascadeMed(mrn, o.id).catch((e) => console.warn("[order-cascadeMed] failed", e));
        },
      )
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "lab_orders" },
        (payload) => {
          const o = payload.new as InsertedOrder;
          const mrn = o.patient_mrn ?? o.mrn;
          const source = (o.ordered_by ?? "").toLowerCase();
          if (!mrn || (o.status ?? "").toLowerCase() !== "ordered") return;
          if (
            source.includes("admission randomizer") ||
            source.includes("admission workflow") ||
            source.includes("bedside rn") ||
            source.includes("ghost ai")
          ) return;
          cascadeLab(mrn, o.id, `${o.test_type ?? "Lab"}: resulted`).catch((e) =>
            console.warn("[order-cascadeLab] failed", e),
          );
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
      clearAllTimers();
      clearInterval(sweepInterval);
    };
  }, [automationEnabled]);
}