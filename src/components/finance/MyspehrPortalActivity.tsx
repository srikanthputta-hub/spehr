import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { CalendarClock, Wallet, RefreshCw, Smartphone } from "lucide-react";
import { InfoHint } from "@/components/ui/info-hint";

/**
 * MySPEHR Portal Activity feed. Renders the most recent Appointment and
 * PaymentNotice rows that were pushed IN to spehr by the patient portal
 * via the fhir-inbound-webhook. Mirrors the style of CdsOverridesFeed:
 * quiet list, colored decision-style badge, expandable rows for the raw
 * detail. Facility-scoped so it matches the finance board's filter.
 */

type Appt = {
  id: string;
  fhir_id: string | null;
  facility_name: string;
  patient_mrn: string | null;
  patient_name: string;
  practitioner_name: string | null;
  service_type: string | null;
  description: string | null;
  start_time: string;
  end_time: string;
  status: string;
  comment: string | null;
  created_at: string;
};

type Payment = {
  id: string;
  fhir_id: string | null;
  invoice_id: string;
  mrn: string;
  amount: number;
  currency: string;
  status: string;
  payment_date: string;
  payment_method: string | null;
  payment_origin: string | null;
  created_at: string;
  invoice_no?: string | null;
};

function fmt(ts: string | null) {
  if (!ts) return "—";
  try { return new Date(ts).toLocaleString(); } catch { return ts; }
}

export function MyspehrPortalActivity({ facility }: { facility: string }) {
  const [appts, setAppts] = useState<Appt[]>([]);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    async function run() {
      setLoading(true);
      // Every row now carries a `fhir_id` (backfilled for pre-existing
      // reception-booked rows too), so `.not("fhir_id", "is", null)` would
      // show everything, not just portal-originated appointments. Filter
      // on `origin` instead.
      let apptQ = supabase
        .from("fhir_appointments")
        .select("*")
        .eq("origin", "myspehr")
        .order("created_at", { ascending: false })
        .limit(15);
      if (facility && facility !== "all") apptQ = apptQ.eq("facility_name", facility);

      const [aRes, pRes] = await Promise.all([
        apptQ,
        supabase
          .from("fhir_payment_notices")
          .select("*, fhir_invoices!inner(invoice_no, facility_name)")
          .in("payment_origin", ["patient-portal", "auto-pay-timeout"])
          .order("created_at", { ascending: false })
          .limit(15),
      ]);
      if (cancelled) return;
      setAppts((aRes.data ?? []) as any[]);
      const pRows = ((pRes.data ?? []) as any[])
        .filter((r) => {
          if (!facility || facility === "all") return true;
          return r?.fhir_invoices?.facility_name === facility;
        })
        .map((r) => ({ ...r, invoice_no: r?.fhir_invoices?.invoice_no ?? null }));
      setPayments(pRows as Payment[]);
      setLoading(false);
    }
    void run();
    return () => { cancelled = true; };
  }, [facility, nonce]);

  useEffect(() => {
    const ch = supabase
      .channel("myspehr-portal-activity")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "fhir_appointments" },
        () => setNonce((n) => n + 1),
      )
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "fhir_payment_notices" },
        () => setNonce((n) => n + 1),
      )
      .subscribe();
    return () => { void supabase.removeChannel(ch); };
  }, []);

  const isEmpty = !loading && appts.length === 0 && payments.length === 0;

  return (
    <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
      <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-5 py-3">
        <div className="flex items-center gap-2">
          <Smartphone className="h-4 w-4 text-indigo-700" />
          <div>
            <h2 className="text-sm font-semibold text-slate-900 flex items-center gap-1.5">
              MySPEHR Portal Activity
              <InfoHint
                className="ml-1"
                text="Appointments booked through the MySPEHR portal, plus invoice payments — either paid by the patient through the portal, or auto-paid on file after a 3-hour no-response timeout. Delivered here in real time via FHIR Subscription/DB update."
              />
            </h2>
          </div>
        </div>
        <button
          type="button"
          onClick={() => setNonce((n) => n + 1)}
          className="inline-flex items-center gap-1 text-xs text-slate-600 hover:text-slate-900"
        >
          <RefreshCw className="h-3.5 w-3.5" /> Refresh
        </button>
      </div>

      {loading ? (
        <div className="px-5 py-8 text-center text-xs text-slate-500">Loading…</div>
      ) : isEmpty ? (
        <div className="px-5 py-8 text-center text-xs text-slate-500">
          No portal activity yet. Once a MySPEHR patient books an appointment
          or pays an invoice, it lands here in real time.
        </div>
      ) : (
        <div className="grid gap-4 px-5 py-4 md:grid-cols-2">
          <ActivityColumn
            title="Appointments from MySPEHR"
            icon={<CalendarClock className="h-3.5 w-3.5 text-emerald-700" />}
            empty="No portal-booked appointments."
          >
            {appts.map((a) => (
              <li key={a.id} className="rounded-md border border-slate-200 bg-slate-50/50 p-2.5 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <div className="font-semibold text-slate-900 truncate">
                    {a.patient_name}
                    <span className="ml-2 font-normal text-slate-500">
                      {a.patient_mrn ?? "—"}
                    </span>
                  </div>
                  <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold text-emerald-700">
                    {a.status}
                  </span>
                </div>
                <div className="mt-1 text-slate-700">
                  {a.service_type ?? a.description ?? "Appointment"}
                </div>
                <div className="mt-0.5 text-slate-500">
                  {fmt(a.start_time)} · {a.facility_name}
                  {a.practitioner_name ? ` · ${a.practitioner_name}` : ""}
                </div>
              </li>
            ))}
          </ActivityColumn>

          <ActivityColumn
            title="Payments from MySPEHR"
            icon={<Wallet className="h-3.5 w-3.5 text-amber-700" />}
            empty="No portal payments yet."
          >
            {payments.map((p) => (
              <li key={p.id} className="rounded-md border border-slate-200 bg-slate-50/50 p-2.5 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <div className="font-semibold text-slate-900 truncate">
                    {p.invoice_no ?? p.invoice_id.slice(0, 8)}
                    <span className="ml-2 font-normal text-slate-500">
                      {p.mrn}
                    </span>
                  </div>
                  <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${
                    p.status.toLowerCase() === "paid"
                      ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                      : "border-slate-200 bg-white text-slate-600"
                  }`}>
                    {p.status}
                  </span>
                </div>
                <div className="mt-1 flex items-center gap-1.5 text-slate-700">
                  <span>
                    {p.currency} {Number(p.amount).toFixed(2)}
                    {p.payment_method ? ` · ${p.payment_method}` : ""}
                  </span>
                  {p.payment_origin === "auto-pay-timeout" ? (
                    <span className="rounded-full border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-amber-700">
                      Auto-paid · 3h timeout
                    </span>
                  ) : p.payment_origin === "patient-portal" ? (
                    <span className="rounded-full border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-emerald-700">
                      Paid by patient (portal)
                    </span>
                  ) : null}
                </div>
                <div className="mt-0.5 text-slate-500">{fmt(p.payment_date)}</div>
              </li>
            ))}
          </ActivityColumn>
        </div>
      )}
    </div>
  );
}

function ActivityColumn({
  title,
  icon,
  empty,
  children,
}: {
  title: string;
  icon: React.ReactNode;
  empty: string;
  children: React.ReactNode;
}) {
  const arr = Array.isArray(children) ? children : [children];
  const filtered = arr.filter(Boolean);
  return (
    <div>
      <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
        {icon} {title}
      </div>
      {filtered.length === 0 ? (
        <div className="rounded-md border border-dashed border-slate-200 px-3 py-4 text-center text-[11px] text-slate-400">
          {empty}
        </div>
      ) : (
        <ul className="space-y-2">{filtered}</ul>
      )}
    </div>
  );
}