import { useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { getAutomationEnabled, useAutomationEnabled } from "@/hooks/useAutomationEnabled";
import { fetchWithTimeout } from "@/lib/async-timeout";

/**
 * Automation Watchdog
 * -------------------
 * Runs a self-healing health check on the core AI engines (admissions,
 * pharmacy queue, lab queue). In production this would cycle every
 * 15 min — for the live preview it ticks every 60 s so operators can
 * see telemetry / intervention banners without waiting.
 *
 * If the global automation switch is ON but one of the engines has
 * shown zero activity over the threshold window OR has pending rows
 * stuck past the cascade duration, the watchdog will:
 *   1) Force-trigger a recovery cycle (RPC ghost admission, advance
 *      stuck Ordered/Pending orders, request a lab/pharm sweep).
 *   2) Append a row to `automation_watchdog_logs` describing what was
 *      detected and which engines were healed.
 * Otherwise it logs a heartbeat (issues_detected=false).
 */

// Accelerated for preview: real 15-min cycle is `15 * 60_000`.
const WATCHDOG_INTERVAL_MS = 60_000;
// Ghost admission randomizer cadence when engines are active.
const GHOST_ADMIT_INTERVAL_MS = 90_000;
// Activity windows used to flag a stalled engine.
const ADMISSION_IDLE_MS = 6 * 60_000;
const QUEUE_IDLE_MS = 6 * 60_000;
// Stuck-row thresholds (cascade finishes in ~60s; >3 min = stuck).
const STUCK_ORDER_MS = 3 * 60_000;

type Engine = "Admissions" | "Pharmacy Queue" | "Lab Queue";

/**
 * Force-seed the network with ghost patients when the census is empty.
 * Called once on the first watchdog cycle after engines come online so
 * dashboards don't sit empty waiting for the 90s randomizer tick.
 */
export async function forceSeedGhostPatients(target = 5, gapMs = 2_000) {
  for (let i = 0; i < target; i++) {
    try {
      await supabase.rpc("auto_admit_ghost_patient");
    } catch (e) {
      console.warn("[watchdog] force-seed RPC failed", e);
    }
    if (i < target - 1) await new Promise((r) => setTimeout(r, gapMs));
  }
}

async function runWatchdogCycle() {
  const automationOn = await getAutomationEnabled();

  // First-cycle seed: if engines are on but the active census is < 3,
  // fire the randomizer 5x with 2s gaps to populate facilities.
  if (automationOn) {
    const { count: admittedNow } = await supabase
      .from("patients")
      .select("id", { count: "exact", head: true })
      .eq("status", "Admitted");
    if ((admittedNow ?? 0) < 3) {
      await forceSeedGhostPatients(5, 2_000);
    }
  }

  const enginesChecked: Record<string, any> = {};
  const healed: Engine[] = [];
  const actions: string[] = [];

  // ---- Admissions ----
  const admitCutoff = new Date(Date.now() - ADMISSION_IDLE_MS).toISOString();
  const { count: recentAdmits } = await supabase
    .from("patients")
    .select("id", { count: "exact", head: true })
    .gte("admission_time", admitCutoff);
  enginesChecked["Admissions"] = {
    recent_admissions: recentAdmits ?? 0,
    window_minutes: ADMISSION_IDLE_MS / 60_000,
  };
  const admissionsStalled = automationOn && (recentAdmits ?? 0) === 0;

  // ---- Pharmacy ----
  const orderCutoff = new Date(Date.now() - QUEUE_IDLE_MS).toISOString();
  const { count: recentMeds } = await supabase
    .from("medication_orders")
    .select("id", { count: "exact", head: true })
    .gte("created_at", orderCutoff);
  const stuckMedCutoff = new Date(Date.now() - STUCK_ORDER_MS).toISOString();
  const { data: stuckMeds } = await supabase
    .from("medication_orders")
    .select("id, status")
    .in("status", ["Ordered", "Pending Verification", "Dispensed"])
    .lt("created_at", stuckMedCutoff)
    .limit(50);
  enginesChecked["Pharmacy Queue"] = {
    recent_orders: recentMeds ?? 0,
    stuck_orders: stuckMeds?.length ?? 0,
  };
  const pharmacyStalled =
    automationOn &&
    ((recentMeds ?? 0) === 0 || (stuckMeds?.length ?? 0) > 0);

  // ---- Lab ----
  const { count: recentLabs } = await supabase
    .from("lab_orders")
    .select("id", { count: "exact", head: true })
    .gte("created_at", orderCutoff);
  const { data: stuckLabs } = await supabase
    .from("lab_orders")
    .select("id, status")
    .in("status", ["Ordered", "Processing"])
    .lt("created_at", stuckMedCutoff)
    .limit(50);
  enginesChecked["Lab Queue"] = {
    recent_orders: recentLabs ?? 0,
    stuck_orders: stuckLabs?.length ?? 0,
  };
  const labStalled =
    automationOn &&
    ((recentLabs ?? 0) === 0 || (stuckLabs?.length ?? 0) > 0);

  // ---- Heal ----
  if (admissionsStalled) {
    try {
      await supabase.rpc("auto_admit_ghost_patient");
      healed.push("Admissions");
      actions.push(
        `Restarted Admission Randomizer — no new patient in ${ADMISSION_IDLE_MS / 60_000} min. Forced ghost admission cycle via auto_admit_ghost_patient().`,
      );
    } catch (e) {
      actions.push(`Admission auto-heal failed: ${(e as Error).message}`);
    }
  }

  if (pharmacyStalled) {
    const nowIso = new Date().toISOString();
    if ((stuckMeds?.length ?? 0) > 0) {
      const ids = (stuckMeds ?? []).map((r: any) => r.id);
      await supabase
        .from("medication_orders")
        .update({
          status: "Administered",
          administered_at: nowIso,
        } as any)
        .in("id", ids);
      actions.push(
        `Cleared ${ids.length} stuck pharmacy order(s) (Ordered/Pending Verification/Dispensed > ${STUCK_ORDER_MS / 60_000} min) by force-advancing to Administered.`,
      );
    } else {
      actions.push(
        `Pharmacy queue idle for ${QUEUE_IDLE_MS / 60_000} min — kicked admission randomizer to refill the queue.`,
      );
      try {
        await supabase.rpc("auto_admit_ghost_patient");
      } catch {}
    }
    healed.push("Pharmacy Queue");
  }

  if (labStalled) {
    const nowIso = new Date().toISOString();
    if ((stuckLabs?.length ?? 0) > 0) {
      const ids = (stuckLabs ?? []).map((r: any) => r.id);
      await supabase
        .from("lab_orders")
        .update({
          status: "Reported",
          resulted_at: nowIso,
        } as any)
        .in("id", ids);
      actions.push(
        `Cleared ${ids.length} stuck lab order(s) (Ordered/Processing > ${STUCK_ORDER_MS / 60_000} min) by force-advancing to Reported.`,
      );
    } else {
      actions.push(
        `Lab queue idle for ${QUEUE_IDLE_MS / 60_000} min — kicked admission randomizer to generate fresh orders.`,
      );
      try {
        await supabase.rpc("auto_admit_ghost_patient");
      } catch {}
    }
    healed.push("Lab Queue");
  }

  const issuesDetected = healed.length > 0;
  await supabase.from("automation_watchdog_logs").insert({
    global_control_status: automationOn ? "ON" : "OFF",
    engines_checked: enginesChecked,
    issues_detected: issuesDetected,
    actions_taken: issuesDetected
      ? actions.join(" • ")
      : automationOn
        ? "All systems operating within normal parameters."
        : "Global automation OFF — passive heartbeat only, no auto-heal performed.",
    healed_engines: healed,
  } as any);
}

// Singleton guard — only one tab should drive the watchdog so we don't
// spam duplicate heartbeats. Tabs use a randomized leader election via
// a shared localStorage key with a short heartbeat lease.
const LEADER_KEY = "spehr.watchdog.leader";
const LEADER_LEASE_MS = 90_000;
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

export function useAutomationWatchdog() {
  const ran = useRef(false);
  // Always run regardless of switch state so we still log heartbeats
  // when automation is paused — operators want to see that the watchdog
  // itself is alive even when engines are off.
  void useAutomationEnabled();

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    const tick = () => {
      if (!tryAcquireLeader()) return;
      runWatchdogCycle().catch((e) =>
        console.warn("[watchdog] cycle failed", e),
      );
    };
    // Stagger the first tick by 8s so other boot-time queries settle.
    const boot = setTimeout(tick, 8_000);
    const id = setInterval(tick, WATCHDOG_INTERVAL_MS);
    return () => {
      clearTimeout(boot);
      clearInterval(id);
    };
  }, []);
}

// Live subscription helper for UI widgets — exposes the latest log row.
export interface WatchdogLogRow {
  id: string;
  checker_timestamp: string;
  global_control_status: string;
  issues_detected: boolean;
  actions_taken: string;
  healed_engines: string[];
}

export function useLatestWatchdogLog(): WatchdogLogRow | null {
  const [row, setRow] = useState<WatchdogLogRow | null>(null);
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const { data } = await fetchWithTimeout(
        () =>
          supabase
            .from("automation_watchdog_logs")
            .select("id, checker_timestamp, global_control_status, issues_detected, actions_taken, healed_engines")
            .order("checker_timestamp", { ascending: false })
            .limit(1),
        { data: [], error: null } as any,
      );
      if (!cancelled && data && data[0]) setRow(data[0] as any);
    };
    load();
    const ch = supabase
      .channel("watchdog-latest")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "automation_watchdog_logs" },
        (payload) => setRow(payload.new as any),
      )
      .subscribe();
    const poll = setInterval(load, 15_000);
    return () => {
      cancelled = true;
      supabase.removeChannel(ch);
      clearInterval(poll);
    };
  }, []);
  return row;
}