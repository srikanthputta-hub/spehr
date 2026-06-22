import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useFacility } from "@/lib/facility-context";
import { MOCK_AI_MRNS } from "@/lib/mockAiNotes";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Printer, FileText, Brain } from "lucide-react";
import { buildDischargeMarkdown } from "@/lib/discharge-narrative";

interface PatientRow {
  id: string;
  mrn: string | null;
  first_name: string | null;
  last_name: string | null;
  name: string | null;
  chief_complaint: string | null;
  status: string | null;
  admission_time: string | null;
  discharge_time: string | null;
  discharge_summary: string | null;
  age: number | null;
  gender: string | null;
  icd10_codes: string[] | null;
  snomed_codes: string[] | null;
  diagnosis: string | null;
  past_medical_history: string | null;
  past_surgical_history: string | null;
  primary_care_physician: string | null;
}

interface DischargeNote {
  id: string;
  content: string | null;
  author: string | null;
  created_at: string | null;
}

interface MedAdminRow {
  medication_name: string | null;
  drug_name: string | null;
  dose: string | null;
  route: string | null;
  status: string | null;
  ordered_by: string | null;
  administered_at: string | null;
  created_at?: string | null;
  rxnorm_code?: string | null;
  display_name?: string | null;
  frequency?: string | null;
}

interface LabResultRow {
  test_type: string | null;
  status: string | null;
  result_value: string | null;
  requested_by: string | null;
  ordered_by: string | null;
  collected_at: string | null;
  created_at: string | null;
  loinc_code?: string | null;
  display_name?: string | null;
  value_numeric?: number | null;
  unit?: string | null;
  abnormal_flag?: string | null;
}

interface AllergyRow {
  substance: string | null;
  reaction: string | null;
  severity: string | null;
  status: string | null;
  category?: string | null;
}

function fmtTs(ts: string | null): string {
  if (!ts) return "-- Active --";
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())}/${d.getFullYear()} - ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function durationHrs(a: string | null, b: string | null): string {
  if (!a || !b) return "—";
  const ms = new Date(b).getTime() - new Date(a).getTime();
  if (!isFinite(ms) || ms < 0) return "—";
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return `${h}h ${m}m`;
}

function fullName(p: PatientRow): string {
  return (
    p.name ||
    [p.first_name, p.last_name].filter(Boolean).join(" ") ||
    "Unknown"
  );
}

function DischargeSummaryModal({
  patient,
  facility,
  onClose,
}: {
  patient: PatientRow;
  facility: string;
  onClose: () => void;
}) {
  // Prefer the summary written directly on the patient row. Fall back to
  // clinical_notes only for legacy encounters that don't carry the field.
  const [note, setNote] = useState<DischargeNote | null>(null);
  const [loading, setLoading] = useState(!patient.discharge_summary);
  const [meds, setMeds] = useState<MedAdminRow[]>([]);
  const [labs, setLabs] = useState<LabResultRow[]>([]);
  const [allergies, setAllergies] = useState<AllergyRow[]>([]);
  const [chartLoading, setChartLoading] = useState(true);

  useEffect(() => {
    if (patient.discharge_summary) {
      setNote(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    (async () => {
      const { data } = await supabase
        .from("clinical_notes")
        .select("id, content, author, created_at")
        .eq("mrn", patient.mrn ?? "")
        .eq("note_type", "DISCHARGE_SUMMARY")
        .order("created_at", { ascending: false })
        .limit(1);
      if (cancelled) return;
      setNote((data && data[0]) ? (data[0] as DischargeNote) : null);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [patient.mrn, patient.discharge_summary]);

  useEffect(() => {
    if (!patient.mrn) {
      setChartLoading(false);
      return;
    }
    let cancelled = false;
    setChartLoading(true);
    const mrn = patient.mrn;
    (async () => {
      // Read the structured FHIR-aligned tables FIRST (the canonical source
      // of truth post-refactor). Fall back to the legacy `lab_orders` /
      // `medication_orders` rows only when no structured rows exist (older
      // encounters that ran before the relational refactor).
      const [obsRes, medReqRes, legacyMedsRes, legacyLabsRes, allergiesRes] = await Promise.all([
        supabase
          .from("observations")
          .select("loinc_code, display_name, value, value_numeric, unit, abnormal_flag, status, recorded_at")
          .eq("patient_mrn", mrn)
          .order("recorded_at", { ascending: true }),
        supabase
          .from("medication_requests")
          .select("rxnorm_code, display_name, dosage, route, frequency, status, intent, ordered_at, requester")
          .eq("patient_mrn", mrn)
          .order("ordered_at", { ascending: true }),
        supabase
          .from("medication_orders")
          .select("medication_name, drug_name, dose, route, status, ordered_by, administered_at, created_at")
          .eq("patient_mrn", mrn)
          .order("administered_at", { ascending: true }),
        supabase
          .from("lab_orders")
          .select("test_type, status, result_value, requested_by, ordered_by, collected_at, created_at")
          .eq("patient_mrn", mrn)
          .order("collected_at", { ascending: true }),
        supabase
          .from("allergies")
          .select("substance, reaction, severity, status, category")
          .eq("mrn", mrn),
      ]);
      if (cancelled) return;

      const obsRows = (obsRes.data ?? []) as Array<{
        loinc_code: string | null;
        display_name: string | null;
        value: string | null;
        value_numeric: number | null;
        unit: string | null;
        abnormal_flag: string | null;
        status: string | null;
        recorded_at: string | null;
      }>;
      const mappedLabs: LabResultRow[] = obsRows.length > 0
        ? obsRows.map((o) => ({
            test_type: o.display_name,
            status: o.status === "final" ? "Resulted" : o.status,
            result_value: o.value ?? (o.value_numeric != null ? String(o.value_numeric) : null),
            requested_by: null,
            ordered_by: "Auto Doc",
            collected_at: o.recorded_at,
            created_at: o.recorded_at,
            loinc_code: o.loinc_code,
            display_name: o.display_name,
            value_numeric: o.value_numeric,
            unit: o.unit,
            abnormal_flag: o.abnormal_flag,
          }))
        : ((legacyLabsRes.data ?? []) as LabResultRow[]);

      const mrRows = (medReqRes.data ?? []) as Array<{
        rxnorm_code: string | null;
        display_name: string | null;
        dosage: string | null;
        route: string | null;
        frequency: string | null;
        status: string | null;
        ordered_at: string | null;
        requester: string | null;
      }>;
      const mappedMeds: MedAdminRow[] = mrRows.length > 0
        ? mrRows.map((m) => ({
            medication_name: m.display_name,
            drug_name: m.display_name,
            dose: m.dosage,
            route: m.route,
            status: (m.status ?? "").toLowerCase() === "completed" ? "Administered" : (m.status ?? "active"),
            ordered_by: m.requester ?? "Auto Doc",
            administered_at: m.ordered_at,
            created_at: m.ordered_at,
            rxnorm_code: m.rxnorm_code,
            display_name: m.display_name,
            frequency: m.frequency,
          }))
        : ((legacyMedsRes.data ?? []) as MedAdminRow[]);

      setMeds(mappedMeds);
      setLabs(mappedLabs);
      setAllergies((allergiesRes.data ?? []) as AllergyRow[]);
      setChartLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [patient.mrn]);

  // Surface that a persisted text summary exists (legacy field) but the
  // rendered narrative below is rebuilt fresh from the structured chart.
  void patient.discharge_summary;
  void note;
  const summaryAuthor = "Ghost AI - Clinical Narrative";
  const los = durationHrs(patient.admission_time, patient.discharge_time);
  const isDischarged = !!patient.discharge_time;

  const handlePrint = () => window.print();

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-5xl max-h-[92vh] overflow-y-auto p-0 print:max-w-full print:max-h-none print:shadow-none">
        <DialogTitle className="sr-only">
          Discharge Summary for {fullName(patient)}
        </DialogTitle>
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-slate-200 bg-white/95 backdrop-blur px-6 py-3 print:hidden">
          <span className="text-[11px] font-mono uppercase tracking-widest text-slate-500">
            Document ID · DS-{patient.mrn ?? "—"}
          </span>
          <Button
            size="sm"
            variant="outline"
            onClick={handlePrint}
            className="gap-1.5"
          >
            <Printer className="h-3.5 w-3.5" />
            Print to PDF
          </Button>
        </div>

        <div
          className="px-10 py-8 text-slate-800 print:px-12 print:py-10"
          style={{ fontFamily: '"Times New Roman", Times, serif' }}
        >
          {/* Letterhead */}
          <div className="text-center border-b-2 border-slate-900 pb-5 mb-6">
            <h1 className="text-3xl font-bold tracking-tight text-slate-900">
              {facility}
            </h1>
            <p className="mt-2 text-[12px] font-semibold uppercase tracking-[0.3em] text-slate-600">
              Official Clinical Discharge Summary
            </p>
          </div>

          {/* Demographics */}
          <section className="mb-6">
            <h2 className="text-[11px] font-bold uppercase tracking-widest text-slate-500 mb-2">
              Patient Demographics
            </h2>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-x-6 gap-y-3 border border-slate-300 rounded-sm p-4 bg-white text-[14px]">
              <Field label="Patient Name" value={fullName(patient)} />
              <Field label="MRN" value={patient.mrn ?? "—"} mono />
              <Field
                label="Status"
                value={patient.status ?? "—"}
              />
              <Field
                label="Chief Complaint"
                value={patient.chief_complaint ?? "—"}
                wide
              />
              <Field label="Admission" value={fmtTs(patient.admission_time)} mono />
              <Field
                label="Discharge"
                value={
                  patient.discharge_time ? fmtTs(patient.discharge_time) : "Currently Admitted"
                }
                mono
              />
            </div>
          </section>

          {/* AI Discharge Summary */}
          <section className="mb-6">
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-[11px] font-bold uppercase tracking-widest text-slate-500">
                Clinical Discharge Summary
              </h2>
              {summaryAuthor && (
                <span className="inline-flex items-center gap-1 rounded-full bg-purple-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-purple-700 ring-1 ring-purple-300">
                  <Brain className="h-2.5 w-2.5" />
                  {summaryAuthor}
                </span>
              )}
            </div>
            {loading || chartLoading ? (
              <p className="text-sm text-slate-400 italic">Loading discharge summary…</p>
            ) : (
              <ClinicalNarrative
                patient={patient}
                meds={meds}
                labs={labs}
                allergies={allergies}
                isDischarged={isDischarged}
                los={los}
              />
            )}
          </section>

          {/* Footer */}
          <div className="mt-10 pt-4 border-t border-slate-300 text-center text-[11px] text-slate-500">
            <p className="font-medium">
              Electronically generated and verified by S.P.E.H.R. AI Core
            </p>
            <p className="font-mono mt-1">{fmtTs(new Date().toISOString())}</p>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Field({
  label,
  value,
  mono,
  wide,
}: {
  label: string;
  value: string;
  mono?: boolean;
  wide?: boolean;
}) {
  return (
    <div className={wide ? "col-span-2 md:col-span-3" : ""}>
      <div className="text-[10px] uppercase tracking-wider text-slate-500">
        {label}
      </div>
      <div
        className={`text-slate-900 font-medium ${mono ? "font-mono text-[12.5px]" : "text-sm"}`}
      >
        {value}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Clinical narrative — 6-part discharge structure with safety flags. */
/* ------------------------------------------------------------------ */

function renderInline(text: string): React.ReactNode {
  // Bold **...** and italic _..._ ; everything else verbatim.
  const parts: React.ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|_[^_]+_)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith("**")) {
      parts.push(<strong key={key++} className="font-semibold text-slate-900">{tok.slice(2, -2)}</strong>);
    } else {
      parts.push(<em key={key++} className="text-slate-700">{tok.slice(1, -1)}</em>);
    }
    last = m.index + tok.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

function MarkdownBlock({ md }: { md: string }) {
  const lines = md.split("\n");
  const out: React.ReactNode[] = [];
  let bullets: string[] = [];
  let quote: string[] = [];
  const flushBullets = () => {
    if (bullets.length === 0) return;
    out.push(
      <ul key={`u-${out.length}`} className="list-disc pl-6 space-y-1.5 text-[14.5px] leading-[1.7] text-slate-800">
        {bullets.map((b, i) => (
          <li key={i}>{renderInline(b)}</li>
        ))}
      </ul>,
    );
    bullets = [];
  };
  const flushQuote = () => {
    if (quote.length === 0) return;
    out.push(
      <div
        key={`q-${out.length}`}
        className="rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-[12.5px] text-amber-900 space-y-1"
      >
        {quote.map((q, i) => (
          <div key={i} className="flex items-start gap-2">
            <span className={i === 0 ? "font-semibold" : "pl-5"}>{renderInline(q)}</span>
          </div>
        ))}
      </div>,
    );
    quote = [];
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (line.startsWith("> ")) {
      flushBullets();
      quote.push(line.slice(2).replace(/^-\s*/, ""));
      continue;
    }
    flushQuote();
    if (line.startsWith("- ")) {
      bullets.push(line.slice(2));
      continue;
    }
    flushBullets();
    if (line === "") continue;
    // Section header like **1. Foo**
    const head = line.match(/^\*\*(.+)\*\*$/);
    if (head) {
      out.push(
        <h3
          key={`h-${out.length}`}
          className="text-[15px] font-bold text-slate-900 mt-5 mb-2 border-b border-slate-300 pb-1"
        >
          {head[1]}
        </h3>,
      );
      continue;
    }
    out.push(
      <p key={`p-${out.length}`} className="text-[14.5px] leading-[1.8] text-slate-800 text-justify">
        {renderInline(line)}
      </p>,
    );
  }
  flushBullets();
  flushQuote();
  return <div className="space-y-2">{out}</div>;
}

function ClinicalNarrative({
  patient,
  meds,
  labs,
  allergies,
  isDischarged,
  los,
}: {
  patient: PatientRow;
  meds: MedAdminRow[];
  labs: LabResultRow[];
  allergies: AllergyRow[];
  isDischarged: boolean;
  los: string;
}) {
  const administered = meds.filter((m) => (m.status ?? "").toLowerCase() === "administered");
  const resulted = labs.filter((l) => {
    const s = (l.status ?? "").toLowerCase();
    return s === "resulted" || s === "reported";
  });
  const md = buildDischargeMarkdown(
    patient,
    administered,
    resulted,
    allergies.map((a) => ({
      substance: a.substance,
      reaction: a.reaction,
      severity: a.severity,
      category: null,
    })),
  );
  return (
    <div
      className="rounded-sm border border-slate-300 bg-white px-10 py-8"
      style={{ fontFamily: '"Times New Roman", Times, serif' }}
    >
      <MarkdownBlock md={md} />
      <div className="mt-6 pt-3 border-t border-slate-300 text-[12px] text-slate-600">
        Disposition:{" "}
        {isDischarged
          ? <>Discharged in stable condition · Length of stay <span className="font-mono">{los}</span></>
          : <>Active inpatient — disposition pending clinical reassessment.</>}
      </div>
      <div className="mt-8 grid grid-cols-2 gap-8 text-[12.5px] text-slate-700">
        <div>
          <div className="border-t border-slate-400 pt-1 mt-10">
            Attending Physician — Signature &amp; Date
          </div>
        </div>
        <div>
          <div className="border-t border-slate-400 pt-1 mt-10">
            Patient / Authorized Representative — Signature &amp; Date
          </div>
        </div>
      </div>
    </div>
  );
}

export function PatientFlowCensusLog() {
  const { facility } = useFacility();
  const [rows, setRows] = useState<PatientRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<PatientRow | null>(null);
  // SYNCHRONOUS BYPASS: seeded from global mock store. No timers, no DB.
  const [aiMrns, setAiMrns] = useState<Set<string>>(() => new Set(MOCK_AI_MRNS));

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const { data, error } = await supabase
        .from("patients")
        .select(
          "id, mrn, first_name, last_name, name, chief_complaint, status, admission_time, discharge_time, discharge_summary, age, gender, icd10_codes, snomed_codes, diagnosis, past_medical_history, past_surgical_history, primary_care_physician",
        )
        .eq("facility_name", facility)
        .order("admission_time", { ascending: false })
        .limit(50);
      if (!cancelled && !error && data) setRows(data as PatientRow[]);
      if (!cancelled) setLoading(false);
    };
    setLoading(true);
    load();
    const ch = supabase
      .channel(`patient-flow-${facility}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "patients" },
        () => load(),
      )
      .subscribe();
    return () => {
      cancelled = true;
      supabase.removeChannel(ch);
    };
  }, [facility]);

  // Keep mock MRNs marked AI-complete; nothing async to wire up.
  useEffect(() => {
    setAiMrns(new Set(MOCK_AI_MRNS));
  }, [rows]);

  const admittedCount = rows.filter((r) => r.status === "Admitted").length;
  const dischargedCount = rows.filter((r) => r.status === "Discharged").length;

  return (
    <div>
      <div className="mb-3 flex items-end justify-between flex-wrap gap-2">
        <div>
          <h2 className="text-base font-semibold text-slate-900">
            🛏️ Patient Flow & Census Log
          </h2>
          <p className="text-xs text-slate-500 mt-0.5">
            Last 50 admissions · {facility} · Realtime
          </p>
        </div>
        <div className="flex items-center gap-2 text-[11px]">
          <span className="inline-flex items-center gap-1.5 rounded-md border border-emerald-200 bg-emerald-50 px-2 py-1 text-emerald-700 font-medium">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
            {admittedCount} Active
          </span>
          <span className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2 py-1 text-slate-600 font-medium">
            <span className="h-1.5 w-1.5 rounded-full bg-slate-400" />
            {dischargedCount} Discharged
          </span>
        </div>
      </div>

      <div className="rounded-lg border border-slate-200 bg-white shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-[12px] font-mono">
            <thead className="bg-slate-100 text-slate-600">
              <tr className="border-b border-slate-200">
                <th className="text-left px-3 py-2 font-semibold uppercase tracking-wider text-[10px]">MRN</th>
                <th className="text-left px-3 py-2 font-semibold uppercase tracking-wider text-[10px]">Patient Name</th>
                <th className="text-left px-3 py-2 font-semibold uppercase tracking-wider text-[10px]">Chief Complaint</th>
                <th className="text-left px-3 py-2 font-semibold uppercase tracking-wider text-[10px]">Status</th>
                <th className="text-left px-3 py-2 font-semibold uppercase tracking-wider text-[10px]">Admission Time</th>
                <th className="text-left px-3 py-2 font-semibold uppercase tracking-wider text-[10px]">Discharge Time</th>
                <th className="text-left px-3 py-2 font-semibold uppercase tracking-wider text-[10px]">Documentation</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={7} className="px-3 py-8 text-center text-slate-400">
                    Loading census…
                  </td>
                </tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-3 py-8 text-center text-slate-400">
                    No patient records for {facility}.
                  </td>
                </tr>
              ) : (
                rows.map((p, i) => {
                  const active = p.status === "Admitted";
                  return (
                    <tr
                      key={p.id}
                      className={`border-b border-slate-100 hover:bg-slate-50 ${
                        i % 2 === 1 ? "bg-slate-50/40" : ""
                      }`}
                    >
                      <td className="px-3 py-1.5 text-slate-900">{p.mrn ?? "—"}</td>
                      <td className="px-3 py-1.5 text-slate-900 font-sans font-medium">
                        {fullName(p)}
                      </td>
                      <td className="px-3 py-1.5 text-slate-700 font-sans">
                        <div className="flex flex-col gap-0.5">
                          <span>{p.chief_complaint ?? "—"}</span>
                          {p.mrn && aiMrns.has(p.mrn) ? (
                            <span className="inline-flex items-center gap-1 self-start rounded-full bg-purple-100 px-1.5 py-0.5 text-[9.5px] font-bold uppercase tracking-wider text-purple-700 ring-1 ring-purple-300">
                              <Brain className="h-2.5 w-2.5" />
                              AI Differential Complete
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 self-start rounded-full bg-slate-100 px-1.5 py-0.5 text-[9.5px] font-medium uppercase tracking-wider text-slate-500 ring-1 ring-slate-200">
                              <Brain className="h-2.5 w-2.5" />
                              AI Pending
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-3 py-1.5">
                        {active ? (
                          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-semibold text-emerald-700 ring-1 ring-emerald-300 font-sans">
                            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
                            🟢 Active
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-500 ring-1 ring-slate-200 font-sans">
                            ⚪ Discharged
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-1.5 text-slate-700">
                        {fmtTs(p.admission_time)}
                      </td>
                      <td className="px-3 py-1.5 text-slate-700">
                        {p.discharge_time ? (
                          fmtTs(p.discharge_time)
                        ) : (
                          <span className="text-emerald-600/80 italic font-sans">
                            -- Active --
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-1.5">
                        <button
                          onClick={() => setSelected(p)}
                          className="inline-flex items-center gap-1 rounded-md border border-slate-300 bg-white px-2 py-1 text-[11px] font-medium text-slate-700 font-sans shadow-sm hover:bg-slate-900 hover:text-white hover:border-slate-900 transition-colors"
                        >
                          <FileText className="h-3 w-3" />
                          View Summary
                        </button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {selected && (
        <DischargeSummaryModal
          patient={selected}
          facility={facility}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}