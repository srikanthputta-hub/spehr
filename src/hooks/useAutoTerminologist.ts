import { useEffect, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import {
  claimLease as sharedClaimLease,
  heartbeatLease as sharedHeartbeatLease,
  releaseLeaseBestEffort as sharedReleaseLeaseBestEffort,
  runAutoTerminologistCycle,
  codeShapeMatches,
} from "@/lib/auto-terminologist-cycle";

/**
 * Auto Terminologist — client-side trigger.
 * --------------------------------------------------------------
 * The actual cycle logic (demand-queue processing, VSAC publication
 * polling, Drug-Allergy pair auto-linking, the proactive sweep, and
 * value-set staleness flagging) lives in
 * `supabase/functions/_shared/auto-terminologist-cycle.ts` (re-exported
 * via `src/lib/auto-terminologist-cycle.ts`) — see that file for the full
 * design notes. This hook now only does three things:
 *   1. Ticks every TICK_MS and tries to claim the DB-backed
 *      `auto_terminologist` lease (`claimLease`), gated on the real
 *      10-minute cadence recorded in `automation_leases.last_run_at`.
 *   2. Runs the shared cycle when it wins the claim.
 *   3. Releases the lease (best-effort) on unmount.
 *
 * *** This is a convenience path only, not the reliability fix. ***
 * The cycle used to run ONLY from this hook, which meant it went silent
 * for ~28.7h (confirmed via `auto_terminologist_log`'s heartbeat gap,
 * 2026-11-16 14:28 -> 2026-11-17 19:11) whenever nobody had a browser tab
 * open — the "Loop active · 10 min cadence" badge was misleading. The
 * real fix is the `auto-terminologist-cycle` edge function, scheduled via
 * `pg_cron` every 10 minutes independent of any open tab; this hook and
 * that edge function race for the SAME lease (keyed by a different
 * `holder` id each) so they can never double-run a cycle, and either one
 * running satisfies the cadence.
 */

const TICK_MS = 60_000;
const TAB_ID = Math.random().toString(36).slice(2);

export { codeShapeMatches };

export async function claimLease(): Promise<boolean> {
  return sharedClaimLease(supabase, TAB_ID);
}

export async function heartbeatLease(): Promise<void> {
  return sharedHeartbeatLease(supabase, TAB_ID);
}

export function releaseLeaseBestEffort(): void {
  sharedReleaseLeaseBestEffort(supabase, TAB_ID);
}

export function useAutoTerminologist() {
  const ran = useRef(false);
  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    const tick = async () => {
      // Single atomic claim — zero rows / false means another tab (or the
      // cron-triggered edge function) holds the lease or the interval
      // hasn't elapsed — skip this cycle.
      const claimed = await claimLease();
      if (!claimed) return;
      // last_run_at was already advanced atomically inside the claim RPC.
      // This log insert is just the audit-trail row, not gating logic.
      await supabase
        .from("auto_terminologist_log" as any)
        .insert({
          message: `${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} — Cycle started (tab).`,
          action: "heartbeat",
        } as any)
        .then(
          () => {},
          () => {},
        );
      runAutoTerminologistCycle(supabase, TAB_ID).catch((e) =>
        console.warn("[auto-term] cycle failed", e),
      );
    };
    // Stagger first run by 25s so it doesn't race other boot tasks.
    const boot = setTimeout(tick, 25_000);
    const id = setInterval(tick, TICK_MS);
    return () => {
      clearTimeout(boot);
      clearInterval(id);
      // Best-effort lease release — purely an optimisation so another
      // caller doesn't have to wait out the full TTL. Never blocks unmount.
      releaseLeaseBestEffort();
    };
  }, []);
}
