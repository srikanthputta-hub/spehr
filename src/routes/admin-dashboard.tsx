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
} from "lucide-react";

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
}

interface Assignment {
  id: string;
  nurse: string;
  cluster: string;
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
  const [patients, setPatients] = useState<Patient[]>([]);
  const [pendingPharm, setPendingPharm] = useState(0);
  const [loading, setLoading] = useState(true);

  const [nurse, setNurse] = useState("");
  const [cluster, setCluster] = useState("");
  const [assignments, setAssignments] = useState<Assignment[]>([]);

  useEffect(() => {
    (async () => {
      const [pRes, mRes] = await Promise.all([
        supabase
          .from("patients")
          .select("id,mrn,name,first_name,last_name,room,code_status,hr,spo2")
          .order("room", { ascending: true }),
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

  const acuity = useMemo(
    () =>
      patients.filter((p) => (p.hr ?? 0) > 100 || (p.spo2 ?? 100) < 92).length,
    [patients],
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

  return (
    <main className="min-h-screen bg-slate-50">
      <BoardHeader
        title="Unit Administrator Dashboard"
        badge="Operations"
        subtitle="Floor census, throughput, and staffing"
      />

      <section className="p-6 space-y-6 max-w-7xl mx-auto">
        {/* Metrics */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <MetricCard
            icon={<Users className="h-5 w-5" />}
            label="Total Active Census"
            value={loading ? "…" : patients.length}
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