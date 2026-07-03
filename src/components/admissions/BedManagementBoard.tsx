import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Loader2, X } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { reconcileOrphanedBeds } from "@/lib/admit-patient";
import { fetchWithTimeout } from "@/lib/async-timeout";

interface BedRow {
  id: string;
  facility_name: string;
  room_number: string;
  bed_letter: string;
  status: string;
  current_patient_mrn: string | null;
  status_updated_at: string | null;
}

type PatientNameMap = Record<string, string>;

const CLEAN_PHASE_MS = 60_000;

function bedTone(status: string): { wrap: string; label: string; dot: string } {
  const s = status.toLowerCase();
  if (s.startsWith("available"))
    return { wrap: "bg-emerald-50 border-emerald-300", label: "text-emerald-800", dot: "bg-emerald-500" };
  if (s.startsWith("occupied"))
    return { wrap: "bg-sky-50 border-sky-300", label: "text-sky-800", dot: "bg-sky-500" };
  if (s.startsWith("cleaning") || s.includes("deep cleaning") || s.startsWith("discharged"))
    return { wrap: "bg-amber-50 border-amber-300", label: "text-amber-900", dot: "bg-amber-500 animate-pulse" };
  if (s.startsWith("disinfecting"))
    return { wrap: "bg-indigo-50 border-indigo-300", label: "text-indigo-800", dot: "bg-indigo-500 animate-pulse" };
  return { wrap: "bg-slate-50 border-slate-300", label: "text-slate-700", dot: "bg-slate-400" };
}

function CleaningMeter({ status, updatedAt }: { status: string; updatedAt: string | null }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, []);
  if (!updatedAt) return null;
  const elapsed = Math.max(0, now - new Date(updatedAt).getTime());
  const pct = Math.min(100, (elapsed / CLEAN_PHASE_MS) * 100);
  const remain = Math.max(0, Math.ceil((CLEAN_PHASE_MS - elapsed) / 1000));
  const s = status.toLowerCase();
  const isClean = s.startsWith("cleaning") || s.includes("deep cleaning") || s.startsWith("discharged");
  const isDis = s.startsWith("disinfecting");
  if (!isClean && !isDis) return null;
  return (
    <div className="mt-2">
      <div className="h-1.5 w-full bg-white/60 rounded overflow-hidden">
        <div className={`h-full transition-all ${isClean ? "bg-amber-500" : "bg-indigo-500"}`} style={{ width: `${pct}%` }} />
      </div>
      <div className="mt-1 text-[10px] font-mono tabular-nums text-slate-600">
        {isClean ? "Cleaning" : "Disinfecting"} · {remain}s remaining
      </div>
    </div>
  );
}

export function BedManagementBoard({ facility, onClose }: { facility: string; onClose: () => void }) {
  const [beds, setBeds] = useState<BedRow[]>([]);
  const [names, setNames] = useState<PatientNameMap>({});
  const [loading, setLoading] = useState(true);
  const busyRef = useRef(false);
  const navigate = useNavigate();

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      if (busyRef.current) return;
      busyRef.current = true;
      try {
        const { data } = await fetchWithTimeout(
          () =>
            supabase
              .from("bed_management")
              .select("id, facility_name, room_number, bed_letter, status, current_patient_mrn, status_updated_at")
              .eq("facility_name", facility)
              .order("room_number", { ascending: true })
              .order("bed_letter", { ascending: true })
              .limit(20),
          { data: [], error: null } as any,
        );
        if (cancelled) return;
        setBeds((data ?? []) as BedRow[]);
        const bedRows = (data ?? []) as BedRow[];
        const mrns = bedRows
          .map((b: BedRow) => b.current_patient_mrn)
          .filter((m: string | null): m is string => !!m);
        if (mrns.length) {
          const { data: pts } = await fetchWithTimeout(
            () =>
              supabase
                .from("patients")
                .select("mrn, first_name, last_name")
                .in("mrn", mrns),
            { data: [], error: null } as any,
          );
          if (cancelled) return;
          const map: PatientNameMap = {};
          for (const p of pts ?? []) {
            map[p.mrn as string] = `${(p as any).first_name ?? ""} ${(p as any).last_name ?? ""}`.trim();
          }
          setNames(map);
        } else {
          setNames({});
        }
      } finally {
        busyRef.current = false;
        if (!cancelled) setLoading(false);
      }
    };
    void reconcileOrphanedBeds(facility).catch(() => {});
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
      .channel(`bed-board-${facility}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "bed_management", filter: `facility_name=eq.${facility}` }, scheduleLoad)
      .on("postgres_changes", { event: "*", schema: "public", table: "patients", filter: `facility_name=eq.${facility}` }, scheduleLoad)
      .subscribe();
    const poll = setInterval(load, 10000);
    const reconcilePoll = setInterval(() => {
      void reconcileOrphanedBeds(facility).catch(() => {});
    }, 30000);
    return () => {
      cancelled = true;
      if (debounceTimer) clearTimeout(debounceTimer);
      supabase.removeChannel(ch);
      clearInterval(poll);
      clearInterval(reconcilePoll);
    };
  }, [facility]);

  const counts = useMemo(() => {
    const c = { available: 0, occupied: 0, cleaning: 0, disinfecting: 0 };
    for (const b of beds) {
      const s = b.status.toLowerCase();
      if (s.startsWith("available")) c.available++;
      else if (s.startsWith("occupied")) c.occupied++;
      else if (s.includes("deep cleaning") || s.startsWith("discharged")) c.cleaning++;
      else if (s.startsWith("disinfecting")) c.disinfecting++;
    }
    return c;
  }, [beds]);

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-sm flex flex-col">
      <div className="flex items-center justify-between px-6 h-14 border-b border-slate-700 bg-[#0c2340] text-white">
        <div>
          <div className="text-[10px] uppercase tracking-[0.24em] text-white/55">Unit Bed Allocation</div>
          <div className="text-base font-semibold">{facility} — Floor Bed Board</div>
        </div>
        <div className="flex items-center gap-3 text-xs">
          <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-emerald-400" /> Available {counts.available}</span>
          <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-sky-400" /> Occupied {counts.occupied}</span>
          <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-amber-400" /> Cleaning {counts.cleaning}</span>
          <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-indigo-400" /> Disinfecting {counts.disinfecting}</span>
          <button onClick={onClose} className="ml-2 inline-flex items-center gap-1 rounded-md bg-white/10 hover:bg-white/20 px-3 h-8 text-xs font-semibold">
            <X className="h-3.5 w-3.5" /> Close
          </button>
        </div>
      </div>
      <div className="flex-1 overflow-auto bg-slate-100 p-6">
        {loading ? (
          <div className="grid place-items-center h-full text-slate-500"><Loader2 className="h-5 w-5 animate-spin" /></div>
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4 max-w-[1400px] mx-auto">
            {beds.map((b) => {
              const tone = bedTone(b.status);
              const isOccupied = b.status.toLowerCase().startsWith("occupied") && b.current_patient_mrn;
              const handleClick = () => {
                if (!isOccupied || !b.current_patient_mrn) return;
                onClose();
                navigate({ to: "/patient/$mrn", params: { mrn: b.current_patient_mrn } }).catch(() => {});
              };
              return (
                <div
                  key={b.id}
                  onClick={handleClick}
                  className={`rounded-xl border-2 ${tone.wrap} p-4 shadow-sm ${isOccupied ? "cursor-pointer hover:shadow-md hover:scale-[1.01] transition" : ""}`}
                  title={isOccupied ? `Open chart · ${b.current_patient_mrn}` : undefined}
                >
                  <div className="flex items-center justify-between">
                    <div className="font-mono font-bold text-slate-900 text-lg tabular-nums">{b.room_number}-{b.bed_letter}</div>
                    <span className={`h-2.5 w-2.5 rounded-full ${tone.dot}`} />
                  </div>
                  <div className={`mt-1 text-[11px] font-semibold uppercase tracking-wider ${tone.label}`}>{b.status}</div>
                  <div className="mt-2 text-xs text-slate-700 min-h-[18px] font-mono">
                    {b.current_patient_mrn ? (
                      <span className="flex items-center gap-1.5 flex-wrap">
                        <span className="underline decoration-dotted">{b.current_patient_mrn}</span>
                        {names[b.current_patient_mrn] && (
                          <span className="font-sans font-medium text-slate-900">· {names[b.current_patient_mrn]}</span>
                        )}
                      </span>
                    ) : "—"}
                  </div>
                  <CleaningMeter status={b.status} updatedAt={b.status_updated_at} />
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}