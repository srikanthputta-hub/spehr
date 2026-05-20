import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";
import { ShieldCheck, ToggleRight, Users, Activity, Loader2, Zap } from "lucide-react";
import { FACILITIES, type Facility } from "@/lib/facility-context";

export const Route = createFileRoute("/system-admin")({
  component: SystemAdminPage,
});

type Perm = {
  id: string;
  target_role: string;
  feature_key: string;
  feature_name: string;
  is_active: boolean;
};

const TABS = [
  { id: "feature_controls" as const, label: "🎛️ UI & Feature Controls", icon: ToggleRight },
  { id: "users" as const, label: "👥 Users", icon: Users },
  { id: "audit" as const, label: "📜 Audit Log", icon: Activity },
];

const ROLE_LABELS: Record<string, string> = {
  RN: "Registered Nurse (RN)",
  MD: "Attending Physician (MD)",
  PharmD: "Clinical Pharmacist (PharmD)",
  RT: "Respiratory Therapist (RT)",
  Admin: "Unit Administrator",
  Lab: "Laboratory Technician (CLT)",
};

function SystemAdminPage() {
  const [tab, setTab] = useState<(typeof TABS)[number]["id"]>("feature_controls");
  const [perms, setPerms] = useState<Perm[]>([]);
  const [loading, setLoading] = useState(true);
  const [updating, setUpdating] = useState<string | null>(null);
  const [selectedFacility, setSelectedFacility] = useState<Facility>("Memorial Hospital");
  const [automation, setAutomation] = useState<boolean | null>(null);
  const [automationSaving, setAutomationSaving] = useState(false);
  const [isAdmin, setIsAdmin] = useState(true);

  useEffect(() => {
    let active = true;
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!active || !user) return;
      const { data } = await supabase
        .from("user_roles")
        .select("role")
        .eq("user_id", user.id);
      if (!active) return;
      const roles = (data ?? []).map((r: any) => r.role);
      setIsAdmin(true || roles.includes("it_admin"));
    })();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    (async () => {
      const { data, error } = await supabase
        .from("system_settings")
        .select("automation_enabled")
        .eq("id", 1)
        .maybeSingle();
      if (!active) return;
      if (error) {
        toast.error("Failed to load automation state", { description: error.message });
        setAutomation(false);
      } else {
        setAutomation(Boolean((data as any)?.automation_enabled));
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  const toggleAutomation = async () => {
    if (automation === null || automationSaving) return;
    const next = !automation;
    setAutomation(next);
    setAutomationSaving(true);
    const { error } = await supabase
      .from("system_settings")
      .update({ automation_enabled: next })
      .eq("id", 1);
    setAutomationSaving(false);
    if (error) {
      setAutomation(!next);
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

  const load = async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from("role_permissions")
      .select("id, target_role, feature_key, feature_name, is_active")
      .eq("facility_name", selectedFacility)
      .order("target_role")
      .order("feature_key");
    if (error) {
      toast.error("Failed to load permissions", { description: error.message });
    } else {
      setPerms((data as any) ?? []);
    }
    setLoading(false);
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedFacility]);

  const toggle = async (p: Perm, next: boolean) => {
    setUpdating(p.id);
    const prev = perms;
    setPerms((rows) => rows.map((r) => (r.id === p.id ? { ...r, is_active: next } : r)));
    const { error } = await supabase
      .from("role_permissions")
      .update({ is_active: next })
      .eq("feature_key", p.feature_key)
      .eq("target_role", p.target_role)
      .eq("facility_name", selectedFacility);
    setUpdating(null);
    if (error) {
      setPerms(prev);
      toast.error("Could not update flag", { description: error.message });
      return;
    }
    toast.success(
      `Updated '${p.feature_name}' for ${p.target_role}`,
      { description: `${next ? "Enabled" : "Disabled"} · ${selectedFacility}` },
    );
  };

  const grouped = perms.reduce<Record<string, Perm[]>>((acc, p) => {
    (acc[p.target_role] ??= []).push(p);
    return acc;
  }, {});

  return (
    <main className="min-h-screen bg-slate-50">
      <header className="bg-[#0c2340] text-white">
        <div className="max-w-6xl mx-auto px-6 py-5 flex items-center gap-3">
          <div className="grid place-items-center h-10 w-10 rounded-lg bg-[#2d8a9e]">
            <ShieldCheck className="h-5 w-5" />
          </div>
          <div className="leading-tight">
            <div className="text-[10px] uppercase tracking-[0.28em] text-slate-300">
              S.P.E.H.R. EHR Specialist
            </div>
            <div className="text-base font-semibold">Command Center · System Administration</div>
          </div>
          <Link
            to="/"
            className="ml-auto text-xs text-slate-300 hover:text-white underline-offset-2 hover:underline"
          >
            ← Exit to gateway
          </Link>
        </div>
        <nav className="max-w-6xl mx-auto px-6 flex gap-1">
          {TABS.map((t) => {
            const Icon = t.icon;
            const active = tab === t.id;
            return (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={`inline-flex items-center gap-2 px-4 py-2.5 text-xs font-semibold rounded-t-md transition cursor-pointer ${
                  active
                    ? "bg-slate-50 text-[#0c2340]"
                    : "text-slate-300 hover:text-white hover:bg-white/5"
                }`}
              >
                <Icon className="h-3.5 w-3.5" />
                {t.label}
              </button>
            );
          })}
        </nav>
      </header>

      <section className="max-w-6xl mx-auto px-6 py-8">
        {isAdmin && (
        <div
          className={`mb-6 rounded-xl border shadow-sm overflow-hidden ${
            automation
              ? "border-emerald-300 bg-gradient-to-r from-emerald-50 to-white"
              : "border-slate-200 bg-white"
          }`}
        >
          <div className="flex items-center justify-between gap-6 px-6 py-5">
            <div className="flex items-center gap-4 min-w-0">
              <div
                className={`grid place-items-center h-12 w-12 rounded-lg ${
                  automation ? "bg-emerald-500 text-white" : "bg-slate-200 text-slate-500"
                }`}
              >
                <Zap className="h-5 w-5" />
              </div>
              <div className="min-w-0">
                <div className="text-[10px] font-semibold uppercase tracking-[0.22em] text-slate-500">
                  ⚙️ Global System Controls
                </div>
                <div className="text-base font-semibold text-slate-900">
                  Automate Hospital Network (AI Engines)
                </div>
                <div className="text-xs text-slate-600 mt-0.5">
                  Controls all background engines: ghost admissions, discharges, lab
                  ordering/results, and medication cascades across every facility.
                </div>
              </div>
            </div>
            <div className="flex items-center gap-3 shrink-0">
              <div className="flex items-center gap-2">
                <span className="relative flex h-2.5 w-2.5">
                  {automation && (
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                  )}
                  <span
                    className={`relative inline-flex h-2.5 w-2.5 rounded-full ${
                      automation ? "bg-emerald-500" : "bg-slate-400"
                    }`}
                  />
                </span>
                <span
                  className={`text-[11px] font-bold uppercase tracking-wider ${
                    automation ? "text-emerald-700" : "text-slate-500"
                  }`}
                >
                  {automation === null ? "Loading…" : automation ? "Engines Active" : "Paused"}
                </span>
              </div>
              <button
                onClick={toggleAutomation}
                disabled={automation === null || automationSaving}
                className={`relative inline-flex h-7 w-14 items-center rounded-full border transition-colors disabled:opacity-50 cursor-pointer ${
                  automation
                    ? "bg-emerald-500 border-emerald-600"
                    : "bg-slate-200 border-slate-300"
                }`}
                aria-pressed={!!automation}
              >
                <span
                  className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${
                    automation ? "translate-x-8" : "translate-x-1"
                  }`}
                />
              </button>
            </div>
          </div>
        </div>
        )}

        {tab === "feature_controls" && (
          <div className="space-y-6">
            <div>
              <h1 className="text-xl font-semibold text-slate-900">
                🎛️ UI &amp; Feature Controls
              </h1>
              <p className="text-sm text-slate-600 mt-1">
                Master switches for in-app actions, scoped per hospital. Toggling a switch
                instantly updates button visibility for users of that role at the selected facility.
              </p>
            </div>

            <div className="rounded-xl border border-slate-200 bg-white shadow-sm px-5 py-4">
              <label className="block text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-500 mb-1.5">
                🏥 Select Network Facility to Configure
              </label>
              <select
                value={selectedFacility}
                onChange={(e) => setSelectedFacility(e.target.value as Facility)}
                className="w-full md:w-96 h-10 rounded-md border border-slate-300 bg-white px-3 text-sm font-medium text-slate-900 outline-none hover:border-[#2d8a9e] focus:border-[#2d8a9e] focus:ring-2 focus:ring-[#2d8a9e]/30 cursor-pointer"
              >
                {FACILITIES.map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </select>
              <p className="mt-2 text-[11px] text-slate-500">
                Permissions below apply only to staff logged in at{" "}
                <span className="font-semibold text-slate-700">{selectedFacility}</span>.
              </p>
            </div>

            {loading ? (
              <div className="flex items-center gap-2 text-sm text-slate-500">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading feature flags…
              </div>
            ) : (
              <div className="grid gap-5 md:grid-cols-2">
                {Object.entries(grouped).map(([role, list]) => (
                  <div
                    key={role}
                    className="rounded-xl border border-slate-200 bg-white shadow-sm overflow-hidden"
                  >
                    <div className="px-5 py-3 border-b border-slate-100 bg-slate-50/60">
                      <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                        Role Scope
                      </div>
                      <div className="text-sm font-semibold text-slate-900">
                        {ROLE_LABELS[role] ?? role}
                      </div>
                    </div>
                    <ul className="divide-y divide-slate-100">
                      {list.map((p) => (
                        <li
                          key={p.id}
                          className="flex items-center justify-between gap-4 px-5 py-3"
                        >
                          <div className="min-w-0">
                            <div className="text-sm font-medium text-slate-900 truncate">
                              {p.feature_name}
                            </div>
                            <div className="text-[11px] text-slate-500 font-mono">
                              {p.feature_key}
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            <span
                              className={`text-[10px] font-semibold uppercase tracking-wider ${
                                p.is_active ? "text-emerald-600" : "text-slate-400"
                              }`}
                            >
                              {p.is_active ? "Enabled" : "Disabled"}
                            </span>
                            <Switch
                              checked={p.is_active}
                              disabled={updating === p.id}
                              onCheckedChange={(v) => toggle(p, v)}
                            />
                          </div>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {tab === "users" && (
          <div className="rounded-xl border border-slate-200 bg-white p-8 text-sm text-slate-500">
            User directory module — connect to identity registry to manage staff accounts.
          </div>
        )}
        {tab === "audit" && (
          <div className="rounded-xl border border-slate-200 bg-white p-8 text-sm text-slate-500">
            Audit log stream — surfaced from MAR, e-sign, and transfer registries.
          </div>
        )}
      </section>
    </main>
  );
}
