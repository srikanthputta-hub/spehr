import { createFileRoute, Link, useNavigate, useParams } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import {
  ArrowLeft,
  HeartPulse,
  Activity,
  Thermometer,
  Wind,
  Droplet,
  AlertOctagon,
  Sparkles,
  Pill,
  CheckCircle2,
  TrendingUp,
  TrendingDown,
  Minus,
  Loader2,
  ClipboardList,
} from "lucide-react";
import {
  getPatient,
  hrOutOfRange,
  bpOutOfRange,
  o2OutOfRange,
  tempOutOfRange,
  type CodeStatus,
  type MedOrder,
} from "@/lib/patients";

export const Route = createFileRoute("/chart/$mrn")({
  component: ChartPage,
});

const codeBadge: Record<CodeStatus, string> = {
  "Full Code": "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-600/20",
  DNR: "bg-red-50 text-red-700 ring-1 ring-red-600/20",
  DNI: "bg-amber-50 text-amber-700 ring-1 ring-amber-600/20",
  Comfort: "bg-slate-100 text-slate-700 ring-1 ring-slate-600/20",
};

function ChartPage() {
  const { mrn } = useParams({ from: "/chart/$mrn" });
  const navigate = useNavigate();
  const [ready, setReady] = useState(false);
  const [given, setGiven] = useState<Record<string, string>>({});

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      if (!data.session) {
        navigate({ to: "/" }).catch(() => {});
        return;
      }
      setReady(true);
    });
  }, [navigate]);

  const patient = getPatient(mrn);

  if (!ready) {
    return (
      <div className="min-h-screen grid place-items-center">
        <Loader2 className="h-5 w-5 animate-spin text-[var(--teal)]" />
      </div>
    );
  }

  if (!patient) {
    return (
      <div className="min-h-screen grid place-items-center p-6">
        <div className="text-center max-w-sm">
          <h1 className="text-lg font-semibold">Chart not found</h1>
          <p className="text-sm text-muted-foreground mt-1">
            MRN {mrn} is not on this unit.
          </p>
          <Link
            to="/dashboard"
            className="inline-flex items-center gap-1 mt-4 text-sm text-[var(--teal)] hover:underline"
          >
            <ArrowLeft className="h-4 w-4" /> Back to Floor
          </Link>
        </div>
      </div>
    );
  }

  const handleAdminister = (id: string) => {
    setGiven((g) => ({
      ...g,
      [id]: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false }),
    }));
  };

  return (
    <main className="min-h-screen bg-background pb-12">
      {/* Patient Banner */}
      <header className="sticky top-0 z-20 bg-[var(--navy)] text-white border-b border-black/20 shadow-md">
        <div className="max-w-[1400px] mx-auto px-5 py-3 flex flex-wrap items-center gap-x-6 gap-y-3">
          <Link
            to="/dashboard"
            className="inline-flex items-center gap-1.5 rounded-md bg-white/10 hover:bg-white/15 ring-1 ring-white/10 px-3 h-9 text-xs font-medium transition shrink-0"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Back to Floor
          </Link>

          <div className="flex items-center gap-3 min-w-0">
            <div className="grid place-items-center h-10 w-10 rounded-lg bg-[var(--teal)] shrink-0">
              <HeartPulse className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h1 className="text-base font-semibold tracking-tight truncate">
                  {patient.name}
                </h1>
                <span
                  className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ${codeBadge[patient.code]}`}
                >
                  {patient.code}
                </span>
              </div>
              <div className="text-[11px] text-white/65 mt-0.5">
                Room {patient.room} · {patient.age}
                {patient.sex} · DOB {patient.dob} · {patient.mrn}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2 ml-auto">
            <div className="inline-flex items-center gap-2 rounded-md bg-red-500/15 ring-1 ring-red-400/40 px-3 h-9 text-xs">
              <AlertOctagon className="h-4 w-4 text-red-300" />
              <span className="font-semibold text-red-200 uppercase tracking-wider text-[10px]">
                Allergies
              </span>
              <span className="font-medium text-red-100">
                {patient.allergies.join(", ")}
              </span>
            </div>
          </div>
        </div>
      </header>

      <div className="max-w-[1400px] mx-auto px-5 py-6 grid lg:grid-cols-5 gap-6">
        {/* LEFT — Clinical Context */}
        <div className="lg:col-span-3 space-y-6">
          {/* Live Vitals */}
          <section className="rounded-xl border border-border bg-card overflow-hidden">
            <SectionHeader icon={Activity} title="Live Vitals" subtitle="Streaming · last 7 readings" />
            <div className="grid grid-cols-2 md:grid-cols-4 divide-x divide-border border-t border-border">
              <VitalCard
                icon={HeartPulse}
                label="Heart Rate"
                unit="bpm"
                value={patient.hr}
                trend={patient.hrTrend}
                alert={hrOutOfRange(patient.hr)}
              />
              <VitalCard
                icon={Droplet}
                label="Blood Pressure"
                unit="mmHg"
                value={patient.bp}
                trend={patient.bpTrend}
                alert={bpOutOfRange(patient.bp)}
              />
              <VitalCard
                icon={Thermometer}
                label="Temp"
                unit="°F"
                value={patient.temp}
                trend={patient.tempTrend}
                alert={tempOutOfRange(patient.temp)}
              />
              <VitalCard
                icon={Wind}
                label="SpO₂"
                unit="%"
                value={patient.o2}
                trend={patient.o2Trend}
                alert={o2OutOfRange(patient.o2)}
              />
            </div>
          </section>

          {/* Admitting Note */}
          <section className="rounded-xl border border-border bg-card overflow-hidden">
            <SectionHeader
              icon={ClipboardList}
              title="Admitting H&P — AI Summary"
              subtitle="Generated from Dr. R. Patel's full note"
              right={
                <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-[var(--teal)] uppercase tracking-wider">
                  <Sparkles className="h-3 w-3" />
                  AI
                </span>
              }
            />
            <div className="p-5 space-y-3 text-sm leading-relaxed text-foreground/90">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span className="font-medium text-foreground">Chief Complaint:</span>
                {patient.diagnosis}
              </div>
              <p>{patient.admitNote}</p>
              <div className="text-[11px] text-muted-foreground pt-2 border-t border-border">
                Source: Admission H&P · Reviewed 06:42 · Tap to view full note
              </div>
            </div>
          </section>
        </div>

        {/* RIGHT — MAR */}
        <div className="lg:col-span-2">
          <section className="rounded-xl border border-border bg-card overflow-hidden sticky top-[88px]">
            <SectionHeader
              icon={Pill}
              title="MAR — Due Now"
              subtitle={`${patient.meds.length} active orders`}
              right={
                <span className="inline-flex items-center gap-1.5 rounded-full bg-[var(--teal-soft)] text-[var(--teal)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider">
                  <span className="h-1.5 w-1.5 rounded-full bg-[var(--teal)]" />
                  Live
                </span>
              }
            />
            <ul className="divide-y divide-border">
              {patient.meds.map((m) => (
                <MedRow
                  key={m.id}
                  med={m}
                  givenAt={given[m.id]}
                  onAdminister={() => handleAdminister(m.id)}
                />
              ))}
            </ul>
          </section>
        </div>
      </div>
    </main>
  );
}

function SectionHeader({
  icon: Icon,
  title,
  subtitle,
  right,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  subtitle?: string;
  right?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between px-5 h-12 bg-secondary/40 border-b border-border">
      <div className="flex items-center gap-2 min-w-0">
        <Icon className="h-4 w-4 text-[var(--teal)] shrink-0" />
        <h3 className="text-sm font-semibold tracking-tight">{title}</h3>
        {subtitle && (
          <span className="text-xs text-muted-foreground truncate">· {subtitle}</span>
        )}
      </div>
      {right}
    </div>
  );
}

function Sparkline({ data, alert }: { data: number[]; alert: boolean }) {
  if (!data.length) return null;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const w = 80;
  const h = 24;
  const step = data.length > 1 ? w / (data.length - 1) : 0;
  const points = data
    .map((v, i) => `${i * step},${h - ((v - min) / range) * h}`)
    .join(" ");
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-20 h-6" preserveAspectRatio="none">
      <polyline
        points={points}
        fill="none"
        stroke={alert ? "rgb(220 38 38)" : "var(--teal)"}
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function trendArrow(data: number[]) {
  if (data.length < 2) return Minus;
  const delta = data[data.length - 1] - data[0];
  if (Math.abs(delta) < 0.5) return Minus;
  return delta > 0 ? TrendingUp : TrendingDown;
}

function VitalCard({
  icon: Icon,
  label,
  unit,
  value,
  trend,
  alert,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  unit: string;
  value: number | string;
  trend: number[];
  alert: boolean;
}) {
  const TrendIcon = trendArrow(trend);
  return (
    <div className={`p-4 ${alert ? "bg-red-50/60" : ""}`}>
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
        <Icon className={`h-3.5 w-3.5 ${alert ? "text-red-600" : "text-[var(--teal)]"}`} />
        {label}
      </div>
      <div className="mt-1.5 flex items-baseline gap-1.5">
        <div
          className={`text-2xl font-bold tabular-nums tracking-tight ${alert ? "text-red-600" : "text-foreground"}`}
        >
          {value}
        </div>
        <div className="text-xs text-muted-foreground">{unit}</div>
      </div>
      <div className="mt-2 flex items-center justify-between">
        <Sparkline data={trend} alert={alert} />
        <TrendIcon
          className={`h-3.5 w-3.5 ${alert ? "text-red-600" : "text-muted-foreground"}`}
        />
      </div>
    </div>
  );
}

function MedRow({
  med,
  givenAt,
  onAdminister,
}: {
  med: MedOrder;
  givenAt?: string;
  onAdminister: () => void;
}) {
  return (
    <li className="p-4 flex items-start gap-3">
      <div className="grid place-items-center h-9 w-9 rounded-lg bg-secondary text-[var(--navy)] shrink-0">
        <Pill className="h-4 w-4" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline justify-between gap-2">
          <div className="font-semibold text-sm text-foreground truncate">
            {med.name}
          </div>
          <div className="text-[11px] text-muted-foreground tabular-nums shrink-0">
            Due {med.due}
          </div>
        </div>
        <div className="text-xs text-muted-foreground mt-0.5">
          <span className="text-foreground font-medium">{med.dose}</span> ·{" "}
          {med.route} · {med.freq}
        </div>
        {med.notes && (
          <div className="text-[11px] text-amber-700 mt-1 inline-flex items-center gap-1">
            <AlertOctagon className="h-3 w-3" />
            {med.notes}
          </div>
        )}
        <div className="mt-3">
          {givenAt ? (
            <div className="inline-flex items-center gap-1.5 rounded-md bg-emerald-50 text-emerald-700 ring-1 ring-emerald-600/20 px-3 h-8 text-xs font-semibold">
              <CheckCircle2 className="h-3.5 w-3.5" />
              Given · {givenAt}
            </div>
          ) : (
            <button
              onClick={onAdminister}
              className="inline-flex items-center gap-1.5 rounded-md bg-[var(--teal)] hover:bg-[var(--teal)]/90 text-white px-3 h-8 text-xs font-semibold transition shadow-sm"
            >
              <CheckCircle2 className="h-3.5 w-3.5" />
              Administer
            </button>
          )}
        </div>
      </div>
    </li>
  );
}
