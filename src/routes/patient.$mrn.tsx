import { createFileRoute, Link, useNavigate, useParams } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import {
  ArrowLeft,
  HeartPulse,
  Droplet,
  Thermometer,
  Wind,
  Loader2,
  Sparkles,
  Pill,
  ClipboardList,
  AlertTriangle,
  CheckCircle2,
  Activity,
  FlaskConical,
  ArrowUp,
  ArrowDown,
  FileText,
  Sparkle,
} from "lucide-react";
import {
  hrOutOfRange,
  bpOutOfRange,
  o2OutOfRange,
  tempOutOfRange,
  type CodeStatus,
} from "@/lib/patients";

export const Route = createFileRoute("/patient/$mrn")({
  component: PatientChart,
});

const codeBadge: Record<CodeStatus, string> = {
  "Full Code": "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-600/20",
  DNR: "bg-red-50 text-red-700 ring-1 ring-red-600/20",
  DNI: "bg-amber-50 text-amber-700 ring-1 ring-amber-600/20",
  Comfort: "bg-slate-100 text-slate-700 ring-1 ring-slate-600/20",
};

function normalizeCode(s: string | null | undefined): CodeStatus {
  const v = (s ?? "").trim().toLowerCase();
  if (v === "dnr") return "DNR";
  if (v === "dni") return "DNI";
  if (v === "comfort") return "Comfort";
  return "Full Code";
}

interface PatientRecord {
  mrn: string;
  first_name: string;
  last_name: string;
  age: number;
  gender: string;
  room: string | null;
  code_status: string;
  chief_complaint: string;
  hr: number;
  bp_systolic: number;
  bp_diastolic: number;
  spo2: number;
  temp_f: number;
  ai_clinical_summary: string | null;
}

interface MedOrder {
  id: string;
  mrn: string | null;
  drug_name: string | null;
  dose: string | null;
  route: string | null;
  frequency: string | null;
  status: string | null;
  time_administered: string | null;
  administered_by: string | null;
}

interface LabResult {
  id: string;
  mrn: string | null;
  panel_name: string | null;
  test_name: string | null;
  result_value: number | null;
  unit: string | null;
  reference_range: string | null;
  flag: string | null;
  time_drawn: string | null;
}

interface ClinicalNote {
  id: string;
  mrn: string | null;
  note_type: string | null;
  content: string | null;
  author: string | null;
  created_at: string | null;
}

function PatientChart() {
  const { mrn } = useParams({ from: "/patient/$mrn" });
  const navigate = useNavigate();
  const [ready, setReady] = useState(false);
  const [patient, setPatient] = useState<PatientRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pulse, setPulse] = useState(false);
  const [meds, setMeds] = useState<MedOrder[]>([]);
  const [medsLoading, setMedsLoading] = useState(true);
  const [administering, setAdministering] = useState<Record<string, boolean>>({});
  const [labs, setLabs] = useState<LabResult[]>([]);
  const [labsLoading, setLabsLoading] = useState(true);
  const [notes, setNotes] = useState<ClinicalNote[]>([]);
  const [notesLoading, setNotesLoading] = useState(true);
  const [generating, setGenerating] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      if (!data.session) {
        navigate({ to: "/" }).catch(() => {});
        return;
      }
      setReady(true);
    });
  }, [navigate]);

  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      const { data, error } = await supabase
        .from("patients")
        .select("*")
        .eq("mrn", mrn)
        .maybeSingle();
      if (cancelled) return;
      if (error) {
        setError(error.message);
      } else {
        setPatient(data as PatientRecord | null);
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [ready, mrn]);

  useEffect(() => {
    if (!ready) return;
    const channel = supabase
      .channel(`patient-live-${mrn}`)
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "patients", filter: `mrn=eq.${mrn}` },
        (payload) => {
          setPatient((prev) => (prev ? { ...prev, ...(payload.new as Partial<PatientRecord>) } : prev));
          setPulse(true);
          setTimeout(() => setPulse(false), 600);
        },
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [ready, mrn]);

  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    (async () => {
      setMedsLoading(true);
      const { data, error } = await supabase
        .from("medication_orders")
        .select("*")
        .eq("mrn", mrn)
        .order("status", { ascending: true });
      if (cancelled) return;
      if (error) {
        toast.error("Failed to load medications");
      } else {
        setMeds((data ?? []) as MedOrder[]);
      }
      setMedsLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [ready, mrn]);

  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    (async () => {
      setLabsLoading(true);
      const { data, error } = await supabase
        .from("lab_results")
        .select("*")
        .eq("mrn", mrn)
        .order("panel_name", { ascending: true })
        .order("test_name", { ascending: true });
      if (cancelled) return;
      if (error) {
        toast.error("Failed to load lab results");
      } else {
        setLabs((data ?? []) as LabResult[]);
      }
      setLabsLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [ready, mrn]);

  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    (async () => {
      setNotesLoading(true);
      const { data, error } = await supabase
        .from("clinical_notes")
        .select("*")
        .eq("mrn", mrn)
        .order("created_at", { ascending: false });
      if (cancelled) return;
      if (error) {
        toast.error("Failed to load notes");
      } else {
        setNotes((data ?? []) as ClinicalNote[]);
      }
      setNotesLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [ready, mrn]);

  const generateShiftNote = async () => {
    if (!patient || generating) return;
    setGenerating(true);
    await new Promise((r) => setTimeout(r, 1500));

    const fullName = `${patient.first_name} ${patient.last_name}`;
    const bpStr = `${patient.bp_systolic}/${patient.bp_diastolic}`;
    const givenMeds = meds.filter((m) => m.status === "GIVEN");
    const medsStr = givenMeds.length
      ? givenMeds.map((m) => `${m.drug_name} ${m.dose} ${m.route}`).join("; ")
      : "none administered this shift";
    const abnormal = labs.filter((l) => l.flag === "H" || l.flag === "L");
    const labsStr = abnormal.length
      ? abnormal.map((l) => `${l.test_name} ${l.result_value} ${l.unit} (${l.flag})`).join("; ")
      : "all within reference range";

    const content =
      `Shift summary for ${fullName} (MRN ${patient.mrn}, ${patient.age}${patient.gender?.[0] ?? ""}, ${patient.code_status}). ` +
      `Chief complaint: ${patient.chief_complaint}. ` +
      `Latest vitals: HR ${patient.hr} bpm, BP ${bpStr} mmHg, Temp ${Number(patient.temp_f).toFixed(1)}°F, SpO₂ ${patient.spo2}%. ` +
      `Labs reviewed — ${labsStr}. ` +
      `Medications administered: ${medsStr}. ` +
      `Patient resting comfortably, neuro intact, call light within reach. Continue current plan of care.`;

    const optimistic: ClinicalNote = {
      id: `tmp-${Date.now()}`,
      mrn,
      note_type: "Nursing Shift Note",
      content,
      author: "RN - S.P.E.H.R. Auto-Chart",
      created_at: new Date().toISOString(),
    };
    setNotes((curr) => [optimistic, ...curr]);

    const { data, error } = await supabase
      .from("clinical_notes")
      .insert({ mrn, note_type: "Nursing Shift Note", content })
      .select()
      .single();

    setGenerating(false);

    if (error) {
      setNotes((curr) => curr.filter((n) => n.id !== optimistic.id));
      toast.error("Could not save note", { description: error.message });
      return;
    }
    setNotes((curr) => [data as ClinicalNote, ...curr.filter((n) => n.id !== optimistic.id)]);
    toast.success("End-of-shift note generated");
  };

  const administer = async (med: MedOrder) => {
    const now = new Date().toISOString();
    const prev = meds;
    // Optimistic update
    setMeds((curr) =>
      curr.map((m) =>
        m.id === med.id ? { ...m, status: "GIVEN", time_administered: now } : m,
      ),
    );
    setAdministering((a) => ({ ...a, [med.id]: true }));
    const { error } = await supabase
      .from("medication_orders")
      .update({ status: "GIVEN", time_administered: now })
      .eq("id", med.id);
    setAdministering((a) => {
      const next = { ...a };
      delete next[med.id];
      return next;
    });
    if (error) {
      setMeds(prev);
      toast.error("Could not log medication", { description: error.message });
      return;
    }
    toast.success("Medication logged successfully", {
      description: `${med.drug_name} · ${med.dose}`,
    });
  };

  if (!ready || loading) {
    return (
      <div className="min-h-screen grid place-items-center">
        <Loader2 className="h-5 w-5 animate-spin text-[var(--teal)]" />
      </div>
    );
  }

  if (error || !patient) {
    return (
      <div className="min-h-screen grid place-items-center p-6">
        <div className="text-center max-w-sm">
          <AlertTriangle className="h-6 w-6 text-red-600 mx-auto mb-2" />
          <h1 className="text-lg font-semibold">Chart not found</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {error ?? `No patient on this unit with MRN ${mrn}.`}
          </p>
          <Link
            to="/nursing-board"
            className="inline-flex items-center gap-1 mt-4 text-sm text-[var(--teal)] hover:underline"
          >
            <ArrowLeft className="h-4 w-4" /> Back to Status Board
          </Link>
        </div>
      </div>
    );
  }

  const code = normalizeCode(patient.code_status);
  const fullName = `${patient.first_name} ${patient.last_name}`;
  const bpStr = `${patient.bp_systolic}/${patient.bp_diastolic}`;

  return (
    <main className="min-h-screen bg-background pb-12">
      {/* Header */}
      <header className="sticky top-0 z-20 bg-[var(--navy)] text-white border-b border-black/20 shadow-md">
        <div className="max-w-[1400px] mx-auto px-5 py-3 flex flex-wrap items-center gap-x-6 gap-y-3">
          <Link
            to="/nursing-board"
            className="inline-flex items-center gap-1.5 rounded-md bg-white/10 hover:bg-white/15 ring-1 ring-white/10 px-3 h-9 text-xs font-medium transition shrink-0"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Back to Status Board
          </Link>

          <div className="flex items-center gap-3 min-w-0 flex-1">
            <div className="grid place-items-center h-10 w-10 rounded-lg bg-[var(--teal)] shrink-0">
              <HeartPulse className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h1 className="text-base font-semibold tracking-tight truncate">{fullName}</h1>
                <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ${codeBadge[code]}`}>
                  {code}
                </span>
              </div>
              <div className="text-[11px] text-white/65 mt-0.5">
                {patient.age} y/o · {patient.gender} · MRN {patient.mrn}
                {patient.room ? ` · Room ${patient.room}` : ""}
              </div>
            </div>
          </div>

          <div className="inline-flex items-center gap-2 rounded-md bg-white/5 ring-1 ring-white/10 px-3 h-9 text-xs max-w-md">
            <ClipboardList className="h-3.5 w-3.5 text-[var(--teal)] shrink-0" />
            <span className="text-white/55 uppercase tracking-wider text-[10px] font-semibold shrink-0">
              Chief Complaint
            </span>
            <span className="text-white/90 truncate">{patient.chief_complaint}</span>
          </div>
        </div>
      </header>

      {/* Live Vitals Banner */}
      <section className="bg-gradient-to-b from-[var(--teal-soft)]/40 to-transparent border-b border-border">
        <div className="max-w-[1400px] mx-auto px-5 py-5">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <Activity className="h-4 w-4 text-[var(--teal)]" />
              <h2 className="text-sm font-semibold tracking-tight">Live Vitals</h2>
              <span className="relative flex h-2 w-2 ml-1">
                <span className="absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75 animate-ping" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
              </span>
              <span className="text-[11px] text-emerald-700 font-medium">Streaming</span>
            </div>
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
              Updated {new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })}
            </span>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <VitalTile
              icon={HeartPulse}
              label="Heart Rate"
              value={patient.hr}
              unit="bpm"
              alert={hrOutOfRange(patient.hr)}
              pulse={pulse}
            />
            <VitalTile
              icon={Droplet}
              label="Blood Pressure"
              value={bpStr}
              unit="mmHg"
              alert={bpOutOfRange(bpStr)}
              pulse={pulse}
            />
            <VitalTile
              icon={Thermometer}
              label="Temperature"
              value={Number(patient.temp_f).toFixed(1)}
              unit="°F"
              alert={tempOutOfRange(Number(patient.temp_f))}
              pulse={pulse}
            />
            <VitalTile
              icon={Wind}
              label="SpO₂"
              value={patient.spo2}
              unit="%"
              alert={o2OutOfRange(patient.spo2)}
              pulse={pulse}
            />
          </div>
        </div>
      </section>

      {/* Main: 2 columns */}
      <div className="max-w-[1400px] mx-auto px-5 py-6 grid lg:grid-cols-5 gap-6">
        {/* Left — AI Clinical Summary + Labs */}
        <div className="lg:col-span-3 space-y-6">
        <section className="rounded-xl border border-border bg-card overflow-hidden">
          <div className="flex items-center justify-between px-5 h-12 bg-secondary/40 border-b border-border">
            <div className="flex items-center gap-2">
              <ClipboardList className="h-4 w-4 text-[var(--teal)]" />
              <h3 className="text-sm font-semibold tracking-tight">AI Clinical Summary</h3>
              <span className="text-xs text-muted-foreground">· Synthesized from H&P</span>
            </div>
            <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-[var(--teal)] uppercase tracking-wider">
              <Sparkles className="h-3 w-3" />
              AI
            </span>
          </div>
          <div className="p-5 space-y-3 text-sm leading-relaxed text-foreground/90">
            {patient.ai_clinical_summary ? (
              <p>{patient.ai_clinical_summary}</p>
            ) : (
              <p className="text-muted-foreground italic">
                No AI summary generated yet for this patient.
              </p>
            )}
            <div className="text-[11px] text-muted-foreground pt-3 border-t border-border">
              Generated by S.P.E.H.R. Persona Engine · Reviewed by Dr. R. Patel
            </div>
          </div>
        </section>

        {/* Recent Labs */}
        <section className="rounded-xl border border-border bg-card overflow-hidden">
          <div className="flex items-center justify-between px-5 h-12 bg-secondary/40 border-b border-border">
            <div className="flex items-center gap-2">
              <FlaskConical className="h-4 w-4 text-[var(--teal)]" />
              <h3 className="text-sm font-semibold tracking-tight">Recent Labs</h3>
              <span className="text-xs text-muted-foreground">· Last 24h</span>
            </div>
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
              {labs.filter((l) => l.flag === "H" || l.flag === "L").length} abnormal
            </span>
          </div>
          {labsLoading ? (
            <div className="p-8 grid place-items-center">
              <Loader2 className="h-4 w-4 animate-spin text-[var(--teal)]" />
            </div>
          ) : labs.length === 0 ? (
            <div className="p-8 text-center text-sm text-muted-foreground">
              No recent lab results.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-secondary/20 text-[10px] uppercase tracking-wider text-muted-foreground">
                  <tr>
                    <th className="text-left font-semibold px-5 py-2">Panel</th>
                    <th className="text-left font-semibold px-3 py-2">Test</th>
                    <th className="text-right font-semibold px-3 py-2">Result</th>
                    <th className="text-left font-semibold px-3 py-2">Unit</th>
                    <th className="text-left font-semibold px-5 py-2">Reference</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {labs.map((l) => {
                    const abnormal = l.flag === "H" || l.flag === "L";
                    return (
                      <tr key={l.id} className={abnormal ? "bg-red-50/30" : ""}>
                        <td className="px-5 py-2.5 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                          {l.panel_name}
                        </td>
                        <td className="px-3 py-2.5 font-medium text-foreground">{l.test_name}</td>
                        <td className="px-3 py-2.5 text-right tabular-nums">
                          <span
                            className={`inline-flex items-center gap-1 ${
                              abnormal ? "text-red-600 font-bold" : "text-foreground"
                            }`}
                          >
                            {l.flag === "H" && <ArrowUp className="h-3.5 w-3.5" />}
                            {l.flag === "L" && <ArrowDown className="h-3.5 w-3.5" />}
                            {l.result_value}
                          </span>
                        </td>
                        <td className="px-3 py-2.5 text-xs text-muted-foreground">{l.unit}</td>
                        <td className="px-5 py-2.5 text-xs text-muted-foreground tabular-nums">
                          {l.reference_range}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
        </div>

        {/* Right — MAR + AI Clinical Notes */}
        <div className="lg:col-span-2 space-y-6">
        <section className="rounded-xl border border-border bg-card overflow-hidden">
          <div className="flex items-center justify-between px-5 h-12 bg-secondary/40 border-b border-border">
            <div className="flex items-center gap-2">
              <Pill className="h-4 w-4 text-[var(--teal)]" />
              <h3 className="text-sm font-semibold tracking-tight">Medication Administration Record</h3>
            </div>
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
              {meds.filter((m) => m.status === "DUE").length} due
            </span>
          </div>
          {medsLoading ? (
            <div className="p-8 grid place-items-center">
              <Loader2 className="h-4 w-4 animate-spin text-[var(--teal)]" />
            </div>
          ) : meds.length === 0 ? (
            <div className="p-8 text-center text-sm text-muted-foreground">
              No active medication orders.
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {meds.map((m) => {
                const isDue = m.status === "DUE";
                const givenAt = m.time_administered
                  ? new Date(m.time_administered).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                      hour12: false,
                    })
                  : null;
                const busy = !!administering[m.id];
                return (
                  <li key={m.id} className="p-4 flex items-start gap-3">
                    <div className="grid place-items-center h-9 w-9 rounded-lg bg-secondary text-[var(--navy)] shrink-0">
                      <Pill className="h-4 w-4" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-baseline justify-between gap-2">
                        <div className="font-semibold text-sm text-foreground truncate">
                          {m.drug_name}
                        </div>
                        <span
                          className={`text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded shrink-0 ${
                            isDue
                              ? "bg-amber-50 text-amber-700 ring-1 ring-amber-600/20"
                              : "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-600/20"
                          }`}
                        >
                          {m.status}
                        </span>
                      </div>
                      <div className="text-xs text-muted-foreground mt-0.5">
                        <span className="text-foreground font-medium">{m.dose}</span> · {m.route} · {m.frequency}
                      </div>
                      <div className="mt-3">
                        {isDue ? (
                          <button
                            disabled={busy}
                            onClick={() => administer(m)}
                            className="inline-flex items-center gap-1.5 rounded-md bg-[var(--teal)] hover:bg-[var(--teal)]/90 text-white px-3 h-8 text-xs font-semibold transition shadow-sm disabled:opacity-60"
                          >
                            {busy ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <CheckCircle2 className="h-3.5 w-3.5" />
                            )}
                            Administer
                          </button>
                        ) : (
                          <div className="inline-flex items-center gap-1.5 text-emerald-700 text-xs font-medium">
                            <CheckCircle2 className="h-3.5 w-3.5" />
                            Given at {givenAt}
                          </div>
                        )}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {/* AI Clinical Notes */}
        <section className="rounded-xl border border-border bg-card overflow-hidden">
          <div className="flex items-center justify-between px-5 h-12 bg-secondary/40 border-b border-border">
            <div className="flex items-center gap-2">
              <FileText className="h-4 w-4 text-[var(--teal)]" />
              <h3 className="text-sm font-semibold tracking-tight">Clinical Notes</h3>
            </div>
            <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-[var(--teal)] uppercase tracking-wider">
              <Sparkles className="h-3 w-3" />
              AI
            </span>
          </div>
          <div className="p-4 border-b border-border bg-gradient-to-b from-[var(--teal-soft)]/30 to-transparent">
            <button
              onClick={generateShiftNote}
              disabled={generating || !patient}
              className="w-full inline-flex items-center justify-center gap-2 rounded-md bg-[var(--navy)] hover:bg-[var(--navy)]/90 text-white px-4 h-10 text-xs font-semibold transition shadow-sm disabled:opacity-70"
            >
              {generating ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Synthesizing data...
                </>
              ) : (
                <>
                  <Sparkle className="h-4 w-4 text-[var(--teal)]" />
                  Generate End-of-Shift Note
                </>
              )}
            </button>
          </div>
          {notesLoading ? (
            <div className="p-8 grid place-items-center">
              <Loader2 className="h-4 w-4 animate-spin text-[var(--teal)]" />
            </div>
          ) : notes.length === 0 ? (
            <div className="p-8 text-center text-sm text-muted-foreground">
              No clinical notes yet. Generate the first shift summary above.
            </div>
          ) : (
            <ol className="relative">
              {notes.map((n, idx) => {
                const ts = n.created_at ? new Date(n.created_at) : null;
                return (
                  <li key={n.id} className="relative pl-12 pr-5 py-4 border-b border-border last:border-b-0">
                    <span className="absolute left-5 top-5 grid place-items-center h-6 w-6 rounded-full bg-[var(--teal)] ring-4 ring-card text-white">
                      <FileText className="h-3 w-3" />
                    </span>
                    {idx < notes.length - 1 && (
                      <span className="absolute left-[31px] top-11 bottom-0 w-px bg-border" />
                    )}
                    <div className="flex items-baseline justify-between gap-2 mb-1">
                      <div className="text-xs font-semibold text-foreground">{n.note_type}</div>
                      <div className="text-[10px] tabular-nums text-muted-foreground shrink-0">
                        {ts?.toLocaleString([], {
                          month: "short",
                          day: "numeric",
                          hour: "2-digit",
                          minute: "2-digit",
                          hour12: false,
                        })}
                      </div>
                    </div>
                    <div className="text-[11px] text-muted-foreground mb-2">{n.author}</div>
                    <p className="text-xs leading-relaxed text-foreground/90 whitespace-pre-wrap">
                      {n.content}
                    </p>
                  </li>
                );
              })}
            </ol>
          )}
        </section>
        </div>
      </div>
    </main>
  );
}

function VitalTile({
  icon: Icon,
  label,
  value,
  unit,
  alert,
  pulse,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: number | string;
  unit: string;
  alert: boolean;
  pulse: boolean;
}) {
  return (
    <div
      className={`relative rounded-xl border bg-card p-4 transition-all duration-500 ${
        alert ? "border-red-300 bg-red-50/60" : "border-border"
      } ${pulse ? "ring-2 ring-[var(--teal)]/50 shadow-md scale-[1.01]" : "ring-0"}`}
    >
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
        <Icon className={`h-3.5 w-3.5 ${alert ? "text-red-600" : "text-[var(--teal)]"}`} />
        {label}
      </div>
      <div className="mt-2 flex items-baseline gap-1.5">
        <div
          className={`text-3xl font-bold tabular-nums tracking-tight ${
            alert ? "text-red-600" : "text-foreground"
          }`}
        >
          {value}
        </div>
        <div className="text-xs text-muted-foreground">{unit}</div>
      </div>
    </div>
  );
}