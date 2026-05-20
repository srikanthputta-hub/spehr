import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useFacility } from "@/lib/facility-context";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Printer, FileText } from "lucide-react";

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
}

interface LabOrder {
  id: string;
  test_type: string | null;
  result_value: string | null;
  status: string | null;
  created_at: string | null;
}

interface MedOrder {
  id: string;
  medication_name: string | null;
  dose: string | null;
  route: string | null;
  administered_at: string | null;
  created_at: string | null;
}

function fmtTs(ts: string | null): string {
  if (!ts) return "-- Active --";
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())}/${d.getFullYear()} - ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
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
  const [labs, setLabs] = useState<LabOrder[]>([]);
  const [meds, setMeds] = useState<MedOrder[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      const [labRes, medRes] = await Promise.all([
        supabase
          .from("lab_orders")
          .select("id, test_type, result_value, status, created_at")
          .eq("patient_mrn", patient.mrn ?? "")
          .order("created_at", { ascending: false }),
        supabase
          .from("medication_orders")
          .select("id, medication_name, dose, route, administered_at, created_at")
          .eq("mrn", patient.mrn ?? "")
          .order("administered_at", { ascending: false, nullsFirst: false }),
      ]);
      if (cancelled) return;
      if (labRes.data) setLabs(labRes.data as LabOrder[]);
      if (medRes.data) setMeds(medRes.data as MedOrder[]);
      setLoading(false);
    };
    load();
    return () => {
      cancelled = true;
    };
  }, [patient.mrn]);

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

          {/* Care Team */}
          <section className="mb-6">
            <h2 className="text-[10px] font-bold uppercase tracking-widest text-slate-500 mb-2">
              Care Team
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
              <div className="rounded-md border border-slate-200 px-4 py-2.5">
                <div className="text-[10px] uppercase text-slate-500 tracking-wider">Attending Physician</div>
                <div className="font-medium text-slate-900">Dr. Expanse System</div>
              </div>
              <div className="rounded-md border border-slate-200 px-4 py-2.5">
                <div className="text-[10px] uppercase text-slate-500 tracking-wider">Primary RN</div>
                <div className="font-medium text-slate-900">Automated Clinical Unit</div>
              </div>
            </div>
          </section>

          {/* Labs */}
          {loading ? (
            <p className="text-sm text-slate-400 italic">Loading clinical history…</p>
          ) : (
            <>
              {labs.length > 0 && (
                <section className="mb-6">
                  <h2 className="text-[10px] font-bold uppercase tracking-widest text-slate-500 mb-2">
                    Laboratory Results
                  </h2>
                  <table className="w-full text-[12.5px] border border-slate-200 rounded-md overflow-hidden">
                    <thead className="bg-slate-100 text-slate-600 text-[10px] uppercase tracking-wider">
                      <tr>
                        <th className="text-left px-3 py-2 font-semibold">Test Type</th>
                        <th className="text-left px-3 py-2 font-semibold">Result</th>
                        <th className="text-left px-3 py-2 font-semibold">Resulted At</th>
                      </tr>
                    </thead>
                    <tbody>
                      {labs.map((l) => (
                        <tr key={l.id} className="border-t border-slate-200">
                          <td className="px-3 py-2 font-medium text-slate-900">{l.test_type ?? "—"}</td>
                          <td className="px-3 py-2 font-mono text-slate-700">{l.result_value ?? <span className="italic text-slate-400">Pending</span>}</td>
                          <td className="px-3 py-2 font-mono text-[11px] text-slate-600">{fmtTs(l.created_at)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </section>
              )}

              {meds.length > 0 && (
                <section className="mb-6">
                  <h2 className="text-[10px] font-bold uppercase tracking-widest text-slate-500 mb-2">
                    Medications Administered
                  </h2>
                  <table className="w-full text-[12.5px] border border-slate-200 rounded-md overflow-hidden">
                    <thead className="bg-slate-100 text-slate-600 text-[10px] uppercase tracking-wider">
                      <tr>
                        <th className="text-left px-3 py-2 font-semibold">Medication</th>
                        <th className="text-left px-3 py-2 font-semibold">Dose</th>
                        <th className="text-left px-3 py-2 font-semibold">Route</th>
                        <th className="text-left px-3 py-2 font-semibold">Administered At</th>
                      </tr>
                    </thead>
                    <tbody>
                      {meds.map((m) => (
                        <tr key={m.id} className="border-t border-slate-200">
                          <td className="px-3 py-2 font-medium text-slate-900">{m.medication_name ?? "—"}</td>
                          <td className="px-3 py-2 font-mono text-slate-700">{m.dose ?? "—"}</td>
                          <td className="px-3 py-2 text-slate-700">{m.route ?? "—"}</td>
                          <td className="px-3 py-2 font-mono text-[11px] text-slate-600">
                            {m.administered_at ? fmtTs(m.administered_at) : <span className="italic text-slate-400">Not yet</span>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </section>
              )}

              {labs.length === 0 && meds.length === 0 && (
                <p className="text-sm text-slate-500 italic border border-dashed border-slate-300 rounded-md px-4 py-6 text-center">
                  No laboratory or medication records on file for this encounter.
                </p>
              )}
            </>
          )}

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

export function PatientFlowCensusLog() {
  const { facility } = useFacility();
  const [rows, setRows] = useState<PatientRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<PatientRow | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const { data, error } = await supabase
        .from("patients")
        .select(
          "id, mrn, first_name, last_name, name, chief_complaint, status, admission_time, discharge_time",
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
                        {p.chief_complaint ?? "—"}
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