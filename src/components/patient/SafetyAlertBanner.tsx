import { useEffect, useState } from "react";
import { AlertOctagon } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";

type SafetyAlert = {
  id: string;
  kind: string;
  drug: string | null;
  drug_b: string | null;
  allergy_name: string | null;
  family: string | null;
  severity: string | null;
  status: string;
  created_at: string;
};

export default function SafetyAlertBanner({ mrn }: { mrn: string }) {
  const [alert, setAlert] = useState<SafetyAlert | null>(null);

  useEffect(() => {
    if (!mrn) return;
    let cancelled = false;
    const load = async () => {
      const { data } = await supabase
        .from("clinical_safety_alerts")
        .select("id, kind, drug, drug_b, allergy_name, family, severity, status, created_at")
        .eq("mrn", mrn)
        .eq("status", "Pending Review")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (!cancelled) setAlert(data as SafetyAlert | null);
    };
    load();
    const channel = supabase
      .channel(`safety-alert-banner-${mrn}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "clinical_safety_alerts", filter: `mrn=eq.${mrn}` },
        () => load(),
      )
      .subscribe();
    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
    };
  }, [mrn]);

  if (!alert) return null;

  const title =
    alert.kind === "Drug-Allergy"
      ? `Drug-Allergy Conflict — ${alert.drug ?? "Medication"} vs. ${alert.allergy_name ?? "known allergy"}`
      : alert.kind === "Drug-Drug"
        ? `Drug-Drug Interaction — ${alert.drug ?? ""} + ${alert.drug_b ?? ""}`
        : `Clinical Safety Alert — ${alert.kind}`;

  return (
    <div className="mx-3 mt-2 flex items-start gap-2 rounded border border-red-400 bg-red-50 px-3 py-2.5 text-[12.5px] text-red-900 shadow-sm">
      <AlertOctagon className="mt-0.5 h-4 w-4 flex-none text-red-600 animate-pulse" />
      <div className="flex-1">
        <span className="font-bold uppercase tracking-wide text-red-700 text-[10px]">
          ⚠ Active Safety Alert{alert.severity ? ` · ${alert.severity.toUpperCase()} SEVERITY` : ""}
        </span>
        <div className="font-semibold mt-0.5">{title}</div>
        {alert.family && (
          <div className="text-red-800/80 text-[11.5px] mt-0.5">{alert.family}</div>
        )}
        <div className="text-[10px] text-red-700/70 mt-1">
          Pending clinical review — see Medical Dictionary → Safety Alerts to override or reject.
        </div>
      </div>
    </div>
  );
}