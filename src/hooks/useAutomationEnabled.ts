import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

/**
 * Global System Automation flag (system_settings.automation_enabled).
 *
 * When ON  → all background AI engines run (ghost admissions, auto
 *            discharge, ghost labs, vitals simulation, med cascades).
 * When OFF → entire hospital network is in MANUAL mode. Clinicians
 *            drive admissions, lab ordering, pharmacy and discharge by
 *            hand. No simulated fluctuations, no auto seeding.
 *
 * The hook subscribes to realtime updates so flipping the master switch
 * in /system-admin instantly propagates across every open dashboard.
 */
let cached: boolean | null = null;
const listeners = new Set<(v: boolean) => void>();
let channelStarted = false;

async function fetchFlag(): Promise<boolean> {
  const { data } = await supabase
    .from("system_settings")
    .select("automation_enabled")
    .eq("id", 1)
    .maybeSingle();
  return Boolean((data as any)?.automation_enabled);
}

function broadcast(v: boolean) {
  cached = v;
  listeners.forEach((cb) => cb(v));
}

function ensureChannel() {
  if (channelStarted) return;
  channelStarted = true;
  supabase
    .channel("system-settings-automation")
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "system_settings" },
      (payload) => {
        const next = Boolean((payload.new as any)?.automation_enabled);
        broadcast(next);
      },
    )
    .subscribe();
}

export function useAutomationEnabled(): boolean {
  // Default to true so first paint doesn't disable engines for a flicker.
  const [enabled, setEnabled] = useState<boolean>(cached ?? true);

  useEffect(() => {
    let mounted = true;
    ensureChannel();
    if (cached === null) {
      fetchFlag()
        .then((v) => {
          if (!mounted) return;
          broadcast(v);
        })
        .catch(() => {});
    }
    const cb = (v: boolean) => {
      if (mounted) setEnabled(v);
    };
    listeners.add(cb);
    return () => {
      mounted = false;
      listeners.delete(cb);
    };
  }, []);

  return enabled;
}

/** One-shot read (no subscription) — useful inside event handlers. */
export async function getAutomationEnabled(): Promise<boolean> {
  if (cached !== null) return cached;
  const v = await fetchFlag();
  cached = v;
  return v;
}