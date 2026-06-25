import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Loader2,
  Receipt,
  CreditCard,
  CheckCircle2,
  ShieldCheck,
  ChevronRight,
  FileText,
  Lock,
  Wallet,
  Calendar,
  MessageSquare,
  Activity,
  Plus,
  Send,
  Thermometer,
  Clock,
  Heart,
  Droplet,
} from "lucide-react";
import { toast } from "sonner";
import { useServerFn } from "@tanstack/react-start";
import { payInvoice } from "@/lib/auto-doc.functions";
import spehrLogo from "@/assets/spehr-logo.png.asset.json";
import { PlainEnglish } from "@/components/myspehr/PlainEnglish";
import { FileHeart, Pill, FlaskConical, AlertTriangle } from "lucide-react";

/* ----------------------------------------------------------------- */
/* Plain English Mode — global toggle persisted in localStorage      */
/* ----------------------------------------------------------------- */
function usePlainEnglishMode(): [boolean, (v: boolean) => void] {
  const [on, setOn] = useState<boolean>(() => {
    try { return localStorage.getItem("myspehr.plainEnglish") !== "0"; } catch { return true; }
  });
  const set = (v: boolean) => {
    setOn(v);
    try { localStorage.setItem("myspehr.plainEnglish", v ? "1" : "0"); } catch {}
  };
  return [on, set];
}

export const Route = createFileRoute("/my-spehr")({
  head: () => ({
    meta: [
      { title: "MySPEHR · Patient Portal" },
      { name: "description", content: "MySPEHR mobile patient portal — view appointments, records and pay your hospital bills." },
      { name: "viewport", content: "width=device-width, initial-scale=1, maximum-scale=1" },
    ],
  }),
  component: MySpehrApp,
});

interface InvoiceRow {
  id: string;
  invoice_no: string;
  mrn: string;
  patient_name: string | null;
  facility_name: string | null;
  status: string;
  subtotal: number;
  tax: number;
  total: number;
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
}

function money(n: number) {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD" });
}
function fmtDate(ts: string | null) {
  if (!ts) return "—";
  const d = new Date(ts);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function MySpehrApp() {
  const [mrn, setMrn] = useState<string>(() => {
    try {
      return localStorage.getItem("myspehr.mrn") ?? "";
    } catch {
      return "";
    }
  });
  const [draft, setDraft] = useState(mrn);

  const handleSignIn = () => {
    const v = draft.trim().toUpperCase();
    if (!v) {
      toast.error("Enter your MRN to continue");
      return;
    }
    try {
      localStorage.setItem("myspehr.mrn", v);
    } catch {}
    setMrn(v);
  };

  const handleSignOut = () => {
    try {
      localStorage.removeItem("myspehr.mrn");
    } catch {}
    setMrn("");
    setDraft("");
  };

  return (
    <main className="min-h-screen bg-slate-100">
      {/* Mobile frame */}
      <div className="mx-auto max-w-[420px] min-h-screen bg-white shadow-2xl flex flex-col">
        {/* Top bar */}
        <header className="sticky top-0 z-20 flex items-center justify-between px-4 py-3 bg-gradient-to-b from-[#0e1726] to-[#0a1220] text-white">
          <div className="flex items-center gap-2">
            <img src={spehrLogo.url} alt="SPEHR" className="h-7 w-auto" />
            <div className="leading-tight">
              <div className="text-sm font-semibold">MySPEHR</div>
              <div className="text-[10px] uppercase tracking-widest text-slate-400">Patient Portal</div>
            </div>
          </div>
          {mrn ? (
            <button
              className="text-[11px] text-slate-300 hover:text-white"
              onClick={handleSignOut}
            >
              Sign out
            </button>
          ) : (
            <Link to="/" className="text-[11px] text-slate-300 hover:text-white">
              Provider login
            </Link>
          )}
        </header>

        {mrn ? (
          <PortalHome mrn={mrn} />
        ) : (
          <div className="flex-1 px-6 py-10">
            <div className="text-center mb-8">
              <div className="mx-auto mb-4 inline-flex h-14 w-14 items-center justify-center rounded-2xl bg-[#2d8a9e]/10 ring-1 ring-[#2d8a9e]/30">
                <ShieldCheck className="h-7 w-7 text-[#2d8a9e]" />
              </div>
              <h1 className="text-xl font-semibold text-slate-900">Welcome to MySPEHR</h1>
              <p className="mt-1 text-xs text-slate-500">
                View your records, appointments and pay your hospital bills securely.
              </p>
            </div>
            <label className="block text-[11px] uppercase tracking-widest text-slate-500 mb-2">
              Your Medical Record Number (MRN)
            </label>
            <Input
              placeholder="e.g. MRN-123456"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSignIn()}
              className="h-11 text-base"
            />
            <Button
              onClick={handleSignIn}
              className="mt-4 w-full h-11 bg-[#2d8a9e] hover:bg-[#34a0b6]"
            >
              Sign in to MySPEHR
            </Button>
            <p className="mt-6 flex items-center gap-1.5 justify-center text-[10px] text-slate-400">
              <Lock className="h-3 w-3" /> TLS 1.3 · HIPAA mode · Audit-logged
            </p>
          </div>
        )}
      </div>
    </main>
  );
}

function PortalHome({ mrn }: { mrn: string }) {
  const [tab, setTab] = useState<"home" | "billing" | "appointments" | "messages" | "health" | "records">("home");
  const [plain, setPlain] = usePlainEnglishMode();
  return (
    <div className="flex-1 flex flex-col">
      {/* Plain English Mode global toggle */}
      <div className="flex items-center justify-between px-4 py-2 bg-sky-50/70 border-b border-sky-100">
        <span className="text-[10px] font-semibold uppercase tracking-widest text-sky-700">
          Plain English Mode
        </span>
        <button
          onClick={() => setPlain(!plain)}
          className={`relative inline-flex h-5 w-9 items-center rounded-full transition ${
            plain ? "bg-sky-600" : "bg-slate-300"
          }`}
          aria-label="Toggle plain english mode"
        >
          <span className={`inline-block h-4 w-4 rounded-full bg-white shadow transition-transform ${
            plain ? "translate-x-4" : "translate-x-0.5"
          }`} />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto pb-24">
        {tab === "home" && <HomeTab mrn={mrn} onOpenBilling={() => setTab("billing")} />}
        {tab === "billing" && <BillingTab mrn={mrn} />}
        {tab === "appointments" && <AppointmentsTab mrn={mrn} />}
        {tab === "messages" && <MessagesTab mrn={mrn} />}
        {tab === "health" && <HealthLogsTab mrn={mrn} />}
        {tab === "records" && <RecordsTab mrn={mrn} plain={plain} />}
      </div>

      {/* Bottom nav */}
      <nav className="sticky bottom-0 grid grid-cols-6 border-t border-slate-200 bg-white pb-safe">
        <NavTab
          active={tab === "home"}
          icon={<ShieldCheck className="h-5 w-5" />}
          label="Home"
          onClick={() => setTab("home")}
        />
        <NavTab
          active={tab === "records"}
          icon={<FileHeart className="h-5 w-5" />}
          label="Records"
          onClick={() => setTab("records")}
        />
        <NavTab
          active={tab === "appointments"}
          icon={<Calendar className="h-5 w-5" />}
          label="Appts"
          onClick={() => setTab("appointments")}
        />
        <NavTab
          active={tab === "messages"}
          icon={<MessageSquare className="h-5 w-5" />}
          label="Chat"
          onClick={() => setTab("messages")}
        />
        <NavTab
          active={tab === "health"}
          icon={<Activity className="h-5 w-5" />}
          label="Health"
          onClick={() => setTab("health")}
        />
        <NavTab
          active={tab === "billing"}
          icon={<Wallet className="h-5 w-5" />}
          label="Bills"
          onClick={() => setTab("billing")}
        />
      </nav>
    </div>
  );
}

function NavTab({
  active,
  icon,
  label,
  onClick,
}: {
  active: boolean;
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex flex-col items-center gap-1 py-3 text-[11px] font-medium ${
        active ? "text-[#2d8a9e]" : "text-slate-500"
      }`}
    >
      {icon}
      {label}
    </button>
  );
}

function HomeTab({ mrn, onOpenBilling }: { mrn: string; onOpenBilling: () => void }) {
  const [outstanding, setOutstanding] = useState<{ count: number; total: number } | null>(null);

  useEffect(() => {
    (async () => {
      const { data } = await (supabase as any)
        .from("fhir_invoices")
        .select("total,status")
        .eq("mrn", mrn)
        .eq("status", "issued");
      const list = (data ?? []) as Array<{ total: number; status: string }>;
      setOutstanding({
        count: list.length,
        total: list.reduce((s, i) => s + Number(i.total ?? 0), 0),
      });
    })();
  }, [mrn]);

  return (
    <div className="px-5 py-6">
      <div className="text-[11px] uppercase tracking-widest text-slate-500">Signed in as</div>
      <div className="text-lg font-semibold text-slate-900 font-mono">{mrn}</div>

      <button
        onClick={onOpenBilling}
        className="mt-6 w-full text-left rounded-2xl border border-slate-200 bg-gradient-to-br from-emerald-50 to-white p-5 hover:border-emerald-300 transition"
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-[11px] uppercase tracking-widest text-emerald-700">
            <Wallet className="h-3.5 w-3.5" /> Outstanding balance
          </div>
          <ChevronRight className="h-4 w-4 text-slate-400" />
        </div>
        {outstanding === null ? (
          <Loader2 className="mt-3 h-4 w-4 animate-spin text-slate-400" />
        ) : (
          <>
            <div className="mt-2 text-3xl font-bold text-slate-900">
              {money(outstanding.total)}
            </div>
            <div className="mt-1 text-xs text-slate-500">
              {outstanding.count} unpaid invoice{outstanding.count === 1 ? "" : "s"} · Tap to pay
            </div>
          </>
        )}
      </button>

      <div className="mt-6 grid grid-cols-1 gap-3">
        <InfoCard
          icon={<FileText className="h-4 w-4 text-sky-700" />}
          title="Visit Summary"
          body="Your most recent discharge summary and care plan are available with your provider."
        />
        <InfoCard
          icon={<ShieldCheck className="h-4 w-4 text-violet-700" />}
          title="Privacy"
          body="MySPEHR uses TLS 1.3 in HIPAA mode. Every page view is audit-logged."
        />
      </div>
    </div>
  );
}

function InfoCard({
  icon,
  title,
  body,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
}) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="flex items-center gap-2 text-sm font-semibold text-slate-900">
        {icon} {title}
      </div>
      <p className="mt-1 text-xs text-slate-600 leading-relaxed">{body}</p>
    </div>
  );
}

function BillingTab({ mrn }: { mrn: string }) {
  const [invoices, setInvoices] = useState<InvoiceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<InvoiceRow | null>(null);

  const refresh = async () => {
    setLoading(true);
    const { data, error } = await (supabase as any)
      .from("fhir_invoices")
      .select("id,invoice_no,mrn,patient_name,facility_name,status,subtotal,tax,total,issued_at,paid_at")
      .eq("mrn", mrn)
      .order("issued_at", { ascending: false });
    if (error) toast.error(error.message);
    else setInvoices((data ?? []) as InvoiceRow[]);
    setLoading(false);
  };

  useEffect(() => {
    refresh();
    const channel = supabase
      .channel(`myspehr-invoices-${mrn}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "fhir_invoices", filter: `mrn=eq.${mrn}` },
        () => refresh(),
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mrn]);

  return (
    <div className="px-5 py-6">
      <h2 className="text-lg font-bold text-slate-900">Billing & Payments</h2>
      <p className="text-xs text-slate-500 mt-0.5">
        View itemized FHIR ChargeItems and pay your hospital invoices.
      </p>

      {loading ? (
        <div className="mt-10 grid place-items-center text-slate-400">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      ) : invoices.length === 0 ? (
        <div className="mt-10 rounded-xl border border-dashed border-slate-300 p-8 text-center text-sm text-slate-500">
          No invoices on file for <span className="font-mono">{mrn}</span> yet.
        </div>
      ) : (
        <ul className="mt-5 space-y-3">
          {invoices.map((i) => (
            <li
              key={i.id}
              className="rounded-xl border border-slate-200 bg-white p-4 active:scale-[0.99] transition"
            >
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-xs text-slate-500 font-mono">{i.invoice_no}</div>
                  <div className="text-sm font-semibold text-slate-900">
                    {i.facility_name ?? "Hospital Invoice"}
                  </div>
                  <div className="text-[11px] text-slate-500 mt-0.5">
                    Issued {fmtDate(i.issued_at)}
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-lg font-bold text-slate-900">{money(Number(i.total))}</div>
                  {i.status === "balanced" ? (
                    <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-emerald-700">
                      <CheckCircle2 className="h-3 w-3" /> Paid
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-amber-700">
                      Due
                    </span>
                  )}
                </div>
              </div>
              <Button
                size="sm"
                variant="outline"
                className="mt-3 w-full gap-1.5"
                onClick={() => setSelected(i)}
              >
                <Receipt className="h-4 w-4" /> View itemized bill
              </Button>
            </li>
          ))}
        </ul>
      )}

      {selected && (
        <InvoiceSheet
          invoice={selected}
          onClose={() => setSelected(null)}
          onPaid={async () => {
            await refresh();
            setSelected(null);
          }}
        />
      )}
    </div>
  );
}

function InvoiceSheet({
  invoice,
  onClose,
  onPaid,
}: {
  invoice: InvoiceRow;
  onClose: () => void;
  onPaid: () => void | Promise<void>;
}) {
  const [items, setItems] = useState<ChargeItemRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [paying, setPaying] = useState(false);
  const pay = useServerFn(payInvoice);

  useEffect(() => {
    (async () => {
      const { data } = await (supabase as any)
        .from("fhir_charge_items")
        .select("id,invoice_id,charge_code,code_system,description,category,quantity,unit_price,amount")
        .eq("invoice_id", invoice.id)
        .order("created_at", { ascending: true });
      setItems((data ?? []) as ChargeItemRow[]);
      setLoading(false);
    })();
  }, [invoice.id]);

  const grouped = useMemo(() => {
    const g: Record<string, ChargeItemRow[]> = {};
    for (const it of items) (g[it.category] ||= []).push(it);
    return g;
  }, [items]);

  const handlePay = async () => {
    setPaying(true);
    try {
      await pay({ data: { invoiceId: invoice.id, method: "Card · Patient Portal" } } as any);
      toast.success(`Payment received · ${invoice.invoice_no} balanced`);
      await onPaid();
    } catch (e) {
      toast.error(`Payment failed: ${(e as Error).message}`);
    } finally {
      setPaying(false);
    }
  };

  const paid = invoice.status === "balanced";

  return (
    <div className="fixed inset-0 z-50 bg-black/40" onClick={onClose}>
      <div
        className="absolute bottom-0 left-1/2 -translate-x-1/2 w-full max-w-[420px] max-h-[88vh] overflow-y-auto rounded-t-3xl bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 bg-white px-5 pt-3 pb-2 border-b border-slate-200">
          <div className="mx-auto h-1 w-10 rounded-full bg-slate-300 mb-3" />
          <div className="flex items-center justify-between">
            <div>
              <div className="text-[11px] uppercase tracking-widest text-slate-500 font-mono">
                {invoice.invoice_no}
              </div>
              <div className="text-base font-semibold text-slate-900">
                {invoice.facility_name ?? "Hospital Invoice"}
              </div>
            </div>
            {paid && (
              <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-emerald-700">
                <CheckCircle2 className="h-3 w-3" /> Paid
              </span>
            )}
          </div>
        </div>

        <div className="px-5 py-4">
          {loading ? (
            <div className="grid place-items-center h-32"><Loader2 className="h-5 w-5 animate-spin text-slate-400" /></div>
          ) : (
            <>
              {Object.entries(grouped).map(([cat, list]) => (
                <div key={cat} className="mb-4">
                  <div className="text-[10px] uppercase tracking-widest text-slate-500 mb-1.5">
                    {cat}
                  </div>
                  <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
                    {list.map((it) => (
                      <li key={it.id} className="flex items-center justify-between gap-3 px-3 py-2.5">
                        <div className="min-w-0">
                          <div className="text-sm text-slate-900 truncate">{it.description}</div>
                          <div className="text-[10px] font-mono text-slate-500">
                            {it.code_system !== "internal" ? `${it.code_system}: ` : ""}
                            {it.charge_code} · qty {it.quantity} × {money(Number(it.unit_price))}
                          </div>
                        </div>
                        <div className="text-sm font-mono font-semibold text-slate-900 whitespace-nowrap">
                          {money(Number(it.amount))}
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}

              <div className="mt-4 rounded-lg border border-slate-200 p-3 text-sm">
                <div className="flex justify-between py-0.5 text-slate-600">
                  <span>Subtotal</span>
                  <span className="font-mono">{money(Number(invoice.subtotal))}</span>
                </div>
                <div className="flex justify-between py-0.5 text-slate-600">
                  <span>Tax</span>
                  <span className="font-mono">{money(Number(invoice.tax))}</span>
                </div>
                <div className="flex justify-between py-2 mt-1 bg-slate-900 text-white px-3 rounded-md">
                  <span className="font-bold">Total Due</span>
                  <span className="font-mono font-bold">{money(Number(invoice.total))}</span>
                </div>
              </div>
            </>
          )}
        </div>

        <div className="sticky bottom-0 bg-white border-t border-slate-200 px-5 py-3">
          {paid ? (
            <Button variant="outline" className="w-full" onClick={onClose}>
              Close
            </Button>
          ) : (
            <Button
              className="w-full h-12 text-base bg-emerald-600 hover:bg-emerald-700 gap-2"
              disabled={paying || loading}
              onClick={handlePay}
            >
              {paying ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <CreditCard className="h-4 w-4" />
              )}
              Pay {money(Number(invoice.total))} Now
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------- */
/* Appointments Tab — Patient-side requesting                        */
/* ----------------------------------------------------------------- */

function AppointmentsTab({ mrn }: { mrn: string }) {
  const [appts, setAppts] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [requesting, setRequesting] = useState(false);
  const [form, setForm] = useState({
    service_type: "General Consultation",
    description: "",
  });

  const load = async () => {
    const { data } = await (supabase as any)
      .from("fhir_appointments")
      .select("*")
      .eq("patient_mrn", mrn)
      .order("start_time", { ascending: false });
    setAppts(data ?? []);
    setLoading(false);
  };

  useEffect(() => {
    load();
    const ch = supabase.channel(`patient-appts-${mrn}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "fhir_appointments", filter: `patient_mrn=eq.${mrn}` }, () => load())
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [mrn]);

  const handleRequest = async () => {
    if (!form.description.trim()) {
      toast.error("Please provide a reason for the visit");
      return;
    }
    setRequesting(true);
    // Request is created in 'proposed' status for receptionist review.
    const start = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    start.setHours(10, 0, 0, 0);
    const end = new Date(start.getTime() + 30 * 60 * 1000);

    const { error } = await (supabase as any).from("fhir_appointments").insert({
      patient_mrn: mrn,
      patient_name: `Patient ${mrn}`,
      facility_name: "Memorial Hospital", // Default
      status: "proposed",
      service_type: form.service_type,
      description: form.description,
      start_time: start.toISOString(),
      end_time: end.toISOString(),
    });

    if (error) toast.error(error.message);
    else {
      toast.success("Appointment request submitted", { description: "The clinic staff will review and confirm shortly." });
      setForm({ service_type: "General Consultation", description: "" });
    }
    setRequesting(false);
  };

  return (
    <div className="px-5 py-6">
      <h2 className="text-lg font-bold text-slate-900">Appointments</h2>
      <p className="text-xs text-slate-500 mt-0.5">Manage your upcoming visits and request new ones.</p>

      <div className="mt-6 space-y-4">
        <div className="rounded-xl border border-slate-200 bg-emerald-50/50 p-4">
          <h3 className="text-sm font-semibold text-emerald-900 mb-2 flex items-center gap-1.5">
            <Plus className="h-4 w-4" /> Request New Appointment
          </h3>
          <div className="space-y-3">
            <select
              value={form.service_type}
              onChange={(e) => setForm({ ...form, service_type: e.target.value })}
              className="w-full h-10 rounded-lg border border-slate-200 bg-white px-3 text-sm"
            >
              <option>General Consultation</option>
              <option>Follow-up Visit</option>
              <option>Lab Results Review</option>
              <option>Specialist Referral</option>
            </select>
            <textarea
              placeholder="Reason for visit (symptoms or purpose)…"
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm h-20 outline-none focus:ring-2 focus:ring-[#2d8a9e]/40"
            />
            <Button
              onClick={handleRequest}
              disabled={requesting}
              className="w-full bg-[#2d8a9e]"
            >
              {requesting ? <Loader2 className="h-4 w-4 animate-spin" /> : "Submit Request"}
            </Button>
          </div>
        </div>

        {loading ? (
          <div className="flex justify-center py-8"><Loader2 className="h-5 w-5 animate-spin text-slate-400" /></div>
        ) : appts.length === 0 ? (
          <div className="text-center py-10 text-xs text-slate-400 border border-dashed rounded-xl">No appointment history found.</div>
        ) : (
          <div className="space-y-3">
            <h3 className="text-[11px] uppercase tracking-widest text-slate-500 font-semibold">Your Appointments</h3>
            {appts.map((a: any) => (
              <div key={a.id} className="rounded-xl border border-slate-200 bg-white p-4">
                <div className="flex justify-between items-start mb-2">
                  <div className="text-sm font-bold text-slate-900">{a.service_type}</div>
                  <span className={`rounded-full px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider ring-1 ${
                    a.status === 'proposed' ? 'bg-amber-100 text-amber-800 ring-amber-300' :
                    a.status === 'booked' ? 'bg-emerald-100 text-emerald-800 ring-emerald-300' :
                    'bg-slate-100 text-slate-700 ring-slate-300'
                  }`}>
                    {a.status}
                  </span>
                </div>
                <div className="flex items-center gap-2 text-xs text-slate-600">
                  <Calendar className="h-3.5 w-3.5" /> {new Date(a.start_time).toLocaleDateString()}
                </div>
                <div className="flex items-center gap-2 text-xs text-slate-600 mt-1">
                  <Clock className="h-3.5 w-3.5" /> {new Date(a.start_time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </div>
                {a.practitioner_name && (
                  <div className="text-[11px] text-slate-500 mt-2 pt-2 border-t border-slate-50 italic">
                    Provider: {a.practitioner_name}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------- */
/* Messages Tab — Bidirectional Patient-Provider Chat               */
/* ----------------------------------------------------------------- */

function MessagesTab({ mrn }: { mrn: string }) {
  const [messages, setMessages] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);

  const load = async () => {
    const { data } = await (supabase as any)
      .from("fhir_communications")
      .select("*")
      .eq("mrn", mrn)
      .order("created_at", { ascending: true });
    setMessages(data ?? []);
    setLoading(false);
  };

  useEffect(() => {
    load();
    const ch = supabase.channel(`patient-comms-${mrn}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "fhir_communications", filter: `mrn=eq.${mrn}` }, () => load())
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [mrn]);

  const handleSend = async () => {
    if (!text.trim()) return;
    setSending(true);
    const { error } = await (supabase as any).from("fhir_communications").insert({
      mrn,
      sender: "patient",
      sender_label: `Patient ${mrn}`,
      recipient: "provider",
      message: text.trim(),
      status: "unread", // Provider will see it as unread
    });
    if (error) toast.error(error.message);
    else setText("");
    setSending(false);
  };

  return (
    <div className="flex flex-col h-[calc(100vh-130px)]">
      <div className="px-5 py-4 border-b border-slate-200 bg-white flex-shrink-0">
        <h2 className="text-lg font-bold text-slate-900">Care Team Chat</h2>
        <p className="text-[11px] text-slate-500">Secure messaging with your clinical team.</p>
      </div>

      <div className="flex-1 overflow-y-auto p-5 space-y-4 bg-slate-50/50">
        {loading ? (
          <div className="flex justify-center py-10"><Loader2 className="h-5 w-5 animate-spin text-slate-400" /></div>
        ) : messages.length === 0 ? (
          <div className="text-center py-20">
            <MessageSquare className="h-10 w-10 text-slate-200 mx-auto mb-3" />
            <p className="text-sm text-slate-500">No messages yet. Send a note to your care team below.</p>
          </div>
        ) : (
          messages.map((m) => (
            <div key={m.id} className={`flex ${m.sender === 'patient' ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-[85%] rounded-2xl px-4 py-2.5 shadow-sm text-sm ${
                m.sender === 'patient'
                  ? 'bg-[#2d8a9e] text-white rounded-br-none'
                  : 'bg-white border border-slate-200 text-slate-800 rounded-bl-none'
              }`}>
                <div className="text-[10px] opacity-70 mb-1 font-semibold uppercase tracking-wider">
                  {m.sender === 'patient' ? 'You' : (m.sender_label || 'Provider')}
                </div>
                {m.message}
                <div className="text-[9px] opacity-60 mt-1.5 text-right">
                  {new Date(m.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </div>
              </div>
            </div>
          ))
        )}
      </div>

      <div className="p-4 bg-white border-t border-slate-200 flex-shrink-0">
        <div className="flex gap-2">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Type a message…"
            className="flex-1 h-10 min-h-[40px] max-h-32 rounded-xl border border-slate-200 px-4 py-2 text-sm outline-none focus:ring-2 focus:ring-[#2d8a9e]/40"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleSend();
              }
            }}
          />
          <button
            onClick={handleSend}
            disabled={sending || !text.trim()}
            className="h-10 w-10 rounded-full bg-[#2d8a9e] text-white flex items-center justify-center shadow-lg disabled:opacity-50"
          >
            {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------- */
/* Health Logs Tab — Submit Patient Reported Vitals (Observations)   */
/* ----------------------------------------------------------------- */

function HealthLogsTab({ mrn }: { mrn: string }) {
  const [submitting, setSubmitting] = useState(false);
  const [vitals, setVitals] = useState({
    bp_systolic: "",
    bp_diastolic: "",
    hr: "",
    spo2: "",
    temp: "",
  });

  const handleSubmit = async (type: 'bp' | 'vitals') => {
    setSubmitting(true);
    try {
      const observations = [];
      const timestamp = new Date().toISOString();

      if (type === 'bp' && vitals.bp_systolic && vitals.bp_diastolic) {
        observations.push({
          patient_mrn: mrn,
          status: "final",
          resource: {
            resourceType: "Observation",
            status: "final",
            category: [{ coding: [{ system: "http://terminology.hl7.org/CodeSystem/observation-category", code: "vital-signs", display: "Vital Signs" }, { system: "http://spehr.io/codes", code: "patient-reported", display: "Patient Reported" }] }],
            code: { coding: [{ system: "http://loinc.org", code: "85354-9", display: "Blood pressure panel with all children optional" }], text: "Blood Pressure" },
            subject: { reference: `Patient/${mrn}` },
            effectiveDateTime: timestamp,
            component: [
              { code: { coding: [{ system: "http://loinc.org", code: "8480-6", display: "Systolic blood pressure" }] }, valueQuantity: { value: Number(vitals.bp_systolic), unit: "mmHg", system: "http://unitsofmeasure.org", code: "mm[Hg]" } },
              { code: { coding: [{ system: "http://loinc.org", code: "8462-4", display: "Diastolic blood pressure" }] }, valueQuantity: { value: Number(vitals.bp_diastolic), unit: "mmHg", system: "http://unitsofmeasure.org", code: "mm[Hg]" } }
            ]
          }
        });
      }

      if (type === 'vitals') {
        if (vitals.hr) {
          observations.push({
            patient_mrn: mrn,
            status: "final",
            resource: {
              resourceType: "Observation",
              status: "final",
              category: [{ coding: [{ system: "http://terminology.hl7.org/CodeSystem/observation-category", code: "vital-signs" }, { system: "http://spehr.io/codes", code: "patient-reported" }] }],
              code: { coding: [{ system: "http://loinc.org", code: "8867-4", display: "Heart rate" }], text: "Heart Rate" },
              subject: { reference: `Patient/${mrn}` },
              effectiveDateTime: timestamp,
              valueQuantity: { value: Number(vitals.hr), unit: "bpm", system: "http://unitsofmeasure.org", code: "/min" }
            }
          });
        }
        if (vitals.spo2) {
          observations.push({
            patient_mrn: mrn,
            status: "final",
            resource: {
              resourceType: "Observation",
              status: "final",
              category: [{ coding: [{ system: "http://terminology.hl7.org/CodeSystem/observation-category", code: "vital-signs" }, { system: "http://spehr.io/codes", code: "patient-reported" }] }],
              code: { coding: [{ system: "http://loinc.org", code: "2708-6", display: "Oxygen saturation in Arterial blood by Pulse oximetry" }], text: "Oxygen Saturation" },
              subject: { reference: `Patient/${mrn}` },
              effectiveDateTime: timestamp,
              valueQuantity: { value: Number(vitals.spo2), unit: "%", system: "http://unitsofmeasure.org", code: "%" }
            }
          });
        }
      }

      if (observations.length === 0) {
        toast.error("Please enter at least one value");
        return;
      }

      const { error } = await (supabase as any).from("fhir_observations").insert(observations);
      if (error) throw error;

      toast.success("Health data logged", { description: "Your provider can now see these vitals in your chart." });
      if (type === 'bp') setVitals({ ...vitals, bp_systolic: "", bp_diastolic: "" });
      else setVitals({ ...vitals, hr: "", spo2: "", temp: "" });
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="px-5 py-6 space-y-6">
      <header>
        <h2 className="text-lg font-bold text-slate-900">Health Logs</h2>
        <p className="text-xs text-slate-500 mt-0.5">Submit your vitals directly to your hospital record.</p>
      </header>

      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex items-center gap-2 text-sm font-semibold text-slate-900 mb-4">
          <Heart className="h-4 w-4 text-rose-500" /> Blood Pressure
        </div>
        <div className="grid grid-cols-2 gap-3 mb-4">
          <div>
            <label className="text-[10px] uppercase tracking-widest text-slate-500 mb-1 block font-bold">Systolic</label>
            <Input
              type="number"
              placeholder="120"
              value={vitals.bp_systolic}
              onChange={(e) => setVitals({ ...vitals, bp_systolic: e.target.value })}
            />
          </div>
          <div>
            <label className="text-[10px] uppercase tracking-widest text-slate-500 mb-1 block font-bold">Diastolic</label>
            <Input
              type="number"
              placeholder="80"
              value={vitals.bp_diastolic}
              onChange={(e) => setVitals({ ...vitals, bp_diastolic: e.target.value })}
            />
          </div>
        </div>
        <Button
          onClick={() => handleSubmit('bp')}
          disabled={submitting}
          className="w-full bg-rose-500 hover:bg-rose-600"
        >
          {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : "Log Blood Pressure"}
        </Button>
      </div>

      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex items-center gap-2 text-sm font-semibold text-slate-900 mb-4">
          <Activity className="h-4 w-4 text-emerald-500" /> Vital Signs
        </div>
        <div className="space-y-4 mb-4">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-full bg-emerald-50 flex items-center justify-center flex-shrink-0">
              <Activity className="h-5 w-5 text-emerald-600" />
            </div>
            <div className="flex-1">
              <label className="text-[10px] uppercase tracking-widest text-slate-500 mb-0.5 block font-bold">Heart Rate (bpm)</label>
              <Input
                type="number"
                placeholder="72"
                value={vitals.hr}
                onChange={(e) => setVitals({ ...vitals, hr: e.target.value })}
              />
            </div>
          </div>
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-full bg-blue-50 flex items-center justify-center flex-shrink-0">
              <Droplet className="h-5 w-5 text-blue-600" />
            </div>
            <div className="flex-1">
              <label className="text-[10px] uppercase tracking-widest text-slate-500 mb-0.5 block font-bold">Oxygen (SpO2 %)</label>
              <Input
                type="number"
                placeholder="98"
                value={vitals.spo2}
                onChange={(e) => setVitals({ ...vitals, spo2: e.target.value })}
              />
            </div>
          </div>
        </div>
        <Button
          onClick={() => handleSubmit('vitals')}
          disabled={submitting}
          className="w-full bg-emerald-600 hover:bg-emerald-700"
        >
          {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : "Log Vital Signs"}
        </Button>
      </div>

      <div className="rounded-xl bg-slate-50 p-4 flex gap-3 items-start">
        <ShieldCheck className="h-5 w-5 text-[#2d8a9e] mt-0.5" />
        <p className="text-[11px] text-slate-600 leading-relaxed">
          These logs are saved as FHIR Observation resources. They are flagged as "patient-reported" and will appear on your clinician's real-time monitoring dashboard immediately.
        </p>
      </div>
    </div>
  );
}
