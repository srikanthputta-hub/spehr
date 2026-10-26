import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Sparkles, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AuditCard, type AuditRow } from "./AuditCard";
import { InfoHint } from "@/components/ui/info-hint";
import { auditRowsEqual, sortAuditRows } from "./auditRows";

let cachedApprovalRows: AuditRow[] = [];

type AuditQueryResult = { data: any[] | null; error?: unknown; timedOut?: boolean };

export default function NlpApprovalTrail() {
  const [rows, setRows] = useState<AuditRow[]>(cachedApprovalRows);
  const [loading, setLoading] = useState(cachedApprovalRows.length === 0);
  const [query, setQuery] = useState("");
  const initialLoadRef = useRef(cachedApprovalRows.length === 0);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(
      (r) =>
        (r.patient_mrn ?? "").toLowerCase().includes(q) ||
        (r.raw_text ?? "").toLowerCase().includes(q),
    );
  }, [rows, query]);

  const refresh = async () => {
    if (initialLoadRef.current) setLoading(true);
    try {
      const query = supabase
        .from("nlp_audit_logs" as any)
        .select(
          "id, patient_mrn, raw_text, extraction_mapping, standardized_output, confidence_score, status, created_at, updated_at, approved_by",
        )
        .eq("status", "approved")
        .order("updated_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(150);
      const timeout = new Promise<AuditQueryResult>((resolve) =>
        setTimeout(() => resolve({ data: null, timedOut: true }), 10_000),
      );
      const result = (await Promise.race([query, timeout])) as AuditQueryResult;
      if (result.timedOut) return;
      if (result.error) throw result.error;

      const fetched = sortAuditRows((result.data ?? []) as AuditRow[], "updated_at");
      setRows((prev) => {
        if (auditRowsEqual(prev, fetched)) return prev;
        cachedApprovalRows = fetched;
        return fetched;
      });
    } catch {
      // Leave existing rows in place on transient error — no flicker.
    } finally {
      setLoading(false);
      initialLoadRef.current = false;
    }
  };

  useEffect(() => {
    refresh();
    const onApproved = () => refresh();
    window.addEventListener("nlp:approved", onApproved);
    const poll = setInterval(refresh, 20_000);
    return () => {
      window.removeEventListener("nlp:approved", onApproved);
      clearInterval(poll);
    };
  }, []);

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-slate-900 flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-indigo-600" /> NLP Approval Trail
            <span className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-slate-700">
              Last 150 · Approved
            </span>
            <InfoHint
              className="ml-1.5"
              text="The 50 most recently approved audit rows across the 6-stream pipeline. Human approvals are tagged green; AI auto-approvals (after the 3-minute grace window elapses untouched) are tagged blue."
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
        <div className="rounded-xl border border-slate-200 bg-white p-6 text-sm text-slate-500">
          Loading…
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 p-8 text-center text-sm text-slate-500">
          {rows.length === 0
            ? "No approvals yet. Approve an audit card to populate this trail."
            : "No matches for your search."}
        </div>
      ) : (
        <div className="scroll-feed space-y-3">
          {filtered.map((r) => (
            <AuditCard key={r.id} row={r} readOnly />
          ))}
        </div>
      )}
    </div>
  );
}
