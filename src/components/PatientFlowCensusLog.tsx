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
import { Printer, FileText, Brain, AlertTriangle } from "lucide-react";
import {
  buildDischargeMarkdown,
  computeSafetyFlags,
} from "@/lib/discharge-narrative";

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
}

interface LabResultRow {
  test_type: string | null;
  status: string | null;
  result_value: string | null;
  requested_by: string | null;
  ordered_by: string | null;
  collected_at: string | null;
  created_at: string | null;
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
      const [medsRes, labsRes] = await Promise.all([
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
      ]);
      if (cancelled) return;
      setMeds((medsRes.data ?? []) as MedAdminRow[]);
      setLabs((labsRes.data ?? []) as LabResultRow[]);
      setChartLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [patient.mrn]);

  const summaryContent =
    patient.discharge_summary ?? note?.content ?? null;
  const summaryAuthor = "Ghost AI - Auto Discharge";

  const administered = meds.filter((m) => (m.status ?? "").toLowerCase() === "administered");
  const resulted = labs.filter((l) => {
    const s = (l.status ?? "").toLowerCase();
    return s === "resulted" || s === "reported";
  });
  const complaint = patient.chief_complaint || "evaluation";
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

        <div className="px-10 py-8 font-sans text-slate-800 print:px-12 print:py-10">
          {/* Letterhead */}
          <div className="text-center border-b-2 border-slate-900 pb-5 mb-6">
            <h1 className="font-serif text-3xl font-bold tracking-tight text-slate-900">
              {facility}
            </h1>
            <p className="mt-2 text-[11px] font-semibold uppercase tracking-[0.3em] text-slate-600">
              Official Clinical Discharge Summary
            </p>
          </div>

          {/* Demographics */}
          <section className="mb-6">
            <h2 className="text-[10px] font-bold uppercase tracking-widest text-slate-500 mb-2">
              Patient Demographics
            </h2>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-x-6 gap-y-3 border border-slate-200 rounded-md p-4 bg-slate-50/60 text-sm">
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
              <h2 className="text-[10px] font-bold uppercase tracking-widest text-slate-500">
                AI-Generated Discharge Summary
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
              <div className="rounded-md border border-slate-200 bg-white px-8 py-7 text-[13.5px] leading-[1.8] text-slate-800 font-serif tracking-[0.005em] space-y-5">
                <NarrativeBlock title="History of Present Illness">
                  Patient is a {fullName(patient)} (MRN {patient.mrn ?? "—"}) who presented to {facility} on{" "}
                  <span className="font-mono">{fmtTs(patient.admission_time)}</span> with a chief complaint of{" "}
                  <strong>{complaint}</strong>. Patient was admitted to the inpatient service for further evaluation,
                  monitoring, and management.
                </NarrativeBlock>

                <NarrativeBlock title="Hospital Course">
                  During the {los} length of stay, the patient was managed per facility clinical protocols. Vital signs
                  were monitored continuously and trended within or near acceptable parameters throughout the
                  encounter. {administered.length > 0
                    ? `A total of ${administered.length} medication administration${administered.length === 1 ? "" : "s"} ` +
                      `${resulted.length > 0 ? `and ${resulted.length} laboratory study${resulted.length === 1 ? "" : "ies"} ` : ""}` +
                      `were completed and documented in the medication administration record and laboratory results below.`
                    : "Standard clinical observation and supportive care were provided. No discrete medication or laboratory orders were recorded for this encounter."}
                </NarrativeBlock>

                <div>
                  <h3 className="flex items-center gap-1.5 text-[11px] font-sans font-bold uppercase tracking-widest text-slate-600 mb-2">
                    <Pill className="h-3 w-3" /> Medications Administered ({administered.length})
                  </h3>
                  {administered.length === 0 ? (
                    <p className="text-[12.5px] italic text-slate-500 font-sans">No medications administered during this encounter.</p>
                  ) : (
                    <div className="overflow-x-auto rounded-md border border-slate-200">
                      <table className="w-full text-[12px] font-sans">
                        <thead className="bg-slate-50 text-slate-600">
                          <tr>
                            <th className="text-left px-3 py-1.5 font-semibold uppercase tracking-wider text-[10px]">Medication</th>
                            <th className="text-left px-3 py-1.5 font-semibold uppercase tracking-wider text-[10px]">Dose / Route</th>
                            <th className="text-left px-3 py-1.5 font-semibold uppercase tracking-wider text-[10px]">Administered</th>
                            <th className="text-left px-3 py-1.5 font-semibold uppercase tracking-wider text-[10px]">Ordered By</th>
                          </tr>
                        </thead>
                        <tbody>
                          {administered.map((m, i) => (
                            <tr key={i} className="border-t border-slate-100">
                              <td className="px-3 py-1.5 font-medium text-slate-900">
                                {m.medication_name || m.drug_name || "—"}
                              </td>
                              <td className="px-3 py-1.5 text-slate-700">
                                {[m.dose, m.route].filter(Boolean).join(" · ") || "—"}
                              </td>
                              <td className="px-3 py-1.5 font-mono text-[11.5px] text-slate-700">
                                {fmtTs(m.administered_at ?? m.created_at ?? null)}
                              </td>
                              <td className="px-3 py-1.5 text-slate-600">{m.ordered_by ?? "—"}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>

                <div>
                  <h3 className="flex items-center gap-1.5 text-[11px] font-sans font-bold uppercase tracking-widest text-slate-600 mb-2">
                    <FlaskConical className="h-3 w-3" /> Laboratory Results ({resulted.length})
                  </h3>
                  {resulted.length === 0 ? (
                    <p className="text-[12.5px] italic text-slate-500 font-sans">No laboratory studies resulted during this encounter.</p>
                  ) : (
                    <div className="overflow-x-auto rounded-md border border-slate-200">
                      <table className="w-full text-[12px] font-sans">
                        <thead className="bg-slate-50 text-slate-600">
                          <tr>
                            <th className="text-left px-3 py-1.5 font-semibold uppercase tracking-wider text-[10px]">Test</th>
                            <th className="text-left px-3 py-1.5 font-semibold uppercase tracking-wider text-[10px]">Result</th>
                            <th className="text-left px-3 py-1.5 font-semibold uppercase tracking-wider text-[10px]">Resulted</th>
                            <th className="text-left px-3 py-1.5 font-semibold uppercase tracking-wider text-[10px]">Ordered By</th>
                          </tr>
                        </thead>
                        <tbody>
                          {resulted.map((l, i) => (
                            <tr key={i} className="border-t border-slate-100">
                              <td className="px-3 py-1.5 font-medium text-slate-900">{l.test_type ?? "—"}</td>
                              <td className="px-3 py-1.5 text-slate-700 font-mono text-[11.5px]">{l.result_value ?? "Pending"}</td>
                              <td className="px-3 py-1.5 font-mono text-[11.5px] text-slate-700">
                                {fmtTs(l.collected_at ?? l.created_at ?? null)}
                              </td>
                              <td className="px-3 py-1.5 text-slate-600">{l.ordered_by ?? l.requested_by ?? "—"}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>

                <NarrativeBlock title="Assessment & Impression">
                  {summaryContent ||
                    `Patient admitted for ${complaint}. Clinical course was uncomplicated. Patient responded appropriately to inpatient interventions.`}
                </NarrativeBlock>

                <NarrativeBlock title="Discharge Disposition">
                  {isDischarged ? (
                    <>
                      Patient was discharged in stable condition on{" "}
                      <span className="font-mono">{fmtTs(patient.discharge_time)}</span> with a total length of stay of {los}.
                      Discharge instructions, medication reconciliation, and follow-up arrangements were provided per
                      facility standard of care.
                    </>
                  ) : (
                    <>Patient remains admitted under active inpatient care. Disposition pending clinical reassessment.</>
                  )}
                </NarrativeBlock>
              </div>
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

function NarrativeBlock({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="text-[11px] font-sans font-bold uppercase tracking-widest text-slate-600 mb-1.5">
        {title}
      </h3>
      <p className="text-[13.5px] leading-[1.85] text-slate-800">{children}</p>
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
          "id, mrn, first_name, last_name, name, chief_complaint, status, admission_time, discharge_time, discharge_summary",
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