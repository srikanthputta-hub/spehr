import { createFileRoute, Link, useParams } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { ArrowLeft, Loader2, AlertTriangle, Activity, Plus, ShieldCheck, X, CheckCircle2 } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/patient/$mrn")({
  component: PatientChart,
});

interface PatientRecord {
  mrn: string;
  first_name: string | null;
  last_name: string | null;
  age: number | null;
  gender: string | null;
  room: string | null;
  code_status: string | null;
  chief_complaint: string | null;
  diagnosis: string | null;
  hr: number | null;
  bp_systolic: number | null;
  bp_diastolic: number | null;
  spo2: number | null;
}

function mockAgeFromName(first: string | null | undefined, fallback: number | null): number {
  if (fallback && fallback > 0) return fallback;
  const s = (first ?? "X").toLowerCase();
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return 28 + (h % 60); // 28 – 87
}

function mockDobFromAge(age: number): string {
  const year = new Date().getFullYear() - age;
  // Stable deterministic month/day from age
  const m = ((age * 7) % 12) + 1;
  const d = ((age * 13) % 27) + 1;
  return `${String(m).padStart(2, "0")}/${String(d).padStart(2, "0")}/${year}`;
}

function mockAllergy(mrn: string): string {
  let h = 0;
  for (let i = 0; i < mrn.length; i++) h = (h * 31 + mrn.charCodeAt(i)) >>> 0;
  const options = ["NKDA", "Penicillin", "Sulfa", "Latex", "NKDA"];
  return options[h % options.length];
}

function baselineVitals(dx: string | null | undefined) {
  const d = (dx ?? "").toLowerCase();
  if (d.includes("sepsis")) return { hr: 112, sys: 88, dia: 55, spo2: 95 };
  if (d.includes("dka")) return { hr: 105, sys: 100, dia: 65, spo2: 97 };
  if (d.includes("stemi")) return { hr: 98, sys: 138, dia: 88, spo2: 96 };
  if (d.includes("stroke")) return { hr: 92, sys: 165, dia: 95, spo2: 96 };
  return { hr: 75, sys: 120, dia: 80, spo2: 98 };
}

function LiveTelemetry({ dx }: { dx: string | null | undefined }) {
  const base = useMemo(() => baselineVitals(dx), [dx]);
  const [hr, setHr] = useState(base.hr);
  const [sys, setSys] = useState(base.sys);
  const [dia, setDia] = useState(base.dia);
  const [spo2, setSpo2] = useState(base.spo2);

  useEffect(() => {
    setHr(base.hr);
    setSys(base.sys);
    setDia(base.dia);
    setSpo2(base.spo2);
  }, [base]);

  useEffect(() => {
    const id = setInterval(() => {
      const j = (r: number) => Math.floor(Math.random() * (2 * r + 1)) - r;
      setHr((v) => Math.max(30, Math.min(220, v + j(2))));
      setSpo2((v) => Math.max(70, Math.min(100, v + (Math.random() < 0.5 ? -1 : 1))));
      setSys((v) => Math.max(50, Math.min(220, v + j(1))));
      setDia((v) => Math.max(30, Math.min(140, v + (Math.random() < 0.5 ? -1 : 0))));
    }, 3000);
    return () => clearInterval(id);
  }, []);

  const hrCritical = hr > 100;
  const sysCritical = sys < 90;

  return (
    <div className="flex items-center gap-5 font-mono tabular-nums">
      <div className="flex flex-col items-end leading-tight">
        <span className="text-[9px] uppercase tracking-widest text-white/55">HR</span>
        <span className={`text-xl ${hrCritical ? "text-red-400 font-extrabold" : "text-emerald-300 font-bold"}`}>
          {hr}
        </span>
        <span className="text-[9px] text-white/45">bpm</span>
      </div>
      <div className="flex flex-col items-end leading-tight">
        <span className="text-[9px] uppercase tracking-widest text-white/55">BP</span>
        <span className="text-xl font-bold">
          <span className={sysCritical ? "text-red-400 font-extrabold" : "text-white"}>{sys}</span>
          <span className="text-white/55">/{dia}</span>
        </span>
        <span className="text-[9px] text-white/45">mmHg</span>
      </div>
      <div className="flex flex-col items-end leading-tight">
        <span className="text-[9px] uppercase tracking-widest text-white/55">SpO₂</span>
        <span className="text-xl text-cyan-300 font-bold">{spo2}</span>
        <span className="text-[9px] text-white/45">%</span>
      </div>
      <div className="flex items-center gap-1.5 pl-3 ml-1 border-l border-white/15">
        <Activity className="h-3.5 w-3.5 text-emerald-400 animate-pulse" />
        <span className="text-[10px] uppercase tracking-wider text-emerald-300 font-semibold">Live</span>
      </div>
    </div>
  );
}

type TabKey = "summary" | "labs" | "mar" | "notes";
const TABS: { key: TabKey; label: string }[] = [
  { key: "summary", label: "Summary" },
  { key: "labs", label: "Lab Results" },
  { key: "mar", label: "MAR (Medications)" },
  { key: "notes", label: "Provider Notes" },
];

function PatientChart() {
  const { mrn } = useParams({ from: "/patient/$mrn" });
  const [patient, setPatient] = useState<PatientRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<TabKey | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      const { data, error } = await supabase
        .from("patients")
        .select("mrn, first_name, last_name, age, gender, room, code_status, chief_complaint, diagnosis, hr, bp_systolic, bp_diastolic, spo2")
        .eq("mrn", mrn)
        .maybeSingle();
      if (cancelled) return;
      if (error) setError(error.message);
      else setPatient(data as PatientRecord | null);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [mrn]);

  if (loading) {
    return (
      <div className="min-h-screen grid place-items-center bg-slate-50">
        <Loader2 className="h-5 w-5 animate-spin text-slate-500" />
      </div>
    );
  }

  if (error || !patient) {
    return (
      <div className="min-h-screen grid place-items-center bg-slate-50 p-6">
        <div className="text-center max-w-sm">
          <AlertTriangle className="h-6 w-6 text-red-600 mx-auto mb-2" />
          <h1 className="text-lg font-semibold">Chart not found</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {error ?? `No patient with MRN ${mrn}.`}
          </p>
          <Link
            to="/nursing-board"
            className="inline-flex items-center gap-1 mt-4 text-sm text-[var(--teal)] hover:underline"
          >
            <ArrowLeft className="h-4 w-4" /> Back to Floor Board
          </Link>
        </div>
      </div>
    );
  }

  const fullName = `${patient.first_name ?? ""} ${patient.last_name ?? ""}`.trim() || "Unknown Patient";
  const age = mockAgeFromName(patient.first_name, patient.age);
  const dob = mockDobFromAge(age);
  const codeStatus = (patient.code_status ?? "").trim() || "Full Code";
  const isFullCode = /full/i.test(codeStatus);
  const allergy = mockAllergy(patient.mrn);
  const isNKDA = allergy === "NKDA";
  const dx = patient.diagnosis ?? patient.chief_complaint;

  return (
    <main className="min-h-screen bg-slate-50">
      {/* Persistent Clinical Banner */}
      <header className="sticky top-0 z-30 bg-[var(--navy,#0b2545)] text-white border-b-2 border-[var(--teal,#13b5b1)] shadow-lg">
        <div className="max-w-[1600px] mx-auto px-4 py-2.5 flex items-center gap-4">
          <Link
            to="/nursing-board"
            className="inline-flex items-center gap-1 rounded bg-white/10 hover:bg-white/20 ring-1 ring-white/15 px-2.5 h-8 text-[11px] font-semibold transition shrink-0"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Floor Board
          </Link>

          <div className="min-w-0 flex-1 flex items-center gap-4">
            {/* Identity */}
            <div className="min-w-0">
              <h1 className="font-serif text-2xl leading-none tracking-tight truncate">
                {fullName}
              </h1>
              <div className="mt-1 flex items-center gap-2 font-mono text-[10.5px] text-white/75 tabular-nums">
                <span>MRN {patient.mrn}</span>
                <span className="text-white/30">|</span>
                <span>DOB {dob}</span>
                <span className="text-white/30">|</span>
                <span>{age} y/o {patient.gender ?? "—"}</span>
                {patient.room ? (
                  <>
                    <span className="text-white/30">|</span>
                    <span>RM {patient.room}</span>
                  </>
                ) : null}
              </div>
            </div>

            {/* Pills */}
            <div className="hidden md:flex items-center gap-1.5 shrink-0">
              <span
                className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10.5px] font-bold ring-1 ${
                  isFullCode
                    ? "bg-emerald-500/15 text-emerald-300 ring-emerald-400/40"
                    : "bg-amber-500/15 text-amber-300 ring-amber-400/40"
                }`}
              >
                {codeStatus}
              </span>
              <span
                className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10.5px] font-bold ring-1 ${
                  isNKDA
                    ? "bg-slate-500/15 text-slate-200 ring-slate-400/30"
                    : "bg-red-500/20 text-red-300 ring-red-400/50"
                }`}
              >
                Allergies: {allergy}
              </span>
            </div>

            {/* Chief Complaint */}
            <div className="hidden lg:flex min-w-0 flex-1 items-center gap-2 px-3 h-8 rounded bg-white/5 ring-1 ring-white/10">
              <span className="text-[9px] uppercase tracking-widest text-white/55 shrink-0">CC</span>
              <span className="text-[11.5px] text-white/95 truncate font-medium">
                {patient.chief_complaint ?? "—"}
              </span>
            </div>
          </div>

          {/* Live Telemetry */}
          <div className="shrink-0">
            <LiveTelemetry dx={dx} />
          </div>
        </div>

        {/* Chart Navigation Tabs */}
        <nav className="bg-[#0a1f3d] border-t border-white/10">
          <div className="max-w-[1600px] mx-auto px-4 flex items-center gap-0">
            {TABS.map((t) => {
              const active = tab === t.key;
              return (
                <button
                  key={t.key}
                  onClick={() => setTab(t.key)}
                  className={`relative h-9 px-4 text-[11.5px] font-semibold uppercase tracking-wider transition ${
                    active
                      ? "text-white"
                      : "text-white/55 hover:text-white/85"
                  }`}
                >
                  {t.label}
                  {active ? (
                    <span className="absolute bottom-0 left-2 right-2 h-0.5 bg-[var(--teal,#13b5b1)] rounded-t" />
                  ) : null}
                </button>
              );
            })}
          </div>
        </nav>
      </header>

      {/* Main content area */}
      <section className="max-w-[1600px] mx-auto px-4 py-10">
        {tab === null ? (
          <div className="rounded-lg border border-slate-200 bg-white shadow-sm p-12 text-center">
            <div className="text-[10px] uppercase tracking-widest text-slate-400 font-semibold">
              S.P.E.H.R. Clinical Chart
            </div>
            <p className="mt-3 text-base text-slate-600">
              Select a chart section to view clinical data for{" "}
              <span className="font-serif text-slate-900 font-semibold">{fullName}</span>.
            </p>
            <div className="mt-6 flex justify-center gap-2 flex-wrap">
              {TABS.map((t) => (
                <button
                  key={t.key}
                  onClick={() => setTab(t.key)}
                  className="rounded border border-slate-300 bg-white px-3 h-8 text-[11px] font-semibold text-slate-700 hover:bg-[var(--navy,#0b2545)] hover:text-white hover:border-[var(--navy,#0b2545)] transition"
                >
                  {t.label}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="rounded-lg border border-slate-200 bg-white shadow-sm p-8">
            <div className="text-[10px] uppercase tracking-widest text-slate-400 font-semibold">
              {TABS.find((t) => t.key === tab)?.label}
            </div>
            <p className="mt-2 text-sm text-slate-500 italic">
              Section module pending integration.
            </p>
          </div>
        )}
      </section>
    </main>
  );
}