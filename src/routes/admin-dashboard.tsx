import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { BoardHeader } from "@/components/BoardShell";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { Users, PillBottle, Loader2, Inbox, Check, X, ArrowRightLeft } from "lucide-react";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
import { Progress } from "@/components/ui/progress";
import {
  useFacility,
  useActiveStaff,
  STAFF_BY_FACILITY,
  type Facility,
  type StaffRole,
} from "@/lib/facility-context";
import { PatientFlowCensusLog } from "@/components/PatientFlowCensusLog";
import { useRolePermissions } from "@/hooks/useRolePermissions";
import { fetchWithTimeout } from "@/lib/async-timeout";
import { transferDeletePatientViaWorker } from "@/lib/transfer-delete-patient";
import { InfoHint } from "@/components/ui/info-hint";
import CohortCountsStrip from "@/components/analytics/CohortCountsStrip";
import { StatusBadge } from "@/components/common/StatusBadge";
import { KpiTile } from "@/components/common/KpiTile";
import { EmptyState } from "@/components/common/EmptyState";
import { TableSkeleton } from "@/components/common/LoadingSkeleton";
import { severityRowVariants } from "@/components/common/SeverityRow";
import { cn } from "@/lib/utils";

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
const STAFF_ROLES: readonly RoleKey[] = ["RN", "MD", "PharmD", "Lab", "Admin", "Finance"] as const;

const ROLE_SUFFIX: Record<RoleKey, string> = {
  RN: ", RN",
  MD: ", MD",
  PharmD: ", PharmD",
  Lab: ", CLT",
  Admin: ", Admin",
  Finance: ", CPA",
  Reception: "",
  Rad: ", MD",
};
const ROLE_RATE: Record<RoleKey, number> = {
  RN: 52,
  MD: 150,
  PharmD: 68,
  Lab: 38,
  Admin: 45,
  Finance: 60,
  Reception: 28,
  Rad: 160,
};
const ROLE_CAP: Record<RoleKey, number> = {
  RN: 5,
  MD: 15,
  PharmD: 50,
  Lab: 20,
  Admin: 0,
  Finance: 0,
  Reception: 0,
  Rad: 0,
};

// Deterministic per-facility name pool keeps each hospital's roster
// consistent across reloads (no random churn between renders).
const NAME_POOL: Array<[string, string]> = [
  ["Sarah", "Jenkins"],
  ["Marcus", "Patel"],
  ["Elena", "Rostova"],
  ["David", "Okafor"],
  ["Aisha", "Bauer"],
  ["Hiro", "Quintero"],
  ["Nadia", "Mendez"],
  ["Owen", "Sullivan"],
  ["Priya", "Reyes"],
  ["Felix", "Carter"],
  ["Grace", "Holloway"],
  ["Jonah", "Brennan"],
  ["Kira", "Tanaka"],
  ["Leon", "Ortiz"],
  ["Mira", "Singh"],
  ["Noor", "Adler"],
  ["Otis", "Bishop"],
  ["Rhea", "Costa"],
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
    names.push(
      canonical ??
        `${pool[idx % pool.length][0]} ${pool[idx % pool.length][1]}${ROLE_SUFFIX[role]}`,
    );
    // Slots 1 & 2 = relief pool for Next Shift / Resting.
    for (let k = 0; k < 2; k++) {
      const [f, l] = pool[idx++ % pool.length];
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

function fullName(p: Patient) {
  return p.name || [p.first_name, p.last_name].filter(Boolean).join(" ") || p.mrn || "—";
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
  const { can } = useRolePermissions("Admin");
  const [patients, setPatients] = useState<Patient[]>([]);
  const [pendingPharm, setPendingPharm] = useState(0);
  const [loading, setLoading] = useState(true);

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
      const [pRes, mRes] = await fetchWithTimeout(async () => {
        const [patientsRes, medsRes] = await Promise.all([
          supabase
            .from("patients")
            .select(
              "id,mrn,name,first_name,last_name,room,code_status,hr,spo2,facility_name,status,chief_complaint,admission_time",
            )
            .order("admission_time", { ascending: false }),
          supabase
            .from("medication_orders")
            .select("id", { count: "exact", head: true })
            .eq("status", "PENDING_PHARMACY"),
        ]);
        return [
          { data: patientsRes.data, error: patientsRes.error },
          { count: medsRes.count, error: medsRes.error },
        ];
      }, [
        { data: [], error: null },
        { count: 0, error: null },
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
    const { data, error } = await fetchWithTimeout(
      async () => {
        const res = await supabase
          .from("patient_transfers")
          .select("*")
          .eq("status", "Pending Approval")
          .order("created_at", { ascending: false });
        return { data: res.data, error: res.error };
      },
      { data: [], error: null },
    );
    if (error) toast.error(error.message);
    else setTransfers((data ?? []) as TransferRequest[]);
    setTransfersLoading(false);
  };

  const reloadPatients = async () => {
    const { data, error } = await supabase
      .from("patients")
      .select(
        "id,mrn,name,first_name,last_name,room,code_status,hr,spo2,facility_name,status,chief_complaint,admission_time",
      )
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
    // Compare-and-swap: only approve if the request is still Pending
    // Approval, so a race with another admin acting on the same request
    // can't silently double-act on it (mirrors actOnOrder in
    // pharmacy-queue.tsx, PR #26).
    const prevTransfers = transfers;
    try {
      const { data: updData, error: updErr } = await supabase
        .from("patient_transfers")
        .update({ status: "Approved" })
        .eq("id", t.id)
        .eq("status", "Pending Approval")
        .select("id");
      if (updErr) throw updErr;
      if (!updData || updData.length === 0) {
        setTransfers(prevTransfers);
        toast.error("Transfer already acted on", {
          description: "This transfer was already acted on by another admin.",
        });
        return;
      }

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
        // Outside-network transfer: permanently delete the patient record.
        // This MUST go through the service-role `transfer-delete-worker`
        // edge function, not a direct anon `.from("patients").delete()` —
        // RLS has no anon-matching DELETE policy on `patients`, so an anon
        // delete silently affects 0 rows with no error, and this branch
        // would otherwise show a false success toast while leaving the
        // patient record completely untouched.
        const result = await transferDeletePatientViaWorker({
          mrn: t.patient_mrn,
          transferId: t.id,
        });
        if (!result.ok || !result.deleted) {
          throw new Error(
            result.reason ?? "Patient delete could not be confirmed by transfer-delete-worker.",
          );
        }
      }

      toast.success("Patient successfully transferred and rerouted across network servers.");
      setTransfers((cur) => cur.filter((x) => x.id !== t.id));
      await reloadPatients();
    } catch (e) {
      toast.error("Transfer failed", { description: e instanceof Error ? e.message : undefined });
    } finally {
      setActingOn(null);
    }
  };

  const denyTransfer = async (t: TransferRequest) => {
    setActingOn(t.id);
    const prevTransfers = transfers;
    // Compare-and-swap guard: same rationale as approveTransfer above.
    const { data, error } = await supabase
      .from("patient_transfers")
      .update({ status: "Denied" })
      .eq("id", t.id)
      .eq("status", "Pending Approval")
      .select("id");
    setActingOn(null);
    if (error) {
      toast.error("Could not deny transfer", { description: error.message });
      return;
    }
    if (!data || data.length === 0) {
      setTransfers(prevTransfers);
      toast.error("Transfer already acted on", {
        description: "This transfer was already acted on by another admin.",
      });
      return;
    }
    setTransfers((cur) => cur.filter((x) => x.id !== t.id));
    toast.success("Transfer request denied.");
  };

  const facilityPatients = useMemo(
    () => patients.filter((p) => (p.facility_name ?? "Memorial Hospital") === facility),
    [patients, facility],
  );
  // Active census: strictly patients.status = "Admitted". Matches the
  // nursing / physician / analytics boards so the tile is consistent
  // across the entire app (previously used status !== "discharged"
  // which loosely counted null / pending / cancelled rows too).
  const activePatients = useMemo(
    () => facilityPatients.filter((p) => (p.status ?? "").toString().toLowerCase() === "admitted"),
    [facilityPatients],
  );
  // No-op placeholder — staffing now derives purely from the shift clock
  // (see `rosterCards` below). Kept here to preserve memo ordering for
  // downstream dependent memos.

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
          // Relief slot rotates between 1 & 2 each block; the canonical
          // on-duty clinician (slot 0) stays put for system-wide sync.
          const reliefIdx = 1 + (s.block % 2);
          toast(`Shift change · ${r}: ${roster[r][reliefIdx]} queued as next shift.`, {
            className: "bg-slate-100 text-slate-800",
          });
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
    // Slot 0 is always the canonical, system-synced clinician for this
    // facility/role — they stay On Duty so every board (nursing,
    // pharmacy, physician, lab, finance, admin) shows the same name.
    // Relief staff in slots 1 & 2 rotate through the Next Shift card.
    const onIdx = 0;
    const nextIdx = 1 + (shiftTick.block % 2);
    const curHours = shiftTick.hours;
    for (const role of STAFF_ROLES) {
      const cap = ROLE_CAP[role];
      const rate = ROLE_RATE[role];
      // Synthetic patient load — proportional to census, capped at role limit.
      const loadFactor =
        role === "RN"
          ? 0.25
          : role === "MD"
            ? 0.5
            : role === "PharmD"
              ? 0.8
              : role === "Lab"
                ? 0.4
                : 0;
      const assigned = cap > 0 ? Math.min(cap, Math.max(1, Math.round(census * loadFactor))) : 0;
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
        name: roster[role][nextIdx],
        status: "Next Shift",
        hours: curHours,
        rate,
        cap,
        assigned: 0,
      });
    }
    return out;
  }, [roster, shiftTick, census]);

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
            info={`Facility-scoped count of patients where status = "Admitted" at ${facility}.`}
          />
          <MetricCard
            icon={<PillBottle className="h-5 w-5" />}
            label="Pharmacy Bottleneck"
            value={loading ? "…" : pendingPharm}
            tint="bg-amber-50 text-amber-700"
            sub="Orders pending verification"
            info={`Orders at ${facility} with status = "PENDING_PHARMACY". PENDING_VERIFICATION and HELD_SAFETY_REVIEW orders are NOT included in this count.`}
          />
          <CohortCountsStrip variant="card" facilityName={facility} />
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
              <TableSkeleton rows={3} columns={4} />
            ) : facilityTransfers.length === 0 ? (
              <EmptyState
                description={`No pending inter-facility transfer requests for ${facility}.`}
              />
            ) : (
              <ul className="space-y-3">
                {facilityTransfers.map((t) => {
                  const busy = actingOn === t.id;
                  const outside = !IN_NETWORK_FACILITIES.has(t.destination_facility);
                  return (
                    <li
                      key={t.id}
                      className={cn(
                        severityRowVariants({ severity: outside ? "critical" : "none" }),
                        "rounded-lg border border-slate-200 p-4 hover:border-slate-300 transition-colors",
                      )}
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
                            {outside && <StatusBadge status="critical" label="Outside Network" />}
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
                            title={
                              can("btn_approve_transfer")
                                ? undefined
                                : "Action disabled — contact admin to activate"
                            }
                            className="bg-emerald-600 hover:bg-emerald-700"
                          >
                            {busy ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <Check className="h-3.5 w-3.5" />
                            )}
                            ✅ Approve &amp; Transfer
                          </Button>
                          <InfoHint text="In-network destination: moves the patient's facility_name to the target facility (record preserved). Outside-network destination: PERMANENTLY DELETES the local patient record because the patient is leaving the SPEHR network entirely — this action cannot be undone." />
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={busy || !can("btn_deny_transfer")}
                            onClick={() => denyTransfer(t)}
                            title={
                              can("btn_deny_transfer")
                                ? undefined
                                : "Action disabled — contact admin to activate"
                            }
                            className="border-red-200 text-red-700 hover:bg-red-50"
                          >
                            <X className="h-3.5 w-3.5" />❌ Deny
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
              👥 Simulated Staffing (Demo Data — Not Live)
              <InfoHint
                className="ml-1"
                text="Names, hours, rates, and patient assignments on this panel are generated client-side for demo purposes — there is no live staff_shifts/roster table behind them. Do not use these numbers for real staffing-safety decisions."
              />
            </h2>
            <span className="text-[11px] text-slate-500 font-mono">
              3-per-role rotation · {MAX_SHIFT_HOURS}h shifts (simulated)
              <InfoHint
                className="ml-1"
                text="Wall-clock UTC rotation: 3 staff members per role cycle through 12-hour shift blocks aligned to absolute UTC time, so shift changes happen at the same instant network-wide regardless of local timezone. This entire rotation is synthetic — no real shift data drives it."
              />
            </span>
          </div>

          {/* Roster cards */}
          <div className="p-5">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {rosterCards.map((s) => {
                const pct = s.cap > 0 ? Math.min(100, Math.round((s.assigned / s.cap) * 100)) : 0;
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
                        <span className="text-sm font-semibold text-slate-900">{s.name}</span>
                        <span
                          className={`inline-flex rounded-md px-1.5 py-0.5 text-[10px] font-bold tracking-wide ${roleBadgeClass(
                            s.role,
                          )}`}
                        >
                          {s.role}
                        </span>
                      </div>
                      <StatusBadge status={onDuty ? "success" : "neutral"} label={s.status} />
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
                              <span
                                className="text-sky-700 tabular-nums"
                                title="Hours until shift change"
                              >
                                in ~{hoursRemaining.toFixed(0)}h
                              </span>
                            )}
                            {onDuty && <span>{pct}%</span>}
                          </span>
                        </div>
                        {onDuty && <Progress value={pct} />}
                      </div>
                    )}
                    <div className="mt-2 text-[11px] text-slate-500">${s.rate}/hr</div>
                  </div>
                );
              })}
            </div>
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
  info,
}: {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
  tint: string;
  sub?: string;
  alert?: boolean;
  info?: string;
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
          {info && <InfoHint className="ml-1.5" text={info} />}
        </div>
        <div className={`grid place-items-center h-8 w-8 rounded-md ${tint}`}>{icon}</div>
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
      const status = (p.status ?? "").toLowerCase();
      if (status === "admitted") admitted++;
      else if (status === "discharged") discharged++;
    }
    return { total: patients.length, admitted, discharged };
  }, [patients]);

  const chartData = useMemo(() => {
    const map = new Map<string, number>();
    for (const p of patients) {
      if ((p.status ?? "").toLowerCase() !== "admitted") continue;
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
        <span className="text-[11px] text-slate-500 font-mono">Scoped to selected facility</span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <KpiTile value={totals.total.toLocaleString()} label="Facility Admissions (All Time)" />
        <KpiTile value={totals.admitted.toLocaleString()} label="Currently Admitted" />
        <KpiTile value={totals.discharged.toLocaleString()} label="Discharges" />
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
