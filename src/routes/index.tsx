import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import {
  ShieldCheck,
  Activity,
  Lock,
  ArrowRight,
  ArrowLeft,
  Stethoscope,
  FlaskConical,
  BarChart3,
} from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { FACILITIES, useFacility, STAFF_BY_FACILITY, type StaffRole } from "@/lib/facility-context";
import spehrLogo from "@/assets/spehr-logo.png.asset.json";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "S.P.E.H.R. — Network Hub" },
      {
        name: "description",
        content:
          "S Group Private Network hub. Choose Clinical, Ancillary, or Analytics workspace to enter the live network.",
      },
    ],
  }),
  component: LoginScreen,
});

type RoleRoute =
  | "/nursing-board"
  | "/physician-board"
  | "/finance-board"
  | "/admin-dashboard"
  | "/admissions-board"
  | "/ancillary-services"
  | "/system-admin";

const ROLES: { value: RoleRoute; label: string; abbrev: StaffRole | "EHR" }[] = [
  { value: "/admissions-board", label: "Admissions / Reception", abbrev: "Reception" },
  { value: "/nursing-board", label: "Registered Nurse", abbrev: "RN" },
  { value: "/physician-board", label: "Attending Physician", abbrev: "MD" },
  { value: "/ancillary-services", label: "Clinical Ancillary Services", abbrev: "Ancillary" as unknown as StaffRole },
  { value: "/admin-dashboard", label: "Clinical Site Manager", abbrev: "Admin" },
  { value: "/finance-board", label: "Corporate Finance & Accounts", abbrev: "Finance" },
  { value: "/system-admin", label: "Command Center · System Administration", abbrev: "EHR" },
];

const ANCILLARY_URL = "https://www.spehrancillary.live";
const ANALYTICS_URL = "https://www.spehranalytics.live";

function LoginScreen() {
  const navigate = useNavigate();
  const [view, setView] = useState<"hub" | "clinical">("hub");
  const [role, setRole] = useState<RoleRoute | "">("");
  const { facility, setFacility, setActiveRole } = useFacility();
  const selectedRole = ROLES.find((r) => r.value === role);
  const isEhr = selectedRole?.abbrev === "EHR";
  const activeStaff =
    selectedRole && !isEhr ? STAFF_BY_FACILITY[facility][selectedRole.abbrev as StaffRole] : null;

  const handleLaunch = () => {
    if (!role) return;
    if (selectedRole && !isEhr) setActiveRole(selectedRole.abbrev as StaffRole);
    if (isEhr) {
      try {
        localStorage.setItem("spehr.activeRole", "EHR");
      } catch {}
    }
    navigate({ to: role });
  };

  return (
    <main className="min-h-screen bg-[#05080f] text-slate-100 relative overflow-hidden">
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

      <header className="relative flex items-center justify-between px-6 sm:px-10 py-5 border-b border-white/5">
        <div className="flex items-center gap-3">
          <img src={spehrLogo.url} alt="S Group Private Network" className="h-10 w-auto" />
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

      <section className={`relative px-6 sm:px-10 py-10 mx-auto ${view === "hub" ? "max-w-lg" : "max-w-md"}`}>
        {view === "hub" && (
          <div className="text-center">
            <div className="flex justify-center mb-8">
              <img src={spehrLogo.url} alt="S Group Private Network" className="h-40 w-auto scale-125" />
            </div>
            <h1 className="text-3xl font-bold tracking-tight">S.P.E.H.R</h1>
            <p className="mt-2 text-sm text-slate-400">
              Simulated Patient Electronic Health Records
            </p>

            <div className="mt-8 space-y-3">
              <button
                type="button"
                onClick={() => setView("clinical")}
                className="w-full flex items-center gap-3 rounded-xl border border-white/10 bg-gradient-to-b from-white/[0.05] to-white/[0.015] px-5 py-4 text-left shadow-lg shadow-black/30 hover:border-[#5cbdb9]/40 hover:bg-white/[0.06] transition cursor-pointer group"
              >
                <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-[#2d8a9e]/15 text-[#5cbdb9]">
                  <Stethoscope className="h-5 w-5" />
                </span>
                <span className="flex-1">
                  <span className="block text-sm font-semibold">Clinical Workspace</span>
                  <span className="block text-[11px] text-slate-400">Role Gateway · Admissions, Nursing, Physician, Pharmacy…</span>
                </span>
                <ArrowRight className="h-4 w-4 text-slate-500 group-hover:text-[#5cbdb9] transition" />
              </button>

              <a
                href={ANCILLARY_URL}
                className="w-full flex items-center gap-3 rounded-xl border border-white/10 bg-gradient-to-b from-white/[0.05] to-white/[0.015] px-5 py-4 text-left shadow-lg shadow-black/30 hover:border-[#5cbdb9]/40 hover:bg-white/[0.06] transition cursor-pointer group"
              >
                <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-[#2d8a9e]/15 text-[#5cbdb9]">
                  <FlaskConical className="h-5 w-5" />
                </span>
                <span className="flex-1">
                  <span className="block text-sm font-semibold">Ancillary Workspace</span>
                  <span className="block text-[11px] text-slate-400">Labs · Pharmacy · Radiology</span>
                </span>
                <ArrowRight className="h-4 w-4 text-slate-500 group-hover:text-[#5cbdb9] transition" />
              </a>

              <a
                href={ANALYTICS_URL}
                className="w-full flex items-center gap-3 rounded-xl border border-white/10 bg-gradient-to-b from-white/[0.05] to-white/[0.015] px-5 py-4 text-left shadow-lg shadow-black/30 hover:border-[#5cbdb9]/40 hover:bg-white/[0.06] transition cursor-pointer group"
              >
                <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-[#2d8a9e]/15 text-[#5cbdb9]">
                  <BarChart3 className="h-5 w-5" />
                </span>
                <span className="flex-1">
                  <span className="block text-sm font-semibold">Analytics Workspace</span>
                  <span className="block text-[11px] text-slate-400">Billing · RCM · Population Health</span>
                </span>
                <ArrowRight className="h-4 w-4 text-slate-500 group-hover:text-[#5cbdb9] transition" />
              </a>
            </div>

            <p className="mt-8 text-[11px] text-slate-600 text-center max-w-sm mx-auto">
              Disclaimer: All patient data displayed in this system is 100% fabricated for simulation purposes and contains no real Protected Health Information (PHI).
            </p>
          </div>
        )}

        {view === "clinical" && (
          <div className="rounded-2xl border border-white/10 bg-gradient-to-b from-white/[0.05] to-white/[0.015] p-8 shadow-2xl shadow-black/40 backdrop-blur-sm">
            <button
              type="button"
              onClick={() => setView("hub")}
              className="inline-flex items-center gap-1.5 text-[11px] text-slate-400 hover:text-[#5cbdb9] transition cursor-pointer mb-4"
            >
              <ArrowLeft className="h-3.5 w-3.5" /> Back
            </button>

            <div className="mt-7 space-y-2">
              <label className="block text-[11px] uppercase tracking-[0.18em] text-slate-400">
                Select Demo Role to Enter System
              </label>
              <Select value={role} onValueChange={(v) => setRole(v as RoleRoute)}>
                <SelectTrigger className="h-11 bg-[#0a1220] border-white/10 text-slate-100 hover:border-[#5cbdb9]/40 focus:ring-[#5cbdb9]/60">
                  <SelectValue placeholder="Choose a clinical role…" />
                </SelectTrigger>
                <SelectContent className="bg-[#0a1220] border-white/10 text-slate-100">
                  {ROLES.map((r) => (
                    <SelectItem
                      key={r.value}
                      value={r.value}
                      className="focus:bg-[#2d8a9e]/20 focus:text-slate-50"
                    >
                      <span className="font-medium">{r.label}</span>
                      <span className="ml-2 text-[11px] text-[#5cbdb9]">
                        {r.abbrev}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {activeStaff && !isEhr && (
              <div className="mt-4 rounded-lg border border-[#5cbdb9]/25 bg-[#0a1220]/70 p-3 space-y-2">
                <label className="block text-[10px] uppercase tracking-[0.18em] text-slate-400">
                  Facility Network · Auto-binds {activeStaff.roleLabel} Identity
                </label>
                <select
                  value={facility}
                  onChange={(e) => setFacility(e.target.value as any)}
                  className="w-full h-10 rounded-md bg-[#0a1220] border border-white/10 text-slate-100 text-sm px-2 outline-none hover:border-[#5cbdb9]/40 focus:border-[#5cbdb9]/60 cursor-pointer"
                >
                  {FACILITIES.map((f) => (
                    <option key={f} value={f} className="text-slate-900">
                      {f}
                    </option>
                  ))}
                </select>
                <div className="flex items-center justify-between gap-2 pt-1 text-[11px]">
                  <span className="text-slate-400">Signing in as</span>
                  <span className="font-medium text-[#5cbdb9]">
                    {activeStaff.name} · {activeStaff.ward}
                  </span>
                </div>
              </div>
            )}

            <button
              type="button"
              onClick={handleLaunch}
              disabled={!role}
              className="mt-5 w-full inline-flex items-center justify-center gap-2 h-11 rounded-md bg-[#2d8a9e] text-white font-semibold text-sm shadow-lg shadow-[#2d8a9e]/20 hover:bg-[#34a0b6] transition disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#5cbdb9]/60"
            >
              Launch Clinical Workspace
              <ArrowRight className="h-4 w-4" />
            </button>

            <p className="mt-4 text-center text-[11px] text-slate-500">
              No password required · Audit-logged session
            </p>
          </div>
        )}
      </section>
    </main>
  );
}
