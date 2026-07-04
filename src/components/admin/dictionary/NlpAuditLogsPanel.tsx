import { useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Sparkles, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { runSixStreamPipeline, approveMrnCoding } from "@/lib/coding-pipeline";
import { AuditCard, type AuditRow } from "./AuditCard";

export default function NlpAuditLogsPanel() {
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [admissionMap, setAdmissionMap] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const initialLoadRef = useRef(true);
  const firedIdsRef = useRef<Set<string>>(new Set());
  const inFlightRef = useRef<Set<string>>(new Set());
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = async () => {
    if (initialLoadRef.current) setLoading(true);
    try {
      const query = supabase
        .from("nlp_audit_logs" as any)
        .select("id, patient_mrn, raw_text, extraction_mapping, standardized_output, confidence_score, status, created_at, updated_at, approved_by")
        .in("status", ["pending", "needs_review"])
        .order("created_at", { ascending: false })
        .limit(20);
      const timeout = new Promise<{ data: any[] }>((resolve) =>
        setTimeout(() => resolve({ data: [] }), 10_000),
      );
      const { data } = (await Promise.race([query, timeout])) as { data: any[] | null };
      const list = (data ?? []) as any[];
      setRows(list);
      const mrns = Array.from(new Set(list.map((r) => r.patient_mrn).filter(Boolean)));
      if (mrns.length) {
        const { data: pts } = await supabase
          .from("patients")
          .select("mrn, admission_time")
          .in("mrn", mrns);
        const map: Record<string, string> = {};
        for (const p of (pts ?? []) as any[]) {
          if (p?.mrn && p?.admission_time) map[p.mrn] = p.admission_time;
        }
        setAdmissionMap(map);
      } else {
        setAdmissionMap({});
      }
    } catch {
      setRows([]);
    } finally {
      setLoading(false);
      initialLoadRef.current = false;
    }
  };

  const scheduleRefresh = () => {
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    refreshTimerRef.current = setTimeout(() => {
      refreshTimerRef.current = null;
      refresh();
    }, 1200);
  };

  useEffect(() => {
    refresh();
    // Intentional: one-shot fetch on mount + manual Refresh button.
    // Realtime subscription removed to prevent re-render flicker.
  }, []);

  const handleApprove = async (r: AuditRow, approvedBy: "human" | "ai") => {
    // Dedup: don't approve the same row twice, even across remounts.
    if (inFlightRef.current.has(r.id) || firedIdsRef.current.has(r.id)) return;
    inFlightRef.current.add(r.id);
    firedIdsRef.current.add(r.id);
    if (approvedBy === "human") setBusy(r.id);
    try {
      await approveMrnCoding(r.patient_mrn, approvedBy);
      if (approvedBy === "human") {
        toast.success("Approved — codes published to Live Terminology Matrix");
      }
      // Optimistically remove from local list so auto-approve doesn't refire.
      setRows((prev) => prev.filter((x) => x.patient_mrn !== r.patient_mrn));
      // Notify the Approval Trail to refresh immediately.
      try { window.dispatchEvent(new CustomEvent("nlp:approved", { detail: { mrn: r.patient_mrn } })); } catch {}
      scheduleRefresh();
    } catch (e: any) {
      firedIdsRef.current.delete(r.id);
      if (approvedBy === "human") toast.error("Approve failed", { description: e?.message });
    } finally {
      inFlightRef.current.delete(r.id);
      if (approvedBy === "human") setBusy(null);
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
            Allergies, Vitals, Labs). Pending cards auto-approve after 3 minutes if a
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
          No pending items. Admit a patient (or click Refresh) to populate this log.
        </div>
      ) : (
        <div className="space-y-3">
          {rows.map((r) => (
            <AuditCard
              key={r.id}
              row={r}
              admissionAt={admissionMap[r.patient_mrn] ?? null}
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