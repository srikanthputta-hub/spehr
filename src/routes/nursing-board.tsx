import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { BoardHeader } from "@/components/BoardShell";
import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";
import { LiveClock } from "@/components/common/LiveClock";
import { BedManagementBoard } from "@/components/admissions/BedManagementBoard";
import {
  Loader2,
  Search,
  Users,
  AlertTriangle,
  BedDouble,
  ChevronRight,
  Activity,
  X,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { type CodeStatus } from "@/lib/patients";
import { useFacility, useActiveNurse } from "@/lib/facility-context";
import { useAutomationEnabled } from "@/hooks/useAutomationEnabled";
import { useRolePermissions } from "@/hooks/useRolePermissions";
import { fetchWithTimeout } from "@/lib/async-timeout";
import CohortCountsStrip from "@/components/analytics/CohortCountsStrip";
import { dischargePatientViaWorker } from "@/lib/discharge-patient";
import { reconcileOrphanedBeds } from "@/lib/admit-patient";
import { InfoHint } from "@/components/ui/info-hint";
import { StatusBadge, type StatusBadgeProps } from "@/components/common/StatusBadge";
import { TableSkeleton } from "@/components/common/LoadingSkeleton";
import { EmptyState } from "@/components/common/EmptyState";
import { severityRowVariants } from "@/components/common/SeverityRow";
import { cn } from "@/lib/utils";

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

// `reconcileOrphanedBeds` (releases beds whose `current_patient_mrn` no
// longer maps to an actively admitted patient) is shared from
// @/lib/admit-patient — it used to be duplicated here verbatim.

type AlertKind = "sepsis" | "stemi" | "dka" | "stroke" | "pending";
function classifyAlert(dx: string | null | undefined): AlertKind {
  const d = (dx ?? "").toLowerCase();
  if (d.includes("sepsis")) return "sepsis";
  if (d.includes("stemi")) return "stemi";
  if (d.includes("dka")) return "dka";
  if (d.includes("stroke")) return "stroke";
  return "pending";
}

type AlertSeverity = "critical" | "warning" | "none";

interface ClinicalAlertInfo {
  label: string;
  status: StatusBadgeProps["status"];
  severity: AlertSeverity;
}

function computeClinicalAlert({
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
}): ClinicalAlertInfo {
  let sys: number | undefined;
  let dia: number | undefined;
  if (bp) {
    const [s, d] = bp.split("/").map((n) => parseInt(n, 10));
    if (!isNaN(s)) sys = s;
    if (!isNaN(d)) dia = d;
  }

  // Severity-ordered, vitals-driven alerts (override the diagnosis pill).
  if ((typeof sys === "number" && sys > 180) || (typeof dia === "number" && dia > 120)) {
    return { label: "🆘 Hypertensive Crisis", status: "critical", severity: "critical" };
  }
  if (typeof o2 === "number" && o2 < 90) {
    return { label: "🫁 Hypoxia Alert", status: "critical", severity: "critical" };
  }
  if (typeof temp === "number" && temp < 95.0) {
    return { label: "🥶 Hypothermia", status: "critical", severity: "critical" };
  }
  if (typeof temp === "number" && temp > 100.4) {
    return { label: "🌡️ Fever", status: "warning", severity: "warning" };
  }
  if (typeof sys === "number" && sys < 90) {
    return { label: "📉 Hypotension", status: "critical", severity: "critical" };
  }
  if (typeof hr === "number" && hr < 60) {
    return { label: "🐢 Bradycardia", status: "warning", severity: "warning" };
  }
  if (typeof hr === "number" && hr > 100) {
    return { label: "⚡ Tachycardia", status: "warning", severity: "warning" };
  }
  if ((typeof sys === "number" && sys > 130) || (typeof dia === "number" && dia > 80)) {
    return { label: "🩺 Hypertension", status: "info", severity: "none" };
  }
  if (typeof rr === "number" && rr < 12) {
    return { label: "💨 Bradypnea", status: "warning", severity: "warning" };
  }
  if (typeof rr === "number" && rr > 20) {
    return { label: "💨 Tachypnea", status: "warning", severity: "warning" };
  }
  if (typeof o2 === "number" && o2 < 95) {
    return { label: "🫁 Low SpO₂", status: "warning", severity: "warning" };
  }

  // Fall back to diagnosis-driven pill when vitals are within range.
  const kind = classifyAlert(dx);
  if (kind === "sepsis") {
    return { label: "🚨 Sepsis Watch", status: "critical", severity: "critical" };
  }
  switch (kind) {
    case "stemi":
      return { label: "❤️ Cath Lab Alert", status: "critical", severity: "critical" };
    case "dka":
      return { label: "🩸 ABG / Insulin Protocol", status: "warning", severity: "warning" };
    case "stroke":
      return { label: "🧠 Stroke Alert", status: "critical", severity: "critical" };
    default:
      return { label: "🟢 Stable", status: "success", severity: "none" };
  }
}

function ClinicalAlertPill(props: {
  dx: string | null | undefined;
  hr?: number;
  o2?: number;
  bp?: string;
  rr?: number;
  temp?: number;
}) {
  const { label, status } = computeClinicalAlert(props);
  return <StatusBadge status={status} label={label} />;
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
        <span
          className={
            hrCritical ? "text-red-600 font-extrabold animate-pulse" : "text-emerald-600 font-bold"
          }
        >
          {hr}
        </span>
        <span className="text-slate-400"> bpm</span>
      </div>
      <div>
        <span className="text-slate-400">BP </span>
        <span
          className={
            sysCritical
              ? "text-red-600 font-extrabold animate-pulse"
              : sysWarn
                ? "text-amber-600 font-bold"
                : "text-slate-800 font-semibold"
          }
        >
          {sys}
        </span>
        <span className="text-slate-500">/{dia}</span>
      </div>
      <div>
        <span className="text-slate-400">SpO₂ </span>
        <span
          className={
            spo2Critical
              ? "text-red-600 font-extrabold animate-pulse"
              : spo2Warn
                ? "text-amber-600 font-bold"
                : "text-cyan-600 font-bold"
          }
        >
          {spo2}
        </span>
        <span className="text-slate-400">%</span>
      </div>
      <div>
        <span className="text-slate-400">RR </span>
        <span className={rrAlert ? "text-amber-600 font-bold" : "text-slate-700 font-semibold"}>
          {rr}
        </span>
        <span className="text-slate-400"> /min</span>
      </div>
      <div>
        <span className="text-slate-400">T </span>
        <span
          className={
            tempCritical
              ? "text-red-600 font-extrabold animate-pulse"
              : tempWarn
                ? "text-amber-600 font-bold"
                : "text-slate-700 font-semibold"
          }
        >
          {temp.toFixed(1)}
        </span>
        <span className="text-slate-400">°F</span>
      </div>
    </div>
  );
}

type ToRowPatient = Pick<
  Database["public"]["Tables"]["patients"]["Row"],
  | "mrn"
  | "first_name"
  | "last_name"
  | "room"
  | "age"
  | "gender"
  | "code_status"
  | "chief_complaint"
  | "hr"
  | "bp_systolic"
  | "bp_diastolic"
  | "spo2"
  | "meds_due_count"
  | "facility_name"
  | "unread_labs_alert"
  | "admission_time"
  | "rr"
  | "temp"
>;

function toRow(p: ToRowPatient): PatientRow {
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
    rr: p.rr ?? 0,
    temp: p.temp ?? 0,
  };
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
  const [query, setQuery] = useState("");
  const [patients, setPatients] = useState<PatientRow[]>([]);
  const [loading, setLoading] = useState(true);
  const initialLoadRef = useRef(true);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [liveConnected, setLiveConnected] = useState(false);
  const [discharging, setDischarging] = useState<PatientRow | null>(null);
  const [showOnlyMedsDue, setShowOnlyMedsDue] = useState(false);
  const [bedBoardOpen, setBedBoardOpen] = useState(false);
  const [bedCounts, setBedCounts] = useState<{ available: number; total: number }>({
    available: 0,
    total: 0,
  });
  const [admittedFacilityCount, setAdmittedFacilityCount] = useState<number>(0);
  const [alertMrns, setAlertMrns] = useState<Set<string>>(new Set());
  const automationEnabled = useAutomationEnabled();
  const { gate } = useRolePermissions("RN");

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setEmail(data.session?.user.email ?? "demo@sgroup.health");
      setReady(true);
    });
  }, []);

  useEffect(() => {
    if (!facility) return;
    let cancelled = false;
    const load = async () => {
      await reconcileOrphanedBeds(facility).catch(() => {});
      const { data } = await supabase
        .from("bed_management")
        .select("status")
        .eq("facility_name", facility);
      if (cancelled || !data) return;
      const available = data.filter(
        (b: { status: string | null }) => (b.status ?? "").toLowerCase() === "available",
      ).length;
      setBedCounts({ available, total: data.length });
      const { count } = await supabase
        .from("patients")
        .select("mrn", { count: "exact", head: true })
        .eq("facility_name", facility)
        .eq("status", "Admitted");
      if (!cancelled) setAdmittedFacilityCount(count ?? 0);
    };
    load();
    const ch = supabase
      .channel(`bed-count-${facility}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "bed_management",
          filter: `facility_name=eq.${facility}`,
        },
        () => load(),
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "patients", filter: `facility_name=eq.${facility}` },
        () => load(),
      )
      .subscribe();
    const interval = setInterval(load, 30000);
    return () => {
      cancelled = true;
      supabase.removeChannel(ch);
      clearInterval(interval);
    };
  }, [facility]);

  useEffect(() => {
    if (!facility) return;
    let cancelled = false;
    const load = async () => {
      const { data } = await supabase
        .from("clinical_safety_alerts")
        .select("mrn")
        .eq("facility_name", facility)
        .eq("status", "Pending Review");
      if (!cancelled) setAlertMrns(new Set((data ?? []).map((r) => r.mrn)));
    };
    load();
    const ch = supabase
      .channel(`safety-alerts-board-${facility}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "clinical_safety_alerts",
          filter: `facility_name=eq.${facility}`,
        },
        () => load(),
      )
      .subscribe();
    return () => {
      cancelled = true;
      supabase.removeChannel(ch);
    };
  }, [facility]);

  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    const load = async () => {
      if (initialLoadRef.current) setLoading(true);
      setFetchError(null);
      // Floor census is bed-driven. The authoritative list of patients
      // currently on the unit is "every Occupied bed in this facility".
      // We then hydrate patient rows by MRN so the Floor Overview count
      // ALWAYS matches the occupied-bed KPI / Bed Allocation matrix.
      const { data: occBeds, error: bedErr } = await fetchWithTimeout(
        async () => {
          const res = await supabase
            .from("bed_management")
            .select("current_patient_mrn, room_number, bed_letter, status")
            .eq("facility_name", facility)
            .ilike("status", "Occupied%")
            .not("current_patient_mrn", "is", null);
          return { data: res.data, error: res.error };
        },
        { data: [], error: null },
      );
      if (cancelled) return;
      if (bedErr) {
        setFetchError(bedErr.message);
        setLoading(false);
        initialLoadRef.current = false;
        return;
      }
      const bedByMrn = new Map<string, { room: string }>();
      for (const b of occBeds ?? []) {
        if (!b.current_patient_mrn) continue;
        bedByMrn.set(b.current_patient_mrn, {
          room: `${b.room_number}-${b.bed_letter}`,
        });
      }
      const mrns = Array.from(bedByMrn.keys());
      if (mrns.length === 0) {
        setPatients([]);
        setLoading(false);
        initialLoadRef.current = false;
        return;
      }
      const { data, error } = await fetchWithTimeout(
        async () => {
          const res = await supabase
            .from("patients")
            .select(
              "mrn, first_name, last_name, age, gender, code_status, chief_complaint, room, hr, bp_systolic, bp_diastolic, spo2, rr, temp, meds_due_count, facility_name, unread_labs_alert, status, admission_time",
            )
            .in("mrn", mrns);
          return { data: res.data, error: res.error };
        },
        { data: [], error: null },
      );
      if (cancelled) return;
      if (error) {
        setFetchError(error.message);
        setLoading(false);
        initialLoadRef.current = false;
        return;
      }
      const patientByMrn = new Map<string, NonNullable<typeof data>[number]>();
      for (const p of data ?? []) patientByMrn.set(p.mrn, p);
      // Build one row per occupied bed. If clinical/intake data hasn't
      // initialized yet, surface a minimal "Initializing…" placeholder
      // so the row count still matches the bed tally exactly.
      const rows: PatientRow[] = mrns.map((mrn) => {
        const p = patientByMrn.get(mrn);
        const bed = bedByMrn.get(mrn)!;
        if (p) {
          const row = toRow(p);
          // Prefer the live bed assignment over any stale patient.room.
          return { ...row, room: bed.room, facility };
        }
        return {
          mrn,
          name: "Initializing…",
          room: bed.room,
          age: 0,
          sex: "",
          code: "Full Code",
          diagnosis: "Awaiting intake",
          hr: 0,
          bp: "—/—",
          o2: 0,
          rr: 0,
          temp: 0,
          task: "—",
          medsDue: 0,
          facility,
          unreadLabs: false,
          admittedAt: null,
        };
      });
      // Sort: real patients first (newest admission), placeholders last by room.
      rows.sort((a, b) => {
        if (!!a.admittedAt !== !!b.admittedAt) return a.admittedAt ? -1 : 1;
        if (a.admittedAt && b.admittedAt) return b.admittedAt.localeCompare(a.admittedAt);
        return (a.room ?? "").localeCompare(b.room ?? "");
      });
      setPatients(rows);
      setLoading(false);
      initialLoadRef.current = false;
    };
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleLoad = () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        void load();
      }, 250);
    };
    load();
    // Re-load whenever bed_management OR patients change for this facility
    // so the Floor Overview tally never drifts from the bed KPI.
    const ch = supabase
      .channel(`floor-census-${facility}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "bed_management",
          filter: `facility_name=eq.${facility}`,
        },
        scheduleLoad,
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "patients", filter: `facility_name=eq.${facility}` },
        scheduleLoad,
      )
      .subscribe();
    return () => {
      cancelled = true;
      if (debounceTimer) clearTimeout(debounceTimer);
      supabase.removeChannel(ch);
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
          const p = payload.new as Database["public"]["Tables"]["patients"]["Row"];
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
                    rr: p.rr ?? row.rr,
                    temp: p.temp ?? row.temp,
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
          const row = toRow(payload.new as Database["public"]["Tables"]["patients"]["Row"]);
          setPatients((prev) => (prev.some((p) => p.mrn === row.mrn) ? prev : [...prev, row]));
        },
      )
      .on(
        "postgres_changes",
        { event: "DELETE", schema: "public", table: "patients" },
        (payload) => {
          const oldMrn = (payload.old as { mrn?: string } | null)?.mrn;
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
    const jitter = (range: number) => Math.floor(Math.random() * (2 * range + 1)) - range;
    const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
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
      list = list.filter((p) => (p.medsDue ?? 0) > 0);
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

  const handleDischarge = async (p: PatientRow) => {
    const prev = patients;
    setPatients((curr) => curr.filter((x) => x.mrn !== p.mrn));
    // Route through ghost-discharge-worker so the DISCHARGE_SUMMARY note,
    // real-data FHIR Composition and bed release all happen together.
    const result = await dischargePatientViaWorker({ mrn: p.mrn });
    if (!result.ok) {
      setPatients(prev);
      toast.error("Could not discharge", { description: result.reason ?? "unknown_error" });
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
        <div className="max-w-[1400px] mx-auto px-3 md:px-5 h-12 flex items-center gap-4">
          <div className="flex-1 max-w-md">
            <div className="flex items-center gap-2 h-9 rounded-md bg-white/10 ring-1 ring-white/10 px-3 focus-within:bg-white/15 focus-within:ring-[var(--teal)]/40 transition">
              <Search className="h-4 w-4 text-white/60" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search chart — name, MRN, room, dx…"
                aria-label="Search patients by name, MRN, room, or diagnosis"
                className="w-full bg-transparent outline-none text-sm placeholder:text-white/45"
              />
            </div>
          </div>
          <div className="hidden sm:flex flex-col items-end leading-tight tabular-nums">
            <LiveClock
              className="text-sm font-semibold tracking-tight"
              dateClassName="text-[10px] uppercase tracking-wider text-white/55"
            />
          </div>
        </div>
      </div>

      <div className="max-w-[1400px] mx-auto px-5 py-6 space-y-6">
        <section className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3">
          <StatCard
            icon={Users}
            label="Total Patients"
            value={`${admittedFacilityCount}`}
            tone="navy"
            info={`Live count of rows in the patients table where facility_name = "${facility}" AND status = "Admitted" — the same query the physician board uses, refreshed via realtime.`}
          />
          <StatCard
            icon={AlertTriangle}
            label="Critical Alerts"
            value={`${facilityPatients.filter((p) => p.o2 < 90 || p.hr > 115).length}`}
            tone="red"
            sub="SpO₂ < 90% or HR > 115 bpm"
            info="Currently defined as SpO₂ < 90% OR HR > 115 bpm only — blood pressure, temperature, and respiratory rate thresholds are NOT included in this tile today."
          />
          <CohortCountsStrip facilityName={facility} variant="card" />
          <StatCard
            icon={BedDouble}
            label="Available Beds"
            value={`${bedCounts.available}`}
            tone="teal"
            sub={
              bedCounts.available === 0 && bedCounts.total > 0
                ? `⚠ No empty beds available · 0 of ${bedCounts.total} open · click to manage`
                : `${bedCounts.available} of ${bedCounts.total} beds open · click to manage`
            }
            warn={bedCounts.available === 0 && bedCounts.total > 0}
            interactive
            active={bedBoardOpen}
            onClick={() => setBedBoardOpen(true)}
            info={`Beds where bed_management.status = "Available" at ${facility}. Beds in "Cleaning" (60s terminal clean) or "Disinfecting" (extended isolation protocol) are NOT counted as available until the cycle completes.`}
          />
        </section>

        <section className="rounded-xl border border-border bg-card overflow-hidden shadow-[0_1px_0_rgba(15,23,42,0.04)]">
          <div className="flex items-center justify-between px-5 h-12 border-b border-border bg-secondary/40">
            <div className="flex items-center gap-2">
              <Activity className="h-4 w-4 text-[var(--teal)]" />
              <h2 className="text-sm font-semibold tracking-tight">
                Floor Overview -&nbsp;{nurse.ward.split(" - ").pop()}
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
              <span
                className={liveConnected ? "text-emerald-600 font-medium" : "text-muted-foreground"}
              >
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
                    <td colSpan={8} className="p-4">
                      <TableSkeleton rows={5} columns={8} />
                    </td>
                  </tr>
                )}
                {!loading && fetchError && (
                  <tr>
                    <td colSpan={8} className="px-5 py-10 text-center text-sm">
                      <div className="inline-flex items-center gap-2 text-critical">
                        <AlertTriangle className="h-4 w-4" />
                        Unable to load patients — {fetchError}
                      </div>
                    </td>
                  </tr>
                )}
                {!loading && !fetchError && rows.length === 0 && (
                  <tr>
                    <td colSpan={8} className="px-5 py-8">
                      <EmptyState
                        title="Floor census empty"
                        description={`No occupied beds at ${facility} right now — this list fills in automatically as patients are triaged and admitted.`}
                      />
                    </td>
                  </tr>
                )}
                {!loading &&
                  !fetchError &&
                  rows.map((p, i) => {
                    const room = p.room?.trim() || "—";
                    const alert = computeClinicalAlert({
                      dx: p.diagnosis,
                      hr: p.hr,
                      o2: p.o2,
                      bp: p.bp,
                      rr: p.rr,
                      temp: p.temp,
                    });
                    const hasSafetyAlert = alertMrns.has(p.mrn);
                    const rowSeverity: AlertSeverity = hasSafetyAlert ? "critical" : alert.severity;
                    return (
                      <tr
                        key={p.mrn}
                        className={cn(
                          "border-b border-slate-200 hover:bg-[var(--teal-soft)]/40 transition",
                          i % 2 === 1 ? "bg-slate-50/60" : "bg-white",
                          severityRowVariants({ severity: rowSeverity }),
                        )}
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
                          <span className="inline-flex items-center gap-1.5">
                            <ClinicalAlertPill
                              dx={p.diagnosis}
                              hr={p.hr}
                              o2={p.o2}
                              bp={p.bp}
                              rr={p.rr}
                              temp={p.temp}
                            />
                            {hasSafetyAlert && (
                              <StatusBadge
                                status="critical"
                                label="🚨 Safety Alert"
                                title="Active clinical safety alert — pending review in Medical Dictionary → Safety Alerts"
                              />
                            )}
                          </span>
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
          Signed in as {email}. Vitals shown are synthetic for design review — live device telemetry
          will replace this feed.
        </p>
      </div>

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

function StatCard({
  icon: Icon,
  label,
  value,
  sub,
  tone,
  interactive,
  active,
  onClick,
  warn,
  info,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  sub?: string;
  tone: "navy" | "teal" | "red";
  interactive?: boolean;
  active?: boolean;
  onClick?: () => void;
  warn?: boolean;
  info?: string;
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
  const Comp = interactive ? "button" : "div";
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
          {info && <InfoHint className="ml-1.5" text={info} />}
          {interactive && (
            <span
              className={`ml-2 inline-flex items-center rounded-full px-1.5 py-0.5 text-[9px] font-semibold tracking-wider ${active ? "bg-[var(--teal)] text-white" : "bg-secondary text-muted-foreground"}`}
            >
              {active ? "FILTER ON" : "FILTER"}
            </span>
          )}
        </div>
        <div className="flex items-baseline gap-2">
          <div className="text-2xl font-semibold tracking-tight tabular-nums">{value}</div>
          {sub && (
            <div
              className={`text-xs truncate ${
                warn ? "text-red-600 font-semibold" : "text-muted-foreground"
              }`}
            >
              {sub}
            </div>
          )}
        </div>
      </div>
    </Comp>
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
            <span className="font-medium text-foreground">{patient.name}</span> ({patient.mrn})?
            This will remove them from the floor census.
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
