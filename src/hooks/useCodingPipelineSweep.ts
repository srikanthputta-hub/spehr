import { useEffect, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import { runSixStreamPipeline } from "@/lib/coding-pipeline";
import { getAutomationEnabled } from "@/hooks/useAutomationEnabled";

/**
 * Leader-elected background sweep that runs the six-stream coding
 * pipeline on any admitted patient that hasn't been coded yet (no
 * nlp_audit_logs row referencing their MRN). Capped at 5 patients per
 * tick to respect UMLS rate limits. Ticks every 30s; gated on the
 * automation-enabled flag.
 */
const LEADER_KEY = "spehr.coding-sweep.leader";
const LEADER_LEASE_MS = 3 * 60_000;
const TICK_MS = 30_000;
const MAX_PER_TICK = 5;
const TAB_ID = Math.random().toString(36).slice(2);

function tryAcquireLeader(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const raw = localStorage.getItem(LEADER_KEY);
    const now = Date.now();
    if (raw) {
      const { id, ts } = JSON.parse(raw);
      if (id !== TAB_ID && now - ts < LEADER_LEASE_MS) return false;
    }
    localStorage.setItem(LEADER_KEY, JSON.stringify({ id: TAB_ID, ts: now }));
    return true;
  } catch {
    return false;
  }
}

export function useCodingPipelineSweep() {
  const busy = useRef(false);
  useEffect(() => {
    let stopped = false;

    const tick = async () => {
      if (stopped || busy.current) return;
      if (!getAutomationEnabled()) return;
      if (!tryAcquireLeader()) return;
      busy.current = true;
      try {
        // Recent admissions, newest first
        const { data: patients } = await supabase
          .from("patients")
          .select("mrn")
          .eq("status", "Admitted")
          .order("admission_time", { ascending: false })
          .limit(50);
        const mrns = ((patients ?? []) as any[]).map((p) => p.mrn).filter(Boolean);
        if (mrns.length === 0) return;

        // Skip MRNs that already have any audit log row
        const { data: logged } = await supabase
          .from("nlp_audit_logs" as any)
          .select("patient_mrn")
          .in("patient_mrn", mrns);
        const covered = new Set(((logged ?? []) as any[]).map((l) => l.patient_mrn));
        const todo = mrns.filter((m) => !covered.has(m)).slice(0, MAX_PER_TICK);

        for (const mrn of todo) {
          if (stopped) break;
          await runSixStreamPipeline(mrn);
        }
      } catch (e) {
        console.warn("[coding-sweep] tick failed", e);
      } finally {
        busy.current = false;
      }
    };

    // Delay first tick a bit to let the app settle
    const first = setTimeout(tick, 8_000);
    const iv = setInterval(tick, TICK_MS);
    return () => {
      stopped = true;
      clearTimeout(first);
      clearInterval(iv);
    };
  }, []);
}