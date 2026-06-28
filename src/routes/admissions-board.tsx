import { createFileRoute } from "@tanstack/react-router";
import { Fragment, useEffect, useMemo, useState } from "react";
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
} from "lucide-react";
import { BoardHeader } from "@/components/BoardShell";
import { supabase } from "@/integrations/supabase/client";
import { useFacility, useActiveStaff } from "@/lib/facility-context";
import { admitPatient, type AdmitInput } from "@/lib/admit-patient";
import { AdmitPatientModal } from "@/components/admissions/AdmitPatientModal";
import { BedManagementBoard } from "@/components/admissions/BedManagementBoard";
import spehrLogo from "@/assets/spehr-logo.png.asset.json";
import { fetchWithTimeout } from "@/lib/async-timeout";

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
    let cancelled = false;
    const load = async () => {
      const { data } = await fetchWithTimeout(
        () =>
          supabase
            .from("bed_management")
            .select("status")
            .eq("facility_name", facility),
        { data: [], error: null } as any,
      );
      if (cancelled || !data) return;
      const available = data.filter(
        (b: any) => (b.status ?? "").toLowerCase() === "available",
      ).length;
      setBedCounts({ available, total: data.length });
    };
    load();
    const ch = supabase
      .channel(`reception-bed-count-${facility}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "bed_management", filter: `facility_name=eq.${facility}` },
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
      description: `${res.patient.first_name} ${res.patient.last_name} · ${res.patient.mrn}`,
    });
    setTab("roster");
    return true;
  };

  const tabs: { key: TabKey; label: string; icon: any }[] = [
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
        <div className="max-w-[1400px] mx-auto px-5 h-12 flex items-center gap-1">
          {tabs.map((t) => {
            const Icon = t.icon;
            const active = tab === t.key;
            return (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                className={`inline-flex items-center gap-1.5 h-9 px-3 rounded-md text-xs font-semibold transition ${
                  active
                    ? "bg-[var(--teal)] text-white shadow"
                    : "text-white/70 hover:bg-white/10 hover:text-white"
                }`}
              >
                <Icon className="h-3.5 w-3.5" /> {t.label}
              </button>
            );
          })}
          <div className="ml-auto text-[11px] text-white/60">
            {bedCounts.available} / {bedCounts.total} beds open
          </div>
        </div>
      </div>

      <div className="max-w-[1400px] mx-auto px-5 py-6 space-y-4">
        {tab === "home" && (
          <div className="min-h-[60vh] flex flex-col items-center justify-center gap-8 py-12">
            <div className="relative flex items-center justify-center">
              <div className="absolute inset-0 rounded-full bg-[radial-gradient(circle,rgba(20,80,80,0.15)_0%,transparent_70%)] blur-2xl scale-150" />
              <img
                src={spehrLogo.url}
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

  const load = async () => {
    // Source: `patients` (the local mirror of the FHIR Encounter resource).
    // status = 'Admitted' → FHIR Encounter.status = in-progress
    // status = 'Discharged' → FHIR Encounter.status = finished
    setLoading(true);
    const { data } = await fetchWithTimeout(
      () =>
        supabase
          .from("patients")
          .select("mrn, first_name, last_name, dob, address, status, admission_time, discharge_time, room")
          .eq("facility_name", facility)
          .order("admission_time", { ascending: false })
          .limit(50),
      { data: [], error: null } as any,
    );
    const mapped: EncounterRow[] = ((data ?? []) as any[]).map((p) => ({
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
  };

  useEffect(() => {
    load();
    const ch = supabase
      .channel(`reception-roster-${facility}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "patients", filter: `facility_name=eq.${facility}` },
        () => load(),
      )
      .subscribe();
    return () => {
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
      <div className="overflow-x-auto">
        <table className="w-full text-[12.5px]">
          <thead>
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
                <td colSpan={7} className="px-5 py-10 text-center text-sm text-muted-foreground">
                  <span className="inline-flex items-center gap-2">
                    <Loader2 className="h-4 w-4 animate-spin text-[var(--teal)]" />
                    Loading encounters…
                  </span>
                </td>
              </tr>
            )}
            {!loading && filtered.length === 0 && (
              <tr>
                <td colSpan={7} className="px-5 py-16 text-center text-sm text-muted-foreground">
                  {rows.length === 0 ? "No patients on the census." : "No matches for that search."}
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
                  <td className="px-3 py-2 font-mono text-[11.5px] text-slate-700 whitespace-nowrap">{r.dob ?? "—"}</td>
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
  return d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
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
}

const APPT_STATUSES = ["proposed", "pending", "booked", "arrived", "fulfilled", "cancelled", "noshow"] as const;

function SchedulingTab({ facility }: { facility: string }) {
  const [rows, setRows] = useState<AppointmentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);

  const load = async () => {
    setLoading(true);
    const { data, error } = await (supabase as any)
      .from("fhir_appointments")
      .select("*")
      .eq("facility_name", facility)
      .order("start_time", { ascending: true })
      .limit(100);
    if (error) toast.error("Could not load appointments", { description: error.message });
    setRows((data ?? []) as AppointmentRow[]);
    setLoading(false);
  };

  useEffect(() => {
    load();
    const ch = supabase
      .channel(`reception-appts-${facility}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "fhir_appointments", filter: `facility_name=eq.${facility}` },
        () => load(),
      )
      .subscribe();
    return () => {
      supabase.removeChannel(ch);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [facility]);

  const updateStatus = async (id: string, status: string) => {
    const row = rows.find((r) => r.id === id);
    const { error } = await (supabase as any)
      .from("fhir_appointments")
      .update({ status })
      .eq("id", id);
    if (error) toast.error("Update failed", { description: error.message });
    else toast.success(`Appointment marked ${status}`);
    // Push status change to external FHIR server (PUT)
    if (!error && row) {
      try {
        const appt = {
          resourceType: "Appointment",
          id: row.id,
          status,
          description: row.description ?? undefined,
          start: row.start_time,
          end: row.end_time,
          comment: row.comment ?? undefined,
          participant: [
            {
              actor: {
                reference: row.patient_mrn ? `Patient/${row.patient_mrn}` : undefined,
                display: row.patient_name,
              },
              required: "required",
              status: "accepted",
            },
          ],
        };
        await supabase.functions.invoke("fhir-proxy", {
          body: {
            bundle: {
              resourceType: "Bundle",
              type: "transaction",
              entry: [{ resource: appt, request: { method: "PUT", url: `Appointment/${row.id}` } }],
            },
          },
        });
      } catch {
        /* non-fatal */
      }
    }
  };

  const reschedule = async (id: string, start: string, end: string) => {
    const startIso = new Date(start).toISOString();
    const endIso = new Date(end).toISOString();
    const { error } = await (supabase as any)
      .from("fhir_appointments")
      .update({ start_time: startIso, end_time: endIso, status: "booked" })
      .eq("id", id);
    if (error) {
      toast.error("Reschedule failed", { description: error.message });
      return;
    }
    toast.success("Appointment rescheduled");
  };

  const upcoming = useMemo(() => rows.filter((r) => !["fulfilled", "cancelled", "noshow"].includes(r.status)), [rows]);
  const past = useMemo(() => rows.filter((r) => ["fulfilled", "cancelled", "noshow"].includes(r.status)), [rows]);

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
          rows={upcoming}
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
        <AppointmentTable rows={past} loading={loading} onUpdateStatus={updateStatus} onReschedule={reschedule} />
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
              <td colSpan={showActions ? 7 : 6} className="px-5 py-10 text-center text-sm text-muted-foreground">
                <span className="inline-flex items-center gap-2">
                  <Loader2 className="h-4 w-4 animate-spin text-[var(--teal)]" /> Loading…
                </span>
              </td>
            </tr>
          )}
          {!loading && rows.length === 0 && (
            <tr>
              <td colSpan={showActions ? 7 : 6} className="px-5 py-10 text-center text-sm text-muted-foreground">
                No appointments.
              </td>
            </tr>
          )}
          {!loading &&
            rows.map((r, i) => (
              <Fragment key={r.id}>
              <tr
                className={`border-b border-slate-200 ${
                  r.status === "proposed"
                    ? "bg-amber-50/70 ring-1 ring-amber-200"
                    : i % 2 === 1
                    ? "bg-slate-50/60"
                    : "bg-white"
                }`}
              >
                <td className="px-3 py-2 font-mono text-[11.5px] text-slate-700 whitespace-nowrap">{fmtTs(r.start_time)}</td>
                <td className="px-3 py-2 font-mono text-[11.5px] text-slate-500 whitespace-nowrap">{fmtTs(r.end_time)}</td>
                <td className="px-3 py-2">
                  <div className="font-semibold text-slate-900">{r.patient_name}</div>
                  {r.patient_mrn && <div className="font-mono text-[11px] text-slate-500">{r.patient_mrn}</div>}
                </td>
                <td className="px-3 py-2 text-slate-700">{r.practitioner_name ?? "—"}</td>
                <td className="px-3 py-2 text-slate-700">
                  <div className="font-medium">{r.service_type ?? "—"}</div>
                  {r.description && <div className="text-[11px] text-slate-500">{r.description}</div>}
                </td>
                <td className="px-3 py-2">
                  <span
                    className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ring-1 ${
                      r.status === "proposed"
                        ? "bg-amber-100 text-amber-800 ring-amber-300"
                        : r.status === "booked"
                        ? "bg-emerald-100 text-emerald-800 ring-emerald-300"
                        : r.status === "cancelled" || r.status === "noshow"
                        ? "bg-rose-100 text-rose-700 ring-rose-300"
                        : "bg-slate-100 text-slate-700 ring-slate-300"
                    }`}
                  >
                    {r.status === "proposed" && (
                      <span className="mr-1 h-1.5 w-1.5 rounded-full bg-amber-500 animate-pulse" />
                    )}
                    {r.status}
                  </span>
                </td>
                {showActions && (
                  <td className="px-3 py-2 text-right pr-4">
                    <div className="inline-flex items-center gap-1.5">
                      {r.status === "proposed" && (
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
    const candidates = (data ?? []).filter((p: any) => p.mrn);
    if (candidates.length === 0) {
      toast.error(`No existing patients found at ${facility}`);
      return;
    }
    const p: any = candidates[Math.floor(Math.random() * candidates.length)];
    const start = new Date(Date.now() + (1 + Math.floor(Math.random() * 14)) * 24 * 60 * 60 * 1000);
    start.setHours(9 + Math.floor(Math.random() * 8), [0, 15, 30, 45][Math.floor(Math.random() * 4)], 0, 0);
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
    const { data: inserted, error } = await (supabase as any).from("fhir_appointments").insert({
      facility_name: facility,
      patient_name: form.patient_name.trim(),
      patient_mrn: form.patient_mrn.trim() || null,
      practitioner_name: form.practitioner_name.trim() || null,
      service_type: form.service_type.trim() || null,
      description: form.description.trim() || null,
      start_time: startIso,
      end_time: endIso,
      status: form.status,
      comment: form.comment.trim() || null,
    }).select().maybeSingle();
    if (error) {
      setSubmitting(false);
      toast.error("Could not book appointment", { description: error.message });
      return;
    }

    // Build strict FHIR R4 Appointment and push to external FHIR server + local mirror
    const apptId = (inserted as any)?.id ?? crypto.randomUUID();
    const mrnTrim = form.patient_mrn.trim();
    const appt: any = {
      resourceType: "Appointment",
      id: apptId,
      status: form.status,
      serviceType: form.service_type.trim()
        ? [{ text: form.service_type.trim() }]
        : undefined,
      description: form.description.trim() || undefined,
      start: startIso,
      end: endIso,
      comment: form.comment.trim() || undefined,
      participant: [
        {
          actor: {
            reference: mrnTrim ? `Patient/${mrnTrim}` : undefined,
            identifier: mrnTrim
              ? { system: "http://spehr.local/mrn", value: mrnTrim }
              : undefined,
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
    try {
      const bundle = {
        resourceType: "Bundle",
        type: "transaction",
        entry: [
          {
            resource: appt,
            request: { method: "PUT", url: `Appointment/${apptId}` },
          },
        ],
      };
      const { error: fnError } = await supabase.functions.invoke("fhir-proxy", {
        body: { bundle },
      });
      if (fnError) {
        toast.warning("Saved locally, FHIR sync deferred", { description: fnError.message });
      }
    } catch (err) {
      toast.warning("Saved locally, FHIR sync deferred", {
        description: (err as Error).message,
      });
    }

    // Persist a local FHIR resource mirror so the patient portal can query
    // Appointment?actor=Patient/[MRN] without round-tripping to the external server.
    try {
      await (supabase as any).rpc("persist_fhir_resource", {
        _resource_type: "Appointment",
        _resource_id: apptId,
        _mrn: mrnTrim || null,
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
    <div className="fixed inset-0 z-50 grid place-items-center bg-[var(--navy)]/70 backdrop-blur-sm p-4" onClick={onClose}>
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
          <button type="button" onClick={onClose} className="grid place-items-center h-7 w-7 rounded-md hover:bg-white/10">
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
            {looking ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Wand2 className="h-3.5 w-3.5" />}
            Auto-fill
          </button>
          <button
            type="submit"
            disabled={submitting}
            className="inline-flex items-center gap-1.5 rounded-md bg-[var(--teal)] hover:bg-[var(--teal)]/90 text-white px-4 h-9 text-xs font-semibold shadow-sm disabled:opacity-60"
          >
            {submitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
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
      <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">{label}</span>
      {children}
    </label>
  );
}

/* ----------------------------------------------------------------- */
/* Bed Management — shared with the Nurse Dashboard                   */
/* ----------------------------------------------------------------- */

