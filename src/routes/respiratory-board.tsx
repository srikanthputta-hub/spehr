import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { BoardHeader } from "@/components/BoardShell";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { Loader2, Wind, AlertTriangle, Activity } from "lucide-react";
import { useFacility } from "@/lib/facility-context";
import { useMemo } from "react";

export const Route = createFileRoute("/respiratory-board")({
  component: RespiratoryBoard,
});

interface Patient {
  id: string;
  mrn: string | null;
  name: string | null;
  first_name: string | null;
  last_name: string | null;
  room: string | null;
  spo2: number | null;
  rr: number | null;
  diagnosis: string | null;
  facility_name: string | null;
}

const INTERVENTIONS = [
  "Administer Albuterol Nebulizer",
  "Titrate Oxygen Flow",
  "Initiate BiPAP",
];

function displayName(p: Patient) {
  return (
    p.name ||
    [p.first_name, p.last_name].filter(Boolean).join(" ") ||
    p.mrn ||
    "Unknown"
  );
}

function RespiratoryBoard() {
  const { facility } = useFacility();
  const [patients, setPatients] = useState<Patient[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Patient | null>(null);
  const [intervention, setIntervention] = useState<string>("");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    (async () => {
      const { data, error } = await supabase
        .from("patients")
        .select("id,mrn,name,first_name,last_name,room,spo2,rr,diagnosis,facility_name")
        .order("room", { ascending: true });
      if (error) toast.error(`Unable to load patients: ${error.message}`);
      else setPatients((data ?? []) as Patient[]);
      setLoading(false);
    })();
  }, []);

  const visiblePatients = useMemo(
    () => patients.filter((p) => (p.facility_name ?? "Memorial Hospital") === facility),
    [patients, facility],
  );

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selected || !intervention) {
      toast.error("Select an intervention");
      return;
    }
    setSubmitting(true);
    try {
      const content = `RT Intervention: ${intervention}\nSpO2: ${selected.spo2 ?? "—"}%  RR: ${selected.rr ?? "—"}\nAssessment: ${notes || "(none)"}`;
      const { error } = await supabase.from("clinical_notes").insert({
        mrn: selected.mrn,
        note_type: "Respiratory Therapy Treatment",
        content,
        author: "RT - S.P.E.H.R. Pulmonary Command",
      });
      if (error) throw error;
      toast.success(`Respiratory treatment logged for ${displayName(selected)}`);
      setIntervention("");
      setNotes("");
    } catch (err: any) {
      toast.error(err?.message ?? "Failed to log treatment");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="min-h-screen bg-slate-50">
      <BoardHeader
        title="Pulmonary Command Center"
        badge="Respiratory"
        subtitle="Live ventilation & oxygenation monitoring"
      />

      <style>{`
        @keyframes pulseBorder {
          0%, 100% { box-shadow: 0 0 0 0 rgba(220,38,38,0.55); border-color: rgb(220,38,38); }
          50% { box-shadow: 0 0 0 8px rgba(220,38,38,0); border-color: rgb(248,113,113); }
        }
        .hypoxemia-alert { animation: pulseBorder 1.6s ease-in-out infinite; }
      `}</style>

      <section className="grid grid-cols-1 lg:grid-cols-3 gap-6 p-6">
        <div className="lg:col-span-2">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-800 flex items-center gap-2">
              <Wind className="h-4 w-4 text-sky-600" /> Active Floor · Pulmonary Vitals
            </h2>
            <span className="text-xs text-slate-500">{patients.length} patients</span>
          </div>

          {loading ? (
            <div className="grid place-items-center h-48 text-slate-500">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {patients.map((p) => {
                const critical = (p.spo2 ?? 100) < 92;
                const isSelected = selected?.id === p.id;
                return (
                  <button
                    key={p.id}
                    onClick={() => setSelected(p)}
                    className={`text-left rounded-xl border-2 bg-white p-4 transition hover:shadow-md ${
                      critical
                        ? "hypoxemia-alert border-red-500"
                        : isSelected
                          ? "border-sky-500"
                          : "border-slate-200"
                    }`}
                  >
                    <div className="flex items-start justify-between">
                      <div>
                        <div className="text-[10px] uppercase tracking-widest text-slate-500">
                          Room {p.room ?? "—"}
                        </div>
                        <div className="text-base font-semibold text-slate-900">
                          {displayName(p)}
                        </div>
                        <div className="text-xs text-slate-500 mt-0.5">
                          {p.diagnosis ?? "—"}
                        </div>
                      </div>
                      {critical && (
                        <span className="inline-flex items-center gap-1 rounded-md bg-red-600 text-white text-[10px] font-bold px-2 py-1 uppercase tracking-wide">
                          <AlertTriangle className="h-3 w-3" /> Critical Hypoxemia
                        </span>
                      )}
                    </div>

                    <div className="mt-3 grid grid-cols-2 gap-3">
                      <div
                        className={`rounded-lg p-3 ${
                          critical ? "bg-red-50" : "bg-sky-50"
                        }`}
                      >
                        <div className="text-[10px] uppercase tracking-widest text-slate-500">
                          SpO₂
                        </div>
                        <div
                          className={`text-2xl font-bold ${
                            critical ? "text-red-700" : "text-sky-700"
                          }`}
                        >
                          {p.spo2 ?? "—"}
                          <span className="text-sm font-medium">%</span>
                        </div>
                      </div>
                      <div className="rounded-lg p-3 bg-slate-100">
                        <div className="text-[10px] uppercase tracking-widest text-slate-500">
                          Resp Rate
                        </div>
                        <div className="text-2xl font-bold text-slate-800">
                          {p.rr ?? "—"}
                          <span className="text-sm font-medium"> /min</span>
                        </div>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <aside className="lg:col-span-1">
          <div className="sticky top-4 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
            <h3 className="text-sm font-semibold text-slate-900 flex items-center gap-2">
              <Activity className="h-4 w-4 text-sky-600" /> RT Intervention Panel
            </h3>

            {!selected ? (
              <p className="mt-6 text-sm text-slate-500 text-center py-10 border border-dashed border-slate-300 rounded-lg">
                Select a patient from the floor to log a respiratory intervention.
              </p>
            ) : (
              <form onSubmit={handleSubmit} className="mt-4 space-y-4">
                <div className="rounded-md bg-slate-50 p-3">
                  <div className="text-[10px] uppercase tracking-widest text-slate-500">
                    Patient
                  </div>
                  <div className="text-sm font-semibold text-slate-900">
                    {displayName(selected)} · Rm {selected.room ?? "—"}
                  </div>
                  <div className="text-xs text-slate-500 mt-1">
                    SpO₂ {selected.spo2 ?? "—"}% · RR {selected.rr ?? "—"}/min
                  </div>
                </div>

                <div className="space-y-2">
                  <Label>Intervention</Label>
                  <Select value={intervention} onValueChange={setIntervention}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select intervention…" />
                    </SelectTrigger>
                    <SelectContent>
                      {INTERVENTIONS.map((i) => (
                        <SelectItem key={i} value={i}>
                          {i}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label>Clinical Assessment Notes</Label>
                  <Textarea
                    rows={5}
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    placeholder="Breath sounds, work of breathing, response to treatment…"
                  />
                </div>

                <Button
                  type="submit"
                  disabled={submitting}
                  className="w-full bg-sky-700 hover:bg-sky-800"
                >
                  {submitting ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" /> Logging…
                    </>
                  ) : (
                    "Log Respiratory Treatment"
                  )}
                </Button>
              </form>
            )}
          </div>
        </aside>
      </section>
    </main>
  );
}