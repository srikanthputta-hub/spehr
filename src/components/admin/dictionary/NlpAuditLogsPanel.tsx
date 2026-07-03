import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Sparkles, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { runSixStreamPipeline, approveMrnCoding } from "@/lib/coding-pipeline";
import { AuditCard, type AuditRow } from "./AuditCard";

export default function NlpAuditLogsPanel() {
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = async () => {
    setLoading(true);
    const { data } = await supabase
      .from("nlp_audit_logs" as any)
      .select("id, patient_mrn, raw_text, extraction_mapping, standardized_output, confidence_score, status, created_at, updated_at, approved_by")
      .neq("status", "approved")
      .order("created_at", { ascending: false })
      .limit(25);
    setRows((data ?? []) as any[]);
    setLoading(false);
  };

  useEffect(() => {
    refresh();
    const ch = supabase
      .channel("nlp-audit-logs-panel")
      .on("postgres_changes", { event: "*", schema: "public", table: "nlp_audit_logs" }, () => refresh())
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, []);

  const handleApprove = async (r: AuditRow, approvedBy: "human" | "ai") => {
    setBusy(r.id);
    try {
      await approveMrnCoding(r.patient_mrn, approvedBy);
      if (approvedBy === "ai") {
        toast.success("Auto-approved by AI");
      } else {
        toast.success("Approved — codes published to Live Terminology Matrix");
      }
      refresh();
    } catch (e: any) {
      toast.error("Approve failed", { description: e?.message });
    } finally {
      setBusy(null);
    }
  };

  const handleRecode = async (r: AuditRow) => {
    setBusy(r.id);
    try {
      const result = await runSixStreamPipeline(r.patient_mrn);
      if (result) toast.success("Re-coded successfully");
      else toast.warning("Re-code skipped (already running or no data).");
      refresh();
    } catch (e: any) {
      toast.error("Re-code failed", { description: e?.message });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-slate-900 flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-indigo-600" /> NLP Coding Audit Trail
            <span className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-emerald-700">
              6-Stream Pipeline · Live
            </span>
          </h2>
          <p className="text-sm text-slate-600 mt-1 max-w-3xl">
            Every admission fans out through 6 terminology streams (CC + HPI, PMH, Meds,
            Allergies, Vitals, Labs). Pending cards auto-approve after 2 minutes if a
            human doesn't act first.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={refresh}>
          <RefreshCw className="h-4 w-4" /> Refresh
        </Button>
      </div>

      {loading ? (
        <div className="rounded-xl border border-slate-200 bg-white p-6 text-sm text-slate-500">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 p-8 text-center text-sm text-slate-500">
          No pipeline runs yet. Admit a patient (or wait for the background sweep) to populate this log.
        </div>
      ) : (
        <div className="space-y-3">
          {rows.map((r) => (
            <AuditCard
              key={r.id}
              row={r}
              onApprove={handleApprove}
              onRecode={handleRecode}
              busy={busy === r.id}
              autoApprove
              onAutoApprove={(row) => handleApprove(row, "ai")}
            />
          ))}
        </div>
      )}
    </div>
  );
}