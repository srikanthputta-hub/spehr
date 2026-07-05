import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { Button } from "@/components/ui/button";
import {
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  PencilLine,
  RefreshCw,
  Sparkles,
  User,
  AlertTriangle,
} from "lucide-react";

export type AuditRow = {
  id: string;
  patient_mrn: string;
  raw_text: string | null;
  extraction_mapping: any;
  standardized_output: any;
  confidence_score: number | null;
  status: string | null;
  created_at: string;
  updated_at?: string | null;
  approved_by?: string | null;
};

const STREAM_META: Record<string, { title: string; blurb: string }> = {
  a: { title: "Stream A · Chief Complaint + HPI", blurb: "SNOMED CT · ICD-10 (via UMLS)" },
  b: { title: "Stream B · Past Medical History", blurb: "SNOMED CT · ICD-10 (direct map)" },
  c: { title: "Stream C · Medications", blurb: "RxNorm (via RxNav)" },
  d: { title: "Stream D · Allergies", blurb: "RxNorm + SNOMED reactions" },
  e: { title: "Stream E · Vitals", blurb: "LOINC (static)" },
  f: { title: "Stream F · Lab Results", blurb: "LOINC (pre-map + UMLS)" },
};

const AUTO_APPROVE_MS = 180_000;
const NEEDS_REVIEW_AUTO_APPROVE_MS = 360_000;

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
  streamKey, meta, status, payload, gate,
}: {
  streamKey: string;
  meta: { title: string; blurb: string };
  status?: string;
  payload: any;
  gate?: string;
}) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-xs font-semibold text-slate-900">{meta.title}</div>
          <div className="text-[10px] text-slate-500">{meta.blurb}</div>
        </div>
        <div className="flex items-center gap-1">
          {gate === "needs_review" && (
            <span className="inline-flex items-center gap-1 rounded border border-amber-300 bg-amber-50 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-amber-700" title="One or more codes not in value set">
              <AlertTriangle className="h-3 w-3" /> Review
            </span>
          )}
          <StatusPill s={status} />
        </div>
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
  const warn = (validated: any) => (validated === false ? "ring-1 ring-amber-400" : "");
  const warnTitle = (validated: any, reason?: string) =>
    validated === false ? (reason ? `Not in value set — ${reason}` : "Not in value set") : undefined;
  if (key === "a") {
    const arr = Array.isArray(payload) ? payload : payload ? [payload] : [];
    arr.forEach((p: any, i: number) => {
      if (p?.snomed_code) pills.push(<span key={`asn${i}`} className={`inline-block rounded ${warn(p.validated)}`} title={warnTitle(p.validated, p.validation_reason)}><CodePill system="SNOMED" code={p.snomed_code} display={p.snomed_display} /></span>);
      if (p?.icd10_code) pills.push(<CodePill key={`ai${i}`} system="ICD-10" code={p.icd10_code} display={p.icd10_display} />);
    });
  } else if (key === "b") {
    const arr = Array.isArray(payload) ? payload : [];
    arr.forEach((p: any, i: number) => {
      if (p.snomed_code) pills.push(<span key={`bs${i}`} className={`inline-block rounded ${warn(p.validated)}`} title={warnTitle(p.validated, p.validation_reason)}><CodePill system="SNOMED" code={p.snomed_code} display={p.snomed_display} /></span>);
      if (p.icd10_code) pills.push(<CodePill key={`bi${i}`} system="ICD-10" code={p.icd10_code} display={p.icd10_display} />);
    });
  } else if (key === "c") {
    (Array.isArray(payload) ? payload : []).forEach((p: any, i: number) =>
      p.rxnorm_code && pills.push(<span key={`c${i}`} className={`inline-block rounded ${warn(p.validated)}`} title={warnTitle(p.validated, p.validation_reason)}><CodePill system="RxNorm" code={p.rxnorm_code} display={p.rxnorm_display ?? p.name} /></span>)
    );
  } else if (key === "d") {
    (Array.isArray(payload) ? payload : []).forEach((p: any, i: number) => {
      if (p.substance_rxcui) pills.push(<CodePill key={`dr${i}`} system="RxNorm" code={p.substance_rxcui} display={p.substance} />);
      if (p.substance_snomed) pills.push(<span key={`ds${i}`} className={`inline-block rounded ${warn(p.validated)}`} title={warnTitle(p.validated, p.validation_reason)}><CodePill system="SNOMED" code={p.substance_snomed} display={p.substance} /></span>);
      if (p.reaction_snomed) pills.push(<CodePill key={`drx${i}`} system="SNOMED" code={p.reaction_snomed} display="reaction" />);
    });
  } else if (key === "e") {
    const map = payload && typeof payload === "object" ? payload : {};
    Object.entries(map).forEach(([field, code]: any, i) =>
      pills.push(<CodePill key={`e${i}`} system="LOINC" code={String(code)} display={field} />)
    );
  } else if (key === "f") {
    (Array.isArray(payload) ? payload : []).forEach((p: any, i: number) =>
      p.loinc_code && pills.push(<span key={`f${i}`} className={`inline-block rounded ${warn(p.validated)}`} title={warnTitle(p.validated, p.validation_reason)}><CodePill system="LOINC" code={p.loinc_code} display={p.loinc_display ?? p.test_name} /></span>)
    );
  }
  return pills.length ? pills : <span className="text-[11px] text-slate-400">No coded items.</span>;
}

export function AuditCard({
  row,
  onApprove,
  onRecode,
  busy,
  readOnly = false,
  defaultExpanded = false,
  autoApprove = false,
  onAutoApprove,
  admissionAt,
}: {
  row: AuditRow;
  onApprove?: (r: AuditRow, approvedBy: "human" | "ai") => void | Promise<void>;
  onRecode?: (r: AuditRow) => void | Promise<void>;
  busy?: boolean;
  readOnly?: boolean;
  defaultExpanded?: boolean;
  autoApprove?: boolean;
  onAutoApprove?: (r: AuditRow) => void | Promise<void>;
  admissionAt?: string | null;
}) {
  const std = row.standardized_output ?? {};
  const mapping = row.extraction_mapping?.streams ?? {};
  const validation = row.extraction_mapping?.validation ?? {};
  const conf = Math.round(((row.confidence_score ?? 0) as number) * 100);
  const approved = row.status === "approved";
  const needsReview = row.status === "needs_review";
  const created = new Date(row.created_at).toLocaleString();
  const approvedBy = (row.approved_by ?? "").toLowerCase();
  const autoReviewed =
    (row as any).__autoReviewed === true ||
    row.extraction_mapping?.auto_reviewed === true;
  const [expanded, setExpanded] = useState(defaultExpanded);

  // CSS-only auto-approve countdown — no interval / no per-tick state.
  // Anchor to admission time (falls back to row.created_at if unknown).
  const firedRef = useRef(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { remainingMs, startPct, nrRemainingMs, nrStartPct } = useMemo(() => {
    const anchorMs = new Date(admissionAt ?? row.created_at).getTime();
    const elapsedMs = Date.now() - anchorMs;
    const remainingMs = Math.max(0, AUTO_APPROVE_MS - elapsedMs);
    const startPct = Math.max(0, Math.min(100, (remainingMs / AUTO_APPROVE_MS) * 100));
    const nrRemainingMs = Math.max(0, NEEDS_REVIEW_AUTO_APPROVE_MS - elapsedMs);
    const nrStartPct = Math.max(0, Math.min(100, (nrRemainingMs / NEEDS_REVIEW_AUTO_APPROVE_MS) * 100));
    return { remainingMs, startPct, nrRemainingMs, nrStartPct };
  }, [admissionAt, row.created_at, needsReview]);

  useEffect(() => {
    if (!autoApprove || approved || firedRef.current) return;
    const isNr = needsReview;
    const windowMs = isNr ? nrRemainingMs : remainingMs;
    const fire = () => {
      if (firedRef.current) return;
      firedRef.current = true;
      if (isNr) {
        (row as any).__autoReviewed = true;
      }
      onAutoApprove?.(row);
    };
    if (windowMs <= 0) {
      fire();
      return;
    }
    timeoutRef.current = setTimeout(fire, windowMs);
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoApprove, approved, needsReview, row.id]);

  const handleApproveClick = () => {
    firedRef.current = true;
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    onApprove?.(row, "human");
  };

  return (
    <div className="rounded-xl border border-slate-200 bg-white shadow-sm overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full text-left flex flex-wrap items-center justify-between gap-3 px-4 py-3 bg-slate-50/70 border-b border-slate-100 hover:bg-slate-100/70 transition-colors"
      >
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-slate-900 flex items-center gap-2">
            {expanded ? <ChevronUp className="h-4 w-4 text-slate-500" /> : <ChevronDown className="h-4 w-4 text-slate-500" />}
            {row.patient_mrn}
            <span className="ml-2 text-[11px] font-normal text-slate-500">{created}</span>
          </div>
          <div className="text-[11px] text-slate-500 truncate max-w-xl mt-0.5">
            {row.raw_text ?? "—"}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {approved && approvedBy === "human" && (
            <span className="inline-flex items-center gap-1 rounded border border-emerald-300 bg-emerald-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-emerald-700">
              <User className="h-3 w-3" /> User
            </span>
          )}
          {approved && approvedBy === "ai" && !autoReviewed && (
            <span className="inline-flex items-center gap-1 rounded border border-sky-300 bg-sky-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-sky-700">
              <Sparkles className="h-3 w-3" /> AI
            </span>
          )}
          {approved && approvedBy === "ai" && autoReviewed && (
            <span className="inline-flex items-center gap-1 rounded border border-amber-300 bg-amber-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-amber-700">
              <Sparkles className="h-3 w-3" /> AI Reviewed
            </span>
          )}
          <span className={`inline-flex items-center rounded border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${
            conf >= 80 ? "border-emerald-200 bg-emerald-50 text-emerald-700"
            : conf >= 50 ? "border-amber-200 bg-amber-50 text-amber-700"
            : "border-red-200 bg-red-50 text-red-700"
          }`}>
            Confidence · {conf}%
          </span>
          <span className={`inline-flex items-center rounded border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${
            approved ? "border-emerald-300 bg-emerald-100 text-emerald-800"
            : needsReview ? "border-amber-300 bg-amber-100 text-amber-800"
            : "border-amber-200 bg-amber-50 text-amber-700"
          }`}>
            {approved ? "Approved" : needsReview ? "⚠ Needs Review" : "Pending"}
          </span>
        </div>
      </button>

      {autoApprove && !approved && !needsReview && remainingMs > 0 && (
        <div className="h-1.5 w-full bg-slate-100">
          <div
            className="h-full"
            style={{
              width: `${startPct}%`,
              animation: `audit-drain ${remainingMs}ms linear forwards, audit-drain-color ${remainingMs}ms linear forwards`,
              ["--audit-start" as any]: `${startPct}%`,
              backgroundColor: "#10b981",
            }}
            title={`Auto-approves in ${Math.ceil(remainingMs / 1000)}s`}
          />
        </div>
      )}

      {autoApprove && !approved && needsReview && nrRemainingMs > 0 && (
        <div className="h-1.5 w-full bg-slate-100">
          <div
            className="h-full"
            style={{
              width: `${nrStartPct}%`,
              animation: `audit-drain ${nrRemainingMs}ms linear forwards`,
              ["--audit-start" as any]: `${nrStartPct}%`,
              backgroundColor: "#f59e0b",
            }}
            title={`Auto-reviews in ${Math.ceil(nrRemainingMs / 1000)}s`}
          />
        </div>
      )}

      {expanded && (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 p-3">
            {(["a","b","c","d","e","f"] as const).map((k) => (
              <StreamCard
                key={k}
                streamKey={k}
                meta={STREAM_META[k]}
                status={mapping?.[k]?.status}
                payload={std?.[`stream_${k}`]}
                gate={validation?.[k]}
              />
            ))}
          </div>
          {!readOnly && (
            <div className="flex items-center justify-end gap-2 px-4 py-3 bg-slate-50/40 border-t border-slate-100">
              <Button variant="outline" size="sm" disabled title="Inline edit coming soon">
                <PencilLine className="h-4 w-4" /> Edit
              </Button>
              <Button variant="outline" size="sm" onClick={() => onRecode?.(row)} disabled={busy}>
                <RefreshCw className="h-4 w-4" /> Re-code
              </Button>
              <Button size="sm" onClick={handleApproveClick} disabled={busy || approved}>
                <CheckCircle2 className="h-4 w-4" /> {approved ? "Approved" : "Approve"}
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}