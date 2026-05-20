import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
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
  UserPlus,
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
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetTrigger,
  SheetFooter,
} from "@/components/ui/sheet";
import { Progress } from "@/components/ui/progress";
import { useFacility, useActiveStaff } from "@/lib/facility-context";
import { PatientFlowCensusLog } from "@/components/PatientFlowCensusLog";

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
}

const STAFF_ROLES = ["RN", "MD", "PharmD", "RT", "CNA", "LPN"] as const;

const IN_NETWORK_FACILITIES = new Set([
  "Memorial Hospital",
  "St. Jude Medical Center",
  "City General Infirmary",
  "County Health Pavilion",
  "Mercy Childrens Hospital",
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
    case "RT":
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
  const [patients, setPatients] = useState<Patient[]>([]);
  const [pendingPharm, setPendingPharm] = useState(0);
  const [loading, setLoading] = useState(true);

  const [nurse, setNurse] = useState("");
  const [cluster, setCluster] = useState("");
  const [assignments, setAssignments] = useState<Assignment[]>([]);

  const [staff, setStaff] = useState<StaffMember[]>([]);
  const [staffLoading, setStaffLoading] = useState(true);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newRole, setNewRole] = useState<string>("RN");
  const [newRate, setNewRate] = useState<string>("");
  const [saving, setSaving] = useState(false);

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

  useEffect(() => {
    (async () => {
      const { data, error } = await supabase
        .from("hospital_staff")
        .select("id,name,role,status,assigned_patients,max_capacity,hourly_rate,facility_name")
        .order("role", { ascending: true });
      if (error) toast.error(error.message);
      else setStaff((data ?? []) as StaffMember[]);
      setStaffLoading(false);
    })();
  }, []);

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
      .select("id,mrn,name,first_name,last_name,room,code_status,hr,spo2,facility_name")
      .order("room", { ascending: true });
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
  const facilityStaff = useMemo(
    () => staff.filter((s) => (s.facility_name ?? "Memorial Hospital") === facility),
    [staff, facility],
  );

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

  const onDutyRNs = useMemo(
    () =>
      facilityStaff.filter((s) => s.role === "RN" && s.status === "On Duty").length,
    [facilityStaff],
  );
  const census = facilityPatients.length;
  const ratio = onDutyRNs > 0 ? census / onDutyRNs : Infinity;
  const safeRatio = onDutyRNs > 0 && ratio <= 5;

  const clockInStaff = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName.trim() || !newRole) {
      toast.error("Name and role are required");
      return;
    }
    const rate = parseInt(newRate, 10);
    setSaving(true);
    const { data, error } = await supabase
      .from("hospital_staff")
      .insert({
        name: newName.trim(),
        role: newRole,
        hourly_rate: Number.isFinite(rate) ? rate : 45,
        status: "On Duty",
        assigned_patients: 0,
        max_capacity: newRole === "RN" ? 5 : 10,
        facility_name: facility,
      })
      .select(
        "id,name,role,status,assigned_patients,max_capacity,hourly_rate,facility_name",
      )
      .single();
    setSaving(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    setStaff((s) => [data as StaffMember, ...s]);
    toast.success(`${(data as StaffMember).name} clocked in.`);
    setNewName("");
    setNewRole("RN");
    setNewRate("");
    setSheetOpen(false);
  };

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
            value={loading ? "…" : facilityPatients.length}
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
                            disabled={busy}
                            onClick={() => approveTransfer(t)}
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
                            disabled={busy}
                            onClick={() => denyTransfer(t)}
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
            <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
              <SheetTrigger asChild>
                <Button
                  size="sm"
                  className="bg-[#0c2340] hover:bg-[#0c2340]/90"
                >
                  <UserPlus className="h-4 w-4" />
                  Clock-In New Staff
                </Button>
              </SheetTrigger>
              <SheetContent className="sm:max-w-md">
                <SheetHeader>
                  <SheetTitle>➕ Clock-In New Staff</SheetTitle>
                  <SheetDescription>
                    Add a clinician to the active shift roster.
                  </SheetDescription>
                </SheetHeader>
                <form
                  onSubmit={clockInStaff}
                  className="space-y-4 px-4 py-6"
                >
                  <div className="space-y-1.5">
                    <Label>Full Name</Label>
                    <Input
                      placeholder="e.g. Jordan Lee"
                      value={newName}
                      onChange={(e) => setNewName(e.target.value)}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Role</Label>
                    <Select value={newRole} onValueChange={setNewRole}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {STAFF_ROLES.map((r) => (
                          <SelectItem key={r} value={r}>
                            {r}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label>Hourly Rate (USD)</Label>
                    <Input
                      type="number"
                      min={0}
                      placeholder="45"
                      value={newRate}
                      onChange={(e) => setNewRate(e.target.value)}
                    />
                  </div>
                  <SheetFooter className="px-0">
                    <Button
                      type="submit"
                      disabled={saving}
                      className="bg-[#0c2340] hover:bg-[#0c2340]/90 w-full"
                    >
                      {saving ? "Saving…" : "Save & Clock In"}
                    </Button>
                  </SheetFooter>
                </form>
              </SheetContent>
            </Sheet>
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
            {staffLoading ? (
              <div className="grid place-items-center h-32">
                <Loader2 className="h-5 w-5 animate-spin text-slate-400" />
              </div>
            ) : facilityStaff.length === 0 ? (
              <p className="text-xs text-slate-500 border border-dashed border-slate-200 rounded-md py-6 text-center">
                No staff clocked in at {facility}.
              </p>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {facilityStaff.map((s) => {
                  const assigned = s.assigned_patients ?? 0;
                  const cap = s.max_capacity ?? 5;
                  const pct = Math.min(100, Math.round((assigned / cap) * 100));
                  const onDuty = s.status === "On Duty";
                  return (
                    <div
                      key={s.id}
                      className="rounded-lg border border-slate-200 p-4 hover:border-slate-300 transition-colors"
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
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
                        <div className="flex items-center gap-1.5 text-xs text-slate-600">
                          <span
                            className={`h-2 w-2 rounded-full ${
                              onDuty
                                ? "bg-emerald-500 animate-pulse"
                                : "bg-amber-500"
                            }`}
                          />
                          {s.status ?? "—"}
                        </div>
                      </div>
                      <div className="mt-3">
                        <div className="flex items-center justify-between text-xs text-slate-600 mb-1">
                          <span>
                            {assigned} / {cap} Patients Assigned
                          </span>
                          <span className="font-medium text-slate-700">
                            {pct}%
                          </span>
                        </div>
                        <Progress value={pct} />
                      </div>
                      {s.hourly_rate != null && (
                        <div className="mt-2 text-[11px] text-slate-500">
                          ${s.hourly_rate}/hr
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
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

        {/* Census */}
        <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
          <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3">
            <h2 className="text-sm font-semibold text-slate-900">
              Live Census Audit
            </h2>
            <span className="text-xs text-slate-500">
              {patients.length} active patients
            </span>
          </div>
          {loading ? (
            <div className="grid place-items-center h-40">
              <Loader2 className="h-5 w-5 animate-spin text-slate-400" />
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-[11px] uppercase tracking-widest text-slate-500">
                  <tr>
                    <th className="text-left px-5 py-2.5">MRN</th>
                    <th className="text-left px-5 py-2.5">Patient</th>
                    <th className="text-left px-5 py-2.5">Room</th>
                    <th className="text-left px-5 py-2.5">Code Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {patients.map((p) => (
                    <tr key={p.id}>
                      <td className="px-5 py-2.5 font-mono text-xs text-slate-700">
                        {p.mrn ?? "—"}
                      </td>
                      <td className="px-5 py-2.5 text-slate-900">
                        {fullName(p)}
                      </td>
                      <td className="px-5 py-2.5 text-slate-700">
                        {p.room ?? "—"}
                      </td>
                      <td className="px-5 py-2.5">
                        <span
                          className={`inline-flex rounded-md px-2 py-0.5 text-xs font-semibold ${codeColor(
                            p.code_status,
                          )}`}
                        >
                          {p.code_status ?? "Full Code"}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
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