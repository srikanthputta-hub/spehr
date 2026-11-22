import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { BoardHeader } from "@/components/BoardShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { InfoHint } from "@/components/ui/info-hint";
import { Loader2, Receipt, Printer, Search, FileText, CheckCircle2, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { useFacility, useActiveStaff } from "@/lib/facility-context";
import { useServerFn } from "@tanstack/react-start";
import { backfillInvoices, generateInvoiceForMrn } from "@/lib/auto-doc.functions";
import { fetchWithTimeout, DEFAULT_FETCH_TIMEOUT_MS } from "@/lib/async-timeout";
import { MyspehrPortalActivity } from "@/components/finance/MyspehrPortalActivity";
import { StatusBadge } from "@/components/common/StatusBadge";
import { KpiTile } from "@/components/common/KpiTile";
import { EmptyState } from "@/components/common/EmptyState";
import { TableSkeleton } from "@/components/common/LoadingSkeleton";
import { severityRowVariants } from "@/components/common/SeverityRow";
import { cn } from "@/lib/utils";

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
  payment_origin: string | null;
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

// L17: the invoice dialog showed "Length of Stay: 1 day(s)" for a genuine
// 12-minute encounter — the old helper here rounded up to a whole day
// regardless of actual duration, which is misleading as a literal
// duration on a bill. This is for display only (billing itself is now
// prorated server-side — see lengthOfStayFractionalDays() in
// src/lib/billing-pricing.ts) and shows hours/minutes under one day.
function formatLengthOfStay(admit: string | null, discharge: string | null): string {
  if (!admit) return "—";
  const end = discharge ? new Date(discharge).getTime() : Date.now();
  const ms = end - new Date(admit).getTime();
  if (!isFinite(ms) || ms <= 0) return "—";
  const totalMinutes = Math.round(ms / 60_000);
  if (totalMinutes < 60) return `${totalMinutes} min`;
  if (totalMinutes < 24 * 60) {
    const hours = Math.floor(totalMinutes / 60);
    const mins = totalMinutes % 60;
    return mins > 0 ? `${hours} hr ${mins} min` : `${hours} hr`;
  }
  const days = Math.ceil(ms / 86_400_000);
  return `${days} day(s)`;
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

  const refresh = async (opts?: { longTimeout?: boolean; isRetry?: boolean }) => {
    const isInitialLoad = initialLoadRef.current;
    if (isInitialLoad) setLoading(true);
    // The very first fetch on a fresh tab (and its one retry, see below)
    // pay for cold Supabase client setup (auth bootstrap, Realtime WS
    // handshake racing the same network) on top of the actual query, so
    // the default 5s budget (fine for every later refresh) was tight
    // enough to time out and silently fall back to `{ data: [] }` —
    // `error` stays null, so no toast fires either, and the board
    // confidently renders "No invoices in this facility yet" even though
    // `backfill-invoices-every-30min` (see CLAUDE.md) has already kept
    // fhir_invoices fully current server-side. That's H15: not a
    // missing-data problem, a connection-reliability one. Keyed on `opts`
    // rather than `initialLoadRef` directly, since that ref already flips
    // to false by the time a scheduled retry actually runs.
    const longTimeout = opts?.longTimeout ?? isInitialLoad;
    const { data, error } = await fetchWithTimeout(
      async () => {
        const res = await supabase
          .from("fhir_invoices")
          .select(
            "id,invoice_no,mrn,patient_name,encounter_id,facility_name,status,subtotal,tax,total,currency,issued_at,paid_at,payment_origin",
          )
          .order("issued_at", { ascending: false });
        return { data: res.data, error: res.error };
      },
      { data: [], error: null },
      longTimeout ? 12_000 : DEFAULT_FETCH_TIMEOUT_MS,
    );
    if (error) toast.error(`Unable to load invoices: ${error.message}`);
    else {
      const rows = (data ?? []) as InvoiceRow[];
      const mrns = Array.from(new Set(rows.map((r) => r.mrn))).filter(Boolean);
      // Seed from the previously-known map so a partial/failed patients
      // fetch on a realtime-triggered refresh doesn't collapse every row
      // to -Infinity and fall back to the DB's `issued_at DESC` order.
      const times: Record<
        string,
        { admission_time: string | null; discharge_time: string | null }
      > = {
        ...patientTimes,
      };
      if (mrns.length > 0) {
        const { data: pts, error: pErr } = await supabase
          .from("patients")
          .select("mrn,admission_time,discharge_time")
          .in("mrn", mrns);
        if (pErr) console.warn("[finance-board] patients join failed", pErr.message);
        for (const p of pts ?? []) {
          times[String(p.mrn)] = {
            admission_time: p.admission_time ?? null,
            discharge_time: p.discharge_time ?? null,
          };
        }
        setPatientTimes(times);
      }
      // Sort by actual discharge time (latest first) so users see real
      // chronology instead of the batch-cron `issued_at` clusters. Sort a
      // shallow copy — the PostgREST response array can be non-writable in
      // some transport paths, which silently no-ops in-place sort and left
      // the queue in DB-returned `issued_at DESC` order. Tiebreaker on
      // `issued_at` keeps deterministic order when two invoices share a
      // discharge_time; rows without a discharge_time sink to the bottom.
      const dt = (mrn: string) => {
        const t = times[String(mrn)]?.discharge_time;
        return t ? new Date(t).getTime() : -Infinity;
      };
      const sorted = [...rows].sort((a, b) => {
        const diff = dt(b.mrn) - dt(a.mrn);
        if (diff !== 0) return diff;
        const ai = a.issued_at ? new Date(a.issued_at).getTime() : 0;
        const bi = b.issued_at ? new Date(b.issued_at).getTime() : 0;
        return bi - ai;
      });
      setInvoices(sorted);
      // H15: don't trust a completely-empty FIRST read at face value. The
      // cron-driven backfill keeps fhir_invoices current server-side
      // independent of anyone opening this page (confirmed: `generated: 0`
      // steady-state in auto_terminologist-style logs — see
      // backfill-invoices-every-30min), so a real facility with zero
      // invoices is rare; far more often, zero rows on the *first* read of
      // a fresh tab means the cold-start race above still lost. Retry the
      // read exactly once, cheaply (no backfill re-run) — this is the
      // "fix the connection" half of H15, as opposed to re-running the
      // whole sync pipeline redundantly on every page load.
      if (isInitialLoad && rows.length === 0 && !opts?.isRetry) {
        setTimeout(() => {
          refresh({ longTimeout: true, isRetry: true });
        }, 1200);
      }
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
    // H15: this used to also fire `backfill()` (the full
    // backfillMissingInvoices() pipeline) on every single mount, in every
    // tab, on top of the `backfill-invoices-every-30min` pg_cron job that
    // already runs the exact same function server-side on a schedule.
    // Confirmed live: that cron job is healthy and returns `generated: 0`
    // in steady state (nothing ever left for a page-load to "catch"), so
    // the old `if (res?.generated > 0) refresh()` guard was effectively
    // dead code — it could never fire in practice, which is exactly why
    // this bug could persist even though "auto-backfill" was already
    // wired up here. Removed the redundant resync; see the retry-on-empty
    // logic in refresh() above for the actual fix (reading the cron's
    // already-correct data reliably, not redoing its work).
    refresh();
    const channel = supabase
      .channel("finance-invoices")
      .on("postgres_changes", { event: "*", schema: "public", table: "fhir_invoices" }, () =>
        scheduleRefresh(),
      )
      .on("postgres_changes", { event: "*", schema: "public", table: "fhir_payment_notices" }, () =>
        scheduleRefresh(),
      )
      .subscribe();
    return () => {
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
      supabase.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const facilityInvoices = useMemo(
    () => invoices.filter((i) => (i.facility_name ?? "Memorial Hospital") === facility),
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

  // L16: this table used to hard-cap at `filtered.slice(0, 150)` with no
  // paging and no indication that a facility with more than 150
  // issued/balanced invoices was missing rows entirely — a facility doing
  // steady volume crosses that within days. Real pagination instead of a
  // silent cutoff.
  const INVOICE_PAGE_SIZE = 50;
  const [invoicePage, setInvoicePage] = useState(1);
  useEffect(() => {
    setInvoicePage(1);
  }, [tab, search]);
  const invoiceTotalPages = Math.max(1, Math.ceil(filtered.length / INVOICE_PAGE_SIZE));
  const invoicePageClamped = Math.min(invoicePage, invoiceTotalPages);
  const pagedInvoices = useMemo(
    () =>
      filtered.slice(
        (invoicePageClamped - 1) * INVOICE_PAGE_SIZE,
        invoicePageClamped * INVOICE_PAGE_SIZE,
      ),
    [filtered, invoicePageClamped],
  );

  const totalRevenue = useMemo(
    () => facilityInvoices.reduce((s, i) => s + Number(i.total ?? 0), 0),
    [facilityInvoices],
  );
  const collected = useMemo(
    () => balanced.reduce((s, i) => s + Number(i.total ?? 0), 0),
    [balanced],
  );
  // L18: "Collected" blends real MySPEHR portal payments with invoices
  // that auto-paid themselves after a 3-hour no-response timeout — the
  // latter has no actual payment method on file anywhere (it's a status
  // flip, not a transaction), so a figure that's mostly or entirely
  // auto-paid can look like real cash collected with nothing on the
  // board calling that out beyond a small per-row badge. Surface the
  // simulated share explicitly next to the KPI itself.
  const autoPaidCollected = useMemo(
    () =>
      balanced
        .filter((i) => i.payment_origin === "auto-pay-timeout")
        .reduce((s, i) => s + Number(i.total ?? 0), 0),
    [balanced],
  );

  const handleSync = async () => {
    setSyncing(true);
    try {
      const res = await backfill();
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
      await regenerate({ data: { mrn } });
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

      {/* KPI strip */}
      <section className="grid grid-cols-1 md:grid-cols-4 gap-4 p-6 pb-2">
        <KpiTile value={issued.length} label="Issued Invoices · Awaiting Payment" />
        <KpiTile value={balanced.length} label="Balanced (Paid) Invoices" />
        <div className="relative">
          {/*
            pr-10 reserves a gutter the full height of the tile for the
            absolutely-positioned InfoHint icon (top-4 right-4, ~18px +
            offset). Without it, the headline value has no right padding
            of its own, so a large dollar figure (7+ digits) can run its
            text under the icon instead of wrapping clear of it.
          */}
          <KpiTile value={money(totalRevenue)} label="Total Billed Revenue" className="pr-10" />
          <InfoHint
            className="absolute top-4 right-4"
            text="Sum of ALL invoices at this facility regardless of status (issued + balanced) — not just money actually collected. The gap between Total Billed and Collected is the outstanding accounts receivable."
          />
        </div>
        <div className="relative">
          <KpiTile value={money(collected)} label="Collected (Paid)" className="pr-10" />
          <InfoHint
            className="absolute top-4 right-4"
            text="Sum of only FHIR Invoices with status = balanced at this facility — money actually collected, either paid by the patient via the MySPEHR portal, or auto-paid on file after a 3-hour no-response timeout. The auto-paid share is simulated: no real payment method is ever captured for it, it's a status flip, not a transaction."
          />
          {autoPaidCollected > 0 && (
            <div
              className="mt-1 px-4 text-[11px] font-medium text-amber-700"
              title="These invoices have no real payment method on file anywhere — auto-pay-on-timeout only flips the invoice's status to balanced, it never collects anything"
            >
              ⚠ {money(autoPaidCollected)} of this is simulated auto-pay — no real payment on file
              {autoPaidCollected === collected ? " (all of it)" : ""}
            </div>
          )}
        </div>
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
                  text="Active shows invoices Auto Doc issued at discharge (FHIR Invoice + ChargeItem); Settled is the historical ledger of invoices that have been paid — either by the patient through MySPEHR, or auto-paid on file after a 3-hour no-response timeout (both post a FHIR PaymentNotice) — an invoice moves from Active to Settled automatically the moment it's paid."
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
                {syncing ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="h-3.5 w-3.5" />
                )}
                Sync from Auto Doc
              </Button>
            </div>
          </div>

          {loading ? (
            <div className="p-5">
              <TableSkeleton rows={6} columns={9} />
            </div>
          ) : filtered.length === 0 ? (
            <EmptyState
              icon={Receipt}
              description="No invoices in this facility yet. They appear automatically once Auto Doc generates a FHIR Invoice for a discharged encounter."
            />
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
                  {pagedInvoices.map((i) => (
                    <tr key={i.id} className="hover:bg-slate-50">
                      <td className="px-4 py-3 font-mono text-xs text-slate-700">{i.invoice_no}</td>
                      <td className="px-4 py-3 font-mono text-xs text-slate-700">{i.mrn}</td>
                      <td className="px-4 py-3 font-medium text-slate-900">
                        {i.patient_name ?? "—"}
                      </td>
                      <td className="px-4 py-3 text-xs font-mono text-slate-600">
                        {fmtTs(i.issued_at)}
                      </td>
                      <td className="px-4 py-3 text-xs font-mono text-slate-600">
                        {fmtTs(patientTimes[i.mrn]?.admission_time ?? null)}
                      </td>
                      <td className="px-4 py-3 text-xs font-mono text-slate-600">
                        {fmtTs(patientTimes[i.mrn]?.discharge_time ?? null)}
                      </td>
                      <td className="px-4 py-3">
                        {i.status === "balanced" ? (
                          <div className="inline-flex items-center gap-1">
                            <StatusBadge
                              status="success"
                              label="Paid"
                              icon={<CheckCircle2 className="h-3 w-3" />}
                            />
                            {i.payment_origin === "auto-pay-timeout" ? (
                              <StatusBadge
                                status="warning"
                                label="Auto-paid"
                                title="Simulated — no real payment method on file. No portal payment within 3h of discharge, so the invoice's status was flipped to balanced automatically; no transaction actually occurred."
                              />
                            ) : i.payment_origin === "patient-portal" ? (
                              <StatusBadge status="info" label="Portal" />
                            ) : i.payment_origin === "staff" ? (
                              <StatusBadge status="neutral" label="Staff" />
                            ) : null}
                          </div>
                        ) : (
                          <StatusBadge status="warning" label="Issued" />
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
          {!loading && filtered.length > 0 && (
            <div className="flex items-center justify-between gap-3 border-t border-slate-200 px-4 py-2 text-xs text-slate-600">
              <span>
                Showing {(invoicePageClamped - 1) * INVOICE_PAGE_SIZE + 1}–
                {Math.min(invoicePageClamped * INVOICE_PAGE_SIZE, filtered.length)} of{" "}
                {filtered.length}
              </span>
              <div className="flex items-center gap-1.5">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 px-2 text-xs"
                  disabled={invoicePageClamped <= 1}
                  onClick={() => setInvoicePage((p) => Math.max(1, p - 1))}
                >
                  Previous
                </Button>
                <span className="font-mono">
                  {invoicePageClamped} / {invoiceTotalPages}
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 px-2 text-xs"
                  disabled={invoicePageClamped >= invoiceTotalPages}
                  onClick={() => setInvoicePage((p) => Math.min(invoiceTotalPages, p + 1))}
                >
                  Next
                </Button>
              </div>
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

function RiskAdjustmentGaps({ facility, invoices }: { facility: string; invoices: InvoiceRow[] }) {
  const [gaps, setGaps] = useState<Array<{ mrn: string; name: string; diagnosis: string }>>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      // Scope to the CURRENT encounter's invoice per MRN, not the MRN's
      // whole lifetime history. `invoices` arrives already sorted
      // latest-discharge-first (see refresh() in FinanceBoard), so the
      // first invoice seen for a given MRN is that patient's current/most
      // recent encounter — a prior encounter's invoice having an ICD-10
      // line must never mask a gap on the current one.
      const mrnToInvoiceId = new Map<string, string>();
      for (const inv of invoices) {
        if (inv.mrn && !mrnToInvoiceId.has(inv.mrn)) mrnToInvoiceId.set(inv.mrn, inv.id);
      }
      const mrns = Array.from(mrnToInvoiceId.keys());
      if (mrns.length === 0) {
        if (!cancelled) {
          setGaps([]);
          setLoading(false);
        }
        return;
      }
      const invoiceIds = Array.from(new Set(mrnToInvoiceId.values()));
      const [patRes, ciRes] = await Promise.all([
        supabase.from("patients").select("mrn,name,diagnosis,chief_complaint").in("mrn", mrns),
        supabase
          .from("fhir_charge_items")
          .select("invoice_id,code_system")
          .in("invoice_id", invoiceIds),
      ]);
      if (cancelled) return;
      // Keyed by invoice_id (the specific encounter being evaluated), not
      // by mrn — an ICD-10 line on a different past invoice for the same
      // MRN must not count as coverage for this one.
      const riskByInvoice = new Set<string>();
      for (const r of ciRes?.data ?? []) {
        if (String(r.code_system) === "ICD-10") riskByInvoice.add(String(r.invoice_id));
      }
      const rows: Array<{ mrn: string; name: string; diagnosis: string }> = [];
      for (const p of patRes?.data ?? []) {
        const dx = String(p.diagnosis ?? p.chief_complaint ?? "");
        if (!CHRONIC_RE.test(dx)) continue;
        const invoiceId = mrnToInvoiceId.get(String(p.mrn));
        if (invoiceId && riskByInvoice.has(invoiceId)) continue;
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
              text="Discharged patients with a chronic diagnosis whose invoice has no ICD-10 risk-adjustment line, because no published Billing value set covers that code yet. Separately, when a patient's invoice is generated, any of their recorded ICD-10 diagnosis codes not covered by a published Billing value set files a change request with Auto Terminologist — but that only fires for patients with a recorded ICD-10 code, so it is not guaranteed for every gap listed here."
            />
          </h2>
        </div>
        {loading ? (
          <div className="p-5">
            <TableSkeleton rows={3} columns={4} />
          </div>
        ) : gaps.length === 0 ? (
          // L18: this check is narrow and correct for what it actually
          // measures (discharged, chronic-diagnosis patients at this
          // facility whose CURRENT invoice has no ICD-10 risk-adjustment
          // line) — it was never wrong about that. The wording was: "No
          // coverage gaps" reads as a system-wide, unqualified claim, and
          // the Auto Terminologist review queue can simultaneously have a
          // real, large backlog of open terminology gaps for entirely
          // different consumers (Safety Alerts, HRRP, Drug-Allergy pairs,
          // ...) that this panel never touches. Scope the message
          // explicitly so it can't be read as "the system has no open
          // terminology work" when it's really "this one invoice-level
          // check passed."
          <EmptyState description="No risk-adjustment coverage gaps on currently-displayed invoices in this facility. This checks only ICD-10-vs-published-Billing-value-set coverage on these invoices — it is not a count of all open Auto Terminologist requests system-wide (see Medical Dictionary → Auto Terminologist Activity for those)." />
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
                    {/*
                      Per the CSS table-rendering spec, a border set directly
                      on a <tr> is never painted under border-collapse:
                      separate (this table's default — it never sets
                      border-collapse) — only td/th borders render. So the
                      critical accent stripe goes on the first <td> instead.
                      `-ml-px` from severityRowVariants is a margin, which
                      also has no effect on table cells, but is harmless;
                      `border-l-4`/`pl-3` are what actually render it. `pl-3`
                      (not `px-4`) matches this table's other cells' 16px
                      left inset exactly: 4px border + 12px padding = 16px.
                    */}
                    <td
                      className={cn(
                        severityRowVariants({ severity: "critical" }),
                        "py-3 pr-4 font-mono text-xs text-slate-700",
                      )}
                    >
                      {g.mrn}
                    </td>
                    <td className="px-4 py-3 font-medium text-slate-900">{g.name}</td>
                    <td className="px-4 py-3 text-slate-700">{g.diagnosis}</td>
                    <td className="px-4 py-3 text-right">
                      <StatusBadge status="critical" label="Not Captured" />
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

function PatientFieldSkeleton({ rows = 2 }: { rows?: number }) {
  return (
    <div className="mt-1.5 space-y-1.5" aria-label="Loading patient details">
      {Array.from({ length: rows }).map((_, i) => (
        <div
          key={i}
          className="h-2.5 animate-pulse rounded bg-slate-200"
          style={{ width: `${70 - i * 8}%` }}
        />
      ))}
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
      const [ciRes, pRes] = await fetchWithTimeout(async () => {
        const [chargeRes, patientRes] = await Promise.all([
          supabase
            .from("fhir_charge_items")
            .select(
              "id,invoice_id,charge_code,code_system,description,category,quantity,unit_price,amount,service_date",
            )
            .eq("invoice_id", invoice.id)
            .order("created_at", { ascending: true }),
          supabase
            .from("patients")
            .select(
              "mrn,name,age,gender,room,chief_complaint,diagnosis,admission_time,discharge_time",
            )
            .eq("mrn", invoice.mrn)
            .maybeSingle(),
        ]);
        return [
          { data: chargeRes.data, error: chargeRes.error },
          { data: patientRes.data, error: patientRes.error },
        ];
      }, [
        { data: [], error: null },
        { data: null, error: null },
      ]);
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
  const losDisplay = patient
    ? formatLengthOfStay(patient.admission_time, patient.discharge_time)
    : "—";

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
              <StatusBadge
                status="success"
                label="Paid in Full"
                icon={<CheckCircle2 className="h-3 w-3" />}
              />
            )}
            <Button size="sm" variant="outline" onClick={handlePrint} className="gap-1.5">
              <Printer className="h-3.5 w-3.5" /> Print Invoice
            </Button>
          </div>
        </div>

        <div className="px-10 py-8 font-sans text-slate-800 print:px-12 print:py-10">
          {/* Letterhead */}
          <div className="flex items-start justify-between border-b-2 border-slate-900 pb-5 mb-6 print:break-inside-avoid">
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
                <div className="mt-3">
                  <StatusBadge
                    status="success"
                    label="Paid in Full"
                    icon={<CheckCircle2 className="h-3 w-3" />}
                  />
                </div>
              )}
            </div>
          </div>

          {/*
            L17: everything below that depends on `patient` used to render
            with `patient` still null for the first ~5s (the same
            cold-client-connection pattern as H15, here on the dialog's own
            fetch) — not blank, but confidently WRONG: "Room: —",
            "Length of Stay: 1 day(s)" (now "—", see formatLengthOfStay)
            for a patient who may have had a 10+ day stay. A skeleton that
            visibly says "loading" is honest; a dash that looks like a
            real, already-loaded value is not. Gate every patient-derived
            field on `loading` instead of letting optional-chaining
            fallbacks stand in for real data.
          */}
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
              {loading ? (
                <PatientFieldSkeleton />
              ) : (
                <>
                  <div className="text-xs text-slate-600">
                    {patient?.age ? `${patient.age} yrs · ` : ""}
                    {patient?.gender ?? ""}
                  </div>
                  <div className="text-xs text-slate-600 mt-1">Room: {patient?.room ?? "—"}</div>
                </>
              )}
            </div>
            <div className="rounded-md border border-slate-200 bg-slate-50/60 p-4 text-sm">
              <div className="text-[10px] font-bold uppercase tracking-widest text-slate-500 mb-2">
                Encounter
              </div>
              {loading ? (
                <PatientFieldSkeleton rows={5} />
              ) : (
                <>
                  <div className="text-xs">
                    <span className="text-slate-500">Chief Complaint: </span>
                    <span className="text-slate-900 font-medium">
                      {patient?.chief_complaint ?? "—"}
                    </span>
                  </div>
                  <div className="text-xs mt-1">
                    <span className="text-slate-500">Diagnosis: </span>
                    <span className="text-slate-900">{patient?.diagnosis ?? "—"}</span>
                  </div>
                  <div className="text-xs mt-1 font-mono">
                    <span className="text-slate-500">Admitted: </span>
                    {fmtTs(patient?.admission_time ?? null)}
                  </div>
                  <div className="text-xs font-mono">
                    <span className="text-slate-500">Discharged: </span>
                    {fmtTs(patient?.discharge_time ?? null)}
                  </div>
                  <div className="text-xs mt-1">
                    <span className="text-slate-500">Length of Stay: </span>
                    <strong>{losDisplay}</strong>
                  </div>
                </>
              )}
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
                  <FileText className="h-3 w-3" /> Itemized Charges · FHIR ChargeItems (
                  {items.length})
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
                        <td className="px-3 py-2 text-right font-mono">
                          {money(Number(it.unit_price))}
                        </td>
                        <td className="px-3 py-2 text-right font-mono font-semibold">
                          {money(Number(it.amount))}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>

              {/* Totals */}
              <section className="flex justify-end print:break-inside-avoid">
                <div className="w-full md:w-80 text-sm">
                  <div className="flex justify-between py-1.5 border-b border-slate-200">
                    <span className="text-slate-600">Subtotal</span>
                    <span className="font-mono">{money(subtotal)}</span>
                  </div>
                  <div className="flex justify-between py-1.5 border-b border-slate-200">
                    {/*
                      L17: "GST" (Goods and Services Tax) isn't a US tax
                      term — this is a flat facility surcharge applied to
                      every invoice at this US-facility hospital, not a
                      government sales/goods tax, so labeling it "Tax /
                      GST" was simply the wrong term, not a sign the
                      underlying charge itself needs to change. Renamed to
                      what it actually is; the FHIR Invoice resource's
                      underlying priceComponent.type stays "tax" (a fixed,
                      correct enum value from the FHIR spec) — only this
                      user-facing label changes.
                    */}
                    <span
                      className="text-slate-600"
                      title="A flat facility & administrative surcharge applied to every invoice — not a government sales or goods/services tax"
                    >
                      Facility & Administrative Fee
                      {subtotal > 0 && ` (${((tax / subtotal) * 100).toFixed(0)}%)`}
                    </span>
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
