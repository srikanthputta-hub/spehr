import { createFileRoute, Link, useNavigate, useParams } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import {
  ArrowLeft,
  HeartPulse,
  Activity,
  Thermometer,
  Wind,
  Droplet,
  AlertOctagon,
  Sparkles,
  Pill,
  CheckCircle2,
  TrendingUp,
  TrendingDown,
  Minus,
  Loader2,
  ClipboardList,
} from "lucide-react";
import { ChevronDown, ChevronUp, FileSignature, Clock, User } from "lucide-react";
import { FlaskConical } from "lucide-react";
import { toast } from "sonner";
import { useActiveNurse, useFacility } from "@/lib/facility-context";
import {
  getPatient,
  hrOutOfRange,
  bpOutOfRange,
  o2OutOfRange,
  tempOutOfRange,
  type CodeStatus,
  type MedOrder,
  type Patient,
} from "@/lib/patients";

export const Route = createFileRoute("/chart/$mrn")({
  component: ChartPage,
});

function buildFallbackPatient(mrn: string, db: any): Patient {
  const name =
    db?.name ||
    [db?.first_name, db?.last_name].filter(Boolean).join(" ") ||
    `Patient ${mrn}`;
  const bp =
    db?.bp ||
    (db?.bp_systolic && db?.bp_diastolic
      ? `${db.bp_systolic}/${db.bp_diastolic}`
      : "120/80");
  const code: CodeStatus =
    (["Full Code", "DNR", "DNI", "Comfort"] as CodeStatus[]).includes(db?.code_status)
      ? (db.code_status as CodeStatus)
      : "Full Code";
  const hr = db?.hr ?? 80;
  const temp = Number(db?.temp ?? 98.6);
  const o2 = db?.spo2 ?? 98;
  const sys = db?.bp_systolic ?? Number(String(bp).split("/")[0]) ?? 120;
  return {
    room: db?.room || "—",
    name,
    age: db?.age ?? 0,
    sex: (db?.gender?.[0]?.toUpperCase() === "F" ? "F" : "M") as "M" | "F",
    mrn,
    dob: "—",
    code,
    allergies: ["No known allergies"],
    diagnosis: db?.diagnosis || db?.chief_complaint || "Acute monitoring",
    hr,
    hrTrend: [hr, hr, hr, hr, hr, hr, hr],
    bp,
    bpTrend: [sys, sys, sys, sys, sys, sys, sys],
    temp,
    tempTrend: [temp, temp, temp, temp, temp, temp, temp],
    o2,
    o2Trend: [o2, o2, o2, o2, o2, o2, o2],
    task: "Routine monitoring",
    admitNote:
      "Patient admitted for acute monitoring and dynamic clinical evaluation under the current unit protocol.",
    meds: [],
  };
}

const codeBadge: Record<CodeStatus, string> = {
  "Full Code": "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-600/20",
  DNR: "bg-red-50 text-red-700 ring-1 ring-red-600/20",
  DNI: "bg-amber-50 text-amber-700 ring-1 ring-amber-600/20",
  Comfort: "bg-slate-100 text-slate-700 ring-1 ring-slate-600/20",
};

function ChartPage() {
  const { mrn } = useParams({ from: "/chart/$mrn" });
  const navigate = useNavigate();
  const nurse = useActiveNurse();
  const { facility } = useFacility();
  const [ready, setReady] = useState(false);
  const [given, setGiven] = useState<Record<string, string>>({});
  const [dbPatient, setDbPatient] = useState<any>(null);
  const [lookupDone, setLookupDone] = useState(false);
  const [administering, setAdministering] = useState<string | null>(null);
  const [shiftNotes, setShiftNotes] = useState<any[]>([]);
  const [noteText, setNoteText] = useState("");
  const [sbarOpen, setSbarOpen] = useState(false);
  const [sbar, setSbar] = useState({ s: "", b: "", a: "", r: "" });
  const [savingNote, setSavingNote] = useState(false);
  const [labTest, setLabTest] = useState<string>("CBC Pack");
  const [orderingLab, setOrderingLab] = useState(false);
  const [activeTab, setActiveTab] = useState<"clinical" | "labs">("clinical");
  const [completedLabs, setCompletedLabs] = useState<any[]>([]);
  const [draftId, setDraftId] = useState<string | null>(null);
  const [lockedNote, setLockedNote] = useState<any | null>(null);
  const [draftSavedAt, setDraftSavedAt] = useState<string | null>(null);
  const [esignOpen, setEsignOpen] = useState(false);
  const [pin, setPin] = useState("");
  const [pinError, setPinError] = useState(false);
  const [shake, setShake] = useState(false);
  const [esigning, setEsigning] = useState(false);
  const isLocked = !!lockedNote;

  useEffect(() => {
    // Auth gate disabled — chart renders using mock demo session.
    setReady(true);
  }, [navigate]);

  const staticPatient = getPatient(mrn);

  useEffect(() => {
    if (staticPatient) {
      setLookupDone(true);
      return;
    }
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from("patients")
        .select("*")
        .eq("mrn", mrn)
        .maybeSingle();
      if (!cancelled) {
        setDbPatient(data);
        setLookupDone(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [mrn, staticPatient]);

  const patient = staticPatient ?? buildFallbackPatient(mrn, dbPatient);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from("shift_notes")
        .select("*")
        .eq("patient_mrn", mrn)
        .order("created_at", { ascending: false });
      if (!cancelled && data) setShiftNotes(data);
      if (!cancelled && data) {
        const signed = data.find((n: any) => n.status === "E-Signed");
        if (signed) {
          setLockedNote(signed);
        } else {
          const draft = data.find((n: any) => n.status === "Draft");
          if (draft) {
            setDraftId(draft.id);
            setNoteText(draft.note_text === "(SBAR handoff — see structured fields)" ? "" : (draft.note_text || ""));
            setSbar({
              s: draft.sbar_situation || "",
              b: draft.sbar_background || "",
              a: draft.sbar_assessment || "",
              r: draft.sbar_recommendation || "",
            });
            if (draft.sbar_situation || draft.sbar_background || draft.sbar_assessment || draft.sbar_recommendation) {
              setSbarOpen(true);
            }
          }
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [mrn]);

  // Clear unread labs alert when nurse opens the chart
  useEffect(() => {
    (async () => {
      await supabase
        .from("patients")
        .update({ unread_labs_alert: false })
        .eq("mrn", mrn);
    })();
  }, [mrn]);

  // Fetch completed historical lab reports for this patient
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from("lab_orders")
        .select("*")
        .eq("patient_mrn", mrn)
        .eq("status", "Completed")
        .order("created_at", { ascending: false });
      if (!cancelled && data) setCompletedLabs(data);
    })();
    return () => {
      cancelled = true;
    };
  }, [mrn, activeTab]);

  // Re-clear alert when clinician opens the Lab Reports tab
  useEffect(() => {
    if (activeTab !== "labs") return;
    (async () => {
      await supabase
        .from("patients")
        .update({ unread_labs_alert: false })
        .eq("mrn", mrn);
    })();
  }, [activeTab, mrn]);

  // Ensure there's always at least one med to administer (mock fallback)
  const medsList: MedOrder[] =
    patient.meds.length > 0
      ? patient.meds
      : [
          {
            id: "mock-1",
            name: "Furosemide (Lasix)",
            dose: "40 mg",
            route: "PO",
            freq: "Q12H",
            due: "Now",
          },
        ];

  if (!ready) {
    return (
      <div className="min-h-screen grid place-items-center">
        <Loader2 className="h-5 w-5 animate-spin text-[var(--teal)]" />
      </div>
    );
  }

  if (!staticPatient && !lookupDone) {
    return (
      <div className="min-h-screen grid place-items-center">
        <Loader2 className="h-5 w-5 animate-spin text-[var(--teal)]" />
      </div>
    );
  }

  const handleAdminister = async (med: MedOrder) => {
    setAdministering(med.id);
    try {
      const { error: logErr } = await supabase.from("mar_logs").insert({
        mrn: patient.mrn,
        medication_name: `${med.name} ${med.dose} ${med.route}`,
        administered_by: nurse.name,
        given_by: nurse.name,
      });
      if (logErr) throw logErr;

      // Decrement meds_due_count on the patient (clamped at 0)
      const { data: cur } = await supabase
        .from("patients")
        .select("meds_due_count")
        .eq("mrn", patient.mrn)
        .maybeSingle();
      const next = Math.max(0, ((cur as any)?.meds_due_count ?? 1) - 1);
      await supabase
        .from("patients")
        .update({ meds_due_count: next })
        .eq("mrn", patient.mrn);

      setGiven((g) => ({
        ...g,
        [med.id]: new Date().toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        }),
      }));
      toast.success("Medication successfully administered and signed off in MAR.");
    } catch (e: any) {
      toast.error("Failed to sign off medication", { description: e?.message });
    } finally {
      setAdministering(null);
    }
  };

  const handleSaveNote = async () => {
    if (!noteText.trim() && !sbar.s && !sbar.b && !sbar.a && !sbar.r) {
      toast.error("Please enter a note before signing.");
      return;
    }
    setSavingNote(true);
    try {
      const payload = {
        patient_mrn: patient.mrn,
        note_text: noteText.trim() || "(SBAR handoff — see structured fields)",
        author_nurse: nurse.name,
        sbar_situation: sbar.s || null,
        sbar_background: sbar.b || null,
        sbar_assessment: sbar.a || null,
        sbar_recommendation: sbar.r || null,
      };
      const { data, error } = await supabase
        .from("shift_notes")
        .insert(payload)
        .select()
        .single();
      if (error) throw error;
      setShiftNotes((prev) => [data, ...prev]);
      setNoteText("");
      setSbar({ s: "", b: "", a: "", r: "" });
      setSbarOpen(false);
      toast.success("Shift note securely committed and stamped to patient electronic health record.");
    } catch (e: any) {
      toast.error("Failed to save note", { description: e?.message });
    } finally {
      setSavingNote(false);
    }
  };

  const handleOrderLab = async () => {
    setOrderingLab(true);
    try {
      const { error } = await supabase.from("lab_orders").insert({
        patient_mrn: patient.mrn,
        patient_name: patient.name,
        requested_by: nurse.name,
        facility_name: facility,
        test_type: labTest,
        clinical_condition: patient.diagnosis,
        status: "Pending Collection",
      });
      if (error) throw error;
      toast.success(`Lab order routed to ${facility} lab queue.`, {
        description: `${labTest} · ${patient.name}`,
      });
    } catch (e: any) {
      toast.error("Failed to submit lab order", { description: e?.message });
    } finally {
      setOrderingLab(false);
    }
  };

  return (
    <main className="min-h-screen bg-background pb-12">
      {/* Patient Banner */}
      <header className="sticky top-0 z-20 bg-[var(--navy)] text-white border-b border-black/20 shadow-md">
        <div className="max-w-[1400px] mx-auto px-5 py-3 flex flex-wrap items-center gap-x-6 gap-y-3">
          <Link
            to="/nursing-board"
            className="inline-flex items-center gap-1.5 rounded-md bg-white/10 hover:bg-white/15 ring-1 ring-white/10 px-3 h-9 text-xs font-medium transition shrink-0"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Back to Floor
          </Link>

          <div className="flex items-center gap-3 min-w-0">
            <div className="grid place-items-center h-10 w-10 rounded-lg bg-[var(--teal)] shrink-0">
              <HeartPulse className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h1 className="text-base font-semibold tracking-tight truncate">
                  {patient.name}
                </h1>
                <span
                  className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ${codeBadge[patient.code]}`}
                >
                  {patient.code}
                </span>
              </div>
              <div className="text-[11px] text-white/65 mt-0.5">
                Room {patient.room} · {patient.age}
                {patient.sex} · DOB {patient.dob} · {patient.mrn}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2 ml-auto">
            <div className="hidden md:flex flex-col items-end text-[11px] leading-tight">
              <span className="text-white/55 uppercase tracking-[0.18em] text-[9px]">Signed In</span>
              <span className="text-white font-medium">RN: {nurse.name.replace(/, RN$/, "")}</span>
              <span className="text-white/60">{nurse.facility} — {nurse.ward}</span>
            </div>
            <div className="inline-flex items-center gap-2 rounded-md bg-red-500/15 ring-1 ring-red-400/40 px-3 h-9 text-xs">
              <AlertOctagon className="h-4 w-4 text-red-300" />
              <span className="font-semibold text-red-200 uppercase tracking-wider text-[10px]">
                Allergies
              </span>
              <span className="font-medium text-red-100">
                {patient.allergies.join(", ")}
              </span>
            </div>
          </div>
        </div>
      </header>

      <div className="max-w-[1400px] mx-auto px-5 py-6 grid lg:grid-cols-5 gap-6">
        {/* LEFT — Clinical Context */}
        <div className="lg:col-span-3 space-y-6">
          {/* View Tabs */}
          <div className="inline-flex items-center gap-1 rounded-lg border border-border bg-card p-1">
            <button
              type="button"
              onClick={() => setActiveTab("clinical")}
              className={`inline-flex items-center gap-1.5 rounded-md px-3 h-8 text-xs font-semibold transition ${
                activeTab === "clinical"
                  ? "bg-[var(--navy)] text-white shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <ClipboardList className="h-3.5 w-3.5" />
              Clinical Workspace
            </button>
            <button
              type="button"
              onClick={() => setActiveTab("labs")}
              className={`inline-flex items-center gap-1.5 rounded-md px-3 h-8 text-xs font-semibold transition ${
                activeTab === "labs"
                  ? "bg-[var(--navy)] text-white shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <span aria-hidden>🧪</span>
              Lab Reports
              {completedLabs.length > 0 && (
                <span className={`ml-1 inline-flex items-center justify-center rounded-full px-1.5 h-4 text-[10px] font-bold tabular-nums ${
                  activeTab === "labs" ? "bg-white/20 text-white" : "bg-[var(--teal-soft)] text-[var(--teal)]"
                }`}>
                  {completedLabs.length}
                </span>
              )}
            </button>
          </div>

          {activeTab === "labs" ? (
            <LabReportsPanel reports={completedLabs} />
          ) : (
          <>
          {/* Live Vitals */}
          <section className="rounded-xl border border-border bg-card overflow-hidden">
            <SectionHeader icon={Activity} title="Live Vitals" subtitle="Streaming · last 7 readings" />
            <div className="grid grid-cols-2 md:grid-cols-4 divide-x divide-border border-t border-border">
              <VitalCard
                icon={HeartPulse}
                label="Heart Rate"
                unit="bpm"
                value={patient.hr}
                trend={patient.hrTrend}
                alert={hrOutOfRange(patient.hr)}
              />
              <VitalCard
                icon={Droplet}
                label="Blood Pressure"
                unit="mmHg"
                value={patient.bp}
                trend={patient.bpTrend}
                alert={bpOutOfRange(patient.bp)}
              />
              <VitalCard
                icon={Thermometer}
                label="Temp"
                unit="°F"
                value={patient.temp}
                trend={patient.tempTrend}
                alert={tempOutOfRange(patient.temp)}
              />
              <VitalCard
                icon={Wind}
                label="SpO₂"
                unit="%"
                value={patient.o2}
                trend={patient.o2Trend}
                alert={o2OutOfRange(patient.o2)}
              />
            </div>
          </section>

          {/* Admitting Note */}
          <section className="rounded-xl border border-border bg-card overflow-hidden">
            <SectionHeader
              icon={ClipboardList}
              title="Admitting H&P — AI Summary"
              subtitle="Generated from Dr. R. Patel's full note"
              right={
                <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-[var(--teal)] uppercase tracking-wider">
                  <Sparkles className="h-3 w-3" />
                  AI
                </span>
              }
            />
            <div className="p-5 space-y-3 text-sm leading-relaxed text-foreground/90">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span className="font-medium text-foreground">Chief Complaint:</span>
                {patient.diagnosis}
              </div>
              <p>{patient.admitNote}</p>
              <div className="text-[11px] text-muted-foreground pt-2 border-t border-border">
                Source: Admission H&P · Reviewed 06:42 · Tap to view full note
              </div>
            </div>
          </section>

          {/* Lab Order */}
          <section className="rounded-xl border border-border bg-card overflow-hidden">
            <SectionHeader
              icon={ClipboardList}
              title="🧪 Order Laboratory Evaluation"
              subtitle={`Routes to ${facility} lab queue`}
            />
            <div className="p-5 flex flex-wrap items-end gap-3">
              <label className="flex-1 min-w-[220px]">
                <span className="block text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">
                  Test Type
                </span>
                <select
                  value={labTest}
                  onChange={(e) => setLabTest(e.target.value)}
                  className="w-full h-10 rounded-md border border-border bg-background px-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--teal)]/40 cursor-pointer"
                >
                  <option>CBC Pack</option>
                  <option>Metabolic Panel CMP</option>
                  <option>Arterial Blood Gas</option>
                  <option>Cardiac Troponin</option>
                  <option>Serum Lactate</option>
                </select>
              </label>
              <button
                type="button"
                onClick={handleOrderLab}
                disabled={orderingLab}
                className="inline-flex items-center gap-1.5 rounded-md bg-[var(--teal)] hover:bg-[var(--teal)]/90 disabled:opacity-60 disabled:cursor-not-allowed text-white px-4 h-10 text-xs font-semibold transition shadow-sm"
              >
                {orderingLab ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <span aria-hidden>🧪</span>
                )}
                {orderingLab ? "Submitting…" : "Submit Lab Request"}
              </button>
            </div>
          </section>

          {/* Shift Handoff & Clinical Documentation */}
          <section className="rounded-xl border border-border bg-card overflow-hidden">
            <SectionHeader
              icon={FileSignature}
              title="📋 Shift Handoff & Clinical Documentation"
              subtitle={`${shiftNotes.length} note${shiftNotes.length === 1 ? "" : "s"} on file`}
            />

            {/* Timeline */}
            <div className="p-5 space-y-3">
              {shiftNotes.length === 0 ? (
                <div className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
                  No shift notes recorded yet. Be the first to document this shift.
                </div>
              ) : (
                <ul className="space-y-3 max-h-80 overflow-y-auto pr-1">
                  {shiftNotes.map((n) => (
                    <li
                      key={n.id}
                      className="rounded-lg border border-border bg-secondary/30 p-3"
                    >
                      <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
                        <span className="inline-flex items-center gap-1 font-medium text-foreground">
                          <User className="h-3 w-3 text-[var(--teal)]" />
                          {n.author_nurse || nurse.name}
                        </span>
                        <span className="inline-flex items-center gap-1 tabular-nums">
                          <Clock className="h-3 w-3" />
                          {n.created_at
                            ? new Date(n.created_at).toLocaleString([], {
                                month: "short",
                                day: "numeric",
                                hour: "2-digit",
                                minute: "2-digit",
                              })
                            : "—"}
                        </span>
                      </div>
                      <p className="mt-2 text-sm text-foreground/90 whitespace-pre-wrap leading-relaxed">
                        {n.note_text}
                      </p>
                      {(n.sbar_situation ||
                        n.sbar_background ||
                        n.sbar_assessment ||
                        n.sbar_recommendation) && (
                        <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-2 text-[11px]">
                          {n.sbar_situation && (
                            <SbarPill label="S" text={n.sbar_situation} />
                          )}
                          {n.sbar_background && (
                            <SbarPill label="B" text={n.sbar_background} />
                          )}
                          {n.sbar_assessment && (
                            <SbarPill label="A" text={n.sbar_assessment} />
                          )}
                          {n.sbar_recommendation && (
                            <SbarPill label="R" text={n.sbar_recommendation} />
                          )}
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* New entry form */}
            <div className="border-t border-border bg-secondary/20 p-5 space-y-3">
              <label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground">
                New Entry
              </label>
              <textarea
                value={noteText}
                onChange={(e) => setNoteText(e.target.value)}
                placeholder="General Nursing Shift Notes..."
                rows={4}
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--teal)]/40 resize-y"
              />

              <button
                type="button"
                onClick={() => setSbarOpen((v) => !v)}
                className="inline-flex items-center gap-1.5 text-xs font-medium text-[var(--teal)] hover:underline"
              >
                {sbarOpen ? (
                  <ChevronUp className="h-3.5 w-3.5" />
                ) : (
                  <ChevronDown className="h-3.5 w-3.5" />
                )}
                SBAR Handoff (optional)
              </button>

              {sbarOpen && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 rounded-lg border border-border bg-background p-3">
                  <SbarInput
                    label="Situation"
                    value={sbar.s}
                    onChange={(v) => setSbar((p) => ({ ...p, s: v }))}
                  />
                  <SbarInput
                    label="Background"
                    value={sbar.b}
                    onChange={(v) => setSbar((p) => ({ ...p, b: v }))}
                  />
                  <SbarInput
                    label="Assessment"
                    value={sbar.a}
                    onChange={(v) => setSbar((p) => ({ ...p, a: v }))}
                  />
                  <SbarInput
                    label="Recommendation"
                    value={sbar.r}
                    onChange={(v) => setSbar((p) => ({ ...p, r: v }))}
                  />
                </div>
              )}

              <div className="flex items-center justify-between pt-1">
                <span className="text-[11px] text-muted-foreground">
                  Signing as <span className="font-medium text-foreground">{nurse.name}</span> · {nurse.facility} — {nurse.ward}
                </span>
                <button
                  onClick={handleSaveNote}
                  disabled={savingNote}
                  className="inline-flex items-center gap-1.5 rounded-md bg-[var(--navy)] hover:bg-[var(--navy)]/90 disabled:opacity-60 disabled:cursor-not-allowed text-white px-4 h-9 text-xs font-semibold transition shadow-sm"
                >
                  {savingNote ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <span aria-hidden>✍️</span>
                  )}
                  {savingNote ? "Saving…" : "Sign & Save Note"}
                </button>
              </div>
            </div>
          </section>
          </>
          )}
        </div>

        {/* RIGHT — MAR */}
        <div className="lg:col-span-2">
          <section className="rounded-xl border border-border bg-card overflow-hidden sticky top-[88px]">
            <SectionHeader
              icon={Pill}
              title="MAR — Due Now"
              subtitle={`${patient.meds.length} active orders`}
              right={
                <span className="inline-flex items-center gap-1.5 rounded-full bg-[var(--teal-soft)] text-[var(--teal)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider">
                  <span className="h-1.5 w-1.5 rounded-full bg-[var(--teal)]" />
                  Live
                </span>
              }
            />
            <ul className="divide-y divide-border">
              {medsList.map((m) => (
                <MedRow
                  key={m.id}
                  med={m}
                  givenAt={given[m.id]}
                  busy={administering === m.id}
                  onAdminister={() => handleAdminister(m)}
                />
              ))}
            </ul>
          </section>
        </div>
      </div>
    </main>
  );
}

function SectionHeader({
  icon: Icon,
  title,
  subtitle,
  right,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  subtitle?: string;
  right?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between px-5 h-12 bg-secondary/40 border-b border-border">
      <div className="flex items-center gap-2 min-w-0">
        <Icon className="h-4 w-4 text-[var(--teal)] shrink-0" />
        <h3 className="text-sm font-semibold tracking-tight">{title}</h3>
        {subtitle && (
          <span className="text-xs text-muted-foreground truncate">· {subtitle}</span>
        )}
      </div>
      {right}
    </div>
  );
}

function Sparkline({ data, alert }: { data: number[]; alert: boolean }) {
  if (!data.length) return null;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const w = 80;
  const h = 24;
  const step = data.length > 1 ? w / (data.length - 1) : 0;
  const points = data
    .map((v, i) => `${i * step},${h - ((v - min) / range) * h}`)
    .join(" ");
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-20 h-6" preserveAspectRatio="none">
      <polyline
        points={points}
        fill="none"
        stroke={alert ? "rgb(220 38 38)" : "var(--teal)"}
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function trendArrow(data: number[]) {
  if (data.length < 2) return Minus;
  const delta = data[data.length - 1] - data[0];
  if (Math.abs(delta) < 0.5) return Minus;
  return delta > 0 ? TrendingUp : TrendingDown;
}

function VitalCard({
  icon: Icon,
  label,
  unit,
  value,
  trend,
  alert,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  unit: string;
  value: number | string;
  trend: number[];
  alert: boolean;
}) {
  const TrendIcon = trendArrow(trend);
  return (
    <div className={`p-4 ${alert ? "bg-red-50/60" : ""}`}>
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
        <Icon className={`h-3.5 w-3.5 ${alert ? "text-red-600" : "text-[var(--teal)]"}`} />
        {label}
      </div>
      <div className="mt-1.5 flex items-baseline gap-1.5">
        <div
          className={`text-2xl font-bold tabular-nums tracking-tight ${alert ? "text-red-600" : "text-foreground"}`}
        >
          {value}
        </div>
        <div className="text-xs text-muted-foreground">{unit}</div>
      </div>
      <div className="mt-2 flex items-center justify-between">
        <Sparkline data={trend} alert={alert} />
        <TrendIcon
          className={`h-3.5 w-3.5 ${alert ? "text-red-600" : "text-muted-foreground"}`}
        />
      </div>
    </div>
  );
}

function MedRow({
  med,
  givenAt,
  busy,
  onAdminister,
}: {
  med: MedOrder;
  givenAt?: string;
  busy?: boolean;
  onAdminister: () => void;
}) {
  return (
    <li className="p-4 flex items-start gap-3">
      <div className="grid place-items-center h-9 w-9 rounded-lg bg-secondary text-[var(--navy)] shrink-0">
        <Pill className="h-4 w-4" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline justify-between gap-2">
          <div className="font-semibold text-sm text-foreground truncate">
            {med.name}
          </div>
          <div className="text-[11px] text-muted-foreground tabular-nums shrink-0">
            Due {med.due}
          </div>
        </div>
        <div className="text-xs text-muted-foreground mt-0.5">
          <span className="text-foreground font-medium">{med.dose}</span> ·{" "}
          {med.route} · {med.freq}
        </div>
        {med.notes && (
          <div className="text-[11px] text-amber-700 mt-1 inline-flex items-center gap-1">
            <AlertOctagon className="h-3 w-3" />
            {med.notes}
          </div>
        )}
        <div className="mt-3">
          {givenAt ? (
            <div className="inline-flex items-center gap-1.5 rounded-md bg-emerald-50 text-emerald-700 ring-1 ring-emerald-600/20 px-3 h-8 text-xs font-semibold">
              <CheckCircle2 className="h-3.5 w-3.5" />
              Given · {givenAt}
            </div>
          ) : (
            <button
              onClick={onAdminister}
              disabled={busy}
              className="inline-flex items-center gap-1.5 rounded-md bg-emerald-600 hover:bg-emerald-700 disabled:opacity-60 disabled:cursor-not-allowed text-white px-3 h-9 text-xs font-semibold transition shadow-sm"
            >
              {busy ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <span aria-hidden>💊</span>
              )}
              {busy ? "Signing off…" : "Administer Dose"}
            </button>
          )}
        </div>
      </div>
    </li>
  );
}

function SbarPill({ label, text }: { label: string; text: string }) {
  return (
    <div className="rounded-md bg-background border border-border px-2 py-1.5">
      <div className="text-[10px] font-bold text-[var(--teal)] uppercase tracking-wider">
        {label}
      </div>
      <div className="text-xs text-foreground/90 mt-0.5">{text}</div>
    </div>
  );
}

function SbarInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="block">
      <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={`${label}…`}
        className="mt-1 w-full rounded-md border border-border bg-background px-2.5 h-9 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--teal)]/40"
      />
    </label>
  );
}

function LabReportsPanel({ reports }: { reports: any[] }) {
  return (
    <section className="rounded-xl border border-border bg-card overflow-hidden">
      <SectionHeader
        icon={FlaskConical}
        title="🧪 Lab Reports"
        subtitle={`${reports.length} completed report${reports.length === 1 ? "" : "s"} · newest first`}
      />
      <div className="p-5 space-y-4">
        {reports.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
            No completed lab reports on file for this patient yet.
          </div>
        ) : (
          reports.map((r) => <LabReportCard key={r.id} report={r} />)
        )}
      </div>
    </section>
  );
}

function LabReportCard({ report }: { report: any }) {
  const ts = report.created_at
    ? new Date(report.created_at).toLocaleString([], {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "—";
  const metrics: any[] = Array.isArray(report.results_data)
    ? report.results_data
    : Array.isArray(report.results_data?.metrics)
      ? report.results_data.metrics
      : [];
  return (
    <article className="rounded-lg border border-border bg-secondary/20 overflow-hidden">
      <header className="flex flex-wrap items-start justify-between gap-2 px-4 py-3 bg-background border-b border-border">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <FlaskConical className="h-4 w-4 text-[var(--teal)]" />
            <h4 className="text-sm font-bold tracking-tight text-foreground">
              {report.test_type}
            </h4>
            <span className="inline-flex items-center rounded-full bg-emerald-50 text-emerald-700 ring-1 ring-emerald-600/20 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider">
              Completed
            </span>
          </div>
          <div className="mt-1 text-[11px] text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-0.5">
            <span className="inline-flex items-center gap-1">
              <Clock className="h-3 w-3" /> Completed: {ts}
            </span>
            <span className="inline-flex items-center gap-1">
              <FileSignature className="h-3 w-3" /> Processed by:{" "}
              <span className="font-medium text-foreground">{report.requested_by || "Lab Tech"}</span>
            </span>
          </div>
        </div>
      </header>
      <div className="p-4">
        {metrics.length === 0 ? (
          <div className="text-xs text-muted-foreground italic">
            Report data unavailable.
          </div>
        ) : (
          <table className="w-full text-xs">
            <thead>
              <tr className="text-[10px] uppercase tracking-wider text-muted-foreground border-b border-border">
                <th className="text-left font-semibold py-1.5 pr-2">Analyte</th>
                <th className="text-left font-semibold py-1.5 px-2">Value</th>
                <th className="text-left font-semibold py-1.5 px-2">Reference Range</th>
                <th className="text-left font-semibold py-1.5 pl-2">Flag</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {metrics.map((m, i) => {
                const flag = String(m.flag || m.status || "").toUpperCase();
                const abnormal = flag && flag !== "NORMAL" && flag !== "WNL";
                return (
                  <tr key={i} className={abnormal ? "bg-red-50/40" : ""}>
                    <td className="py-1.5 pr-2 font-medium text-foreground">
                      {m.name || m.test || m.analyte}
                    </td>
                    <td
                      className={`py-1.5 px-2 tabular-nums font-semibold ${
                        abnormal ? "text-red-600" : "text-foreground"
                      }`}
                    >
                      {m.value} {m.unit || ""}
                    </td>
                    <td className="py-1.5 px-2 text-muted-foreground tabular-nums">
                      {m.reference || m.range || m.normal || "—"}
                    </td>
                    <td className="py-1.5 pl-2">
                      {abnormal ? (
                        <span className="inline-flex items-center rounded-full bg-red-100 text-red-700 ring-1 ring-red-600/20 px-2 py-0.5 text-[10px] font-bold uppercase">
                          {flag}
                        </span>
                      ) : (
                        <span className="text-[10px] text-emerald-700 font-semibold uppercase">
                          {flag || "Normal"}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </article>
  );
}
