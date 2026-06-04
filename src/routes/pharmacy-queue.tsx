import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  AlertTriangle,
  CheckCircle2,
  FlaskConical,
  Inbox,
  Loader2,
  Pill,
  ShieldAlert,
  XCircle,
} from "lucide-react";
import { BoardHeader } from "@/components/BoardShell";
import { ModuleRibbon, SectionHeader, StatusPill } from "@/components/ClinicalShell";
import { supabase } from "@/integrations/supabase/client";
import { useFacility, useActiveStaff } from "@/lib/facility-context";
import { fallbackMedsFor } from "@/lib/fallback-meds";

type Order = {
  id: string;
  mrn: string | null;
  drug_name: string | null;
  dose: string | null;
  route: string | null;
  frequency: string | null;
  status: string | null;
};

type Patient = {
  mrn: string;
  first_name: string | null;
  last_name: string | null;
  age: number | null;
  gender: string | null;
  room: string | null;
  diagnosis: string | null;
  chief_complaint: string | null;
};

type Lab = {
  id: string;
  test_name: string | null;
  panel_name: string | null;
  result_value: number | null;
  unit: string | null;
  reference_range: string | null;
  flag: string | null;
  time_drawn: string | null;
};

interface BoardPatient {
  mrn: string;
  name: string;
  admission_time: string | null;
}

interface DispensedFeedRow {
  key: string;
  timestamp: string | null;
  patient_name: string;
  patient_mrn: string;
  drug_name: string;
  dose: string | null;
  route: string | null;
  frequency: string | null;
  status: string;
  pharmacist: string;
}

const KEY_LABS = ["creatinine", "potassium", "k+", "k ", "bun", "egfr", "inr", "platelet", "wbc", "hgb", "hemoglobin"];

function PharmacyQueue() {
  const { facility } = useFacility();
  const pharm = useActiveStaff("PharmD");
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [facilityMrns, setFacilityMrns] = useState<Set<string>>(new Set());
  const [dispensed, setDispensed] = useState<
    {
      id: string;
      mrn: string | null;
      patient_mrn: string | null;
      patient_name: string | null;
      drug_name: string | null;
      medication_name: string | null;
      dose: string | null;
      route: string | null;
      frequency: string | null;
      status: string | null;
      administered_at: string | null;
      created_at: string | null;
      ordering_physician: string | null;
    }[]
  >([]);
  const [boardPatients, setBoardPatients] = useState<BoardPatient[]>([]);

  const [patient, setPatient] = useState<Patient | null>(null);
  const [labs, setLabs] = useState<Lab[]>([]);
  const [contextLoading, setContextLoading] = useState(false);
  const [acting, setActing] = useState(false);

  // Load the set of MRNs for the active facility so we can ring-fence the queue
  useEffect(() => {
    let active = true;
    (async () => {
      const { data } = await supabase
        .from("patients")
        .select("mrn, facility_name");
      if (!active) return;
      const set = new Set<string>();
      for (const p of (data ?? []) as { mrn: string | null; facility_name: string | null }[]) {
        if (!p.mrn) continue;
        if ((p.facility_name ?? "Memorial Hospital") === facility) set.add(p.mrn);
      }
      setFacilityMrns(set);
    })();
    return () => {
      active = false;
    };
  }, [facility]);

  // Load the Nursing Board roster (latest 25 admitted patients) for the
  // active facility — same source the Nursing Board / Lab Board use.
  useEffect(() => {
    let active = true;
    const loadBoard = async () => {
      const { data } = await supabase
        .from("patients")
        .select("mrn, first_name, last_name, name, admission_time")
        .eq("facility_name", facility)
        .eq("status", "Admitted")
        .order("admission_time", { ascending: false })
        .limit(25);
      if (!active) return;
      const rows = (data as Array<{
        mrn: string | null;
        first_name: string | null;
        last_name: string | null;
        name: string | null;
        admission_time: string | null;
      }> | null) ?? [];
      setBoardPatients(
        rows
          .filter((p): p is typeof p & { mrn: string } => !!p.mrn)
          .map((p) => ({
            mrn: p.mrn,
            name:
              (p.name ?? [p.first_name, p.last_name].filter(Boolean).join(" ")) ||
              "Unknown",
            admission_time: p.admission_time,
          })),
      );
    };
    loadBoard();
    const channel = supabase
      .channel(`pharmacy-board-${facility}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "patients" },
        () => loadBoard(),
      )
      .subscribe();
    return () => {
      active = false;
      supabase.removeChannel(channel);
    };
  }, [facility]);

  // Load pending queue — includes every in-flight status so users watch
  // each order transition Ordered → Pending → Dispensed live (then it
  // drops off once the bedside RN marks it Administered).
  useEffect(() => {
    let active = true;
    const PENDING_STATUSES = [
      "ORDERED",
      "PENDING_PHARMACY",
      "PENDING_VERIFICATION",
      "DISPENSED",
    ];
    (async () => {
      const { data, error } = await supabase
        .from("medication_orders")
        .select("id, mrn, drug_name, dose, route, frequency, status")
        .in("status", PENDING_STATUSES);
      if (!active) return;
      if (error) setError(error.message);
      else {
        const rows = (data ?? []) as Order[];
        setOrders(rows);
        if (rows.length > 0) setSelectedId(rows[0].id);
      }
      setLoading(false);
    })();

    const channel = supabase
      .channel("pharmacy-orders")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "medication_orders" },
        (payload) => {
          const row = (payload.new ?? payload.old) as Order | undefined;
          if (!row) return;
          setOrders((prev) => {
            const without = prev.filter((o) => o.id !== row.id);
            const newStatus = (payload.new as Order)?.status;
            if (
              payload.eventType !== "DELETE" &&
              newStatus &&
              PENDING_STATUSES.includes(newStatus)
            ) {
              return [...without, payload.new as Order];
            }
            return without;
          });
        },
      )
      .subscribe();
    return () => {
      active = false;
      supabase.removeChannel(channel);
    };
  }, []);

  const visibleOrders = useMemo(
    () => orders.filter((o) => !!o.mrn && facilityMrns.has(o.mrn)),
    [orders, facilityMrns],
  );

  // Recent dispensed medications — live feed sourced from medication_orders.
  // Refetches on any change to the table so the dashboard stays in sync with
  // the global state the moment a new patient is admitted or a dose is given.
  useEffect(() => {
    let active = true;
    const loadDispensed = async () => {
      const { data } = await supabase
        .from("medication_orders")
        .select(
          "id, mrn, patient_mrn, patient_name, drug_name, medication_name, dose, route, frequency, status, administered_at, created_at, ordering_physician, facility_name",
        )
        .eq("facility_name", facility)
        .order("administered_at", { ascending: false, nullsFirst: false })
        .limit(200);
      if (!active) return;
      setDispensed((data ?? []) as any);
    };
    loadDispensed();
    const channel = supabase
      .channel(`pharmacy-dispensed-${facility}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "medication_orders" },
        (payload) => {
          // Instant optimistic prepend so meds inserted by backend SQL
          // triggers (auto_order_ghost_labs, etc.) appear immediately
          // without waiting for the broader refetch below.
          const row = payload.new as any;
          if (row && row.facility_name === facility) {
            setDispensed((prev) =>
              prev.some((o) => o.id === row.id) ? prev : [row, ...prev],
            );
          }
        },
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "medication_orders" },
        () => loadDispensed(),
      )
      .subscribe();
    return () => {
      active = false;
      supabase.removeChannel(channel);
    };
  }, [facility]);

  // For each patient currently on the Nursing Board, surface their exact
  // administered medications — mirroring the patient chart's MAR.
  // Real medication_orders rows win; otherwise fall back to the same
  // deterministic per-MRN panel the admission randomizer would have seeded.
  const recentDispensed: DispensedFeedRow[] = useMemo(() => {
    const pharmacistName = pharm?.name
      ? `${pharm.name}, PharmD`
      : "Auto-Dispense, PharmD";

    const adminByMrn = new Map<string, typeof dispensed>();
    for (const o of dispensed) {
      if ((o.status ?? "").toUpperCase() !== "ADMINISTERED") continue;
      const mrn = o.patient_mrn ?? o.mrn;
      if (!mrn) continue;
      const list = adminByMrn.get(mrn) ?? [];
      list.push(o);
      adminByMrn.set(mrn, list);
    }

    const rows: DispensedFeedRow[] = [];
    for (const p of boardPatients) {
      const real = adminByMrn.get(p.mrn);
      if (real && real.length > 0) {
        for (const o of real) {
          rows.push({
            key: o.id,
            timestamp: o.administered_at ?? o.created_at,
            patient_name: o.patient_name || p.name,
            patient_mrn: p.mrn,
            drug_name: o.drug_name ?? o.medication_name ?? "—",
            dose: o.dose,
            route: o.route,
            frequency: o.frequency,
            status: o.status ?? "Administered",
            pharmacist: pharmacistName,
          });
        }
      } else {
        for (const [i, m] of fallbackMedsFor(p.mrn).entries()) {
          rows.push({
            key: `${p.mrn}-fb-${i}`,
            timestamp: p.admission_time,
            patient_name: p.name,
            patient_mrn: p.mrn,
            drug_name: m.drug_name,
            dose: m.dose,
            route: m.route,
            frequency: null,
            status: m.status,
            pharmacist: pharmacistName,
          });
        }
      }
    }

    rows.sort((a, b) => {
      const ta = a.timestamp ? new Date(a.timestamp).getTime() : 0;
      const tb = b.timestamp ? new Date(b.timestamp).getTime() : 0;
      return tb - ta;
    });
    return rows.slice(0, 25);
  }, [boardPatients, dispensed, pharm?.name]);

  const selected = useMemo(
    () => visibleOrders.find((o) => o.id === selectedId) ?? null,
    [visibleOrders, selectedId],
  );

  // Load patient context + labs whenever selection changes
  useEffect(() => {
    if (!selected?.mrn) {
      setPatient(null);
      setLabs([]);
      return;
    }
    let active = true;
    setContextLoading(true);
    (async () => {
      const [{ data: pData }, { data: lData }] = await Promise.all([
        supabase
          .from("patients")
          .select("mrn, first_name, last_name, age, gender, room, diagnosis, chief_complaint")
          .eq("mrn", selected.mrn!)
          .maybeSingle(),
        supabase
          .from("lab_results")
          .select("id, test_name, panel_name, result_value, unit, reference_range, flag, time_drawn")
          .eq("mrn", selected.mrn!)
          .order("time_drawn", { ascending: false })
          .limit(40),
      ]);
      if (!active) return;
      setPatient((pData ?? null) as Patient | null);
      setLabs((lData ?? []) as Lab[]);
      setContextLoading(false);
    })();
    return () => {
      active = false;
    };
  }, [selected?.mrn]);

  // Always pick next pending after current selection disappears
  useEffect(() => {
    if (selectedId && !visibleOrders.some((o) => o.id === selectedId)) {
      setSelectedId(visibleOrders[0]?.id ?? null);
    }
  }, [visibleOrders, selectedId]);

  const keyLabs = useMemo(() => {
    const result: Record<string, Lab> = {};
    for (const l of labs) {
      const key = (l.test_name ?? "").toLowerCase().trim();
      if (!KEY_LABS.some((k) => key.includes(k))) continue;
      if (!result[key]) result[key] = l; // already ordered newest first
    }
    return Object.values(result);
  }, [labs]);

  const actOnOrder = async (id: string, newStatus: "DUE" | "REJECTED") => {
    const prevOrders = orders;
    // Optimistic remove
    setOrders((curr) => curr.filter((o) => o.id !== id));
    setActing(true);
    const { error } = await supabase
      .from("medication_orders")
      .update({ status: newStatus })
      .eq("id", id);
    setActing(false);
    if (error) {
      setOrders(prevOrders);
      toast.error("Action failed", { description: error.message });
      return;
    }
    if (newStatus === "DUE") {
      toast.success("Verified & released to MAR", {
        description: `${selected?.drug_name ?? "Order"} now DUE on nursing board`,
      });
    } else {
      toast("Order rejected", {
        description: "Provider will be notified to re-order",
      });
    }
  };

  return (
    <main className="min-h-screen bg-slate-50">
      <BoardHeader
        title={`Pharmacy Workspace: ${pharm.name} | ${pharm.facility}`}
        badge="Pharmacy · PharmD"
        subtitle={`${pharm.ward} · Order verification & clinical review`}
      />
      <ModuleRibbon
        module="PHA"
        context={`${facility} · Central Pharmacy`}
        stats={[
          { label: "Pending", value: visibleOrders.length, tone: visibleOrders.length > 0 ? "warn" : "good" },
          { label: "Dispensed", value: recentDispensed.length, tone: "good" },
          { label: "Pharmacist", value: pharm.name },
          { label: "Mode", value: "Verification" },
        ]}
      />
      <div className="grid grid-cols-12 gap-4 p-4">
        {/* Inbox */}
        <aside className="col-span-12 lg:col-span-4 xl:col-span-3">
          <div className="rounded-sm border border-slate-300 bg-white overflow-hidden shadow-sm">
            <SectionHeader
              icon={<Inbox className="h-3.5 w-3.5" />}
              title="Pending Verification"
              subtitle="RxQueue · Live"
              right={<span className="font-mono">{visibleOrders.length}</span>}
            />
            <div className="max-h-[calc(100vh-160px)] overflow-y-auto divide-y divide-slate-100">
              {loading && (
                <div className="p-4 text-xs text-slate-500">Loading queue…</div>
              )}
              {error && (
                <div className="p-4 text-xs text-red-600">Unable to load — {error}</div>
              )}
              {!loading && visibleOrders.length === 0 && !error && (
                <div className="p-8 text-center text-xs text-slate-500">
                  <CheckCircle2 className="mx-auto h-6 w-6 text-emerald-500 mb-2" />
                  Queue clear for {facility}.
                </div>
              )}
              {visibleOrders.map((o) => {
                const active = o.id === selectedId;
                return (
                  <button
                    key={o.id}
                    onClick={() => setSelectedId(o.id)}
                    className={`w-full text-left px-3 py-2.5 transition ${
                      active ? "bg-[#0c2340] text-white" : "hover:bg-slate-50"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-sm font-medium truncate flex items-center gap-1.5">
                        <Pill className={`h-3.5 w-3.5 ${active ? "text-white/80" : "text-amber-600"}`} />
                        {o.drug_name ?? "—"}
                      </div>
                      <span
                        className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${
                          active ? "bg-white/15 text-white" : "bg-amber-50 text-amber-700 border border-amber-200"
                        }`}
                      >
                        PEND
                      </span>
                    </div>
                    <div className={`mt-0.5 text-[11px] truncate ${active ? "text-white/75" : "text-slate-500"}`}>
                      {o.dose} · {o.route} · {o.frequency}
                    </div>
                    <div className={`mt-1 text-[10px] font-mono ${active ? "text-white/70" : "text-slate-400"}`}>
                      {o.mrn ?? "—"}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        </aside>

        {/* Processing panel */}
        <section className="col-span-12 lg:col-span-8 xl:col-span-9 space-y-4">
          {!selected ? (
            <div className="rounded-lg border border-dashed border-slate-300 bg-white p-12 text-center text-sm text-slate-500">
              Select a pending order to begin verification.
            </div>
          ) : (
            <>
              {/* Order + Patient banner */}
              <div className="rounded-lg border border-slate-200 bg-white p-5">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div>
                    <div className="text-[10px] uppercase tracking-[0.18em] text-slate-500">
                      Requested Order
                    </div>
                    <div className="mt-1 text-lg font-semibold text-slate-900">
                      {selected.drug_name}
                    </div>
                    <div className="text-sm text-slate-600">
                      <span className="font-medium">{selected.dose}</span>
                      <span className="mx-1.5 text-slate-300">·</span>
                      {selected.route}
                      <span className="mx-1.5 text-slate-300">·</span>
                      {selected.frequency}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-[10px] uppercase tracking-[0.18em] text-slate-500">
                      Patient
                    </div>
                    <div className="mt-1 text-sm font-semibold text-slate-900">
                      {patient ? `${patient.first_name ?? ""} ${patient.last_name ?? ""}`.trim() : "—"}
                    </div>
                    <div className="text-[11px] text-slate-500 font-mono">
                      {selected.mrn}
                      {patient?.room && <> · Rm {patient.room}</>}
                    </div>
                    {patient && (
                      <div className="text-[11px] text-slate-500">
                        {patient.age ?? "—"} {patient.gender ?? ""} ·{" "}
                        {patient.diagnosis || patient.chief_complaint || "—"}
                      </div>
                    )}
                  </div>
                </div>

                {/* Actions */}
                <div className="mt-5 flex flex-wrap items-center gap-3 border-t border-slate-100 pt-4">
                  <button
                    onClick={() => actOnOrder(selected.id, "DUE")}
                    disabled={acting}
                    className="inline-flex items-center gap-2 rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-60"
                  >
                    {acting ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                    Approve &amp; Verify → Send to MAR
                  </button>
                  <button
                    onClick={() => actOnOrder(selected.id, "REJECTED")}
                    disabled={acting}
                    className="inline-flex items-center gap-2 rounded-md border border-red-200 bg-white px-4 py-2 text-sm font-medium text-red-700 hover:bg-red-50 disabled:opacity-60"
                  >
                    <XCircle className="h-4 w-4" />
                    Reject Order
                  </button>
                  <div className="ml-auto text-[11px] text-slate-500">
                    Approval routes status to <span className="font-mono text-slate-700">DUE</span>
                  </div>
                </div>
              </div>

              {/* Clinical guardrails */}
              <div className="rounded-lg border border-slate-200 bg-white">
                <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3">
                  <div className="flex items-center gap-2">
                    <ShieldAlert className="h-4 w-4 text-amber-600" />
                    <h2 className="text-sm font-semibold text-slate-900">
                      Clinical Guardrails — Latest Labs
                    </h2>
                  </div>
                  <span className="text-[10px] uppercase tracking-[0.18em] text-slate-500">
                    Verify organ function before sign-off
                  </span>
                </div>
                <div className="p-5">
                  {contextLoading ? (
                    <div className="text-xs text-slate-500 flex items-center gap-2">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" /> Fetching labs…
                    </div>
                  ) : keyLabs.length === 0 ? (
                    <div className="flex items-center gap-2 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-3 py-2">
                      <AlertTriangle className="h-3.5 w-3.5" />
                      No recent renal/electrolyte labs on file for this patient. Confirm before verifying.
                    </div>
                  ) : (
                    <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-3">
                      {keyLabs.map((l) => {
                        const abn = l.flag === "H" || l.flag === "L";
                        return (
                          <div
                            key={l.id}
                            className={`rounded-md border p-3 ${
                              abn ? "border-red-200 bg-red-50/60" : "border-slate-200 bg-slate-50/60"
                            }`}
                          >
                            <div className="flex items-center justify-between">
                              <div className="text-[11px] uppercase tracking-[0.14em] text-slate-500">
                                {l.test_name}
                              </div>
                              {abn && (
                                <span className="text-[10px] font-bold text-red-700 bg-red-100 rounded px-1.5 py-0.5">
                                  {l.flag}
                                </span>
                              )}
                            </div>
                            <div
                              className={`mt-1 text-base font-semibold ${
                                abn ? "text-red-700" : "text-slate-900"
                              }`}
                            >
                              {l.result_value}
                              <span className="ml-1 text-xs font-normal text-slate-500">
                                {l.unit}
                              </span>
                            </div>
                            <div className="text-[10px] text-slate-500">
                              Ref: {l.reference_range ?? "—"}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {/* Full lab strip */}
                  {labs.length > 0 && (
                    <details className="mt-4 group">
                      <summary className="cursor-pointer text-[11px] uppercase tracking-[0.18em] text-slate-500 hover:text-slate-700 inline-flex items-center gap-1.5">
                        <FlaskConical className="h-3 w-3" />
                        All recent labs ({labs.length})
                      </summary>
                      <div className="mt-3 overflow-x-auto">
                        <table className="w-full text-xs">
                          <thead className="text-[10px] uppercase tracking-[0.14em] text-slate-500 border-b border-slate-200">
                            <tr>
                              <th className="text-left py-1.5 pr-3">Panel</th>
                              <th className="text-left py-1.5 pr-3">Test</th>
                              <th className="text-right py-1.5 pr-3">Result</th>
                              <th className="text-left py-1.5 pr-3">Ref</th>
                              <th className="text-left py-1.5">Flag</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-100">
                            {labs.map((l) => {
                              const abn = l.flag === "H" || l.flag === "L";
                              return (
                                <tr key={l.id}>
                                  <td className="py-1.5 pr-3 text-slate-500">{l.panel_name ?? "—"}</td>
                                  <td className="py-1.5 pr-3 text-slate-700">{l.test_name ?? "—"}</td>
                                  <td className={`py-1.5 pr-3 text-right font-mono ${abn ? "text-red-700 font-bold" : "text-slate-900"}`}>
                                    {l.result_value ?? "—"} {l.unit ?? ""}
                                  </td>
                                  <td className="py-1.5 pr-3 text-slate-500">{l.reference_range ?? "—"}</td>
                                  <td className="py-1.5 text-slate-500">{l.flag ?? "—"}</td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    </details>
                  )}
                </div>
              </div>
            </>
          )}

          {/* Recent dispatched medications feed */}
          <div className="pt-2">
            <div className="rounded-sm border border-slate-300 bg-white overflow-hidden shadow-sm">
              <SectionHeader
                tone="teal"
                icon={<span>💊</span>}
                title={`Recent Dispatched Medications — ${facility}`}
                subtitle="Auto-Updating · Newest first"
                right={<span className="font-mono">LIVE</span>}
              />
              <table className="w-full text-xs">
                <thead className="bg-[#0c2340] text-slate-100">
                  <tr>
                    <th className="text-left px-3 py-2 text-[10px] font-bold uppercase tracking-[0.18em]">Timestamp</th>
                    <th className="text-left px-3 py-2 text-[10px] font-bold uppercase tracking-[0.18em]">Patient</th>
                    <th className="text-left px-3 py-2 text-[10px] font-bold uppercase tracking-[0.18em]">MRN</th>
                    <th className="text-left px-3 py-2 text-[10px] font-bold uppercase tracking-[0.18em]">Medication Order</th>
                    <th className="text-left px-3 py-2 text-[10px] font-bold uppercase tracking-[0.18em]">Status</th>
                    <th className="text-left px-3 py-2 text-[10px] font-bold uppercase tracking-[0.18em]">Verifying PharmD</th>
                  </tr>
                </thead>
                <tbody>
                  {(() => {
                    const rows = recentDispensed;
                    if (rows.length === 0) {
                      return (
                        <tr>
                          <td colSpan={6} className="px-3 py-6 text-center text-slate-500">
                            No recent activity.
                          </td>
                        </tr>
                      );
                    }
                    return rows.map((m, i) => (
                      <tr
                        key={m.key}
                        className={`border-t border-slate-200 ${i % 2 === 0 ? "bg-white" : "bg-slate-50/70"} hover:bg-cyan-50/50 transition-colors`}
                      >
                        <td className="px-3 py-2 tabular-nums text-slate-700 whitespace-nowrap">
                          {(() => {
                            const ts = m?.timestamp;
                            return ts ? new Date(ts).toLocaleString([], {
                              month: "short",
                              day: "numeric",
                              hour: "2-digit",
                              minute: "2-digit",
                              second: "2-digit",
                            }) : "Just now";
                          })()}
                        </td>
                        <td className="px-3 py-2 font-medium text-slate-900">{m?.patient_name ?? "Unknown"}</td>
                        <td className="px-3 py-2 font-mono text-slate-600">{m?.patient_mrn ?? "—"}</td>
                        <td className="px-3 py-2 text-slate-800">
                          {[m?.drug_name, m?.dose, m?.route, m?.frequency].filter(Boolean).join(" ") || "Unknown"}
                        </td>
                        <td className="px-3 py-2">
                          <StatusPill tone="good" pulse>{m.status ?? "Administered"}</StatusPill>
                        </td>
                        <td className="px-3 py-2 text-slate-700">
                          {m.pharmacist}
                        </td>
                      </tr>
                    ));
                  })()}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}

export const Route = createFileRoute("/pharmacy-queue")({
  component: PharmacyQueue,
});