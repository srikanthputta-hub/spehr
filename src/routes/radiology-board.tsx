import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Scan, ArrowLeft, CheckCircle2 } from "lucide-react";
import { toast } from "sonner";
import { BoardHeader } from "@/components/BoardShell";
import { ModuleRibbon, SectionHeader } from "@/components/ClinicalShell";
import { supabase } from "@/integrations/supabase/client";
import { useActiveStaff, useFacility } from "@/lib/facility-context";
import { useRolePermissions } from "@/hooks/useRolePermissions";
import { useAutomationEnabled } from "@/hooks/useAutomationEnabled";
import { fetchWithTimeout } from "@/lib/async-timeout";
import { InfoHint } from "@/components/ui/info-hint";
import { StatusBadge } from "@/components/common/StatusBadge";
import { EmptyState } from "@/components/common/EmptyState";
import { TableSkeleton } from "@/components/common/LoadingSkeleton";

export const Route = createFileRoute("/radiology-board")({
  head: () => ({
    meta: [
      { title: "Radiology Workspace · S.P.E.H.R." },
      {
        name: "description",
        content:
          "Radiology workspace — pending imaging orders and recently reported studies for the active facility.",
      },
    ],
  }),
  component: RadiologyBoard,
});

interface RadRow {
  id: string;
  patient_mrn: string;
  patient_name: string | null;
  facility_name: string | null;
  requested_by: string | null;
  exam_type: string;
  modality: string | null;
  body_part: string | null;
  clinical_indication: string | null;
  snomed_code: string | null;
  snomed_display: string | null;
  status: string | null;
  impression: string | null;
  report_text: string | null;
  ordered_at: string | null;
  resulted_at: string | null;
  created_at: string | null;
}

const PENDING_SET = new Set(["ordered", "pending"]);
const REPORTED_SET = new Set(["reported", "completed"]);

function RadiologyBoard() {
  const { facility } = useFacility();
  const radiologist = useActiveStaff("Rad");
  const { can, gate } = useRolePermissions("Rad");
  const automationEnabled = useAutomationEnabled();
  const [orders, setOrders] = useState<RadRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draftImpression, setDraftImpression] = useState<Record<string, string>>({});
  const [draftReport, setDraftReport] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState<string | null>(null);
  const initialLoadRef = useRef(true);

  const load = async () => {
    if (initialLoadRef.current) setLoading(true);
    const { data } = await fetchWithTimeout(
      async () => {
        const res = await supabase
          .from("radiology_orders")
          .select(
            "id, patient_mrn, patient_name, facility_name, requested_by, exam_type, modality, body_part, clinical_indication, snomed_code, snomed_display, status, impression, report_text, ordered_at, resulted_at, created_at",
          )
          .eq("facility_name", facility)
          .order("created_at", { ascending: false })
          .limit(300);
        return { data: res.data, error: res.error };
      },
      { data: [], error: null },
    );
    setOrders((data as RadRow[]) ?? []);
    setLoading(false);
    initialLoadRef.current = false;
  };

  useEffect(() => {
    load();
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        void load();
      }, 300);
    };
    const channel = supabase
      .channel(`rad-board-${facility}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "radiology_orders" }, schedule)
      .subscribe();
    return () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      supabase.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [facility]);

  const visible = useMemo(
    () => orders.filter((o) => o.facility_name === facility),
    [orders, facility],
  );

  const pending = useMemo(
    () =>
      visible
        .filter((o) => PENDING_SET.has((o.status ?? "").toLowerCase()))
        .sort((a, b) => (b.ordered_at ?? "").localeCompare(a.ordered_at ?? "")),
    [visible],
  );

  const reported = useMemo(
    () =>
      visible
        .filter((o) => REPORTED_SET.has((o.status ?? "").toLowerCase()))
        .sort((a, b) =>
          (b.resulted_at ?? b.created_at ?? "").localeCompare(a.resulted_at ?? a.created_at ?? ""),
        )
        .slice(0, 150),
    [visible],
  );

  const selected = pending.find((o) => o.id === selectedId) ?? pending[0] ?? null;

  const submitManualReport = async (order: RadRow) => {
    const impression = (draftImpression[order.id] ?? "").trim();
    const reportText = (draftReport[order.id] ?? "").trim();
    if (!impression) {
      toast.error("Enter an impression before submitting.");
      return;
    }
    setSubmitting(order.id);
    try {
      const officialAt = new Date().toISOString();
      const { error } = await supabase
        .from("radiology_orders")
        .update({
          status: "Reported",
          impression,
          report_text: reportText || impression,
          resulted_at: officialAt,
        })
        .eq("id", order.id);
      if (error) throw error;
      toast.success("Official report posted.");
      setDraftImpression((d) => {
        const { [order.id]: _, ...rest } = d;
        return rest;
      });
      setDraftReport((d) => {
        const { [order.id]: _, ...rest } = d;
        return rest;
      });
      await load();
    } catch (e) {
      toast.error("Failed to submit report", {
        description: e instanceof Error ? e.message : undefined,
      });
    } finally {
      setSubmitting(null);
    }
  };

  return (
    <main className="min-h-screen bg-slate-50">
      <BoardHeader
        title={`Radiology Workspace: ${radiologist.name} | ${radiologist.facility}`}
        subtitle={`${radiologist.ward} · ${pending.length} pending · ${reported.length} reported`}
        badge="Radiology"
      />
      <div className="px-6 pt-3">
        <Link
          to="/ancillary-services"
          className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2.5 py-1 text-[11px] font-medium text-slate-600 hover:text-slate-900 hover:bg-slate-50 transition"
        >
          <ArrowLeft className="h-3 w-3" /> Back to Ancillary Services
        </Link>
      </div>
      <ModuleRibbon
        module="RAD"
        context={`${facility} · Central Radiology`}
        stats={[
          { label: "Pending", value: pending.length, tone: pending.length > 0 ? "warn" : "good" },
          { label: "Reported", value: reported.length, tone: "good" },
          { label: "Radiologist", value: radiologist.name },
          { label: "Mode", value: automationEnabled ? "Auto-Report" : "Verification" },
        ]}
      />
      {!automationEnabled && (
        <div className="mx-6 mt-3 rounded border border-amber-300 bg-amber-50 px-4 py-2 text-xs text-amber-800">
          <span className="font-bold uppercase tracking-wider">Verification Mode</span> — AI engines
          are OFF. Studies must be finalized manually by the radiologist below.
        </div>
      )}
      <section className="max-w-[1400px] mx-auto px-6 py-8 space-y-8">
        <div>
          <div className="rounded-sm border border-slate-300 bg-white overflow-hidden shadow-sm">
            <SectionHeader
              icon={<Scan className="h-3.5 w-3.5" />}
              title={`Pending Imaging Orders — ${facility}`}
              subtitle="Live"
              right={<span className="font-mono">{pending.length} OPEN</span>}
            />
            {loading ? (
              <div className="p-4">
                <TableSkeleton rows={4} columns={3} />
              </div>
            ) : pending.length === 0 ? (
              <EmptyState
                description={`Queue clear — no pending imaging orders for ${facility}.`}
              />
            ) : (
              <ul className="divide-y divide-slate-200">
                {pending.map((o) => {
                  const isSel = selected?.id === o.id;
                  return (
                    <li
                      key={o.id}
                      onClick={() => setSelectedId(o.id)}
                      className={`p-5 cursor-pointer hover:bg-amber-50/40 transition ${isSel ? "bg-amber-50/60" : ""}`}
                    >
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="font-semibold text-slate-900">
                            {o.patient_name ?? "Unknown"}{" "}
                            <span className="text-xs font-normal text-slate-500">
                              · {o.patient_mrn}
                            </span>
                          </div>
                          <div className="mt-0.5 text-xs text-slate-600">
                            <span className="font-medium text-[#0c2340]">{o.exam_type}</span>
                            {o.modality && <> · {o.modality}</>}
                            {o.body_part && <> · {o.body_part}</>}
                          </div>
                          {o.clinical_indication && (
                            <div className="mt-0.5 text-[11px] text-slate-500">
                              Indication: {o.clinical_indication}
                            </div>
                          )}
                          <div className="mt-0.5 text-[11px] text-slate-500">
                            Requested by {o.requested_by ?? "—"} ·{" "}
                            {o.ordered_at
                              ? new Date(o.ordered_at).toLocaleString([], {
                                  month: "short",
                                  day: "numeric",
                                  hour: "2-digit",
                                  minute: "2-digit",
                                })
                              : "—"}
                          </div>
                          {o.snomed_code && (
                            <div className="mt-0.5 text-[10px] font-mono text-slate-400">
                              SNOMED {o.snomed_code} · {o.snomed_display ?? ""}
                            </div>
                          )}
                        </div>
                        <StatusBadge status="warning" label={o.status ?? "Ordered"} />
                      </div>

                      {isSel && (
                        <div
                          className="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-3 space-y-2"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <div>
                            <label className="block text-[11px] font-semibold text-slate-600 mb-1">
                              Impression <span className="text-red-500">*</span>
                            </label>
                            <input
                              type="text"
                              value={draftImpression[o.id] ?? ""}
                              onChange={(e) =>
                                setDraftImpression((d) => ({ ...d, [o.id]: e.target.value }))
                              }
                              placeholder="e.g. No acute cardiopulmonary abnormality."
                              className="w-full rounded-md border border-slate-300 px-2.5 py-1.5 text-xs"
                            />
                          </div>
                          <div>
                            <label className="block text-[11px] font-semibold text-slate-600 mb-1">
                              Full Report (optional — defaults to impression)
                            </label>
                            <textarea
                              value={draftReport[o.id] ?? ""}
                              onChange={(e) =>
                                setDraftReport((d) => ({ ...d, [o.id]: e.target.value }))
                              }
                              rows={4}
                              placeholder="Findings, technique, comparison, impression…"
                              className="w-full rounded-md border border-slate-300 px-2.5 py-1.5 text-xs font-mono"
                            />
                          </div>
                          <div className="flex items-center gap-1.5">
                            <button
                              {...gate("btn_submit_radiology_report", () => submitManualReport(o))}
                              disabled={
                                submitting === o.id ||
                                !can("btn_submit_radiology_report") ||
                                !(draftImpression[o.id] ?? "").trim()
                              }
                              className="inline-flex items-center gap-1.5 rounded-md bg-emerald-600 hover:bg-emerald-700 disabled:opacity-60 disabled:cursor-not-allowed text-white px-3 h-9 text-xs font-semibold transition shadow-sm"
                            >
                              {submitting === o.id ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <CheckCircle2 className="h-3.5 w-3.5" />
                              )}
                              {submitting === o.id ? "Posting…" : "Submit Official Report"}
                            </button>
                            <InfoHint text="Final, irreversible release: sets radiology_orders.status = Reported, writes the impression and report text, and makes the study visible as a completed read." />
                          </div>
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
          <div className="rounded-sm border border-slate-300 bg-white overflow-hidden shadow-sm">
            <SectionHeader
              tone="teal"
              icon={<span>🖼️</span>}
              title={`Recent Completed Studies — ${facility}`}
              subtitle={`Auto-Updating · Newest first · ${reported.length} entries`}
              right={<span className="font-mono">LIVE</span>}
            />
            <div className="scroll-feed">
              <table className="w-full text-xs">
                <thead className="bg-[#0c2340] text-slate-100 sticky top-0 z-10">
                  <tr>
                    <th className="text-left px-3 py-2 text-[10px] font-bold uppercase tracking-[0.18em]">
                      Timestamp
                    </th>
                    <th className="text-left px-3 py-2 text-[10px] font-bold uppercase tracking-[0.18em]">
                      Patient
                    </th>
                    <th className="text-left px-3 py-2 text-[10px] font-bold uppercase tracking-[0.18em]">
                      MRN
                    </th>
                    <th className="text-left px-3 py-2 text-[10px] font-bold uppercase tracking-[0.18em]">
                      Exam
                    </th>
                    <th className="text-left px-3 py-2 text-[10px] font-bold uppercase tracking-[0.18em]">
                      Modality
                    </th>
                    <th className="text-left px-3 py-2 text-[10px] font-bold uppercase tracking-[0.18em]">
                      Body Site
                    </th>
                    <th className="text-left px-3 py-2 text-[10px] font-bold uppercase tracking-[0.18em]">
                      Status
                    </th>
                    <th className="text-left px-3 py-2 text-[10px] font-bold uppercase tracking-[0.18em]">
                      Radiologist
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {reported.length === 0 ? (
                    <tr>
                      <td colSpan={8} className="p-0">
                        <EmptyState
                          className="border-0 rounded-none"
                          description={`No reported imaging studies yet at ${facility}.`}
                        />
                      </td>
                    </tr>
                  ) : (
                    reported.map((o, i) => {
                      const ts = o.resulted_at ?? o.created_at;
                      return (
                        <tr
                          key={o.id}
                          className={`border-t border-slate-200 ${i % 2 === 0 ? "bg-white" : "bg-slate-50/70"} hover:bg-amber-50/40 transition-colors`}
                        >
                          <td className="px-3 py-2 tabular-nums text-slate-700 whitespace-nowrap">
                            {ts
                              ? new Date(ts).toLocaleString([], {
                                  month: "short",
                                  day: "numeric",
                                  hour: "2-digit",
                                  minute: "2-digit",
                                  second: "2-digit",
                                  hour12: false,
                                })
                              : "Just now"}
                          </td>
                          <td className="px-3 py-2 font-medium text-slate-900">
                            {o.patient_name ?? "Unknown"}
                          </td>
                          <td className="px-3 py-2 font-mono text-slate-600">{o.patient_mrn}</td>
                          <td className="px-3 py-2 text-slate-800">
                            <div className="font-medium">{o.exam_type}</div>
                            {o.impression && (
                              <div className="text-[11px] text-slate-500 mt-0.5 line-clamp-2">
                                {o.impression}
                              </div>
                            )}
                          </td>
                          <td className="px-3 py-2 text-slate-700">{o.modality ?? "—"}</td>
                          <td className="px-3 py-2 text-slate-700">{o.body_part ?? "—"}</td>
                          <td className="px-3 py-2">
                            <StatusBadge status="success" label="Reported" />
                          </td>
                          <td className="px-3 py-2 text-slate-700">{radiologist.name}</td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
