import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import {
  HeartPulse,
  LogOut,
  Loader2,
  Search,
  Users,
  AlertTriangle,
  Pill,
  ChevronRight,
  Activity,
  UserPlus,
  X,
  Trash2,
} from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";
import {
  hrOutOfRange,
  bpOutOfRange,
  o2OutOfRange,
  type CodeStatus,
} from "@/lib/patients";

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
  task: string;
}

function normalizeCode(s: string): CodeStatus {
  const v = s.trim().toLowerCase();
  if (v === "dnr") return "DNR";
  if (v === "dni") return "DNI";
  if (v === "comfort") return "Comfort";
  return "Full Code";
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
  };
}

function genMRN() {
  return `MRN-${Math.floor(100000 + Math.random() * 900000)}`;
}

function Dashboard() {
  const navigate = useNavigate();
  const [email, setEmail] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [now, setNow] = useState(new Date());
  const [query, setQuery] = useState("");
  const [patients, setPatients] = useState<PatientRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [liveConnected, setLiveConnected] = useState(false);
  const [simulate, setSimulate] = useState(false);
  const [admitOpen, setAdmitOpen] = useState(false);
  const [discharging, setDischarging] = useState<PatientRow | null>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      if (!data.session) {
        navigate({ to: "/" }).catch(() => {});
        return;
      }
      setEmail(data.session.user.email ?? null);
      setReady(true);
    });
  }, [navigate]);

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
          "mrn, first_name, last_name, age, gender, code_status, chief_complaint, room, hr, bp_systolic, bp_diastolic, spo2",
        )
        .order("room", { ascending: true });
      if (cancelled) return;
      if (error) {
        setFetchError(error.message);
        setLoading(false);
        return;
      }
      setPatients(
        (data ?? []).map(toRow),
      );
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [ready]);

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
    if (!ready || !simulate) return;
    const jitter = (range: number) => Math.floor(Math.random() * (2 * range + 1)) - range;
    const tick = async () => {
      const { data, error } = await supabase
        .from("patients")
        .select("mrn, hr, bp_systolic, bp_diastolic, spo2");
      if (error || !data) return;
      await Promise.all(
        data.map((p: any) => {
          const next = {
            hr: Math.max(20, p.hr + jitter(2)),
            bp_systolic: Math.max(50, p.bp_systolic + jitter(3)),
            bp_diastolic: Math.max(30, p.bp_diastolic + jitter(2)),
            spo2: Math.min(100, Math.max(70, p.spo2 + jitter(1))),
          };
          return supabase.from("patients").update(next).eq("mrn", p.mrn);
        }),
      );
    };
    tick();
    const id = setInterval(tick, 5000);
    return () => clearInterval(id);
  }, [ready, simulate]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return patients;
    return patients.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.mrn.toLowerCase().includes(q) ||
        (p.room ?? "").toLowerCase().includes(q) ||
        p.diagnosis.toLowerCase().includes(q),
    );
  }, [query, patients]);

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
      dob: new Date(new Date().getFullYear() - input.age, 0, 1).toISOString().slice(0, 10),
      room: input.room.trim() || null,
      code_status: input.code_status,
      chief_complaint: input.diagnosis.trim(),
      hr: 76,
      bp_systolic: 120,
      bp_diastolic: 78,
      temp_f: 98.6,
      spo2: 98,
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
      <header className="sticky top-0 z-20 border-b border-border bg-[var(--navy)] text-white">
        <div className="max-w-[1400px] mx-auto px-5 h-14 flex items-center gap-4">
          <div className="flex items-center gap-2.5">
            <div className="grid place-items-center h-8 w-8 rounded-md bg-[var(--teal)]">
              <HeartPulse className="h-4.5 w-4.5" strokeWidth={2.4} />
            </div>
            <div className="leading-tight">
              <div className="text-[10px] uppercase tracking-[0.22em] text-white/55">
                S.P.E.H.R.
              </div>
              <div className="text-sm font-semibold">Status Board</div>
            </div>
          </div>

          <div className="hidden md:flex items-center gap-2 ml-2 pl-4 border-l border-white/10 text-xs">
            <div className="h-2 w-2 rounded-full bg-emerald-400 shadow-[0_0_0_3px_rgba(52,211,153,0.18)]" />
            <span className="text-white/80 font-medium">RN — Memorial Hospital</span>
            <span className="text-white/50">· Unit 4B</span>
          </div>

          <div className="flex-1 max-w-md mx-auto">
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
            onClick={async () => {
              await supabase.auth.signOut();
              navigate({ to: "/" }).catch(() => {});
            }}
            className="inline-flex items-center gap-1.5 rounded-md bg-white/10 hover:bg-white/15 px-3 h-9 text-xs font-medium ring-1 ring-white/10 transition"
          >
            <LogOut className="h-3.5 w-3.5" /> Logout
          </button>
          <button
            onClick={() => setAdmitOpen(true)}
            className="inline-flex items-center gap-1.5 rounded-md bg-[var(--teal)] hover:bg-[var(--teal)]/90 px-3 h-9 text-xs font-semibold text-white shadow-sm transition"
          >
            <UserPlus className="h-3.5 w-3.5" /> Admit Patient
          </button>
        </div>
      </header>

      <div className="max-w-[1400px] mx-auto px-5 py-6 space-y-6">
        <section className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <StatCard
            icon={Users}
            label="Total Patients"
            value={`${patients.length}`}
            tone="navy"
          />
          <StatCard
            icon={AlertTriangle}
            label="Critical Alerts"
            value={`${patients.filter((p) => hrOutOfRange(p.hr) || bpOutOfRange(p.bp) || o2OutOfRange(p.o2)).length}`}
            tone="red"
            sub="Vitals out of range"
          />
          <StatCard
            icon={Pill}
            label="Meds Due · Next Hour"
            value="4"
            tone="teal"
            sub="2 IV · 2 PO"
          />
        </section>

        <section className="rounded-xl border border-border bg-card overflow-hidden shadow-[0_1px_0_rgba(15,23,42,0.04)]">
          <div className="flex items-center justify-between px-5 h-12 border-b border-border bg-secondary/40">
            <div className="flex items-center gap-2">
              <Activity className="h-4 w-4 text-[var(--teal)]" />
              <h2 className="text-sm font-semibold tracking-tight">
                Floor Overview — Unit 4B
              </h2>
              <span className="text-xs text-muted-foreground">
                · {rows.length} of {patients.length} patients
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
              <span className="mx-2 h-3 w-px bg-border" />
              <label className="inline-flex items-center gap-1.5 cursor-pointer select-none">
                <Switch checked={simulate} onCheckedChange={setSimulate} aria-label="Simulate vitals" />
                <span className={simulate ? "text-[var(--teal)] font-medium" : ""}>
                  Simulate Vitals
                </span>
              </label>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wider text-muted-foreground bg-secondary/30">
                  <Th>Room / Bed</Th>
                  <Th>Patient</Th>
                  <Th>Code</Th>
                  <Th>Diagnosis</Th>
                  <Th>Live Vitals</Th>
                  <Th>Next Task</Th>
                  <Th className="text-right pr-5">Action</Th>
                </tr>
              </thead>
              <tbody>
                {loading && (
                  <tr>
                    <td colSpan={7} className="px-5 py-10 text-center text-sm text-muted-foreground">
                      <span className="inline-flex items-center gap-2">
                        <Loader2 className="h-4 w-4 animate-spin text-[var(--teal)]" />
                        Loading floor census…
                      </span>
                    </td>
                  </tr>
                )}
                {!loading && fetchError && (
                  <tr>
                    <td colSpan={7} className="px-5 py-10 text-center text-sm">
                      <div className="inline-flex items-center gap-2 text-red-600">
                        <AlertTriangle className="h-4 w-4" />
                        Unable to load patients — {fetchError}
                      </div>
                    </td>
                  </tr>
                )}
                {!loading && !fetchError && rows.map((p) => {
                  const hrAlert = hrOutOfRange(p.hr);
                  const bpAlert = bpOutOfRange(p.bp);
                  const o2Alert = o2OutOfRange(p.o2);
                  const anyAlert = hrAlert || bpAlert || o2Alert;
                  return (
                    <tr
                      key={p.mrn}
                      className="border-t border-border group hover:bg-[var(--teal-soft)]/40 transition"
                    >
                      <td className="px-5 py-3.5 align-top">
                        <div className="font-semibold text-foreground tabular-nums">
                          {p.room ?? "—"}
                        </div>
                        {anyAlert && (
                          <div className="mt-1 inline-flex items-center gap-1 text-[10px] font-semibold text-red-600">
                            <span className="h-1.5 w-1.5 rounded-full bg-red-500 animate-pulse" />
                            ALERT
                          </div>
                        )}
                      </td>
                      <td className="px-5 py-3.5 align-top">
                        <div className="font-medium text-foreground">{p.name}</div>
                        <div className="text-xs text-muted-foreground mt-0.5">
                          {p.age}{p.sex} · {p.mrn}
                        </div>
                      </td>
                      <td className="px-5 py-3.5 align-top">
                        <span
                          className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ${codeBadge[p.code]}`}
                        >
                          {p.code}
                        </span>
                      </td>
                      <td className="px-5 py-3.5 align-top text-foreground/90 max-w-[220px]">
                        {p.diagnosis}
                      </td>
                      <td className="px-5 py-3.5 align-top">
                        <div className="text-sm font-medium tabular-nums text-foreground/90">
                          <span className={hrAlert ? "text-red-600 font-bold" : ""}>
                            {p.hr} bpm
                          </span>
                          <span className="text-muted-foreground"> | </span>
                          <span className={bpAlert ? "text-red-600 font-bold" : ""}>
                            {p.bp} mmHg
                          </span>
                          <span className="text-muted-foreground"> | </span>
                          <span className={o2Alert ? "text-red-600 font-bold" : ""}>
                            {p.o2}%
                          </span>
                        </div>
                      </td>
                      <td className="px-5 py-3.5 align-top text-foreground/90">
                        {p.task}
                      </td>
                      <td className="px-5 py-3.5 align-top text-right pr-5">
                        <div className="inline-flex items-center gap-1.5">
                          <Link
                            to="/patient/$mrn"
                            params={{ mrn: p.mrn }}
                            className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-2.5 h-8 text-xs font-medium text-foreground hover:bg-[var(--navy)] hover:text-white hover:border-[var(--navy)] transition"
                          >
                            Open Chart
                            <ChevronRight className="h-3.5 w-3.5" />
                          </Link>
                          <button
                            onClick={() => setDischarging(p)}
                            title="Discharge patient"
                            aria-label={`Discharge ${p.name}`}
                            className="inline-grid place-items-center h-8 w-8 rounded-md border border-border bg-background text-muted-foreground hover:bg-red-50 hover:text-red-600 hover:border-red-200 transition"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
                {!loading && !fetchError && rows.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-5 py-10 text-center text-sm text-muted-foreground">
                      {query ? `No charts match "${query}".` : "No patients on the floor."}
                    </td>
                  </tr>
                )}
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
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  sub?: string;
  tone: "navy" | "teal" | "red";
}) {
  const tones = {
    navy: "bg-[var(--navy)] text-white",
    teal: "bg-[var(--teal)] text-white",
    red: "bg-red-600 text-white",
  } as const;
  return (
    <div className="rounded-xl border border-border bg-card p-4 flex items-center gap-4">
      <div className={`h-11 w-11 rounded-lg grid place-items-center ${tones[tone]}`}>
        <Icon className="h-5 w-5" />
      </div>
      <div className="min-w-0">
        <div className="text-xs uppercase tracking-wider text-muted-foreground">
          {label}
        </div>
        <div className="flex items-baseline gap-2">
          <div className="text-2xl font-semibold tracking-tight tabular-nums">
            {value}
          </div>
          {sub && <div className="text-xs text-muted-foreground truncate">{sub}</div>}
        </div>
      </div>
    </div>
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
}

function AdmitModal({
  onClose,
  onSubmit,
}: {
  onClose: () => void;
  onSubmit: (input: AdmitInput) => Promise<boolean>;
}) {
  const [name, setName] = useState("");
  const [age, setAge] = useState("");
  const [gender, setGender] = useState<"M" | "F">("M");
  const [room, setRoom] = useState("");
  const [code, setCode] = useState<CodeStatus>("Full Code");
  const [dx, setDx] = useState("");
  const [mrn, setMrn] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const handle = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    const trimmedName = name.trim();
    const ageNum = Number(age);
    if (trimmedName.length < 2 || trimmedName.length > 100) {
      setErr("Name must be 2–100 characters.");
      return;
    }
    if (!Number.isFinite(ageNum) || ageNum < 0 || ageNum > 120) {
      setErr("Age must be between 0 and 120.");
      return;
    }
    if (dx.trim().length < 2 || dx.trim().length > 500) {
      setErr("Diagnosis must be 2–500 characters.");
      return;
    }
    if (room.length > 20) {
      setErr("Room must be at most 20 characters.");
      return;
    }
    if (mrn && !/^MRN-[A-Za-z0-9-]{3,20}$/.test(mrn.trim())) {
      setErr("MRN must look like 'MRN-XXXXXX'.");
      return;
    }
    setSubmitting(true);
    const ok = await onSubmit({
      name: trimmedName,
      age: Math.floor(ageNum),
      gender,
      room,
      code_status: code,
      diagnosis: dx,
      mrn: mrn.trim() || undefined,
    });
    setSubmitting(false);
    if (ok) onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-[var(--navy)]/70 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-xl bg-card border border-border shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 h-12 bg-[var(--navy)] text-white">
          <div className="flex items-center gap-2">
            <UserPlus className="h-4 w-4 text-[var(--teal)]" />
            <h2 className="text-sm font-semibold">Admit New Patient</h2>
          </div>
          <button
            onClick={onClose}
            className="grid place-items-center h-7 w-7 rounded-md hover:bg-white/10 transition"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <form onSubmit={handle} className="p-5 grid grid-cols-2 gap-4">
          <Field label="Patient Name" full>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={100}
              required
              autoFocus
              placeholder="John Doe"
              className="h-9 rounded-md border border-border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-[var(--teal)]/40 focus:border-[var(--teal)] transition"
            />
          </Field>
          <Field label="Age">
            <input
              value={age}
              onChange={(e) => setAge(e.target.value.replace(/[^\d]/g, ""))}
              maxLength={3}
              required
              placeholder="65"
              inputMode="numeric"
              className="h-9 rounded-md border border-border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-[var(--teal)]/40 focus:border-[var(--teal)] transition"
            />
          </Field>
          <Field label="Gender">
            <select
              value={gender}
              onChange={(e) => setGender(e.target.value as "M" | "F")}
              className="h-9 rounded-md border border-border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-[var(--teal)]/40 focus:border-[var(--teal)] transition"
            >
              <option value="M">M</option>
              <option value="F">F</option>
            </select>
          </Field>
          <Field label="Room / Bed">
            <input
              value={room}
              onChange={(e) => setRoom(e.target.value)}
              maxLength={20}
              placeholder="412-A"
              className="h-9 rounded-md border border-border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-[var(--teal)]/40 focus:border-[var(--teal)] transition"
            />
          </Field>
          <Field label="Code Status">
            <select
              value={code}
              onChange={(e) => setCode(e.target.value as CodeStatus)}
              className="h-9 rounded-md border border-border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-[var(--teal)]/40 focus:border-[var(--teal)] transition"
            >
              <option>Full Code</option>
              <option>DNR</option>
              <option>DNI</option>
              <option>Comfort</option>
            </select>
          </Field>
          <Field label="Diagnosis / Chief Complaint" full>
            <input
              value={dx}
              onChange={(e) => setDx(e.target.value)}
              maxLength={500}
              required
              placeholder="CHF exacerbation"
              className="h-9 rounded-md border border-border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-[var(--teal)]/40 focus:border-[var(--teal)] transition"
            />
          </Field>
          <Field label="MRN (optional — auto-generated if blank)" full>
            <input
              value={mrn}
              onChange={(e) => setMrn(e.target.value)}
              maxLength={24}
              placeholder="MRN-482910"
              className="h-9 rounded-md border border-border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-[var(--teal)]/40 focus:border-[var(--teal)] transition"
            />
          </Field>

          {err && (
            <div className="col-span-2 text-xs text-red-600 inline-flex items-center gap-1.5">
              <AlertTriangle className="h-3.5 w-3.5" />
              {err}
            </div>
          )}

          <div className="col-span-2 flex items-center justify-end gap-2 pt-2 border-t border-border">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-border bg-background px-3 h-9 text-xs font-medium hover:bg-secondary transition"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="inline-flex items-center gap-1.5 rounded-md bg-[var(--teal)] hover:bg-[var(--teal)]/90 text-white px-4 h-9 text-xs font-semibold shadow-sm transition disabled:opacity-60"
            >
              {submitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <UserPlus className="h-3.5 w-3.5" />}
              Admit Patient
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function Field({
  label,
  full,
  children,
}: {
  label: string;
  full?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className={`flex flex-col gap-1.5 ${full ? "col-span-2" : ""}`}>
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
