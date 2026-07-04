/**
 * Client-side Safety Alerts watcher.
 *
 * Wires two trigger sources into the runtime safety-alerts engine:
 *   • realtime INSERT on `medication_orders`   → Rules 1 & 2
 *   • window `nlp:approved` event              → Rules 3 & 4
 *
 * Mounted once from `src/routes/__root.tsx`.
 */

import { useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import {
  ensureValueSetsLoaded,
  runMedicationOrderRules,
  runNlpApprovalRules,
} from "@/lib/safety-alerts-engine";

export function useSafetyAlertsWatcher() {
  useEffect(() => {
    let cancelled = false;
    void ensureValueSetsLoaded().catch(() => {});

    const channel = supabase
      .channel("safety-alerts-watcher")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "medication_orders" },
        (payload) => {
          if (cancelled) return;
          const rec: any = payload?.new ?? {};
          void runMedicationOrderRules({
            mrn: rec.patient_mrn,
            rxnorm_code: rec.rxnorm_code,
            rxnorm_display: rec.rxnorm_display,
            medication_name: rec.medication_name,
            drug_name: rec.drug_name,
          }).catch((e) => console.warn("[safety-alerts] med rule failed", e));
        },
      )
      .subscribe();

    const onApproved = async (e: Event) => {
      const mrn = (e as CustomEvent).detail?.mrn;
      if (!mrn) return;
      try {
        const { data } = await supabase
          .from("nlp_audit_logs")
          .select("patient_mrn, standardized_output, status")
          .eq("patient_mrn", mrn)
          .eq("status", "approved")
          .order("updated_at", { ascending: false })
          .limit(5);
        for (const row of (data ?? []) as any[]) {
          await runNlpApprovalRules(row);
        }
      } catch (err) {
        console.warn("[safety-alerts] nlp rule failed", err);
      }
    };
    window.addEventListener("nlp:approved", onApproved as EventListener);

    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
      window.removeEventListener("nlp:approved", onApproved as EventListener);
    };
  }, []);
}