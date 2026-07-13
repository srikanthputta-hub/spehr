import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { BoardHeader } from "@/components/BoardShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import { InfoHint } from "@/components/ui/info-hint";
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
  RefreshCw,
} from "lucide-react";
import { toast } from "sonner";
import { useFacility, useActiveStaff } from "@/lib/facility-context";
import { useServerFn } from "@tanstack/react-start";
import { backfillInvoices, generateInvoiceForMrn } from "@/lib/auto-doc.functions";
import { fetchWithTimeout } from "@/lib/async-timeout";
import { MyspehrPortalActivity } from "@/components/finance/MyspehrPortalActivity";

export const Route = createFileRoute("/finance-board")({
  component: FinanceBoard,
});

interface InvoiceRow {
  id: string;
  invoice_no: string;
  mrn: string;
  patient_name: string | null;
  encounter_id: string | null;
  facility_name: string | null;
  status: string;
  subtotal: number;
  tax: number;
  total: number;
  currency: string;
  issued_at: string;
  paid_at: string | null;
}

interface ChargeItemRow {
  id: string;
  invoice_id: string;
  charge_code: string;
  code_system: string;
  description: string;
  category: string;
  quantity: number;
  unit_price: number;
  amount: number;
  service_date: string | null;
}

interface PatientLite {
  mrn: string;
  name: string | null;
  age: number | null;
  gender: string | null;
  room: string | null;
  chief_complaint: string | null;
  diagnosis: string | null;
  admission_time: string | null;
  discharge_time: string | null;
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
  const [invoices, setInvoices] = useState<InvoiceRow[]>([]);
  const [patientTimes, setPatientTimes] = useState<
    Record<string, { admission_time: string | null; discharge_time: string | null }>
  >({});
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<InvoiceRow | null>(null);
  const [syncing, setSyncing] = useState(false);
  const backfill = useServerFn(backfillInvoices);
  const regenerate = useServerFn(generateInvoiceForMrn);

  const initialLoadRef = useRef(true);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = async () => {
    if (initialLoadRef.current) setLoading(true);
    const { data, error } = await fetchWithTimeout(
      () =>
        (supabase as any)
          .from("fhir_invoices")
          .select(
            "id,invoice_no,mrn,patient_name,encounter_id,facility_name,status,subtotal,tax,total,currency,issued_at,paid_at",
          )
          .order("issued_at", { ascending: false }),
      { data: [], error: null } as any,
    );
    if (error) toast.error(`Unable to load invoices: ${error.message}`);
    else {
      const rows = (data ?? []) as InvoiceRow[];
      const mrns = Array.from(new Set(rows.map((r) => r.mrn))).filter(Boolean);
      let times: Record<string, { admission_time: string | null; discharge_time: string | null }> = {};
      if (mrns.length > 0) {
        const { data: pts } = await (supabase as any)
          .from("patients")
          .select("mrn,admission_time,discharge_time")
          .in("mrn", mrns);
        for (const p of ((pts ?? []) as any[])) {
          times[String(p.mrn)] = {
            admission_time: p.admission_time ?? null,
            discharge_time: p.discharge_time ?? null,
          };
        }
        setPatientTimes(times);
      }
      // Sort the queue by actual discharge time (latest first) so users see
      // real chronology instead of the batch-cron `issued_at` clusters.
      // `issued_at` remains visible in the "Issued" column — only the
      // sort key changes here. Rows without a discharge_time (edge cases)
      // sink to the bottom.
      const dt = (mrn: string) => {
        const t = times[mrn]?.discharge_time;
        return t ? new Date(t).getTime() : -Infinity;
      };
      rows.sort((a, b) => dt(b.mrn) - dt(a.mrn));
      setInvoices(rows);
    }
    setLoading(false);
    initialLoadRef.current = false;
  };

  const scheduleRefresh = () => {
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    refreshTimerRef.current = setTimeout(() => {
      refreshTimerRef.current = null;
      refresh();
    }, 600);
  };

  useEffect(() => {
    refresh();
    // Auto-backfill any missing invoices on first mount.
    backfill({} as any).then((res: any) => {
      if (res?.generated > 0) refresh();
    }).catch(() => {});
    const channel = supabase
      .channel("finance-invoices")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "fhir_invoices" },
        () => scheduleRefresh(),
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "fhir_payment_notices" },
        () => scheduleRefresh(),
      )
      .subscribe();
    return () => {
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
      supabase.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const facilityInvoices = useMemo(
    () =>
      invoices.filter((i) => (i.facility_name ?? "Memorial Hospital") === facility),
    [invoices, facility],
  );

  const issued = useMemo(
    () => facilityInvoices.filter((i) => i.status === "issued"),
    [facilityInvoices],
  );
  const balanced = useMemo(
    () => facilityInvoices.filter((i) => i.status === "balanced"),
    [facilityInvoices],
  );

  const [tab, setTab] = useState<"active" | "settled">("active");
  const filtered = useMemo(() => {
    // Keep Active tab in lockstep with the "Issued Invoices · Awaiting
    // Payment" KPI (status === "issued"). Prior filter used status !==
    // "balanced" which double-counted draft/cancelled invoices.
    const base = tab === "settled" ? balanced : issued;
    const q = search.trim().toLowerCase();
    if (!q) return base;
    return base.filter(
      (i) =>
        i.mrn.toLowerCase().includes(q) ||
        (i.patient_name ?? "").toLowerCase().includes(q) ||
        i.invoice_no.toLowerCase().includes(q),
    );
  }, [issued, balanced, search, tab]);

  const totalRevenue = useMemo(
    () => facilityInvoices.reduce((s, i) => s + Number(i.total ?? 0), 0),
    [facilityInvoices],
  );
  const collected = useMemo(
    () => balanced.reduce((s, i) => s + Number(i.total ?? 0), 0),
    [balanced],
  );

  const handleSync = async () => {
    setSyncing(true);
    try {
      const res: any = await backfill({} as any);
      toast.success(`Sync complete · ${res?.generated ?? 0} invoice(s) generated`);
      await refresh();
    } catch (e) {
      toast.error(`Sync failed: ${(e as Error).message}`);
    } finally {
      setSyncing(false);
    }
  };

  const handleRegen = async (mrn: string) => {
    try {
      await regenerate({ data: { mrn } } as any);
      toast.success("Invoice regenerated from latest clinical course");
      await refresh();
    } catch (e) {
      toast.error(`Regenerate failed: ${(e as Error).message}`);
    }
  };

  return (
    <main className="min-h-screen bg-slate-50">
      <BoardHeader
        title={`Finance & Accounts: ${officer.name} | ${officer.facility}`}
        badge="Finance · Revenue Cycle"
        subtitle={`${officer.ward} · FHIR R4 Invoice & ChargeItem · Auto Doc pricing engine`}
      />

      {/* KPI strip — rounded widgets */}
      <section className="grid grid-cols-1 md:grid-cols-4 gap-4 p-6 pb-2">
        <KpiCard
          icon={<Wallet className="h-4 w-4" />}
          label="Issued Invoices · Awaiting Payment"
          value={String(issued.length)}
          tone="emerald"
        />
        <KpiCard
          icon={<Receipt className="h-4 w-4" />}
          label="Balanced (Paid) Invoices"
          value={String(balanced.length)}
          tone="sky"
        />
        <KpiCard
          icon={<TrendingUp className="h-4 w-4" />}
          label="Total Billed Revenue"
          value={money(totalRevenue)}
          tone="violet"
          info="Sum of ALL invoices at this facility regardless of status (issued + balanced) — not just money actually collected. The gap between Total Billed and Collected is the outstanding accounts receivable."
        />
        <KpiCard
          icon={<DollarSign className="h-4 w-4" />}
          label="Collected (Paid)"
          value={money(collected)}
          tone="amber"
          info="Sum of only FHIR Invoices with status = balanced at this facility — the portion patients have actually paid via the MySPEHR portal (FHIR PaymentNotice)."
        />
      </section>

      <section className="px-6 pb-6">
        <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-5 py-3">
            <div>
              <h2 className="text-sm font-semibold text-slate-900 flex items-center gap-2">
                <Receipt className="h-4 w-4 text-emerald-700" />
                {tab === "settled" ? "Settled · Paid Ledger" : "Active · Bill Generation Queue"}
                <InfoHint
                  className="ml-1"
                  text="Active shows invoices Auto Doc issued at discharge (FHIR Invoice + ChargeItem); Settled is the historical ledger of invoices fully paid by patients through MySPEHR (FHIR PaymentNotice) — an invoice moves from Active to Settled automatically the moment it's paid."
                />
              </h2>
            </div>
            <div className="flex items-center gap-2">
              <div className="inline-flex rounded-md border border-slate-200 overflow-hidden text-xs font-semibold">
                <button
                  type="button"
                  onClick={() => setTab("active")}
                  className={`px-3 h-8 ${tab === "active" ? "bg-emerald-700 text-white" : "bg-white text-slate-700 hover:bg-slate-50"}`}
                >
                  Active · {issued.length}
                </button>
                <button
                  type="button"
                  onClick={() => setTab("settled")}
                  className={`px-3 h-8 border-l border-slate-200 ${tab === "settled" ? "bg-emerald-700 text-white" : "bg-white text-slate-700 hover:bg-slate-50"}`}
                >
                  Settled · {balanced.length}
                </button>
              </div>
              <div className="relative">
                <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-slate-400" />
                <Input
                  placeholder="Search MRN / name / invoice #…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="pl-8 w-72"
                />
              </div>
              <Button
                size="sm"
                variant="outline"
                onClick={handleSync}
                disabled={syncing}
                className="gap-1.5"
              >
                {syncing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                Sync from Auto Doc
              </Button>
            </div>
          </div>

          {loading ? (
            <div className="grid place-items-center h-48 text-slate-500">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          ) : filtered.length === 0 ? (
            <div className="px-5 py-12 text-center text-sm text-slate-500">
              No invoices in this facility yet. They appear automatically once
              Auto Doc generates a FHIR Invoice for a discharged encounter.
            </div>
          ) : (
            <div className="scroll-feed max-h-[640px]">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 sticky top-0 z-10 text-[10px] font-bold uppercase tracking-widest text-slate-500">
                  <tr>
                    <th className="text-left px-4 py-2.5">Invoice #</th>
                    <th className="text-left px-4 py-2.5">MRN</th>
                    <th className="text-left px-4 py-2.5">Patient</th>
                    <th className="text-left px-4 py-2.5">Issued</th>
                    <th className="text-left px-4 py-2.5">Admitted</th>
                    <th className="text-left px-4 py-2.5">Discharged</th>
                    <th className="text-left px-4 py-2.5">Status</th>
                    <th className="text-right px-4 py-2.5">Total</th>
                    <th className="text-right px-4 py-2.5">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {filtered.slice(0, 150).map((i) => (
                    <tr key={i.id} className="hover:bg-slate-50">
                      <td className="px-4 py-3 font-mono text-xs text-slate-700">{i.invoice_no}</td>
                      <td className="px-4 py-3 font-mono text-xs text-slate-700">{i.mrn}</td>
                      <td className="px-4 py-3 font-medium text-slate-900">{i.patient_name ?? "—"}</td>
                      <td className="px-4 py-3 text-xs font-mono text-slate-600">{fmtTs(i.issued_at)}</td>
                      <td className="px-4 py-3 text-xs font-mono text-slate-600">{fmtTs(patientTimes[i.mrn]?.admission_time ?? null)}</td>
                      <td className="px-4 py-3 text-xs font-mono text-slate-600">{fmtTs(patientTimes[i.mrn]?.discharge_time ?? null)}</td>
                      <td className="px-4 py-3">
                        {i.status === "balanced" ? (
                          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-emerald-700 ring-1 ring-emerald-300">
                            <CheckCircle2 className="h-3 w-3" /> Paid
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-amber-700 ring-1 ring-amber-300">
                            Issued
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right font-mono font-semibold text-slate-900">
                        {money(Number(i.total))}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <div className="inline-flex gap-1.5">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => handleRegen(i.mrn)}
                            className="gap-1"
                            title="Re-run Auto Doc pricing for this encounter"
                          >
                            <RefreshCw className="h-3 w-3" />
                          </Button>
                          <Button
                            size="sm"
                            onClick={() => setSelected(i)}
                            className="bg-emerald-700 hover:bg-emerald-800 gap-1.5"
                          >
                            <Receipt className="h-3.5 w-3.5" />
                            View Invoice
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>

      <RiskAdjustmentGaps facility={facility} invoices={facilityInvoices} />

      <section className="px-6 pb-6">
        <MyspehrPortalActivity facility={facility} />
      </section>

      {selected && (
        <BillModal
          invoice={selected}
          facility={facility}
          officer={officer.name}
          onClose={() => setSelected(null)}
          onPaid={refresh}
        />
      )}
    </main>
  );
}

const CHRONIC_RE = /diabet|heart failure|chf|copd|renal|chronic kidney|dialysis/i;

function RiskAdjustmentGaps({
  facility,
  invoices,
}: {
  facility: string;
  invoices: InvoiceRow[];
}) {
  const [gaps, setGaps] = useState<
    Array<{ mrn: string; name: string; diagnosis: string }>
  >([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const mrns = Array.from(new Set(invoices.map((i) => i.mrn))).filter(Boolean);
      if (mrns.length === 0) {
        if (!cancelled) {
          setGaps([]);
          setLoading(false);
        }
        return;
      }
      const [patRes, ciRes] = await Promise.all([
        (supabase as any)
          .from("patients")
          .select("mrn,name,diagnosis,chief_complaint")
          .in("mrn", mrns),
        (supabase as any)
          .from("fhir_charge_items")
          .select("mrn,code_system")
          .in("mrn", mrns),
      ]);
      if (cancelled) return;
      const risk = new Set<string>();
      for (const r of ((ciRes?.data ?? []) as any[])) {
        if (String(r.code_system) === "ICD-10") risk.add(String(r.mrn));
      }
      const rows: Array<{ mrn: string; name: string; diagnosis: string }> = [];
      for (const p of ((patRes?.data ?? []) as any[])) {
        const dx = String(p.diagnosis ?? p.chief_complaint ?? "");
        if (!CHRONIC_RE.test(dx)) continue;
        if (risk.has(String(p.mrn))) continue;
        rows.push({
          mrn: String(p.mrn),
          name: String(p.name ?? "—"),
          diagnosis: dx || "—",
        });
      }
      setGaps(rows);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [invoices, facility]);

  return (
    <section className="px-6 pb-8">
      <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-200 px-5 py-3">
          <h2 className="text-sm font-semibold text-slate-900 flex items-center gap-2">
            <FileText className="h-4 w-4 text-amber-700" />
            Risk Adjustment Coverage Gaps
            <InfoHint
              className="ml-1"
              text="Discharged patients with a chronic diagnosis whose invoice has no ICD-10 risk-adjustment line, because no published Billing value set covers that code yet. Each gap shown here has also automatically filed a change request with Auto Terminologist so the missing code can be reviewed and added to a value set."
            />
          </h2>
        </div>
        {loading ? (
          <div className="grid place-items-center h-24 text-slate-500">
            <Loader2 className="h-4 w-4 animate-spin" />
          </div>
        ) : gaps.length === 0 ? (
          <div className="px-5 py-8 text-center text-sm text-slate-500">
            No coverage gaps detected in this facility.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-[10px] font-bold uppercase tracking-widest text-slate-500">
                <tr>
                  <th className="text-left px-4 py-2.5">MRN</th>
                  <th className="text-left px-4 py-2.5">Patient</th>
                  <th className="text-left px-4 py-2.5">Diagnosis</th>
                  <th className="text-right px-4 py-2.5">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {gaps.map((g) => (
                  <tr key={g.mrn} className="hover:bg-slate-50">
                    <td className="px-4 py-3 font-mono text-xs text-slate-700">{g.mrn}</td>
                    <td className="px-4 py-3 font-medium text-slate-900">{g.name}</td>
                    <td className="px-4 py-3 text-slate-700">{g.diagnosis}</td>
                    <td className="px-4 py-3 text-right">
                      <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-amber-700 ring-1 ring-amber-300">
                        Not captured
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}

function KpiCard({
  icon,
  label,
  value,
  tone,
  info,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  tone: "emerald" | "sky" | "violet" | "amber";
  info?: string;
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
        <div className="text-[10px] uppercase tracking-widest text-slate-500">
          {label}
          {info && <InfoHint className="ml-1" text={info} />}
        </div>
        <span className={`inline-grid place-items-center h-7 w-7 rounded-md ring-1 ${toneMap[tone]}`}>
          {icon}
        </span>
      </div>
      <div className="mt-2 text-2xl font-bold text-slate-900">{value}</div>
    </div>
  );
}

function BillModal({
  invoice,
  facility,
  officer,
  onClose,
  onPaid,
}: {
  invoice: InvoiceRow;
  facility: string;
  officer: string;
  onClose: () => void;
  onPaid?: () => void;
}) {
  const [items, setItems] = useState<ChargeItemRow[]>([]);
  const [patient, setPatient] = useState<PatientLite | null>(null);
  const [loading, setLoading] = useState(true);
  const paid = invoice.status === "balanced";

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [ciRes, pRes] = await fetchWithTimeout(
        () =>
          Promise.all([
            (supabase as any)
              .from("fhir_charge_items")
              .select("id,invoice_id,charge_code,code_system,description,category,quantity,unit_price,amount,service_date")
              .eq("invoice_id", invoice.id)
              .order("created_at", { ascending: true }),
            supabase
              .from("patients")
              .select("mrn,name,age,gender,room,chief_complaint,diagnosis,admission_time,discharge_time")
              .eq("mrn", invoice.mrn)
              .maybeSingle(),
          ]),
        [{ data: [], error: null }, { data: null, error: null }] as any,
      );
      if (cancelled) return;
      setItems((ciRes.data ?? []) as ChargeItemRow[]);
      setPatient((pRes.data ?? null) as PatientLite | null);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [invoice.id, invoice.mrn]);

  const subtotal = Number(invoice.subtotal);
  const tax = Number(invoice.tax);
  const total = Number(invoice.total);
  const invoiceNo = invoice.invoice_no;
  const los = patient ? lengthOfStayDays(patient.admission_time, patient.discharge_time) : 1;

  const handlePrint = () => window.print();

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-4xl max-h-[92vh] overflow-y-auto p-0 print:max-w-full print:max-h-none print:shadow-none">
        <DialogTitle className="sr-only">Hospital Invoice {invoiceNo}</DialogTitle>

        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-slate-200 bg-white/95 backdrop-blur px-6 py-3 print:hidden">
          <span className="text-[11px] font-mono uppercase tracking-widest text-slate-500">
            FHIR Invoice · {invoiceNo}
          </span>
          <div className="flex items-center gap-2">
            {paid && (
              <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-emerald-700 ring-1 ring-emerald-300">
                <CheckCircle2 className="h-3 w-3" /> Paid in Full
              </span>
            )}
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
              <div className="font-mono">{fmtTs(invoice.issued_at)}</div>
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
              <div className="font-semibold text-slate-900">{invoice.patient_name ?? "—"}</div>
              <div className="text-xs text-slate-600 mt-1">
                MRN: <span className="font-mono">{invoice.mrn}</span>
              </div>
              <div className="text-xs text-slate-600">
                {patient?.age ? `${patient.age} yrs · ` : ""}
                {patient?.gender ?? ""}
              </div>
              <div className="text-xs text-slate-600 mt-1">
                Room: {patient?.room ?? "—"}
              </div>
            </div>
            <div className="rounded-md border border-slate-200 bg-slate-50/60 p-4 text-sm">
              <div className="text-[10px] font-bold uppercase tracking-widest text-slate-500 mb-2">
                Encounter
              </div>
              <div className="text-xs">
                <span className="text-slate-500">Chief Complaint: </span>
                <span className="text-slate-900 font-medium">{patient?.chief_complaint ?? "—"}</span>
              </div>
              <div className="text-xs mt-1">
                <span className="text-slate-500">Diagnosis: </span>
                <span className="text-slate-900">{patient?.diagnosis ?? "—"}</span>
              </div>
              <div className="text-xs mt-1 font-mono">
                <span className="text-slate-500">Admitted: </span>{fmtTs(patient?.admission_time ?? null)}
              </div>
              <div className="text-xs font-mono">
                <span className="text-slate-500">Discharged: </span>{fmtTs(patient?.discharge_time ?? null)}
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
                  <FileText className="h-3 w-3" /> Itemized Charges · FHIR ChargeItems ({items.length})
                </div>
                <table className="w-full text-sm border border-slate-200 rounded-md overflow-hidden">
                  <thead className="bg-slate-100 text-[10px] uppercase tracking-widest text-slate-600">
                    <tr>
                      <th className="text-left px-3 py-2 w-28">Code</th>
                      <th className="text-left px-3 py-2">Description</th>
                      <th className="text-right px-3 py-2 w-16">Qty</th>
                      <th className="text-right px-3 py-2 w-24">Rate</th>
                      <th className="text-right px-3 py-2 w-28">Amount</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {items.map((it) => (
                      <tr key={it.id}>
                        <td className="px-3 py-2 font-mono text-xs text-slate-500">
                          {it.code_system !== "internal" ? `${it.code_system}:` : ""}
                          {it.charge_code}
                        </td>
                        <td className="px-3 py-2">{it.description}</td>
                        <td className="px-3 py-2 text-right font-mono">{it.quantity}</td>
                        <td className="px-3 py-2 text-right font-mono">{money(Number(it.unit_price))}</td>
                        <td className="px-3 py-2 text-right font-mono font-semibold">{money(Number(it.amount))}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>

              {/* Totals */}
              <section className="flex justify-end">
                <div className="w-full md:w-80 text-sm">
                  <div className="flex justify-between py-1.5 border-b border-slate-200">
                    <span className="text-slate-600">Subtotal</span>
                    <span className="font-mono">{money(subtotal)}</span>
                  </div>
                  <div className="flex justify-between py-1.5 border-b border-slate-200">
                    <span className="text-slate-600">Tax / GST</span>
                    <span className="font-mono">{money(tax)}</span>
                  </div>
                  <div className="flex justify-between py-2 mt-1 bg-slate-900 text-white px-3 rounded-md">
                    <span className="font-bold">TOTAL DUE</span>
                    <span className="font-mono font-bold">{money(total)}</span>
                  </div>
                  {onPaid && void 0}
                </div>
              </section>

              {/* Footer */}
              <section className="mt-8 pt-4 border-t border-slate-200 text-[11px] text-slate-500 leading-relaxed">
                <p>
                  This invoice is auto-generated by the {facility} Corporate Finance & Accounts
                  department upon patient discharge by the Auto Doc pricing engine. Each line item
                  is stored as a FHIR <code>ChargeItem</code> resource linked to this FHIR{" "}
                  <code>Invoice</code> ({invoiceNo}) for MRN {invoice.mrn}. All amounts in USD.
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