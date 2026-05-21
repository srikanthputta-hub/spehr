import { Link, useNavigate } from "@tanstack/react-router";
import { HeartPulse, LogOut, Construction, ClipboardList, Users } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { FacilitySwitcher, useFacility } from "@/lib/facility-context";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";

const ROLE_LINKS: { to: string; label: string; abbrev: string }[] = [
  { to: "/nursing-board", label: "Registered Nurse", abbrev: "RN" },
  { to: "/physician-board", label: "Attending Physician", abbrev: "MD" },
  { to: "/pharmacy-queue", label: "Clinical Pharmacist", abbrev: "PharmD" },
  { to: "/respiratory-board", label: "Respiratory Therapist", abbrev: "RT" },
  { to: "/admin-dashboard", label: "Unit Administrator", abbrev: "Admin" },
  { to: "/lab-board", label: "Laboratory Technician", abbrev: "Lab" },
  { to: "/system-admin", label: "EHR Specialist", abbrev: "EHR" },
];

export function BoardHeader({
  title,
  subtitle,
  badge,
}: {
  title: string;
  subtitle?: string;
  badge?: string;
}) {
  const navigate = useNavigate();
  const { facility } = useFacility();
  const logout = async () => {
    await supabase.auth.signOut().catch(() => {});
    navigate({ to: "/" }).catch(() => {});
  };
  return (
    <header className="flex items-center justify-between border-b border-slate-200 bg-white px-6 py-3">
      <div className="flex items-center gap-3">
        <Link to="/" className="grid place-items-center h-9 w-9 rounded-md bg-[#0c2340] text-white">
          <HeartPulse className="h-4 w-4" />
        </Link>
        <div className="leading-tight">
          <div className="text-[10px] uppercase tracking-[0.22em] text-slate-500">
            S.P.E.H.R. · {badge ?? "Clinical"}
          </div>
          <div className="text-sm font-semibold text-slate-900">{title}</div>
          {subtitle && (
            <div className="text-[11px] text-slate-500">{subtitle}</div>
          )}
          <div className="text-[10px] text-slate-500 mt-0.5">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-500 mr-1 align-middle" />
            {facility}
          </div>
        </div>
      </div>
      <div className="flex items-center gap-3">
        <FacilitySwitcher variant="light" />
        <Link
          to="/tasks"
          className="inline-flex items-center gap-1.5 rounded-md border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs font-semibold text-amber-800 hover:bg-amber-100"
        >
          <ClipboardList className="h-3.5 w-3.5" /> 📋 Task List
        </Link>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
            >
              <Users className="h-3.5 w-3.5" /> Switch Role
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" sideOffset={6} className="w-60">
            <DropdownMenuLabel className="text-[10px] uppercase tracking-[0.18em] text-slate-500">
              Switch Clinical Role
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            {ROLE_LINKS.map((r) => (
              <DropdownMenuItem
                key={r.to}
                onSelect={() => {
                  navigate({ to: r.to }).catch(() => {});
                }}
                className="cursor-pointer flex items-center justify-between gap-3"
              >
                <span className="text-sm text-slate-800">{r.label}</span>
                <span className="text-[11px] font-semibold text-[#2d8a9e]">{r.abbrev}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <button
          onClick={logout}
          className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
        >
          <LogOut className="h-3.5 w-3.5" /> Log Out
        </button>
      </div>
    </header>
  );
}

export function PlaceholderBoard({
  title,
  badge,
  description,
}: {
  title: string;
  badge: string;
  description: string;
}) {
  return (
    <main className="min-h-screen bg-slate-50">
      <BoardHeader title={title} badge={badge} subtitle="Demo workspace" />
      <section className="max-w-4xl mx-auto px-6 py-16">
        <div className="rounded-xl border border-dashed border-slate-300 bg-white p-12 text-center">
          <div className="mx-auto grid place-items-center h-12 w-12 rounded-lg bg-slate-100 text-slate-500">
            <Construction className="h-5 w-5" />
          </div>
          <h1 className="mt-4 text-xl font-semibold text-slate-900">{title}</h1>
          <p className="mt-2 text-sm text-slate-500 max-w-md mx-auto">
            {description}
          </p>
          <Link
            to="/"
            className="mt-6 inline-flex items-center gap-1.5 rounded-md bg-[#0c2340] px-4 py-2 text-xs font-medium text-white hover:bg-[#0c2340]/90"
          >
            Back to Role Gateway
          </Link>
        </div>
      </section>
    </main>
  );
}