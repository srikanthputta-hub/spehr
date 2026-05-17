import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import {
  HeartPulse,
  LogOut,
  Loader2,
  Search,
  Users,
  AlertTriangle,
  Pill,
  ChevronRight,
  Activity,
} from "lucide-react";

export const Route = createFileRoute("/dashboard")({
  component: Dashboard,
});

type CodeStatus = "Full Code" | "DNR" | "DNI" | "Comfort";

interface Patient {
  room: string;
  name: string;
  age: number;
  sex: "M" | "F";
  mrn: string;
  code: CodeStatus;
  diagnosis: string;
  hr: number;
  bp: string;
  o2: number;
  task: string;
}

const PATIENTS: Patient[] = [
  {
    room: "401-A",
    name: "Margaret Chen",
    age: 78,
    sex: "F",
    mrn: "MRN-884213",
    code: "DNR",
    diagnosis: "CHF Exacerbation",
    hr: 112,
    bp: "98/54",
    o2: 91,
    task: "IV Lasix due 14:00",
  },
  {
    room: "402-B",
    name: "Robert Alvarez",
    age: 64,
    sex: "M",
    mrn: "MRN-771902",
    code: "Full Code",
    diagnosis: "Sepsis, UTI source",
    hr: 124,
    bp: "86/48",
    o2: 94,
    task: "Blood cultures x2",
  },
  {
    room: "404-A",
    name: "Janelle Owusu",
    age: 41,
    sex: "F",
    mrn: "MRN-902551",
    code: "Full Code",
    diagnosis: "Post-op Day 1 — Lap chole",
    hr: 82,
    bp: "118/74",
    o2: 98,
    task: "PO Meds due 14:00",
  },
  {
    room: "407-B",
    name: "Henry Whitaker",
    age: 71,
    sex: "M",
    mrn: "MRN-650118",
    code: "DNI",
    diagnosis: "COPD Exacerbation",
    hr: 96,
    bp: "142/88",
    o2: 88,
    task: "Wound care 15:30",
  },
];

function hrOutOfRange(hr: number) {
  return hr < 60 || hr > 100;
}
function bpOutOfRange(bp: string) {
  const [s, d] = bp.split("/").map(Number);
  return s < 90 || s > 140 || d < 60 || d > 90;
}
function o2OutOfRange(o2: number) {
  return o2 < 92;
}

const codeBadge: Record<CodeStatus, string> = {
  "Full Code":
    "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-600/20",
  DNR: "bg-red-50 text-red-700 ring-1 ring-red-600/20",
  DNI: "bg-amber-50 text-amber-700 ring-1 ring-amber-600/20",
  Comfort: "bg-slate-100 text-slate-700 ring-1 ring-slate-600/20",
};

function Dashboard() {
  const navigate = useNavigate();
  const [email, setEmail] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [now, setNow] = useState(new Date());
  const [query, setQuery] = useState("");

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      if (!data.session) {
        navigate({ to: "/" }).catch(() => {});
        return;
      }
      setEmail(data.session.user.email ?? null);
      setReady(true);
    });
  }, [navigate]);

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return PATIENTS;
    return PATIENTS.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.mrn.toLowerCase().includes(q) ||
        p.room.toLowerCase().includes(q) ||
        p.diagnosis.toLowerCase().includes(q),
    );
  }, [query]);

  if (!ready) {
    return (
      <div className="min-h-screen grid place-items-center">
        <Loader2 className="h-5 w-5 animate-spin text-[var(--teal)]" />
      </div>
    );
  }

  const clock = now.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const dateStr = now.toLocaleDateString([], {
    weekday: "short",
    month: "short",
    day: "numeric",
  });

  return (
    <main className="min-h-screen bg-background">
      {/* Top Nav */}
      <header className="sticky top-0 z-20 border-b border-border bg-[var(--navy)] text-white">
        <div className="max-w-[1400px] mx-auto px-5 h-14 flex items-center gap-4">
          <div className="flex items-center gap-2.5">
            <div className="grid place-items-center h-8 w-8 rounded-md bg-[var(--teal)]">
              <HeartPulse className="h-4.5 w-4.5" strokeWidth={2.4} />
            </div>
            <div className="leading-tight">
              <div className="text-[10px] uppercase tracking-[0.22em] text-white/55">
                S.P.E.H.R.
              </div>
              <div className="text-sm font-semibold">Status Board</div>
            </div>
          </div>

          <div className="hidden md:flex items-center gap-2 ml-2 pl-4 border-l border-white/10 text-xs">
            <div className="h-2 w-2 rounded-full bg-emerald-400 shadow-[0_0_0_3px_rgba(52,211,153,0.18)]" />
            <span className="text-white/80 font-medium">
              RN — Memorial Hospital
            </span>
            <span className="text-white/50">· Unit 4B</span>
          </div>

          <div className="flex-1 max-w-md mx-auto">
            <div className="flex items-center gap-2 h-9 rounded-md bg-white/10 ring-1 ring-white/10 px-3 focus-within:bg-white/15 focus-within:ring-[var(--teal)]/40 transition">
              <Search className="h-4 w-4 text-white/60" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search chart — name, MRN, room, dx…"
                className="w-full bg-transparent outline-none text-sm placeholder:text-white/45"
              />
            </div>
          </div>

          <div className="hidden sm:flex flex-col items-end leading-tight tabular-nums">
            <div className="text-sm font-semibold tracking-tight">{clock}</div>
            <div className="text-[10px] uppercase tracking-wider text-white/55">
              {dateStr}
            </div>
          </div>

          <button
            onClick={async () => {
              await supabase.auth.signOut();
              navigate({ to: "/" }).catch(() => {});
            }}
            className="inline-flex items-center gap-1.5 rounded-md bg-white/10 hover:bg-white/15 px-3 h-9 text-xs font-medium ring-1 ring-white/10 transition"
          >
            <LogOut className="h-3.5 w-3.5" /> Logout
          </button>
        </div>
      </header>

      {/* Body */}
      <div className="max-w-[1400px] mx-auto px-5 py-6 space-y-6">
        {/* Stats Row */}
        <section className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <StatCard
            icon={Users}
            label="Total Patients"
            value="10"
            tone="navy"
          />
          <StatCard
            icon={AlertTriangle}
            label="Critical Alerts"
            value="2"
            tone="red"
            sub="Sepsis · Hypoxia"
          />
          <StatCard
            icon={Pill}
            label="Meds Due · Next Hour"
            value="4"
            tone="teal"
            sub="2 IV · 2 PO"
          />
        </section>

        {/* Status Board */}
        <section className="rounded-xl border border-border bg-card overflow-hidden shadow-[0_1px_0_rgba(15,23,42,0.04)]">
          <div className="flex items-center justify-between px-5 h-12 border-b border-border bg-secondary/40">
            <div className="flex items-center gap-2">
              <Activity className="h-4 w-4 text-[var(--teal)]" />
              <h2 className="text-sm font-semibold tracking-tight">
                Floor Overview — Unit 4B
              </h2>
              <span className="text-xs text-muted-foreground">
                · {rows.length} of {PATIENTS.length} patients
              </span>
            </div>
            <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <span className="relative flex h-1.5 w-1.5">
                <span className="absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75 animate-ping" />
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500" />
              </span>
              Live · auto-refresh
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wider text-muted-foreground bg-secondary/30">
                  <Th>Room / Bed</Th>
                  <Th>Patient</Th>
                  <Th>Code</Th>
                  <Th>Diagnosis</Th>
                  <Th>Live Vitals</Th>
                  <Th>Next Task</Th>
                  <Th className="text-right pr-5">Action</Th>
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => {
                  const hrAlert = hrOutOfRange(p.hr);
                  const bpAlert = bpOutOfRange(p.bp);
                  const o2Alert = o2OutOfRange(p.o2);
                  const anyAlert = hrAlert || bpAlert || o2Alert;
                  return (
                    <tr
                      key={p.mrn}
                      className="border-t border-border group hover:bg-[var(--teal-soft)]/40 transition cursor-pointer"
                    >
                      <td className="px-5 py-3.5 align-top">
                        <div className="font-semibold text-foreground tabular-nums">
                          {p.room}
                        </div>
                        {anyAlert && (
                          <div className="mt-1 inline-flex items-center gap-1 text-[10px] font-semibold text-red-600">
                            <span className="h-1.5 w-1.5 rounded-full bg-red-500 animate-pulse" />
                            ALERT
                          </div>
                        )}
                      </td>
                      <td className="px-5 py-3.5 align-top">
                        <div className="font-medium text-foreground">
                          {p.name}
                        </div>
                        <div className="text-xs text-muted-foreground mt-0.5">
                          {p.age}{p.sex} · {p.mrn}
                        </div>
                      </td>
                      <td className="px-5 py-3.5 align-top">
                        <span
                          className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ${codeBadge[p.code]}`}
                        >
                          {p.code}
                        </span>
                      </td>
                      <td className="px-5 py-3.5 align-top text-foreground/90 max-w-[220px]">
                        {p.diagnosis}
                      </td>
                      <td className="px-5 py-3.5 align-top">
                        <div className="grid grid-cols-3 gap-x-4 gap-y-0.5 tabular-nums">
                          <Vital label="HR" value={`${p.hr}`} alert={hrAlert} />
                          <Vital label="BP" value={p.bp} alert={bpAlert} />
                          <Vital
                            label="O₂"
                            value={`${p.o2}%`}
                            alert={o2Alert}
                          />
                        </div>
                      </td>
                      <td className="px-5 py-3.5 align-top text-foreground/90">
                        {p.task}
                      </td>
                      <td className="px-5 py-3.5 align-top text-right pr-5">
                        <button
                          className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-2.5 h-8 text-xs font-medium text-foreground hover:bg-[var(--navy)] hover:text-white hover:border-[var(--navy)] transition"
                        >
                          Open Chart
                          <ChevronRight className="h-3.5 w-3.5" />
                        </button>
                      </td>
                    </tr>
                  );
                })}
                {rows.length === 0 && (
                  <tr>
                    <td
                      colSpan={7}
                      className="px-5 py-10 text-center text-sm text-muted-foreground"
                    >
                      No charts match "{query}".
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        <p className="text-[11px] text-muted-foreground">
          Signed in as {email}. Vitals shown are synthetic for design review —
          live device telemetry will replace this feed.
        </p>
      </div>
    </main>
  );
}

function Th({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <th className={`px-5 py-2.5 font-semibold ${className}`}>{children}</th>
  );
}

function Vital({
  label,
  value,
  alert,
}: {
  label: string;
  value: string;
  alert: boolean;
}) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div
        className={`text-sm font-bold ${alert ? "text-red-600" : "text-foreground"}`}
      >
        {value}
      </div>
    </div>
  );
}

function StatCard({
  icon: Icon,
  label,
  value,
  sub,
  tone,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  sub?: string;
  tone: "navy" | "teal" | "red";
}) {
  const tones = {
    navy: "bg-[var(--navy)] text-white",
    teal: "bg-[var(--teal)] text-white",
    red: "bg-red-600 text-white",
  } as const;
  return (
    <div className="rounded-xl border border-border bg-card p-4 flex items-center gap-4">
      <div
        className={`h-11 w-11 rounded-lg grid place-items-center ${tones[tone]}`}
      >
        <Icon className="h-5 w-5" />
      </div>
      <div className="min-w-0">
        <div className="text-xs uppercase tracking-wider text-muted-foreground">
          {label}
        </div>
        <div className="flex items-baseline gap-2">
          <div className="text-2xl font-semibold tracking-tight tabular-nums">
            {value}
          </div>
          {sub && (
            <div className="text-xs text-muted-foreground truncate">{sub}</div>
          )}
        </div>
      </div>
    </div>
  );
}
