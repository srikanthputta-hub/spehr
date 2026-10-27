import { createFileRoute } from "@tanstack/react-router";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  BedDouble,
  CalendarClock,
  CheckCircle2,
  ClipboardList,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  Wand2,
  UserPlus,
  Users,
  X,
  type LucideIcon,
} from "lucide-react";
import { BoardHeader } from "@/components/BoardShell";
import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";
import { useFacility, useActiveStaff } from "@/lib/facility-context";
import { admitPatient, type AdmitInput } from "@/lib/admit-patient";
import { AdmitPatientModal } from "@/components/admissions/AdmitPatientModal";
import { BedManagementBoard } from "@/components/admissions/BedManagementBoard";
import spehrLogo from "@/assets/spehr-logo.png";
import { fetchWithTimeout } from "@/lib/async-timeout";
import { InfoHint } from "@/components/ui/info-hint";
import { StatusBadge } from "@/components/common/StatusBadge";
import { EmptyState } from "@/components/common/EmptyState";
import { TableSkeleton } from "@/components/common/LoadingSkeleton";

export const Route = createFileRoute("/admissions-board")({
  component: AdmissionsBoard,
});

type TabKey = "home" | "admit" | "roster" | "scheduling" | "beds";

function AdmissionsBoard() {
  const { facility } = useFacility();
  const staff = useActiveStaff("Reception");
  const [tab, setTab] = useState<TabKey>("home");
  const [bedCounts, setBedCounts] = useState({ available: 0, total: 0 });

  useEffect(() => {
    const cancelled = false;
    const load = async () => {
      const { data } = await fetchWithTimeout(
        async () => {
          const res = await supabase
            .from("bed_management")
            .select("status")
            .eq("facility_name", facility);
          return { data: res.data, error: res.error };
        },
        { data: [] as Array<{ status: string | null }>, error: null },
      );
      if (cancelled || !data) return;
      const available = data.filter((b) => (b.status ?? "").toLowerCase() === "available").length;
      setBedCounts({ available, total: data.length });
    };
    load();
    const ch = supabase
      .channel(`reception-bed-count-${facility}`)
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
      .subscribe();
    return () => {
      supabase.removeChannel(ch);
    };
  }, [facility]);

  const handleAdmit = async (input: AdmitInput): Promise<boolean> => {
    if (bedCounts.available === 0) {
      toast.error("No empty beds available", {
        description: `${facility} is at full capacity (${bedCounts.total}/${bedCounts.total} occupied). Please direct the patient to the Patient Lounge until a bed is released.`,
      });
      return false;
    }
    const res = await admitPatient(facility, input);
    if (!res.ok) {
      toast.error("Could not admit patient", { description: res.error });
      return false;
    }
    toast.success("Patient admitted", {
      description: `${res.patient?.first_name} ${res.patient?.last_name} · ${res.patient?.mrn}`,
    });
    setTab("roster");
    return true;
  };

  const tabs: { key: TabKey; label: string; icon: LucideIcon }[] = [
    { key: "home", label: "Home", icon: ClipboardList },
    { key: "admit", label: "Admit Patient", icon: UserPlus },
    { key: "roster", label: "Patient Census", icon: Users },
    { key: "scheduling", label: "Scheduling", icon: CalendarClock },
    { key: "beds", label: "Bed Management", icon: BedDouble },
  ];

  return (
    <main className="min-h-screen bg-background">
      <BoardHeader
        title="Admissions Desk"
        subtitle={`${staff.name} · ${staff.facility} — ${staff.ward}`}
        badge="Reception"
      />

      <div className="sticky top-0 z-10 border-b border-border bg-[var(--navy)] text-white">
        <div className="max-w-[1400px] mx-auto px-3 md:px-5 h-12 flex items-center gap-2">
          <div className="flex-1 min-w-0 overflow-x-auto snap-x snap-mandatory board-tabs-scroll">
            <div className="flex items-center gap-1 w-max">
              {tabs.map((t) => {
                const Icon = t.icon;
                const active = tab === t.key;
                return (
                  <button
                    key={t.key}
                    onClick={() => setTab(t.key)}
                    className={`snap-start shrink-0 inline-flex items-center gap-1.5 h-9 px-3 rounded-md text-xs font-semibold transition ${
                      active
                        ? "bg-[var(--teal)] text-white shadow"
                        : "text-white/70 hover:bg-white/10 hover:text-white"
                    }`}
                  >
                    <Icon className="h-3.5 w-3.5" /> {t.label}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="hidden sm:inline-flex shrink-0 text-[11px] text-white/60 items-center gap-1">
            {bedCounts.available} / {bedCounts.total} beds open
            <InfoHint
              text={`Beds where bed_management.status = "Available" at ${facility}. Beds in "Cleaning" or "Disinfecting" are not counted as open — they roll back to Available automatically when the cleaning cycle finishes.`}
            />
          </div>
        </div>
      </div>

      <div className="max-w-[1400px] mx-auto px-5 py-6 space-y-4">
        {tab === "home" && (
          <div className="min-h-[60vh] flex flex-col items-center justify-center gap-8 py-12">
            <div className="relative flex items-center justify-center">
              <div className="absolute inset-0 rounded-full bg-[radial-gradient(circle,rgba(20,80,80,0.15)_0%,transparent_70%)] blur-2xl scale-150" />
              <img
                src={spehrLogo}
                alt="S Group Private Network"
                className="relative h-96 w-auto md:h-[28rem] drop-shadow-2xl"
              />
            </div>
          </div>
        )}
        {/* Keep roster mounted to preserve state and avoid remount flash on tab switch */}
        <div style={{ display: tab === "roster" ? "block" : "none" }}>
          <RosterTab facility={facility} />
        </div>
        {tab === "scheduling" && <SchedulingTab facility={facility} />}
        {(tab === "admit" || tab === "beds") && (
          <div className="rounded-xl border border-dashed border-border bg-card/40 p-10 text-center text-sm text-muted-foreground">
            Opening {tab === "admit" ? "admission form" : "bed board"}…
          </div>
        )}
      </div>

      {tab === "admit" && (
        <AdmitPatientModal onClose={() => setTab("roster")} onSubmit={handleAdmit} />
      )}
      {tab === "beds" && (
        <BedManagementBoard facility={facility} onClose={() => setTab("roster")} />
      )}
    </main>
  );
}

/* ----------------------------------------------------------------- */
/* Patient Roster — admitted (in-progress) + recently discharged      */
/* ----------------------------------------------------------------- */

interface EncounterRow {
  mrn: string;
  name: string;
  dob: string | null;
  address: string | null;
  status: "in-progress" | "finished";
  start: string | null;
  end: string | null;
  room: string | null;
}

function RosterTab({ facility }: { facility: string }) {
  const [rows, setRows] = useState<EncounterRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const initialLoadRef = useRef(true);

  const load = async () => {
    // Source: `patients` (the local mirror of the FHIR Encounter resource).
    // status = 'Admitted' → FHIR Encounter.status = in-progress
    // status = 'Discharged' → FHIR Encounter.status = finished
    if (initialLoadRef.current) setLoading(true);
    const { data } = await fetchWithTimeout(
      async () => {
        const res = await supabase
          .from("patients")
          .select(
            "mrn, first_name, last_name, dob, address, status, admission_time, discharge_time, room",
          )
          .eq("facility_name", facility)
          .order("admission_time", { ascending: false })
          .limit(150);
        return { data: res.data, error: res.error };
      },
      {
        data: [] as Array<
          Pick<
            Database["public"]["Tables"]["patients"]["Row"],
            | "mrn"
            | "first_name"
            | "last_name"
            | "dob"
            | "address"
            | "status"
            | "admission_time"
            | "discharge_time"
            | "room"
          >
        >,
        error: null,
      },
    );
    const mapped: EncounterRow[] = (data ?? []).map((p) => ({
      mrn: p.mrn,
      name: `${p.first_name ?? ""} ${p.last_name ?? ""}`.trim(),
      dob: p.dob ?? null,
      address: p.address ?? null,
      status: (p.status ?? "").toLowerCase() === "discharged" ? "finished" : "in-progress",
      start: p.admission_time ?? null,
      end: p.discharge_time ?? null,
      room: p.room ?? null,
    }));
    setRows(mapped);
    setLoading(false);
    initialLoadRef.current = false;
  };

  useEffect(() => {
    load();
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleLoad = () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        void load();
      }, 300);
    };
    const ch = supabase
      .channel(`reception-roster-${facility}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "patients", filter: `facility_name=eq.${facility}` },
        scheduleLoad,
      )
      .subscribe();
    return () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      supabase.removeChannel(ch);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [facility]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(
      (r) =>
        r.mrn.toLowerCase().includes(q) ||
        r.name.toLowerCase().includes(q) ||
        (r.room ?? "").toLowerCase().includes(q) ||
        (r.address ?? "").toLowerCase().includes(q) ||
        (r.dob ?? "").toLowerCase().includes(q),
    );
  }, [rows, query]);

  return (
    <section className="rounded-xl border border-border bg-card overflow-hidden">
      <div className="flex items-center justify-between px-5 h-12 border-b border-border bg-secondary/40">
        <div className="flex items-center gap-2">
          <ClipboardList className="h-4 w-4 text-[var(--teal)]" />
          <h2 className="text-sm font-semibold">Patient Census</h2>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="h-3.5 w-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search MRN, name, room, address…"
              className="h-8 w-72 rounded-md border border-slate-200 bg-white pl-8 pr-3 text-xs outline-none focus:ring-2 focus:ring-[var(--teal)]/40"
            />
          </div>
          <button
            onClick={load}
            className="ml-2 inline-grid place-items-center h-8 w-8 rounded-md border border-slate-200 bg-white hover:bg-slate-50 text-slate-600"
            title="Refresh"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
      <div className="scroll-feed">
        <table className="w-full text-[12.5px]">
          <thead className="sticky top-0 z-10">
            <tr className="text-left text-[10px] uppercase tracking-[0.14em] text-slate-600 bg-slate-100 border-b border-slate-300">
              <th className="px-3 py-2 font-bold">MRN</th>
              <th className="px-3 py-2 font-bold">Patient</th>
              <th className="px-3 py-2 font-bold">Room</th>
              <th className="px-3 py-2 font-bold">Date of Birth</th>
              <th className="px-3 py-2 font-bold">Address</th>
              <th className="px-3 py-2 font-bold">Admitted</th>
              <th className="px-3 py-2 font-bold">Discharged</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={7} className="px-5 py-4">
                  <TableSkeleton rows={5} columns={7} />
                </td>
              </tr>
            )}
            {!loading && filtered.length === 0 && (
              <tr>
                <td colSpan={7} className="px-5 py-10">
                  <EmptyState
                    description={
                      rows.length === 0
                        ? "No patients on the census. New admissions appear here automatically."
                        : "No matches for that search."
                    }
                  />
                </td>
              </tr>
            )}
            {!loading &&
              filtered.map((r, i) => (
                <tr
                  key={r.mrn + r.status}
                  className={`border-b border-slate-200 hover:bg-[var(--teal-soft)]/40 transition ${i % 2 === 1 ? "bg-slate-50/60" : "bg-white"}`}
                >
                  <td className="px-3 py-2 font-mono text-slate-700">{r.mrn}</td>
                  <td className="px-3 py-2 font-semibold text-slate-900">{r.name || "—"}</td>
                  <td className="px-3 py-2 font-mono text-slate-700">{r.room ?? "—"}</td>
                  <td className="px-3 py-2 font-mono text-[11.5px] text-slate-700 whitespace-nowrap">
                    {r.dob ?? "—"}
                  </td>
                  <td className="px-3 py-2 text-slate-700">{r.address ?? "—"}</td>
                  <td className="px-3 py-2 font-mono text-[11.5px] text-slate-500 whitespace-nowrap">
                    {fmtTs(r.start)}
                  </td>
                  <td className="px-3 py-2 font-mono text-[11.5px] text-slate-500 whitespace-nowrap">
                    {fmtTs(r.end)}
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function fmtTs(ts: string | null | undefined): string {
  if (!ts) return "—";
  const d = new Date(ts);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/* ----------------------------------------------------------------- */
/* Scheduling — FHIR Appointment R4 compatible                        */
/* ----------------------------------------------------------------- */

interface AppointmentRow {
  id: string;
  facility_name: string;
  patient_mrn: string | null;
  patient_name: string;
  practitioner_name: string | null;
  service_type: string | null;
  description: string | null;
  start_time: string;
  end_time: string;
  status: string;
  comment: string | null;
  fhir_id: string | null;
  origin: string | null;
  accepted_by: string | null;
}

const APPT_STATUSES = [
  "proposed",
  "waitlist",
  "pending",
  "booked",
  "arrived",
  "checked-in",
  "fulfilled",
  "cancelled",
  "noshow",
] as const;

// Statuses that no longer belong on the "Upcoming" list.
const CLOSED_APPT_STATUSES = ["fulfilled", "cancelled", "noshow"];

function SchedulingTab({ facility }: { facility: string }) {
  const [upcomingRows, setUpcomingRows] = useState<AppointmentRow[]>([]);
  const [historyRows, setHistoryRows] = useState<AppointmentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const initialLoadRef = useRef(true);

  const load = async () => {
    if (initialLoadRef.current) setLoading(true);
    // Two independent queries instead of one ascending-sorted, limit-100
    // query: with a single query, old fulfilled/cancelled rows (which never
    // stop being "in the past") crowd out real upcoming appointments once a
    // facility accumulates more than ~100 total rows. Upcoming looks back
    // 6h (so a visit that just started/ran slightly over doesn't vanish
    // mid-visit) and excludes closed statuses; History is the closed
    // statuses, most-recent first.
    const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
    type FhirAppointmentRow = Database["public"]["Tables"]["fhir_appointments"]["Row"];
    const emptyFallback = { data: [] as FhirAppointmentRow[], error: null };
    const [upcomingRes, historyRes] = await Promise.all([
      fetchWithTimeout(async () => {
        const res = await supabase
          .from("fhir_appointments")
          .select("*")
          .eq("facility_name", facility)
          .not("status", "in", `(${CLOSED_APPT_STATUSES.join(",")})`)
          .gte("start_time", sixHoursAgo)
          .order("start_time", { ascending: true })
          .limit(200);
        return { data: res.data, error: res.error };
      }, emptyFallback),
      fetchWithTimeout(async () => {
        const res = await supabase
          .from("fhir_appointments")
          .select("*")
          .eq("facility_name", facility)
          .in("status", CLOSED_APPT_STATUSES)
          .order("start_time", { ascending: false })
          .limit(50);
        return { data: res.data, error: res.error };
      }, emptyFallback),
    ]);
    if (upcomingRes.error)
      toast.error("Could not load upcoming appointments", {
        description: upcomingRes.error.message,
      });
    if (historyRes.error)
      toast.error("Could not load appointment history", { description: historyRes.error.message });
    setUpcomingRows((upcomingRes.data ?? []) as AppointmentRow[]);
    setHistoryRows((historyRes.data ?? []) as AppointmentRow[]);
    setLoading(false);
    initialLoadRef.current = false;
  };

  useEffect(() => {
    load();
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleLoad = () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        void load();
      }, 300);
    };
    const ch = supabase
      .channel(`reception-appts-${facility}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "fhir_appointments",
          filter: `facility_name=eq.${facility}`,
        },
        scheduleLoad,
      )
      .subscribe();
    return () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      supabase.removeChannel(ch);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [facility]);

  // FHIR write-back for a local status/time change is no longer done here
  // directly (that was the source of the duplicate-FHIR-resource bug: this
  // PUT'd `Appointment/{local-uuid}` while the outbound poller separately
  // PUT'd `Appointment/appt-{local-uuid}` for the same row). The
  // `needs_fhir_push` DB trigger + `fhir-outbound-poll` now own all
  // outbound Appointment writes, keyed uniformly off `fhir_id`.
  const updateStatus = async (id: string, status: string) => {
    const { error } = await supabase.from("fhir_appointments").update({ status }).eq("id", id);
    if (error) toast.error("Update failed", { description: error.message });
    else toast.success(`Appointment marked ${status}`);
  };

  const reschedule = async (id: string, start: string, end: string) => {
    const startIso = new Date(start).toISOString();
    const endIso = new Date(end).toISOString();
    const { error } = await supabase
      .from("fhir_appointments")
      .update({ start_time: startIso, end_time: endIso, status: "booked" })
      .eq("id", id);
    if (error) {
      toast.error("Reschedule failed", { description: error.message });
      return;
    }
    toast.success("Appointment rescheduled");
  };

  return (
    <div className="space-y-4">
      <section className="rounded-xl border border-border bg-card overflow-hidden">
        <div className="flex items-center justify-between px-5 h-12 border-b border-border bg-secondary/40">
          <div className="flex items-center gap-2">
            <CalendarClock className="h-4 w-4 text-[var(--teal)]" />
            <h2 className="text-sm font-semibold">Upcoming Appointments</h2>
          </div>
          <button
            onClick={() => setOpen(true)}
            className="inline-flex items-center gap-1.5 rounded-md bg-[var(--teal)] hover:bg-[var(--teal)]/90 text-white px-3 h-8 text-xs font-semibold"
          >
            <Plus className="h-3.5 w-3.5" /> Book Appointment
          </button>
        </div>
        <AppointmentTable
          rows={upcomingRows}
          loading={loading}
          onUpdateStatus={updateStatus}
          onReschedule={reschedule}
          showActions
        />
      </section>

      <section className="rounded-xl border border-border bg-card overflow-hidden">
        <div className="flex items-center px-5 h-12 border-b border-border bg-secondary/40">
          <CheckCircle2 className="h-4 w-4 text-slate-500 mr-2" />
          <h2 className="text-sm font-semibold">Completed / Cancelled</h2>
        </div>
        <AppointmentTable
          rows={historyRows}
          loading={loading}
          onUpdateStatus={updateStatus}
          onReschedule={reschedule}
        />
      </section>

      {open && (
        <BookAppointmentModal
          facility={facility}
          onClose={() => setOpen(false)}
          onCreated={() => {
            setOpen(false);
            load();
          }}
        />
      )}
    </div>
  );
}

// Small provenance chip: "Auto-accepted" (accepted_by set, e.g. by the
// reception auto-accept feature) takes precedence over the origin-based
// label. Falls back to "Reception" for reception-booked / legacy rows.
function originChip(r: AppointmentRow): { label: string; cls: string } | null {
  if (r.accepted_by) {
    return { label: "Auto-accepted", cls: "border-violet-200 bg-violet-50 text-violet-700" };
  }
  switch (r.origin) {
    case "recall":
      return { label: "Recall", cls: "border-sky-200 bg-sky-50 text-sky-700" };
    case "myspehr":
      return { label: "Portal", cls: "border-indigo-200 bg-indigo-50 text-indigo-700" };
    case "reception":
      return { label: "Reception", cls: "border-slate-200 bg-slate-50 text-slate-600" };
    default:
      return null;
  }
}

function AppointmentTable({
  rows,
  loading,
  onUpdateStatus,
  onReschedule,
  showActions,
}: {
  rows: AppointmentRow[];
  loading: boolean;
  onUpdateStatus: (id: string, status: string) => void;
  onReschedule: (id: string, start: string, end: string) => void | Promise<void>;
  showActions?: boolean;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [editStart, setEditStart] = useState("");
  const [editEnd, setEditEnd] = useState("");
  const toLocal = (iso: string) => {
    const d = new Date(iso);
    d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
    return d.toISOString().slice(0, 16);
  };
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[12.5px]">
        <thead>
          <tr className="text-left text-[10px] uppercase tracking-[0.14em] text-slate-600 bg-slate-100 border-b border-slate-300">
            <th className="px-3 py-2 font-bold">Start</th>
            <th className="px-3 py-2 font-bold">End</th>
            <th className="px-3 py-2 font-bold">Patient</th>
            <th className="px-3 py-2 font-bold">Practitioner</th>
            <th className="px-3 py-2 font-bold">Service / Reason</th>
            <th className="px-3 py-2 font-bold">Status</th>
            {showActions && <th className="px-3 py-2 font-bold text-right pr-4">Action</th>}
          </tr>
        </thead>
        <tbody>
          {loading && (
            <tr>
              <td colSpan={showActions ? 7 : 6} className="px-5 py-4">
                <TableSkeleton rows={4} columns={showActions ? 7 : 6} />
              </td>
            </tr>
          )}
          {!loading && rows.length === 0 && (
            <tr>
              <td colSpan={showActions ? 7 : 6} className="px-5 py-10">
                <EmptyState description="No appointments scheduled in this list." />
              </td>
            </tr>
          )}
          {!loading &&
            rows.map((r, i) => (
              <Fragment key={r.id}>
                <tr
                  className={`border-b border-slate-200 ${
                    r.status === "proposed" || r.status === "pending"
                      ? "bg-amber-50/70 ring-1 ring-amber-200"
                      : i % 2 === 1
                        ? "bg-slate-50/60"
                        : "bg-white"
                  }`}
                >
                  <td className="px-3 py-2 font-mono text-[11.5px] text-slate-700 whitespace-nowrap">
                    {fmtTs(r.start_time)}
                  </td>
                  <td className="px-3 py-2 font-mono text-[11.5px] text-slate-500 whitespace-nowrap">
                    {fmtTs(r.end_time)}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-1.5">
                      <span className="font-semibold text-slate-900">{r.patient_name}</span>
                      {(() => {
                        const chip = originChip(r);
                        return chip ? (
                          <span
                            className={`inline-flex items-center rounded-full border px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider ${chip.cls}`}
                          >
                            {chip.label}
                          </span>
                        ) : null;
                      })()}
                    </div>
                    {r.patient_mrn && (
                      <div className="font-mono text-[11px] text-slate-500">{r.patient_mrn}</div>
                    )}
                  </td>
                  <td className="px-3 py-2 text-slate-700">{r.practitioner_name ?? "—"}</td>
                  <td className="px-3 py-2 text-slate-700">
                    <div className="font-medium">{r.service_type ?? "—"}</div>
                    {r.description && (
                      <div className="text-[11px] text-slate-500">{r.description}</div>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <StatusBadge
                      status={
                        r.status === "proposed" || r.status === "pending"
                          ? "warning"
                          : r.status === "booked"
                            ? "success"
                            : r.status === "cancelled" || r.status === "noshow"
                              ? "critical"
                              : "neutral"
                      }
                      label={r.status}
                    />
                  </td>
                  {showActions && (
                    <td className="px-3 py-2 text-right pr-4">
                      <div className="inline-flex items-center gap-1.5">
                        {(r.status === "proposed" || r.status === "pending") && (
                          <>
                            <button
                              onClick={() => onUpdateStatus(r.id, "booked")}
                              className="rounded-md bg-emerald-600 hover:bg-emerald-700 text-white px-2 h-7 text-[11px] font-semibold"
                              title="Confirm patient-requested appointment"
                            >
                              Confirm
                            </button>
                            <button
                              onClick={() => onUpdateStatus(r.id, "cancelled")}
                              className="rounded-md border border-rose-300 text-rose-700 bg-white hover:bg-rose-50 px-2 h-7 text-[11px] font-semibold"
                            >
                              Cancel
                            </button>
                          </>
                        )}
                        <button
                          onClick={() => {
                            setEditing(editing === r.id ? null : r.id);
                            setEditStart(toLocal(r.start_time));
                            setEditEnd(toLocal(r.end_time));
                          }}
                          className="rounded-md border border-slate-300 bg-white hover:bg-slate-50 px-2 h-7 text-[11px] font-semibold text-slate-700"
                        >
                          Reschedule
                        </button>
                        <select
                          value={r.status}
                          onChange={(e) => onUpdateStatus(r.id, e.target.value)}
                          className="h-7 rounded-md border border-slate-300 bg-white text-[11px] px-2"
                        >
                          {APPT_STATUSES.map((s) => (
                            <option key={s} value={s}>
                              {s}
                            </option>
                          ))}
                        </select>
                      </div>
                    </td>
                  )}
                </tr>
                {editing === r.id && (
                  <tr className="bg-slate-50 border-b border-slate-200">
                    <td colSpan={showActions ? 7 : 6} className="px-4 py-3">
                      <div className="flex flex-wrap items-end gap-3">
                        <label className="flex flex-col gap-1 text-[10px] uppercase tracking-wider text-slate-600 font-semibold">
                          New start
                          <input
                            type="datetime-local"
                            value={editStart}
                            onChange={(e) => setEditStart(e.target.value)}
                            className="h-8 rounded-md border border-slate-300 bg-white px-2 text-xs"
                          />
                        </label>
                        <label className="flex flex-col gap-1 text-[10px] uppercase tracking-wider text-slate-600 font-semibold">
                          New end
                          <input
                            type="datetime-local"
                            value={editEnd}
                            onChange={(e) => setEditEnd(e.target.value)}
                            className="h-8 rounded-md border border-slate-300 bg-white px-2 text-xs"
                          />
                        </label>
                        <button
                          onClick={async () => {
                            if (!editStart || !editEnd) return;
                            await onReschedule(r.id, editStart, editEnd);
                            setEditing(null);
                          }}
                          className="rounded-md bg-[var(--teal)] hover:bg-[var(--teal)]/90 text-white px-3 h-8 text-xs font-semibold"
                        >
                          Save & Confirm
                        </button>
                        <button
                          onClick={() => setEditing(null)}
                          className="rounded-md border border-slate-300 bg-white hover:bg-slate-50 px-3 h-8 text-xs font-semibold text-slate-700"
                        >
                          Close
                        </button>
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
        </tbody>
      </table>
    </div>
  );
}

function BookAppointmentModal({
  facility,
  onClose,
  onCreated,
}: {
  facility: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const nowLocal = (() => {
    const d = new Date();
    d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
    return d.toISOString().slice(0, 16);
  })();
  const [form, setForm] = useState({
    patient_name: "",
    patient_mrn: "",
    patient_dob: "",
    practitioner_name: "",
    service_type: "Outpatient Visit",
    description: "",
    start_time: nowLocal,
    end_time: nowLocal,
    status: "booked",
    comment: "",
  });
  const [submitting, setSubmitting] = useState(false);
  const [looking, setLooking] = useState(false);

  const PRACTITIONERS = [
    "Dr. Robert Patel, MD",
    "Dr. Priya Shah, DO",
    "Dr. Alan Reyes, MD",
    "Dr. Marcus Lee, MD",
    "Dr. Elena Park, MD",
  ];
  const SERVICE_TYPES = [
    "Outpatient Visit",
    "Follow-up Consultation",
    "Annual Physical",
    "Specialist Consultation",
    "Lab Review",
    "Imaging Review",
  ];
  const REASONS = [
    "Routine follow-up after recent admission",
    "Medication reconciliation and review",
    "Post-discharge wellness check",
    "Chronic condition management",
    "Lab results review",
  ];

  const autoFillFromExistingPatient = async () => {
    setLooking(true);
    const { data, error } = await supabase
      .from("patients")
      .select("mrn, first_name, last_name, dob")
      .eq("facility_name", facility)
      .not("mrn", "is", null)
      .order("admission_time", { ascending: false, nullsFirst: false })
      .limit(50);
    setLooking(false);
    if (error) {
      toast.error("Auto-fill failed", { description: error.message });
      return;
    }
    const candidates = (data ?? []).filter((p) => p.mrn);
    if (candidates.length === 0) {
      toast.error(`No existing patients found at ${facility}`);
      return;
    }
    const p = candidates[Math.floor(Math.random() * candidates.length)];
    const start = new Date(Date.now() + (1 + Math.floor(Math.random() * 14)) * 24 * 60 * 60 * 1000);
    start.setHours(
      9 + Math.floor(Math.random() * 8),
      [0, 15, 30, 45][Math.floor(Math.random() * 4)],
      0,
      0,
    );
    const end = new Date(start.getTime() + 30 * 60 * 1000);
    const toLocal = (d: Date) => {
      const x = new Date(d);
      x.setMinutes(x.getMinutes() - x.getTimezoneOffset());
      return x.toISOString().slice(0, 16);
    };
    setForm({
      patient_name: `${p.first_name ?? ""} ${p.last_name ?? ""}`.trim(),
      patient_mrn: p.mrn,
      patient_dob: (p.dob as string) ?? "",
      practitioner_name: PRACTITIONERS[Math.floor(Math.random() * PRACTITIONERS.length)],
      service_type: SERVICE_TYPES[Math.floor(Math.random() * SERVICE_TYPES.length)],
      description: REASONS[Math.floor(Math.random() * REASONS.length)],
      start_time: toLocal(start),
      end_time: toLocal(end),
      status: "booked",
      comment: "",
    });
    toast.success(`Auto-filled with ${p.first_name ?? ""} ${p.last_name ?? ""} (${p.mrn})`);
  };

  const lookupByMrn = async (mrnRaw?: string): Promise<boolean> => {
    const mrn = (mrnRaw ?? form.patient_mrn).trim();
    if (!mrn) {
      toast.error("Enter an MRN to auto-fill");
      return false;
    }
    setLooking(true);
    const { data, error } = await supabase
      .from("patients")
      .select("first_name, last_name, dob")
      .eq("mrn", mrn)
      .maybeSingle();
    setLooking(false);
    if (error) {
      toast.error("Lookup failed", { description: error.message });
      return false;
    }
    if (!data) {
      toast.error(`No patient found for ${mrn}`);
      return false;
    }
    setForm((f) => ({
      ...f,
      patient_mrn: mrn,
      patient_name: `${data.first_name ?? ""} ${data.last_name ?? ""}`.trim(),
      patient_dob: (data.dob as string) ?? "",
    }));
    toast.success("Patient details filled");
    return true;
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.patient_name.trim()) {
      toast.error("Patient name is required");
      return;
    }
    if (!form.start_time || !form.end_time) {
      toast.error("Start and end times are required");
      return;
    }
    setSubmitting(true);
    const startIso = new Date(form.start_time).toISOString();
    const endIso = new Date(form.end_time).toISOString();
    const mrnTrim = form.patient_mrn.trim();
    // Insert only. The `fhir_appointments_mark_dirty` trigger assigns a
    // stable `fhir_id` (`appt-<uuid>`) and flags `needs_fhir_push` — the
    // outbound poller owns the actual FHIR PUT from here, keyed off that
    // same `fhir_id`, so there is exactly one writer and one resource id
    // per appointment (previously this booking flow PUT directly AND the
    // poller separately PUT under a different id for the same row).
    const { data: inserted, error } = await supabase
      .from("fhir_appointments")
      .insert({
        facility_name: facility,
        patient_name: form.patient_name.trim(),
        patient_mrn: mrnTrim || null,
        practitioner_name: form.practitioner_name.trim() || null,
        service_type: form.service_type.trim() || null,
        description: form.description.trim() || null,
        start_time: startIso,
        end_time: endIso,
        status: form.status,
        comment: form.comment.trim() || null,
        origin: "reception",
      })
      .select()
      .maybeSingle();
    if (error) {
      setSubmitting(false);
      toast.error("Could not book appointment", { description: error.message });
      return;
    }

    const fhirId = inserted?.fhir_id ?? `appt-${inserted?.id}`;
    const appt = {
      resourceType: "Appointment",
      id: fhirId,
      status: form.status,
      serviceType: form.service_type.trim() ? [{ text: form.service_type.trim() }] : undefined,
      description: form.description.trim() || undefined,
      start: startIso,
      end: endIso,
      comment: form.comment.trim() || undefined,
      participant: [
        {
          actor: {
            reference: mrnTrim ? `Patient/${mrnTrim}` : undefined,
            identifier: mrnTrim ? { system: "http://spehr.local/mrn", value: mrnTrim } : undefined,
            display: form.patient_name.trim(),
          },
          required: "required",
          status: "accepted",
        },
        ...(form.practitioner_name.trim()
          ? [
              {
                actor: { display: form.practitioner_name.trim() },
                required: "required",
                status: "accepted",
              },
            ]
          : []),
      ],
    };

    // Persist a local FHIR resource mirror (keyed off the SAME fhir_id the
    // outbound poller will PUT under) so the patient portal can query
    // Appointment?actor=Patient/[MRN] without round-tripping to the
    // external server while the poll cycle is in flight.
    try {
      await supabase.rpc("persist_fhir_resource", {
        _resource_type: "Appointment",
        _resource_id: fhirId,
        _mrn: mrnTrim || "",
        _payload: appt,
        _source: "reception-booking",
        _origin: "human",
      });
    } catch {
      /* non-fatal */
    }

    setSubmitting(false);
    toast.success(`Appointment booked for ${form.patient_name.trim()}`);
    onCreated();
  };

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-[var(--navy)]/70 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <form
        onSubmit={submit}
        className="w-full max-w-xl rounded-xl bg-card border border-border shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 h-12 bg-[var(--navy)] text-white">
          <div className="flex items-center gap-2">
            <CalendarClock className="h-4 w-4 text-[var(--teal)]" />
            <h2 className="text-sm font-semibold">Book Appointment</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="grid place-items-center h-7 w-7 rounded-md hover:bg-white/10"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="p-5 grid grid-cols-12 gap-3 text-sm">
          <FormField label="Patient Name *" className="col-span-7">
            <input
              value={form.patient_name}
              onChange={(e) => setForm({ ...form, patient_name: e.target.value })}
              className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-[var(--teal)]/40"
              placeholder="John Doe"
            />
          </FormField>
          <FormField label="Patient MRN" className="col-span-5">
            <input
              value={form.patient_mrn}
              onChange={(e) => setForm({ ...form, patient_mrn: e.target.value })}
              onBlur={(e) => {
                if (e.target.value.trim() && !form.patient_name.trim()) {
                  void lookupByMrn(e.target.value);
                }
              }}
              className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-[var(--teal)]/40"
              placeholder="MRN-482910"
            />
          </FormField>
          <FormField label="Date of Birth" className="col-span-5">
            <input
              type="date"
              value={form.patient_dob}
              onChange={(e) => setForm({ ...form, patient_dob: e.target.value })}
              className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-[var(--teal)]/40"
            />
          </FormField>
          <FormField label="Practitioner / CareTeam" className="col-span-7">
            <input
              value={form.practitioner_name}
              onChange={(e) => setForm({ ...form, practitioner_name: e.target.value })}
              className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-[var(--teal)]/40"
              placeholder="Dr. Robert Patel"
            />
          </FormField>
          <FormField label="Service Type" className="col-span-5">
            <input
              value={form.service_type}
              onChange={(e) => setForm({ ...form, service_type: e.target.value })}
              className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-[var(--teal)]/40"
              placeholder="Outpatient Visit"
            />
          </FormField>
          <FormField label="Start" className="col-span-6">
            <input
              type="datetime-local"
              value={form.start_time}
              onChange={(e) => setForm({ ...form, start_time: e.target.value })}
              className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-[var(--teal)]/40"
            />
          </FormField>
          <FormField label="End" className="col-span-6">
            <input
              type="datetime-local"
              value={form.end_time}
              onChange={(e) => setForm({ ...form, end_time: e.target.value })}
              className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-[var(--teal)]/40"
            />
          </FormField>
          <FormField label="Status" className="col-span-6">
            <select
              value={form.status}
              onChange={(e) => setForm({ ...form, status: e.target.value })}
              className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm outline-none focus:ring-2 focus:ring-[var(--teal)]/40"
            >
              {APPT_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </FormField>
          <FormField label="Description / Reason" className="col-span-12">
            <input
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-[var(--teal)]/40"
              placeholder="Annual physical, follow-up, etc."
            />
          </FormField>
          <FormField label="Comment" className="col-span-12">
            <textarea
              value={form.comment}
              onChange={(e) => setForm({ ...form, comment: e.target.value })}
              rows={2}
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[var(--teal)]/40"
            />
          </FormField>
        </div>
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-border bg-secondary/30">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-border bg-background px-3 h-9 text-xs font-medium hover:bg-secondary"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void autoFillFromExistingPatient()}
            disabled={looking}
            className="inline-flex items-center gap-1.5 rounded-md border border-[var(--teal)]/40 bg-[var(--teal-soft)] text-[var(--teal)] hover:bg-[var(--teal)]/10 px-3 h-9 text-xs font-semibold disabled:opacity-60"
            title="Pick a random existing patient at this facility and fill realistic details"
          >
            {looking ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Wand2 className="h-3.5 w-3.5" />
            )}
            Auto-fill
          </button>
          <button
            type="submit"
            disabled={submitting}
            className="inline-flex items-center gap-1.5 rounded-md bg-[var(--teal)] hover:bg-[var(--teal)]/90 text-white px-4 h-9 text-xs font-semibold shadow-sm disabled:opacity-60"
          >
            {submitting ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Plus className="h-3.5 w-3.5" />
            )}
            Book Appointment
          </button>
        </div>
      </form>
    </div>
  );
}

function FormField({
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

/* ----------------------------------------------------------------- */
/* Bed Management — shared with the Nurse Dashboard                   */
/* ----------------------------------------------------------------- */
