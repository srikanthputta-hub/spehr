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

// ============= shared styles ============================================
const panelClass =
  "rounded-md border border-slate-300 bg-white shadow-sm";
const sectionHeader =
  "px-3 py-2 border-b border-slate-300 bg-slate-50 text-[10px] uppercase tracking-widest text-slate-600 font-bold flex items-center justify-between";
const thClass =
  "h-8 px-2 text-left text-[10px] uppercase tracking-wider text-slate-500 font-bold border-b border-slate-300 bg-slate-100";
const tdClass = "px-2 py-1.5 text-[12px] text-slate-800 border-b border-slate-200 align-top";
const emptyMsg = (
  <div className="px-3 py-6 text-center text-[12px] text-slate-500 italic">No records found.</div>
);

function fmtTime(t: string | null | undefined) {
  if (!t) return "—";
  try {
    return new Date(t).toLocaleString(undefined, {
      month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
    });
  } catch { return "—"; }
}

// ============= data hooks ==============================================
interface LabRow {
  id: string;
  test_type: string | null;
  status: string | null;
  result_value: string | null;
  ordered_by: string | null;
  created_at: string | null;
}
interface MedRow {
  id: string;
  medication_name: string | null;
  drug_name: string | null;
  medication: string | null;
  dose: string | null;
  route: string | null;
  status: string | null;
  administered_at: string | null;
  created_at: string | null;
}
interface NoteRow {
  id: string;
  author_name: string | null;
  author_role: string | null;
  note_type: string | null;
  content: string | null;
  signed_at: string | null;
}

function useLabs(mrn: string) {
  const [rows, setRows] = useState<LabRow[] | null>(null);
  useEffect(() => {
    let c = false;
    supabase.from("lab_orders")
      .select("id, test_type, status, result_value, ordered_by, created_at")
      .eq("patient_mrn", mrn)
      .order("created_at", { ascending: false })
      .then(({ data }) => { if (!c) setRows((data as LabRow[]) ?? []); });
    return () => { c = true; };
  }, [mrn]);
  return rows;
}

function useMeds(mrn: string) {
  const [rows, setRows] = useState<MedRow[] | null>(null);
  useEffect(() => {
    let c = false;
    supabase.from("medication_orders")
      .select("id, medication_name, drug_name, medication, dose, route, status, administered_at, created_at")
      .eq("mrn", mrn)
      .order("created_at", { ascending: false })
      .then(({ data }) => { if (!c) setRows((data as MedRow[]) ?? []); });
    return () => { c = true; };
  }, [mrn]);
  return rows;
}

function useNotes(mrn: string, refreshKey: number) {
  const [rows, setRows] = useState<NoteRow[] | null>(null);
  useEffect(() => {
    let c = false;
    supabase.from("provider_notes")
      .select("id, author_name, author_role, note_type, content, signed_at")
      .eq("patient_mrn", mrn)
      .order("signed_at", { ascending: false })
      .then(({ data }) => { if (!c) setRows((data as NoteRow[]) ?? []); });
    return () => { c = true; };
  }, [mrn, refreshKey]);
  return [rows, setRows] as const;
}

// ============= badges ==================================================
function LabStatusBadge({ status }: { status: string | null }) {
  const s = (status ?? "").toLowerCase();
  const cls =
    s === "resulted"
      ? "bg-emerald-100 text-emerald-800 ring-emerald-300"
      : s.includes("processing")
      ? "bg-blue-100 text-blue-800 ring-blue-300"
      : "bg-slate-100 text-slate-700 ring-slate-300";
  return (
    <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide ring-1 ${cls}`}>
      {status ?? "—"}
    </span>
  );
}
function MedStatusBadge({ status }: { status: string | null }) {
  const s = (status ?? "").toLowerCase();
  if (s === "administered") {
    return (
      <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide bg-emerald-100 text-emerald-800 ring-1 ring-emerald-300">
        <CheckCircle2 className="h-3 w-3" /> Administered
      </span>
    );
  }
  if (s.includes("approved")) {
    return <span className="inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide bg-amber-100 text-amber-800 ring-1 ring-amber-300">⚠ Approved</span>;
  }
  if (s.includes("pending")) {
    return <span className="inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide bg-slate-200 text-slate-700 ring-1 ring-slate-300">⚠ {status}</span>;
  }
  return <span className="inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide bg-slate-100 text-slate-700 ring-1 ring-slate-300">{status ?? "—"}</span>;
}

function ResultValueCell({ value }: { value: string | null }) {
  if (!value) return <span className="text-slate-400">—</span>;
  if (/\[CRITICAL[^\]]*\]/i.test(value)) {
    const parts = value.split(/(\[CRITICAL[^\]]*\])/i);
    return (
      <span className="font-mono text-[11.5px]">
        {parts.map((p, i) =>
          /\[CRITICAL/i.test(p) ? (
            <span key={i} className="font-extrabold text-red-600 animate-pulse">{p}</span>
          ) : (
            <span key={i}>{p}</span>
          )
        )}
      </span>
    );
  }
  return <span className="font-mono text-[11.5px]">{value}</span>;
}

// ============= tab views ===============================================
function LabsView({ mrn }: { mrn: string }) {
  const rows = useLabs(mrn);
  if (rows === null) return <div className="p-6 text-center"><Loader2 className="h-4 w-4 animate-spin inline text-slate-400" /></div>;
  if (rows.length === 0) return emptyMsg;
  return (
    <table className="w-full">
      <thead>
        <tr>
          <th className={thClass}>Test Type</th>
          <th className={thClass}>Status</th>
          <th className={thClass}>Result Value</th>
          <th className={thClass}>Ordered By</th>
          <th className={thClass}>Time</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id} className="hover:bg-slate-50">
            <td className={`${tdClass} font-semibold`}>{r.test_type}</td>
            <td className={tdClass}><LabStatusBadge status={r.status} /></td>
            <td className={tdClass}><ResultValueCell value={r.result_value} /></td>
            <td className={`${tdClass} text-slate-600`}>{r.ordered_by ?? "—"}</td>
            <td className={`${tdClass} font-mono text-[11px] text-slate-600`}>{fmtTime(r.created_at)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function MarView({ mrn }: { mrn: string }) {
  const rows = useMeds(mrn);
  if (rows === null) return <div className="p-6 text-center"><Loader2 className="h-4 w-4 animate-spin inline text-slate-400" /></div>;
  if (rows.length === 0) return emptyMsg;
  return (
    <table className="w-full">
      <thead>
        <tr>
          <th className={thClass}>Medication</th>
          <th className={thClass}>Dose</th>
          <th className={thClass}>Route</th>
          <th className={thClass}>Status</th>
          <th className={thClass}>Administered At</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id} className="hover:bg-slate-50">
            <td className={`${tdClass} font-semibold`}>{r.medication_name ?? r.drug_name ?? r.medication ?? "—"}</td>
            <td className={`${tdClass} font-mono`}>{r.dose ?? "—"}</td>
            <td className={`${tdClass} font-mono`}>{r.route ?? "—"}</td>
            <td className={tdClass}><MedStatusBadge status={r.status} /></td>
            <td className={`${tdClass} font-mono text-[11px] text-slate-600`}>{fmtTime(r.administered_at)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function NotesView({ mrn }: { mrn: string }) {
  const [refreshKey, setRefreshKey] = useState(0);
  const [rows] = useNotes(mrn, refreshKey);
  const [showForm, setShowForm] = useState(false);
  const [noteType, setNoteType] = useState("Progress Note");
  const [content, setContent] = useState("");
  const [pinOpen, setPinOpen] = useState(false);
  const [pin, setPin] = useState("");
  const [pinError, setPinError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const tryOpenPin = () => {
    if (!content.trim()) {
      toast.error("Note content is required");
      return;
    }
    setPin(""); setPinError(null); setPinOpen(true);
  };

  const verifyAndSubmit = async () => {
    if (pin !== "1234") {
      setPinError("Invalid Signature PIN.");
      return;
    }
    setSubmitting(true);
    const { error } = await supabase.from("provider_notes").insert({
      patient_mrn: mrn,
      note_type: noteType,
      content: content.trim(),
      author_name: "Sarah Jenkins",
      author_role: "RN, BSN",
    });
    setSubmitting(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Note signed and submitted");
    setPinOpen(false);
    setShowForm(false);
    setContent("");
    setNoteType("Progress Note");
    setRefreshKey((k) => k + 1);
  };

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <button
          onClick={() => setShowForm((v) => !v)}
          className="inline-flex items-center gap-1.5 rounded bg-[var(--navy,#0b2545)] text-white px-3 h-8 text-[11px] font-bold uppercase tracking-wider hover:bg-[var(--teal,#13b5b1)] transition"
        >
          <Plus className="h-3.5 w-3.5" /> Add Clinical Note
        </button>
      </div>

      {showForm ? (
        <div className={`${panelClass} p-3 space-y-2`}>
          <div className="flex items-center gap-2">
            <label className="text-[10px] uppercase tracking-widest text-slate-500 font-bold w-24">Note Type</label>
            <select
              value={noteType}
              onChange={(e) => setNoteType(e.target.value)}
              className="flex-1 h-8 rounded border border-slate-300 px-2 text-[12px] bg-white"
            >
              <option>Progress Note</option>
              <option>Nursing Shift Note</option>
              <option>SBAR Handoff</option>
              <option>Care Plan Update</option>
              <option>Discharge Note</option>
            </select>
          </div>
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            rows={6}
            placeholder="Document clinical observations, interventions, and patient response…"
            className="w-full rounded border border-slate-300 p-2 text-[12px] font-sans focus:outline-none focus:ring-1 focus:ring-[var(--teal,#13b5b1)]"
          />
          <div className="flex justify-end gap-2">
            <button onClick={() => setShowForm(false)} className="rounded border border-slate-300 bg-white px-3 h-8 text-[11px] font-semibold text-slate-700 hover:bg-slate-50">
              Cancel
            </button>
            <button
              onClick={tryOpenPin}
              className="inline-flex items-center gap-1.5 rounded bg-emerald-700 text-white px-3 h-8 text-[11px] font-bold uppercase tracking-wider hover:bg-emerald-800"
            >
              <ShieldCheck className="h-3.5 w-3.5" /> Sign & Submit
            </button>
          </div>
        </div>
      ) : null}

      {rows === null ? (
        <div className="p-6 text-center"><Loader2 className="h-4 w-4 animate-spin inline text-slate-400" /></div>
      ) : rows.length === 0 ? (
        <div className={panelClass}>{emptyMsg}</div>
      ) : (
        <div className="space-y-2">
          {rows.map((n) => (
            <article key={n.id} className={`${panelClass} p-3`}>
              <header className="flex items-center justify-between border-b border-slate-200 pb-1.5 mb-1.5">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="rounded bg-[var(--navy,#0b2545)] text-white px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider">
                    {n.note_type ?? "Note"}
                  </span>
                  <span className="text-[12px] font-semibold text-slate-800 truncate">{n.author_name ?? "Unknown"}</span>
                  <span className="text-[10.5px] text-slate-500">{n.author_role ?? ""}</span>
                </div>
                <div className="flex items-center gap-1.5 text-[10.5px] text-slate-500 font-mono shrink-0">
                  <ShieldCheck className="h-3 w-3 text-emerald-600" />
                  Signed {fmtTime(n.signed_at)}
                </div>
              </header>
              <p className="text-[12.5px] text-slate-800 whitespace-pre-wrap leading-relaxed">{n.content}</p>
            </article>
          ))}
        </div>
      )}

      {pinOpen ? (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4">
          <div className="w-full max-w-sm rounded-lg bg-white shadow-2xl border-t-4 border-[var(--teal,#13b5b1)]">
            <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200">
              <div className="flex items-center gap-2">
                <ShieldCheck className="h-4 w-4 text-[var(--navy,#0b2545)]" />
                <h3 className="text-[12px] font-bold uppercase tracking-wider text-slate-800">
                  Digital Signature Verification
                </h3>
              </div>
              <button onClick={() => setPinOpen(false)} className="text-slate-400 hover:text-slate-700"><X className="h-4 w-4" /></button>
            </div>
            <div className="p-5 space-y-3">
              <p className="text-[12px] text-slate-600">
                Enter your 4-digit clinician PIN to electronically sign this note.
              </p>
              <input
                type="password"
                inputMode="numeric"
                maxLength={4}
                value={pin}
                onChange={(e) => { setPin(e.target.value.replace(/\D/g, "").slice(0, 4)); setPinError(null); }}
                onKeyDown={(e) => e.key === "Enter" && verifyAndSubmit()}
                autoFocus
                placeholder="••••"
                className="w-full h-12 rounded border-2 border-slate-300 px-3 text-center font-mono text-2xl tracking-[0.6em] focus:outline-none focus:border-[var(--teal,#13b5b1)]"
              />
              {pinError ? (
                <p className="text-[11.5px] font-bold text-red-600 text-center">{pinError}</p>
              ) : null}
              <button
                onClick={verifyAndSubmit}
                disabled={submitting || pin.length !== 4}
                className="w-full rounded bg-emerald-700 text-white px-3 h-9 text-[11px] font-bold uppercase tracking-wider hover:bg-emerald-800 disabled:opacity-50"
              >
                {submitting ? "Signing…" : "Verify & Sign"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function SummaryView({ mrn, patient }: { mrn: string; patient: PatientRecord }) {
  const labs = useLabs(mrn);
  const meds = useMeds(mrn);
  const [notes] = useNotes(mrn, 0);

  const topMeds = (meds ?? []).slice(0, 3);
  const topLabs = (labs ?? []).slice(0, 3);
  const latestNote = (notes ?? [])[0];

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
      {/* LEFT */}
      <div className="space-y-3">
        <section className={panelClass}>
          <header className={sectionHeader}>Encounter Details</header>
          <dl className="grid grid-cols-3 gap-x-3 gap-y-1.5 p-3 text-[12px]">
            <dt className="col-span-1 text-slate-500 uppercase text-[10px] tracking-wider font-bold">Admission</dt>
            <dd className="col-span-2 font-mono">—</dd>
            <dt className="col-span-1 text-slate-500 uppercase text-[10px] tracking-wider font-bold">Chief Complaint</dt>
            <dd className="col-span-2 font-semibold text-slate-800">{patient.chief_complaint ?? "—"}</dd>
            <dt className="col-span-1 text-slate-500 uppercase text-[10px] tracking-wider font-bold">Diagnosis</dt>
            <dd className="col-span-2 text-slate-800">{patient.diagnosis ?? "—"}</dd>
            <dt className="col-span-1 text-slate-500 uppercase text-[10px] tracking-wider font-bold">Room</dt>
            <dd className="col-span-2 font-mono">{patient.room ?? "—"}</dd>
          </dl>
        </section>

        <section className={panelClass}>
          <header className={sectionHeader}>Active Medications</header>
          {meds === null ? (
            <div className="p-3"><Loader2 className="h-4 w-4 animate-spin text-slate-400" /></div>
          ) : topMeds.length === 0 ? emptyMsg : (
            <ul className="divide-y divide-slate-200">
              {topMeds.map((m) => (
                <li key={m.id} className="px-3 py-2 flex items-center justify-between text-[12px]">
                  <div className="min-w-0">
                    <div className="font-semibold text-slate-800 truncate">
                      {m.medication_name ?? m.drug_name ?? m.medication ?? "—"}
                    </div>
                    <div className="font-mono text-[11px] text-slate-500">
                      {m.dose ?? "—"} · {m.route ?? "—"}
                    </div>
                  </div>
                  <MedStatusBadge status={m.status} />
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {/* RIGHT */}
      <div className="space-y-3">
        <section className={panelClass}>
          <header className={sectionHeader}>Recent Labs</header>
          {labs === null ? (
            <div className="p-3"><Loader2 className="h-4 w-4 animate-spin text-slate-400" /></div>
          ) : topLabs.length === 0 ? emptyMsg : (
            <ul className="divide-y divide-slate-200">
              {topLabs.map((l) => (
                <li key={l.id} className="px-3 py-2 text-[12px]">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-semibold text-slate-800 truncate">{l.test_type}</span>
                    <LabStatusBadge status={l.status} />
                  </div>
                  <div className="mt-0.5"><ResultValueCell value={l.result_value} /></div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className={panelClass}>
          <header className={sectionHeader}>Latest Clinical Note</header>
          {notes === null ? (
            <div className="p-3"><Loader2 className="h-4 w-4 animate-spin text-slate-400" /></div>
          ) : !latestNote ? emptyMsg : (
            <div className="p-3 text-[12px]">
              <div className="flex items-center justify-between border-b border-slate-200 pb-1.5 mb-1.5">
                <span className="rounded bg-[var(--navy,#0b2545)] text-white px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider">
                  {latestNote.note_type ?? "Note"}
                </span>
                <span className="font-mono text-[10.5px] text-slate-500">{fmtTime(latestNote.signed_at)}</span>
              </div>
              <div className="text-[11px] text-slate-500 mb-1">
                {latestNote.author_name} · {latestNote.author_role}
              </div>
              <p className="text-slate-800 whitespace-pre-wrap line-clamp-6">{latestNote.content}</p>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

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