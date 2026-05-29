import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Loader2, FlaskConical, Sparkles, CheckCircle2 } from "lucide-react";
import { BoardHeader } from "@/components/BoardShell";
import { supabase } from "@/integrations/supabase/client";
import { useActiveStaff, useFacility } from "@/lib/facility-context";
import { useRolePermissions } from "@/hooks/useRolePermissions";
import { fallbackLabsFor } from "@/lib/fallback-labs";

export const Route = createFileRoute("/lab-board")({
  component: LabBoard,
});

interface LabOrderRow {
  id: string;
  patient_mrn: string;
  patient_name: string;
  requested_by: string;
  facility_name: string;
  test_type: string;
  clinical_condition: string | null;
  status: string | null;
  results_data: any;
  created_at: string | null;
  result_value?: string | null;
}

interface LabValue {
  test: string;
  value: string;
  unit: string;
  range: string;
  flag: "H" | "L" | "CRITICAL" | "NORMAL";
}

interface BoardPatient {
  mrn: string;
  name: string;
  admission_time: string | null;
}

interface FeedRow {
  key: string;
  timestamp: string | null;
  patient_name: string;
  patient_mrn: string;
  test_type: string;
  result_value: string | null;
  status: string;
  physician: string;
}

function generateMockResults(testType: string, condition: string | null): LabValue[] {
  const dx = (condition || "").toLowerCase();
  const hasSepsis = dx.includes("sepsis") || dx.includes("septic");
  const hasDKA = dx.includes("dka") || dx.includes("ketoacidosis");
  const hasCardiac =
    dx.includes("chf") || dx.includes("heart failure") || dx.includes("mi") || dx.includes("myocardial") || dx.includes("infarction");

  if (testType === "CBC Pack") {
    if (hasSepsis) {
      return [
        { test: "WBC", value: "18.5", unit: "k/uL", range: "4.5–11.0", flag: "CRITICAL" },
        { test: "Hgb", value: "11.8", unit: "g/dL", range: "12–17", flag: "L" },
        { test: "Platelets", value: "142", unit: "k/uL", range: "150–400", flag: "L" },
      ];
    }
    return [
      { test: "WBC", value: "7.2", unit: "k/uL", range: "4.5–11.0", flag: "NORMAL" },
      { test: "Hgb", value: "13.9", unit: "g/dL", range: "12–17", flag: "NORMAL" },
      { test: "Platelets", value: "245", unit: "k/uL", range: "150–400", flag: "NORMAL" },
    ];
  }

  if (testType === "Metabolic Panel CMP") {
    if (hasDKA) {
      return [
        { test: "Glucose", value: "450", unit: "mg/dL", range: "70–110", flag: "CRITICAL" },
        { test: "Potassium", value: "5.6", unit: "mEq/L", range: "3.5–5.0", flag: "H" },
        { test: "Bicarbonate", value: "12", unit: "mEq/L", range: "22–28", flag: "L" },
      ];
    }
    return [
      { test: "Glucose", value: "98", unit: "mg/dL", range: "70–110", flag: "NORMAL" },
      { test: "Potassium", value: "4.1", unit: "mEq/L", range: "3.5–5.0", flag: "NORMAL" },
      { test: "Bicarbonate", value: "24", unit: "mEq/L", range: "22–28", flag: "NORMAL" },
    ];
  }

  if (testType === "Arterial Blood Gas") {
    if (hasDKA) {
      return [
        { test: "pH", value: "7.15", unit: "", range: "7.35–7.45", flag: "CRITICAL" },
        { test: "pCO2", value: "22", unit: "mmHg", range: "35–45", flag: "L" },
        { test: "HCO3", value: "11", unit: "mEq/L", range: "22–26", flag: "L" },
      ];
    }
    return [
      { test: "pH", value: "7.40", unit: "", range: "7.35–7.45", flag: "NORMAL" },
      { test: "pCO2", value: "40", unit: "mmHg", range: "35–45", flag: "NORMAL" },
      { test: "HCO3", value: "24", unit: "mEq/L", range: "22–26", flag: "NORMAL" },
    ];
  }

  if (testType === "Cardiac Troponin") {
    if (hasCardiac) {
      return [
        { test: "Troponin I", value: "0.85", unit: "ng/mL", range: "<0.04", flag: "CRITICAL" },
      ];
    }
    return [{ test: "Troponin I", value: "0.02", unit: "ng/mL", range: "<0.04", flag: "NORMAL" }];
  }

  if (testType === "Serum Lactate") {
    if (hasSepsis) {
      return [{ test: "Lactate", value: "4.2", unit: "mmol/L", range: "0.5–2.2", flag: "CRITICAL" }];
    }
    return [{ test: "Lactate", value: "1.4", unit: "mmol/L", range: "0.5–2.2", flag: "NORMAL" }];
  }

  return [];
}

function LabBoard() {
  const { facility } = useFacility();
  const tech = useActiveStaff("Lab");
  // DB target_role for laboratory tech is "CLT"
  const { can, gate } = useRolePermissions("CLT" as any);
  const [orders, setOrders] = useState<LabOrderRow[]>([]);
  const [boardPatients, setBoardPatients] = useState<BoardPatient[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState<Record<string, LabValue[]>>({});
  const [processing, setProcessing] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    const [{ data: labData }, { data: patientData }] = await Promise.all([
      supabase
        .from("lab_orders")
        .select("*")
        .eq("facility_name", facility)
        .order("created_at", { ascending: false }),
      supabase
        .from("patients")
        .select("mrn, first_name, last_name, name, admission_time")
        .eq("facility_name", facility)
        .eq("status", "Admitted")
        .order("admission_time", { ascending: false })
        .limit(25),
    ]);
    setOrders((labData as LabOrderRow[]) ?? []);
    const rows = (patientData as Array<{
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
    setLoading(false);
  };

  useEffect(() => {
    load();
    // Subscribe to live changes so the board re-renders the moment a lab is
    // ordered, collected, or resulted from anywhere in the system.
    const channel = supabase
      .channel(`lab-board-${facility}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "lab_orders" },
        (payload) => {
          // Instant optimistic prepend so newly-generated orders (e.g. from
          // backend SQL triggers) appear immediately without waiting for the
          // full refetch below.
          const row = payload.new as LabOrderRow | undefined;
          if (row && row.facility_name === facility) {
            setOrders((prev) =>
              prev.some((o) => o.id === row.id) ? prev : [row, ...prev],
            );
          }
        },
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "lab_orders" },
        () => load(),
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "patients" },
        () => load(),
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [facility]);

  // All lab rows for the active facility, drawn from the live global state.
  const visible = useMemo(
    () => orders.filter((o) => o.facility_name === facility),
    [orders, facility],
  );
  const tsOf = (o: LabOrderRow) =>
    o.created_at ? new Date(o.created_at).getTime() : 0;
  // Pending queue — strictly PENDING status, newest first, capped at 25.
  const pending = useMemo(
    () =>
      visible
        .filter((o) => (o.status ?? "").toUpperCase().startsWith("PENDING"))
        .sort((a, b) => tsOf(b) - tsOf(a))
        .slice(0, 25),
    [visible],
  );
  // For each patient currently on the Nursing Board, surface their exact
  // resulted labs — mirroring the patient chart's Recent Labs widget.
  // Real lab_orders rows win; otherwise fall back to the same deterministic
  // per-MRN panel the chart uses (e.g. Patricia Smith → BUN + Urine SG).
  const recentResulted: FeedRow[] = useMemo(() => {
    const resultedByMrn = new Map<string, LabOrderRow[]>();
    for (const o of visible) {
      const s = (o.status ?? "").toUpperCase();
      if (s !== "RESULTED" && s !== "COMPLETED") continue;
      const list = resultedByMrn.get(o.patient_mrn) ?? [];
      list.push(o);
      resultedByMrn.set(o.patient_mrn, list);
    }

    const rows: FeedRow[] = [];
    for (const p of boardPatients) {
      const real = resultedByMrn.get(p.mrn);
      if (real && real.length > 0) {
        for (const o of real) {
          rows.push({
            key: o.id,
            timestamp: o.created_at ?? p.admission_time,
            patient_name: o.patient_name || p.name,
            patient_mrn: p.mrn,
            test_type: o.test_type,
            result_value:
              o.result_value ??
              (Array.isArray(o.results_data) && o.results_data.length > 0
                ? (() => {
                    const r = o.results_data[0];
                    return `${r.test}: ${r.value} ${r.unit}${r.flag && r.flag !== "NORMAL" ? ` [${r.flag}]` : ""}`;
                  })()
                : null),
            status: o.status ?? "Resulted",
            physician: o.requested_by || "Dr. Ghost",
          });
        }
      } else {
        // Deterministic synthetic panel — same tests the patient chart shows.
        for (const [i, l] of fallbackLabsFor(p.mrn).entries()) {
          rows.push({
            key: `${p.mrn}-fb-${i}`,
            timestamp: p.admission_time,
            patient_name: p.name,
            patient_mrn: p.mrn,
            test_type: l.test_type,
            result_value: l.result_value,
            status: l.status,
            physician: "Dr. Ghost",
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
  }, [boardPatients, visible]);

  // Pending count for header still reflects real pending orders.
  const completed = recentResulted;

  const runSample = async (order: LabOrderRow) => {
    setProcessing(order.id);
    await new Promise((r) => setTimeout(r, 900));
    const results = generateMockResults(order.test_type, order.clinical_condition);
    setDraft((d) => ({ ...d, [order.id]: results }));
    setProcessing(null);
    toast.success("AI sample analysis complete — review and submit.");
  };

  const submitReport = async (order: LabOrderRow) => {
    const results = draft[order.id];
    if (!results) return;
    setSubmitting(order.id);
    try {
      const { error: e1 } = await supabase
        .from("lab_orders")
        .update({ status: "Completed", results_data: results as any })
        .eq("id", order.id);
      if (e1) throw e1;
      const { error: e2 } = await supabase
        .from("patients")
        .update({ unread_labs_alert: true })
        .eq("mrn", order.patient_mrn);
      if (e2) throw e2;
      toast.success("Official report posted — RN notified.");
      setDraft((d) => {
        const { [order.id]: _, ...rest } = d;
        return rest;
      });
      await load();
    } catch (e: any) {
      toast.error("Failed to submit report", { description: e?.message });
    } finally {
      setSubmitting(null);
    }
  };

  return (
    <main className="min-h-screen bg-slate-50">
      <BoardHeader
        title={`Laboratory Workspace: ${tech.name} | ${tech.facility}`}
        subtitle={`${tech.ward} · ${pending.length} pending · ${completed.length} resulted`}
        badge="Lab Tech"
      />
      <section className="max-w-[1400px] mx-auto px-6 py-8 space-y-8">
        <div>
          <h2 className="text-lg font-semibold text-slate-900 flex items-center gap-2">
            <FlaskConical className="h-5 w-5 text-[#2d8a9e]" />
            Pending Lab Requests — {facility}
          </h2>
          <p className="text-xs text-slate-500 mt-1">
            Ring-fenced queue. Orders from other facilities are hidden.
          </p>

          <div className="mt-4 rounded-xl border border-slate-200 bg-white overflow-hidden">
            {loading ? (
              <div className="p-8 grid place-items-center text-slate-400">
                <Loader2 className="h-5 w-5 animate-spin" />
              </div>
            ) : pending.length === 0 ? (
              <div className="p-8 text-center text-sm text-slate-500">
                No pending orders for {facility}.
              </div>
            ) : (
              <ul className="divide-y divide-slate-200">
                {pending.map((o) => {
                  const results = draft[o.id];
                  return (
                    <li key={o.id} className="p-5">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="font-semibold text-slate-900">
                            {o.patient_name}{" "}
                            <span className="text-xs font-normal text-slate-500">
                              · {o.patient_mrn}
                            </span>
                          </div>
                          <div className="mt-0.5 text-xs text-slate-600">
                            <span className="font-medium text-[#0c2340]">{o.test_type}</span>
                            {o.clinical_condition && <> · Dx: {o.clinical_condition}</>}
                          </div>
                          <div className="mt-0.5 text-[11px] text-slate-500">
                            Requested by {o.requested_by} ·{" "}
                            {o.created_at
                              ? new Date(o.created_at).toLocaleString([], {
                                  month: "short",
                                  day: "numeric",
                                  hour: "2-digit",
                                  minute: "2-digit",
                                })
                              : "—"}
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          {!results && (
                            <button
                              {...gate("btn_run_lab_sample", () => runSample(o))}
                              disabled={processing === o.id || !can("btn_run_lab_sample")}
                              className="inline-flex items-center gap-1.5 rounded-md bg-[#2d8a9e] hover:bg-[#34a0b6] disabled:opacity-60 disabled:cursor-not-allowed text-white px-3 h-9 text-xs font-semibold transition shadow-sm"
                            >
                              {processing === o.id ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <Sparkles className="h-3.5 w-3.5" />
                              )}
                              {processing === o.id ? "Analyzing…" : "⚙️ Run Sample (AI Autogen)"}
                            </button>
                          )}
                          {results && (
                            <button
                              {...gate("btn_submit_report", () => submitReport(o))}
                              disabled={submitting === o.id || !can("btn_submit_report")}
                              className="inline-flex items-center gap-1.5 rounded-md bg-emerald-600 hover:bg-emerald-700 disabled:opacity-60 disabled:cursor-not-allowed text-white px-3 h-9 text-xs font-semibold transition shadow-sm"
                            >
                              {submitting === o.id ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <CheckCircle2 className="h-3.5 w-3.5" />
                              )}
                              {submitting === o.id ? "Posting…" : "Submit Official Report"}
                            </button>
                          )}
                        </div>
                      </div>

                      {results && (
                        <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 overflow-hidden">
                          <table className="w-full text-xs">
                            <thead className="bg-slate-100 text-slate-600">
                              <tr>
                                <th className="text-left px-3 py-2 font-semibold">Test</th>
                                <th className="text-left px-3 py-2 font-semibold">Value</th>
                                <th className="text-left px-3 py-2 font-semibold">Range</th>
                                <th className="text-left px-3 py-2 font-semibold">Flag</th>
                              </tr>
                            </thead>
                            <tbody>
                              {results.map((r, i) => (
                                <tr key={i} className="border-t border-slate-200">
                                  <td className="px-3 py-2 font-medium text-slate-800">{r.test}</td>
                                  <td className="px-3 py-2 tabular-nums">
                                    {r.value} {r.unit}
                                  </td>
                                  <td className="px-3 py-2 text-slate-500">{r.range}</td>
                                  <td className="px-3 py-2">
                                    <span
                                      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                                        r.flag === "CRITICAL"
                                          ? "bg-red-100 text-red-700 ring-1 ring-red-600/20"
                                          : r.flag === "H" || r.flag === "L"
                                            ? "bg-amber-100 text-amber-800 ring-1 ring-amber-600/20"
                                            : "bg-emerald-100 text-emerald-700 ring-1 ring-emerald-600/20"
                                      }`}
                                    >
                                      {r.flag}
                                    </span>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>

        <div>
          <h2 className="text-lg font-semibold text-slate-900 flex items-center gap-2">
            🗄️ Recent Completed Labs Feed
            <span className="text-xs font-normal text-slate-500">(Auto-Updating · {facility})</span>
          </h2>
          <p className="text-xs text-slate-500 mt-1">
            Latest {recentResulted.length} completed labs for patients currently on the Nursing Board at {facility}, newest first.
          </p>
          <div className="mt-3 rounded-xl border border-slate-300 bg-white overflow-hidden shadow-sm">
            <table className="w-full text-xs">
              <thead className="bg-slate-900 text-slate-100">
                <tr>
                  <th className="text-left px-3 py-2 font-semibold tracking-wide">Timestamp</th>
                  <th className="text-left px-3 py-2 font-semibold tracking-wide">Patient Name</th>
                  <th className="text-left px-3 py-2 font-semibold tracking-wide">MRN</th>
                  <th className="text-left px-3 py-2 font-semibold tracking-wide">Test Type</th>
                  <th className="text-left px-3 py-2 font-semibold tracking-wide">Status</th>
                  <th className="text-left px-3 py-2 font-semibold tracking-wide">Ordering Physician</th>
                </tr>
              </thead>
              <tbody>
                {recentResulted.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-3 py-6 text-center text-slate-500">
                      No completed labs yet for patients currently on the Nursing Board at {facility}.
                    </td>
                  </tr>
                ) : (
                  recentResulted.map((o, i) => (
                    <tr
                      key={o.key}
                      className={`border-t border-slate-200 ${i % 2 === 0 ? "bg-white" : "bg-slate-50"} hover:bg-emerald-50/40`}
                    >
                      <td className="px-3 py-2 tabular-nums text-slate-700 whitespace-nowrap">
                        {o.timestamp
                          ? new Date(o.timestamp).toLocaleString([], {
                              month: "short",
                              day: "numeric",
                              hour: "2-digit",
                              minute: "2-digit",
                              second: "2-digit",
                            })
                          : "Just now"}
                      </td>
                      <td className="px-3 py-2 font-medium text-slate-900">{o?.patient_name ?? "Unknown"}</td>
                      <td className="px-3 py-2 font-mono text-slate-600">{o?.patient_mrn ?? "—"}</td>
                      <td className="px-3 py-2 text-slate-800">
                        <div className="font-medium">{o?.test_type ?? "Unknown"}</div>
                        {o.result_value && (
                          <div className="text-[11px] text-slate-500 mt-0.5">{o.result_value}</div>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold text-emerald-700 ring-1 ring-emerald-600/20">
                          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
                          {o?.status ?? "Resulted"}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-slate-700">{o.physician}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </main>
  );
}