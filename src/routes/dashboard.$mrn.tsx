import { createFileRoute, Link, useParams } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import {
  ArrowLeft, Loader2, AlertTriangle, Pill, FlaskConical, FileText,
  Stethoscope, ClipboardList, Plus, User, Clock, Activity,
} from "lucide-react";
import { toast } from "sonner";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";

export const Route = createFileRoute("/dashboard/$mrn")({
  component: PatientChartDashboard,
});

type Patient = Record<string, any>;

function fmtDateTime(v?: string | null) {
  if (!v) return "—";
  try { return new Date(v).toLocaleString(); } catch { return v; }
}

function PatientChartDashboard() {
  const { mrn } = useParams({ from: "/dashboard/$mrn" });
  const [loading, setLoading] = useState(true);
  const [patient, setPatient] = useState<Patient | null>(null);
  const [allergies, setAllergies] = useState<any[]>([]);
  const [meds, setMeds] = useState<any[]>([]);
  const [labs, setLabs] = useState<any[]>([]);
  const [notes, setNotes] = useState<any[]>([]);
  const [newNote, setNewNote] = useState("");
  const [savingNote, setSavingNote] = useState(false);

  const fetchAll = async () => {
    const [p, a, m, l, n] = await Promise.all([
      supabase.from("patients").select("*").eq("mrn", mrn).maybeSingle(),
      supabase.from("allergies").select("*").eq("mrn", mrn).order("logged_at", { ascending: false }),
      supabase.from("medication_orders").select("*").or(`mrn.eq.${mrn},patient_mrn.eq.${mrn}`).order("created_at", { ascending: false }),
      supabase.from("lab_results").select("*").eq("mrn", mrn).order("time_drawn", { ascending: false }),
      supabase.from("clinical_notes").select("*").eq("mrn", mrn).order("created_at", { ascending: false }),
    ]);
    setPatient(p.data);
    setAllergies(a.data || []);
    setMeds(m.data || []);
    setLabs(l.data || []);
    setNotes(n.data || []);
    setLoading(false);
  };

  useEffect(() => {
    setLoading(true);
    fetchAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mrn]);

  const handleAddNote = async () => {
    if (!newNote.trim()) {
      toast.error("Please enter a note before saving.");
      return;
    }
    setSavingNote(true);
    const { data, error } = await supabase
      .from("clinical_notes")
      .insert({ mrn, note_type: "Progress Note", content: newNote.trim(), author: "Clinician" })
      .select()
      .single();
    setSavingNote(false);
    if (error) { toast.error("Failed to save note", { description: error.message }); return; }
    setNotes((prev) => [data, ...prev]);
    setNewNote("");
    toast.success("Note saved to longitudinal record.");
  };

  if (loading) {
    return (
      <div className="min-h-screen grid place-items-center bg-slate-50">
        <Loader2 className="h-6 w-6 animate-spin text-slate-500" />
      </div>
    );
  }

  if (!patient) {
    return (
      <div className="min-h-screen grid place-items-center bg-slate-50">
        <div className="text-center">
          <AlertTriangle className="mx-auto h-10 w-10 text-amber-500 mb-3" />
          <p className="text-slate-700 font-medium">No patient found for MRN {mrn}</p>
          <Link to="/nursing-board" className="text-sky-600 text-sm underline mt-2 inline-block">
            Back to floor
          </Link>
        </div>
      </div>
    );
  }

  const fullName = [patient.first_name, patient.last_name].filter(Boolean).join(" ") || patient.name || "Unknown";
  const sex = patient.biological_sex || patient.gender_identity || patient.gender || "—";

  return (
    <main className="min-h-screen bg-slate-50 pb-12">
      {/* Header */}
      <header className="sticky top-0 z-20 bg-white border-b border-slate-200 shadow-sm">
        <div className="max-w-[1400px] mx-auto px-6 py-4">
          <Link to="/nursing-board" className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-700 mb-3">
            <ArrowLeft className="h-3.5 w-3.5" /> Back to Patient List
          </Link>
          <div className="flex flex-wrap items-center gap-x-8 gap-y-2">
            <div className="flex items-center gap-3">
              <div className="grid place-items-center h-12 w-12 rounded-full bg-sky-100 text-sky-700">
                <User className="h-6 w-6" />
              </div>
              <div>
                <h1 className="text-xl font-semibold text-slate-900 leading-tight">{fullName}</h1>
                <div className="text-xs text-slate-500 mt-0.5 font-mono">MRN: {patient.mrn}</div>
              </div>
            </div>
            <HeaderStat label="Age" value={patient.age ?? "—"} />
            <HeaderStat label="Sex" value={String(sex).toUpperCase()} />
            <HeaderStat label="Code Status" value={patient.code_status || "Full Code"} tone="emerald" />
            <HeaderStat label="Admitted" value={fmtDateTime(patient.admission_time)} />
            <HeaderStat label="Room" value={patient.room || "—"} />
          </div>
        </div>
      </header>

      <div className="max-w-[1400px] mx-auto px-6 py-6 grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Left: Clinical Status */}
        <div className="space-y-6">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <Stethoscope className="h-4 w-4 text-sky-600" /> Chief Complaint & HPI
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <Field label="Chief Complaint" value={patient.chief_complaint} />
              <div className="grid grid-cols-2 gap-3">
                <Field label="Onset" value={patient.hpi_onset} />
                <Field label="Duration" value={patient.hpi_duration} />
                <Field label="Location" value={patient.hpi_location} />
                <Field label="Character" value={patient.hpi_character} />
                <Field label="Severity" value={patient.hpi_severity} />
                <Field label="Aggravating" value={patient.hpi_aggravating_factors} />
                <Field label="Alleviating" value={patient.hpi_alleviating_factors} />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <ClipboardList className="h-4 w-4 text-sky-600" /> Past Medical / Surgical History
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <Field label="Past Medical History" value={patient.past_medical_history} multiline />
              <Field label="Past Surgical History" value={patient.past_surgical_history} multiline />
              <Field label="Past Hospitalizations" value={patient.past_hospitalizations} multiline />
              <Field label="Family History" value={patient.family_history} multiline />
            </CardContent>
          </Card>
        </div>

        {/* Right: Active Care */}
        <div className="space-y-6">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <AlertTriangle className="h-4 w-4 text-red-600" /> Allergies
              </CardTitle>
            </CardHeader>
            <CardContent>
              {allergies.length === 0 ? (
                <div className="text-sm text-slate-500 italic">
                  {patient.allergies || "No documented allergies (NKDA)"}
                </div>
              ) : (
                <ul className="space-y-2">
                  {allergies.map((a) => (
                    <li key={a.id} className="flex items-start justify-between border-l-2 border-red-300 pl-3 py-1">
                      <div>
                        <div className="text-sm font-semibold text-slate-900">{a.substance}</div>
                        <div className="text-xs text-slate-600">Reaction: {a.reaction || "—"}</div>
                      </div>
                      <span className={`text-[10px] uppercase font-bold px-2 py-0.5 rounded ${
                        a.severity === "Severe" ? "bg-red-100 text-red-700" :
                        a.severity === "Moderate" ? "bg-amber-100 text-amber-700" :
                        "bg-slate-100 text-slate-600"
                      }`}>{a.severity || "—"}</span>
                    </li>
                  ))}
                </ul>
              )}
              {patient.environmental_allergies && (
                <div className="mt-3 text-xs text-slate-600">
                  <span className="font-semibold">Environmental:</span> {patient.environmental_allergies}
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <Pill className="h-4 w-4 text-emerald-600" /> Medication Orders
              </CardTitle>
            </CardHeader>
            <CardContent>
              {meds.length === 0 ? (
                <div className="text-sm text-slate-500 italic">No active medication orders</div>
              ) : (
                <ul className="divide-y divide-slate-100">
                  {meds.map((m) => {
                    const name = m.medication_name || m.drug_name || m.drug || m.medication || m.name || "Medication";
                    return (
                      <li key={m.id} className="py-2 flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="text-sm font-semibold text-slate-900">{name}</div>
                          <div className="text-xs text-slate-600">
                            {[m.dose, m.route, m.frequency].filter(Boolean).join(" · ") || "—"}
                          </div>
                          {m.ordering_physician && (
                            <div className="text-[11px] text-slate-500 mt-0.5">Ordered by {m.ordering_physician}</div>
                          )}
                        </div>
                        <span className={`text-[10px] uppercase font-bold px-2 py-0.5 rounded shrink-0 ${
                          m.status === "Administered" ? "bg-emerald-100 text-emerald-700" :
                          m.status === "Approved" ? "bg-sky-100 text-sky-700" :
                          "bg-amber-100 text-amber-700"
                        }`}>{m.status || "Pending"}</span>
                      </li>
                    );
                  })}
                </ul>
              )}
              {patient.current_medications && meds.length === 0 && (
                <div className="mt-2 text-xs text-slate-600 whitespace-pre-wrap">
                  <span className="font-semibold">Home meds:</span> {patient.current_medications}
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Bottom: Longitudinal Record */}
        <div className="lg:col-span-2">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <Activity className="h-4 w-4 text-indigo-600" /> Longitudinal Record
              </CardTitle>
            </CardHeader>
            <CardContent>
              <Tabs defaultValue="labs">
                <TabsList>
                  <TabsTrigger value="labs">
                    <FlaskConical className="h-3.5 w-3.5 mr-1.5" /> Lab Results ({labs.length})
                  </TabsTrigger>
                  <TabsTrigger value="notes">
                    <FileText className="h-3.5 w-3.5 mr-1.5" /> Clinical Notes ({notes.length})
                  </TabsTrigger>
                </TabsList>

                <TabsContent value="labs" className="mt-4">
                  {labs.length === 0 ? (
                    <div className="text-sm text-slate-500 italic py-6 text-center">No lab results on file.</div>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead className="bg-slate-50 text-[11px] uppercase tracking-wider text-slate-500">
                          <tr>
                            <th className="text-left px-3 py-2">Panel</th>
                            <th className="text-left px-3 py-2">Test</th>
                            <th className="text-left px-3 py-2">Result</th>
                            <th className="text-left px-3 py-2">Range</th>
                            <th className="text-left px-3 py-2">Flag</th>
                            <th className="text-left px-3 py-2">Drawn</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {labs.map((l) => (
                            <tr key={l.id}>
                              <td className="px-3 py-2 text-slate-700">{l.panel_name || "—"}</td>
                              <td className="px-3 py-2 font-medium text-slate-900">{l.test_name}</td>
                              <td className="px-3 py-2 font-mono">{l.result_value} {l.unit}</td>
                              <td className="px-3 py-2 text-slate-500 text-xs">{l.reference_range || "—"}</td>
                              <td className="px-3 py-2">
                                {l.flag && l.flag !== "Normal" ? (
                                  <span className={`text-[10px] font-bold uppercase px-1.5 py-0.5 rounded ${
                                    l.flag === "Critical" || l.flag === "High" ? "bg-red-100 text-red-700" :
                                    l.flag === "Low" ? "bg-amber-100 text-amber-700" :
                                    "bg-slate-100 text-slate-600"
                                  }`}>{l.flag}</span>
                                ) : <span className="text-xs text-emerald-600">Normal</span>}
                              </td>
                              <td className="px-3 py-2 text-xs text-slate-500">{fmtDateTime(l.time_drawn)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </TabsContent>

                <TabsContent value="notes" className="mt-4 space-y-4">
                  <div className="border border-slate-200 rounded-lg p-3 bg-slate-50">
                    <Textarea
                      placeholder="Enter a new clinical note… (AI Discharge Summary generation will be wired in here)"
                      value={newNote}
                      onChange={(e) => setNewNote(e.target.value)}
                      className="bg-white"
                      rows={3}
                    />
                    <div className="flex justify-end mt-2">
                      <Button size="sm" onClick={handleAddNote} disabled={savingNote}>
                        {savingNote ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
                        Add Note
                      </Button>
                    </div>
                  </div>

                  {notes.length === 0 ? (
                    <div className="text-sm text-slate-500 italic py-6 text-center">No clinical notes yet.</div>
                  ) : (
                    <ul className="space-y-3">
                      {notes.map((n) => (
                        <li key={n.id} className="border border-slate-200 rounded-lg p-3 bg-white">
                          <div className="flex items-center justify-between mb-1.5">
                            <span className="text-[11px] uppercase tracking-wider font-bold text-indigo-700 bg-indigo-50 px-2 py-0.5 rounded">
                              {n.note_type || "Note"}
                            </span>
                            <span className="text-[11px] text-slate-500 inline-flex items-center gap-1">
                              <Clock className="h-3 w-3" /> {fmtDateTime(n.created_at)}
                            </span>
                          </div>
                          <p className="text-sm text-slate-800 whitespace-pre-wrap">{n.content}</p>
                          {n.author && <p className="text-[11px] text-slate-500 mt-1.5">— {n.author}</p>}
                        </li>
                      ))}
                    </ul>
                  )}
                </TabsContent>
              </Tabs>
            </CardContent>
          </Card>
        </div>
      </div>
    </main>
  );
}

function HeaderStat({ label, value, tone }: { label: string; value: any; tone?: "emerald" }) {
  return (
    <div className="flex flex-col">
      <span className="text-[10px] uppercase tracking-wider text-slate-500">{label}</span>
      <span className={`text-sm font-semibold ${tone === "emerald" ? "text-emerald-700" : "text-slate-900"}`}>
        {String(value)}
      </span>
    </div>
  );
}

function Field({ label, value, multiline }: { label: string; value?: string | null; multiline?: boolean }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold mb-0.5">{label}</div>
      <div className={`text-sm text-slate-800 ${multiline ? "whitespace-pre-wrap" : ""}`}>
        {value || <span className="text-slate-400 italic">Not documented</span>}
      </div>
    </div>
  );
}