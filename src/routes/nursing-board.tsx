import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { BoardHeader } from "@/components/BoardShell";
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import {
  Loader2,
  Search,
  Users,
  AlertTriangle,
  BedDouble,
  ChevronRight,
  Activity,
  UserPlus,
  X,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import {
  type CodeStatus,
} from "@/lib/patients";
import { useFacility, useActiveNurse } from "@/lib/facility-context";
import { seedAdmission } from "@/hooks/useAIAutomation";
import { useAutomationEnabled } from "@/hooks/useAutomationEnabled";
import { useRolePermissions } from "@/hooks/useRolePermissions";
import {
  analyzeNarrative,
  loadDictionary,
  saveAudit,
  type NlpResult,
} from "@/lib/nlp-engine";
import { Sparkles, Wand2, ChevronDown, Plus } from "lucide-react";
import {
  autoFillIntake,
  blankIntake,
  intakeToSoap,
  saveIntake,
  CHRONIC_OPTIONS,
  CHARACTER_OPTIONS,
  FAMILY_OPTIONS,
  ENV_ALLERGY_OPTIONS,
  RELATIONSHIP_OPTIONS,
  SEX_OPTIONS,
  GENDER_IDENTITY_OPTIONS,
  DURATION_OPTIONS,
  type IntakeRecord,
} from "@/lib/intake-record";

export const Route = createFileRoute("/nursing-board")({
  component: Dashboard,
});

const codeBadge: Record<CodeStatus, string> = {
  "Full Code": "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-600/20",
  DNR: "bg-red-50 text-red-700 ring-1 ring-red-600/20",
  DNI: "bg-amber-50 text-amber-700 ring-1 ring-amber-600/20",
  Comfort: "bg-slate-100 text-slate-700 ring-1 ring-slate-600/20",
};

interface PatientRow {
  mrn: string;
  name: string;
  room: string | null;
  age: number;
  sex: string;
  code: CodeStatus;
  diagnosis: string;
  hr: number;
  bp: string;
  o2: number;
  rr: number;
  temp: number;
  task: string;
  medsDue: number;
  facility: string;
  unreadLabs: boolean;
  admittedAt: string | null;
}

function normalizeCode(s: string | null | undefined): CodeStatus {
  const v = (s ?? "").trim().toLowerCase();
  if (v === "dnr") return "DNR";
  if (v === "dni") return "DNI";
  if (v === "comfort") return "Comfort";
  return "Full Code";
}

// Deterministic mock room from MRN so it stays stable across renders.
function mockRoom(mrn: string): string {
  let h = 0;
  for (let i = 0; i < mrn.length; i++) h = (h * 31 + mrn.charCodeAt(i)) >>> 0;
  const num = 400 + (h % 60); // 400 – 459
  const bed = ["A", "B", "C", "D"][h % 4];
  return `${num}-${bed}`;
}

type AlertKind = "sepsis" | "stemi" | "dka" | "stroke" | "pending";
function classifyAlert(dx: string | null | undefined): AlertKind {
  const d = (dx ?? "").toLowerCase();
  if (d.includes("sepsis")) return "sepsis";
  if (d.includes("stemi")) return "stemi";
  if (d.includes("dka")) return "dka";
  if (d.includes("stroke")) return "stroke";
  return "pending";
}

function ClinicalAlertPill({
  dx,
  hr,
  o2,
  bp,
  rr,
  temp,
}: {
  dx: string | null | undefined;
  hr?: number;
  o2?: number;
  bp?: string;
  rr?: number;
  temp?: number;
}) {
  const base =
    "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-bold ring-1 font-sans tracking-tight whitespace-nowrap";

  const critical = `${base} bg-red-600 text-white ring-red-700 animate-pulse shadow-[0_0_10px_rgba(220,38,38,0.55)]`;
  const warn = `${base} bg-amber-100 text-amber-900 ring-amber-400`;
  const info = `${base} bg-orange-100 text-orange-800 ring-orange-400`;

  let sys: number | undefined;
  let dia: number | undefined;
  if (bp) {
    const [s, d] = bp.split("/").map((n) => parseInt(n, 10));
    if (!isNaN(s)) sys = s;
    if (!isNaN(d)) dia = d;
  }

  // Severity-ordered, vitals-driven alerts (override the diagnosis pill).
  if ((typeof sys === "number" && sys > 180) || (typeof dia === "number" && dia > 120)) {
    return <span className={critical}>🆘 Hypertensive Crisis</span>;
  }
  if (typeof o2 === "number" && o2 < 90) {
    return <span className={critical}>🫁 Hypoxia Alert</span>;
  }
  if (typeof temp === "number" && temp < 95.0) {
    return <span className={critical}>🥶 Hypothermia</span>;
  }
  if (typeof temp === "number" && temp > 100.4) {
    return <span className={warn}>🌡️ Fever</span>;
  }
  if (typeof sys === "number" && sys < 90) {
    return <span className={critical}>📉 Hypotension</span>;
  }
  if (typeof hr === "number" && hr < 60) {
    return <span className={warn}>🐢 Bradycardia</span>;
  }
  if (typeof hr === "number" && hr > 100) {
    return <span className={warn}>⚡ Tachycardia</span>;
  }
  if ((typeof sys === "number" && sys > 130) || (typeof dia === "number" && dia > 80)) {
    return <span className={info}>🩺 Hypertension</span>;
  }
  if (typeof rr === "number" && rr < 12) {
    return <span className={warn}>💨 Bradypnea</span>;
  }
  if (typeof rr === "number" && rr > 20) {
    return <span className={warn}>💨 Tachypnea</span>;
  }
  if (typeof o2 === "number" && o2 < 95) {
    return <span className={warn}>🫁 Low SpO₂</span>;
  }

  // Fall back to diagnosis-driven pill when vitals are within range.
  const kind = classifyAlert(dx);
  if (kind === "sepsis") {
    return (
      <span className={critical}>🚨 Sepsis Watch</span>
    );
  }
  switch (kind) {
    case "stemi":
      return (
        <span className={`${base} bg-red-100 text-red-800 ring-red-400`}>
          ❤️ Cath Lab Alert
        </span>
      );
    case "dka":
      return (
        <span className={`${base} bg-purple-100 text-purple-800 ring-purple-400`}>
          🩸 ABG / Insulin Protocol
        </span>
      );
    case "stroke":
      return (
        <span className={`${base} bg-orange-100 text-orange-800 ring-orange-400`}>
          🧠 Stroke Alert
        </span>
      );
    default:
      return (
        <span className={`${base} bg-green-100 text-green-800 ring-green-400`}>
          🟢 Stable
        </span>
      );
  }
}

function baselineVitals(dx: string | null | undefined): { hr: number; sys: number; dia: number; spo2: number } {
  const d = (dx ?? "").toLowerCase();
  if (d.includes("sepsis")) return { hr: 112, sys: 88, dia: 55, spo2: 95 };
  if (d.includes("dka")) return { hr: 105, sys: 100, dia: 65, spo2: 97 };
  if (d.includes("stemi")) return { hr: 98, sys: 138, dia: 88, spo2: 96 };
  if (d.includes("stroke")) return { hr: 92, sys: 165, dia: 95, spo2: 96 };
  return { hr: 75, sys: 120, dia: 80, spo2: 98 };
}

function LiveVitals({
  hr,
  bp,
  spo2,
  rr,
  temp,
}: {
  hr: number;
  bp: string;
  spo2: number;
  rr: number;
  temp: number;
}) {
  void baselineVitals; // legacy helper, kept for compatibility
  const [sysStr, diaStr] = bp.split("/");
  const sys = parseInt(sysStr, 10) || 0;
  const dia = parseInt(diaStr, 10) || 0;
  const hrCritical = hr > 100 || hr < 60;
  const sysCritical = sys < 90 || sys > 180 || dia > 120;
  const sysWarn = !sysCritical && (sys > 130 || dia > 80);
  const spo2Critical = spo2 < 90;
  const spo2Warn = !spo2Critical && spo2 < 95;
  const rrAlert = rr < 12 || rr > 20;
  const tempCritical = temp < 95.0;
  const tempWarn = !tempCritical && temp > 100.4;
  return (
    <div className="font-mono text-[11.5px] leading-tight tabular-nums">
      <div>
        <span className="text-slate-400">HR </span>
        <span className={hrCritical ? "text-red-600 font-extrabold animate-pulse" : "text-emerald-600 font-bold"}>
          {hr}
        </span>
        <span className="text-slate-400"> bpm</span>
      </div>
      <div>
        <span className="text-slate-400">BP </span>
        <span className={sysCritical ? "text-red-600 font-extrabold animate-pulse" : sysWarn ? "text-amber-600 font-bold" : "text-slate-800 font-semibold"}>
          {sys}
        </span>
        <span className="text-slate-500">/{dia}</span>
      </div>
      <div>
        <span className="text-slate-400">SpO₂ </span>
        <span className={spo2Critical ? "text-red-600 font-extrabold animate-pulse" : spo2Warn ? "text-amber-600 font-bold" : "text-cyan-600 font-bold"}>{spo2}</span>
        <span className="text-slate-400">%</span>
      </div>
      <div>
        <span className="text-slate-400">RR </span>
        <span className={rrAlert ? "text-amber-600 font-bold" : "text-slate-700 font-semibold"}>{rr}</span>
        <span className="text-slate-400"> /min</span>
      </div>
      <div>
        <span className="text-slate-400">T </span>
        <span className={tempCritical ? "text-red-600 font-extrabold animate-pulse" : tempWarn ? "text-amber-600 font-bold" : "text-slate-700 font-semibold"}>{temp.toFixed(1)}</span>
        <span className="text-slate-400">°F</span>
      </div>
    </div>
  );
}

function toRow(p: any): PatientRow {
  return {
    mrn: p.mrn,
    name: `${p.first_name} ${p.last_name}`,
    room: p.room,
    age: p.age,
    sex: p.gender,
    code: normalizeCode(p.code_status),
    diagnosis: p.chief_complaint,
    hr: p.hr,
    bp: `${p.bp_systolic}/${p.bp_diastolic}`,
    o2: p.spo2,
    task: "—",
    medsDue: p.meds_due_count ?? 1,
    facility: p.facility_name ?? "Memorial Hospital",
    unreadLabs: !!p.unread_labs_alert,
    admittedAt: p.admission_time ?? null,
    rr: 16,
    temp: 98.6,
  };
}

function genMRN() {
  return `MRN-${Math.floor(100000 + Math.random() * 900000)}`;
}

function fmtAdmitted(ts: string | null | undefined): string {
  if (!ts) return "—";
  const d = new Date(ts);
  if (isNaN(d.getTime())) return "—";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())}/${String(d.getFullYear()).slice(-2)} - ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function Dashboard() {
  const navigate = useNavigate();
  const { facility } = useFacility();
  const nurse = useActiveNurse();
  const [email, setEmail] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [now, setNow] = useState(new Date());
  const [query, setQuery] = useState("");
  const [patients, setPatients] = useState<PatientRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [liveConnected, setLiveConnected] = useState(false);
  const [admitOpen, setAdmitOpen] = useState(false);
  const [discharging, setDischarging] = useState<PatientRow | null>(null);
  const [showOnlyMedsDue, setShowOnlyMedsDue] = useState(false);
  const [bedBoardOpen, setBedBoardOpen] = useState(false);
  const automationEnabled = useAutomationEnabled();
  const { gate } = useRolePermissions("RN");

  const MEDS_DUE_NAMES = ["margaret chen", "robert alvarez", "srujan patel", "marcus vance"];

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setEmail(data.session?.user.email ?? "demo@sgroup.health");
      setReady(true);
    });
  }, []);

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      setFetchError(null);
      const { data, error } = await supabase
        .from("patients")
        .select(
          "mrn, first_name, last_name, age, gender, code_status, chief_complaint, room, hr, bp_systolic, bp_diastolic, spo2, meds_due_count, facility_name, unread_labs_alert, status, admission_time",
        )
        .eq("status", "Admitted")
        .eq("facility_name", facility)
        .order("admission_time", { ascending: false })
        .limit(200);
      if (cancelled) return;
      if (error) {
        setFetchError(error.message);
        setLoading(false);
        return;
      }
      setPatients((data ?? []).map(toRow));
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [ready, facility]);

  useEffect(() => {
    if (!ready) return;
    const channel = supabase
      .channel("patients-live")
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "patients" },
        (payload) => {
          const p: any = payload.new;
          setPatients((prev) =>
            prev.map((row) =>
              row.mrn === p.mrn
                ? {
                    ...row,
                    name: `${p.first_name} ${p.last_name}`,
                    room: p.room,
                    age: p.age,
                    sex: p.gender,
                    code: normalizeCode(p.code_status),
                    diagnosis: p.chief_complaint,
                    hr: p.hr,
                    bp: `${p.bp_systolic}/${p.bp_diastolic}`,
                    o2: p.spo2,
                    medsDue: p.meds_due_count ?? row.medsDue,
                  }
                : row,
            ),
          );
        },
      )
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "patients" },
        (payload) => {
          const row = toRow(payload.new);
          setPatients((prev) =>
            prev.some((p) => p.mrn === row.mrn) ? prev : [...prev, row],
          );
        },
      )
      .on(
        "postgres_changes",
        { event: "DELETE", schema: "public", table: "patients" },
        (payload) => {
          const oldMrn = (payload.old as any)?.mrn;
          if (!oldMrn) return;
          setPatients((prev) => prev.filter((p) => p.mrn !== oldMrn));
        },
      )
      .subscribe((status) => {
        setLiveConnected(status === "SUBSCRIBED");
      });
    return () => {
      setLiveConnected(false);
      supabase.removeChannel(channel);
    };
  }, [ready]);

  useEffect(() => {
    if (!ready || !automationEnabled) return;
    const jitter = (range: number) =>
      Math.floor(Math.random() * (2 * range + 1)) - range;
    const clamp = (v: number, lo: number, hi: number) =>
      Math.min(hi, Math.max(lo, v));
    const id = setInterval(() => {
      setPatients((prev) =>
        prev.map((p) => {
          const [sysStr, diaStr] = p.bp.split("/");
          const sys = clamp((parseInt(sysStr, 10) || 120) + jitter(8), 80, 200);
          const dia = clamp((parseInt(diaStr, 10) || 80) + jitter(6), 45, 130);
          return {
            ...p,
            hr: clamp(p.hr + jitter(8), 45, 140),
            bp: `${sys}/${dia}`,
            o2: clamp(p.o2 + jitter(3), 85, 100),
            rr: clamp((p.rr ?? 16) + jitter(2), 8, 26),
            temp: Math.round((Math.max(94.5, Math.min(102.5, (p.temp ?? 98.6) + (Math.random() - 0.5) * 0.6))) * 10) / 10,
          };
        }),
      );
    }, 2000);
    return () => clearInterval(id);
  }, [ready, automationEnabled]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = patients.filter((p) => p.facility === facility);
    if (showOnlyMedsDue) {
      list = list.filter((p) =>
        MEDS_DUE_NAMES.some((n) => p.name.toLowerCase().includes(n)),
      );
    }
    if (!q) return list;
    return list.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.mrn.toLowerCase().includes(q) ||
        (p.room ?? "").toLowerCase().includes(q) ||
        p.diagnosis.toLowerCase().includes(q),
    );
  }, [query, patients, showOnlyMedsDue, facility]);

  const facilityPatients = useMemo(
    () => patients.filter((p) => p.facility === facility),
    [patients, facility],
  );

  if (!ready) {
    return (
      <div className="min-h-screen grid place-items-center">
        <Loader2 className="h-5 w-5 animate-spin text-[var(--teal)]" />
      </div>
    );
  }

  const clock = now.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const dateStr = now.toLocaleDateString([], {
    weekday: "short",
    month: "short",
    day: "numeric",
  });

  const handleAdmit = async (input: AdmitInput) => {
    const mrn = input.mrn?.trim() || genMRN();
    const [first_name, ...rest] = input.name.trim().split(/\s+/);
    const last_name = rest.join(" ") || "—";
    const payload = {
      mrn,
      first_name,
      last_name,
      age: input.age,
      gender: input.gender,
      room: input.room.trim() || null,
      code_status: input.code_status,
      chief_complaint: input.diagnosis.trim(),
      hr: 76,
      bp_systolic: 120,
      bp_diastolic: 78,
      temp: 98.6,
      spo2: 98,
      status: "Admitted",
      facility_name: facility,
      admission_time: new Date().toISOString(),
    };
    const { data, error } = await supabase
      .from("patients")
      .insert(payload)
      .select()
      .single();
    if (error) {
      toast.error("Could not admit patient", { description: error.message });
      return false;
    }
    // Persist the NLP audit alongside the admission so the Coding Audit
    // tab in the Medical Dictionary can replay the physician's narrative.
    if (input.nlp) {
      try {
        saveAudit(input.nlp, {
          mrn: data.mrn,
          patient_name: `${data.first_name} ${data.last_name}`,
          facility_name: data.facility_name,
        });
      } catch (e) {
        console.warn("[admit] saveAudit failed", e);
      }
    }
    // Persist the full structured intake record so the patient chart can
    // render a real hospital-style Admission Case History panel, and drop
    // a SOAP-formatted clinical note into the chart timeline.
    if (input.intake) {
      try {
        const mrnSafe = data.mrn ?? mrn;
        saveIntake(mrnSafe, { ...input.intake, mrn: mrnSafe });
        const soap = intakeToSoap({ ...input.intake, mrn: mrnSafe });
        await supabase.from("clinical_notes").insert({
          mrn: mrnSafe,
          note_type: "Admission Intake (SOAP)",
          content: soap,
          author: "Admitting Provider",
        });
      } catch (e) {
        console.warn("[admit] intake persist failed", e);
      }
    }
    // Explicitly seed meds + labs into Supabase so the Pharmacy and Lab
    // boards pick this admission up immediately — don't rely solely on the
    // realtime channel, which can be missed on reconnect.
    try {
      await seedAdmission({
        id: data.id,
        mrn: data.mrn,
        first_name: data.first_name,
        last_name: data.last_name,
        name: (data as any).name ?? null,
        facility_name: data.facility_name,
        chief_complaint: (data as any).chief_complaint ?? null,
      }, { manual: true });
    } catch (e: any) {
      console.warn("[admit] seedAdmission failed", e);
    }
    setPatients((prev) =>
      prev.some((p) => p.mrn === mrn) ? prev : [...prev, toRow(data)],
    );
    toast.success("Patient admitted", { description: `${payload.first_name} ${payload.last_name} · ${mrn}` });
    return true;
  };

  const handleDischarge = async (p: PatientRow) => {
    const prev = patients;
    setPatients((curr) => curr.filter((x) => x.mrn !== p.mrn));
    const { error } = await supabase.from("patients").delete().eq("mrn", p.mrn);
    if (error) {
      setPatients(prev);
      toast.error("Could not discharge", { description: error.message });
      return;
    }
    toast.success("Patient discharged", { description: `${p.name} · ${p.mrn}` });
  };

  return (
    <main className="min-h-screen bg-background">
      <BoardHeader
        title="Status Board"
        subtitle={`RN: ${nurse.name.replace(/, RN$/, "")} · ${nurse.facility} — ${nurse.ward}`}
        badge="RN"
      />
      <div className="sticky top-0 z-10 border-b border-border bg-[var(--navy)] text-white">
        <div className="max-w-[1400px] mx-auto px-5 h-12 flex items-center gap-4">
          <div className="flex-1 max-w-md">
            <div className="flex items-center gap-2 h-9 rounded-md bg-white/10 ring-1 ring-white/10 px-3 focus-within:bg-white/15 focus-within:ring-[var(--teal)]/40 transition">
              <Search className="h-4 w-4 text-white/60" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search chart — name, MRN, room, dx…"
                className="w-full bg-transparent outline-none text-sm placeholder:text-white/45"
              />
            </div>
          </div>
          <div className="hidden sm:flex flex-col items-end leading-tight tabular-nums">
            <div className="text-sm font-semibold tracking-tight">{clock}</div>
            <div className="text-[10px] uppercase tracking-wider text-white/55">
              {dateStr}
            </div>
          </div>
          <button
            {...gate("btn_admit_patient", () => setAdmitOpen(true))}
            className="inline-flex items-center gap-1.5 rounded-md bg-[var(--teal)] hover:bg-[var(--teal)]/90 px-3 h-9 text-xs font-semibold text-white shadow-sm transition disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <UserPlus className="h-3.5 w-3.5" /> Admit Patient
          </button>
        </div>
      </div>

      <div className="max-w-[1400px] mx-auto px-5 py-6 space-y-6">
        <section className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <StatCard
            icon={Users}
            label="Total Patients"
            value={`${facilityPatients.length}`}
            tone="navy"
          />
          <StatCard
            icon={AlertTriangle}
            label="Critical Alerts"
            value={`${facilityPatients.filter((p) => p.o2 < 90 || p.hr > 115).length}`}
            tone="red"
            sub="SpO₂ < 90% or HR > 115 bpm"
          />
          <StatCard
            icon={BedDouble}
            label="Bed Management"
            value={facility}
            tone="teal"
            sub="Click to open MEDITECH Expanse board"
            interactive
            active={bedBoardOpen}
            onClick={() => setBedBoardOpen(true)}
          />
        </section>

        <section className="rounded-xl border border-border bg-card overflow-hidden shadow-[0_1px_0_rgba(15,23,42,0.04)]">
          <div className="flex items-center justify-between px-5 h-12 border-b border-border bg-secondary/40">
            <div className="flex items-center gap-2">
              <Activity className="h-4 w-4 text-[var(--teal)]" />
              <h2 className="text-sm font-semibold tracking-tight">
                Floor Overview — {nurse.ward}
              </h2>
              <span className="text-xs text-muted-foreground">
                · {rows.length} of {facilityPatients.length} patients
              </span>
            </div>
            <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              {liveConnected ? (
                <span className="relative flex h-2 w-2">
                  <span className="absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75 animate-ping" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
                </span>
              ) : (
                <span className="inline-flex h-2 w-2 rounded-full bg-slate-300" />
              )}
              Live · auto-refresh
              <span className={liveConnected ? "text-emerald-600 font-medium" : "text-muted-foreground"}>
                {liveConnected ? "· connected" : "· connecting…"}
              </span>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-[12.5px] font-sans border-collapse">
              <thead>
                <tr className="text-left text-[10px] uppercase tracking-[0.14em] text-slate-600 bg-slate-100 border-b border-slate-300">
                  <th className="px-3 py-2 font-bold">Room / Bed</th>
                  <th className="px-3 py-2 font-bold">MRN</th>
                  <th className="px-3 py-2 font-bold">Patient Name</th>
                  <th className="px-3 py-2 font-bold">Chief Complaint</th>
                  <th className="px-3 py-2 font-bold">Admitted</th>
                  <th className="px-3 py-2 font-bold">Live Vitals</th>
                  <th className="px-3 py-2 font-bold">Clinical Alerts</th>
                  <th className="px-3 py-2 font-bold text-right pr-4">Action</th>
                </tr>
              </thead>
              <tbody>
                {loading && (
                  <tr>
                    <td colSpan={8} className="px-5 py-10 text-center text-sm text-muted-foreground">
                      <span className="inline-flex items-center gap-2">
                        <Loader2 className="h-4 w-4 animate-spin text-[var(--teal)]" />
                        Loading floor census…
                      </span>
                    </td>
                  </tr>
                )}
                {!loading && fetchError && (
                  <tr>
                    <td colSpan={8} className="px-5 py-10 text-center text-sm">
                      <div className="inline-flex items-center gap-2 text-red-600">
                        <AlertTriangle className="h-4 w-4" />
                        Unable to load patients — {fetchError}
                      </div>
                    </td>
                  </tr>
                )}
                {!loading && !fetchError && rows.length === 0 && (
                  <tr>
                    <td colSpan={8} className="px-5 py-16 text-center">
                      <div className="flex flex-col items-center gap-2 text-slate-500">
                        <div className="text-3xl">🛏️</div>
                        <div className="text-sm font-semibold text-slate-700">
                          Floor Census Empty — Waiting for Triage Admissions.
                        </div>
                        <div className="text-xs text-slate-400">
                          {facility} · Live monitoring active
                        </div>
                      </div>
                    </td>
                  </tr>
                )}
                {!loading && !fetchError && rows.map((p, i) => {
                  const room = p.room?.trim() || mockRoom(p.mrn);
                  return (
                    <tr
                      key={p.mrn}
                      className={`border-b border-slate-200 hover:bg-[var(--teal-soft)]/40 transition ${
                        i % 2 === 1 ? "bg-slate-50/60" : "bg-white"
                      }`}
                    >
                      <td className="px-3 py-2 align-middle">
                        <span className="font-mono font-bold text-slate-900 tabular-nums text-[12.5px]">
                          {room}
                        </span>
                      </td>
                      <td className="px-3 py-2 align-middle font-mono text-slate-600 text-[12px]">
                        {p.mrn}
                      </td>
                      <td className="px-3 py-2 align-middle font-semibold text-slate-900">
                        {p.name}
                        <span className="ml-1.5 text-[11px] font-normal text-slate-500">
                          {p.age ? `${p.age}${p.sex ?? ""}` : ""}
                        </span>
                      </td>
                      <td className="px-3 py-2 align-middle text-slate-700 max-w-[260px]">
                        <div className="truncate" title={p.diagnosis}>
                          {p.diagnosis || "—"}
                        </div>
                      </td>
                      <td className="px-3 py-2 align-middle font-mono tabular-nums text-[11.5px] text-slate-500 whitespace-nowrap">
                        {fmtAdmitted(p.admittedAt)}
                      </td>
                      <td className="px-3 py-2 align-middle">
                        <LiveVitals hr={p.hr} bp={p.bp} spo2={p.o2} rr={p.rr} temp={p.temp} />
                      </td>
                      <td className="px-3 py-2 align-middle">
                        <ClinicalAlertPill dx={p.diagnosis} hr={p.hr} o2={p.o2} bp={p.bp} rr={p.rr} temp={p.temp} />
                      </td>
                      <td className="px-3 py-2 align-middle text-right pr-4">
                        <div className="inline-flex items-center gap-1.5">
                          <Link
                            to="/patient/$mrn"
                            params={{ mrn: p.mrn }}
                            className="inline-flex items-center gap-1 rounded-md border border-slate-300 bg-white px-2.5 h-7 text-[11px] font-semibold text-slate-700 hover:bg-[var(--navy)] hover:text-white hover:border-[var(--navy)] transition"
                          >
                            Open Chart
                            <ChevronRight className="h-3 w-3" />
                          </Link>
                          <button
                            {...gate("btn_discharge_patient", () => setDischarging(p))}
                            aria-label={`Discharge ${p.name}`}
                            className="inline-grid place-items-center h-7 w-7 rounded-md border border-slate-300 bg-white text-slate-500 hover:bg-red-50 hover:text-red-600 hover:border-red-200 transition disabled:opacity-50 disabled:cursor-not-allowed"
                          >
                            <Trash2 className="h-3 w-3" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>

        <p className="text-[11px] text-muted-foreground">
          Signed in as {email}. Vitals shown are synthetic for design review — live
          device telemetry will replace this feed.
        </p>
      </div>

      {admitOpen && (
        <AdmitModal onClose={() => setAdmitOpen(false)} onSubmit={handleAdmit} />
      )}

      {discharging && (
        <ConfirmDischargeModal
          patient={discharging}
          onCancel={() => setDischarging(null)}
          onConfirm={async () => {
            const p = discharging;
            setDischarging(null);
            await handleDischarge(p);
          }}
        />
      )}
      {bedBoardOpen && (
        <BedManagementBoard facility={facility} onClose={() => setBedBoardOpen(false)} />
      )}
    </main>
  );
}

function Th({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <th className={`px-5 py-2.5 font-semibold ${className}`}>{children}</th>;
}

function Vital({ label, value, alert }: { label: string; value: string; alert: boolean }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div className={`text-sm font-bold ${alert ? "text-red-600" : "text-foreground"}`}>
        {value}
      </div>
    </div>
  );
}

function StatCard({
  icon: Icon,
  label,
  value,
  sub,
  tone,
  interactive,
  active,
  onClick,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  sub?: string;
  tone: "navy" | "teal" | "red";
  interactive?: boolean;
  active?: boolean;
  onClick?: () => void;
}) {
  const tones = {
    navy: "bg-[var(--navy)] text-white",
    teal: "bg-[var(--teal)] text-white",
    red: "bg-red-600 text-white",
  } as const;
  const interactiveCls = interactive
    ? "cursor-pointer transition-all duration-200 hover:scale-[1.02] hover:shadow-md active:scale-[0.99] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--teal)]/50"
    : "";
  const activeCls = active
    ? "ring-2 ring-[var(--teal)] border-[var(--teal)] bg-[var(--teal-soft)]/40 shadow-[0_0_0_4px_rgba(20,184,166,0.12)]"
    : "";
  const Comp: any = interactive ? "button" : "div";
  return (
    <Comp
      type={interactive ? "button" : undefined}
      onClick={onClick}
      aria-pressed={interactive ? !!active : undefined}
      className={`w-full text-left rounded-xl border border-border bg-card p-4 flex items-center gap-4 ${interactiveCls} ${activeCls}`}
    >
      <div className={`h-11 w-11 rounded-lg grid place-items-center ${tones[tone]}`}>
        <Icon className="h-5 w-5" />
      </div>
      <div className="min-w-0">
        <div className="text-xs uppercase tracking-wider text-muted-foreground">
          {label}
          {interactive && (
            <span className={`ml-2 inline-flex items-center rounded-full px-1.5 py-0.5 text-[9px] font-semibold tracking-wider ${active ? "bg-[var(--teal)] text-white" : "bg-secondary text-muted-foreground"}`}>
              {active ? "FILTER ON" : "FILTER"}
            </span>
          )}
        </div>
        <div className="flex items-baseline gap-2">
          <div className="text-2xl font-semibold tracking-tight tabular-nums">
            {value}
          </div>
          {sub && <div className="text-xs text-muted-foreground truncate">{sub}</div>}
        </div>
      </div>
    </Comp>
  );
}

interface AdmitInput {
  name: string;
  age: number;
  gender: "M" | "F";
  room: string;
  code_status: CodeStatus;
  diagnosis: string;
  mrn?: string;
  nlp?: NlpResult;
  intake?: IntakeRecord;
}

function AdmitModal({
  onClose,
  onSubmit,
}: {
  onClose: () => void;
  onSubmit: (input: AdmitInput) => Promise<boolean>;
}) {
  const [intake, setIntake] = useState<IntakeRecord>(() => blankIntake());
  const [code, setCode] = useState<CodeStatus>("Full Code");
  const [room, setRoom] = useState("");
  const [mrn, setMrn] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [nlp, setNlp] = useState<NlpResult | null>(null);
  const [suggestedLabs, setSuggestedLabs] = useState<string[]>([]);
  const [open, setOpen] = useState<Record<string, boolean>>({
    demo: true, cc: true, hpi: false, pmh: false, allergies: false, family: false,
  });

  const patch = (p: Partial<IntakeRecord>) => setIntake((s) => ({ ...s, ...p }));
  const toggleSection = (k: string) => setOpen((s) => ({ ...s, [k]: !s[k] }));
  const toggleInArray = (arr: string[], v: string) =>
    arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v];

  const handleAutoFill = () => {
    const filled = autoFillIntake({
      firstName: intake.firstName || undefined,
      lastName: intake.lastName || undefined,
      age: intake.age || undefined,
      chiefComplaint: intake.chiefComplaint || undefined,
      narrative: intake.narrative || undefined,
    });
    setIntake(filled);
    setOpen({ demo: true, cc: true, hpi: true, pmh: true, allergies: true, family: true });
    toast.success("Intake auto-filled", { description: "Review fields, then click Admit Patient." });
  };

  const runAnalyze = async () => {
    const text = intake.narrative.trim();
    if (text.length < 6) { toast.error("Enter a longer narrative to analyze"); return; }
    setAnalyzing(true);
    try {
      const dict = await loadDictionary();
      const result = analyzeNarrative(text, dict);
      setNlp(result);
      if (!intake.chiefComplaint.trim() && result.chiefComplaint) patch({ chiefComplaint: result.chiefComplaint });
      setSuggestedLabs(result.suggestedLabs.map((l) => `${l.display} (LOINC ${l.code})`));
      toast.success("NLP analysis complete", {
        description: `${result.matches.length} concept${result.matches.length === 1 ? "" : "s"} extracted`,
      });
    } catch (e: any) {
      toast.error("NLP analysis failed", { description: e?.message ?? String(e) });
    } finally { setAnalyzing(false); }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const handle = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    const first = intake.firstName.trim();
    const last = intake.lastName.trim();
    if (first.length < 1) { setErr("First name is required."); setOpen((s)=>({...s, demo:true})); return; }
    if (last.length < 1) { setErr("Last name is required."); setOpen((s)=>({...s, demo:true})); return; }
    const ageNum = Number(intake.age);
    if (!Number.isFinite(ageNum) || ageNum < 0 || ageNum > 120) { setErr("Age must be 0–120."); setOpen((s)=>({...s, demo:true})); return; }
    if (intake.chiefComplaint.trim().length < 2) { setErr("Chief complaint is required."); setOpen((s)=>({...s, cc:true})); return; }
    if (mrn && !/^MRN-[A-Za-z0-9-]{3,20}$/.test(mrn.trim())) { setErr("MRN must look like 'MRN-XXXXXX'."); return; }
    setSubmitting(true);
    const ok = await onSubmit({
      name: `${first} ${last}`,
      age: Math.floor(ageNum),
      gender: intake.sex === "Female" ? "F" : "M",
      room,
      code_status: code,
      diagnosis: intake.chiefComplaint.trim(),
      mrn: mrn.trim() || undefined,
      nlp: nlp ?? undefined,
      intake: { ...intake, age: Math.floor(ageNum) },
    });
    setSubmitting(false);
    if (ok) onClose();
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-[var(--navy)]/70 backdrop-blur-sm p-4" onClick={onClose}>
      <div className="w-full max-w-4xl max-h-[92vh] overflow-y-auto rounded-xl bg-card border border-border shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 h-12 bg-[var(--navy)] text-white sticky top-0 z-10">
          <div className="flex items-center gap-2">
            <UserPlus className="h-4 w-4 text-[var(--teal)]" />
            <h2 className="text-sm font-semibold">Admission Case History — New Patient</h2>
          </div>
          <button onClick={onClose} className="grid place-items-center h-7 w-7 rounded-md hover:bg-white/10 transition" aria-label="Close"><X className="h-4 w-4" /></button>
        </div>

        <form onSubmit={handle} className="p-5 space-y-3">
          {/* 1. DEMOGRAPHICS */}
          <Section title="1 · Patient Demographics (Administrative & Identity)" open={open.demo} onToggle={() => toggleSection("demo")}>
            <div className="grid grid-cols-12 gap-3">
              <Field label="First Name" className="col-span-4">
                <Input value={intake.firstName} onChange={(v) => patch({ firstName: v })} placeholder="John" />
              </Field>
              <Field label="Last Name" className="col-span-4">
                <Input value={intake.lastName} onChange={(v) => patch({ lastName: v })} placeholder="Doe" />
              </Field>
              <Field label="Age" className="col-span-2">
                <Input value={String(intake.age || "")} onChange={(v) => patch({ age: Number(v.replace(/[^\d]/g, "")) || 0 })} placeholder="65" />
              </Field>
              <Field label="Date of Birth" className="col-span-2">
                <input type="date" value={intake.dob} onChange={(e) => patch({ dob: e.target.value })} className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm outline-none focus:ring-2 focus:ring-[var(--teal)]/40 focus:border-[var(--teal)]" />
              </Field>
              <Field label="Biological Sex" className="col-span-3">
                <Select value={intake.sex} onChange={(v) => patch({ sex: v as IntakeRecord["sex"] })} options={["", ...SEX_OPTIONS]} placeholder="Select…" />
              </Field>
              <Field label="Gender Identity" className="col-span-3">
                <Select value={intake.genderIdentity} onChange={(v) => patch({ genderIdentity: v as IntakeRecord["genderIdentity"] })} options={["", ...GENDER_IDENTITY_OPTIONS]} placeholder="Select…" />
              </Field>
              <Field label="Phone" className="col-span-3">
                <Input value={intake.phone} onChange={(v) => patch({ phone: v })} placeholder="(555) 123-4567" />
              </Field>
              <Field label="Occupation" className="col-span-3">
                <Input value={intake.occupation} onChange={(v) => patch({ occupation: v })} placeholder="Teacher" />
              </Field>
              <Field label="Address" className="col-span-12">
                <Input value={intake.address} onChange={(v) => patch({ address: v })} placeholder="123 Main St, Springfield" />
              </Field>
              <Field label="Emergency Contact Name" className="col-span-4">
                <Input value={intake.emergencyName} onChange={(v) => patch({ emergencyName: v })} placeholder="Jane Doe" />
              </Field>
              <Field label="Relationship" className="col-span-3">
                <Select value={intake.emergencyRelationship} onChange={(v) => patch({ emergencyRelationship: v as IntakeRecord["emergencyRelationship"] })} options={["", ...RELATIONSHIP_OPTIONS]} placeholder="Select…" />
              </Field>
              <Field label="Emergency Phone" className="col-span-5">
                <Input value={intake.emergencyPhone} onChange={(v) => patch({ emergencyPhone: v })} placeholder="(555) 987-6543" />
              </Field>
              <Field label="Insurance Provider" className="col-span-4">
                <Select value={intake.insuranceProvider} onChange={(v) => patch({ insuranceProvider: v })} options={["","Blue Cross Blue Shield","Aetna","UnitedHealthcare","Cigna","Humana","Kaiser Permanente","Medicare","Medicaid","Self-Pay","Other"]} placeholder="Select…" />
              </Field>
              <Field label="Policy #" className="col-span-3">
                <Input value={intake.insurancePolicy} onChange={(v) => patch({ insurancePolicy: v })} placeholder="POL-123456" />
              </Field>
              <Field label="Primary Care Physician" className="col-span-3">
                <Input value={intake.pcp} onChange={(v) => patch({ pcp: v })} placeholder="Dr. Reyes, MD" />
              </Field>
              <Field label="Guarantor" className="col-span-2">
                <Input value={intake.guarantor} onChange={(v) => patch({ guarantor: v })} placeholder="Self" />
              </Field>
              <Field label="Room / Bed" className="col-span-3">
                <Input value={room} onChange={(v) => setRoom(v)} placeholder="412-A" />
              </Field>
              <Field label="Code Status" className="col-span-3">
                <Select value={code} onChange={(v) => setCode(v as CodeStatus)} options={["Full Code","DNR","DNI","Comfort"]} />
              </Field>
              <Field label="MRN (optional)" className="col-span-6">
                <Input value={mrn} onChange={(v) => setMrn(v)} placeholder="MRN-482910 — auto if blank" />
              </Field>
            </div>
          </Section>

          {/* 2. CC */}
          <Section title="2 · Chief Complaint (CC) — Patient's Own Words" open={open.cc} onToggle={() => toggleSection("cc")}>
            <textarea value={intake.chiefComplaint} onChange={(e) => patch({ chiefComplaint: e.target.value })} rows={2} placeholder='e.g. "Severe chest pain for the last two hours"' className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[var(--teal)]/40 focus:border-[var(--teal)]" />
          </Section>

          {/* 3. HPI */}
          <Section title="3 · History of Present Illness (HPI)" open={open.hpi} onToggle={() => toggleSection("hpi")}>
            <div className="grid grid-cols-12 gap-3">
              <Field label="Onset" className="col-span-4">
                <Input value={intake.hpiOnset} onChange={(v) => patch({ hpiOnset: v })} placeholder="2 hours ago" />
              </Field>
              <Field label="Location / Radiation" className="col-span-5">
                <Input value={intake.hpiLocation} onChange={(v) => patch({ hpiLocation: v })} placeholder="Substernal, radiates to left arm" />
              </Field>
              <Field label="Duration / Frequency" className="col-span-3">
                <Select value={intake.hpiDuration} onChange={(v) => patch({ hpiDuration: v as IntakeRecord["hpiDuration"] })} options={["", ...DURATION_OPTIONS]} placeholder="Select…" />
              </Field>
              <Field label="Character" className="col-span-12">
                <ChipGroup options={CHARACTER_OPTIONS as unknown as string[]} value={intake.hpiCharacter} onToggle={(v) => patch({ hpiCharacter: toggleInArray(intake.hpiCharacter, v) })} />
              </Field>
              <Field label="Aggravating Factors" className="col-span-6">
                <Input value={intake.hpiAggravating} onChange={(v) => patch({ hpiAggravating: v })} placeholder="Exertion, deep breathing" />
              </Field>
              <Field label="Alleviating Factors" className="col-span-6">
                <Input value={intake.hpiAlleviating} onChange={(v) => patch({ hpiAlleviating: v })} placeholder="Rest, nitroglycerin" />
              </Field>
              <Field label={`Severity: ${intake.hpiSeverity}/10`} className="col-span-12">
                <input type="range" min={0} max={10} value={intake.hpiSeverity} onChange={(e) => patch({ hpiSeverity: Number(e.target.value) })} className="w-full accent-[var(--teal)]" />
              </Field>
            </div>
          </Section>

          {/* 4. PMH / PSH */}
          <Section title="4 · Past Medical & Surgical History (PMH/PSH)" open={open.pmh} onToggle={() => toggleSection("pmh")}>
            <div className="space-y-3">
              <Field label="Chronic Illnesses">
                <ChipGroup options={CHRONIC_OPTIONS as unknown as string[]} value={intake.chronicIllnesses} onToggle={(v) => patch({ chronicIllnesses: toggleInArray(intake.chronicIllnesses, v) })} />
              </Field>
              <Field label="Previous Surgeries (procedure, year, complications)">
                <textarea value={intake.priorSurgeries} onChange={(e) => patch({ priorSurgeries: e.target.value })} rows={2} className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[var(--teal)]/40" />
              </Field>
              <Field label="Past Hospitalizations">
                <textarea value={intake.pastHospitalizations} onChange={(e) => patch({ pastHospitalizations: e.target.value })} rows={2} className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[var(--teal)]/40" />
              </Field>
            </div>
          </Section>

          {/* 5. Allergies & Meds */}
          <Section title="5 · Allergies & Current Medications" open={open.allergies} onToggle={() => toggleSection("allergies")}>
            <div className="space-y-3">
              <Field label="Drug Allergies (name + reaction)">
                <div className="space-y-1.5">
                  {intake.drugAllergies.length === 0 && (
                    <p className="text-[11px] text-muted-foreground italic">No known drug allergies (NKDA)</p>
                  )}
                  {intake.drugAllergies.map((a, idx) => (
                    <div key={idx} className="flex items-center gap-2">
                      <Input value={a.name} onChange={(v) => patch({ drugAllergies: intake.drugAllergies.map((x,i)=>i===idx?{...x,name:v}:x) })} placeholder="Penicillin" />
                      <Input value={a.reaction} onChange={(v) => patch({ drugAllergies: intake.drugAllergies.map((x,i)=>i===idx?{...x,reaction:v}:x) })} placeholder="Hives / Anaphylaxis" />
                      <button type="button" onClick={() => patch({ drugAllergies: intake.drugAllergies.filter((_,i)=>i!==idx) })} className="grid place-items-center h-9 w-9 rounded-md border border-border hover:bg-red-50 hover:text-red-600"><X className="h-3.5 w-3.5" /></button>
                    </div>
                  ))}
                  <button type="button" onClick={() => patch({ drugAllergies: [...intake.drugAllergies, { name: "", reaction: "" }] })} className="inline-flex items-center gap-1 text-[11px] font-semibold text-[var(--teal)] hover:underline"><Plus className="h-3 w-3" /> Add drug allergy</button>
                </div>
              </Field>
              <Field label="Environmental / Food Allergies">
                <ChipGroup options={ENV_ALLERGY_OPTIONS as unknown as string[]} value={intake.envAllergies} onToggle={(v) => patch({ envAllergies: toggleInArray(intake.envAllergies, v) })} />
              </Field>
              <Field label="Current Medications (Rx, OTC, supplements)">
                <div className="space-y-1.5">
                  {intake.currentMeds.length === 0 && (
                    <p className="text-[11px] text-muted-foreground italic">None reported</p>
                  )}
                  {intake.currentMeds.map((m, idx) => (
                    <div key={idx} className="grid grid-cols-12 gap-2 items-center">
                      <div className="col-span-5"><Input value={m.name} onChange={(v) => patch({ currentMeds: intake.currentMeds.map((x,i)=>i===idx?{...x,name:v}:x) })} placeholder="Lisinopril" /></div>
                      <div className="col-span-3"><Input value={m.dose} onChange={(v) => patch({ currentMeds: intake.currentMeds.map((x,i)=>i===idx?{...x,dose:v}:x) })} placeholder="10 mg" /></div>
                      <div className="col-span-3"><Select value={m.freq} onChange={(v) => patch({ currentMeds: intake.currentMeds.map((x,i)=>i===idx?{...x,freq:v}:x) })} options={["","PO Daily","PO BID","PO TID","PO QID","PO QHS","PO Q6H","PO Q8H","PRN","IV Daily"]} placeholder="Freq" /></div>
                      <button type="button" onClick={() => patch({ currentMeds: intake.currentMeds.filter((_,i)=>i!==idx) })} className="col-span-1 grid place-items-center h-9 rounded-md border border-border hover:bg-red-50 hover:text-red-600"><X className="h-3.5 w-3.5" /></button>
                    </div>
                  ))}
                  <button type="button" onClick={() => patch({ currentMeds: [...intake.currentMeds, { name: "", dose: "", freq: "" }] })} className="inline-flex items-center gap-1 text-[11px] font-semibold text-[var(--teal)] hover:underline"><Plus className="h-3 w-3" /> Add medication</button>
                </div>
              </Field>
            </div>
          </Section>

          {/* 6. Family Hx */}
          <Section title="6 · Family History" open={open.family} onToggle={() => toggleSection("family")}>
            <div className="space-y-3">
              <Field label="Conditions in Immediate Blood Relatives">
                <ChipGroup options={FAMILY_OPTIONS as unknown as string[]} value={intake.familyConditions} onToggle={(v) => patch({ familyConditions: toggleInArray(intake.familyConditions, v) })} />
              </Field>
              <Field label="Notes (relationship, age, condition)">
                <textarea value={intake.familyNotes} onChange={(e) => patch({ familyNotes: e.target.value })} rows={2} placeholder="Father deceased age 68 — MI. Mother alive, HTN." className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[var(--teal)]/40" />
              </Field>
            </div>
          </Section>

          {err && (
            <div className="text-xs text-red-600 inline-flex items-center gap-1.5">
              <AlertTriangle className="h-3.5 w-3.5" />{err}
            </div>
          )}

          <div className="flex items-center justify-end gap-2 pt-3 border-t border-border sticky bottom-0 bg-card -mx-5 -mb-5 px-5 py-3">
            <button type="button" onClick={onClose} className="rounded-md border border-border bg-background px-3 h-9 text-xs font-medium hover:bg-secondary transition">Cancel</button>
            <button type="button" onClick={handleAutoFill} className="inline-flex items-center gap-1.5 rounded-md border border-amber-300 bg-amber-50 hover:bg-amber-100 text-amber-900 px-3 h-9 text-xs font-semibold shadow-sm transition" title="Populate plausible mock data into every field">
              <Wand2 className="h-3.5 w-3.5" /> Auto-Fill
            </button>
            <button type="submit" disabled={submitting} className="inline-flex items-center gap-1.5 rounded-md bg-[var(--teal)] hover:bg-[var(--teal)]/90 text-white px-4 h-9 text-xs font-semibold shadow-sm transition disabled:opacity-60">
              {submitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <UserPlus className="h-3.5 w-3.5" />}
              Admit Patient
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/* ---- Reusable modal subcomponents ---- */
function Section({ title, open, onToggle, children }: { title: string; open: boolean; onToggle: () => void; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-border bg-background/60">
      <button type="button" onClick={onToggle} className="w-full flex items-center justify-between px-3 h-10 text-left text-[12px] font-bold uppercase tracking-wider text-slate-700 hover:bg-secondary/40 transition rounded-t-lg">
        <span>{title}</span>
        <ChevronDown className={`h-4 w-4 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && <div className="px-3 pb-3 pt-1 border-t border-border">{children}</div>}
    </section>
  );
}

function Input({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-[var(--teal)]/40 focus:border-[var(--teal)] transition"
    />
  );
}

function Select({ value, onChange, options, placeholder }: { value: string; onChange: (v: string) => void; options: readonly string[]; placeholder?: string }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm outline-none focus:ring-2 focus:ring-[var(--teal)]/40 focus:border-[var(--teal)] transition">
      {options.map((o) => (
        <option key={o} value={o}>{o === "" ? (placeholder ?? "—") : o}</option>
      ))}
    </select>
  );
}

function ChipGroup({ options, value, onToggle }: { options: string[]; value: string[]; onToggle: (v: string) => void }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((o) => {
        const on = value.includes(o);
        return (
          <button key={o} type="button" onClick={() => onToggle(o)} className={`rounded-full px-2.5 py-1 text-[11px] font-medium border transition ${on ? "bg-[var(--teal)] text-white border-[var(--teal)]" : "bg-background text-slate-700 border-border hover:border-[var(--teal)]/60"}`}>
            {o}
          </button>
        );
      })}
    </div>
  );
}

function Field({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <label className={`flex flex-col gap-1.5 ${className ?? ""}`}>
      <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
        {label}
      </span>
      {children}
    </label>
  );
}

function ConfirmDischargeModal({
  patient,
  onCancel,
  onConfirm,
}: {
  patient: PatientRow;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-[var(--navy)]/70 backdrop-blur-sm p-4"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-sm rounded-xl bg-card border border-border shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-5">
          <div className="grid place-items-center h-10 w-10 rounded-full bg-red-50 text-red-600 mb-3">
            <Trash2 className="h-5 w-5" />
          </div>
          <h3 className="text-base font-semibold">Discharge patient?</h3>
          <p className="text-sm text-muted-foreground mt-1">
            Are you sure you want to discharge{" "}
            <span className="font-medium text-foreground">{patient.name}</span> (
            {patient.mrn})? This will remove them from the floor census.
          </p>
        </div>
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-border bg-secondary/30">
          <button
            onClick={onCancel}
            className="rounded-md border border-border bg-background px-3 h-9 text-xs font-medium hover:bg-secondary transition"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="inline-flex items-center gap-1.5 rounded-md bg-red-600 hover:bg-red-700 text-white px-3 h-9 text-xs font-semibold shadow-sm transition"
          >
            <Trash2 className="h-3.5 w-3.5" />
            Discharge
          </button>
        </div>
      </div>
    </div>
  );
}
