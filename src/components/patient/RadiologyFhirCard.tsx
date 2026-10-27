import { useEffect, useState } from "react";
import { Loader2, Scan, ChevronDown, ChevronUp } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";

/** Minimal FHIR shapes for the fields this card reads off the live server. */
interface FhirCodeableConcept {
  text?: string;
  coding?: Array<{ code?: string; display?: string }>;
}
interface FhirReference {
  reference?: string;
}
interface FhirServiceRequest {
  id?: string;
  code?: FhirCodeableConcept;
  authoredOn?: string;
}
interface FhirAttachment {
  contentType?: string;
  data?: string;
  url?: string;
}
interface FhirDiagnosticReport {
  id?: string;
  basedOn?: FhirReference[];
  issued?: string;
  conclusion?: string;
  presentedForm?: FhirAttachment[];
}
interface FhirBundle<T> {
  entry?: Array<{ resource?: T }>;
}

/**
 * Radiology / Imaging card that reads live from the shared FHIR server
 * (Medblocks) via the fhir-proxy edge function. Shows:
 *
 *  - Every ServiceRequest for this patient in the Imaging category
 *    (SNOMED 363679005) — these are the studies spehr has ordered.
 *  - Every DiagnosticReport for this patient with category RAD
 *    (v2-0074 code "RAD") — these are the reads coming back from the
 *    Health Hub Suite imaging network.
 *
 * A study is "Reported" when a DiagnosticReport `basedOn`s the
 * ServiceRequest; otherwise it's "Ordered — pending read".
 */
export function RadiologyFhirCard({ mrn }: { mrn: string }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [orders, setOrders] = useState<FhirServiceRequest[]>([]);
  const [reports, setReports] = useState<FhirDiagnosticReport[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const [srRes, drRes] = await Promise.all([
          supabase.functions.invoke<FhirBundle<FhirServiceRequest>>("fhir-proxy", {
            body: {
              method: "GET",
              path: "/ServiceRequest",
              query: {
                subject: `Patient/${mrn}`,
                category: "363679005",
                _count: "50",
              },
            },
          }),
          supabase.functions.invoke<FhirBundle<FhirDiagnosticReport>>("fhir-proxy", {
            body: {
              method: "GET",
              path: "/DiagnosticReport",
              query: {
                subject: `Patient/${mrn}`,
                category: "RAD",
                _count: "50",
              },
            },
          }),
        ]);
        if (cancelled) return;
        const srEntries = (srRes.data?.entry ?? [])
          .map((e) => e.resource)
          .filter((r): r is FhirServiceRequest => !!r);
        const drEntries = (drRes.data?.entry ?? [])
          .map((e) => e.resource)
          .filter((r): r is FhirDiagnosticReport => !!r);
        setOrders(srEntries);
        setReports(drEntries);
      } catch (e) {
        if (!cancelled)
          setError(e instanceof Error ? e.message : "Failed to query imaging network");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [mrn]);

  const reportForOrder = (srId: string): FhirDiagnosticReport | null => {
    for (const r of reports) {
      const based = r?.basedOn ?? [];
      for (const b of based) {
        const ref = String(b?.reference ?? "");
        if (ref.endsWith(`ServiceRequest/${srId}`) || ref === `ServiceRequest/${srId}`) return r;
      }
    }
    return null;
  };

  const toggleExpanded = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <section className="rounded-xl border border-slate-200 bg-white overflow-hidden">
      <header className="flex items-center justify-between gap-2 border-b border-slate-100 bg-gradient-to-r from-cyan-50 to-sky-50 px-4 py-2.5">
        <div className="flex items-center gap-2">
          <Scan className="h-4 w-4 text-cyan-700" />
          <div>
            <div className="text-sm font-semibold text-slate-900">
              Radiology / Imaging (Live FHIR)
            </div>
            <div className="text-[10px] text-slate-500">
              ServiceRequest + DiagnosticReport · sourced from shared imaging network
            </div>
          </div>
        </div>
        <div className="text-[10px] font-semibold text-cyan-700">
          {orders.length} ordered · {reports.length} reported
        </div>
      </header>

      <div className="p-3 space-y-2">
        {loading ? (
          <div className="p-4 text-center">
            <Loader2 className="h-4 w-4 inline animate-spin text-slate-400" />
          </div>
        ) : error ? (
          <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800">
            {error}
          </div>
        ) : orders.length === 0 && reports.length === 0 ? (
          <div className="rounded-md border border-dashed border-slate-200 px-3 py-6 text-center text-xs text-slate-500">
            No imaging on file for this patient yet.
          </div>
        ) : (
          orders.map((sr) => {
            const rep = reportForOrder(String(sr?.id ?? ""));
            const examName = sr?.code?.text ?? sr?.code?.coding?.[0]?.display ?? "Imaging study";
            return (
              <FhirStudyRow
                key={sr?.id ?? examName}
                examName={examName}
                serviceRequest={sr}
                report={rep}
                expanded={expanded.has(String(sr?.id ?? examName))}
                onToggle={() => toggleExpanded(String(sr?.id ?? examName))}
              />
            );
          })
        )}
      </div>
    </section>
  );
}

function FhirStudyRow({
  examName,
  serviceRequest,
  report,
  expanded,
  onToggle,
}: {
  examName: string;
  serviceRequest: FhirServiceRequest;
  report: FhirDiagnosticReport | null;
  expanded: boolean;
  onToggle: () => void;
}) {
  const isReported = !!report;
  const authoredOn = serviceRequest?.authoredOn
    ? new Date(serviceRequest.authoredOn).toLocaleString([], {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "—";
  const issued = report?.issued
    ? new Date(report.issued).toLocaleString([], {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : null;

  // presentedForm[0] = base64 text/plain full report; [1] = image/jpeg url.
  const forms: FhirAttachment[] = Array.isArray(report?.presentedForm) ? report.presentedForm : [];
  const textForm = forms.find((f) => (f?.contentType ?? "").toLowerCase().startsWith("text/"));
  const imageForm = forms.find((f) => (f?.contentType ?? "").toLowerCase().startsWith("image/"));

  let fullReport: string | null = null;
  if (textForm?.data) {
    try {
      fullReport = typeof atob === "function" ? atob(String(textForm.data)) : null;
    } catch {
      fullReport = null;
    }
  }
  const imageUrl: string | null = imageForm?.url ?? null;

  return (
    <article className="rounded-lg border border-slate-200 bg-slate-50/40 overflow-hidden">
      <header className="flex items-start justify-between gap-2 px-3 py-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <div className="text-[12.5px] font-semibold text-slate-900">{examName}</div>
            <span
              className={`inline-flex items-center rounded-full px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider ring-1 ${
                isReported
                  ? "bg-emerald-50 text-emerald-700 ring-emerald-600/20"
                  : "bg-amber-50 text-amber-700 ring-amber-600/20"
              }`}
            >
              {isReported ? "Reported" : "Ordered — pending read"}
            </span>
          </div>
          <div className="mt-0.5 text-[10.5px] text-slate-500">
            Ordered {authoredOn}
            {issued ? ` · Reported ${issued}` : ""}
          </div>
        </div>
      </header>
      {isReported && (
        <div className="border-t border-slate-100 px-3 py-2 space-y-2">
          {report?.conclusion && (
            <div className="text-[12px] text-slate-900">
              <span className="text-[9px] font-bold uppercase tracking-wider text-emerald-700 mr-1">
                Impression:
              </span>
              {report.conclusion}
            </div>
          )}
          {imageUrl && (
            <a
              href={imageUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="block rounded-md border border-slate-200 overflow-hidden bg-black/5 hover:opacity-90 transition-opacity w-fit"
              title="Open radiograph in new tab"
            >
              <img
                src={imageUrl}
                alt={`Radiograph: ${examName}`}
                className="object-contain"
                style={{ maxHeight: 260 }}
                loading="lazy"
              />
            </a>
          )}
          {fullReport && (
            <div>
              <button
                type="button"
                onClick={onToggle}
                className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2 py-1 text-[10.5px] font-semibold text-slate-700 hover:bg-slate-50"
              >
                {expanded ? (
                  <>
                    <ChevronUp className="h-3 w-3" /> Hide Full Report
                  </>
                ) : (
                  <>
                    <ChevronDown className="h-3 w-3" /> Full Report
                  </>
                )}
              </button>
              {expanded && (
                <pre className="mt-1 whitespace-pre-wrap text-[11px] leading-relaxed text-slate-800 bg-white border border-slate-200 rounded-md p-2">
                  {fullReport}
                </pre>
              )}
            </div>
          )}
        </div>
      )}
    </article>
  );
}
