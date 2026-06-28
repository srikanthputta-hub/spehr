import { useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { fetchWithTimeout } from "@/lib/async-timeout";
import { useAutomationEnabled } from "@/hooks/useAutomationEnabled";

let grantsRecoveryStarted = false;
let seedCheckStarted = false;

export function useStartupRecovery() {
  const automationEnabled = useAutomationEnabled();

  useEffect(() => {
    if (grantsRecoveryStarted) return;
    grantsRecoveryStarted = true;

    (async () => {
      const settings = await fetchWithTimeout(
        () =>
          supabase
            .from("system_settings")
            .select("automation_enabled")
            .eq("id", 1)
            .maybeSingle(),
        { data: null, error: new Error("system_settings timeout") } as any,
      );

      if (!settings?.error) return;

      await supabase.functions
        .invoke("apply-grants", {
          body: { reason: "startup-system-settings-unreadable" },
        })
        .catch((error) => console.warn("[startup-recovery] grant repair failed", error));
    })();
  }, []);

  useEffect(() => {
    if (!automationEnabled || seedCheckStarted) return;
    seedCheckStarted = true;

    (async () => {
      const res = await fetchWithTimeout(
        () =>
          supabase
            .from("patients")
            .select("mrn", { count: "exact", head: true })
            .eq("status", "Admitted"),
        { count: null, error: new Error("patients timeout") } as any,
      );

      if (res?.error || res?.count !== 0) return;

      const { error } = await supabase.rpc("auto_admit_ghost_patient");
      if (error) console.warn("[startup-recovery] seed patient failed", error);
    })();
  }, [automationEnabled]);
}
