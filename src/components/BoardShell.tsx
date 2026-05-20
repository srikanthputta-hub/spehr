import { Link, useNavigate } from "@tanstack/react-router";
import { HeartPulse, LogOut, Construction, ClipboardList, Zap } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { FacilitySwitcher, useFacility } from "@/lib/facility-context";

function AutomationToggle() {
  const [on, setOn] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    (async () => {
      const { data } = await supabase
        .from("system_settings")
        .select("automation_enabled")
        .eq("id", 1)
        .maybeSingle();
      if (active) {
        setOn(Boolean((data as any)?.automation_enabled));
        setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  const toggle = async () => {
    const next = !on;
    setOn(next);
    const { error } = await supabase
      .from("system_settings")
      .update({ automation_enabled: next })
      .eq("id", 1);
    if (error) {
      setOn(!next);
      toast.error("Could not update automation", { description: error.message });
      return;
    }
    if (next) {
      toast.success("System Automation Engaged", {
        description: "Background engines active.",
      });
    } else {
      toast("System Automation Paused", {
        description: "Manual mode active.",
      });
    }
  };

  return (
    <button
      onClick={toggle}
      disabled={loading}
      title="Automate Hospital Network"
      className={`relative inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-xs font-semibold transition ${
        on
          ? "border-emerald-400 bg-emerald-50 text-emerald-800 shadow-[0_0_0_3px_rgba(16,185,129,0.12)]"
          : "border-slate-200 bg-slate-50 text-slate-500 hover:bg-slate-100"
      }`}
    >
      <span className="relative flex h-2 w-2">
        {on && (
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
        )}
        <span
          className={`relative inline-flex h-2 w-2 rounded-full ${
            on ? "bg-emerald-500" : "bg-slate-400"
          }`}
        />
      </span>
      <Zap className="h-3.5 w-3.5" />
      Automate Hospital Network
      <span
        className={`ml-1 rounded px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider ${
          on ? "bg-emerald-500 text-white" : "bg-slate-300 text-slate-600"
        }`}
      >
        {on ? "On" : "Off"}
      </span>
    </button>
  );
}

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
        <AutomationToggle />
        <Link
          to="/tasks"
          className="inline-flex items-center gap-1.5 rounded-md border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs font-semibold text-amber-800 hover:bg-amber-100"
        >
          <ClipboardList className="h-3.5 w-3.5" /> 📋 Task List
        </Link>
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