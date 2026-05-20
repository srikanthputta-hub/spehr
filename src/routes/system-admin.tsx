import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";
import { ShieldCheck, ToggleRight, Users, Activity, Loader2 } from "lucide-react";

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

  const load = async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from("role_permissions")
      .select("id, target_role, feature_key, feature_name, is_active")
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
  }, []);

  const toggle = async (p: Perm, next: boolean) => {
    setUpdating(p.id);
    const prev = perms;
    setPerms((rows) => rows.map((r) => (r.id === p.id ? { ...r, is_active: next } : r)));
    const { error } = await supabase
      .from("role_permissions")
      .update({ is_active: next })
      .eq("id", p.id);
    setUpdating(null);
    if (error) {
      setPerms(prev);
      toast.error("Could not update flag", { description: error.message });
      return;
    }
    toast.success(
      `${p.feature_name} ${next ? "enabled" : "disabled"} for ${ROLE_LABELS[p.target_role] ?? p.target_role}`,
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
        {tab === "feature_controls" && (
          <div className="space-y-6">
            <div>
              <h1 className="text-xl font-semibold text-slate-900">
                🎛️ UI &amp; Feature Controls
              </h1>
              <p className="text-sm text-slate-600 mt-1">
                Master switches for in-app actions. Toggling any switch instantly updates
                button visibility for every user of that role across the network.
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
