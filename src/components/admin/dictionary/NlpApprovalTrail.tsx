import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Sparkles } from "lucide-react";
import { AuditCard, type AuditRow } from "./AuditCard";

export default function NlpApprovalTrail() {
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = async () => {
    const { data } = await supabase
      .from("nlp_audit_logs" as any)
      .select("id, patient_mrn, raw_text, extraction_mapping, standardized_output, confidence_score, status, created_at, updated_at, approved_by")
      .eq("status", "approved")
      .order("updated_at", { ascending: false })
      .limit(50);
    setRows((data ?? []) as any[]);
    setLoading(false);
  };

  useEffect(() => {
    refresh();
    const ch = supabase
      .channel("nlp-approval-trail")
      .on("postgres_changes", { event: "*", schema: "public", table: "nlp_audit_logs" }, () => refresh())
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, []);

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-slate-900 flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-indigo-600" /> NLP Approval Trail
          <span className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-slate-700">
            Last 50 · Approved
          </span>
        </h2>
        <p className="text-sm text-slate-600 mt-1 max-w-3xl">
          Recently approved audit rows across the 6-Stream Pipeline. Human approvals are
          tagged green; AI auto-approvals (after the 2-minute grace window) are tagged blue.
        </p>
      </div>

      {loading ? (
        <div className="rounded-xl border border-slate-200 bg-white p-6 text-sm text-slate-500">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 p-8 text-center text-sm text-slate-500">
          No approvals yet. Approve an audit card to populate this trail.
        </div>
      ) : (
        <div className="space-y-3">
          {rows.map((r) => (
            <AuditCard key={r.id} row={r} readOnly />
          ))}
        </div>
      )}
    </div>
  );
}