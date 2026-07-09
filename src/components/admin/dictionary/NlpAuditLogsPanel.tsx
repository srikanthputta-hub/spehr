import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sparkles, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { runSixStreamPipeline, approveMrnCoding } from "@/lib/coding-pipeline";
import { AuditCard, type AuditRow } from "./AuditCard";
import { InfoHint } from "@/components/ui/info-hint";
import { admissionMapsEqual, auditRowsEqual, sortAuditRows } from "./auditRows";

let cachedAuditRows: AuditRow[] = [];
let cachedAdmissionMap: Record<string, string> = {};

type AuditQueryResult = { data: any[] | null; error?: unknown; timedOut?: boolean };

export default function NlpAuditLogsPanel() {
  const [rows, setRows] = useState<AuditRow[]>(cachedAuditRows);
  const [admissionMap, setAdmissionMap] = useState<Record<string, string>>(cachedAdmissionMap);
  const [loading, setLoading] = useState(cachedAuditRows.length === 0);
  const [busy, setBusy] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const initialLoadRef = useRef(cachedAuditRows.length === 0);
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
        .order("id", { ascending: false })
        .limit(150);
      const timeout = new Promise<AuditQueryResult>((resolve) =>
        setTimeout(() => resolve({ data: null, timedOut: true }), 10_000),
      );
      const result = (await Promise.race([query, timeout])) as AuditQueryResult;
      if (result.timedOut) return;
      if (result.error) throw result.error;

      const list = sortAuditRows((result.data ?? []) as AuditRow[], "created_at");
      setRows((prev) => {
        if (auditRowsEqual(prev, list)) return prev;
        cachedAuditRows = list;
        return list;
      });
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
        setAdmissionMap((prev) => {
          if (admissionMapsEqual(prev, map)) return prev;
          cachedAdmissionMap = map;
          return map;
        });
      } else {
        setAdmissionMap((prev) => {
          if (admissionMapsEqual(prev, {})) return prev;
          cachedAdmissionMap = {};
          return {};
        });
      }
    } catch {
      // Keep the current list in place on transient errors/timeouts to avoid flicker.
    } finally {
      setLoading(false);
      initialLoadRef.current = false;
    }
  };

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) =>
      (r.patient_mrn ?? "").toLowerCase().includes(q) ||
      (r.raw_text ?? "").toLowerCase().includes(q),
    );
  }, [rows, query]);

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
    return () => {
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    };
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
      setRows((prev) => {
        const next = prev.filter((x) => x.patient_mrn !== r.patient_mrn);
        if (auditRowsEqual(prev, next)) return prev;
        cachedAuditRows = next;
        return next;
      });
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
            <InfoHint
              className="ml-1.5"
              text="Every new admission fans out through 6 parallel NLP streams — Chief Complaint & HPI, Past Medical History, Medications, Allergies, Vitals, and Labs — each extracted and standardized against its matching vocabulary (SNOMED CT, RxNorm, or LOINC) through a three-stage pipeline (raw entry → extraction mapping → standardized output). A pending card auto-approves after a 3-minute grace window if no one reviews it first."
            />
          </h2>
        </div>
        <Button variant="outline" size="sm" onClick={refresh}>
          <RefreshCw className="h-4 w-4" /> Refresh
        </Button>
      </div>

      <Input
        placeholder="Filter by MRN or text…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        className="max-w-md h-8 text-xs"
      />

      {loading ? (
        <div className="rounded-xl border border-slate-200 bg-white p-6 text-sm text-slate-500">Loading…</div>
      ) : filtered.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 p-8 text-center text-sm text-slate-500">
          {rows.length === 0 ? "No pending items. Admit a patient (or click Refresh) to populate this log." : "No matches for your search."}
        </div>
      ) : (
        <div className="scroll-feed space-y-3">
          {filtered.map((r) => (
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