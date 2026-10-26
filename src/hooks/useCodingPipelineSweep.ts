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
const LEADER_LEASE_MS = 3 * 60_000;
const TICK_MS = 30_000;
const MAX_PER_TICK = 5;
const TAB_ID = Math.random().toString(36).slice(2);

/* ------------------------------------------------------------------ */
/*  Atomic DB-backed lease (replaces the old localStorage              */
/*  tryAcquireLeader() read-then-write race — see                      */
/*  docs/leader-election-fix-design.md).                               */
/*                                                                      */
/*  *** PAIRED CHANGE ***                                               */
/*  These RPCs (claim_automation_lease / heartbeat_automation_lease)    */
/*  are defined in supabase/migrations/20260918000000_automation_leases */
/*  .sql, which is NOT yet applied to any Supabase project — it is a    */
/*  reviewable migration file only. This code path must not be deployed */
/*  ahead of that migration being applied to the target project: until  */
/*  then the RPCs don't exist, every claim/heartbeat call errors, and   */
/*  claimLease() below fails safe by returning false (tick() no-ops,    */
/*  same as "another tab is leader" today) — so it degrades safely but  */
/*  the sweep simply never runs. Apply the migration first.             */
/*                                                                      */
/*  Note: the DB function clamps `_min_interval_ms` to a floor of       */
/*  60_000ms server-side, so the effective cycle cadence becomes ~60s   */
/*  post-fix instead of TICK_MS's 30s — acceptable for a background     */
/*  sweep that isn't latency-critical.                                  */
/*                                                                      */
/*  TAB_ID is reused below as the lease `holder` identifier.            */
/* ------------------------------------------------------------------ */

/**
 * Atomically claim the coding_pipeline_sweep lease via a single UPDATE ...
 * WHERE ... RETURNING call in Postgres (claim_automation_lease). Zero rows
 * returned means another tab currently holds the lease or the cadence
 * interval hasn't elapsed — this cycle should be skipped. One row means
 * this tab now owns the cycle and `last_run_at` has already been advanced
 * atomically (same "heartbeat first, never drift" guarantee as before).
 */
export async function claimLease(): Promise<boolean> {
  try {
    const { data, error } = await supabase.rpc(
      "claim_automation_lease" as any,
      {
        _engine: "coding_pipeline_sweep",
        _holder: TAB_ID,
        _lease_ms: LEADER_LEASE_MS,
        _min_interval_ms: TICK_MS,
      } as any,
    );
    if (error) {
      console.warn("[coding-sweep] claim_automation_lease failed", error);
      return false;
    }
    return Array.isArray(data) && data.length > 0;
  } catch (e) {
    console.warn("[coding-sweep] claim_automation_lease threw", e);
    return false;
  }
}

/**
 * Best-effort mid-cycle lease renewal (heartbeat_automation_lease) so a
 * long-running cycle can't have its lease stolen by another tab before it
 * finishes. Never throws — a failed renewal just means the lease may lapse
 * and another tab could pick up the *next* cycle, which is an acceptable
 * degradation, not a correctness bug.
 */
export async function heartbeatLease(): Promise<void> {
  try {
    const { error } = await supabase.rpc(
      "heartbeat_automation_lease" as any,
      {
        _engine: "coding_pipeline_sweep",
        _holder: TAB_ID,
        _lease_ms: LEADER_LEASE_MS,
      } as any,
    );
    if (error) console.warn("[coding-sweep] heartbeat_automation_lease failed", error);
  } catch (e) {
    console.warn("[coding-sweep] heartbeat_automation_lease threw", e);
  }
}

/**
 * Best-effort release on unmount, purely as an optimisation (per the design
 * doc) — never awaited, never lets cleanup depend on it succeeding. Reuses
 * heartbeat_automation_lease with a negative lease so `leased_until` moves
 * into the past, making the row immediately claimable by the next tab
 * rather than making that tab wait out the full TTL.
 */
export function releaseLeaseBestEffort(): void {
  try {
    // supabase-js query/rpc builders are thenables — the HTTP request is
    // only actually sent once `.then()` (or `.catch()`) is called on them.
    // A bare `void supabase.rpc(...)` never fires the request at all. Chain
    // a no-op `.then()` so it executes, without awaiting it here — React
    // cleanup functions can't be async and this must stay fire-and-forget.
    supabase
      .rpc(
        "heartbeat_automation_lease" as any,
        {
          _engine: "coding_pipeline_sweep",
          _holder: TAB_ID,
          _lease_ms: -1000,
        } as any,
      )
      .then(
        () => {},
        () => {},
      );
  } catch {
    /* best-effort only — cleanup must not depend on this */
  }
}

export function useCodingPipelineSweep() {
  const busy = useRef(false);
  useEffect(() => {
    let stopped = false;

    const tick = async () => {
      if (stopped || busy.current) return;
      const enabled = await getAutomationEnabled();
      if (!enabled) return;
      // last_run_at was already advanced atomically inside the claim RPC
      // (same "advance before running" anti-drift guarantee as the old
      // localStorage cadence check, but race-free).
      const claimed = await claimLease();
      if (!claimed) return;
      busy.current = true;
      // Mid-cycle lease renewal — up to MAX_PER_TICK patients each run
      // through the six-stream pipeline (UMLS/crosswalk/Gemini network
      // calls), which can add up past LEADER_LEASE_MS. Renew on a fixed
      // ~30s cadence for the entire lifetime of this cycle, independent of
      // what the cycle is doing, and clear it in `finally` below on every
      // exit path (success, error, or early return) so it can never leak.
      const heartbeatIntervalId = setInterval(() => {
        void heartbeatLease();
      }, 30_000);
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
        clearInterval(heartbeatIntervalId);
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
      // Best-effort lease release — purely an optimisation so another tab
      // doesn't have to wait out the full TTL. Never blocks unmount.
      releaseLeaseBestEffort();
    };
  }, []);
}
