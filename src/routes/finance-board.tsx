import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { BoardHeader } from "@/components/BoardShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Loader2,
  Wallet,
  Receipt,
  Printer,
  Search,
  FileText,
  TrendingUp,
  DollarSign,
  CheckCircle2,
} from "lucide-react";
import { toast } from "sonner";
import { useFacility, useActiveStaff } from "@/lib/facility-context";

export const Route = createFileRoute("/finance-board")({
  component: FinanceBoard,
});

interface PatientRow {
  id: string;
  mrn: string | null;
  name: string | null;
  first_name: string | null;
  last_name: string | null;
  age: number | null;
  gender: string | null;
  room: string | null;
  chief_complaint: string | null;
  diagnosis: string | null;
  facility_name: string | null;
  status: string | null;
  admission_time: string | null;
  discharge_time: string | null;
}

interface MedRow {
  medication_name: string | null;
  drug_name: string | null;
  dose: string | null;
  route: string | null;
  status: string | null;
  administered_at: string | null;
}

interface LabRow {
  test_type: string | null;
  status: string | null;
  result_value: string | null;
  collected_at: string | null;
}

// Standard private-hospital tariff (USD). Tweak freely — single source of truth.
const TARIFF = {
  bed_per_day: 850, // general ward
  icu_per_day: 2400,
  consultant_per_day: 350,
  nursing_per_day: 220,
  lab_per_test: 95,
  med_per_dose: 38,
  admin_fee: 150,
  pharmacy_handling: 75,
  biomedical_waste: 45,
  tax_rate: 0.05, // 5%
};

function fullName(p: PatientRow) {
  return (
    p.name ||
    [p.first_name, p.last_name].filter(Boolean).join(" ") ||
    p.mrn ||
    "Unknown"
  );
}

function fmtTs(ts: string | null) {
  if (!ts) return "—";
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function lengthOfStayDays(admit: string | null, discharge: string | null) {
  if (!admit) return 1;
  const end = discharge ? new Date(discharge).getTime() : Date.now();
  const ms = end - new Date(admit).getTime();
  if (!isFinite(ms) || ms <= 0) return 1;
  return Math.max(1, Math.ceil(ms / 86_400_000));
}

function money(n: number) {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

function FinanceBoard() {
  const { facility } = useFacility();
  const officer = useActiveStaff("Finance");
  const [patients, setPatients] = useState<PatientRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<PatientRow | null>(null);

  const refresh = async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from("patients")
      .select(
        "id,mrn,name,first_name,last_name,age,gender,room,chief_complaint,diagnosis,facility_name,status,admission_time,discharge_time",
      )
      .order("discharge_time", { ascending: false, nullsFirst: false });
    if (error) toast.error(`Unable to load patients: ${error.message}`);
    else setPatients((data ?? []) as PatientRow[]);
    setLoading(false);
  };

  useEffect(() => {
    refresh();
    const channel = supabase
      .channel("finance-patients")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "patients" },
        () => refresh(),
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const facilityPatients = useMemo(
    () => patients.filter((p) => (p.facility_name ?? "Memorial Hospital") === facility),
    [patients, facility],
  );

  const discharged = useMemo(
    () =>
      facilityPatients.filter(
        (p) => (p.status ?? "").toLowerCase() === "discharged",
      ),
    [facilityPatients],
  );

  const admitted = useMemo(
    () =>
      facilityPatients.filter((p) => {
        const s = (p.status ?? "Admitted").toLowerCase();
        return s === "admitted" || s === "active";
      }),
    [facilityPatients],
  );

  const filteredDischarged = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return discharged;
    return discharged.filter(
      (p) =>
        (p.mrn ?? "").toLowerCase().includes(q) ||
        fullName(p).toLowerCase().includes(q),
    );
  }, [discharged, search]);

  // Quick revenue summary across discharged patients in this facility (estimate)
  const revenueEstimate = useMemo(() => {
    return discharged.reduce((sum, p) => {
      const los = lengthOfStayDays(p.admission_time, p.discharge_time);
      return sum + los * (TARIFF.bed_per_day + TARIFF.consultant_per_day + TARIFF.nursing_per_day);
    }, 0);
  }, [discharged]);

  return (
    <main className="min-h-screen bg-slate-50">
      <BoardHeader
        title={`Finance & Accounts: ${officer.name} | ${officer.facility}`}
        badge="Finance · Revenue Cycle"
        subtitle={`${officer.ward} · Patient billing, charge capture & A/R`}
      />

      {/* KPI strip — Meditech Expanse rounded widgets */}
      <section className="grid grid-cols-1 md:grid-cols-4 gap-4 p-6 pb-2">
        <KpiCard
          icon={<Wallet className="h-4 w-4" />}
          label="Discharged · Ready to Bill"
          value={String(discharged.length)}
          tone="emerald"
        />
        <KpiCard
          icon={<Receipt className="h-4 w-4" />}
          label="Active Admissions (Accruing)"
          value={String(admitted.length)}
          tone="sky"
        />
        <KpiCard
          icon={<TrendingUp className="h-4 w-4" />}
          label="Est. Revenue (Discharged)"
          value={money(revenueEstimate)}
          tone="violet"
        />
        <KpiCard
          icon={<DollarSign className="h-4 w-4" />}
          label="Avg Bill / Encounter"
          value={money(discharged.length ? revenueEstimate / discharged.length : 0)}
          tone="amber"
        />
      </section>

      <section className="px-6 pb-6">
        <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-5 py-3">
            <div>
              <h2 className="text-sm font-semibold text-slate-900 flex items-center gap-2">
                <Receipt className="h-4 w-4 text-emerald-700" />
                Discharged Patients · Bill Generation Queue
              </h2>
              <p className="text-[11px] text-slate-500 mt-0.5">
                Each discharged encounter auto-aggregates labs, meds, bed days,
                and consultant charges by MRN. Click <strong>Generate Bill</strong>{" "}
                to render a hospital invoice.
              </p>
            </div>
            <div className="relative">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-slate-400" />
              <Input
                placeholder="Search by MRN or patient name…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-8 w-72"
              />
            </div>
          </div>

          {loading ? (
            <div className="grid place-items-center h-48 text-slate-500">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          ) : filteredDischarged.length === 0 ? (
            <div className="px-5 py-12 text-center text-sm text-slate-500">
              No discharged patients in this facility yet. Bills appear here
              automatically once a patient is discharged from the ward.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-[10px] font-bold uppercase tracking-widest text-slate-500">
                  <tr>
                    <th className="text-left px-4 py-2.5">MRN</th>
                    <th className="text-left px-4 py-2.5">Patient</th>
                    <th className="text-left px-4 py-2.5">Chief Complaint</th>
                    <th className="text-left px-4 py-2.5">Admitted</th>
                    <th className="text-left px-4 py-2.5">Discharged</th>
                    <th className="text-right px-4 py-2.5">LOS</th>
                    <th className="text-right px-4 py-2.5">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {filteredDischarged.map((p) => (
                    <tr key={p.id} className="hover:bg-slate-50">
                      <td className="px-4 py-3 font-mono text-xs text-slate-700">{p.mrn ?? "—"}</td>
                      <td className="px-4 py-3 font-medium text-slate-900">{fullName(p)}</td>
                      <td className="px-4 py-3 text-slate-600">{p.chief_complaint ?? "—"}</td>
                      <td className="px-4 py-3 text-xs font-mono text-slate-600">{fmtTs(p.admission_time)}</td>
                      <td className="px-4 py-3 text-xs font-mono text-slate-600">{fmtTs(p.discharge_time)}</td>
                      <td className="px-4 py-3 text-right text-slate-700">
                        {lengthOfStayDays(p.admission_time, p.discharge_time)} day(s)
                      </td>
                      <td className="px-4 py-3 text-right">
                        <Button
                          size="sm"
                          onClick={() => setSelected(p)}
                          className="bg-emerald-700 hover:bg-emerald-800 gap-1.5"
                        >
                          <Receipt className="h-3.5 w-3.5" />
                          Generate Bill
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>

      {selected && (
        <BillModal
          patient={selected}
          facility={facility}
          officer={officer.name}
          onClose={() => setSelected(null)}
        />
      )}
    </main>
  );
}

function KpiCard({
  icon,
  label,
  value,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  tone: "emerald" | "sky" | "violet" | "amber";
}) {
  const toneMap: Record<string, string> = {
    emerald: "bg-emerald-50 text-emerald-700 ring-emerald-200",
    sky: "bg-sky-50 text-sky-700 ring-sky-200",
    violet: "bg-violet-50 text-violet-700 ring-violet-200",
    amber: "bg-amber-50 text-amber-700 ring-amber-200",
  };
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex items-center justify-between">
        <div className="text-[10px] uppercase tracking-widest text-slate-500">{label}</div>
        <span className={`inline-grid place-items-center h-7 w-7 rounded-md ring-1 ${toneMap[tone]}`}>
          {icon}
        </span>
      </div>
      <div className="mt-2 text-2xl font-bold text-slate-900">{value}</div>
    </div>
  );
}

function BillModal({
  patient,
  facility,
  officer,
  onClose,
}: {
  patient: PatientRow;
  facility: string;
  officer: string;
  onClose: () => void;
}) {
  const [meds, setMeds] = useState<MedRow[]>([]);
  const [labs, setLabs] = useState<LabRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [paid, setPaid] = useState(false);

  useEffect(() => {
    if (!patient.mrn) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      const [medsRes, labsRes] = await Promise.all([
        supabase
          .from("medication_orders")
          .select("medication_name,drug_name,dose,route,status,administered_at")
          .eq("patient_mrn", patient.mrn),
        supabase
          .from("lab_orders")
          .select("test_type,status,result_value,collected_at")
          .eq("patient_mrn", patient.mrn),
      ]);
      if (cancelled) return;
      setMeds((medsRes.data ?? []) as MedRow[]);
      setLabs((labsRes.data ?? []) as LabRow[]);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [patient.mrn]);

  const administered = useMemo(
    () => meds.filter((m) => (m.status ?? "").toLowerCase() === "administered"),
    [meds],
  );
  const resulted = useMemo(
    () => labs.filter((l) => (l.status ?? "").toLowerCase() === "resulted"),
    [labs],
  );

  const los = lengthOfStayDays(patient.admission_time, patient.discharge_time);

  const lineItems = useMemo(() => {
    const items: { code: string; description: string; qty: number; rate: number; amount: number }[] = [];

    // Bed / Room charges
    items.push({
      code: "RB-101",
      description: `Inpatient Room & Board · General Ward (Room ${patient.room ?? "—"})`,
      qty: los,
      rate: TARIFF.bed_per_day,
      amount: los * TARIFF.bed_per_day,
    });

    // Nursing care
    items.push({
      code: "NC-220",
      description: "Nursing Care · 24-hour bedside coverage",
      qty: los,
      rate: TARIFF.nursing_per_day,
      amount: los * TARIFF.nursing_per_day,
    });

    // Consultant
    items.push({
      code: "MD-350",
      description: "Attending Consultant · Daily Rounds & Charting",
      qty: los,
      rate: TARIFF.consultant_per_day,
      amount: los * TARIFF.consultant_per_day,
    });

    // Lab tests
    if (resulted.length > 0) {
      items.push({
        code: "LAB-500",
        description: `Laboratory Diagnostics (${resulted.length} test${resulted.length === 1 ? "" : "s"})`,
        qty: resulted.length,
        rate: TARIFF.lab_per_test,
        amount: resulted.length * TARIFF.lab_per_test,
      });
    }

    // Medications
    if (administered.length > 0) {
      items.push({
        code: "RX-600",
        description: `Medication Administration (${administered.length} dose${administered.length === 1 ? "" : "s"})`,
        qty: administered.length,
        rate: TARIFF.med_per_dose,
        amount: administered.length * TARIFF.med_per_dose,
      });
      items.push({
        code: "RX-601",
        description: "Pharmacy Dispensing & Handling Fee",
        qty: 1,
        rate: TARIFF.pharmacy_handling,
        amount: TARIFF.pharmacy_handling,
      });
    }

    // Hospital admin + biomed
    items.push({
      code: "HSP-001",
      description: "Hospital Administration & Records Fee",
      qty: 1,
      rate: TARIFF.admin_fee,
      amount: TARIFF.admin_fee,
    });
    items.push({
      code: "HSP-010",
      description: "Biomedical Waste & Sterilization",
      qty: 1,
      rate: TARIFF.biomedical_waste,
      amount: TARIFF.biomedical_waste,
    });

    return items;
  }, [los, patient.room, resulted.length, administered.length]);

  const subtotal = lineItems.reduce((s, i) => s + i.amount, 0);
  const tax = subtotal * TARIFF.tax_rate;
  const total = subtotal + tax;

  const invoiceNo = `INV-${(patient.mrn ?? "0000").replace(/\D/g, "").slice(-6) || "000000"}-${new Date(patient.discharge_time ?? Date.now()).getTime().toString().slice(-5)}`;

  const handlePrint = () => window.print();

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-4xl max-h-[92vh] overflow-y-auto p-0 print:max-w-full print:max-h-none print:shadow-none">
        <DialogTitle className="sr-only">Hospital Invoice for {fullName(patient)}</DialogTitle>

        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-slate-200 bg-white/95 backdrop-blur px-6 py-3 print:hidden">
          <span className="text-[11px] font-mono uppercase tracking-widest text-slate-500">
            Invoice ID · {invoiceNo}
          </span>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant={paid ? "outline" : "default"}
              onClick={() => {
                setPaid(true);
                toast.success(`Invoice ${invoiceNo} marked as paid`);
              }}
              className={paid ? "" : "bg-emerald-700 hover:bg-emerald-800 gap-1.5"}
            >
              <CheckCircle2 className="h-3.5 w-3.5" />
              {paid ? "Paid" : "Mark as Paid"}
            </Button>
            <Button size="sm" variant="outline" onClick={handlePrint} className="gap-1.5">
              <Printer className="h-3.5 w-3.5" /> Print Invoice
            </Button>
          </div>
        </div>

        <div className="px-10 py-8 font-sans text-slate-800 print:px-12 print:py-10">
          {/* Letterhead */}
          <div className="flex items-start justify-between border-b-2 border-slate-900 pb-5 mb-6">
            <div>
              <h1 className="font-serif text-3xl font-bold tracking-tight text-slate-900">
                {facility}
              </h1>
              <p className="mt-1 text-[11px] font-semibold uppercase tracking-[0.3em] text-slate-600">
                Hospital Invoice · Corporate Finance & Accounts
              </p>
              <p className="text-[11px] text-slate-500 mt-1">
                S Group Private Network · TIN 84-2299104
              </p>
            </div>
            <div className="text-right text-xs">
              <div className="font-bold text-slate-900">Invoice #</div>
              <div className="font-mono">{invoiceNo}</div>
              <div className="mt-2 font-bold text-slate-900">Issued</div>
              <div className="font-mono">{fmtTs(new Date().toISOString())}</div>
              {paid && (
                <div className="mt-3 inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-emerald-700 ring-1 ring-emerald-300">
                  <CheckCircle2 className="h-3 w-3" /> Paid in Full
                </div>
              )}
            </div>
          </div>

          {/* Bill To */}
          <section className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
            <div className="rounded-md border border-slate-200 bg-slate-50/60 p-4 text-sm">
              <div className="text-[10px] font-bold uppercase tracking-widest text-slate-500 mb-2">
                Bill To · Patient
              </div>
              <div className="font-semibold text-slate-900">{fullName(patient)}</div>
              <div className="text-xs text-slate-600 mt-1">
                MRN: <span className="font-mono">{patient.mrn ?? "—"}</span>
              </div>
              <div className="text-xs text-slate-600">
                {patient.age ? `${patient.age} yrs · ` : ""}
                {patient.gender ?? ""}
              </div>
              <div className="text-xs text-slate-600 mt-1">
                Room: {patient.room ?? "—"}
              </div>
            </div>
            <div className="rounded-md border border-slate-200 bg-slate-50/60 p-4 text-sm">
              <div className="text-[10px] font-bold uppercase tracking-widest text-slate-500 mb-2">
                Encounter
              </div>
              <div className="text-xs">
                <span className="text-slate-500">Chief Complaint: </span>
                <span className="text-slate-900 font-medium">{patient.chief_complaint ?? "—"}</span>
              </div>
              <div className="text-xs mt-1">
                <span className="text-slate-500">Diagnosis: </span>
                <span className="text-slate-900">{patient.diagnosis ?? "—"}</span>
              </div>
              <div className="text-xs mt-1 font-mono">
                <span className="text-slate-500">Admitted: </span>{fmtTs(patient.admission_time)}
              </div>
              <div className="text-xs font-mono">
                <span className="text-slate-500">Discharged: </span>{fmtTs(patient.discharge_time)}
              </div>
              <div className="text-xs mt-1">
                <span className="text-slate-500">Length of Stay: </span>
                <strong>{los} day(s)</strong>
              </div>
            </div>
          </section>

          {loading ? (
            <div className="grid place-items-center h-32 text-slate-500">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          ) : (
            <>
              {/* Line items */}
              <section className="mb-6">
                <div className="text-[10px] font-bold uppercase tracking-widest text-slate-500 mb-2 flex items-center gap-1.5">
                  <FileText className="h-3 w-3" /> Itemized Charges
                </div>
                <table className="w-full text-sm border border-slate-200 rounded-md overflow-hidden">
                  <thead className="bg-slate-100 text-[10px] uppercase tracking-widest text-slate-600">
                    <tr>
                      <th className="text-left px-3 py-2 w-20">Code</th>
                      <th className="text-left px-3 py-2">Description</th>
                      <th className="text-right px-3 py-2 w-16">Qty</th>
                      <th className="text-right px-3 py-2 w-24">Rate</th>
                      <th className="text-right px-3 py-2 w-28">Amount</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {lineItems.map((it) => (
                      <tr key={it.code}>
                        <td className="px-3 py-2 font-mono text-xs text-slate-500">{it.code}</td>
                        <td className="px-3 py-2">{it.description}</td>
                        <td className="px-3 py-2 text-right font-mono">{it.qty}</td>
                        <td className="px-3 py-2 text-right font-mono">{money(it.rate)}</td>
                        <td className="px-3 py-2 text-right font-mono font-semibold">{money(it.amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>

              {/* Clinical detail appendix */}
              {(resulted.length > 0 || administered.length > 0) && (
                <section className="mb-6 grid grid-cols-1 md:grid-cols-2 gap-4">
                  {resulted.length > 0 && (
                    <div className="rounded-md border border-slate-200 p-3">
                      <div className="text-[10px] font-bold uppercase tracking-widest text-slate-500 mb-1.5">
                        Lab Tests Performed
                      </div>
                      <ul className="text-xs text-slate-700 list-disc pl-4 space-y-0.5">
                        {resulted.slice(0, 12).map((l, i) => (
                          <li key={i}>{l.test_type}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {administered.length > 0 && (
                    <div className="rounded-md border border-slate-200 p-3">
                      <div className="text-[10px] font-bold uppercase tracking-widest text-slate-500 mb-1.5">
                        Medications Administered
                      </div>
                      <ul className="text-xs text-slate-700 list-disc pl-4 space-y-0.5">
                        {administered.slice(0, 12).map((m, i) => (
                          <li key={i}>
                            {m.medication_name || m.drug_name} {m.dose ? `· ${m.dose}` : ""}{" "}
                            {m.route ? `(${m.route})` : ""}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </section>
              )}

              {/* Totals */}
              <section className="flex justify-end">
                <div className="w-full md:w-80 text-sm">
                  <div className="flex justify-between py-1.5 border-b border-slate-200">
                    <span className="text-slate-600">Subtotal</span>
                    <span className="font-mono">{money(subtotal)}</span>
                  </div>
                  <div className="flex justify-between py-1.5 border-b border-slate-200">
                    <span className="text-slate-600">Tax / GST ({(TARIFF.tax_rate * 100).toFixed(0)}%)</span>
                    <span className="font-mono">{money(tax)}</span>
                  </div>
                  <div className="flex justify-between py-2 mt-1 bg-slate-900 text-white px-3 rounded-md">
                    <span className="font-bold">TOTAL DUE</span>
                    <span className="font-mono font-bold">{money(total)}</span>
                  </div>
                </div>
              </section>

              {/* Footer */}
              <section className="mt-8 pt-4 border-t border-slate-200 text-[11px] text-slate-500 leading-relaxed">
                <p>
                  This invoice is auto-generated by the {facility} Corporate Finance & Accounts
                  department upon patient discharge. Charges are computed from the verified clinical
                  record (lab orders, medication administration, bed days, and consultant rounds)
                  attached to MRN {patient.mrn ?? "—"}. All amounts are in USD.
                </p>
                <p className="mt-3">
                  Processed by: <strong className="text-slate-700">{officer}</strong> · Corporate
                  Finance & Accounts · {facility}
                </p>
              </section>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}