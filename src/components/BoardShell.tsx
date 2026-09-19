import { Link, useNavigate } from "@tanstack/react-router";
import { LogOut, Construction, Users, Hand, Zap, MoreVertical } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { FacilitySwitcher, useFacility } from "@/lib/facility-context";
import { useAutomationEnabled } from "@/hooks/useAutomationEnabled";
import spehrLogo from "@/assets/spehr-logo.png";

import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";

const ROLE_LINKS: { to: string; label: string; abbrev: string }[] = [
  { to: "/admissions-board", label: "Admissions / Reception", abbrev: "Reception" },
  { to: "/nursing-board", label: "Registered Nurse", abbrev: "RN" },
  { to: "/physician-board", label: "Attending Physician", abbrev: "MD" },
  { to: "/ancillary-services", label: "Clinical Ancillary Services", abbrev: "Ancillary" },
  { to: "/admin-dashboard", label: "Clinical Site Manager", abbrev: "Admin" },
  { to: "/finance-board", label: "Corporate Finance & Accounts", abbrev: "Finance" },
  { to: "/system-admin", label: "Command Center · System Administration", abbrev: "EHR" },
];

export function BoardHeader({
  title,
  subtitle,
  badge,
  hideFacilitySwitcher,
}: {
  title: string;
  subtitle?: string;
  badge?: string;
  hideFacilitySwitcher?: boolean;
}) {
  const navigate = useNavigate();
  const { facility } = useFacility();
  const automationEnabled = useAutomationEnabled();
  const logout = async () => {
    await supabase.auth.signOut().catch(() => {});
    navigate({ to: "/" }).catch(() => {});
  };
  return (
    <header className="flex items-center justify-between gap-2 border-b border-slate-200 bg-white px-3 py-2 md:px-6 md:py-3">
      <div className="flex items-center gap-2 md:gap-3 min-w-0">
        <Link to="/" className="flex items-center shrink-0">
          <img src={spehrLogo} alt="S Group Private Network" className="h-6 w-auto md:h-8" />
        </Link>
        <div className="leading-tight min-w-0">
          <div className="hidden md:block text-[10px] uppercase tracking-[0.22em] text-slate-500">
            S.P.E.H.R. · {badge ?? "Clinical"}
          </div>
          <div className="text-sm font-semibold text-slate-900 truncate max-w-[160px] sm:max-w-[280px] md:max-w-none">
            {title}
          </div>
          {subtitle && (
            <div className="hidden md:block text-[11px] text-slate-500">{subtitle}</div>
          )}
          <div className="hidden md:block text-[10px] text-slate-500 mt-0.5">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-500 mr-1 align-middle" />
            {facility}
          </div>
        </div>
      </div>

      <div className="flex items-center gap-1.5 md:gap-3 shrink-0">
        {/* AI status pill — icon-only under sm:, icon+label from sm: up, unchanged from md: up */}
        <span
          title={
            automationEnabled
              ? "AI engines are running across the hospital network"
              : "All AI engines paused — every action must be performed manually"
          }
          className={`inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 sm:px-2.5 sm:py-1.5 text-[10px] font-bold uppercase tracking-wider border ${
            automationEnabled
              ? "bg-emerald-50 text-emerald-700 border-emerald-200"
              : "bg-amber-50 text-amber-800 border-amber-300"
          }`}
        >
          {automationEnabled ? <Zap className="h-3 w-3" /> : <Hand className="h-3 w-3" />}
          <span className="hidden sm:inline">{automationEnabled ? "AI Engines" : "Manual Mode"}</span>
        </span>

        {/* Desktop-only inline controls — identical to current markup, just wrapped */}
        <div className="hidden md:flex items-center gap-3">
          {!hideFacilitySwitcher && <FacilitySwitcher variant="light" />}
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
                  onSelect={() => navigate({ to: r.to }).catch(() => {})}
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

        {/* Mobile-only overflow menu: facility switcher + switch role + log out */}
        <div className="md:hidden">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label="More options"
                className="inline-flex items-center justify-center h-8 w-8 rounded-md border border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
              >
                <MoreVertical className="h-4 w-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" sideOffset={6} className="w-64">
              <DropdownMenuLabel className="text-[10px] uppercase tracking-[0.18em] text-slate-500 flex items-center gap-1">
                <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-500" />
                {facility}
              </DropdownMenuLabel>
              {!hideFacilitySwitcher && (
                <div className="px-2 py-1.5">
                  <FacilitySwitcher variant="light" />
                </div>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="text-[10px] uppercase tracking-[0.18em] text-slate-500">
                Switch Clinical Role
              </DropdownMenuLabel>
              {ROLE_LINKS.map((r) => (
                <DropdownMenuItem
                  key={r.to}
                  onSelect={() => navigate({ to: r.to }).catch(() => {})}
                  className="cursor-pointer flex items-center justify-between gap-3"
                >
                  <span className="text-sm text-slate-800">{r.label}</span>
                  <span className="text-[11px] font-semibold text-[#2d8a9e]">{r.abbrev}</span>
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={logout} className="cursor-pointer flex items-center gap-1.5 text-slate-800">
                <LogOut className="h-3.5 w-3.5" /> Log Out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
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