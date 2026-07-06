import { createFileRoute, Link, useParams, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { supabase } from "@/integrations/supabase/client";
import { autoCodeLab, autoCodeMedication } from "@/lib/auto-code";
import { getMockAiNote } from "@/lib/mockAiNotes";
import {
  ArrowLeft, Loader2, AlertTriangle, Activity, Plus, ShieldCheck, X,
  CheckCircle2, Brain, Home, ClipboardList, FileText, FlaskConical,
  LogOut, PenLine, Settings, Power, ChevronUp, RefreshCw, Info, Search,
  TrendingUp, Calendar, Pill, Printer, Users,
} from "lucide-react";
import { toast } from "sonner";
import {
  medsForComplaint,
  labsForComplaint,
} from "@/lib/complaint-protocols";
import { useAutomationEnabled } from "@/hooks/useAutomationEnabled";
import { loadIntake, type IntakeRecord } from "@/lib/intake-record";
import DischargeConformanceBanner from "@/components/patient/DischargeConformanceBanner";
import SafetyAlertBanner from "@/components/patient/SafetyAlertBanner";
import { dischargePatientViaWorker } from "@/lib/discharge-patient";

/* ------------------------------------------------------------------ */
/* CDS active suggestion hook — reads cds_suggestions table + realtime */
/* ------------------------------------------------------------------ */
type CdsSuggestionRow = {
  id: string;
  mrn: string;
  suggestion_id: string;
  label: string;
  severity: string;
  items: string[];
  trigger_code: string | null;
  trigger_display: string | null;
  fired_at: string | null;
  dismissed: boolean;
};
function useCdsActiveSuggestion(mrn: string): {
  suggestion: CdsSuggestionRow | null;
  refresh: () => void;
} {
  const [row, setRow] = useState<CdsSuggestionRow | null>(null);
  const load = async () => {
    const { data } = await supabase
      .from("cds_suggestions")
      .select("*")
      .eq("mrn", mrn)
      .eq("dismissed", false)
      .order("fired_at", { ascending: false })
      .limit(1);
    const first = (data ?? [])[0] as any;
    if (!first) { setRow(null); return; }
    setRow({
      ...first,
      items: Array.isArray(first.items) ? first.items : [],
    });
  };
  useEffect(() => {
    load();
    const channel = supabase
      .channel(`cds-${mrn}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "cds_suggestions", filter: `mrn=eq.${mrn}` },
        () => load(),
      )
      .subscribe();
    return () => { supabase.removeChannel(channel); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mrn]);
  return { suggestion: row, refresh: load };
}

function CdsProtocolModal({
  suggestion,
  onDismiss,
  onClose,
}: {
  suggestion: CdsSuggestionRow;
  onDismiss: () => Promise<void> | void;
  onClose: () => void;
}) {
  const [checked, setChecked] = useState<Record<number, boolean>>({});
  const [dismissing, setDismissing] = useState(false);
  const handleDismiss = async () => {
    setDismissing(true);
    try { await onDismiss(); } finally { setDismissing(false); }
  };
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4">
      <div className="w-full max-w-lg rounded-lg bg-white shadow-2xl border-t-4 border-red-500">
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200">
          <h3 className="text-[13px] font-bold text-slate-800">{suggestion.label}</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700"><X className="h-4 w-4" /></button>
        </div>
        <div className="px-4 py-3 space-y-3">
          {suggestion.trigger_display && (
            <p className="text-[12px] text-slate-600">
              <span className="font-semibold">Triggered by:</span> {suggestion.trigger_display}
              {suggestion.trigger_code ? ` (${suggestion.trigger_code})` : ""}
            </p>
          )}
          <ul className="space-y-1.5">
            {suggestion.items.map((it, i) => (
              <li key={i} className="flex items-start gap-2 text-[12.5px] text-slate-800">
                <input
                  type="checkbox"
                  checked={!!checked[i]}
                  onChange={(e) => setChecked((c) => ({ ...c, [i]: e.target.checked }))}
                  className="mt-0.5"
                />
                <span>{it}</span>
              </li>
            ))}
          </ul>
        </div>
        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-slate-200 bg-slate-50">
          <button
            onClick={onClose}
            className="rounded border border-slate-300 bg-white px-3 h-8 text-[11.5px] font-semibold text-slate-700 hover:bg-slate-100"
          >
            Close
          </button>
          <button
            onClick={handleDismiss}
            disabled={dismissing}
            className="rounded bg-red-600 text-white px-3 h-8 text-[11.5px] font-bold uppercase tracking-wider hover:bg-red-700 disabled:opacity-50"
          >
            {dismissing ? "Dismissing…" : "Dismiss Protocol"}
          </button>
        </div>
      </div>
    </div>
  );
}

export const Route = createFileRoute("/patient/$mrn")({
  component: PatientChart,
});

/* ------------------------------------------------------------------ */
/* Pending Signature Store                                             */
/* ------------------------------------------------------------------ */
/* Any edit in the chart that the user "Saves" is queued here as an    */
/* unsigned change. The toolbar Sign button flushes the queue after    */
/* PIN 1234 is verified, persisting every change to Supabase.          */
/* ------------------------------------------------------------------ */
type PendingChange = {
  id: string;
  label: string;
  commit: () => Promise<void>;
};
const pendingStore = (() => {
  let items: PendingChange[] = [];
  const subs = new Set<() => void>();
  const emit = () => subs.forEach((s) => s());
  return {
    add(c: Omit<PendingChange, "id">) {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      items = [...items, { ...c, id }];
      emit();
      return id;
    },
    remove(id: string) {
      items = items.filter((i) => i.id !== id);
      emit();
    },
    clear() { items = []; emit(); },
    get(): PendingChange[] { return items; },
    subscribe(fn: () => void) { subs.add(fn); return () => subs.delete(fn); },
  };
})();
function usePendingChanges(): PendingChange[] {
  return useSyncExternalStore(
    (cb) => pendingStore.subscribe(cb),
    () => pendingStore.get(),
    () => pendingStore.get(),
  );
}

interface PatientRecord {
  id: string;
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
  admission_time: string | null;
  facility_name: string | null;
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
  const automationEnabled = useAutomationEnabled();

  useEffect(() => {
    setHr(base.hr);
    setSys(base.sys);
    setDia(base.dia);
    setSpo2(base.spo2);
  }, [base]);

  useEffect(() => {
    if (!automationEnabled) return;
    const id = setInterval(() => {
      const j = (r: number) => Math.floor(Math.random() * (2 * r + 1)) - r;
      setHr((v) => Math.max(30, Math.min(220, v + j(2))));
      setSpo2((v) => Math.max(70, Math.min(100, v + (Math.random() < 0.5 ? -1 : 1))));
      setSys((v) => Math.max(50, Math.min(220, v + j(1))));
      setDia((v) => Math.max(30, Math.min(140, v + (Math.random() < 0.5 ? -1 : 0))));
    }, 3000);
    return () => clearInterval(id);
  }, [automationEnabled]);

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

type TabKey =
  | "summary"
  | "activity"
  | "flowsheets"
  | "healthmgmt"
  | "diagnostics"
  | "providernotes"
  | "nurse"
  | "medications"
  | "history"
  | "administrative"
  | "otherclinical";

// Clinical style — two tab rows
const TABS_ROW1: { key: TabKey; label: string }[] = [
  { key: "diagnostics", label: "Diagnostics" },
  { key: "providernotes", label: "Provider Notes" },
  { key: "nurse", label: "Nurse/Allied Health" },
  { key: "medications", label: "Medications" },
];
const TABS_ROW2: { key: TabKey; label: string }[] = [
  { key: "history", label: "History & Problems" },
  { key: "administrative", label: "Administrative" },
  { key: "otherclinical", label: "Other Clinical" },
];
const TABS_ROW3: { key: TabKey; label: string }[] = [
  { key: "summary", label: "Summary" },
  { key: "activity", label: "Activity" },
  { key: "flowsheets", label: "Flowsheets" },
  { key: "healthmgmt", label: "Health Mgmt" },
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
      month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
    });
  } catch { return "—"; }
}

/** Live HH:MM:SS clock that ticks every second — true execution-clock time. */
function LiveClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const i = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(i);
  }, []);
  return (
    <span className="font-mono">
      {now.toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      })}
    </span>
  );
}

// --- Per-complaint fallback (used only if DB row hasn't seeded yet) ---
function fallbackMeds(
  key: string,
  complaint?: string | null,
): MedRow[] {
  const now = new Date().toISOString();
  return medsForComplaint(complaint).map((m, i) => ({
    id: `${key}-fb-med-${i}`,
    medication_name: m.name,
    drug_name: null,
    medication: null,
    dose: m.dose,
    route: m.route,
    status: "Administered",
    administered_at: now,
    created_at: now,
  }));
}
function fallbackLabs(
  key: string,
  complaint?: string | null,
): LabRow[] {
  const now = new Date().toISOString();
  return labsForComplaint(complaint).map((l, i) => ({
    id: `${key}-fb-lab-${i}`,
    test_type: l.name,
    status: "Resulted",
    result_value: `${l.resultExample} (ref ${l.referenceRange}${l.unit ? ` ${l.unit}` : ""})`,
    ordered_by: "Auto-generated",
    created_at: now,
  }));
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

function useLabs(mrn: string, complaint?: string | null) {
  const [rows, setRows] = useState<LabRow[] | null>(null);
  useEffect(() => {
    let c = false;
    const load = () => supabase.from("lab_orders")
      .select("id, test_type, status, result_value, ordered_by, created_at, resulted_at")
      .eq("patient_mrn", mrn)
      .order("created_at", { ascending: false })
      .then(({ data }) => {
        if (c) return;
        const real = ((data as any[]) ?? []).map((r) => ({
          ...r,
          // Surface the lab's official resulted timestamp wherever the chart
          // currently displays created_at — keeps every downstream row aware
          // of the precise moment the cascade flipped status to "Reported".
          created_at: r.resulted_at ?? r.created_at,
        })) as LabRow[];
        // Gate: only labs whose status is "Reported" (current cascade final
        // state) — or the legacy "Resulted" / "Completed" — and that carry a
        // result value are visible in the chart.
        const finalized = real.filter((r) => {
          const s = (r.status ?? "").toLowerCase();
          const released = s === "reported" || s === "resulted" || s === "completed";
          return released && !!r.result_value;
        });
        if (finalized.length > 0) {
          setRows(finalized);
        } else {
          // No released labs yet — show empty. Never surface protocol
          // example values as if they were real results; the chart must
          // mirror the lab board exactly (only "Reported" rows visible).
          setRows([]);
        }
      });
    load();
    const channel = supabase
      .channel(`labs-${mrn}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "lab_orders", filter: `patient_mrn=eq.${mrn}` },
        () => load(),
      )
      .subscribe();
    return () => { c = true; supabase.removeChannel(channel); };
  }, [mrn, complaint]);
  return rows;
}

function useMeds(
  patientId: string | null | undefined,
  mrn: string,
  complaint?: string | null,
) {
  const [rows, setRows] = useState<MedRow[] | null>(null);
  useEffect(() => {
    if (!patientId) { setRows([]); return; }
    let c = false;
    const load = () => supabase.from("medication_orders")
      .select("id, medication_name, drug_name, medication, dose, route, status, administered_at, dispensed_at, created_at")
      .or(`patient_id.eq.${patientId},patient_mrn.eq.${mrn},mrn.eq.${mrn}`)
      .order("created_at", { ascending: false })
      .then(({ data }) => {
        if (c) return;
        const all = ((data as any[]) ?? []).map((r) => ({
          ...r,
        // Prefer the official administered_at timestamp; fall back to
        // dispensed_at for legacy rows that never reached "Administered".
          administered_at: r.administered_at ?? r.dispensed_at,
        })) as MedRow[];
        // Gate: only meds whose status reads "Administered" (cascade final
        // state) are visible in the chart. Anything still Ordered / Pending
        // Verification / Dispensed stays hidden until final administration.
        const released = all.filter((r) => {
          const s = (r.status ?? "").toLowerCase();
          return s === "administered";
        });
        if (released.length > 0) setRows(released);
        else setRows([]);
        // No administered meds yet — show empty. Never surface fallback
        // "Administered" rows; the chart mirrors the pharmacy queue
        // exactly (only rows with status === "Administered" are visible).
      });
    load();
    const channel = supabase
      .channel(`meds-${patientId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "medication_orders" },
        () => load(),
      )
      .subscribe();
    return () => { c = true; supabase.removeChannel(channel); };
  }, [patientId, mrn, complaint]);
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
    s === "resulted" || s === "reported" || s === "completed"
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
function LabsView({ mrn, complaint }: { mrn: string; complaint: string | null }) {
  const rows = useLabs(mrn, complaint);
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

function MarView({ patientId, mrn, complaint }: { patientId: string; mrn: string; complaint: string | null }) {
  const rows = useMeds(patientId, mrn, complaint);
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
  // SYNCHRONOUS BYPASS: read from global mock store. No timers, no DB.
  const mockAi = getMockAiNote(mrn);
  const aiNote = mockAi
    ? { content: mockAi.text, created_at: mockAi.created_at }
    : {
        content:
          "AI Consult [Local Mock]: Based on presentation, rule out ACS, Pulmonary Embolism, and Aortic Dissection.",
        created_at: new Date().toISOString(),
      };
  const [showForm, setShowForm] = useState(false);
  const [noteType, setNoteType] = useState("Progress Note");
  const [content, setContent] = useState("");

  const saveDraft = () => {
    if (!content.trim()) {
      toast.error("Note content is required");
      return;
    }
    const snapshotType = noteType;
    const snapshotContent = content.trim();
    pendingStore.add({
      label: `${snapshotType} note`,
      commit: async () => {
        const { error } = await supabase.from("provider_notes").insert({
          patient_mrn: mrn,
          note_type: snapshotType,
          content: snapshotContent,
          author_name: "Sarah Jenkins",
          author_role: "RN, BSN",
        });
        if (error) throw error;
        setRefreshKey((k) => k + 1);
      },
    });
    toast.success("Draft saved — click Sign on the toolbar to commit");
    setShowForm(false);
    setContent("");
    setNoteType("Progress Note");
  };

  return (
    <div className="space-y-3">
      {/* AI Differential — Provider Notes feed for nursing awareness */}
      <div className="rounded-md border border-purple-300 bg-purple-50/70 p-3">
        <div className="flex items-center justify-between mb-1.5">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-purple-600 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-white">
            <Brain className="h-3 w-3" /> AI Consult · Provider Notes
          </span>
          <span className="text-[10px] font-mono text-purple-700/80">
            {aiNote?.created_at ? fmtTime(aiNote.created_at) : "Pending"}
          </span>
        </div>
        {aiNote ? (
          <p className="text-[12.5px] leading-relaxed text-purple-950 whitespace-pre-wrap">
            {aiNote.content}
          </p>
        ) : (
          <p className="text-[12px] italic text-purple-700/70">
            No AI differential posted yet — Ghost AI Engine analyzes within 10s of admission.
          </p>
        )}
      </div>

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
              onClick={saveDraft}
              className="inline-flex items-center gap-1.5 rounded bg-emerald-700 text-white px-3 h-8 text-[11px] font-bold uppercase tracking-wider hover:bg-emerald-800"
            >
              <ShieldCheck className="h-3.5 w-3.5" /> Save
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
    </div>
  );
}

function SummaryView({ mrn, patient }: { mrn: string; patient: PatientRecord }) {
  const labs = useLabs(mrn, patient.chief_complaint);
  const meds = useMeds(patient.id, patient.mrn, patient.chief_complaint);
  const [notes] = useNotes(mrn, 0);

  const topMeds = (meds ?? []).slice(0, 3);
  const topLabs = (labs ?? []).slice(0, 10);
  const latestNote = (notes ?? [])[0];

  return (
    <div className="space-y-3">
      <ClinicalSummary
        patient={patient}
        meds={meds}
        labs={labs}
        latestNote={latestNote}
        notesLoading={notes === null}
        topMeds={topMeds}
        topLabs={topLabs}
      />
      <section className={widgetBox}>
        <WidgetHeader title="Invoices & Payment (MySPEHR)" />
        <PatientInvoicesPanel mrn={mrn} />
      </section>
    </div>
  );
}

// ============= Clinical summary widgets ================================
const widgetBox =
  "rounded border border-slate-300 bg-white shadow-[0_1px_0_rgba(0,0,0,0.04)]";
const widgetHead =
  "flex items-center justify-between px-2.5 py-1.5 border-b border-slate-300 bg-[#fdfbe8] text-[12px] font-semibold text-emerald-800";

function WidgetHeader({ title, icon }: { title: string; icon?: React.ReactNode }) {
  return (
    <div className={widgetHead}>
      <div className="flex items-center gap-1.5">
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-600 inline-block" />
        <span className="underline decoration-emerald-700/40 underline-offset-2">{title}</span>
      </div>
      <div className="flex items-center gap-1 text-slate-500">
        {icon}
        <ChevronUp className="h-3.5 w-3.5" />
      </div>
    </div>
  );
}

function ClinicalSummary({
  patient,
  meds,
  labs,
  latestNote,
  notesLoading,
  topMeds,
  topLabs,
}: {
  patient: PatientRecord;
  meds: MedRow[] | null;
  labs: LabRow[] | null;
  latestNote: NoteRow | undefined;
  notesLoading: boolean;
  topMeds: MedRow[];
  topLabs: LabRow[];
}) {
  const admissionDate = patient.admission_time
    ? new Date(patient.admission_time).toLocaleDateString("en-GB").replace(/\//g, "/")
    : "—";
  return (
    <div className="bg-[#f7f5ef] border border-slate-300 rounded">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-300 bg-[#f0ecdc]">
        <div className="flex items-center gap-2">
          <ChevronUp className="h-4 w-4 text-slate-600" />
          <h2 className="text-[15px] font-semibold text-slate-800">Summary</h2>
        </div>
        <div className="flex items-center gap-2 text-slate-500">
          <Settings className="h-4 w-4" />
        </div>
      </div>
      <div className="px-3 py-2 text-[11px] text-emerald-700 font-semibold">
        ● Widget data for {admissionDate} (REG ER)
      </div>

      <AdmissionCaseHistory mrn={patient.mrn} />

      <div className="grid grid-cols-12 gap-2 px-2 pb-3">
        {/* LEFT COLUMN — Triage Info + Common Labs */}
        <div className="col-span-12 lg:col-span-5 space-y-2">
          <section className={widgetBox}>
            <WidgetHeader title="Triage Info" />
            <dl className="grid grid-cols-[140px_1fr] gap-y-1 px-2.5 py-2 text-[12px]">
              <dt className="text-slate-600">Triage Note</dt><dd className="text-slate-800">—</dd>
              <dt className="text-slate-600">ED Triage Level</dt>
              <dd className="font-semibold text-slate-800">URGENT</dd>
              <dt className="text-slate-600">Stated Complaint</dt>
              <dd className="text-slate-800">{patient.chief_complaint ?? "—"}</dd>
              <dt className="text-slate-600">Chief Complaint</dt>
              <dd className="text-slate-800">{patient.chief_complaint ?? "—"}</dd>
              <dt className="text-slate-600">Condition</dt><dd className="text-slate-800">—</dd>
              <dt className="text-slate-600">Arrival Date/Time</dt>
              <dd className="text-slate-800">{fmtTime(patient.admission_time)}</dd>
              <dt className="text-slate-600">Arrival Mode</dt>
              <dd className="text-slate-800">No Ambulance</dd>
              <dt className="text-slate-600">Triaged At</dt>
              <dd className="text-slate-800">{fmtTime(patient.admission_time)}</dd>
              <dt className="text-slate-600">ED Location</dt>
              <dd className="text-slate-800">SA Main ED</dd>
              <dt className="text-slate-600">Area/Station</dt>
              <dd className="text-slate-800">{patient.room ?? "Acute A11"}</dd>
            </dl>
          </section>

          <section className={widgetBox}>
            <WidgetHeader title="Common Labs" />
            {labs === null ? (
              <div className="p-3"><Loader2 className="h-4 w-4 animate-spin text-slate-400" /></div>
            ) : topLabs.length === 0 ? (
              <div className="px-3 py-4 text-[12px] italic text-slate-500">No labs released.</div>
            ) : (
              <ul className="divide-y divide-slate-200">
                {topLabs.map((l) => {
                  const abnormal = /\[(CRITICAL|HIGH|LOW|H|L|ABN)/i.test(l.result_value ?? "");
                  const display = l.result_value ?? "Pending";
                  return (
                    <li key={l.id} className="grid grid-cols-[110px_1fr_70px] gap-2 px-2.5 py-1.5 text-[12px] items-center">
                      <span className="text-slate-700 truncate">{l.test_type}</span>
                      <span className={`font-mono text-[11.5px] truncate ${abnormal ? "bg-yellow-200 text-slate-900 px-1 rounded font-bold" : "text-slate-700"}`}>
                        {display}
                      </span>
                      <span className="font-mono text-[10.5px] text-slate-500 text-right">
                        {fmtTime(l.created_at).split(",")[0]}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <section className={widgetBox}>
            <WidgetHeader title="Active Medications" icon={<Pill className="h-3.5 w-3.5" />} />
            {meds === null ? (
              <div className="p-3"><Loader2 className="h-4 w-4 animate-spin text-slate-400" /></div>
            ) : topMeds.length === 0 ? (
              <div className="px-3 py-4 text-[12px] italic text-slate-500">No active medications.</div>
            ) : (
              <ul className="divide-y divide-slate-200">
                {topMeds.map((m) => (
                  <li key={m.id} className="px-2.5 py-1.5 flex items-center justify-between text-[12px]">
                    <div className="min-w-0">
                      <div className="font-semibold text-slate-800 truncate">
                        {m.medication_name ?? m.drug_name ?? m.medication ?? "—"}
                      </div>
                      <div className="font-mono text-[10.5px] text-slate-500">
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

        {/* CENTER COLUMN — Visits + Documents */}
        <div className="col-span-12 lg:col-span-4 space-y-2">
          <section className={widgetBox}>
            <WidgetHeader title="Visits" icon={<Calendar className="h-3.5 w-3.5" />} />
            <div className="text-[12px]">
              <div className="px-2.5 py-1.5 border-b border-slate-200 flex items-center gap-1 text-slate-700 font-semibold">
                <ChevronUp className="h-3.5 w-3.5 rotate-90" /> Future
              </div>
              <div className="px-2.5 py-1.5 border-b border-slate-200 flex items-center gap-1 text-slate-700 font-semibold">
                <ChevronUp className="h-3.5 w-3.5" /> Past
              </div>
              <div className="grid grid-cols-[80px_1fr_24px] px-2.5 py-1.5 bg-slate-50 text-[10px] uppercase tracking-wider text-slate-500 font-bold border-b border-slate-200">
                <span>Date</span><span>Location / Provider</span><span></span>
              </div>
              <div className="grid grid-cols-[80px_1fr_24px] px-2.5 py-1.5 border-b border-slate-100 items-start">
                <span className="font-mono text-[11px] text-slate-600">{fmtTime(patient.admission_time).split(",")[0]}</span>
                <div>
                  <div className="text-slate-800">Emergency Department</div>
                  <div className="text-slate-500 text-[11px]">{patient.chief_complaint ?? "—"}</div>
                </div>
                <FileText className="h-3.5 w-3.5 text-slate-400" />
              </div>
              <div className="grid grid-cols-[80px_1fr_24px] px-2.5 py-1.5 border-b border-slate-100 items-start">
                <span className="font-mono text-[11px] text-slate-600">—</span>
                <div>
                  <div className="text-slate-800">Medical (3B)</div>
                  <div className="text-slate-500 text-[11px]">Garniss, Derek A, MD</div>
                </div>
                <FileText className="h-3.5 w-3.5 text-slate-400" />
              </div>
            </div>
          </section>

          <section className={widgetBox}>
            <WidgetHeader title="Documents" icon={<FileText className="h-3.5 w-3.5" />} />
            <div className="text-[12px]">
              <div className="px-2.5 py-1.5 border-b border-slate-200 flex items-center justify-between text-slate-700">
                <span className="flex items-center gap-1 font-semibold">
                  <ChevronUp className="h-3.5 w-3.5" /> Departmental
                </span>
                <span className="text-[10.5px] text-slate-500">Most Recent</span>
              </div>
              {notesLoading ? (
                <div className="p-3"><Loader2 className="h-4 w-4 animate-spin text-slate-400" /></div>
              ) : !latestNote ? (
                <div className="px-3 py-4 text-[12px] italic text-slate-500">No documents on file.</div>
              ) : (
                <ul className="divide-y divide-slate-200">
                  <li className="grid grid-cols-[1fr_24px_80px] px-2.5 py-1.5 items-center text-[12px]">
                    <span className="text-slate-800 truncate">{latestNote.note_type ?? "Note"}</span>
                    <FileText className="h-3.5 w-3.5 text-slate-400" />
                    <span className="font-mono text-[10.5px] text-slate-500 text-right">{fmtTime(latestNote.signed_at).split(",")[0]}</span>
                  </li>
                </ul>
              )}
            </div>
          </section>
        </div>

        {/* RIGHT COLUMN — Clinical sidebar */}
        <div className="col-span-12 lg:col-span-3 space-y-2">
          <section className={widgetBox}>
            <WidgetHeader title="Active" />
            <div className="px-2.5 py-2 text-[12px]">
              <div className="grid grid-cols-3 gap-1 pb-1 border-b border-slate-200 text-[9.5px] uppercase tracking-wider text-slate-500 font-bold">
                <span>Problem</span><span>Curr Visit</span><span>Onset</span>
              </div>
              <div className="grid grid-cols-3 gap-1 py-1.5 text-slate-800">
                <span className="font-semibold">{patient.chief_complaint ?? "—"}</span>
                <span>●</span>
                <span className="font-mono text-[10.5px] text-slate-500">{fmtTime(patient.admission_time).split(",")[0]}</span>
              </div>
            </div>
          </section>

          <section className={widgetBox}>
            <WidgetHeader title="Allergies" />
            <div className="px-2.5 py-2 text-[12px] space-y-1">
              <div className="flex items-center justify-between">
                <span className="text-slate-800 font-semibold">cefazolin (From Ancef)</span>
                <span className="text-slate-500">Diarrhea</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-slate-800 font-semibold">penicillin G</span>
                <span className="text-slate-500">Rash</span>
              </div>
            </div>
          </section>

          <section className={widgetBox}>
            <WidgetHeader title="Vitals — Initial & Most Recent" icon={<TrendingUp className="h-3.5 w-3.5" />} />
            <div className="px-2.5 py-2 text-[12px]">
              <div className="text-[11px] text-blue-700 underline mb-1 cursor-pointer">Growth Chart</div>
              <div className="grid grid-cols-[60px_1fr] gap-y-1">
                <span className="text-slate-500 text-[10px] uppercase tracking-wider font-bold col-span-2 border-b border-slate-200 pb-1">
                  Current — <LiveClock />
                </span>
                <span className="text-slate-600">BP</span>
                <span className={`font-mono ${(patient.bp_systolic ?? 0) >= 140 ? "bg-yellow-200 px-1 rounded font-bold" : ""}`}>
                  {patient.bp_systolic ?? "—"}/{patient.bp_diastolic ?? "—"}{(patient.bp_systolic ?? 0) >= 140 ? " H" : ""}
                </span>
                <span className="text-slate-600">Pulse</span>
                <span className="font-mono">{patient.hr ?? "—"}</span>
                <span className="text-slate-600">SpO₂</span>
                <span className={`font-mono ${(patient.spo2 ?? 100) < 92 ? "bg-yellow-200 px-1 rounded font-bold" : ""}`}>
                  {patient.spo2 ?? "—"}%
                </span>
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

// ============= Clinical-style tab content for new tabs =================
function ActivityView({ mrn, patient }: { mrn: string; patient: PatientRecord }) {
  const labs = useLabs(mrn, patient.chief_complaint);
  const meds = useMeds(patient.id, patient.mrn, patient.chief_complaint);
  const [notes] = useNotes(mrn, 0);

  type Item = { ts: string | null; type: string; title: string; detail: string };
  const items: Item[] = [];
  if (patient.admission_time) {
    items.push({
      ts: patient.admission_time, type: "Admission",
      title: "Patient admitted to ED",
      detail: `${patient.chief_complaint ?? "—"} · ${patient.room ?? "—"}`,
    });
  }
  (meds ?? []).forEach((m) => items.push({
    ts: m.administered_at ?? m.created_at, type: "Medication",
    title: m.medication_name ?? m.drug_name ?? m.medication ?? "Medication",
    detail: `${m.dose ?? ""} ${m.route ?? ""} · ${m.status ?? ""}`,
  }));
  (labs ?? []).forEach((l) => items.push({
    ts: l.created_at, type: "Lab",
    title: l.test_type ?? "Lab", detail: l.result_value ?? "—",
  }));
  (notes ?? []).forEach((n) => items.push({
    ts: n.signed_at, type: "Note",
    title: n.note_type ?? "Note", detail: `${n.author_name ?? ""} ${n.author_role ?? ""}`,
  }));
  items.sort((a, b) => (new Date(b.ts ?? 0).getTime() - new Date(a.ts ?? 0).getTime()));

  const colorFor = (t: string) =>
    t === "Admission" ? "bg-indigo-100 text-indigo-800 ring-indigo-300"
    : t === "Medication" ? "bg-emerald-100 text-emerald-800 ring-emerald-300"
    : t === "Lab" ? "bg-blue-100 text-blue-800 ring-blue-300"
    : "bg-slate-100 text-slate-700 ring-slate-300";

  return (
    <div className={widgetBox}>
      <WidgetHeader title="Encounter Activity Timeline" icon={<Activity className="h-3.5 w-3.5" />} />
      {items.length === 0 ? emptyMsg : (
        <ol className="divide-y divide-slate-200">
          {items.map((it, i) => (
            <li key={i} className="grid grid-cols-[110px_90px_1fr] gap-2 px-3 py-2 text-[12px] items-start">
              <span className="font-mono text-[10.5px] text-slate-600">{fmtTime(it.ts)}</span>
              <span className={`inline-flex justify-center rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide ring-1 ${colorFor(it.type)}`}>
                {it.type}
              </span>
              <div>
                <div className="font-semibold text-slate-800">{it.title}</div>
                <div className="text-slate-600 text-[11.5px]">{it.detail}</div>
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function FlowsheetsView({ patient }: { patient: PatientRecord }) {
  // Synthesize a vitals trend (4 timepoints) based on baseline
  const base = baselineVitals(patient.diagnosis ?? patient.chief_complaint);
  const cols = [0, 1, 2, 3].map((i) => {
    const t = new Date(Date.now() - i * 60 * 60 * 1000);
    return {
      time: t.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      hr: base.hr + ((i * 3) % 5),
      sys: base.sys - ((i * 2) % 4),
      dia: base.dia - ((i) % 3),
      spo2: base.spo2 - ((i) % 2),
      temp: 36.8 + ((i * 1) % 3) * 0.1,
      resp: 18 + ((i * 2) % 4),
    };
  }).reverse();

  return (
    <div className={widgetBox + " overflow-hidden"}>
      <WidgetHeader title="Vital Signs Flowsheet" icon={<TrendingUp className="h-3.5 w-3.5" />} />
      <table className="w-full text-[12px]">
        <thead>
          <tr>
            <th className={thClass}>Parameter</th>
            {cols.map((c) => <th key={c.time} className={thClass + " text-center"}>{c.time}</th>)}
          </tr>
        </thead>
        <tbody>
          {[
            { lbl: "BP (mmHg)", val: (c: any) => `${c.sys}/${c.dia}`, abn: (c: any) => c.sys >= 140 || c.sys < 90 },
            { lbl: "Pulse (bpm)", val: (c: any) => c.hr, abn: (c: any) => c.hr > 100 || c.hr < 60 },
            { lbl: "Resp (rpm)", val: (c: any) => c.resp, abn: (c: any) => c.resp > 20 },
            { lbl: "SpO₂ (%)", val: (c: any) => c.spo2, abn: (c: any) => c.spo2 < 92 },
            { lbl: "Temp (°C)", val: (c: any) => c.temp.toFixed(1), abn: (c: any) => c.temp >= 38 },
          ].map((r) => (
            <tr key={r.lbl} className="hover:bg-slate-50">
              <td className={tdClass + " font-semibold"}>{r.lbl}</td>
              {cols.map((c) => (
                <td key={c.time} className={tdClass + " text-center font-mono"}>
                  <span className={r.abn(c) ? "bg-yellow-200 px-1 rounded font-bold" : ""}>{r.val(c)}</span>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function HistoryProblemsView({ patient }: { patient: PatientRecord }) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
      <section className={widgetBox}>
        <WidgetHeader title="Active Problems" />
        <ul className="divide-y divide-slate-200 text-[12px]">
          <li className="px-3 py-2 flex justify-between">
            <span className="font-semibold text-slate-800">{patient.chief_complaint ?? "—"}</span>
            <span className="font-mono text-[10.5px] text-slate-500">{fmtTime(patient.admission_time).split(",")[0]}</span>
          </li>
          {patient.diagnosis && patient.diagnosis !== patient.chief_complaint ? (
            <li className="px-3 py-2 flex justify-between">
              <span className="font-semibold text-slate-800">{patient.diagnosis}</span>
              <span className="font-mono text-[10.5px] text-slate-500">Active</span>
            </li>
          ) : null}
        </ul>
      </section>
      <section className={widgetBox}>
        <WidgetHeader title="Past Medical History" />
        <ul className="divide-y divide-slate-200 text-[12px]">
          <li className="px-3 py-2 text-slate-700">Hypertension — controlled</li>
          <li className="px-3 py-2 text-slate-700">Type 2 Diabetes Mellitus</li>
          <li className="px-3 py-2 text-slate-700">Hyperlipidemia</li>
        </ul>
      </section>
      <section className={widgetBox}>
        <WidgetHeader title="Allergies" />
        <ul className="divide-y divide-slate-200 text-[12px]">
          <li className="px-3 py-2 flex justify-between"><span className="font-semibold">cefazolin (From Ancef)</span><span className="text-slate-500">Diarrhea</span></li>
          <li className="px-3 py-2 flex justify-between"><span className="font-semibold">penicillin G</span><span className="text-slate-500">Rash</span></li>
        </ul>
      </section>
      <section className={widgetBox}>
        <WidgetHeader title="Surgical History" />
        <ul className="divide-y divide-slate-200 text-[12px]">
          <li className="px-3 py-2 text-slate-700">Appendectomy — 2012</li>
          <li className="px-3 py-2 text-slate-700">Cholecystectomy — 2018</li>
        </ul>
      </section>
    </div>
  );
}

function AdministrativeView({ patient }: { patient: PatientRecord }) {
  const fullName = `${patient.first_name ?? ""} ${patient.last_name ?? ""}`.trim() || "Unknown";
  const age = mockAgeFromName(patient.first_name, patient.age);
  const dob = mockDobFromAge(age);
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
      <section className={widgetBox}>
        <WidgetHeader title="Demographics" />
        <dl className="grid grid-cols-[140px_1fr] gap-y-1 px-3 py-2 text-[12px]">
          <dt className="text-slate-600">Name</dt><dd className="font-semibold text-slate-800">{fullName}</dd>
          <dt className="text-slate-600">MRN</dt><dd className="font-mono text-slate-800">{patient.mrn}</dd>
          <dt className="text-slate-600">Date of Birth</dt><dd className="font-mono text-slate-800">{dob}</dd>
          <dt className="text-slate-600">Age</dt><dd className="text-slate-800">{age}</dd>
          <dt className="text-slate-600">Sex</dt><dd className="text-slate-800">{patient.gender ?? "—"}</dd>
          <dt className="text-slate-600">Room</dt><dd className="font-mono text-slate-800">{patient.room ?? "—"}</dd>
        </dl>
      </section>
      <section className={widgetBox}>
        <WidgetHeader title="Encounter / Account" />
        <dl className="grid grid-cols-[140px_1fr] gap-y-1 px-3 py-2 text-[12px]">
          <dt className="text-slate-600">Account #</dt><dd className="font-mono text-slate-800">SE{patient.mrn.slice(-7)}</dd>
          <dt className="text-slate-600">Admit Time</dt><dd className="font-mono text-slate-800">{fmtTime(patient.admission_time)}</dd>
          <dt className="text-slate-600">Service</dt><dd className="text-slate-800">Emergency Medicine</dd>
          <dt className="text-slate-600">Status</dt><dd className="text-slate-800">Inpatient</dd>
          <dt className="text-slate-600">Code Status</dt><dd className="text-slate-800">{patient.code_status ?? "Full Code"}</dd>
        </dl>
      </section>
      <section className={widgetBox}>
        <WidgetHeader title="Insurance / Payor" />
        <dl className="grid grid-cols-[140px_1fr] gap-y-1 px-3 py-2 text-[12px]">
          <dt className="text-slate-600">Primary</dt><dd className="text-slate-800">Blue Cross — PPO</dd>
          <dt className="text-slate-600">Policy #</dt><dd className="font-mono text-slate-800">BC{patient.mrn.slice(-6)}</dd>
          <dt className="text-slate-600">Group</dt><dd className="font-mono text-slate-800">GRP-002841</dd>
        </dl>
      </section>
      <section className={widgetBox}>
        <WidgetHeader title="Contacts" />
        <dl className="grid grid-cols-[140px_1fr] gap-y-1 px-3 py-2 text-[12px]">
          <dt className="text-slate-600">Emergency Contact</dt><dd className="text-slate-800">Spouse — (555) 200-4815</dd>
          <dt className="text-slate-600">PCP</dt><dd className="text-slate-800">Dr. Garniss, Derek A, MD</dd>
        </dl>
      </section>
      <section className={`${widgetBox} md:col-span-2`}>
        <WidgetHeader title="Invoices (MySPEHR)" />
        <PatientInvoicesPanel mrn={patient.mrn} />
      </section>
    </div>
  );
}

function PatientInvoicesPanel({ mrn }: { mrn: string }) {
  const [rows, setRows] = useState<Array<{
    id: string;
    invoice_no: string;
    status: string;
    total: number | string | null;
    currency: string | null;
    issued_at: string | null;
    paid_at: string | null;
  }>>([]);
  const [loading, setLoading] = useState(true);
  const [payingId, setPayingId] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    const { data } = await supabase
      .from("fhir_invoices")
      .select("id,invoice_no,status,total,currency,issued_at,paid_at")
      .eq("mrn", mrn)
      .order("issued_at", { ascending: false });
    setRows((data ?? []) as any);
    setLoading(false);
  };
  useEffect(() => { void load(); }, [mrn]);

  const pay = async (invId: string, amount: number, currency: string) => {
    setPayingId(invId);
    try {
      const nowIso = new Date().toISOString();
      const { error: pnErr } = await supabase.from("fhir_payment_notices").insert({
        invoice_id: invId,
        mrn,
        amount,
        currency: currency || "USD",
        status: "active",
        payment_date: nowIso,
        payment_method: "MySPEHR patient portal",
        payload: {
          resourceType: "PaymentNotice",
          status: "active",
          request: { reference: `Invoice/${invId}` },
          amount: { value: amount, currency: currency || "USD" },
          paymentStatus: {
            coding: [{
              system: "http://terminology.hl7.org/CodeSystem/paymentstatus",
              code: "paid",
            }],
          },
          created: nowIso,
        },
      } as any);
      if (pnErr) throw pnErr;
      const { error: upErr } = await supabase
        .from("fhir_invoices")
        .update({ status: "balanced", paid_at: nowIso } as any)
        .eq("id", invId);
      if (upErr) throw upErr;
      toast.success("Payment recorded");
      await load();
    } catch (e: any) {
      toast.error(`Payment failed: ${e?.message ?? String(e)}`);
    } finally {
      setPayingId(null);
    }
  };

  if (loading) return <div className="px-3 py-2 text-[12px] text-slate-500">Loading invoices…</div>;
  if (rows.length === 0) return <div className="px-3 py-2 text-[12px] text-slate-500">No invoices on file.</div>;
  return (
    <table className="w-full text-[12px]">
      <thead className="bg-slate-50 text-slate-600">
        <tr>
          <th className="text-left px-3 py-1.5">Invoice #</th>
          <th className="text-left px-3 py-1.5">Status</th>
          <th className="text-right px-3 py-1.5">Total</th>
          <th className="text-right px-3 py-1.5">Action</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const amount = Number(r.total ?? 0);
          const currency = r.currency ?? "USD";
          return (
            <tr key={r.id} className="border-t border-slate-100">
              <td className="px-3 py-1.5 font-mono">{r.invoice_no}</td>
              <td className="px-3 py-1.5">{r.status}</td>
              <td className="px-3 py-1.5 text-right font-mono">{amount.toFixed(2)} {currency}</td>
              <td className="px-3 py-1.5 text-right">
                {r.status === "balanced" ? (
                  <span className="text-emerald-700">Paid</span>
                ) : (
                  <button
                    disabled={payingId === r.id}
                    onClick={() => pay(r.id, amount, currency)}
                    className="px-2 py-1 rounded bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50"
                  >
                    {payingId === r.id ? "Paying…" : "Pay Invoice"}
                  </button>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function NurseView({ patient }: { patient: PatientRecord }) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
      <section className={widgetBox}>
        <WidgetHeader title="Nursing Assessment" />
        <dl className="grid grid-cols-[160px_1fr] gap-y-1 px-3 py-2 text-[12px]">
          <dt className="text-slate-600">LOC</dt><dd>Alert &amp; Oriented x3</dd>
          <dt className="text-slate-600">Pain Score</dt><dd className="font-mono">4/10</dd>
          <dt className="text-slate-600">Fall Risk</dt><dd>Moderate (Morse 45)</dd>
          <dt className="text-slate-600">Skin Integrity</dt><dd>Intact</dd>
          <dt className="text-slate-600">Mobility</dt><dd>Independent</dd>
          <dt className="text-slate-600">IV Access</dt><dd>20g LFA — patent</dd>
        </dl>
      </section>
      <section className={widgetBox}>
        <WidgetHeader title="Intake &amp; Output (8 hr)" />
        <table className="w-full text-[12px]">
          <thead><tr><th className={thClass}>Type</th><th className={thClass + " text-right"}>Volume (mL)</th></tr></thead>
          <tbody>
            <tr><td className={tdClass}>PO</td><td className={tdClass + " font-mono text-right"}>240</td></tr>
            <tr><td className={tdClass}>IV NS @ 100/hr</td><td className={tdClass + " font-mono text-right"}>800</td></tr>
            <tr><td className={tdClass}>Urine</td><td className={tdClass + " font-mono text-right"}>650</td></tr>
            <tr><td className={tdClass + " font-bold"}>Net</td><td className={tdClass + " font-mono font-bold text-right"}>+390</td></tr>
          </tbody>
        </table>
      </section>
      <section className={widgetBox + " md:col-span-2"}>
        <WidgetHeader title="Allied Health Consults" />
        <ul className="divide-y divide-slate-200 text-[12px]">
          <li className="px-3 py-2 flex justify-between"><span>Nutrition Services</span><span className="text-emerald-700 font-semibold">Active</span></li>
          <li className="px-3 py-2 flex justify-between"><span>Physical Therapy</span><span className="text-slate-500">Pending eval</span></li>
          <li className="px-3 py-2 flex justify-between"><span>Care Management</span><span className="text-slate-500">Pending</span></li>
        </ul>
      </section>
    </div>
  );
}

function OtherClinicalView({ patient }: { patient: PatientRecord }) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
      <section className={widgetBox}>
        <WidgetHeader title="Imaging" />
        <ul className="divide-y divide-slate-200 text-[12px]">
          <li className="px-3 py-2 flex justify-between"><span>CXR — Portable</span><span className="text-emerald-700 font-semibold">Resulted</span></li>
          <li className="px-3 py-2 flex justify-between"><span>CT Abdomen w/ contrast</span><span className="text-amber-700 font-semibold">In Progress</span></li>
        </ul>
      </section>
      <section className={widgetBox}>
        <WidgetHeader title="Microbiology" />
        <ul className="divide-y divide-slate-200 text-[12px]">
          <li className="px-3 py-2 flex justify-between"><span>Blood Culture x2</span><span className="text-slate-500">Pending — 24h</span></li>
          <li className="px-3 py-2 flex justify-between"><span>UA / Urine Cx</span><span className="text-emerald-700 font-semibold">Resulted</span></li>
        </ul>
      </section>
      <section className={widgetBox + " md:col-span-2"}>
        <WidgetHeader title="Diet / Activity Orders" />
        <dl className="grid grid-cols-[160px_1fr] gap-y-1 px-3 py-2 text-[12px]">
          <dt className="text-slate-600">Diet</dt><dd>Regular, as tolerated</dd>
          <dt className="text-slate-600">Activity</dt><dd>Ambulate with assist</dd>
          <dt className="text-slate-600">Precautions</dt><dd>Standard + Fall</dd>
        </dl>
      </section>
    </div>
  );
}

function HealthMgmtView({ patient }: { patient: PatientRecord }) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
      <section className={widgetBox}>
        <WidgetHeader title="Care Plan Goals" />
        <ul className="divide-y divide-slate-200 text-[12px]">
          <li className="px-3 py-2">Stabilize hemodynamics — pulse &lt; 100, MAP &gt; 65</li>
          <li className="px-3 py-2">Pain controlled to &lt; 4/10 within 6h</li>
          <li className="px-3 py-2">Identify infectious source — cultures + imaging</li>
        </ul>
      </section>
      <section className={widgetBox}>
        <WidgetHeader title="Preventive / Screening" />
        <ul className="divide-y divide-slate-200 text-[12px]">
          <li className="px-3 py-2 flex justify-between"><span>Influenza Vaccine</span><span className="text-emerald-700 font-semibold">Up to date</span></li>
          <li className="px-3 py-2 flex justify-between"><span>Pneumococcal</span><span className="text-amber-700 font-semibold">Due</span></li>
          <li className="px-3 py-2 flex justify-between"><span>Tobacco Screening</span><span className="text-emerald-700 font-semibold">Completed</span></li>
        </ul>
      </section>
    </div>
  );
}

function PatientChart() {
  const { mrn } = useParams({ from: "/patient/$mrn" });
  const navigate = useNavigate();
  const [patient, setPatient] = useState<PatientRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<TabKey | null>("summary");
  const [ordersOpen, setOrdersOpen] = useState(false);
  const [dischargeOpen, setDischargeOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [workloadCount, setWorkloadCount] = useState<number>(0);
  const automationEnabled = useAutomationEnabled();
  const pending = usePendingChanges();
  const [signOpen, setSignOpen] = useState(false);
  const [signPin, setSignPin] = useState("");
  const [signError, setSignError] = useState<string | null>(null);
  const [signing, setSigning] = useState(false);
  const [cdsPanelOpen, setCdsPanelOpen] = useState(false);
  const { suggestion: cdsSuggestion, refresh: refreshCds } = useCdsActiveSuggestion(mrn);
  const dismissCds = async () => {
    if (!cdsSuggestion) return;
    await supabase
      .from("cds_suggestions")
      .update({ dismissed: true })
      .eq("id", cdsSuggestion.id);
    setCdsPanelOpen(false);
    refreshCds();
  };

  const openSign = () => {
    if (pending.length === 0) {
      toast.info("No unsigned changes — make an edit and click Save first");
      return;
    }
    setSignPin("");
    setSignError(null);
    setSignOpen(true);
  };

  const verifyAndCommitAll = async () => {
    if (signPin !== "1234") {
      setSignError("Invalid Signature PIN.");
      return;
    }
    setSigning(true);
    const items = pendingStore.get();
    let ok = 0;
    for (const it of items) {
      try {
        await it.commit();
        pendingStore.remove(it.id);
        ok++;
      } catch (e: any) {
        toast.error(`Failed to sign "${it.label}": ${e?.message ?? "error"}`);
      }
    }
    setSigning(false);
    setSignOpen(false);
    if (ok > 0) toast.success(`Signed & saved ${ok} change${ok === 1 ? "" : "s"}`);
  };

  // Live workload badge — pending labs+meds for this patient
  useEffect(() => {
    if (!patient) return;
    let cancelled = false;
    const refresh = async () => {
      const [labs, meds] = await Promise.all([
        supabase.from("lab_orders").select("id", { count: "exact", head: true })
          .eq("patient_mrn", patient.mrn).in("status", ["Ordered", "Processing", "ORDERED", "PROCESSING"]),
        supabase.from("medication_orders").select("id", { count: "exact", head: true })
          .eq("patient_mrn", patient.mrn).in("status", ["Ordered", "Pending Verification", "Dispensed", "ORDERED", "PENDING_VERIFICATION", "DISPENSED"]),
      ]);
      if (cancelled) return;
      setWorkloadCount((labs.count ?? 0) + (meds.count ?? 0));
    };
    refresh();
    const ch = supabase
      .channel(`patient-workload-${patient.mrn}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "lab_orders", filter: `patient_mrn=eq.${patient.mrn}` }, refresh)
      .on("postgres_changes", { event: "*", schema: "public", table: "medication_orders", filter: `patient_mrn=eq.${patient.mrn}` }, refresh)
      .subscribe();
    return () => { cancelled = true; supabase.removeChannel(ch); };
  }, [patient?.mrn]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      const { data, error } = await supabase
        .from("patients")
        .select("id, mrn, first_name, last_name, age, gender, room, code_status, chief_complaint, diagnosis, hr, bp_systolic, bp_diastolic, spo2, admission_time, facility_name")
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

  const handleSuspend = async () => {
    if (!confirm("Suspend session and sign out?")) return;
    await supabase.auth.signOut().catch(() => {});
    toast.success("Session suspended");
    navigate({ to: "/" }).catch(() => {});
  };

  const refreshChart = () => {
    toast.info("Refreshing chart…");
    window.location.reload();
  };

  const handlePrint = () => window.print();

  return (
    <main className="min-h-screen bg-[#e9e7e0]">
      {/* Clinical — Top dark toolbar */}
      <header className="sticky top-0 z-30 bg-[#2c2c2c] text-white shadow">
        <div className="flex items-stretch">
          <Link
            to="/nursing-board"
            className="flex flex-col items-center justify-center px-3 py-1.5 border-r border-white/10 hover:bg-white/10 transition min-w-[64px]"
          >
            <ArrowLeft className="h-4 w-4 text-emerald-400 mb-0.5" />
            <span className="text-[10px] tracking-wide">Return To</span>
          </Link>
          <ToolbarBtn label="Home" icon={<Home className="h-4 w-4" />} onClick={() => navigate({ to: "/" }).catch(() => {})} />
          <ToolbarBtn label="Trackers" icon={<ClipboardList className="h-4 w-4" />} onClick={() => navigate({ to: "/nursing-board" }).catch(() => {})} />
          <ToolbarBtn label="Chart" icon={<FileText className="h-4 w-4" />} active onClick={() => { setTab("summary"); window.scrollTo({ top: 0, behavior: "smooth" }); }} />
          <ToolbarBtn label="Document" icon={<PenLine className="h-4 w-4" />} onClick={() => { setTab("providernotes"); toast.info("Opened Provider Notes — add or sign a note"); }} />
          <ToolbarBtn label="Orders" icon={<FlaskConical className="h-4 w-4" />} onClick={() => setOrdersOpen(true)} />
          <ToolbarBtn label="Discharge" icon={<LogOut className="h-4 w-4" />} onClick={() => setDischargeOpen(true)} />
          <div className="flex-1" />
          <ToolbarBtn side="right" label="Sign" icon={<PenLine className="h-4 w-4" />} badge={pending.length} onClick={openSign} />
          <ToolbarBtn side="right" label="Workload" icon={<ClipboardList className="h-4 w-4" />} badge={workloadCount} onClick={() => navigate({ to: "/tasks" }).catch(() => {})} />
          <div className="relative">
            <ToolbarBtn side="right" label="Menu" icon={<Settings className="h-4 w-4" />} onClick={() => setMenuOpen((v) => !v)} />
            {menuOpen && (
              <div className="absolute right-0 top-full mt-0.5 bg-white text-slate-800 shadow-xl border border-slate-300 rounded-md w-56 z-40">
                <button onClick={() => { setMenuOpen(false); refreshChart(); }} className="w-full text-left px-3 py-2 text-sm hover:bg-slate-100 flex items-center gap-2"><RefreshCw className="h-3.5 w-3.5" /> Refresh Chart</button>
                <button onClick={() => { setMenuOpen(false); handlePrint(); }} className="w-full text-left px-3 py-2 text-sm hover:bg-slate-100 flex items-center gap-2"><Printer className="h-3.5 w-3.5" /> Print Chart</button>
                <button onClick={() => { setMenuOpen(false); navigate({ to: "/physician-board" }).catch(() => {}); }} className="w-full text-left px-3 py-2 text-sm hover:bg-slate-100 flex items-center gap-2"><Users className="h-3.5 w-3.5" /> Switch to Physician Board</button>
                <button onClick={() => { setMenuOpen(false); navigate({ to: "/admin-dashboard" }).catch(() => {}); }} className="w-full text-left px-3 py-2 text-sm hover:bg-slate-100 flex items-center gap-2"><Settings className="h-3.5 w-3.5" /> Admin Dashboard</button>
                <div className="border-t border-slate-200" />
                <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-slate-500">Automation: {automationEnabled ? "ON" : "OFF"}</div>
              </div>
            )}
          </div>
          <ToolbarBtn side="right" label="Suspend" icon={<Power className="h-4 w-4 text-red-400" />} onClick={handleSuspend} />
        </div>
      </header>

      {ordersOpen && (
        <OrdersDialog patient={patient} automationEnabled={automationEnabled} onClose={() => setOrdersOpen(false)} />
      )}
      <DischargeConformanceBanner mrn={patient.mrn} />
      <SafetyAlertBanner mrn={patient.mrn} />
      {cdsPanelOpen && cdsSuggestion && (
        <CdsProtocolModal
          suggestion={cdsSuggestion}
          onDismiss={dismissCds}
          onClose={() => setCdsPanelOpen(false)}
        />
      )}
      {dischargeOpen && (
        <DischargeDialog patient={patient} onClose={() => setDischargeOpen(false)} onDone={() => { setDischargeOpen(false); navigate({ to: "/nursing-board" }).catch(() => {}); }} />
      )}

      {signOpen && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4">
          <div className="w-full max-w-sm rounded-lg bg-white shadow-2xl border-t-4 border-[var(--teal,#13b5b1)]">
            <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200">
              <div className="flex items-center gap-2">
                <ShieldCheck className="h-4 w-4 text-[var(--navy,#0b2545)]" />
                <h3 className="text-[12px] font-bold uppercase tracking-wider text-slate-800">
                  Digital Signature Verification
                </h3>
              </div>
              <button onClick={() => setSignOpen(false)} className="text-slate-400 hover:text-slate-700"><X className="h-4 w-4" /></button>
            </div>
            <div className="p-5 space-y-3">
              <p className="text-[12px] text-slate-600">
                Enter your 4-digit clinician PIN to permanently sign and save the following unsigned change{pending.length === 1 ? "" : "s"}:
              </p>
              <ul className="rounded border border-slate-200 bg-slate-50 divide-y divide-slate-200 text-[11.5px]">
                {pending.map((p) => (
                  <li key={p.id} className="px-2.5 py-1.5 flex items-center gap-2">
                    <PenLine className="h-3 w-3 text-slate-400" />
                    <span className="truncate text-slate-700">{p.label}</span>
                  </li>
                ))}
              </ul>
              <input
                type="password"
                inputMode="numeric"
                maxLength={4}
                value={signPin}
                onChange={(e) => { setSignPin(e.target.value.replace(/\D/g, "").slice(0, 4)); setSignError(null); }}
                onKeyDown={(e) => e.key === "Enter" && verifyAndCommitAll()}
                autoFocus
                placeholder="••••"
                className="w-full h-12 rounded border-2 border-slate-300 px-3 text-center font-mono text-2xl tracking-[0.6em] focus:outline-none focus:border-[var(--teal,#13b5b1)]"
              />
              {signError && <p className="text-[11.5px] font-bold text-red-600 text-center">{signError}</p>}
              <button
                onClick={verifyAndCommitAll}
                disabled={signing || signPin.length !== 4}
                className="w-full rounded bg-emerald-700 text-white px-3 h-9 text-[11px] font-bold uppercase tracking-wider hover:bg-emerald-800 disabled:opacity-50"
              >
                {signing ? "Signing…" : "Verify & Sign"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Body — main content + right patient sidebar */}
      <div className="flex">
        {/* Main column */}
        <div className="flex-1 min-w-0 px-2 pt-3 pb-6">
          {/* Clinical tab rows */}
          <nav className="space-y-1.5 mb-3">
            <div className="flex items-center gap-1">
              <div className="flex-1 min-w-0">
                <TabRow tabs={TABS_ROW1} active={tab} onClick={(k) => setTab(k)} variant="blue" />
              </div>
              {cdsSuggestion && (
                <button
                  onClick={() => setCdsPanelOpen(true)}
                  className="inline-flex items-center gap-2 whitespace-nowrap"
                  style={{
                    background: "#fee2e2",
                    border: "1px solid #ef4444",
                    borderRadius: 6,
                    padding: "4px 12px",
                    color: "#991b1b",
                    fontWeight: 600,
                  }}
                >
                  <span className="relative flex h-2 w-2">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-500 opacity-75" />
                    <span className="relative inline-flex rounded-full h-2 w-2 bg-red-600" />
                  </span>
                  <span>🔴 ACS Protocol</span>
                </button>
              )}
            </div>
            <TabRow tabs={TABS_ROW2} active={tab} onClick={(k) => setTab(k)} variant="blue" />
            <TabRow tabs={TABS_ROW3} active={tab} onClick={(k) => setTab(k)} variant="cream" />
          </nav>

          {tab === "summary" ? (
            <SummaryView mrn={patient.mrn} patient={patient} />
          ) : tab === "diagnostics" ? (
            <div className={widgetBox + " overflow-hidden"}>
              <WidgetHeader title="Laboratory Results" icon={<FlaskConical className="h-3.5 w-3.5" />} />
              <LabsView mrn={patient.mrn} complaint={patient.chief_complaint ?? null} />
            </div>
          ) : tab === "medications" ? (
            <div className={widgetBox + " overflow-hidden"}>
              <WidgetHeader title="Medication Administration Record" icon={<Pill className="h-3.5 w-3.5" />} />
              <MarView patientId={patient.id} mrn={patient.mrn} complaint={patient.chief_complaint ?? null} />
            </div>
          ) : tab === "providernotes" ? (
            <div className="space-y-3">
              <div className={widgetBox + " p-3"}>
                <NotesView mrn={patient.mrn} />
              </div>
            </div>
          ) : tab === "activity" ? (
            <ActivityView mrn={patient.mrn} patient={patient} />
          ) : tab === "flowsheets" ? (
            <FlowsheetsView patient={patient} />
          ) : tab === "nurse" ? (
            <NurseView patient={patient} />
          ) : tab === "history" ? (
            <HistoryProblemsView patient={patient} />
          ) : tab === "administrative" ? (
            <AdministrativeView patient={patient} />
          ) : tab === "otherclinical" ? (
            <OtherClinicalView patient={patient} />
          ) : tab === "healthmgmt" ? (
            <HealthMgmtView patient={patient} />
          ) : null}
        </div>

        {/* Right patient sidebar */}
        <aside className="hidden xl:block w-[300px] shrink-0 bg-white border-l border-slate-300 min-h-[calc(100vh-50px)]">
          <div className="flex items-center justify-between px-3 py-2 border-b border-slate-200">
            <RefreshCw className="h-4 w-4 text-slate-500" />
            <Info className="h-4 w-4 text-blue-600" />
          </div>
          <div className="px-3 pt-2 pb-3 border-b border-slate-200">
            <h2 className="text-[18px] font-semibold text-slate-900 leading-tight truncate">{fullName}</h2>
            <div className="text-[11.5px] text-slate-600 mt-0.5">
              {age}, {patient.gender ?? "—"} · {dob}
            </div>
            <div className="text-[11px] text-slate-600 font-mono mt-0.5">MRN# {patient.mrn}</div>
            <div className="text-[11px] text-slate-700 mt-1">
              REG ER, SA Main ED <span className="text-slate-500">Acute -{patient.room ?? "A11"}</span>
            </div>
            <div className="mt-2 flex gap-3 text-[11px]">
              <span className="text-slate-600">1.58m / 78kg</span>
              <span className="text-slate-600">BMI: 31.2 kg/m²</span>
            </div>
            <div className="mt-2 text-[13px] font-semibold text-orange-700">
              {patient.chief_complaint ?? "—"}
            </div>
            <div className="mt-2 flex items-center justify-between">
              <div className="text-[10px] text-slate-500">
                <div>Acc#</div>
                <div className="font-mono text-slate-700">SE{patient.mrn.slice(-7)}</div>
              </div>
              {!isFullCode ? null : (
                <span className="inline-flex items-center rounded bg-red-600 text-white px-2 py-1 text-[10px] font-bold uppercase tracking-wider">
                  Full Resuscitation
                </span>
              )}
            </div>
          </div>

          <div className="px-3 py-2 border-b border-slate-200 flex items-center gap-2">
            <Search className="h-3.5 w-3.5 text-slate-400" />
            <input placeholder="Search Chart" className="flex-1 bg-[#fdfbe8] border border-slate-300 rounded px-2 py-1 text-[11px] focus:outline-none focus:ring-1 focus:ring-emerald-500" />
          </div>

          {/* Live telemetry pulled into clinical sidebar */}
          <div className="px-3 py-2 border-b border-slate-200 bg-[#0b2545] text-white">
            <div className="text-[10px] uppercase tracking-widest text-white/55 mb-1">Live Telemetry</div>
            <LiveTelemetry dx={dx} />
          </div>

          <div className="px-3 py-2 border-b border-slate-200">
            <div className="text-[12px] font-semibold text-slate-800 mb-1">● Active Problems</div>
            <div className="text-[12px] text-slate-700">{patient.chief_complaint ?? "—"}</div>
          </div>

          <div className="px-3 py-2 border-b border-slate-200">
            <div className="text-[12px] font-semibold text-slate-800 mb-1">● Allergies</div>
            <div className="text-[11.5px] text-slate-700 flex justify-between"><span>cefazolin</span><span className="text-slate-500">Diarrhea</span></div>
            <div className="text-[11.5px] text-slate-700 flex justify-between"><span>penicillin G</span><span className="text-slate-500">Rash</span></div>
          </div>

          <div className="px-3 py-2">
            <div className="text-[12px] font-semibold text-slate-800 mb-1">● Vitals — Current</div>
            <div className="grid grid-cols-2 gap-y-1 text-[11.5px]">
              <span className="text-slate-600">BP</span>
              <span className={`font-mono ${(patient.bp_systolic ?? 0) >= 140 ? "bg-yellow-200 px-1 rounded font-bold" : ""}`}>
                {patient.bp_systolic ?? "—"}/{patient.bp_diastolic ?? "—"}
              </span>
              <span className="text-slate-600">Pulse</span>
              <span className="font-mono">{patient.hr ?? "—"}</span>
              <span className="text-slate-600">SpO₂</span>
              <span className="font-mono">{patient.spo2 ?? "—"}%</span>
              <span className="text-slate-600">Code</span>
              <span className="font-mono">{codeStatus}</span>
              <span className="text-slate-600">Allergy</span>
              <span className={`font-mono ${isNKDA ? "" : "text-red-700 font-bold"}`}>{allergy}</span>
            </div>
          </div>
        </aside>
      </div>
    </main>
  );
}

function TabRow({
  tabs, active, onClick, variant,
}: {
  tabs: { key: TabKey; label: string }[];
  active: TabKey | null;
  onClick: (k: TabKey) => void;
  variant: "blue" | "cream";
}) {
  const isCream = variant === "cream";
  return (
    <div className="flex items-center gap-1">
      {tabs.map((t) => {
        const isActive = active === t.key;
        const base = "px-6 py-1.5 text-[13px] font-medium rounded-t-[14px] rounded-b-sm border border-b-0 transition";
        const colors = isActive
          ? (isCream ? "bg-[#fdfbe8] border-amber-400 text-slate-900 shadow-inner" : "bg-[#7fa9d8] border-[#5b8bc7] text-white shadow-inner")
          : (isCream ? "bg-[#f0ecdc] border-amber-300/60 text-slate-700 hover:bg-[#fdfbe8]" : "bg-[#a8c5e3] border-[#7fa9d8] text-slate-900 hover:bg-[#7fa9d8] hover:text-white");
        return (
          <button key={t.key} onClick={() => onClick(t.key)} className={`${base} ${colors} flex-1`}>
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

function ToolbarBtn({
  label, icon, onClick, active, badge, side = "left",
}: {
  label: string;
  icon: React.ReactNode;
  onClick?: () => void;
  active?: boolean;
  badge?: number;
  side?: "left" | "right";
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      className={`relative flex flex-col items-center justify-center px-3 py-1.5 hover:bg-white/10 transition min-w-[72px] ${side === "right" ? "border-l border-white/10" : "border-r border-white/10"} ${active ? "bg-white/10" : ""}`}
    >
      {icon}
      <span className="text-[10px] tracking-wide mt-0.5">{label}</span>
      {badge && badge > 0 ? (
        <span className="absolute top-1 right-1 bg-amber-500 text-black text-[9px] font-bold rounded-full h-4 w-4 grid place-items-center">{badge}</span>
      ) : null}
    </button>
  );
}

/* ---------- Terminology search (LOINC / RxNorm autocomplete) ---------- */
function TerminologySearch({
  kind, value, onChange, placeholder,
}: {
  kind: "lab" | "med";
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  const [query, setQuery] = useState(value);
  const [results, setResults] = useState<{ code: string; display: string }[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => { setQuery(value); }, [value]);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) { setResults([]); return; }
    let cancelled = false;
    setLoading(true);
    const t = setTimeout(async () => {
      try {
        const url = kind === "lab"
          ? `https://clinicaltables.nlm.nih.gov/api/loinc_items/v3/search?terms=${encodeURIComponent(q)}&df=LOINC_NUM,LONG_COMMON_NAME&maxList=10`
          : `https://clinicaltables.nlm.nih.gov/api/rxterms/v3/search?terms=${encodeURIComponent(q)}&maxList=10`;
        const r = await fetch(url);
        const j = await r.json();
        if (cancelled) return;
        const rows: string[][] = Array.isArray(j?.[3]) ? j[3] : [];
        const codes: string[] = Array.isArray(j?.[1]) ? j[1] : [];
        const out = kind === "lab"
          ? rows.map((row) => ({ code: row[0] ?? "", display: row[1] ?? row[0] ?? "" }))
          : codes.map((c, i) => ({ code: c, display: rows[i]?.[0] ?? c }));
        setResults(out.filter((x) => x.display));
        setOpen(true);
      } catch {
        if (!cancelled) setResults([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 250);
    return () => { cancelled = true; clearTimeout(t); };
  }, [query, kind]);

  const pick = (display: string) => {
    onChange(display);
    setQuery(display);
    setOpen(false);
  };

  return (
    <div className="relative mt-1">
      <input
        type="text"
        value={query}
        onChange={(e) => { setQuery(e.target.value); onChange(e.target.value); }}
        onFocus={() => results.length && setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        placeholder={placeholder}
        className="w-full border border-slate-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500"
      />
      {open && (results.length > 0 || loading) && (
        <div className="absolute z-10 mt-1 w-full max-h-60 overflow-auto bg-white border border-slate-200 rounded shadow-lg">
          {loading && <div className="px-2 py-1.5 text-[11px] text-slate-500">Searching {kind === "lab" ? "LOINC" : "RxNorm"}…</div>}
          {results.map((r, i) => (
            <button
              key={`${r.code}-${i}`}
              type="button"
              onMouseDown={(e) => { e.preventDefault(); pick(r.display); }}
              className="w-full text-left px-2 py-1.5 text-xs hover:bg-blue-50 border-b border-slate-100 last:border-0"
            >
              <div className="text-slate-900">{r.display}</div>
              {r.code && <div className="text-[10px] text-slate-500 font-mono">{kind === "lab" ? "LOINC" : "RxCUI"} {r.code}</div>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function OrdersDialog({
  patient, automationEnabled, onClose,
}: {
  patient: PatientRecord;
  automationEnabled: boolean;
  onClose: () => void;
}) {
  const [kind, setKind] = useState<"lab" | "med">("lab");
  const [testType, setTestType] = useState("");
  const [drug, setDrug] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const patientName = `${patient.first_name ?? ""} ${patient.last_name ?? ""}`.trim() || "Unknown";

  const submit = async () => {
    setSubmitting(true);
    try {
      if (kind === "lab") {
        const { data: inserted, error } = await supabase.from("lab_orders").insert({
          patient_mrn: patient.mrn,
          patient_name: patientName,
          facility_name: patient.facility_name ?? "Memorial Hospital",
          requested_by: "Provider",
          test_type: testType,
          clinical_condition: patient.chief_complaint ?? null,
          status: "Ordered",
          ordered_by: "Human",
        } as any).select("id").single();
        if (error) throw error;
        if (inserted?.id) {
          autoCodeLab(testType, { resourceId: inserted.id, mrn: patient.mrn, resolver: "patient-orders" });
        }
        toast.success(`Lab ordered: ${testType} (sent to live lab queue)`);
      } else {
        const [name, ...rest] = drug.split(" ");
        const { data: inserted, error } = await supabase.from("medication_orders").insert({
          patient_id: patient.id,
          patient_mrn: patient.mrn,
          mrn: patient.mrn,
          patient_name: patientName,
          drug_name: name,
          drug: name,
          medication: drug,
          medication_name: drug,
          name: drug,
          dose: rest.slice(0, 2).join(" "),
          route: "PO",
          frequency: "Q6H PRN",
          status: "Ordered",
          ordered_by: "Human",
          facility_name: patient.facility_name ?? "Memorial Hospital",
          ordering_physician: "Provider",
        } as any).select("id").single();
        if (error) throw error;
        if (inserted?.id) {
          autoCodeMedication(drug, { resourceId: inserted.id, mrn: patient.mrn, resolver: "patient-orders" });
        }
        toast.success(`Medication ordered: ${drug} (sent to live pharmacy queue)`);
      }
      onClose();
    } catch (e: any) {
      toast.error(e.message ?? "Failed to submit order");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/40 grid place-items-center p-4" onClick={onClose}>
      <div className="bg-white rounded-lg shadow-2xl w-full max-w-md" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b">
          <h3 className="text-sm font-semibold text-slate-900">New Order — {patientName}</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700"><X className="h-4 w-4" /></button>
        </div>
        <div className="p-4 space-y-3">
          <div className="flex gap-2">
            <button onClick={() => setKind("lab")} className={`flex-1 py-1.5 text-xs rounded border ${kind === "lab" ? "bg-blue-600 text-white border-blue-600" : "bg-white border-slate-300 text-slate-700"}`}>Lab Order</button>
            <button onClick={() => setKind("med")} className={`flex-1 py-1.5 text-xs rounded border ${kind === "med" ? "bg-blue-600 text-white border-blue-600" : "bg-white border-slate-300 text-slate-700"}`}>Medication</button>
          </div>
          {kind === "lab" ? (
            <div>
              <label className="text-[11px] text-slate-600 uppercase tracking-wider">Test Type · LOINC</label>
              <TerminologySearch
                kind="lab"
                value={testType}
                onChange={setTestType}
                placeholder="Search LOINC (e.g. CBC, troponin, glucose)…"
              />
            </div>
          ) : (
            <div>
              <label className="text-[11px] text-slate-600 uppercase tracking-wider">Medication · RxNorm</label>
              <TerminologySearch
                kind="med"
                value={drug}
                onChange={setDrug}
                placeholder="Search RxNorm (e.g. acetaminophen, lisinopril)…"
              />
            </div>
          )}
          <div className={`text-[11px] rounded px-2 py-1.5 border ${automationEnabled ? "bg-emerald-50 border-emerald-200 text-emerald-800" : "bg-amber-50 border-amber-200 text-amber-800"}`}>
            {automationEnabled
              ? "Automation ON — order will be auto-approved."
              : "Manual mode — order will go to verification queue."}
          </div>
        </div>
        <div className="flex justify-end gap-2 px-4 py-3 border-t bg-slate-50">
          <button onClick={onClose} className="px-3 py-1.5 text-xs rounded border border-slate-300 bg-white hover:bg-slate-100">Cancel</button>
          <button disabled={submitting} onClick={submit} className="px-3 py-1.5 text-xs rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 inline-flex items-center gap-1">
            {submitting ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />} Submit Order
          </button>
        </div>
      </div>
    </div>
  );
}

function DischargeDialog({
  patient, onClose, onDone,
}: {
  patient: PatientRecord;
  onClose: () => void;
  onDone: () => void;
}) {
  const DEFAULT_SUMMARY = "Patient stable for discharge. Follow up with PCP in 7 days.";
  const [summary, setSummary] = useState(DEFAULT_SUMMARY);
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    setSubmitting(true);
    try {
      // Route through ghost-discharge-worker so the DISCHARGE_SUMMARY note,
      // FHIR Composition (with real meds/labs) and DocumentReference all get
      // built headlessly. Preserve clinician free-text only when they edited
      // the default placeholder.
      const clinicianSummary = summary.trim() && summary.trim() !== DEFAULT_SUMMARY
        ? summary
        : null;
      const result = await dischargePatientViaWorker({ mrn: patient.mrn, clinicianSummary });
      if (!result.ok) throw new Error(result.reason ?? "discharge_failed");
      toast.success(`${patient.first_name ?? "Patient"} ${patient.last_name ?? ""} discharged`);
      onDone();
    } catch (e: any) {
      toast.error(e.message ?? "Failed to discharge");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/40 grid place-items-center p-4" onClick={onClose}>
      <div className="bg-white rounded-lg shadow-2xl w-full max-w-md" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b">
          <h3 className="text-sm font-semibold text-slate-900">Discharge Patient</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700"><X className="h-4 w-4" /></button>
        </div>
        <div className="p-4 space-y-3">
          <div className="text-xs text-slate-700">
            <span className="font-semibold">{patient.first_name} {patient.last_name}</span> · MRN {patient.mrn} · Room {patient.room ?? "—"}
          </div>
          <div>
            <label className="text-[11px] text-slate-600 uppercase tracking-wider">Discharge Summary</label>
            <textarea value={summary} onChange={(e) => setSummary(e.target.value)} rows={4} className="w-full mt-1 border border-slate-300 rounded px-2 py-1.5 text-sm" />
          </div>
          <div className="text-[11px] rounded px-2 py-1.5 border bg-amber-50 border-amber-200 text-amber-800">
            This will mark the patient as discharged and sync across every dashboard.
          </div>
        </div>
        <div className="flex justify-end gap-2 px-4 py-3 border-t bg-slate-50">
          <button onClick={onClose} className="px-3 py-1.5 text-xs rounded border border-slate-300 bg-white hover:bg-slate-100">Cancel</button>
          <button disabled={submitting} onClick={submit} className="px-3 py-1.5 text-xs rounded bg-red-600 text-white hover:bg-red-700 disabled:opacity-50 inline-flex items-center gap-1">
            {submitting ? <Loader2 className="h-3 w-3 animate-spin" /> : <LogOut className="h-3 w-3" />} Confirm Discharge
          </button>
        </div>
      </div>
    </div>
  );
}
/* ============================================================ */
/* Admission Case History — hospital-style intake recap          */
/* Reads the structured IntakeRecord saved by the Admit modal    */
/* and renders it as a real-world EHR case-history widget.        */
/* ============================================================ */
function AdmissionCaseHistory({ mrn }: { mrn: string }) {
  const [rec, setRec] = useState<IntakeRecord | null>(null);
  useEffect(() => { setRec(loadIntake(mrn)); }, [mrn]);
  if (!rec) return null;

  const Row = ({ k, v }: { k: string; v: React.ReactNode }) => (
    <>
      <dt className="text-slate-600">{k}</dt>
      <dd className="text-slate-800">{v || "—"}</dd>
    </>
  );
  const Box = ({ title, children }: { title: string; children: React.ReactNode }) => (
    <section className="rounded border border-slate-300 bg-white">
      <div className="flex items-center px-2.5 py-1.5 border-b border-slate-300 bg-[#eef5ff] text-[12px] font-semibold text-blue-900">
        <span className="h-1.5 w-1.5 rounded-full bg-blue-600 inline-block mr-1.5" />
        {title}
      </div>
      <div className="px-2.5 py-2 text-[12px]">{children}</div>
    </section>
  );

  return (
    <div className="px-2 pb-3">
      <div className="rounded border border-blue-300 bg-[#f5faff]">
        <div className="flex items-center justify-between px-3 py-1.5 border-b border-blue-300 bg-[#e6f1ff]">
          <div className="flex items-center gap-2 text-[13px] font-semibold text-blue-900">
            <FileText className="h-4 w-4" /> Admission Case History
          </div>
          <span className="text-[10px] font-mono text-blue-700/80">
            Captured {rec.capturedAt ? new Date(rec.capturedAt).toLocaleString("en-GB") : "—"}
          </span>
        </div>
        <div className="grid grid-cols-12 gap-2 p-2">
          <div className="col-span-12 lg:col-span-6">
            <Box title="1 · Demographics & Administrative">
              <dl className="grid grid-cols-[140px_1fr] gap-y-1">
                <Row k="Full Name" v={`${rec.firstName} ${rec.lastName}`} />
                <Row k="Age / DOB" v={`${rec.age || "—"} · ${rec.dob || "—"}`} />
                <Row k="Sex / Gender" v={`${rec.sex || "—"} · ${rec.genderIdentity || "—"}`} />
                <Row k="Phone" v={rec.phone} />
                <Row k="Address" v={rec.address} />
                <Row k="Occupation" v={rec.occupation} />
                <Row k="Emergency" v={rec.emergencyName ? `${rec.emergencyName} (${rec.emergencyRelationship}) · ${rec.emergencyPhone}` : "—"} />
                <Row k="Insurance" v={rec.insuranceProvider ? `${rec.insuranceProvider} · ${rec.insurancePolicy}` : "—"} />
                <Row k="PCP" v={rec.pcp} />
                <Row k="Guarantor" v={rec.guarantor} />
              </dl>
            </Box>
          </div>
          <div className="col-span-12 lg:col-span-6 space-y-2">
            <Box title="2 · Chief Complaint (Patient's Own Words)">
              <p className="italic text-slate-800">"{rec.chiefComplaint || "—"}"</p>
            </Box>
            <Box title="3 · History of Present Illness (HPI)">
              <dl className="grid grid-cols-[110px_1fr] gap-y-1">
                <Row k="Onset" v={rec.hpiOnset} />
                <Row k="Location" v={rec.hpiLocation} />
                <Row k="Duration" v={rec.hpiDuration} />
                <Row k="Character" v={rec.hpiCharacter.join(", ")} />
                <Row k="Aggravating" v={rec.hpiAggravating} />
                <Row k="Alleviating" v={rec.hpiAlleviating} />
                <Row k="Severity" v={`${rec.hpiSeverity}/10`} />
              </dl>
            </Box>
          </div>
          <div className="col-span-12 lg:col-span-6">
            <Box title="4 · Past Medical & Surgical History">
              <dl className="grid grid-cols-[140px_1fr] gap-y-1">
                <Row k="Chronic Illnesses" v={rec.chronicIllnesses.join(", ") || "None reported"} />
                <Row k="Prior Surgeries" v={rec.priorSurgeries} />
                <Row k="Past Hospitalizations" v={rec.pastHospitalizations} />
              </dl>
            </Box>
          </div>
          <div className="col-span-12 lg:col-span-6">
            <Box title="5 · Allergies & Current Medications">
              <div className="space-y-1.5">
                <div>
                  <span className="font-semibold text-slate-700">Drug Allergies: </span>
                  {rec.drugAllergies.length === 0
                    ? <span className="text-slate-600">NKDA</span>
                    : rec.drugAllergies.map((a, i) => (
                        <span key={i} className="inline-block mr-1.5 rounded-full bg-red-50 text-red-700 ring-1 ring-red-200 px-2 py-0.5 text-[11px] font-semibold">
                          {a.name}{a.reaction ? ` (${a.reaction})` : ""}
                        </span>
                      ))}
                </div>
                {rec.envAllergies.length > 0 && (
                  <div><span className="font-semibold text-slate-700">Environmental/Food: </span>{rec.envAllergies.join(", ")}</div>
                )}
                <div>
                  <span className="font-semibold text-slate-700">Current Meds: </span>
                  {rec.currentMeds.length === 0
                    ? <span className="text-slate-600">None</span>
                    : <ul className="list-disc list-inside text-slate-800">
                        {rec.currentMeds.map((m, i) => (
                          <li key={i}>{m.name} {m.dose} <span className="text-slate-500">· {m.freq}</span></li>
                        ))}
                      </ul>}
                </div>
              </div>
            </Box>
          </div>
          <div className="col-span-12">
            <Box title="6 · Family History">
              <div>
                <span className="font-semibold text-slate-700">Conditions: </span>
                {rec.familyConditions.length ? rec.familyConditions.join(", ") : "Non-contributory"}
              </div>
              {rec.familyNotes && <div className="mt-1 text-slate-700">{rec.familyNotes}</div>}
            </Box>
          </div>
        </div>
      </div>
    </div>
  );
}
