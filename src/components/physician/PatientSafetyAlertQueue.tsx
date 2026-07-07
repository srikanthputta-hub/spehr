import { useEffect, useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, Check, ShieldAlert, X } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { SlaCountdown } from "@/components/patient/SlaCountdown";
import {
  SAFETY_AUTO_REJECT_THRESHOLD,
  buildSafetyRationale,
  resolveAlertSideEffects,
  type DbSafetyAlert,
} from "@/lib/safety-alert-resolution";

/**
 * Per-patient inline safety-alert queue for the Physician Dashboard.
 * Renders nothing when there are no pending alerts for the given MRN
 * (matching the visibility rule of System Admin → SafetyQueue).
 */
export function PatientSafetyAlertQueue({
  mrn,
  physicianName,
}: {
  mrn: string;
  physicianName: string;
}) {
  const [items, setItems] = useState<DbSafetyAlert[]>([]);
  const [nowTs, setNowTs] = useState<number>(Date.now());
  const actorName = physicianName?.trim() ? physicianName.trim() : "Human Clinician";

  // 1s ticker drives the live countdown UI.
  useEffect(() => {
    const id = setInterval(() => setNowTs(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const refresh = async () => {
    const { data, error } = await supabase
      .from("clinical_safety_alerts")
      .select("*")
      .eq("mrn", mrn)
      .eq("status", "Pending Review")
      .order("created_at", { ascending: false });
    if (error) return;
    setItems((data ?? []) as DbSafetyAlert[]);
  };

  useEffect(() => {
    if (!mrn) {
      setItems([]);
      return;
    }
    refresh();
    const channel = supabase
      .channel(`patient-safety-alerts-${mrn}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "clinical_safety_alerts",
          filter: `mrn=eq.${mrn}`,
        },
        () => refresh(),
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mrn]);

  const act = async (c: DbSafetyAlert, status: "Overridden" | "Rejected") => {
    const score = c.risk_score ?? 50;
    const defaultRationale =
      `Risk score ${score}/100 (auto-decision threshold: >= ${SAFETY_AUTO_REJECT_THRESHOLD} = Reject, < ${SAFETY_AUTO_REJECT_THRESHOLD} = Override) — manually set to ${status} by ${actorName}. ` +
      buildSafetyRationale(c, status, "Pharmacist");
    const rationale =
      status === "Overridden"
        ? window.prompt("Override this alert — clinical rationale:", defaultRationale)
        : defaultRationale;
    if (rationale === null) return;
    const { data: updated, error } = await supabase
      .from("clinical_safety_alerts")
      .update({
        status,
        decided_by: actorName,
        decided_at: new Date().toISOString(),
        rationale,
        resolved_by: actorName,
        resolution_rationale: rationale,
      })
      .eq("id", c.id)
      .eq("status", "Pending Review")
      .select("id");
    if (error) {
      toast.error("Update failed", { description: error.message });
      return;
    }
    if (!updated || updated.length === 0) {
      toast.info("Alert already resolved");
      refresh();
      return;
    }
    await resolveAlertSideEffects(c, status, actorName, rationale);
    toast.success(`Alert ${status.toLowerCase()}`);
    refresh();
  };

  if (items.length === 0) return null;

  return (
    <div className="rounded-lg border-2 border-red-300 bg-white shadow-sm">
      <div className="flex items-center gap-2 border-b border-red-200 bg-red-50/60 px-5 py-3">
        <ShieldAlert className="h-4 w-4 text-red-600" />
        <h2 className="text-sm font-semibold text-red-800">
          ⚠ Safety Alert — Action Required
        </h2>
        <span className="ml-auto text-[10px] uppercase tracking-[0.18em] text-red-600">
          {items.length} pending · resolve or SLA auto-decides
        </span>
      </div>
      <div className="space-y-2 p-4">
        {items.map((c) => {
          const score = c.risk_score ?? 50;
          const willReject = score >= SAFETY_AUTO_REJECT_THRESHOLD;
          const scoreTone = willReject
            ? "border-red-300 bg-red-50 text-red-700"
            : "border-emerald-300 bg-emerald-50 text-emerald-700";
          return (
            <div
              key={c.id}
              className="rounded-xl border border-red-300 bg-white p-4"
            >
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="inline-flex items-center gap-1 rounded border border-red-200 bg-red-50 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-red-700">
                      <AlertTriangle className="h-3 w-3" /> Auto-commit halted
                    </span>
                    <span
                      className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider ${
                        c.kind === "Drug-Drug"
                          ? "border-purple-200 bg-purple-50 text-purple-700"
                          : "border-amber-200 bg-amber-50 text-amber-700"
                      }`}
                    >
                      {c.kind === "Drug-Drug"
                        ? `DDI · ${c.severity ?? "Major"}`
                        : "Drug-Allergy"}
                    </span>
                  </div>
                  <div className="mt-1.5 text-sm text-slate-800">
                    {c.kind === "Drug-Drug" ? (
                      <>
                        Co-prescribed{" "}
                        <span className="font-semibold">{c.drug}</span> +{" "}
                        <span className="font-semibold">{c.drug_b}</span> —{" "}
                        <span className="font-mono text-[11px]">{c.family}</span>.
                      </>
                    ) : (
                      <>
                        Ordered{" "}
                        <span className="font-semibold">{c.drug}</span> conflicts
                        with documented allergy to{" "}
                        <span className="font-semibold">{c.allergy_name}</span> —
                        cross-reactivity family:{" "}
                        <span className="font-mono text-[11px]">{c.family}</span>.
                      </>
                    )}
                  </div>
                </div>
                <div className="flex flex-col items-end gap-1.5 shrink-0">
                  <span
                    className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider ${scoreTone}`}
                    title={`Auto-decision band: score ≥ ${SAFETY_AUTO_REJECT_THRESHOLD} = Reject, < ${SAFETY_AUTO_REJECT_THRESHOLD} = Override`}
                  >
                    Risk {score}/100 — will auto-{willReject ? "reject" : "override"} if unactioned
                  </span>
                  <SlaCountdown
                    autoResolveAt={c.auto_resolve_at}
                    createdAt={c.created_at}
                    nowTs={nowTs}
                  />
                  <div className="flex items-center gap-1.5">
                    <Button
                      size="sm"
                      className="h-7 bg-amber-600 hover:bg-amber-700"
                      onClick={() => act(c, "Overridden")}
                    >
                      <Check className="h-3 w-3" /> Override
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-red-600 border-red-200 hover:bg-red-50"
                      onClick={() => act(c, "Rejected")}
                    >
                      <X className="h-3 w-3" /> Reject
                    </Button>
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}