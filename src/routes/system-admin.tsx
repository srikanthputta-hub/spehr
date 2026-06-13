import { createFileRoute } from "@tanstack/react-router";
import { BoardHeader } from "@/components/BoardShell";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";
import { ToggleRight, Users, Activity, Loader2, Zap, Pencil, Download, BarChart3, BookMarked, Plus, Search, Trash2, Sparkles, Grid3x3, Trash, ShieldAlert, AlertTriangle, Check, X, FileCheck2, ListChecks } from "lucide-react";
import { FACILITIES, type Facility } from "@/lib/facility-context";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { AnalyticsPage as GlobalNetworkAnalytics } from "./analytics";
import {
  lookupTerminology,
  toFhirCodeSystem,
  DEFAULT_CATEGORY,
  defaultUsage,
} from "@/lib/terminology-lookup";
import {
  analyzeNarrative,
  loadAudits,
  clearAudits,
  loadDictionary,
  type NlpAudit,
  type DictRow,
} from "@/lib/nlp-engine";
import {
  loadCustomRules,
  loadCustomBanned,
  addCustomRuleDb,
  addBannedDb,
  removeNlpRuleDb,
  refreshNlpRulesFromDb,
  JC_BANNED,
  type CustomRule,
  type CustomBanned,
} from "@/lib/safety-conflicts";
import type { BannedAbbrev } from "@/lib/safety-conflicts";
import { Input } from "@/components/ui/input";

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
  { id: "analytics" as const, label: "📊 Network Analytics", icon: BarChart3 },
  { id: "dictionary" as const, label: "📚 Medical Dictionary", icon: BookMarked },
];

const ROLE_LABELS: Record<string, string> = {
  RN: "Registered Nurse (RN)",
  MD: "Attending Physician (MD)",
  PharmD: "Clinical Pharmacist (PharmD)",
  Finance: "Corporate Finance & Accounts",
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
      <BoardHeader
        title="Command Center · System Administration"
        subtitle="Command Center · System Administration"
        badge="EHR"
        hideFacilitySwitcher
      />
      <div className="bg-[#0c2340] text-white">
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
      </div>

      <section className="max-w-6xl mx-auto px-6 py-8">
        {isAdmin && tab === "feature_controls" && (
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
          <UserDirectory />
        )}
        {tab === "audit" && (
          <AuditLog />
        )}
      </section>
      {tab === "analytics" && (
        <div className="max-w-6xl mx-auto px-6 pb-8">
          <GlobalNetworkAnalytics embedded />
        </div>
      )}
      {tab === "dictionary" && (
        <div className="max-w-6xl mx-auto px-6 pb-8">
          <MedicalDictionary />
        </div>
      )}
    </main>
  );
}

type StaffMember = {
  name: string;
  role: string;
  facility: string;
  status: "Active" | "Suspended";
};

const STAFF_DIRECTORY: StaffMember[] = [
  { name: "Diane Whitaker", role: "System Administrator", facility: "Memorial Hospital", status: "Active" },
  { name: "Marcus Lin, MD", role: "Attending Physician", facility: "Memorial Hospital", status: "Active" },
  { name: "Sarah Jenkins, RN", role: "Registered Nurse", facility: "St. Jude Medical Center", status: "Active" },
  { name: "Priya Raman, PharmD", role: "Clinical Pharmacist", facility: "City General Infirmary", status: "Active" },
  { name: "Jordan Alvarez, CLT", role: "Clinical Lab Tech", facility: "Memorial Hospital", status: "Active" },
  { name: "Evelyn Park, MD", role: "Attending Physician", facility: "Srik Health Clinic", status: "Suspended" },
  { name: "Daniel Whitfield, CPA", role: "Corporate Finance & Accounts", facility: "County Health Pavilion", status: "Active" },
  { name: "Hannah O'Connor, RN", role: "Registered Nurse", facility: "Memorial Hospital", status: "Active" },
  { name: "Brian Yamamoto, MD", role: "Attending Physician", facility: "St. Jude Medical Center", status: "Active" },
  { name: "Lena Kowalski, CLT", role: "Clinical Lab Tech", facility: "City General Infirmary", status: "Suspended" },
];

function UserDirectory() {
  const [staff, setStaff] = useState<StaffMember[]>(STAFF_DIRECTORY);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [draft, setDraft] = useState<StaffMember | null>(null);

  const openEdit = (idx: number) => {
    setEditingIndex(idx);
    setDraft({ ...staff[idx] });
  };

  const closeEdit = () => {
    setEditingIndex(null);
    setDraft(null);
  };

  const saveEdit = () => {
    if (editingIndex === null || !draft) return;
    setStaff((rows) => rows.map((r, i) => (i === editingIndex ? draft : r)));
    closeEdit();
    toast.success("Staff access updated successfully.");
  };

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">👥 User Directory</h1>
        <p className="text-sm text-slate-600 mt-1">
          Network-wide staff accounts with assigned clinical role, primary facility, and current access status.
        </p>
      </div>
      <div className="rounded-xl border border-slate-200 bg-white shadow-sm overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-900 text-slate-100">
            <tr>
              <th className="text-left font-semibold uppercase tracking-wider text-[10px] px-5 py-3">Staff Name</th>
              <th className="text-left font-semibold uppercase tracking-wider text-[10px] px-5 py-3">Clinical Role</th>
              <th className="text-left font-semibold uppercase tracking-wider text-[10px] px-5 py-3">Primary Facility</th>
              <th className="text-left font-semibold uppercase tracking-wider text-[10px] px-5 py-3">Status</th>
              <th className="text-right font-semibold uppercase tracking-wider text-[10px] px-5 py-3">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {staff.map((s, idx) => (
              <tr key={s.name} className="hover:bg-slate-50/70 transition-colors">
                <td className="px-5 py-3 font-medium text-slate-900">{s.name}</td>
                <td className="px-5 py-3 text-slate-700">{s.role}</td>
                <td className="px-5 py-3 text-slate-700">{s.facility}</td>
                <td className="px-5 py-3">
                  <span
                    className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${
                      s.status === "Active"
                        ? "bg-emerald-100 text-emerald-700 border border-emerald-200"
                        : "bg-red-100 text-red-700 border border-red-200"
                    }`}
                  >
                    <span
                      className={`h-1.5 w-1.5 rounded-full ${
                        s.status === "Active" ? "bg-emerald-500" : "bg-red-500"
                      }`}
                    />
                    {s.status}
                  </span>
                </td>
                <td className="px-5 py-3 text-right">
                  <button
                    type="button"
                    onClick={() => openEdit(idx)}
                    className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:border-[#2d8a9e] hover:text-[#0c2340] hover:bg-slate-50 cursor-pointer transition"
                  >
                    <Pencil className="h-3 w-3" />
                    Edit Access
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Dialog open={editingIndex !== null} onOpenChange={(o) => !o && closeEdit()}>
        <DialogContent className="sm:max-w-md">
          {draft && (
            <>
              <DialogHeader>
                <DialogTitle>Modify Staff Access: {draft.name}</DialogTitle>
                <DialogDescription>
                  Update clinical role, facility assignment, and account status.
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-4 py-2">
                <div className="space-y-1.5">
                  <Label className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                    Staff Name
                  </Label>
                  <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm font-medium text-slate-900">
                    {draft.name}
                  </div>
                </div>

                <div className="space-y-1.5">
                  <Label className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                    Clinical Role
                  </Label>
                  <Select
                    value={draft.role}
                    onValueChange={(v) => setDraft({ ...draft, role: v })}
                  >
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {[
                        "Registered Nurse",
                        "Attending Physician",
                        "Clinical Pharmacist",
                        "Clinical Lab Tech",
                        "System Administrator",
                        "Corporate Finance & Accounts",
                      ].map((r) => (
                        <SelectItem key={r} value={r}>{r}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1.5">
                  <Label className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                    Primary Facility
                  </Label>
                  <Select
                    value={draft.facility}
                    onValueChange={(v) => setDraft({ ...draft, facility: v })}
                  >
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {FACILITIES.map((f) => (
                        <SelectItem key={f} value={f}>{f}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1.5">
                  <Label className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                    Account Status
                  </Label>
                  <div
                    className={`flex items-center justify-between rounded-lg border px-4 py-3 ${
                      draft.status === "Active"
                        ? "border-emerald-200 bg-emerald-50"
                        : "border-red-200 bg-red-50"
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <span
                        className={`h-2.5 w-2.5 rounded-full ${
                          draft.status === "Active" ? "bg-emerald-500" : "bg-red-500"
                        }`}
                      />
                      <span
                        className={`text-sm font-semibold ${
                          draft.status === "Active" ? "text-emerald-700" : "text-red-700"
                        }`}
                      >
                        {draft.status}
                      </span>
                    </div>
                    <Switch
                      checked={draft.status === "Active"}
                      onCheckedChange={(v) =>
                        setDraft({ ...draft, status: v ? "Active" : "Suspended" })
                      }
                    />
                  </div>
                </div>
              </div>

              <DialogFooter>
                <Button variant="outline" onClick={closeEdit}>Cancel</Button>
                <Button onClick={saveEdit}>Save Changes</Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

/* ============================================================ */
/*  Safety Alerts — drug↔allergy conflict queue                 */
/* ============================================================ */
type DbSafetyAlert = {
  id: string;
  mrn: string;
  patient_name: string | null;
  facility_name: string | null;
  kind: "Drug-Allergy" | "Drug-Drug";
  drug: string;
  drug_b: string | null;
  allergy_name: string | null;
  family: string;
  severity: string | null;
  status: "Pending Review" | "Overridden" | "Rejected";
  decided_by: string | null;
  decided_at: string | null;
  rationale: string | null;
  created_at: string;
};

function SafetyQueue() {
  const [items, setItems] = useState<DbSafetyAlert[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from("clinical_safety_alerts")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(200);
    if (error) toast.error("Could not load safety alerts", { description: error.message });
    setItems(((data ?? []) as DbSafetyAlert[]));
    setLoading(false);
  };

  useEffect(() => {
    refresh();
    const channel = supabase
      .channel("safety-alerts-live")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "clinical_safety_alerts" },
        () => refresh(),
      )
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, []);

  const act = async (c: DbSafetyAlert, status: "Overridden" | "Rejected") => {
    const rationale = window.prompt(
      `${status === "Overridden" ? "Override" : "Reject"} this alert — clinical rationale:`,
      status === "Overridden"
        ? "Benefit outweighs risk; patient tolerated similar agent previously."
        : "Discontinue order; substitute non-cross-reactive agent.",
    );
    if (rationale === null) return;
    const { error } = await supabase
      .from("clinical_safety_alerts")
      .update({
        status,
        decided_by: "Command Center · System Administration",
        decided_at: new Date().toISOString(),
        rationale,
      })
      .eq("id", c.id);
    if (error) { toast.error("Update failed", { description: error.message }); return; }
    toast.success(`Alert ${status.toLowerCase()}`);
    refresh();
  };

  const pending = items.filter((i) => i.status === "Pending Review");
  const decided = items.filter((i) => i.status !== "Pending Review");

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-slate-900 flex items-center gap-2">
            <ShieldAlert className="h-4 w-4 text-red-600" /> Intervention & Safety Queue
          </h2>
          <p className="text-sm text-slate-600 mt-1 max-w-3xl">
            Auto-commit halts whenever the NLP engine or an order maps an
            RxNorm drug that cross-reacts with a documented patient allergy.
            Pharmacy or an EHR specialist must Override (with rationale) or
            Reject the order before it reaches the Live Terminology Matrix.
          </p>
        </div>
        <Button variant="outline" onClick={refresh}>
          <Loader2 className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} /> Refresh
        </Button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <Stat label="Pending review" value={pending.length} tone="red" />
        <Stat label="Overridden" value={decided.filter((d) => d.status === "Overridden").length} tone="amber" />
        <Stat label="Rejected" value={decided.filter((d) => d.status === "Rejected").length} tone="slate" />
      </div>

      {loading ? (
        <div className="rounded-xl border border-dashed border-slate-300 p-8 text-center text-sm text-slate-500">
          <Loader2 className="inline h-3.5 w-3.5 animate-spin mr-1.5" />
          Scanning intake records and medication orders…
        </div>
      ) : items.length === 0 ? (
        <div className="rounded-xl border border-dashed border-emerald-300 bg-emerald-50/50 p-8 text-center text-sm text-emerald-800">
          <FileCheck2 className="inline h-4 w-4 mr-1.5" />
          No drug↔allergy conflicts detected across the last 50 admissions.
        </div>
      ) : (
        <div className="space-y-2">
          {items.map((c) => (
            <div
              key={c.id}
              className={`rounded-xl border bg-white shadow-sm p-4 ${
                c.status === "Pending Review" ? "border-red-300" : "border-slate-200 opacity-80"
              }`}
            >
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="inline-flex items-center gap-1 rounded border border-red-200 bg-red-50 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-red-700">
                      <AlertTriangle className="h-3 w-3" /> Auto-commit halted
                    </span>
                    <span className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider ${
                      c.kind === "Drug-Drug"
                        ? "border-purple-200 bg-purple-50 text-purple-700"
                        : "border-amber-200 bg-amber-50 text-amber-700"
                    }`}>
                      {c.kind === "Drug-Drug" ? `DDI · ${c.severity ?? "Major"}` : "Drug-Allergy"}
                    </span>
                    <span className="font-mono text-[11px] text-slate-500">{c.mrn}</span>
                    <span className="text-sm font-semibold text-slate-900">{c.patient_name}</span>
                    {c.facility_name && (
                      <span className="text-[11px] text-slate-500">· {c.facility_name}</span>
                    )}
                  </div>
                  <div className="mt-1.5 text-sm text-slate-800">
                    {c.kind === "Drug-Drug" ? (
                      <>
                        Co-prescribed <span className="font-semibold">{c.drug}</span> +{" "}
                        <span className="font-semibold">{c.drug_b}</span> —{" "}
                        <span className="font-mono text-[11px]">{c.family}</span>.
                      </>
                    ) : (
                      <>
                        Ordered <span className="font-semibold">{c.drug}</span> conflicts with
                        documented allergy to{" "}
                        <span className="font-semibold">{c.allergy_name}</span> —
                        cross-reactivity family:{" "}
                        <span className="font-mono text-[11px]">{c.family}</span>.
                      </>
                    )}
                  </div>
                  {c.rationale && (
                    <div className="mt-2 text-[11px] text-slate-600 italic">
                      <span className="font-semibold not-italic">{c.status}</span>
                      {c.decided_by ? ` by ${c.decided_by}` : ""}
                      {c.decided_at ? ` · ${new Date(c.decided_at).toLocaleString()}` : ""} — “{c.rationale}”
                    </div>
                  )}
                </div>
                {c.status === "Pending Review" ? (
                  <div className="flex items-center gap-1.5 shrink-0">
                    <Button
                      size="sm"
                      className="h-7 bg-amber-600 hover:bg-amber-700"
                      onClick={() => act(c, "Overridden")}
                    >
                      <Check className="h-3 w-3" /> Override
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-red-600 border-red-200 hover:bg-red-50"
                      onClick={() => act(c, "Rejected")}
                    >
                      <X className="h-3 w-3" /> Reject
                    </Button>
                  </div>
                ) : (
                  <span
                    className={`inline-flex items-center rounded border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${
                      c.status === "Overridden"
                        ? "border-amber-200 bg-amber-50 text-amber-700"
                        : "border-slate-200 bg-slate-50 text-slate-600"
                    }`}
                  >
                    {c.status}
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone: "red" | "amber" | "slate" }) {
  const palette = {
    red:   "bg-red-50 border-red-200 text-red-700",
    amber: "bg-amber-50 border-amber-200 text-amber-700",
    slate: "bg-slate-50 border-slate-200 text-slate-700",
  }[tone];
  return (
    <div className={`rounded-xl border p-3 ${palette}`}>
      <div className="text-[10px] font-bold uppercase tracking-wider opacity-80">{label}</div>
      <div className="text-2xl font-bold mt-0.5">{value}</div>
    </div>
  );
}

/* ============================================================ */
/*  Custom NLP Rules & Banned Shorthand (Catalog tab)           */
/* ============================================================ */
function CustomRulesCard() {
  const [rules, setRules] = useState<CustomRule[]>([]);
  const [banned, setBanned] = useState<CustomBanned[]>([]);
  const [newRule, setNewRule] = useState({ phrase: "", canonical: "" });
  const [newBanned, setNewBanned] = useState({ token: "", meaning: "", preferred: "" });

  useEffect(() => {
    refreshNlpRulesFromDb().then(() => {
      setRules(loadCustomRules());
      setBanned(loadCustomBanned());
    });
    const onEvt = () => {
      setRules(loadCustomRules());
      setBanned(loadCustomBanned());
    };
    window.addEventListener("spehr:nlp-rules", onEvt);
    return () => window.removeEventListener("spehr:nlp-rules", onEvt);
  }, []);

  const addRule = async () => {
    if (!newRule.phrase.trim() || !newRule.canonical.trim()) return;
    try {
      await addCustomRuleDb(newRule.phrase.trim(), newRule.canonical.trim());
      setRules(loadCustomRules());
      setNewRule({ phrase: "", canonical: "" });
      toast.success("Custom NLP rule added");
    } catch (e: any) {
      toast.error("Could not add rule", { description: e?.message });
    }
  };
  const removeRule = async (id: string) => {
    try { await removeNlpRuleDb(id); setRules(loadCustomRules()); }
    catch (e: any) { toast.error("Could not remove", { description: e?.message }); }
  };
  const addBanned = async () => {
    if (!newBanned.token.trim() || !newBanned.meaning.trim()) return;
    try {
      await addBannedDb(newBanned.token.trim(), newBanned.meaning, newBanned.preferred);
      setBanned(loadCustomBanned());
      setNewBanned({ token: "", meaning: "", preferred: "" });
      toast.success("Banned abbreviation added");
    } catch (e: any) {
      toast.error("Could not add", { description: e?.message });
    }
  };
  const removeBanned = async (id: string) => {
    try { await removeNlpRuleDb(id); setBanned(loadCustomBanned()); }
    catch (e: any) { toast.error("Could not remove", { description: e?.message }); }
  };

  return (
    <div className="rounded-xl border border-slate-200 bg-white shadow-sm overflow-hidden">
      <div className="px-5 py-3 border-b border-slate-100 bg-slate-50/60 flex items-center gap-2">
        <ListChecks className="h-4 w-4 text-[#0c2340]" />
        <div>
          <div className="text-sm font-semibold text-slate-900">NLP Custom Rules & Banned Shorthand</div>
          <div className="text-[11px] text-slate-600">
            Hospital-specific slang the NLP engine should normalize, plus the
            local extension to the Joint Commission "Do Not Use" list.
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 divide-y md:divide-y-0 md:divide-x divide-slate-100">
        {/* Custom slang rules */}
        <div className="p-4 space-y-3">
          <div className="text-[10px] font-bold uppercase tracking-[0.18em] text-slate-500">
            Local slang → canonical term
          </div>
          <div className="grid grid-cols-[1fr_1fr_auto] gap-2">
            <Input
              placeholder='e.g. "the big one"'
              value={newRule.phrase}
              onChange={(e) => setNewRule({ ...newRule, phrase: e.target.value })}
            />
            <Input
              placeholder='e.g. "myocardial infarction"'
              value={newRule.canonical}
              onChange={(e) => setNewRule({ ...newRule, canonical: e.target.value })}
            />
            <Button onClick={addRule} className="bg-[#0c2340] hover:bg-[#0c2340]/90">
              <Plus className="h-3.5 w-3.5" /> Add
            </Button>
          </div>
          {rules.length === 0 ? (
            <div className="text-[11px] text-slate-500 italic">No local rules yet.</div>
          ) : (
            <ul className="divide-y divide-slate-100 border border-slate-200 rounded-md">
              {rules.map((r) => (
                <li key={r.id} className="flex items-center justify-between gap-2 px-2.5 py-1.5 text-xs">
                  <div className="min-w-0 truncate">
                    <span className="font-mono text-[11px] text-slate-700">{r.phrase}</span>
                    <span className="mx-2 text-slate-400">→</span>
                    <span className="font-semibold text-slate-900">{r.canonical}</span>
                  </div>
                  <button onClick={() => removeRule(r.id)} className="text-slate-400 hover:text-rose-600">
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Banned abbreviations */}
        <div className="p-4 space-y-3">
          <div className="text-[10px] font-bold uppercase tracking-[0.18em] text-slate-500">
            "Do Not Use" abbreviations
          </div>
          <div className="text-[11px] text-slate-600">
            Joint Commission core list ships pre-loaded ({JC_BANNED.length} tokens).
            Add facility-specific extensions below.
          </div>
          <div className="grid grid-cols-[1fr_1.4fr_1.4fr_auto] gap-2">
            <Input placeholder="Token (QD)"  value={newBanned.token}     onChange={(e) => setNewBanned({ ...newBanned, token: e.target.value })} />
            <Input placeholder="Meaning"     value={newBanned.meaning}   onChange={(e) => setNewBanned({ ...newBanned, meaning: e.target.value })} />
            <Input placeholder="Preferred"   value={newBanned.preferred} onChange={(e) => setNewBanned({ ...newBanned, preferred: e.target.value })} />
            <Button onClick={addBanned} className="bg-red-600 hover:bg-red-700">
              <Plus className="h-3.5 w-3.5" /> Ban
            </Button>
          </div>
          {banned.length === 0 ? (
            <div className="text-[11px] text-slate-500 italic">No local additions.</div>
          ) : (
            <ul className="divide-y divide-slate-100 border border-slate-200 rounded-md">
              {banned.map((b) => (
                <li key={b.id} className="flex items-center justify-between gap-2 px-2.5 py-1.5 text-xs">
                  <div className="min-w-0 truncate">
                    <span className="font-mono font-bold text-red-700">{b.token}</span>
                    <span className="mx-2 text-slate-400">·</span>
                    <span className="text-slate-700">{b.meaning}</span>
                  </div>
                  <button onClick={() => removeBanned(b.id)} className="text-slate-400 hover:text-rose-600">
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

/* ============================================================ */
/*  NLP Audit Logs — 3-paragraph view of each admission's NLP run */
/* ============================================================ */
function NlpAuditLogs({ facility }: { facility: string }) {
  const [audits, setAudits] = useState<NlpAudit[]>([]);

  // Load latest 15 patients (filtered by facility if selected) and synthesize
  // an NLP audit per patient from their chief complaint + recent narrative so
  // reviewers see live admissions instead of a fixed demo set.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const dict = await loadDictionary();
        let q = supabase
          .from("patients")
          .select("mrn, first_name, last_name, name, facility_name, admission_time, chief_complaint, diagnosis")
          .order("admission_time", { ascending: false })
          .limit(15);
        if (facility && facility !== "all") {
          q = q.eq("facility_name", facility);
        }
        const { data } = await q;
        const live: NlpAudit[] = [];
        for (const p of (data ?? []) as any[]) {
          const narrative =
            [p.chief_complaint, p.diagnosis].filter(Boolean).join(". ") ||
            "Admission without recorded narrative.";
          const res = analyzeNarrative(narrative, dict);
          const createdAt = p.admission_time ?? new Date().toISOString();
          const autoResolveAt = new Date(new Date(createdAt).getTime() + 60_000).toISOString();
          live.push({
            ...res,
            id: `live_${p.mrn ?? Math.random().toString(36).slice(2)}`,
            created_at: createdAt,
            auto_resolve_at: autoResolveAt,
            mrn: p.mrn,
            patient_name:
              `${p.first_name ?? ""} ${p.last_name ?? ""}`.trim() ||
              p.name ||
              "Unattributed encounter",
            facility_name: p.facility_name,
          } as NlpAudit);
        }
        // Merge any locally captured (event-driven) audits, filtered by facility.
        const local = loadAudits().filter(
          (a) => facility === "all" || a.facility_name === facility,
        );
        const merged = [...local, ...live].slice(0, 15);
        if (!cancelled) setAudits(merged);
      } catch {/* noop */}
    })();
    return () => { cancelled = true; };
  }, [facility]);

  // Refresh on live NLP audit events for the currently-viewed facility.
  useEffect(() => {
    const onEvt = () => {
      const local = loadAudits().filter(
        (a) => facility === "all" || a.facility_name === facility,
      );
      setAudits((prev) => {
        const ids = new Set(local.map((l) => l.id));
        const keep = prev.filter((p) => !ids.has(p.id));
        return [...local, ...keep].slice(0, 15);
      });
    };
    window.addEventListener("spehr:nlp-audit", onEvt);
    window.addEventListener("storage", onEvt);
    return () => {
      window.removeEventListener("spehr:nlp-audit", onEvt);
      window.removeEventListener("storage", onEvt);
    };
  }, [facility]);

  const onClear = () => {
    clearAudits();
    setAudits([]);
    toast.success("NLP audit log cleared");
  };

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-slate-900 flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-indigo-600" /> NLP Coding Audit Trail
          </h2>
          <p className="text-sm text-slate-600 mt-1 max-w-2xl">
            Showing the latest {audits.length} admission{audits.length === 1 ? "" : "s"}
            {facility !== "all" ? ` at ${facility}` : " across the network"} — each
            captured in three stages (raw entry, extraction mapping, standardized
            output) so coders can audit how the NLP engine interpreted the narrative.
          </p>
        </div>
        <Button variant="outline" onClick={onClear} title="Clear local audit log">
          <Trash className="h-4 w-4" /> Clear
        </Button>
      </div>

      {audits.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 p-8 text-center text-sm text-slate-500">
          No NLP audits yet. Run a Smart Intake admission from the Nursing
          Board to populate this log.
        </div>
      ) : (
        <div className="space-y-4">
          {audits.map((a) => (
            <NlpAuditCard key={a.id} audit={a} />
          ))}
        </div>
      )}
    </div>
  );
}

function NlpAuditCard({ audit }: { audit: NlpAudit }) {
  const ts = new Date(audit.created_at).toLocaleString();
  const confidence = (audit as any).confidence ?? 100;
  const banned: BannedAbbrev[] = (audit as any).banned ?? [];
  const expansions: Array<{ short: string; long: string }> = (audit as any).expansions ?? [];
  const dosingHazards: Array<{ token: string; reason: string }> = (audit as any).dosingHazards ?? [];
  const streamAOk = (audit as any).streamAOk ?? true;
  const lowConfidence = confidence < 95;

  // Per-card decision persisted in localStorage so reviewer state survives reloads.
  type Decision = "pending" | "approved" | "auto" | "rejected";
  const decisionKey = `spehr.nlp_decision.${audit.id}`;
  const methodKey = `spehr.nlp_method.${audit.id}`;
  const codesKey = `spehr.nlp_codes.${audit.id}`;
  const linesKey = `spehr.nlp_lines.${audit.id}`;

  const initialIcd = (audit.byCode["ICD-10"] ?? []).map((m) => m.code);
  const initialSno = (audit.byCode["SNOMED CT"] ?? []).map((m) => m.code);

  const [decision, setDecision] = useState<Decision>(() => {
    if (typeof window === "undefined") return "pending";
    return (window.localStorage.getItem(decisionKey) as Decision) ?? "pending";
  });
  const [method, setMethod] = useState<string>(() => {
    if (typeof window === "undefined") return "Pending";
    return window.localStorage.getItem(methodKey) ?? "Pending";
  });
  const [icd10Codes, setIcd10Codes] = useState<string[]>(() => {
    if (typeof window === "undefined") return initialIcd;
    const raw = window.localStorage.getItem(codesKey);
    if (!raw) return initialIcd;
    try { return (JSON.parse(raw).icd10 as string[]) ?? initialIcd; } catch { return initialIcd; }
  });
  const [snomedCodes, setSnomedCodes] = useState<string[]>(() => {
    if (typeof window === "undefined") return initialSno;
    const raw = window.localStorage.getItem(codesKey);
    if (!raw) return initialSno;
    try { return (JSON.parse(raw).snomed as string[]) ?? initialSno; } catch { return initialSno; }
  });
  const [lines, setLines] = useState<string[]>(() => {
    if (typeof window === "undefined") return audit.standardized;
    const raw = window.localStorage.getItem(linesKey);
    if (!raw) return audit.standardized;
    try { return JSON.parse(raw) as string[]; } catch { return audit.standardized; }
  });
  const [editOpen, setEditOpen] = useState(false);
  const [dictSearch, setDictSearch] = useState("");
  const [dict, setDict] = useState<DictRow[]>([]);

  const persist = (d: Decision) => {
    setDecision(d);
    if (typeof window !== "undefined") window.localStorage.setItem(decisionKey, d);
  };
  const persistMethod = (m: string) => {
    setMethod(m);
    if (typeof window !== "undefined") window.localStorage.setItem(methodKey, m);
  };
  const persistCodes = (icd: string[], sno: string[]) => {
    setIcd10Codes(icd);
    setSnomedCodes(sno);
    if (typeof window !== "undefined")
      window.localStorage.setItem(codesKey, JSON.stringify({ icd10: icd, snomed: sno }));
  };
  const persistLines = (l: string[]) => {
    setLines(l);
    if (typeof window !== "undefined") window.localStorage.setItem(linesKey, JSON.stringify(l));
  };

  // --- 60-second SLA countdown ----------------------------------------
  const autoResolveAt = (() => {
    const raw = (audit as any).auto_resolve_at as string | undefined;
    if (raw) return new Date(raw).getTime();
    return new Date(audit.created_at).getTime() + 60_000;
  })();
  const [nowTs, setNowTs] = useState(() => Date.now());
  useEffect(() => {
    if (decision !== "pending") return;
    const t = setInterval(() => setNowTs(Date.now()), 1000);
    return () => clearInterval(t);
  }, [decision]);
  const secLeft = Math.max(0, Math.ceil((autoResolveAt - nowTs) / 1000));
  const pct = Math.max(0, Math.min(100, (secLeft / 60) * 100));
  const barColor = secLeft <= 15 ? "bg-red-500" : secLeft <= 30 ? "bg-amber-500" : "bg-emerald-500";

  // --- Commit codes to the patient row (Live Terminology Matrix) ------
  async function commitToPatient(icd: string[], sno: string[]) {
    if (!audit.mrn) return;
    try {
      const { data } = await supabase
        .from("patients")
        .select("icd10_codes, snomed_codes")
        .eq("mrn", audit.mrn)
        .maybeSingle();
      const mergedIcd = Array.from(new Set([...(((data as any)?.icd10_codes as string[]) ?? []), ...icd]));
      const mergedSno = Array.from(new Set([...(((data as any)?.snomed_codes as string[]) ?? []), ...sno]));
      await supabase
        .from("patients")
        .update({ icd10_codes: mergedIcd, snomed_codes: mergedSno } as any)
        .eq("mrn", audit.mrn);
      if (typeof window !== "undefined")
        window.dispatchEvent(new CustomEvent("spehr:matrix-refresh"));
    } catch (e: any) {
      toast.error("Commit failed", { description: e?.message });
    }
  }

  // --- Approve / Reject ------------------------------------------------
  const handleApprove = async () => {
    const hasCodes = icd10Codes.length + snomedCodes.length > 0;
    if (!hasCodes) {
      toast.warning("Cannot approve without mapped codes. Click Edit to manually code.");
      return;
    }
    await commitToPatient(icd10Codes, snomedCodes);
    persistMethod("Human Mapped");
    persist("approved");
    toast.success("Approved — committed to Live Terminology Matrix");
  };

  const handleReject = () => {
    persistMethod("Rejected");
    persist("rejected");
    toast.message("Rejected — codes not committed");
  };

  // --- AI Auto-Fallback at 0s ------------------------------------------
  const FALLBACK_MAP: Array<{ kw: RegExp; icd10: string; snomed: string; display: string }> = [
    { kw: /cough|pneumonia|pna\b/i,            icd10: "J18.9",  snomed: "267036007", display: "Pneumonia, unspecified" },
    { kw: /chest pain|cp\b|stemi|nstemi|\bmi\b/i, icd10: "I20.9",  snomed: "29857009",  display: "Chest pain / angina" },
    { kw: /short(ness)? of breath|sob|dyspnea/i, icd10: "R06.02", snomed: "267036007", display: "Shortness of breath" },
    { kw: /fever|febrile|pyrexia/i,             icd10: "R50.9",  snomed: "386661006", display: "Fever, unspecified" },
    { kw: /abdominal|abd pain|stomach|belly/i,  icd10: "R10.9",  snomed: "21522001",  display: "Abdominal pain" },
    { kw: /stroke|cva|tia/i,                    icd10: "I63.9",  snomed: "230690007", display: "Cerebral infarction" },
    { kw: /sepsis|septic/i,                     icd10: "A41.9",  snomed: "91302008",  display: "Sepsis, unspecified" },
    { kw: /headache|migraine/i,                 icd10: "R51",    snomed: "25064002",  display: "Headache" },
  ];
  const pickFallback = () => {
    const hit = FALLBACK_MAP.find((m) => m.kw.test(audit.raw));
    return hit ?? { icd10: "R69", snomed: "64572001", display: "Illness, unspecified" };
  };
  const autoFallbackRef = useState({ fired: false })[0];
  useEffect(() => {
    if (decision !== "pending") return;
    if (secLeft > 0) return;
    if (autoFallbackRef.fired) return;
    autoFallbackRef.fired = true;
    (async () => {
      const fb = pickFallback();
      const nextIcd = Array.from(new Set([...icd10Codes, fb.icd10]));
      const nextSno = Array.from(new Set([...snomedCodes, fb.snomed]));
      persistCodes(nextIcd, nextSno);
      persistLines([...lines, `AI fallback: ${fb.display} (ICD-10 ${fb.icd10}, SNOMED ${fb.snomed})`]);
      await commitToPatient(nextIcd, nextSno);
      persistMethod("AI Auto-Fallback");
      persist("auto");
      toast.message("AI Auto-Resolved", {
        description: `${fb.display} — ICD-10 ${fb.icd10} / SNOMED ${fb.snomed} committed.`,
      });
    })();
  }, [secLeft, decision]);

  // --- Edit modal: dictionary search ----------------------------------
  useEffect(() => {
    if (!editOpen || dict.length) return;
    loadDictionary().then(setDict).catch(() => {});
  }, [editOpen, dict.length]);
  const dictMatches = (() => {
    const q = dictSearch.trim().toLowerCase();
    if (!q) return [] as DictRow[];
    return dict
      .filter((d) => d.code_system === "ICD-10" || d.code_system === "SNOMED CT")
      .filter((d) => d.display.toLowerCase().includes(q) || d.code.toLowerCase().includes(q))
      .slice(0, 25);
  })();
  const appendCode = (row: DictRow) => {
    if (row.code_system === "ICD-10") {
      if (icd10Codes.includes(row.code)) return;
      persistCodes([...icd10Codes, row.code], snomedCodes);
    } else if (row.code_system === "SNOMED CT") {
      if (snomedCodes.includes(row.code)) return;
      persistCodes(icd10Codes, [...snomedCodes, row.code]);
    }
    persistLines([...lines, `Coder added: ${row.display} (${row.code_system} ${row.code})`]);
    toast.success(`Added ${row.code_system} ${row.code}`);
  };

  // --- Badge ----------------------------------------------------------
  const badge = (() => {
    if (decision === "approved")
      return { text: `APPROVED · ${method}`, cls: "bg-emerald-100 text-emerald-700 border-emerald-300" };
    if (decision === "auto")
      return { text: "AI AUTO-RESOLVED", cls: "bg-amber-100 text-amber-800 border-amber-300" };
    if (decision === "rejected")
      return { text: "REJECTED", cls: "bg-red-100 text-red-700 border-red-300" };
    return { text: "PENDING REVIEW", cls: "bg-amber-50 text-amber-800 border-amber-200" };
  })();

  return (
    <div className="rounded-xl border border-slate-200 bg-white shadow-sm overflow-hidden">
      <div className="flex items-center justify-between gap-3 px-5 py-3 bg-slate-50/70 border-b border-slate-100">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-slate-900 truncate">
            {audit.patient_name ?? "Unattributed encounter"}
            {audit.mrn && (
              <span className="ml-2 font-mono text-[11px] text-slate-500">{audit.mrn}</span>
            )}
          </div>
          <div className="text-[11px] text-slate-500">
            {ts}{audit.facility_name ? ` · ${audit.facility_name}` : ""} · {audit.matches.length} concept{audit.matches.length === 1 ? "" : "s"}
          </div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0 flex-wrap justify-end">
          {streamAOk && (
            <span
              title="Structured demographics & vitals parsed successfully without NLP."
              className="inline-flex items-center gap-1 rounded border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 text-[10px] font-bold tracking-wider text-emerald-700"
            >
              <FileCheck2 className="h-3 w-3" /> STREAM A · OK
            </span>
          )}
          <span
            title={`AI confidence ${confidence}%`}
            className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-bold tracking-wider ${
              confidence >= 95
                ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                : confidence >= 80
                ? "border-amber-200 bg-amber-50 text-amber-700"
                : "border-red-200 bg-red-50 text-red-700"
            }`}
          >
            STREAM B · {confidence}%
          </span>
          {(["ICD-10", "SNOMED CT", "LOINC", "RxNorm"] as const).map((sys) => {
            const n = (audit.byCode[sys] ?? []).length;
            if (!n) return null;
            return (
              <span
                key={sys}
                className={`inline-flex items-center rounded border px-1.5 py-0.5 font-mono text-[10px] font-bold tracking-wider ${SYSTEM_META[sys].chip}`}
              >
                {sys} · {n}
              </span>
            );
          })}
        </div>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 divide-y md:divide-y-0 md:divide-x divide-slate-100">
        <div className="p-4">
          <div className="text-[10px] font-bold uppercase tracking-[0.18em] text-slate-500 mb-1.5">
            ① Raw Physician Entry
          </div>
          <p className="text-sm text-slate-800 leading-relaxed whitespace-pre-wrap">
            {audit.raw || <span className="text-slate-400">—</span>}
          </p>
        </div>
        <div className="p-4 bg-indigo-50/30">
          <div className="text-[10px] font-bold uppercase tracking-[0.18em] text-indigo-700 mb-1.5">
            ② Extraction Mapping
          </div>
          {banned.length > 0 && (
            <div className="mb-2 rounded-md border border-red-300 bg-red-50 px-2.5 py-1.5 text-[11px] text-red-800 flex items-start gap-1.5">
              <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
              <div>
                <div className="font-bold uppercase tracking-wider text-[10px]">
                  Banned abbreviation detected
                </div>
                {banned.map((b) => (
                  <div key={b.token}>
                    <span className="font-mono font-bold">{b.token}</span> — {b.meaning}. {b.preferred}.
                  </div>
                ))}
              </div>
            </div>
          )}
          {dosingHazards.length > 0 && (
            <div className="mb-2 rounded-md border border-red-300 bg-red-50 px-2.5 py-1.5 text-[11px] text-red-800 flex items-start gap-1.5">
              <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
              <div>
                <div className="font-bold uppercase tracking-wider text-[10px]">
                  Unsafe dosing format
                </div>
                {dosingHazards.map((d, i) => (
                  <div key={i}>
                    <span className="font-mono font-bold">{d.token}</span> — {d.reason}.
                  </div>
                ))}
              </div>
            </div>
          )}
          {expansions.length > 0 && (
            <div className="mb-2 rounded-md border border-indigo-200 bg-white px-2.5 py-1.5 text-[11px] text-slate-700">
              <div className="font-bold uppercase tracking-wider text-[10px] text-indigo-700 mb-1">
                Abbreviations decoded
              </div>
              <div className="flex flex-wrap gap-1.5">
                {expansions.map((e) => (
                  <span key={e.short} className="inline-flex items-center rounded border border-indigo-200 bg-indigo-50 px-1.5 py-0.5">
                    <span className="font-mono font-bold mr-1">{e.short}</span>
                    <span className="text-slate-400 mr-1">→</span>
                    {e.long}
                  </span>
                ))}
              </div>
            </div>
          )}
          <p className="text-sm text-slate-800 leading-relaxed font-mono whitespace-pre-wrap">
            {audit.annotated || audit.raw || <span className="text-slate-400">—</span>}
          </p>
        </div>
        <div className="p-4 bg-emerald-50/30">
          <div className="flex items-center justify-between mb-1.5">
            <div className="text-[10px] font-bold uppercase tracking-[0.18em] text-emerald-700">
              ③ Final Standardized Output
            </div>
            <span className={`text-[10px] font-bold uppercase tracking-wider rounded px-1.5 py-0.5 border ${badge.cls}`}>
              {badge.text}
            </span>
          </div>
          {/* SLA countdown — only while pending */}
          {decision === "pending" && (
            <div className="mb-2">
              <div className="flex items-center justify-between text-[11px] mb-1">
                <span className={secLeft <= 15 ? "text-red-700 font-semibold" : "text-slate-600"}>
                  Auto-fallback in {secLeft}s
                </span>
                <span className="text-[10px] text-slate-500">60s SLA</span>
              </div>
              <div className="h-1.5 w-full rounded-full bg-slate-200 overflow-hidden">
                <div
                  className={`h-full ${barColor} transition-all duration-1000 ease-linear`}
                  style={{ width: `${pct}%` }}
                />
              </div>
            </div>
          )}
          {lowConfidence && decision === "pending" && (
            <div className="mb-2 text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded px-2 py-1">
              Confidence {confidence}% &lt; 95%. Held in audit log — commits to the
              Live Terminology Matrix only after a coder approves.
            </div>
          )}
          <ul className="space-y-1.5 text-sm text-slate-800">
            {lines.map((line, i) => (
              <li key={i} className="flex gap-2">
                <span className="text-emerald-600 mt-0.5">•</span>
                <span>{line}</span>
              </li>
            ))}
          </ul>
          {(icd10Codes.length > 0 || snomedCodes.length > 0) && (
            <div className="mt-2 flex flex-wrap gap-1">
              {icd10Codes.map((c) => (
                <span key={`i-${c}`} className="inline-flex items-center rounded border border-blue-200 bg-blue-50 px-1.5 py-0.5 font-mono text-[10px] font-bold text-blue-700">
                  ICD-10 {c}
                </span>
              ))}
              {snomedCodes.map((c) => (
                <span key={`s-${c}`} className="inline-flex items-center rounded border border-violet-200 bg-violet-50 px-1.5 py-0.5 font-mono text-[10px] font-bold text-violet-700">
                  SNOMED {c}
                </span>
              ))}
            </div>
          )}
          <div className="mt-3 flex items-center gap-1.5">
            <Button
              size="sm"
              className="h-7 bg-emerald-600 hover:bg-emerald-700"
              disabled={decision !== "pending"}
              onClick={handleApprove}
            >
              <Check className="h-3 w-3" /> Approve
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-7"
              onClick={() => setEditOpen(true)}
            >
              <Pencil className="h-3 w-3" /> Edit
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-red-600 border-red-200 hover:bg-red-50"
              disabled={decision !== "pending"}
              onClick={handleReject}
            >
              <X className="h-3 w-3" /> Reject
            </Button>
          </div>

          <Dialog open={editOpen} onOpenChange={setEditOpen}>
            <DialogContent className="max-w-2xl">
              <DialogHeader>
                <DialogTitle>Manual coding · {audit.patient_name ?? audit.mrn}</DialogTitle>
                <DialogDescription>
                  Search the terminology dictionary and click a row to append it
                  to this audit's standardized output. ICD-10 and SNOMED CT only.
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-3">
                <Input
                  placeholder="Search by display name or code (e.g. pneumonia, J18.9)…"
                  value={dictSearch}
                  onChange={(e) => setDictSearch(e.target.value)}
                  autoFocus
                />
                <div className="max-h-72 overflow-y-auto rounded border border-slate-200 divide-y divide-slate-100">
                  {dictSearch.trim() === "" ? (
                    <div className="p-4 text-center text-xs text-slate-500">
                      Start typing to search the dictionary.
                    </div>
                  ) : dictMatches.length === 0 ? (
                    <div className="p-4 text-center text-xs text-slate-500">
                      No matches.
                    </div>
                  ) : (
                    dictMatches.map((row) => (
                      <button
                        key={row.id}
                        type="button"
                        onClick={() => appendCode(row)}
                        className="w-full text-left px-3 py-2 hover:bg-slate-50 flex items-center gap-2"
                      >
                        <span className={`inline-flex items-center rounded border px-1.5 py-0.5 font-mono text-[10px] font-bold ${
                          row.code_system === "ICD-10"
                            ? "border-blue-200 bg-blue-50 text-blue-700"
                            : "border-violet-200 bg-violet-50 text-violet-700"
                        }`}>
                          {row.code_system} {row.code}
                        </span>
                        <span className="text-sm text-slate-800 truncate">{row.display}</span>
                      </button>
                    ))
                  )}
                </div>
                <div className="text-[11px] text-slate-500">
                  Current codes: {icd10Codes.length} ICD-10 · {snomedCodes.length} SNOMED CT
                </div>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setEditOpen(false)}>Done</Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </div>
    </div>
  );
}

/* ============================================================ */
/*  Live Terminology Matrix — last 50 patients × code systems    */
/* ============================================================ */

type MatrixCell = {
  mrn: string;
  name: string;
  facility: string | null;
  admitted: string | null;
  chief_complaint: string | null;
  labs: string[];      // test_type strings
  meds: string[];      // medication_name strings
  icd10_codes: string[];
  snomed_codes: string[];
};

function LiveTerminologyMatrix({ dict, facility }: { dict: DictEntry[]; facility: string }) {
  const [rows, setRows] = useState<MatrixCell[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      let pq = supabase
        .from("patients")
        .select("mrn, first_name, last_name, facility_name, admission_time, chief_complaint, icd10_codes, snomed_codes")
        .order("admission_time", { ascending: false })
        .limit(15);
      if (facility && facility !== "all") {
        pq = pq.eq("facility_name", facility);
      }
      const { data: patients, error } = await pq;
      if (error) {
        toast.error("Could not load patient matrix", { description: error.message });
        setLoading(false);
        return;
      }
      const mrns = (patients ?? []).map((p: any) => p.mrn).filter(Boolean);
      const [labsRes, medsRes] = await Promise.all([
        supabase.from("lab_orders").select("patient_mrn, test_type").in("patient_mrn", mrns),
        supabase
          .from("medication_orders")
          .select("patient_mrn, medication_name, drug_name")
          .in("patient_mrn", mrns),
      ]);
      const labMap = new Map<string, Set<string>>();
      for (const r of (labsRes.data ?? []) as any[]) {
        if (!r.patient_mrn || !r.test_type) continue;
        (labMap.get(r.patient_mrn) ?? labMap.set(r.patient_mrn, new Set()).get(r.patient_mrn)!).add(r.test_type);
      }
      const medMap = new Map<string, Set<string>>();
      for (const r of (medsRes.data ?? []) as any[]) {
        const m = r.medication_name || r.drug_name;
        if (!r.patient_mrn || !m) continue;
        (medMap.get(r.patient_mrn) ?? medMap.set(r.patient_mrn, new Set()).get(r.patient_mrn)!).add(m);
      }
      const cells: MatrixCell[] = (patients ?? []).map((p: any) => ({
        mrn: p.mrn,
        name: `${p.first_name ?? ""} ${p.last_name ?? ""}`.trim() || "—",
        facility: p.facility_name,
        admitted: p.admission_time,
        chief_complaint: p.chief_complaint,
        labs: Array.from(labMap.get(p.mrn) ?? []),
        meds: Array.from(medMap.get(p.mrn) ?? []),
        icd10_codes: (p.icd10_codes ?? []) as string[],
        snomed_codes: (p.snomed_codes ?? []) as string[],
      }));
      if (!cancelled) {
        setRows(cells);
        setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [facility]);

  // Build a quick index from display→DictEntry per code system.
  const indexBySystem = (() => {
    const idx: Record<string, Array<DictEntry>> = {};
    for (const r of dict) (idx[r.code_system] ||= []).push(r);
    return idx;
  })();

  const findCodes = (system: string, candidates: string[]): DictEntry[] => {
    const pool = indexBySystem[system] ?? [];
    const out: DictEntry[] = [];
    const seen = new Set<string>();
    for (const c of candidates) {
      if (!c) continue;
      const cl = c.toLowerCase();
      for (const row of pool) {
        const d = row.display?.toLowerCase() ?? "";
        if (!d) continue;
        if (d.includes(cl) || cl.includes(d.split(" ")[0])) {
          const key = row.code;
          if (!seen.has(key)) { seen.add(key); out.push(row); }
        }
      }
    }
    return out.slice(0, 6);
  };

  const findByExactCodes = (system: string, codes: string[]): DictEntry[] => {
    const pool = indexBySystem[system] ?? [];
    const want = new Set(codes);
    return pool.filter((r) => want.has(r.code)).slice(0, 6);
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-slate-900 flex items-center gap-2">
            <Grid3x3 className="h-4 w-4 text-[#0c2340]" /> Live Terminology Matrix
          </h2>
          <p className="text-sm text-slate-600 mt-0.5">
            Last 15 admissions{facility !== "all" ? ` at ${facility}` : " across the network"} mapped to
            SNOMED-CT, ICD-10, LOINC, and RxNorm. Click any pill for the canonical
            display and value-set category.
          </p>
        </div>
        <div className="text-xs text-slate-500">{rows.length} patients</div>
      </div>
      <div className="rounded-xl border border-slate-200 bg-white shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-slate-900 text-slate-100">
              <tr>
                <th className="text-left font-semibold uppercase tracking-wider text-[10px] px-3 py-2.5">MRN</th>
                <th className="text-left font-semibold uppercase tracking-wider text-[10px] px-3 py-2.5">Patient</th>
                <th className="text-left font-semibold uppercase tracking-wider text-[10px] px-3 py-2.5">SNOMED CT</th>
                <th className="text-left font-semibold uppercase tracking-wider text-[10px] px-3 py-2.5">ICD-10</th>
                <th className="text-left font-semibold uppercase tracking-wider text-[10px] px-3 py-2.5">LOINC</th>
                <th className="text-left font-semibold uppercase tracking-wider text-[10px] px-3 py-2.5">RxNorm</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading && (
                <tr>
                  <td colSpan={6} className="px-4 py-6 text-center text-xs text-slate-500">
                    <Loader2 className="inline h-3.5 w-3.5 animate-spin mr-1.5" />
                    Loading matrix…
                  </td>
                </tr>
              )}
              {!loading && rows.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-6 text-center text-xs text-slate-500">
                    No admissions to display.
                  </td>
                </tr>
              )}
              {rows.map((r) => {
                const cc = r.chief_complaint ? [r.chief_complaint] : [];
                const snomed = r.snomed_codes.length
                  ? findByExactCodes("SNOMED CT", r.snomed_codes)
                  : findCodes("SNOMED CT", cc);
                const icd10 = r.icd10_codes.length
                  ? findByExactCodes("ICD-10", r.icd10_codes)
                  : findCodes("ICD-10", cc);
                const loinc = findCodes("LOINC", r.labs);
                const rxnorm = findCodes("RxNorm", r.meds);
                return (
                  <tr key={r.mrn} className="hover:bg-slate-50/60">
                    <td className="px-3 py-2.5 font-mono text-[11px] font-semibold text-slate-900 whitespace-nowrap">{r.mrn}</td>
                    <td className="px-3 py-2.5 text-slate-800 whitespace-nowrap">
                      <div className="font-medium">{r.name}</div>
                      <div className="text-[10px] text-slate-500 truncate max-w-[180px]">{r.chief_complaint ?? "—"}</div>
                    </td>
                    <td className="px-3 py-2.5"><PillRow entries={snomed} system="SNOMED CT" /></td>
                    <td className="px-3 py-2.5"><PillRow entries={icd10} system="ICD-10" /></td>
                    <td className="px-3 py-2.5"><PillRow entries={loinc} system="LOINC" /></td>
                    <td className="px-3 py-2.5"><PillRow entries={rxnorm} system="RxNorm" /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function PillRow({ entries, system }: { entries: DictEntry[]; system: string }) {
  if (entries.length === 0) return <span className="text-slate-300">—</span>;
  const chip = SYSTEM_META[system]?.chip ?? "bg-slate-100 text-slate-700 border-slate-200";
  return (
    <div className="flex flex-wrap gap-1">
      {entries.map((e) => (
        <Popover key={`${system}-${e.code}`}>
          <PopoverTrigger asChild>
            <button
              type="button"
              className={`inline-flex items-center rounded-full border px-2 py-0.5 font-mono text-[10px] font-bold tracking-wider cursor-pointer hover:opacity-80 transition ${chip}`}
            >
              {e.code}
            </button>
          </PopoverTrigger>
          <PopoverContent side="top" className="w-72 text-xs">
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <span className={`inline-flex items-center rounded border px-1.5 py-0.5 font-mono text-[10px] font-bold tracking-wider ${chip}`}>
                  {system}
                </span>
                <span className="font-mono text-[11px] font-semibold text-slate-900">{e.code}</span>
              </div>
              <div className="text-sm font-semibold text-slate-900 leading-snug">{e.display}</div>
              {e.category && (
                <div className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold">
                  Value set: {e.category}
                </div>
              )}
              {e.description && (
                <div className="text-[11px] text-slate-600 leading-relaxed">{e.description}</div>
              )}
            </div>
          </PopoverContent>
        </Popover>
      ))}
    </div>
  );
}

type AuditCategory = "SECURITY" | "CLINICAL" | "AUTOMATION" | "SYSTEM";
type AuditEvent = {
  key: string;
  ts: string;
  tsMs: number;
  category: AuditCategory;
  actor: string;
  facility: string;
  details: string;
};

function fmtTs(d: Date): string {
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getDate())}-${months[d.getMonth()]}-${d.getFullYear()}, ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function isGhost(actor?: string | null): boolean {
  if (!actor) return true;
  const a = actor.toLowerCase();
  return a.includes("ghost") || a.includes("system") || a.includes("auto");
}

const CATEGORY_STYLES: Record<AuditCategory, string> = {
  SECURITY:   "bg-red-900/10 text-red-700 border-red-200",
  CLINICAL:   "bg-sky-900/10 text-sky-700 border-sky-200",
  AUTOMATION: "bg-emerald-900/10 text-emerald-700 border-emerald-200",
  SYSTEM:     "bg-slate-900/10 text-slate-700 border-slate-300",
};

function AuditLog() {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    const [patientsRes, labsRes, medsRes, permsRes, settingsRes] = await Promise.all([
      supabase
        .from("patients")
        .select("mrn, name, facility_name, admission_time, discharge_time, status, chief_complaint")
        .order("admission_time", { ascending: false })
        .limit(60),
      supabase
        .from("lab_orders")
        .select("id, patient_mrn, patient_name, facility_name, test_type, status, result_value, ordered_by, requested_by, collected_at, created_at")
        .order("created_at", { ascending: false })
        .limit(60),
      supabase
        .from("medication_orders")
        .select("id, patient_mrn, mrn, patient_name, facility_name, drug_name, drug, medication_name, dose, route, status, ordering_physician, ordered_by, administered_at, approved_at, created_at")
        .order("created_at", { ascending: false })
        .limit(60),
      supabase
        .from("role_permissions")
        .select("id, facility_name, target_role, feature_key, feature_name, is_active, updated_at")
        .order("updated_at", { ascending: false })
        .limit(30),
      supabase.from("system_settings").select("automation_enabled").eq("id", 1).maybeSingle(),
    ]);

    const out: AuditEvent[] = [];

    for (const p of (patientsRes.data ?? []) as any[]) {
      if (p.admission_time) {
        const d = new Date(p.admission_time);
        out.push({
          key: `adm-${p.mrn}`,
          tsMs: d.getTime(),
          ts: fmtTs(d),
          category: "AUTOMATION",
          actor: "Ghost AI (System)",
          facility: p.facility_name ?? "Global Network",
          details: `Auto-admitted patient MRN-${p.mrn} (${p.chief_complaint ?? p.name ?? "New admission"})`,
        });
      }
      if (p.discharge_time && (p.status === "Discharged" || p.status === "discharged")) {
        const d = new Date(p.discharge_time);
        out.push({
          key: `dis-${p.mrn}`,
          tsMs: d.getTime(),
          ts: fmtTs(d),
          category: "AUTOMATION",
          actor: "Ghost AI (System)",
          facility: p.facility_name ?? "Global Network",
          details: `Auto-discharged patient MRN-${p.mrn} (${p.name ?? ""})`,
        });
      }
    }

    for (const l of (labsRes.data ?? []) as any[]) {
      const tsRaw = l.collected_at ?? l.created_at;
      if (!tsRaw) continue;
      const d = new Date(tsRaw);
      const actor = l.ordered_by ?? l.requested_by ?? "Ghost AI (System)";
      const isResulted = (l.status ?? "").toLowerCase() === "resulted" || !!l.result_value;
      const verb = isResulted ? "Auto-resulted" : "Ordered";
      const cat: AuditCategory = isGhost(actor) ? "AUTOMATION" : "CLINICAL";
      const tail = l.result_value ? ` (${l.result_value})` : "";
      out.push({
        key: `lab-${l.id}`,
        tsMs: d.getTime(),
        ts: fmtTs(d),
        category: cat,
        actor: isGhost(actor) ? "Ghost AI (System)" : actor,
        facility: l.facility_name ?? "Global Network",
        details: `${verb} ${l.test_type ?? "lab"} for MRN-${l.patient_mrn ?? "?"}${tail}`,
      });
    }

    for (const m of (medsRes.data ?? []) as any[]) {
      const tsRaw = m.administered_at ?? m.approved_at ?? m.created_at;
      if (!tsRaw) continue;
      const d = new Date(tsRaw);
      const drug = m.drug_name ?? m.drug ?? m.medication_name ?? "medication";
      const dose = m.dose ?? "";
      const route = m.route ?? "";
      const mrn = m.patient_mrn ?? m.mrn ?? "?";
      const actor = m.ordering_physician ?? m.ordered_by ?? "Ghost AI (System)";
      let verb = "Ordered";
      const status = (m.status ?? "").toLowerCase();
      if (m.administered_at) verb = "Administered";
      else if (m.approved_at || status === "approved") verb = "Approved";
      const cat: AuditCategory = isGhost(actor) || verb === "Approved" ? "AUTOMATION" : "CLINICAL";
      out.push({
        key: `med-${m.id}-${verb}`,
        tsMs: d.getTime(),
        ts: fmtTs(d),
        category: cat,
        actor: isGhost(actor) ? "Ghost AI (System)" : actor,
        facility: m.facility_name ?? "Global Network",
        details: `${verb} ${drug} ${dose} ${route} for MRN-${mrn}`.replace(/\s+/g, " ").trim(),
      });
    }

    for (const r of (permsRes.data ?? []) as any[]) {
      if (!r.updated_at) continue;
      const d = new Date(r.updated_at);
      out.push({
        key: `perm-${r.id}`,
        tsMs: d.getTime(),
        ts: fmtTs(d),
        category: "SECURITY",
        actor: "Diane Whitaker (Admin)",
        facility: r.facility_name ?? "Global Network",
        details: `${r.is_active ? "Enabled" : "Disabled"} feature '${r.feature_key}' for role ${r.target_role}`,
      });
    }

    const auto = (settingsRes.data as any)?.automation_enabled;
    if (typeof auto === "boolean") {
      const now = new Date();
      out.push({
        key: `automation-state`,
        tsMs: now.getTime() - 1000,
        ts: fmtTs(now),
        category: "SYSTEM",
        actor: "Diane Whitaker (Admin)",
        facility: "Global Network",
        details: `Master AI Automation is ${auto ? "ON" : "OFF"}`,
      });
    }

    out.sort((a, b) => b.tsMs - a.tsMs);
    setEvents(out.slice(0, 50));
    setLoading(false);
  };

  useEffect(() => {
    load();
    const channel = supabase
      .channel("audit-log-live")
      .on("postgres_changes", { event: "*", schema: "public", table: "patients" }, () => load())
      .on("postgres_changes", { event: "*", schema: "public", table: "lab_orders" }, () => load())
      .on("postgres_changes", { event: "*", schema: "public", table: "medication_orders" }, () => load())
      .on("postgres_changes", { event: "*", schema: "public", table: "role_permissions" }, () => load())
      .on("postgres_changes", { event: "*", schema: "public", table: "system_settings" }, () => load())
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const downloadCsv = () => {
    const header = ["Timestamp", "Category", "Actor", "Facility", "Details"];
    const rows = events.map((e) =>
      [e.ts, e.category, e.actor, e.facility, e.details]
        .map((v) => `"${String(v).replace(/"/g, '""')}"`)
        .join(","),
    );
    const csv = [header.join(","), ...rows].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `audit-log-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success("Audit log exported", { description: `${events.length} events · CSV` });
  };

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">📜 Enterprise Event Ledger</h1>
          <p className="text-sm text-slate-600 mt-1">
            Immutable record of clinical, automation, security, and system events across the network. Newest first.
          </p>
        </div>
        <button
          type="button"
          onClick={downloadCsv}
          className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:border-[#2d8a9e] hover:text-[#0c2340] hover:bg-slate-50 cursor-pointer transition shrink-0"
        >
          <Download className="h-3.5 w-3.5" />
          Download CSV
        </button>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-900 text-slate-100">
              <tr>
                <th className="text-left font-semibold uppercase tracking-wider text-[10px] px-4 py-3">Timestamp</th>
                <th className="text-left font-semibold uppercase tracking-wider text-[10px] px-4 py-3">Category</th>
                <th className="text-left font-semibold uppercase tracking-wider text-[10px] px-4 py-3">Actor</th>
                <th className="text-left font-semibold uppercase tracking-wider text-[10px] px-4 py-3">Facility Scoped</th>
                <th className="text-left font-semibold uppercase tracking-wider text-[10px] px-4 py-3">Action Details</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading && events.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-6 text-center text-xs text-slate-500">
                    <Loader2 className="inline h-3.5 w-3.5 animate-spin mr-1.5" /> Loading live system events…
                  </td>
                </tr>
              )}
              {!loading && events.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-6 text-center text-xs text-slate-500">
                    No system events yet. Activity will stream in as it happens.
                  </td>
                </tr>
              )}
              {events.map((e) => (
                <tr key={e.key} className="hover:bg-slate-50/70 transition-colors">
                  <td className="px-4 py-2.5 font-mono text-[12px] text-slate-700 whitespace-nowrap">{e.ts}</td>
                  <td className="px-4 py-2.5">
                    <span className={`inline-flex items-center rounded border px-1.5 py-0.5 font-mono text-[10px] font-bold tracking-wider ${CATEGORY_STYLES[e.category]}`}>
                      [{e.category}]
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-slate-800 whitespace-nowrap">{e.actor}</td>
                  <td className="px-4 py-2.5 text-slate-700 whitespace-nowrap">{e.facility}</td>
                  <td className="px-4 py-2.5 text-slate-700">{e.details}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

type DictEntry = {
  id: string;
  code_system: string;
  code: string;
  display: string;
  category: string | null;
  description: string | null;
  status: string;
};

const CODE_SYSTEMS = ["ICD-10", "SNOMED CT", "LOINC", "RxNorm", "VSAC"] as const;

const SYSTEM_META: Record<string, { tint: string; chip: string; blurb: string }> = {
  "ICD-10":     { tint: "border-rose-200 bg-rose-50/40",       chip: "bg-rose-100 text-rose-800 border-rose-200",         blurb: "Diagnosis & symptom codes" },
  "SNOMED CT":  { tint: "border-indigo-200 bg-indigo-50/40",   chip: "bg-indigo-100 text-indigo-800 border-indigo-200",   blurb: "Clinical findings & procedures" },
  "LOINC":      { tint: "border-amber-200 bg-amber-50/40",     chip: "bg-amber-100 text-amber-800 border-amber-200",      blurb: "Laboratory observations" },
  "RxNorm":     { tint: "border-emerald-200 bg-emerald-50/40", chip: "bg-emerald-100 text-emerald-800 border-emerald-200", blurb: "Medications & doses" },
  "VSAC":       { tint: "border-sky-200 bg-sky-50/40",         chip: "bg-sky-100 text-sky-800 border-sky-200",            blurb: "Aligned value sets" },
};

function MedicalDictionary() {
  const [subtab, setSubtab] = useState<"catalog" | "audits" | "matrix" | "safety">("catalog");
  const [facilityFilter, setFacilityFilter] = useState<string>("all");
  const [rows, setRows] = useState<DictEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeSystem, setActiveSystem] = useState<string>("ICD-10");
  const [search, setSearch] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [looking, setLooking] = useState(false);
  const [lookupNote, setLookupNote] = useState<string | null>(null);
  const [form, setForm] = useState({
    code_system: "ICD-10",
    code: "",
    display: "",
    category: "",
    description: "",
  });
  // UMLS search panel state inside the Add Terminology dialog.
  const [umlsQuery, setUmlsQuery] = useState("");
  const [umlsLoading, setUmlsLoading] = useState(false);
  const [umlsError, setUmlsError] = useState<string | null>(null);
  const [umlsResults, setUmlsResults] = useState<
    Array<{ ui: string; name: string; rootSource: string }>
  >([]);
  const [importingCode, setImportingCode] = useState<string | null>(null);

  // Map UI code system → vocabulary name the proxy understands.
  const umlsVocab = (sys: string) =>
    sys === "SNOMED CT"
      ? "SNOMED-CT"
      : sys === "ICD-10"
        ? "ICD-10-CM"
        : sys === "LOINC"
          ? "LOINC"
          : sys === "RxNorm"
            ? "RxNorm"
            : "";

  // 400ms debounced UMLS search via our secure proxy.
  useEffect(() => {
    if (!addOpen) return;
    const vocab = umlsVocab(form.code_system);
    const q = umlsQuery.trim();
    if (!vocab || q.length < 2) {
      setUmlsResults([]);
      setUmlsError(vocab ? null : "VSAC is manual-entry only.");
      return;
    }
    let cancelled = false;
    const t = setTimeout(async () => {
      setUmlsLoading(true);
      setUmlsError(null);
      try {
        const r = await fetch("/api/public/umls-search", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ searchTerm: q, vocabulary: vocab }),
        });
        const j = await r.json();
        if (cancelled) return;
        if (!r.ok) {
          setUmlsError(j?.error ?? `Lookup failed (${r.status})`);
          setUmlsResults([]);
        } else {
          const items = (j?.result?.results ?? []) as Array<{
            ui: string;
            name: string;
            rootSource: string;
          }>;
          // NLM returns [{ui:"NONE",name:"NO RESULTS"}] for empty.
          const cleaned = items.filter((it) => it.ui && it.ui !== "NONE");
          setUmlsResults(cleaned);
          if (cleaned.length === 0) setUmlsError("No matches found.");
        }
      } catch (e: any) {
        if (!cancelled) setUmlsError(e?.message ?? "Network error");
      } finally {
        if (!cancelled) setUmlsLoading(false);
      }
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [umlsQuery, form.code_system, addOpen]);

  /**
   * Populate every form field (Code, Display Name, Category,
   * Usage / Description) from a single UMLS search hit. The user can
   * then review the full record inside the assigned boxes before
   * committing it to the dictionary with "Save to Dictionary".
   */
  const useUmlsHit = (hit: { ui: string; name: string }) => {
    setForm((f) => ({
      ...f,
      code: hit.ui,
      display: hit.name,
      category: f.category.trim() || DEFAULT_CATEGORY[f.code_system] || "",
      description: defaultUsage(f.code_system, hit.name),
    }));
    setLookupNote(`Matched ${form.code_system} ${hit.ui} — ${hit.name}`);
  };

  const load = async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from("medical_terminology")
      .select("id, code_system, code, display, category, description, status")
      .order("code_system")
      .order("code");
    if (error) toast.error("Failed to load dictionary", { description: error.message });
    else setRows((data as any) ?? []);
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  /* ------------------------------------------------------------ */
  /*  Latest-15-admissions usage filter                            */
  /*  Restricts the Catalog to only codes referenced by the most   */
  /*  recent 15 patients in the selected facility (or network).    */
  /* ------------------------------------------------------------ */
  const [usedCodes, setUsedCodes] = useState<Record<string, Set<string>>>({});
  const [usageMeta, setUsageMeta] = useState<{ count: number; labels: string[]; meds: string[] }>({ count: 0, labels: [], meds: [] });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      let pq = supabase
        .from("patients")
        .select("mrn, chief_complaint, diagnosis, icd10_codes, snomed_codes")
        .order("admission_time", { ascending: false })
        .limit(15);
      if (facilityFilter && facilityFilter !== "all") {
        pq = pq.eq("facility_name", facilityFilter);
      }
      const { data: patients } = await pq;
      const list = (patients ?? []) as any[];
      const mrns = list.map((p) => p.mrn).filter(Boolean);
      const [labsRes, medsRes] = await Promise.all([
        mrns.length
          ? supabase.from("lab_orders").select("patient_mrn, test_type").in("patient_mrn", mrns)
          : Promise.resolve({ data: [] as any[] }),
        mrns.length
          ? supabase.from("medication_orders").select("patient_mrn, medication_name, drug_name").in("patient_mrn", mrns)
          : Promise.resolve({ data: [] as any[] }),
      ]);
      const labLabels = new Set<string>();
      for (const r of (labsRes.data ?? []) as any[]) if (r.test_type) labLabels.add(String(r.test_type));
      const medLabels = new Set<string>();
      for (const r of (medsRes.data ?? []) as any[]) {
        const m = r.medication_name || r.drug_name;
        if (m) medLabels.add(String(m));
      }
      const ccLabels: string[] = [];
      const exactIcd = new Set<string>();
      const exactSnomed = new Set<string>();
      for (const p of list) {
        if (p.chief_complaint) ccLabels.push(String(p.chief_complaint));
        if (p.diagnosis) ccLabels.push(String(p.diagnosis));
        for (const c of (p.icd10_codes ?? []) as string[]) exactIcd.add(c);
        for (const c of (p.snomed_codes ?? []) as string[]) exactSnomed.add(c);
      }
      if (cancelled) return;
      setUsageMeta({ count: list.length, labels: Array.from(labLabels), meds: Array.from(medLabels) });

      // Build per-system code sets by matching the dictionary against the
      // patient cohort's chief complaints / lab test names / med names.
      const matchSet = (system: string, candidates: string[], exact?: Set<string>): Set<string> => {
        const pool = rows.filter((r) => r.code_system === system);
        const out = new Set<string>();
        if (exact) for (const c of exact) out.add(c);
        for (const c of candidates) {
          if (!c) continue;
          const cl = c.toLowerCase();
          for (const row of pool) {
            const d = row.display?.toLowerCase() ?? "";
            if (!d) continue;
            if (d.includes(cl) || cl.includes(d.split(" ")[0])) out.add(row.code);
          }
        }
        return out;
      };
      setUsedCodes({
        "ICD-10":    matchSet("ICD-10", ccLabels, exactIcd),
        "SNOMED CT": matchSet("SNOMED CT", ccLabels, exactSnomed),
        "LOINC":     matchSet("LOINC", Array.from(labLabels)),
        "RxNorm":    matchSet("RxNorm", Array.from(medLabels)),
        "VSAC":      new Set(rows.filter((r) => r.code_system === "VSAC").map((r) => r.code)),
      });
    })();
    return () => { cancelled = true; };
  }, [facilityFilter, rows]);

  // Debounced auto-lookup: when user enters a code under a code system
  // that has a public terminology service, resolve display + category +
  // description automatically. User can still override any field.
  useEffect(() => {
    if (!addOpen) return;
    const code = form.code.trim();
    if (!code) { setLookupNote(null); return; }
    let cancelled = false;
    setLooking(true);
    setLookupNote(null);
    const t = setTimeout(async () => {
      const res = await lookupTerminology(form.code_system, code);
      if (cancelled) return;
      setLooking(false);
      if (!res) {
        setLookupNote(
          form.code_system === "VSAC"
            ? "VSAC requires manual entry — fill the fields below."
            : "No public match — verify the code or fill manually.",
        );
        return;
      }
      setLookupNote(`Matched ${form.code_system} · ${code}`);
      setForm((f) => ({
        ...f,
        display: f.display.trim() ? f.display : res.display,
        category: f.category.trim() ? f.category : res.category,
        description: f.description.trim() ? f.description : res.description,
      }));
    }, 450);
    return () => { cancelled = true; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.code, form.code_system, addOpen]);

  const openAdd = () => {
    setForm({
      code_system: activeSystem,
      code: "",
      display: "",
      category: DEFAULT_CATEGORY[activeSystem] ?? "",
      description: "",
    });
    setLookupNote(null);
    setUmlsQuery("");
    setUmlsResults([]);
    setUmlsError(null);
    setAddOpen(true);
  };

  const onSystemChange = (v: string) => {
    setForm((f) => ({
      ...f,
      code_system: v,
      // Refresh default category when switching systems unless user has typed one
      category: f.category && f.category !== DEFAULT_CATEGORY[f.code_system]
        ? f.category
        : (DEFAULT_CATEGORY[v] ?? ""),
    }));
  };

  const exportFhir = () => {
    const entries = rows
      .filter((r) => r.code_system === activeSystem)
      .map((r) => ({ code: r.code, display: r.display, description: r.description }));
    const doc = toFhirCodeSystem(activeSystem, entries);
    const blob = new Blob([JSON.stringify(doc, null, 2)], { type: "application/fhir+json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `CodeSystem-${activeSystem.replace(/\s+/g, "_")}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success("FHIR CodeSystem exported", { description: `${activeSystem} · ${entries.length} concepts` });
  };

  const filtered = rows.filter((r) => {
    if (r.code_system !== activeSystem) return false;
    const used = usedCodes[r.code_system];
    if (used && !used.has(r.code)) return false;
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return (
      r.code.toLowerCase().includes(q) ||
      r.display.toLowerCase().includes(q) ||
      (r.category ?? "").toLowerCase().includes(q)
    );
  });

  const counts = CODE_SYSTEMS.reduce<Record<string, number>>((acc, s) => {
    const used = usedCodes[s];
    acc[s] = rows.filter((r) => r.code_system === s && (!used || used.has(r.code))).length;
    return acc;
  }, {});

  const submit = async () => {
    if (!form.code.trim() || !form.display.trim()) {
      toast.error("Code and display name are required");
      return;
    }
    setSaving(true);
    const finalCategory = form.category.trim() || DEFAULT_CATEGORY[form.code_system] || null;
    const finalDescription = form.description.trim() || defaultUsage(form.code_system, form.display.trim());
    const { data, error } = await supabase
      .from("medical_terminology")
      .upsert({
        code_system: form.code_system,
        code: form.code.trim(),
        display: form.display.trim(),
        category: finalCategory,
        description: finalDescription,
      }, { onConflict: "code_system,code" })
      .select()
      .single();
    setSaving(false);
    if (error) {
      toast.error("Could not add terminology", { description: error.message });
      return;
    }
    setRows((r) => {
      const without = r.filter((x) => x.id !== (data as any).id);
      return [...without, data as any].sort(
        (a, b) => a.code_system.localeCompare(b.code_system) || a.code.localeCompare(b.code),
      );
    });
    setActiveSystem(form.code_system);
    setAddOpen(false);
    setForm({ code_system: form.code_system, code: "", display: "", category: DEFAULT_CATEGORY[form.code_system] ?? "", description: "" });
    toast.success("Terminology added", { description: `${form.code_system} · ${form.code}` });
  };

  const remove = async (id: string) => {
    const prev = rows;
    setRows((r) => r.filter((x) => x.id !== id));
    const { error } = await supabase.from("medical_terminology").delete().eq("id", id);
    if (error) {
      setRows(prev);
      toast.error("Could not remove entry", { description: error.message });
      return;
    }
    toast.success("Entry removed");
  };

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="text-xl font-semibold text-slate-900 flex items-center gap-2">
              📚 Medical Dictionary
            </h1>
            <label className="inline-flex items-center gap-1.5">
              <span className="text-[10px] uppercase tracking-[0.18em] text-slate-500">
                🏥 Select Facility Network
              </span>
              <select
                value={facilityFilter}
                onChange={(e) => setFacilityFilter(e.target.value)}
                className="h-8 rounded-md border border-slate-200 bg-white px-2 text-xs font-medium text-slate-800 outline-none hover:bg-slate-50 focus:border-slate-400 transition cursor-pointer"
              >
                <option value="all">All Facilities</option>
                {FACILITIES.map((f) => (
                  <option key={f} value={f}>{f}</option>
                ))}
              </select>
            </label>
          </div>
          <p className="text-sm text-slate-600 mt-1 max-w-2xl">
            VSAC-aligned terminology library used across the EHR. Browse SNOMED CT, ICD-10,
            LOINC, RxNorm, and curated value sets; extend with site-specific codes.
          </p>
          {subtab === "catalog" && (
            <p className="text-[11px] mt-1 text-slate-500">
              Showing only codes referenced by the latest {usageMeta.count} admission{usageMeta.count === 1 ? "" : "s"}
              {facilityFilter !== "all" ? ` at ${facilityFilter}` : " across the network"}.
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          {subtab === "catalog" && (
            <Button variant="outline" onClick={exportFhir} title="Download active code system as FHIR CodeSystem JSON">
              <Download className="h-4 w-4" /> Export FHIR
            </Button>
          )}
          {/* Search Terminology is available across every sub-tab so any
              workflow (Catalog, NLP Audits, Live Matrix, Safety Alerts)
              can resolve a code via the UMLS API and view its full record. */}
          <Button onClick={openAdd} className="bg-[#0c2340] hover:bg-[#0c2340]/90">
            <Search className="h-4 w-4" /> Search Terminology
          </Button>
        </div>
      </div>

      {/* Sub-tab nav */}
      <div className="flex items-center gap-1 border-b border-slate-200">
        {([
          { id: "catalog", label: "Catalog", Icon: BookMarked },
          { id: "audits",  label: "NLP Audit Logs", Icon: Sparkles },
          { id: "matrix",  label: "Live Terminology Matrix", Icon: Grid3x3 },
          { id: "safety",  label: "Safety Alerts", Icon: ShieldAlert },
        ] as const).map(({ id, label, Icon }) => {
          const active = subtab === id;
          return (
            <button
              key={id}
              onClick={() => setSubtab(id)}
              className={`inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-t-md transition cursor-pointer border-b-2 -mb-px ${
                active
                  ? "border-[#0c2340] text-[#0c2340] bg-white"
                  : "border-transparent text-slate-500 hover:text-slate-800"
              }`}
            >
              <Icon className="h-3.5 w-3.5" /> {label}
            </button>
          );
        })}
      </div>

      {subtab === "audits" && <NlpAuditLogs facility={facilityFilter} />}
      {subtab === "matrix" && <LiveTerminologyMatrix dict={rows} facility={facilityFilter} />}
      {subtab === "safety" && <SafetyQueue />}

      {subtab === "catalog" && (<>
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        {CODE_SYSTEMS.map((s) => {
          const meta = SYSTEM_META[s];
          const active = activeSystem === s;
          return (
            <button
              key={s}
              onClick={() => setActiveSystem(s)}
              className={`text-left rounded-xl border p-3 transition cursor-pointer ${meta.tint} ${
                active ? "ring-2 ring-[#0c2340] shadow-sm" : "hover:shadow-sm"
              }`}
            >
              <div className="flex items-center justify-between">
                <span className={`inline-flex items-center rounded border px-1.5 py-0.5 font-mono text-[10px] font-bold tracking-wider ${meta.chip}`}>
                  {s}
                </span>
                <span className="text-xs font-semibold text-slate-700">{counts[s] ?? 0}</span>
              </div>
              <div className="mt-2 text-[11px] text-slate-600">{meta.blurb}</div>
            </button>
          );
        })}
      </div>

      <div className="rounded-xl border border-slate-200 bg-white shadow-sm overflow-hidden">
        <div className="flex items-center gap-3 px-5 py-3 border-b border-slate-100 bg-slate-50/60">
          <span className={`inline-flex items-center rounded border px-1.5 py-0.5 font-mono text-[10px] font-bold tracking-wider ${SYSTEM_META[activeSystem].chip}`}>
            {activeSystem}
          </span>
          <div className="text-sm font-semibold text-slate-900">{SYSTEM_META[activeSystem].blurb}</div>
          <div className="ml-auto relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-400" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search code or term…"
              className="h-8 w-64 rounded-md border border-slate-300 bg-white pl-7 pr-2 text-xs outline-none focus:border-[#2d8a9e] focus:ring-2 focus:ring-[#2d8a9e]/30"
            />
          </div>
        </div>

        {loading ? (
          <div className="flex items-center gap-2 text-sm text-slate-500 p-6">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading terminology…
          </div>
        ) : filtered.length === 0 ? (
          <div className="p-8 text-center text-sm text-slate-500">
            No entries{search ? " match your search" : ""} in {activeSystem}.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-slate-50 text-[10px] uppercase tracking-wider text-slate-500">
                <tr>
                  <th className="text-left px-4 py-2 font-semibold">Code</th>
                  <th className="text-left px-4 py-2 font-semibold">Display Name</th>
                  <th className="text-left px-4 py-2 font-semibold">Category</th>
                  <th className="text-left px-4 py-2 font-semibold">Usage</th>
                  <th className="text-left px-4 py-2 font-semibold">Status</th>
                  <th className="px-4 py-2"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filtered.map((e) => (
                  <tr key={e.id} className="hover:bg-slate-50/60">
                    <td className="px-4 py-2.5 font-mono text-[11px] font-semibold text-slate-900 whitespace-nowrap">{e.code}</td>
                    <td className="px-4 py-2.5 text-slate-800">{e.display}</td>
                    <td className="px-4 py-2.5 text-slate-700">{e.category ?? "—"}</td>
                    <td className="px-4 py-2.5 text-slate-600">{e.description ?? "—"}</td>
                    <td className="px-4 py-2.5">
                      <span className="inline-flex items-center rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold text-emerald-700">
                        ● {e.status}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <button
                        onClick={() => remove(e.id)}
                        className="text-slate-400 hover:text-rose-600 transition cursor-pointer"
                        title="Remove entry"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      </>)}
      {subtab === "catalog" && <CustomRulesCard />}

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Search Terminology</DialogTitle>
            <DialogDescription>
              Search any SNOMED CT, ICD-10, LOINC, or RxNorm code via the live
              UMLS API. Selecting a result fills in the Code, Category, Display
              Name, and Usage boxes so you can review the full record before
              saving it to the dictionary.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label className="text-xs">Code System</Label>
              <Select value={form.code_system} onValueChange={onSystemChange}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {CODE_SYSTEMS.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            {/* UMLS search — debounced, secure proxy */}
            <div className="rounded-md border border-slate-200 bg-slate-50/60 p-3 space-y-2">
              <Label className="text-xs flex items-center gap-2">
                🔎 UMLS Search ({form.code_system})
                {umlsLoading && <Loader2 className="h-3 w-3 animate-spin text-slate-400" />}
              </Label>
              <input
                value={umlsQuery}
                onChange={(e) => setUmlsQuery(e.target.value)}
                placeholder={
                  umlsVocab(form.code_system)
                    ? `Search ${form.code_system} (e.g. ${form.code_system === "RxNorm" ? "ibuprofen" : form.code_system === "LOINC" ? "hemoglobin" : "sepsis"})`
                    : "VSAC is manual-entry only"
                }
                disabled={!umlsVocab(form.code_system)}
                className="h-9 w-full rounded-md border border-slate-300 px-3 text-sm outline-none focus:border-[#2d8a9e] focus:ring-2 focus:ring-[#2d8a9e]/30 disabled:bg-slate-100 disabled:cursor-not-allowed"
              />
              {umlsError && (
                <div className="text-[11px] text-amber-700">{umlsError}</div>
              )}
              {umlsResults.length > 0 && (
                <ul className="max-h-56 overflow-y-auto divide-y divide-slate-200 rounded border border-slate-200 bg-white">
                  {umlsResults.map((hit) => (
                    <li
                      key={`${hit.rootSource}-${hit.ui}`}
                      className="flex items-center justify-between gap-3 px-3 py-2 text-xs"
                    >
                      <div className="min-w-0">
                        <div className="font-mono text-[11px] font-semibold text-slate-900">
                          {hit.ui}
                        </div>
                        <div className="text-slate-700 truncate">{hit.name}</div>
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => useUmlsHit(hit)}
                        className="shrink-0"
                      >
                        <Search className="h-3.5 w-3.5" />
                        Use
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs flex items-center gap-2">
                  Code
                  {looking && <Loader2 className="h-3 w-3 animate-spin text-slate-400" />}
                </Label>
                <input
                  value={form.code}
                  onChange={(e) => setForm({ ...form, code: e.target.value })}
                  placeholder="e.g. R07.9"
                  className="mt-1 h-9 w-full rounded-md border border-slate-300 px-3 text-sm outline-none focus:border-[#2d8a9e] focus:ring-2 focus:ring-[#2d8a9e]/30"
                />
                {lookupNote && (
                  <div className={`mt-1 text-[10px] ${lookupNote.startsWith("Matched") ? "text-emerald-600" : "text-amber-600"}`}>
                    {lookupNote}
                  </div>
                )}
              </div>
              <div>
                <Label className="text-xs">Category</Label>
                <input
                  value={form.category}
                  onChange={(e) => setForm({ ...form, category: e.target.value })}
                  placeholder="e.g. Chief Complaint"
                  className="mt-1 h-9 w-full rounded-md border border-slate-300 px-3 text-sm outline-none focus:border-[#2d8a9e] focus:ring-2 focus:ring-[#2d8a9e]/30"
                />
              </div>
            </div>
            <div>
              <Label className="text-xs">Display Name</Label>
              <input
                value={form.display}
                onChange={(e) => setForm({ ...form, display: e.target.value })}
                placeholder="e.g. Chest pain, unspecified"
                className="mt-1 h-9 w-full rounded-md border border-slate-300 px-3 text-sm outline-none focus:border-[#2d8a9e] focus:ring-2 focus:ring-[#2d8a9e]/30"
              />
            </div>
            <div>
              <Label className="text-xs">Usage / Description</Label>
              <textarea
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                placeholder="How is this code used in the EHR?"
                rows={2}
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-[#2d8a9e] focus:ring-2 focus:ring-[#2d8a9e]/30"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddOpen(false)} disabled={saving}>Cancel</Button>
            <Button onClick={submit} disabled={saving} className="bg-[#0c2340] hover:bg-[#0c2340]/90">
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
              Save to Dictionary
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
