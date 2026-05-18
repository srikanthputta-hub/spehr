import { createFileRoute, Link } from "@tanstack/react-router";
import {
  HeartPulse,
  ShieldCheck,
  Stethoscope,
  Pill,
  Wind,
  ClipboardList,
  Activity,
  Lock,
  ChevronRight,
} from "lucide-react";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "S.P.E.H.R. Clinical System — Role Gateway" },
      {
        name: "description",
        content:
          "S Group Private Network secure clinical role gateway. Select your role to enter the live clinical workspace.",
      },
    ],
  }),
  component: LoginScreen,
});

type Role = {
  title: string;
  abbrev: string;
  to: "/nursing-board" | "/physician-board" | "/pharmacy-queue" | "/respiratory-board" | "/unit-manager";
  icon: React.ComponentType<{ className?: string }>;
  blurb: string;
  badge: string;
};

const ROLES: Role[] = [
  {
    title: "Registered Nurse",
    abbrev: "RN",
    to: "/nursing-board",
    icon: HeartPulse,
    blurb: "Bedside status board, vitals, MAR, shift notes.",
    badge: "Nursing",
  },
  {
    title: "Attending Physician",
    abbrev: "MD",
    to: "/physician-board",
    icon: Stethoscope,
    blurb: "Patient panel, orders, clinical review queue.",
    badge: "Provider",
  },
  {
    title: "Clinical Pharmacist",
    abbrev: "PharmD",
    to: "/pharmacy-queue",
    icon: Pill,
    blurb: "Verification queue, interaction checks, dosing.",
    badge: "Pharmacy",
  },
  {
    title: "Respiratory Therapist",
    abbrev: "RT",
    to: "/respiratory-board",
    icon: Wind,
    blurb: "Ventilator rounds, SpO₂ trends, treatments.",
    badge: "Respiratory",
  },
  {
    title: "Unit Admin",
    abbrev: "Admin",
    to: "/unit-manager",
    icon: ClipboardList,
    blurb: "Census, staffing grid, throughput metrics.",
    badge: "Operations",
  },
];

function LoginScreen() {
  return (
    <main className="min-h-screen bg-[#05080f] text-slate-100 relative overflow-hidden">
      {/* ambient glow */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          background:
            "radial-gradient(60% 50% at 20% 0%, rgba(45,138,158,0.18), transparent 60%), radial-gradient(50% 40% at 100% 100%, rgba(79,70,229,0.15), transparent 60%)",
        }}
      />
      <div
        className="absolute inset-0 opacity-[0.06] pointer-events-none"
        style={{
          backgroundImage:
            "linear-gradient(to right, #7dd3fc 1px, transparent 1px), linear-gradient(to bottom, #7dd3fc 1px, transparent 1px)",
          backgroundSize: "48px 48px",
        }}
      />

      {/* top bar */}
      <header className="relative flex items-center justify-between px-6 sm:px-10 py-5 border-b border-white/5">
        <div className="flex items-center gap-3">
          <div className="grid place-items-center h-10 w-10 rounded-lg bg-[#2d8a9e] shadow-lg shadow-black/40">
            <HeartPulse className="h-5 w-5" strokeWidth={2.4} />
          </div>
          <div className="leading-tight">
            <div className="text-[10px] uppercase tracking-[0.28em] text-slate-400">
              S Group
            </div>
            <div className="text-sm font-semibold">Private Network</div>
          </div>
        </div>
        <div className="hidden sm:flex items-center gap-4 text-xs text-slate-400">
          <span className="inline-flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
            Network secure
          </span>
          <span className="inline-flex items-center gap-1.5">
            <Lock className="h-3.5 w-3.5" /> TLS 1.3
          </span>
          <span className="inline-flex items-center gap-1.5">
            <ShieldCheck className="h-3.5 w-3.5 text-[#5cbdb9]" /> HIPAA mode
          </span>
        </div>
      </header>

      {/* hero */}
      <section className="relative px-6 sm:px-10 pt-14 pb-10 max-w-6xl mx-auto">
        <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-[11px] uppercase tracking-[0.18em] text-slate-300">
          <Activity className="h-3 w-3 text-[#5cbdb9]" />
          Clinical Workstation · Role Gateway
        </div>
        <h1 className="mt-5 text-4xl sm:text-5xl font-semibold tracking-tight leading-[1.05]">
          S.P.E.H.R. <span className="text-[#5cbdb9]">Clinical System</span>
        </h1>
        <p className="mt-3 text-sm sm:text-base text-slate-400 max-w-xl">
          S Group Private Network · Unified bedside, provider, pharmacy and
          operations workspace. Select your demo role below to enter the live
          clinical environment.
        </p>
      </section>

      {/* role grid */}
      <section className="relative px-6 sm:px-10 pb-20 max-w-6xl mx-auto">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xs uppercase tracking-[0.22em] text-slate-500">
            Demo Login
          </h2>
          <span className="text-[11px] text-slate-500">
            No password required · Audit-logged session
          </span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {ROLES.map((r) => {
            const Icon = r.icon;
            return (
              <Link
                key={r.to}
                to={r.to}
                className="group relative rounded-xl border border-white/10 bg-gradient-to-b from-white/[0.04] to-white/[0.015] p-5 transition hover:border-[#2d8a9e]/60 hover:from-[#2d8a9e]/10 hover:to-white/[0.02] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#5cbdb9]/60"
              >
                <div className="flex items-start justify-between">
                  <div className="grid place-items-center h-11 w-11 rounded-lg bg-[#0f1b2d] ring-1 ring-white/10 group-hover:ring-[#5cbdb9]/40 transition">
                    <Icon className="h-5 w-5 text-[#5cbdb9]" />
                  </div>
                  <span className="text-[10px] uppercase tracking-[0.18em] text-slate-500">
                    {r.badge}
                  </span>
                </div>
                <div className="mt-4 flex items-baseline gap-2">
                  <h3 className="text-base font-semibold text-slate-100">
                    {r.title}
                  </h3>
                  <span className="text-[11px] font-medium text-[#5cbdb9]">
                    {r.abbrev}
                  </span>
                </div>
                <p className="mt-1.5 text-xs leading-relaxed text-slate-400">
                  {r.blurb}
                </p>
                <div className="mt-5 flex items-center justify-between text-xs">
                  <span className="text-slate-500">Enter workspace</span>
                  <span className="inline-flex items-center gap-1 font-medium text-slate-200 group-hover:text-[#5cbdb9] transition">
                    Sign in <ChevronRight className="h-3.5 w-3.5" />
                  </span>
                </div>
              </Link>
            );
          })}
        </div>

        <p className="mt-10 text-[11px] text-slate-600 text-center">
          © {new Date().getFullYear()} S Group Health Network · Authorized
          personnel only · Sessions are monitored and audit-logged
        </p>
      </section>
    </main>
  );
}