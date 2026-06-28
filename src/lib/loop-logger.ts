import { supabase } from "@/integrations/supabase/client";

/**
 * Shared heartbeat writer for the 23 Watchdog loops.
 * Every background engine calls `logLoop(engine, status, payload)` at the
 * end of each cycle. The Watchdog UI reads `automation_watchdog_logs`
 * keyed by `engine` to derive real status (NORMAL / WARNING / ERROR /
 * INACTIVE) from actual execution evidence — not derived timestamps.
 */

export type LoopStatus = "NORMAL" | "WARNING" | "ERROR" | "PAUSED";

export type LoopKey =
  | "VITALS_SIMULATION"
  | "CLINICAL_ALERTS"
  | "CDS_MONITOR"
  | "AUTO_DISCHARGE"
  | "REVENUE_CYCLE"
  | "STAFF_ASSIGNMENT"
  | "FHIR_SYNC"
  | "UMLS_VALIDATION"
  | "LATENCY_PING"
  | "WATCHDOG_HEARTBEAT"
  | "UMLS_LIVE_QUERY"
  | "NLP_PIPELINE"
  | "PRE_PUSH_STANDARD"
  | "DRUG_SAFETY"
  | "NLP_CONFIDENCE_GATE"
  | "GC_SWEEP"
  | "FHIR_R4_COMPLIANCE";

export async function logLoop(
  engine: LoopKey,
  status: LoopStatus,
  payload: Record<string, unknown> = {},
): Promise<void> {
  try {
    await supabase.from("automation_watchdog_logs").insert({
      engine,
      status,
      payload,
      engines_checked: { [engine]: payload },
      issues_detected: status === "ERROR" || status === "WARNING",
      actions_taken: payload.actions_taken ?? "heartbeat",
      healed_engines: [],
      global_control_status: payload.global_control_status ?? "ON",
    } as any);
  } catch (e) {
    console.warn("[loop-logger] insert failed", engine, e);
  }
}

/** Leader-election guard so only one tab drives the heartbeats. */
const LEADER_KEY = "spehr.loops.leader";
const LEADER_LEASE_MS = 30_000;
const TAB_ID = Math.random().toString(36).slice(2);

export function isLoopLeader(): boolean {
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