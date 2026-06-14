import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { BoardHeader } from "@/components/BoardShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import {
  Users,
  PillBottle,
  AlertTriangle,
  UserCog,
  Trash2,
  Loader2,
  ShieldCheck,
  ShieldAlert,
  Inbox,
  Check,
  X,
  ArrowRightLeft,
} from "lucide-react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { Progress } from "@/components/ui/progress";
import { useFacility, useActiveStaff, STAFF_BY_FACILITY, type Facility, type StaffRole } from "@/lib/facility-context";
import { PatientFlowCensusLog } from "@/components/PatientFlowCensusLog";
import { useRolePermissions } from "@/hooks/useRolePermissions";

export const Route = createFileRoute("/admin-dashboard")({
  component: AdminDashboard,
});

interface Patient {
  id: string;
  mrn: string | null;
  name: string | null;
  first_name: string | null;
  last_name: string | null;
  room: string | null;
  code_status: string | null;
  hr: number | null;
  spo2: number | null;
  facility_name: string | null;
  status?: string | null;
  chief_complaint?: string | null;
  admission_time?: string | null;
}

interface Assignment {
  id: string;
  nurse: string;
  cluster: string;
}

interface StaffMember {
  id: string;
  name: string;
  role: string;
  status: string | null;
  assigned_patients: number | null;
  max_capacity: number | null;
  hourly_rate: number | null;
  facility_name: string | null;
  hours_worked?: number;
}

// Roster: exactly 3 staff per role, rotating on strict 12-hour shifts.
// At any moment, slot 0 is On Duty and slot 1 is Next Shift (queued);
// slot 2 is resting. The clock advances 1 simulated hour every TICK_MS,
// and when the on-duty clinician completes 12h the rotation advances
// (slot 1 takes over, the rested clinician becomes Next Shift).
const MAX_SHIFT_HOURS = 12;
const SHIFT_MS = MAX_SHIFT_HOURS * 60 * 60 * 1000;
// Anchor at the Unix epoch so every browser/facility agrees on which
// 12h block we're in right now. Day shift = blocks at 07:00 local etc.
// We use UTC math here — shifts roll every 12h on the wall clock.
function shiftStateNow() {
  const now = Date.now();
  const block = Math.floor(now / SHIFT_MS);
  const intoMs = now - block * SHIFT_MS;
  return { block, hours: intoMs / 3_600_000 };
}

// Roles mirror the system-wide ordering (RN → MD → PharmD → Lab → Admin → Finance)
// so the Active Unit Staffing & Shift Roster reflects the exact clinicians
// signed in for each role at each facility (canonical names come from
// STAFF_BY_FACILITY — same source of truth used by every board header).
type RoleKey = StaffRole;
const STAFF_ROLES: readonly RoleKey[] = [
  "RN",
  "MD",
  "PharmD",
  "Lab",
  "Admin",
  "Finance",
] as const;

const ROLE_SUFFIX: Record<RoleKey, string> = {
  RN: ", RN",
  MD: ", MD",
  PharmD: ", PharmD",
  Lab: ", CLT",
  Admin: ", Admin",
  Finance: ", CPA",
};
const ROLE_RATE: Record<RoleKey, number> = {
  RN: 52, MD: 150, PharmD: 68, Lab: 38, Admin: 45, Finance: 60,
};
const ROLE_CAP: Record<RoleKey, number> = {
  RN: 5, MD: 15, PharmD: 50, Lab: 20, Admin: 0, Finance: 0,
};

// Deterministic per-facility name pool keeps each hospital's roster
// consistent across reloads (no random churn between renders).
const NAME_POOL: Array<[string, string]> = [
  ["Sarah", "Jenkins"], ["Marcus", "Patel"], ["Elena", "Rostova"],
  ["David", "Okafor"], ["Aisha", "Bauer"], ["Hiro", "Quintero"],
  ["Nadia", "Mendez"], ["Owen", "Sullivan"], ["Priya", "Reyes"],
  ["Felix", "Carter"], ["Grace", "Holloway"], ["Jonah", "Brennan"],
  ["Kira", "Tanaka"], ["Leon", "Ortiz"], ["Mira", "Singh"],
  ["Noor", "Adler"], ["Otis", "Bishop"], ["Rhea", "Costa"],
] as const as Array<[string, string]>;

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h * 16777619) >>> 0;
  }
  return h;
}

function buildRoster(facility: string): Record<RoleKey, string[]> {
  // Slot 0 of every role is the canonical on-duty clinician for this facility
  // (pulled from STAFF_BY_FACILITY — the same record the rest of the system
  // uses on every board). Slots 1 & 2 are deterministically seeded relief
  // staff so Next Shift / Resting names are stable across reloads.
  const seed = hashString(facility || "default");
  const pool = [...NAME_POOL];
  // Fisher–Yates with seeded LCG so the same facility always yields the
  // same shuffle (no rotation just from re-mounting the page).
  let s = seed || 1;
  const rand = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const facilityStaff = STAFF_BY_FACILITY[facility as Facility];
  const out = {} as Record<RoleKey, string[]>;
  let idx = 0;
  for (const role of STAFF_ROLES) {
    const canonical = facilityStaff?.[role]?.name;
    const names: string[] = [];
    // Slot 0 = the real, system-synced staff member for this role/facility.
    names.push(canonical ?? `${pool[idx % pool.length][0]} ${pool[idx % pool.length][1]}${ROLE_SUFFIX[role]}`);
    // Slots 1 & 2 = relief pool for Next Shift / Resting.
    for (let k = 0; k < 2; k++) {
      const [f, l] = pool[(idx++) % pool.length];
      names.push(`${f} ${l}${ROLE_SUFFIX[role]}`);
    }
    out[role] = names;
  }
  return out;
}

const IN_NETWORK_FACILITIES = new Set([
  "Memorial Hospital",
  "St. Jude Medical Center",
  "City General Infirmary",
  "County Health Pavilion",
  "Srik Health Clinic",
]);

interface TransferRequest {
  id: string;
  patient_mrn: string;
  patient_name: string;
  source_facility: string;
  destination_facility: string;
  requesting_physician: string;
  reason_for_transfer: string | null;
  status: string | null;
  created_at: string | null;
}

function roleBadgeClass(role: string) {
  switch (role) {
    case "RN":
      return "bg-sky-50 text-sky-700 ring-1 ring-sky-600/20";
    case "MD":
      return "bg-violet-50 text-violet-700 ring-1 ring-violet-600/20";
    case "PharmD":
      return "bg-amber-50 text-amber-700 ring-1 ring-amber-600/20";
    case "Finance":
      return "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-600/20";
    default:
      return "bg-slate-100 text-slate-700 ring-1 ring-slate-600/20";
  }
}

const ROOM_CLUSTERS = [
  "Rooms 401–404",
  "Rooms 405–408",
  "Rooms 409–412",
  "ICU Pod A",
  "ICU Pod B",
];

function fullName(p: Patient) {
  return (
    p.name ||
    [p.first_name, p.last_name].filter(Boolean).join(" ") ||
    p.mrn ||
    "—"
  );
}

function codeColor(c: string | null) {
  switch (c) {
    case "DNR":
      return "bg-red-50 text-red-700 ring-1 ring-red-600/20";
    case "DNI":
      return "bg-amber-50 text-amber-700 ring-1 ring-amber-600/20";
    case "Comfort":
      return "bg-slate-100 text-slate-700 ring-1 ring-slate-600/20";
    default:
      return "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-600/20";
  }
}

function AdminDashboard() {
  const admin = useActiveStaff("Admin");
  const { facility } = useFacility();
  const { can } = useRolePermissions("Admin" as any);
  const [patients, setPatients] = useState<Patient[]>([]);
  const [pendingPharm, setPendingPharm] = useState(0);
  const [loading, setLoading] = useState(true);

  const [nurse, setNurse] = useState("");
  const [cluster, setCluster] = useState("");
  const [assignments, setAssignments] = useState<Assignment[]>([]);

  // Per-role shift clock — driven by real wall-clock time. Every 12h
  // (UTC-aligned) the on-duty index rotates to the next slot, exactly
  // like a real hospital handoff.
  const roster = useMemo(() => buildRoster(facility), [facility]);
  const [shiftTick, setShiftTick] = useState(() => shiftStateNow());

  const [transfers, setTransfers] = useState<TransferRequest[]>([]);
  const [transfersLoading, setTransfersLoading] = useState(true);
  const [actingOn, setActingOn] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const [pRes, mRes] = await Promise.all([
        supabase
          .from("patients")
          .select("id,mrn,name,first_name,last_name,room,code_status,hr,spo2,facility_name,status,chief_complaint,admission_time")
          .order("admission_time", { ascending: false }),
        supabase
          .from("medication_orders")
          .select("id", { count: "exact", head: true })
          .eq("status", "PENDING_PHARMACY"),
      ]);
      if (pRes.error) toast.error(pRes.error.message);
      else setPatients((pRes.data ?? []) as Patient[]);
      if (!mRes.error) setPendingPharm(mRes.count ?? 0);
      setLoading(false);
    })();
  }, []);

  // Re-sync immediately when the facility switches so the new tab shows
  // the correct current shift state without waiting for the next tick.
  useEffect(() => {
    setShiftTick(shiftStateNow());
  }, [facility]);

  const loadTransfers = async () => {
    const { data, error } = await supabase
      .from("patient_transfers")
      .select("*")
      .eq("status", "Pending Approval")
      .order("created_at", { ascending: false });
    if (error) toast.error(error.message);
    else setTransfers((data ?? []) as TransferRequest[]);
    setTransfersLoading(false);
  };

  const reloadPatients = async () => {
    const { data, error } = await supabase
      .from("patients")
      .select("id,mrn,name,first_name,last_name,room,code_status,hr,spo2,facility_name,status,chief_complaint,admission_time")
      .order("admission_time", { ascending: false });
    if (!error) setPatients((data ?? []) as Patient[]);
  };

  useEffect(() => {
    loadTransfers();
  }, []);

  const facilityTransfers = useMemo(
    () => transfers.filter((t) => t.source_facility === facility),
    [transfers, facility],
  );

  const approveTransfer = async (t: TransferRequest) => {
    setActingOn(t.id);
    try {
      const { error: updErr } = await supabase
        .from("patient_transfers")
        .update({ status: "Approved" })
        .eq("id", t.id);
      if (updErr) throw updErr;

      if (IN_NETWORK_FACILITIES.has(t.destination_facility)) {
        const { error: pErr } = await supabase
          .from("patients")
          .update({
            facility_name: t.destination_facility,
            room: "Holding/ER",
          })
          .eq("mrn", t.patient_mrn);
        if (pErr) throw pErr;
      } else {
        const { error: dErr } = await supabase
          .from("patients")
          .delete()
          .eq("mrn", t.patient_mrn);
        if (dErr) throw dErr;
      }

      toast.success(
        "Patient successfully transferred and rerouted across network servers.",
      );
      setTransfers((cur) => cur.filter((x) => x.id !== t.id));
      await reloadPatients();
    } catch (e: any) {
      toast.error("Transfer failed", { description: e?.message });
    } finally {
      setActingOn(null);
    }
  };

  const denyTransfer = async (t: TransferRequest) => {
    setActingOn(t.id);
    const { error } = await supabase
      .from("patient_transfers")
      .update({ status: "Denied" })
      .eq("id", t.id);
    setActingOn(null);
    if (error) {
      toast.error("Could not deny transfer", { description: error.message });
      return;
    }
    setTransfers((cur) => cur.filter((x) => x.id !== t.id));
    toast.success("Transfer request denied.");
  };

  const facilityPatients = useMemo(
    () => patients.filter((p) => (p.facility_name ?? "Memorial Hospital") === facility),
    [patients, facility],
  );
  // Active census: exclude discharged patients. Treat any status that is
  // not explicitly "Discharged" (case-insensitive) as active/admitted.
  const activePatients = useMemo(
    () =>
      facilityPatients.filter(
        (p) => (p.status ?? "Admitted").toString().toLowerCase() !== "discharged",
      ),
    [facilityPatients],
  );
  // No-op placeholder — staffing now derives purely from the shift clock
  // (see `rosterCards` below). Kept here to preserve memo ordering for
  // downstream dependent memos.

  const acuity = useMemo(
    () =>
      facilityPatients.filter((p) => (p.hr ?? 0) > 100 || (p.spo2 ?? 100) < 92).length,
    [facilityPatients],
  );

  const addAssignment = (e: React.FormEvent) => {
    e.preventDefault();
    if (!nurse.trim() || !cluster) {
      toast.error("Enter a nurse name and select a cluster");
      return;
    }
    setAssignments((a) => [
      { id: crypto.randomUUID(), nurse: nurse.trim(), cluster },
      ...a,
    ]);
    toast.success(`${nurse.trim()} assigned to ${cluster}`);
    setNurse("");
    setCluster("");
  };

  const removeAssignment = (id: string) =>
    setAssignments((a) => a.filter((x) => x.id !== id));

  // ============ Real-Time 12-hour Shift Rotation ============
  // Recompute the wall-clock shift state every 30s. When the 12h block
  // index rolls forward, fire a handoff toast for every role.
  const lastBlockRef = useRef<number>(shiftTick.block);
  useEffect(() => {
    const tick = () => {
      const s = shiftStateNow();
      setShiftTick(s);
      if (s.block !== lastBlockRef.current) {
        for (const r of STAFF_ROLES) {
          const newIdx = s.block % 3;
          toast(
            `Shift change · ${r}: ${roster[r][newIdx]} clocking in.`,
            { className: "bg-slate-100 text-slate-800" },
          );
        }
        lastBlockRef.current = s.block;
      }
    };
    const interval = setInterval(tick, 30_000);
    return () => clearInterval(interval);
  }, [roster]);

  // Derive the visible roster: per role, On Duty + Next Shift only.
  const census = activePatients.length;
  const rosterCards = useMemo(() => {
    type Card = {
      key: string;
      role: RoleKey;
      name: string;
      status: "On Duty" | "Next Shift";
      hours: number;
      rate: number;
      cap: number;
      assigned: number;
    };
    const out: Card[] = [];
    const onIdx = shiftTick.block % 3;
    const curHours = shiftTick.hours;
    for (const role of STAFF_ROLES) {
      const cap = ROLE_CAP[role];
      const rate = ROLE_RATE[role];
      // Synthetic patient load — proportional to census, capped at role limit.
      const loadFactor =
        role === "RN" ? 0.25 :
        role === "MD" ? 0.5 :
        role === "PharmD" ? 0.8 :
        role === "CNA" || role === "LPN" ? 0.35 : 0;
      const assigned = cap > 0
        ? Math.min(cap, Math.max(role === "Finance" ? 0 : 1, Math.round(census * loadFactor)))
        : 0;
      out.push({
        key: `${role}-on`,
        role,
        name: roster[role][onIdx],
        status: "On Duty",
        hours: curHours,
        rate,
        cap,
        assigned,
      });
      out.push({
        key: `${role}-next`,
        role,
        name: roster[role][(onIdx + 1) % 3],
        status: "Next Shift",
        hours: curHours,
        rate,
        cap,
        assigned: 0,
      });
    }
    return out;
  }, [roster, shiftTick, census]);

  // RN ratio: exactly 1 RN is On Duty at any given moment (per design).
  const onDutyRNs = 1;
  const ratio = census / onDutyRNs;
  const safeRatio = ratio <= 5;

  return (
    <main className="min-h-screen bg-slate-50">
      <BoardHeader
        title={`Admin Workspace: ${admin.name} | ${admin.facility}`}
        badge="Operations · Admin"
        subtitle={`${admin.ward} · Floor census, throughput, and staffing`}
      />

      <section className="p-6 space-y-6 max-w-7xl mx-auto">
        {/* Metrics */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <MetricCard
            icon={<Users className="h-5 w-5" />}
            label="Total Active Census"
            value={loading ? "…" : activePatients.length}
            tint="bg-sky-50 text-sky-700"
          />
          <MetricCard
            icon={<PillBottle className="h-5 w-5" />}
            label="Pharmacy Bottleneck"
            value={loading ? "…" : pendingPharm}
            tint="bg-amber-50 text-amber-700"
            sub="Orders pending verification"
          />
          <MetricCard
            icon={<AlertTriangle className="h-5 w-5" />}
            label="Unit Acuity Flag"
            value={loading ? "…" : acuity}
            tint="bg-red-50 text-red-700"
            sub="HR >100 or SpO₂ <92%"
            alert={acuity > 0}
          />
        </div>

        <FacilityAnalytics patients={facilityPatients} facility={facility} loading={loading} />

        {/* Pending Network Transfer Requests */}
        <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
          <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3">
            <h2 className="text-sm font-semibold text-slate-900 flex items-center gap-2">
              <Inbox className="h-4 w-4 text-[#0c2340]" />
              📥 Pending Network Transfer Requests
            </h2>
            <span className="text-xs text-slate-500">
              {facilityTransfers.length} awaiting review · {facility}
            </span>
          </div>
          <div className="p-5">
            {transfersLoading ? (
              <div className="grid place-items-center h-24">
                <Loader2 className="h-5 w-5 animate-spin text-slate-400" />
              </div>
            ) : facilityTransfers.length === 0 ? (
              <p className="text-xs text-slate-500 border border-dashed border-slate-200 rounded-md py-6 text-center">
                No pending inter-facility transfer requests for {facility}.
              </p>
            ) : (
              <ul className="space-y-3">
                {facilityTransfers.map((t) => {
                  const busy = actingOn === t.id;
                  const outside = !IN_NETWORK_FACILITIES.has(t.destination_facility);
                  return (
                    <li
                      key={t.id}
                      className="rounded-lg border border-slate-200 p-4 hover:border-slate-300 transition-colors"
                    >
                      <div className="flex items-start justify-between gap-4 flex-wrap">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-sm font-semibold text-slate-900">
                              {t.patient_name}
                            </span>
                            <span className="text-[11px] font-mono text-slate-500">
                              MRN {t.patient_mrn}
                            </span>
                            {outside && (
                              <span className="inline-flex rounded-md bg-red-50 text-red-700 ring-1 ring-red-600/20 px-1.5 py-0.5 text-[10px] font-bold tracking-wide">
                                OUTSIDE NETWORK
                              </span>
                            )}
                          </div>
                          <div className="mt-1 text-xs text-slate-600 flex items-center gap-2 flex-wrap">
                            <span className="font-medium">{t.source_facility}</span>
                            <ArrowRightLeft className="h-3 w-3 text-slate-400" />
                            <span className="font-medium">{t.destination_facility}</span>
                          </div>
                          <div className="mt-1 text-[11px] text-slate-500">
                            Requested by{" "}
                            <span className="font-medium text-slate-700">
                              {t.requesting_physician}
                            </span>
                          </div>
                          {t.reason_for_transfer && (
                            <p className="mt-2 text-xs text-slate-700 bg-slate-50 border border-slate-100 rounded-md px-3 py-2">
                              {t.reason_for_transfer}
                            </p>
                          )}
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <Button
                            size="sm"
                            disabled={busy || !can("btn_approve_transfer")}
                            onClick={() => approveTransfer(t)}
                            title={can("btn_approve_transfer") ? undefined : "Action disabled — contact admin to activate"}
                            className="bg-emerald-600 hover:bg-emerald-700"
                          >
                            {busy ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <Check className="h-3.5 w-3.5" />
                            )}
                            ✅ Approve &amp; Transfer
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={busy || !can("btn_deny_transfer")}
                            onClick={() => denyTransfer(t)}
                            title={can("btn_deny_transfer") ? undefined : "Action disabled — contact admin to activate"}
                            className="border-red-200 text-red-700 hover:bg-red-50"
                          >
                            <X className="h-3.5 w-3.5" />
                            ❌ Deny
                          </Button>
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>

        {/* Active Unit Staffing & Shift Roster */}
        <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
          <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3">
            <h2 className="text-sm font-semibold text-slate-900 flex items-center gap-2">
              👥 Active Unit Staffing &amp; Shift Roster
            </h2>
            <span className="text-[11px] text-slate-500 font-mono">
              3-per-role rotation · {MAX_SHIFT_HOURS}h shifts
            </span>
          </div>

          {/* Safety ratio card */}
          <div className="p-5 border-b border-slate-100">
            <div
              className={`rounded-lg border p-4 flex items-center justify-between gap-4 ${
                safeRatio
                  ? "border-emerald-200 bg-emerald-50"
                  : "border-amber-300 bg-amber-50 animate-pulse"
              }`}
            >
              <div className="flex items-center gap-3">
                {safeRatio ? (
                  <ShieldCheck className="h-6 w-6 text-emerald-600" />
                ) : (
                  <ShieldAlert className="h-6 w-6 text-amber-600" />
                )}
                <div>
                  <div
                    className={`text-sm font-semibold ${
                      safeRatio ? "text-emerald-800" : "text-amber-800"
                    }`}
                  >
                    {safeRatio
                      ? "✅ Safe Staffing Ratios Maintained"
                      : "⚠️ Understaffed: Nursing workload exceeds safety thresholds."}
                  </div>
                  <div className="text-xs text-slate-600 mt-0.5">
                    {onDutyRNs} RN{onDutyRNs === 1 ? "" : "s"} on duty ·{" "}
                    {census} patient census · Ratio{" "}
                    {onDutyRNs > 0 ? `1 : ${(census / onDutyRNs).toFixed(1)}` : "n/a"}
                  </div>
                </div>
              </div>
              <div
                className={`text-2xl font-bold ${
                  safeRatio ? "text-emerald-700" : "text-amber-700"
                }`}
              >
                {onDutyRNs > 0 ? `1:${Math.ceil(census / onDutyRNs)}` : "—"}
              </div>
            </div>
          </div>

          {/* Roster cards */}
          <div className="p-5">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {rosterCards.map((s) => {
                const pct = s.cap > 0
                  ? Math.min(100, Math.round((s.assigned / s.cap) * 100))
                  : 0;
                const onDuty = s.status === "On Duty";
                const hoursRemaining = MAX_SHIFT_HOURS - s.hours;
                return (
                  <div
                    key={s.key}
                    className={`rounded-lg border p-4 transition-colors ${
                      onDuty
                        ? "border-emerald-200 bg-emerald-50/40 hover:border-emerald-300"
                        : "border-slate-200 bg-slate-50/40 hover:border-slate-300"
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-semibold text-slate-900">
                          {s.name}
                        </span>
                        <span
                          className={`inline-flex rounded-md px-1.5 py-0.5 text-[10px] font-bold tracking-wide ${roleBadgeClass(
                            s.role,
                          )}`}
                        >
                          {s.role}
                        </span>
                      </div>
                      <div className="flex items-center gap-1.5 text-xs">
                        <span
                          className={`h-2 w-2 rounded-full ${
                            onDuty
                              ? "bg-emerald-500 animate-pulse"
                              : "bg-sky-500"
                          }`}
                        />
                        <span className={onDuty ? "text-emerald-700 font-medium" : "text-sky-700 font-medium"}>
                          {s.status}
                        </span>
                      </div>
                    </div>
                    {s.cap > 0 && (
                      <div className="mt-3">
                        <div className="flex items-center justify-between text-xs text-slate-600 mb-1">
                          <span>
                            {onDuty
                              ? `${s.assigned} / ${s.cap} Patients Assigned`
                              : `Queued for next shift`}
                          </span>
                          <span className="font-medium text-slate-700 flex items-center gap-2">
                            {onDuty ? (
                              <span
                                className={`tabular-nums ${
                                  s.hours >= 11
                                    ? "text-red-600 font-semibold"
                                    : s.hours >= 9
                                    ? "text-amber-600"
                                    : "text-slate-500"
                                }`}
                                title="Hours worked this shift"
                              >
                                ⏱ {s.hours.toFixed(0)}h / {MAX_SHIFT_HOURS}h
                              </span>
                            ) : (
                              <span className="text-sky-700 tabular-nums" title="Hours until shift change">
                                in ~{hoursRemaining.toFixed(0)}h
                              </span>
                            )}
                            {onDuty && <span>{pct}%</span>}
                          </span>
                        </div>
                        {onDuty && <Progress value={pct} />}
                      </div>
                    )}
                    <div className="mt-2 text-[11px] text-slate-500">
                      ${s.rate}/hr
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* Staffing */}
        <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
          <div className="flex items-center gap-2 border-b border-slate-100 px-5 py-3">
            <UserCog className="h-4 w-4 text-slate-600" />
            <h2 className="text-sm font-semibold text-slate-900">
              Staffing Allocation
            </h2>
          </div>
          <form
            onSubmit={addAssignment}
            className="grid grid-cols-1 md:grid-cols-[1fr_1fr_auto] gap-3 p-5 items-end"
          >
            <div className="space-y-1.5">
              <Label>Lead Nurse</Label>
              <Input
                placeholder="e.g. Sarah Jenkins, RN"
                value={nurse}
                onChange={(e) => setNurse(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Room Cluster</Label>
              <Select value={cluster} onValueChange={setCluster}>
                <SelectTrigger>
                  <SelectValue placeholder="Select cluster…" />
                </SelectTrigger>
                <SelectContent>
                  {ROOM_CLUSTERS.map((c) => (
                    <SelectItem key={c} value={c}>
                      {c}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button type="submit" className="bg-[#0c2340] hover:bg-[#0c2340]/90">
              Assign
            </Button>
          </form>

          <div className="px-5 pb-5">
            {assignments.length === 0 ? (
              <p className="text-xs text-slate-500 border border-dashed border-slate-200 rounded-md py-4 text-center">
                No assignments yet — assign a nurse to a cluster above.
              </p>
            ) : (
              <ul className="divide-y divide-slate-100 rounded-md border border-slate-200">
                {assignments.map((a) => (
                  <li
                    key={a.id}
                    className="flex items-center justify-between px-4 py-2.5"
                  >
                    <div>
                      <div className="text-sm font-medium text-slate-900">
                        {a.nurse}
                      </div>
                      <div className="text-xs text-slate-500">{a.cluster}</div>
                    </div>
                    <button
                      onClick={() => removeAssignment(a.id)}
                      className="text-slate-400 hover:text-red-600"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

      </section>
      <section className="max-w-[1400px] mx-auto px-6 pb-10">
        <PatientFlowCensusLog />
      </section>
    </main>
  );
}

function MetricCard({
  icon,
  label,
  value,
  tint,
  sub,
  alert,
}: {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
  tint: string;
  sub?: string;
  alert?: boolean;
}) {
  return (
    <div
      className={`rounded-xl border bg-white p-5 shadow-sm ${
        alert ? "border-red-300" : "border-slate-200"
      }`}
    >
      <div className="flex items-center justify-between">
        <div className="text-xs font-medium uppercase tracking-widest text-slate-500">
          {label}
        </div>
        <div className={`grid place-items-center h-8 w-8 rounded-md ${tint}`}>
          {icon}
        </div>
      </div>
      <div className="mt-2 text-3xl font-bold text-slate-900">{value}</div>
      {sub && <div className="mt-1 text-xs text-slate-500">{sub}</div>}
    </div>
  );
}

function fmtTs(ts: string | null | undefined) {
  if (!ts) return "—";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "—";
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const yy = String(d.getFullYear()).slice(-2);
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${mm}/${dd}/${yy} ${hh}:${mi}`;
}

function FacilityAnalytics({
  patients,
  facility,
  loading,
}: {
  patients: Patient[];
  facility: string;
  loading: boolean;
}) {
  const totals = useMemo(() => {
    let admitted = 0;
    let discharged = 0;
    for (const p of patients) {
      if (p.status === "Admitted") admitted++;
      else if (p.status === "Discharged") discharged++;
    }
    return { total: patients.length, admitted, discharged };
  }, [patients]);

  const chartData = useMemo(() => {
    const map = new Map<string, number>();
    for (const p of patients) {
      if (p.status !== "Admitted") continue;
      const k = (p.chief_complaint ?? "Unspecified").trim() || "Unspecified";
      map.set(k, (map.get(k) ?? 0) + 1);
    }
    return Array.from(map.entries())
      .map(([complaint, count]) => ({ complaint, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);
  }, [patients]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-[0.18em] text-slate-500">
          📊 Analytics Overview — {facility}
        </h2>
        <span className="text-[11px] text-slate-500 font-mono">
          Scoped to selected facility
        </span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <KpiCard label="Facility Admissions (All Time)" value={totals.total} tone="navy" />
        <KpiCard label="Currently Admitted" value={totals.admitted} tone="emerald" />
        <KpiCard label="Discharges" value={totals.discharged} tone="slate" />
      </div>

      <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3">
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-500">
              Acuity Mix
            </div>
            <div className="text-sm font-semibold text-slate-900">
              Active Census by Chief Complaint — {facility}
            </div>
          </div>
          <div className="text-[11px] text-slate-500 font-mono">
            {loading ? "loading…" : `${totals.admitted} active`}
          </div>
        </div>
        <div className="h-72 px-3 py-4">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chartData} margin={{ top: 10, right: 20, left: 0, bottom: 10 }}>
              <CartesianGrid strokeDasharray="2 3" stroke="#e2e8f0" vertical={false} />
              <XAxis
                dataKey="complaint"
                tick={{ fontSize: 11, fill: "#475569" }}
                axisLine={{ stroke: "#cbd5e1" }}
                tickLine={false}
                interval={0}
                angle={-15}
                textAnchor="end"
                height={60}
              />
              <YAxis
                allowDecimals={false}
                tick={{ fontSize: 11, fill: "#475569" }}
                axisLine={{ stroke: "#cbd5e1" }}
                tickLine={false}
              />
              <Tooltip
                cursor={{ fill: "rgba(13,148,136,0.06)" }}
                contentStyle={{
                  fontSize: 12,
                  borderRadius: 6,
                  border: "1px solid #cbd5e1",
                  boxShadow: "0 4px 12px rgba(15,23,42,0.08)",
                }}
                formatter={(v: number) => [v, "Active"]}
              />
              <Bar dataKey="count" fill="#0d9488" radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

    </div>
  );
}

function KpiCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "navy" | "emerald" | "slate";
}) {
  const tones: Record<string, string> = {
    navy: "bg-[#0c2340] text-white",
    emerald: "bg-emerald-500 text-white",
    slate: "bg-slate-200 text-slate-700",
  };
  return (
    <div className="rounded-xl border border-slate-200 bg-white shadow-sm px-5 py-4">
      <div className="flex items-start justify-between">
        <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-500">
          {label}
        </div>
        <div className={`h-2.5 w-2.5 rounded-full ${tones[tone]}`} />
      </div>
      <div className="mt-2 font-mono text-3xl font-semibold text-slate-900 tabular-nums">
        {value.toLocaleString()}
      </div>
    </div>
  );
}