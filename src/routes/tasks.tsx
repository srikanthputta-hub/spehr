import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { BoardHeader } from "@/components/BoardShell";
import { useFacility } from "@/lib/facility-context";
import { toast } from "sonner";
import { CheckCircle2, ClipboardCheck } from "lucide-react";
import { InfoHint } from "@/components/ui/info-hint";
import { StatusBadge } from "@/components/common/StatusBadge";
import { TableSkeleton } from "@/components/common/LoadingSkeleton";
import { EmptyState } from "@/components/common/EmptyState";

export const Route = createFileRoute("/tasks")({
  component: TasksPage,
});

interface TaskRow {
  id: string;
  patient_name: string | null;
  patient_mrn: string | null;
  mrn: string | null;
  medication_name: string | null;
  medication: string | null;
  drug_name: string | null;
  drug: string | null;
  name: string | null;
  dose: string | null;
  route: string | null;
  status: string | null;
}

function medName(t: TaskRow) {
  return t.medication_name || t.medication || t.drug_name || t.drug || t.name || "—";
}
function mrnOf(t: TaskRow) {
  return t.patient_mrn || t.mrn || "—";
}

function TasksPage() {
  const { facility } = useFacility();
  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    // Strict facility scoping: resolve MRNs for the selected facility first,
    // then fetch only medication orders for those patients.
    const { data: facPatients, error: pErr } = await supabase
      .from("patients")
      .select("mrn")
      .eq("facility_name", facility);
    if (pErr) {
      toast.error("Failed to load tasks");
      setTasks([]);
      setLoading(false);
      return;
    }
    const mrns = (facPatients ?? []).map((p: any) => p.mrn).filter(Boolean);
    if (mrns.length === 0) {
      setTasks([]);
      setLoading(false);
      return;
    }
    const { data, error } = await supabase
      .from("medication_orders")
      .select("*")
      .in("status", ["Approved"])
      .in("patient_mrn", mrns)
      .order("created_at", { ascending: false });
    if (error) {
      toast.error("Failed to load tasks");
      setTasks([]);
    } else {
      setTasks((data ?? []) as TaskRow[]);
    }
    setLoading(false);
  }, [facility]);

  useEffect(() => {
    load();
  }, [load]);

  const administer = async (t: TaskRow) => {
    setBusyId(t.id);
    // Compare-and-swap: only write if the order is still Approved, so a race
    // with another nurse (or the automation sweep) can't silently double-act
    // on an order that already moved on. Mirrors pharmacy-queue.tsx's
    // actOnOrder guard.
    const { data, error } = await supabase
      .from("medication_orders")
      .update({ status: "Administered", administered_at: new Date().toISOString() })
      .eq("id", t.id)
      .eq("status", "Approved")
      .select("id");
    setBusyId(null);
    if (error) return toast.error("Administration failed");
    if (!data || data.length === 0) {
      toast.error("Order already updated", {
        description: "Someone else (or the automation sweep) already acted on this order. Refresh to see its current state.",
      });
      load();
      return;
    }
    toast.success(`Administered · ${medName(t)} to ${t.patient_name ?? "patient"}`);
    setTasks((cur) => cur.filter((x) => x.id !== t.id));
  };

  return (
    <main className="min-h-screen bg-slate-50">
      <BoardHeader
        title={`Active Task List — ${facility}`}
        badge="Nursing"
        subtitle={`Pending administrations · ${facility}`}
      />
      <section className="max-w-7xl mx-auto px-6 py-6">
        <div className="rounded-md border border-slate-200 bg-white">
          <div className="flex items-center justify-between border-b border-slate-200 px-4 py-2.5">
            <div className="text-xs font-semibold uppercase tracking-wider text-slate-700">
              Clinical Tasks
            </div>
            <div className="text-[11px] text-slate-500 tabular-nums">
              {loading ? "Loading…" : `${tasks.length} open`}
            </div>
          </div>

          {loading ? (
            <div className="p-4">
              <TableSkeleton rows={5} columns={7} />
            </div>
          ) : tasks.length === 0 ? (
            <EmptyState
              icon={ClipboardCheck}
              title="All caught up"
              description={`No pharmacist-verified medication orders are waiting for administration at ${facility} right now.`}
            />
          ) : (
            <table className="w-full text-xs">
              <thead className="bg-slate-50 text-[10px] uppercase tracking-wider text-slate-600">
                <tr className="border-b border-slate-200">
                  <th className="px-3 py-2 text-left font-semibold">Patient Name</th>
                  <th className="px-3 py-2 text-left font-semibold">MRN</th>
                  <th className="px-3 py-2 text-left font-semibold">Medication</th>
                  <th className="px-3 py-2 text-left font-semibold">Dose</th>
                  <th className="px-3 py-2 text-left font-semibold">Route</th>
                  <th className="px-3 py-2 text-left font-semibold">
                    <span className="inline-flex items-center gap-1">
                      Status
                      <InfoHint text='"Approved" = pharmacist has verified the order and it is DUE for nurse administration. This list only ever shows pharmacist-verified orders — an order awaiting pharmacist review appears on the Pharmacy Queue, not here.' />
                    </span>
                  </th>
                  <th className="px-3 py-2 text-right font-semibold">
                    <span className="inline-flex items-center gap-1">
                      Action
                      <InfoHint text='"Administer" marks the dose given (status = Administered, administered_at stamped). Only pharmacist-verified ("Approved") orders reach this list, so nurses cannot bypass pharmacist medication verification from here.' />
                    </span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {tasks.map((t) => {
                  return (
                    <tr key={t.id} className="border-b border-slate-100 hover:bg-slate-50">
                      <td className="px-3 py-2 font-medium text-slate-900">
                        {t.patient_name ?? "—"}
                      </td>
                      <td className="px-3 py-2 font-mono text-slate-700">{mrnOf(t)}</td>
                      <td className="px-3 py-2 text-slate-800">{medName(t)}</td>
                      <td className="px-3 py-2 font-mono text-slate-700">{t.dose ?? "—"}</td>
                      <td className="px-3 py-2 font-mono text-slate-700">{t.route ?? "—"}</td>
                      <td className="px-3 py-2">
                        <StatusBadge status="success" label={t.status ?? "Approved"} />
                      </td>
                      <td className="px-3 py-2 text-right">
                        <button
                          disabled={busyId === t.id}
                          onClick={() => administer(t)}
                          className="inline-flex items-center gap-1 rounded-sm bg-emerald-600 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-emerald-500 disabled:opacity-50"
                        >
                          <CheckCircle2 className="h-3 w-3" /> Administer
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </section>
    </main>
  );
}