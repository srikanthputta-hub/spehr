import { useEffect, useState, type ReactElement } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Sparkles, RefreshCw, CheckCircle2, PencilLine } from "lucide-react";
import { toast } from "sonner";
import { runSixStreamPipeline, approveMrnCoding } from "@/lib/coding-pipeline";

type AuditRow = {
  id: string;
  patient_mrn: string;
  raw_text: string | null;
  extraction_mapping: any;
  standardized_output: any;
  confidence_score: number | null;
  status: string | null;
  created_at: string;
};

const STREAM_META: Record<string, { title: string; blurb: string }> = {
  a: { title: "Stream A · Chief Complaint + HPI", blurb: "SNOMED CT · ICD-10 (via UMLS)" },
  b: { title: "Stream B · Past Medical History", blurb: "SNOMED CT · ICD-10 (direct map)" },
  c: { title: "Stream C · Medications",         blurb: "RxNorm (via RxNav)" },
  d: { title: "Stream D · Allergies",           blurb: "RxNorm + SNOMED reactions" },
  e: { title: "Stream E · Vitals",              blurb: "LOINC (static)" },
  f: { title: "Stream F · Lab Results",         blurb: "LOINC (pre-map + UMLS)" },
};

function StatusPill({ s }: { s: string | undefined }) {
  const cls =
    s === "coded" ? "bg-emerald-50 text-emerald-700 border-emerald-200" :
    s === "partial" ? "bg-amber-50 text-amber-700 border-amber-200" :
    s === "failed" ? "bg-red-50 text-red-700 border-red-200" :
    "bg-slate-50 text-slate-600 border-slate-200";
  const label = s === "coded" ? "coded" : s === "partial" ? "partial" : s === "failed" ? "failed" : "—";
  return <span className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider ${cls}`}>{label}</span>;
}

function CodePill({ system, code, display }: { system: string; code: string; display?: string | null }) {
  const chip: Record<string, string> = {
    "SNOMED":  "border-sky-200 bg-sky-50 text-sky-700",
    "ICD-10":  "border-violet-200 bg-violet-50 text-violet-700",
    "RxNorm":  "border-orange-200 bg-orange-50 text-orange-700",
    "LOINC":   "border-emerald-200 bg-emerald-50 text-emerald-700",
  };
  return (
    <span className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[10px] ${chip[system] ?? "border-slate-200 bg-slate-50 text-slate-700"}`}>
      <span className="font-bold">{system} {code}</span>
      {display ? <span className="text-slate-500">· {display}</span> : null}
    </span>
  );
}

function StreamCard({
  streamKey, meta, status, payload,
}: {
  streamKey: string;
  meta: { title: string; blurb: string };
  status?: string;
  payload: any;
}) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-xs font-semibold text-slate-900">{meta.title}</div>
          <div className="text-[10px] text-slate-500">{meta.blurb}</div>
        </div>
        <StatusPill s={status} />
      </div>
      <div className="mt-2 flex flex-wrap gap-1">
        {renderStreamPills(streamKey, payload)}
      </div>
    </div>
  );
}

function renderStreamPills(key: string, payload: any) {
  if (!payload) return <span className="text-[11px] text-slate-400">No coded items.</span>;
  const pills: ReactElement[] = [];
  if (key === "a") {
    const p = Array.isArray(payload) ? payload[0] : payload;
    if (p?.snomed_code) pills.push(<CodePill key="asn" system="SNOMED" code={p.snomed_code} display={p.snomed_display} />);
    if (p?.icd10_code) pills.push(<CodePill key="ai" system="ICD-10" code={p.icd10_code} display={p.icd10_display} />);
  } else if (key === "b") {
    const arr = Array.isArray(payload) ? payload : [];
    arr.forEach((p: any, i: number) => {
      if (p.snomed_code) pills.push(<CodePill key={`bs${i}`} system="SNOMED" code={p.snomed_code} display={p.snomed_display} />);
      if (p.icd10_code) pills.push(<CodePill key={`bi${i}`} system="ICD-10" code={p.icd10_code} display={p.icd10_display} />);
    });
  } else if (key === "c") {
    (Array.isArray(payload) ? payload : []).forEach((p: any, i: number) =>
      p.rxnorm_code && pills.push(<CodePill key={`c${i}`} system="RxNorm" code={p.rxnorm_code} display={p.rxnorm_display ?? p.name} />)
    );
  } else if (key === "d") {
    (Array.isArray(payload) ? payload : []).forEach((p: any, i: number) => {
      if (p.substance_rxcui) pills.push(<CodePill key={`dr${i}`} system="RxNorm" code={p.substance_rxcui} display={p.substance} />);
      if (p.substance_snomed) pills.push(<CodePill key={`ds${i}`} system="SNOMED" code={p.substance_snomed} display={p.substance} />);
      if (p.reaction_snomed) pills.push(<CodePill key={`drx${i}`} system="SNOMED" code={p.reaction_snomed} display="reaction" />);
    });
  } else if (key === "e") {
    const map = payload && typeof payload === "object" ? payload : {};
    Object.entries(map).forEach(([field, code]: any, i) =>
      pills.push(<CodePill key={`e${i}`} system="LOINC" code={String(code)} display={field} />)
    );
  } else if (key === "f") {
    (Array.isArray(payload) ? payload : []).forEach((p: any, i: number) =>
      p.loinc_code && pills.push(<CodePill key={`f${i}`} system="LOINC" code={p.loinc_code} display={p.loinc_display ?? p.test_name} />)
    );
  }
  return pills.length ? pills : <span className="text-[11px] text-slate-400">No coded items.</span>;
}

export default function NlpAuditLogsPanel() {
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = async () => {
    setLoading(true);
    const { data } = await supabase
      .from("nlp_audit_logs" as any)
      .select("id, patient_mrn, raw_text, extraction_mapping, standardized_output, confidence_score, status, created_at")
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

  const handleApprove = async (r: AuditRow) => {
    setBusy(r.id);
    try {
      await approveMrnCoding(r.patient_mrn);
      toast.success("Approved — codes published to Live Terminology Matrix");
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
            Allergies, Vitals, Labs). Approve to publish codes to the Live Terminology Matrix.
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
        <div className="space-y-4">
          {rows.map((r) => (
            <AuditCard key={r.id} row={r} onApprove={handleApprove} onRecode={handleRecode} busy={busy === r.id} />
          ))}
        </div>
      )}
    </div>
  );
}

function AuditCard({
  row, onApprove, onRecode, busy,
}: {
  row: AuditRow;
  onApprove: (r: AuditRow) => void;
  onRecode: (r: AuditRow) => void;
  busy: boolean;
}) {
  const std = row.standardized_output ?? {};
  const mapping = row.extraction_mapping?.streams ?? {};
  const conf = Math.round(((row.confidence_score ?? 0) as number) * 100);
  const approved = row.status === "approved";
  const created = new Date(row.created_at).toLocaleString();

  return (
    <div className="rounded-xl border border-slate-200 bg-white shadow-sm overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 bg-slate-50/70 border-b border-slate-100">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-slate-900">
            {row.patient_mrn}
            <span className="ml-2 text-[11px] font-normal text-slate-500">{created}</span>
          </div>
          <div className="text-[11px] text-slate-500 truncate max-w-xl">{row.raw_text ?? "—"}</div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className={`inline-flex items-center rounded border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${
            conf >= 80 ? "border-emerald-200 bg-emerald-50 text-emerald-700"
            : conf >= 50 ? "border-amber-200 bg-amber-50 text-amber-700"
            : "border-red-200 bg-red-50 text-red-700"
          }`}>
            Confidence · {conf}%
          </span>
          <span className={`inline-flex items-center rounded border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${
            approved ? "border-emerald-300 bg-emerald-100 text-emerald-800" : "border-amber-200 bg-amber-50 text-amber-700"
          }`}>
            {approved ? "Approved" : "Pending"}
          </span>
        </div>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 p-3">
        {(["a","b","c","d","e","f"] as const).map((k) => (
          <StreamCard
            key={k}
            streamKey={k}
            meta={STREAM_META[k]}
            status={mapping?.[k]?.status}
            payload={std?.[`stream_${k}`]}
          />
        ))}
      </div>
      <div className="flex items-center justify-end gap-2 px-4 py-3 bg-slate-50/40 border-t border-slate-100">
        <Button variant="outline" size="sm" disabled title="Inline edit coming soon">
          <PencilLine className="h-4 w-4" /> Edit
        </Button>
        <Button variant="outline" size="sm" onClick={() => onRecode(row)} disabled={busy}>
          <RefreshCw className="h-4 w-4" /> Re-code
        </Button>
        <Button size="sm" onClick={() => onApprove(row)} disabled={busy || approved}>
          <CheckCircle2 className="h-4 w-4" /> {approved ? "Approved" : "Approve"}
        </Button>
      </div>
    </div>
  );
}