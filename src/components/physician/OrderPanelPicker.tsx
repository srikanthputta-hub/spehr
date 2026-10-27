import { useEffect, useMemo, useState } from "react";
import { FlaskConical, Loader2, Send, ChevronDown } from "lucide-react";
import { toast } from "sonner";
import { listValueSets } from "@/lib/auto-api.functions";
import { supabase } from "@/integrations/supabase/client";
import { useAutoApiEnabled } from "@/hooks/useAutomationEnabled";
import { InfoHint } from "@/components/ui/info-hint";

type Code = { code: string; display: string; system?: string };
type ValueSet = {
  id: string;
  name: string;
  system: string;
  status: string;
  codes: Code[];
  description?: string | null;
};

interface Props {
  mrn: string;
  patientName: string | null;
  facility: string | null;
  diagnosis: string | null;
  physicianName?: string;
}

/**
 * Value-set–driven physician order panel.
 * Lists every published LOINC value set authored in the Custom Value Set
 * Builder, then one-click stages all member codes as PENDING lab_orders
 * pre-coded with their LOINC concept (no separate auto-coder round trip).
 */
export function OrderPanelPicker({ mrn, patientName, facility, diagnosis, physicianName }: Props) {
  const autoApi = useAutoApiEnabled();
  const [open, setOpen] = useState(false);
  const [sets, setSets] = useState<ValueSet[]>([]);
  const [loading, setLoading] = useState(false);
  const [fetched, setFetched] = useState(false);
  const [submittingId, setSubmittingId] = useState<string | null>(null);

  useEffect(() => {
    if (!open || sets.length > 0) return;
    setLoading(true);
    listValueSets()
      .then((r) => {
        const all = (r.items ?? []) as unknown as ValueSet[];
        setSets(
          all.filter(
            (v) =>
              v.status === "published" &&
              (v.system === "LOINC" || v.system === "Mixed") &&
              Array.isArray(v.codes) &&
              v.codes.length > 0,
          ),
        );
      })
      .finally(() => {
        setLoading(false);
        setFetched(true);
      });
  }, [open, sets.length]);

  const submitPanel = async (panel: ValueSet) => {
    setSubmittingId(panel.id);
    let okCount = 0;
    try {
      // Insert one lab order per code, pre-coded — no separate UMLS round trip.
      const rows = panel.codes.map((c) => ({
        patient_mrn: mrn,
        patient_name: patientName ?? "Unknown",
        facility_name: facility ?? "Memorial Hospital",
        requested_by: physicianName ?? "Physician",
        test_type: c.display,
        clinical_condition: diagnosis,
        status: "Pending Collection",
        loinc_code: c.code,
        loinc_display: c.display,
        coding_source: `value-set:${panel.name}`,
        coded_at: new Date().toISOString(),
        // `source` is a required column on lab_orders; previously missing
        // here (masked by an `as any` cast on the insert).
        source: "physician-order-panel",
      }));
      const { data, error } = await supabase.from("lab_orders").insert(rows).select("id");
      if (error) throw error;
      okCount = (data ?? []).length;
      toast.success(`Panel staged: ${panel.name}`, {
        description: `${okCount} lab orders routed to the lab queue.`,
      });
    } catch (e) {
      toast.error("Failed to stage panel", {
        description: e instanceof Error ? e.message : undefined,
      });
    } finally {
      setSubmittingId(null);
    }
  };

  const headerHint = useMemo(() => {
    if (!autoApi) return "AUTO API engine OFF — value sets unavailable.";
    if (loading) return "Loading published value sets…";
    if (!fetched) return "Click to view published order panels.";
    if (sets.length === 0)
      return "No published LOINC panels — publish one in System Admin → AUTO API.";
    return `${sets.length} published panel${sets.length === 1 ? "" : "s"} available.`;
  }, [autoApi, loading, fetched, sets.length]);

  return (
    <div className="rounded-lg border border-slate-200 bg-white">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between gap-2 border-b border-slate-200 px-5 py-3 hover:bg-slate-50"
      >
        <div className="flex items-center gap-2">
          <FlaskConical className="h-4 w-4 text-violet-600" />
          <div className="text-left">
            <div className="text-sm font-semibold text-slate-900 inline-flex items-center gap-1">
              Order Panels (Value-Set Driven)
              <InfoHint text="Pre-built lab bundles authored in System Admin → Medical Dictionary → Value Set Library. Clicking a panel one-shot submits every member LOINC code as an individual PENDING lab order, each already pre-coded — no separate auto-coder round trip needed." />
            </div>
            <div className="text-[11px] text-slate-500">{headerHint}</div>
          </div>
        </div>
        <ChevronDown
          className={`h-4 w-4 text-slate-500 transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open && (
        <div className="p-4 space-y-2">
          {loading && (
            <div className="text-xs text-slate-500 flex items-center gap-2">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
            </div>
          )}
          {!loading && sets.length === 0 && (
            <div className="text-xs text-slate-500 italic">No published LOINC panels yet.</div>
          )}
          {sets.map((panel) => (
            <div
              key={panel.id}
              className="flex items-start justify-between gap-3 rounded-md border border-slate-200 bg-slate-50/60 px-3 py-2"
            >
              <div className="min-w-0">
                <div className="text-sm font-semibold text-slate-900 truncate">{panel.name}</div>
                <div className="text-[11px] text-slate-500">
                  {panel.system} · {panel.codes.length} codes
                  {panel.description ? ` · ${panel.description}` : ""}
                </div>
                <div className="mt-1 flex flex-wrap gap-1">
                  {panel.codes.slice(0, 6).map((c) => (
                    <span
                      key={c.code}
                      className="inline-flex items-center gap-1 rounded-full bg-violet-100 text-violet-800 border border-violet-200 px-1.5 py-0.5 text-[10px]"
                    >
                      <span className="font-mono">{c.code}</span>
                      <span className="truncate max-w-[120px]">{c.display}</span>
                    </span>
                  ))}
                  {panel.codes.length > 6 && (
                    <span className="text-[10px] text-slate-500">
                      +{panel.codes.length - 6} more
                    </span>
                  )}
                </div>
              </div>
              <button
                type="button"
                disabled={!autoApi || submittingId === panel.id}
                onClick={() => submitPanel(panel)}
                className="inline-flex items-center gap-1.5 rounded-md bg-[#0c2340] px-3 py-1.5 text-xs font-semibold text-white hover:bg-[#0c2340]/90 disabled:opacity-50 shrink-0"
              >
                {submittingId === panel.id ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Send className="h-3.5 w-3.5" />
                )}
                Order Panel
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
