import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import {
  ShieldCheck,
  Activity,
  Lock,
  ArrowRight,
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

type RoleRoute =
  | "/nursing-board"
  | "/physician-board"
  | "/pharmacy-queue"
  | "/finance-board"
  | "/admin-dashboard"
  | "/lab-board"
  | "/system-admin";

const ROLES: { value: RoleRoute; label: string; abbrev: StaffRole | "EHR" }[] = [
  { value: "/nursing-board", label: "Registered Nurse", abbrev: "RN" },
  { value: "/physician-board", label: "Attending Physician", abbrev: "MD" },
  { value: "/pharmacy-queue", label: "Clinical Pharmacist", abbrev: "PharmD" },
  { value: "/lab-board", label: "Laboratory Technician", abbrev: "Lab" },
  { value: "/admin-dashboard", label: "Unit Administrator", abbrev: "Admin" },
  { value: "/finance-board", label: "Corporate Finance & Accounts", abbrev: "Finance" },
  { value: "/system-admin", label: "Command Center · System Administration", abbrev: "EHR" },
];

function LoginScreen() {
  const navigate = useNavigate();
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
          <img src={spehrLogo.url} alt="S.P.E.H.R." className="h-10 w-auto" />
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

      {/* centered login */}
      <section className="relative px-6 sm:px-10 py-10 max-w-md mx-auto">
        <div className="flex justify-center pb-8">
          <img src={spehrLogo.url} alt="S.P.E.H.R." className="h-24 w-auto" />
        </div>
        <div className="rounded-2xl border border-white/10 bg-gradient-to-b from-white/[0.05] to-white/[0.015] p-8 shadow-2xl shadow-black/40 backdrop-blur-sm">
          <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-[10px] uppercase tracking-[0.18em] text-slate-300">
            <Activity className="h-3 w-3 text-[#5cbdb9]" />
            Role Gateway
          </div>
          <h1 className="mt-4 text-2xl font-semibold tracking-tight leading-tight">
            S.P.E.H.R
          </h1>
          <p className="mt-1.5 text-xs text-slate-400">
            Simulated Patient Electronic Health Records
          </p>

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

        <p className="mt-8 text-[11px] text-slate-600 text-center max-w-sm mx-auto">
          Disclaimer: All patient data displayed in this system is 100% fabricated for simulation purposes and contains no real Protected Health Information (PHI).
        </p>
      </section>
    </main>
  );
}