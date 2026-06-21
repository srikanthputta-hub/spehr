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
  const [tab, setTab] = useState<"home" | "billing">("home");
  return (
    <div className="flex-1 flex flex-col">
      <div className="flex-1 overflow-y-auto pb-20">
        {tab === "home" ? <HomeTab mrn={mrn} onOpenBilling={() => setTab("billing")} /> : <BillingTab mrn={mrn} />}
      </div>

      {/* Bottom nav */}
      <nav className="sticky bottom-0 grid grid-cols-2 border-t border-slate-200 bg-white">
        <NavTab
          active={tab === "home"}
          icon={<ShieldCheck className="h-5 w-5" />}
          label="Overview"
          onClick={() => setTab("home")}
        />
        <NavTab
          active={tab === "billing"}
          icon={<Wallet className="h-5 w-5" />}
          label="Billing & Payments"
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