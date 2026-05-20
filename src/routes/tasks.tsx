import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { BoardHeader } from "@/components/BoardShell";
import { useFacility } from "@/lib/facility-context";
import { toast } from "sonner";
import { Loader2, CheckCircle2, ShieldCheck } from "lucide-react";

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
      .in("status", ["Pending Verification", "Approved"])
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

  const verify = async (t: TaskRow) => {
    setBusyId(t.id);
    const { error } = await supabase
      .from("medication_orders")
      .update({ status: "Approved", approved_at: new Date().toISOString() })
      .eq("id", t.id);
    setBusyId(null);
    if (error) return toast.error("Verification failed");
    toast.success(`Order verified · ${medName(t)}`);
    load();
  };

  const administer = async (t: TaskRow) => {
    setBusyId(t.id);
    const { error } = await supabase
      .from("medication_orders")
      .update({ status: "Administered", administered_at: new Date().toISOString() })
      .eq("id", t.id);
    setBusyId(null);
    if (error) return toast.error("Administration failed");
    toast.success(`Administered · ${medName(t)} to ${t.patient_name ?? "patient"}`);
    setTasks((cur) => cur.filter((x) => x.id !== t.id));
  };

  return (
    <main className="min-h-screen bg-slate-50">
      <BoardHeader
        title={`Active Task List — ${facility}`}
        badge="Nursing"
        subtitle={`Pending verifications & administrations · ${facility}`}
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
            <div className="grid place-items-center py-20 text-slate-400">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          ) : tasks.length === 0 ? (
            <div className="grid place-items-center py-20 text-center">
              <div className="text-2xl">🎉</div>
              <div className="mt-2 text-sm font-semibold text-slate-800">
                All caught up! No pending clinical tasks.
              </div>
            </div>
          ) : (
            <table className="w-full text-xs">
              <thead className="bg-slate-50 text-[10px] uppercase tracking-wider text-slate-600">
                <tr className="border-b border-slate-200">
                  <th className="px-3 py-2 text-left font-semibold">Patient Name</th>
                  <th className="px-3 py-2 text-left font-semibold">MRN</th>
                  <th className="px-3 py-2 text-left font-semibold">Medication</th>
                  <th className="px-3 py-2 text-left font-semibold">Dose</th>
                  <th className="px-3 py-2 text-left font-semibold">Route</th>
                  <th className="px-3 py-2 text-left font-semibold">Status</th>
                  <th className="px-3 py-2 text-right font-semibold">Action</th>
                </tr>
              </thead>
              <tbody>
                {tasks.map((t) => {
                  const pending = t.status === "Pending Verification";
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
                        <span
                          className={
                            pending
                              ? "inline-flex rounded-sm bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-amber-800 ring-1 ring-amber-300"
                              : "inline-flex rounded-sm bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-emerald-800 ring-1 ring-emerald-300"
                          }
                        >
                          {t.status}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-right">
                        {pending ? (
                          <button
                            disabled={busyId === t.id}
                            onClick={() => verify(t)}
                            className="inline-flex items-center gap-1 rounded-sm bg-amber-400 px-2.5 py-1 text-[11px] font-semibold text-slate-900 hover:bg-amber-300 disabled:opacity-50"
                          >
                            <ShieldCheck className="h-3 w-3" /> Verify Order
                          </button>
                        ) : (
                          <button
                            disabled={busyId === t.id}
                            onClick={() => administer(t)}
                            className="inline-flex items-center gap-1 rounded-sm bg-emerald-600 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-emerald-500 disabled:opacity-50"
                          >
                            <CheckCircle2 className="h-3 w-3" /> Administer
                          </button>
                        )}
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