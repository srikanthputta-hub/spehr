import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import {
  Activity,
  CheckCircle2,
  ChevronRight,
  Database,
  Languages,
  Layers,
  ShieldAlert,
  Sparkles,
  XCircle,
} from "lucide-react";
import { InfoHint } from "@/components/ui/info-hint";

/* ------------------------------------------------------------------ */
/*  Catalog → live counts from the step-8 tables                       */
/* ------------------------------------------------------------------ */

type Metrics = {
  resolved24h: number;
  rejected24h: number;
  auditTotal: number;
  valueSets: number;
  chv: number;
  cds24h: number;
};

export function TerminologyMetricsStrip() {
  const [m, setM] = useState<Metrics | null>(null);

  useEffect(() => {
    let cancelled = false;
    const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    (async () => {
      const [r1, r2, r3, r4, r5, r6] = await Promise.all([
        supabase
          .from("terminology_audit")
          .select("id", { count: "exact", head: true })
          .eq("action", "resolved")
          .gte("created_at", since),
        supabase
          .from("terminology_audit")
          .select("id", { count: "exact", head: true })
          .eq("action", "rejected")
          .gte("created_at", since),
        supabase.from("terminology_audit").select("id", { count: "exact", head: true }),
        supabase
          .from("custom_value_sets")
          .select("id", { count: "exact", head: true })
          .eq("status", "published"),
        supabase.from("chv_translations").select("id", { count: "exact", head: true }),
        supabase
          .from("cds_overrides")
          .select("id", { count: "exact", head: true })
          .gte("created_at", since),
      ]);
      if (cancelled) return;
      setM({
        resolved24h: r1.count ?? 0,
        rejected24h: r2.count ?? 0,
        auditTotal: r3.count ?? 0,
        valueSets: r4.count ?? 0,
        chv: r5.count ?? 0,
        cds24h: r6.count ?? 0,
      });
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const items = [
    {
      icon: CheckCircle2,
      label: "UMLS Resolved · 24h",
      value: m?.resolved24h ?? "—",
      cls: "text-emerald-700 bg-emerald-50 border-emerald-200",
      info: "Free-text inputs (drugs, conditions, lab names) the UMLS resolver mapped to a canonical code in the last 24h across all facilities.",
    },
    {
      icon: XCircle,
      label: "Rejected · 24h",
      value: m?.rejected24h ?? "—",
      cls: "text-rose-700 bg-rose-50 border-rose-200",
      info: "Terms the resolver rejected in the last 24h — confidence below the NLP gate threshold or no matching UMLS concept. Rejects go to the NLP Approval Trail for manual review.",
    },
    {
      icon: Database,
      label: "Audit Trail · Total",
      value: m?.auditTotal ?? "—",
      cls: "text-slate-700 bg-slate-50 border-slate-200",
      info: "All-time count of every terminology resolution attempt (resolved + rejected + pending) across all facilities.",
    },
    {
      icon: Layers,
      label: "Value Sets · Published",
      value: m?.valueSets ?? "—",
      cls: "text-indigo-700 bg-indigo-50 border-indigo-200",
      info: "Custom value sets in status = published — the only ones visible to consumers (physician order panels, CDS engine, billing, population health).",
    },
    {
      icon: Languages,
      label: "CHV Translations",
      value: m?.chv ?? "—",
      cls: "text-amber-700 bg-amber-50 border-amber-200",
      info: 'CHV = Consumer Health Vocabulary — plain-language equivalents of clinical terms (e.g. "myocardial infarction" → "heart attack"). Used by MySPEHR patient portal to render readable explanations.',
    },
    {
      icon: ShieldAlert,
      label: "CDS Overrides · 24h",
      value: m?.cds24h ?? "—",
      cls: "text-orange-700 bg-orange-50 border-orange-200",
      info: "Count of drug-allergy or drug-disease CDS alerts a physician acknowledged and overrode (with logged justification) in the last 24h.",
    },
  ];

  return (
    <div className="rounded-xl border border-slate-200 bg-white shadow-sm p-3">
      <div className="flex items-center gap-2 mb-2">
        <Sparkles className="h-4 w-4 text-[#0c2340]" />
        <h3 className="text-sm font-semibold text-slate-900">
          Terminology Intelligence · AUTO API
        </h3>
        <span className="text-[10px] uppercase tracking-wider text-slate-500">
          Live from UMLS resolver, value-set library & CHV cache
        </span>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-2">
        {items.map(({ icon: Icon, label, value, cls, info }) => (
          <div key={label} className={`rounded-lg border px-3 py-2 ${cls}`}>
            <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider font-semibold opacity-80">
              <Icon className="h-3 w-3" /> {label}
              {info && <InfoHint className="ml-auto" text={info} />}
            </div>
            <div className="text-xl font-bold mt-0.5 tabular-nums">{value}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  NLP Audit Logs → UMLS resolution trail                            */
/* ------------------------------------------------------------------ */

type AuditRow = {
  id: string;
  created_at: string;
  vocabulary: string;
  input_text: string;
  resolved_code: string | null;
  resolved_display: string | null;
  confidence: number | null;
  action: string;
  cache_hit: boolean | null;
  elapsed_ms: number | null;
  mrn: string | null;
};

export function UmlsResolutionTrail() {
  const [rows, setRows] = useState<AuditRow[]>([]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const { data } = await supabase
        .from("terminology_audit")
        .select(
          "id, created_at, vocabulary, input_text, resolved_code, resolved_display, confidence, action, cache_hit, elapsed_ms, mrn",
        )
        .order("created_at", { ascending: false })
        .limit(10);
      if (!cancelled) setRows((data ?? []) as AuditRow[]);
    };
    load();
    const ch = supabase
      .channel("terminology_audit_trail")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "terminology_audit" },
        load,
      )
      .subscribe();
    return () => {
      cancelled = true;
      supabase.removeChannel(ch);
    };
  }, []);

  return (
    <div className="rounded-xl border border-slate-200 bg-white shadow-sm p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-slate-900 flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-[#0c2340]" /> UMLS Resolution Trail
        </h3>
        <span className="text-[10px] uppercase tracking-wider text-slate-500">
          Last 10 · live · written by `terminology-resolver`
        </span>
      </div>
      {rows.length === 0 ? (
        <p className="text-xs text-slate-500 px-1 py-3">
          No resolver activity yet. New orders, conditions, and labs append here
          as the resolver runs.
        </p>
      ) : (
        <div className="divide-y divide-slate-100">
          {rows.map((r) => {
            const ok = r.action === "resolved";
            const tone = ok
              ? "text-emerald-700 bg-emerald-50 border-emerald-200"
              : r.action === "rejected"
                ? "text-rose-700 bg-rose-50 border-rose-200"
                : "text-slate-700 bg-slate-50 border-slate-200";
            return (
              <div key={r.id} className="grid grid-cols-12 gap-2 py-2 text-xs">
                <div className="col-span-2 font-mono text-[10px] text-slate-500">
                  {new Date(r.created_at).toLocaleTimeString("en-GB", { hour12: false })}
                </div>
                <div className="col-span-1">
                  <span className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-bold uppercase ${tone}`}>
                    {r.action}
                  </span>
                </div>
                <div className="col-span-1 font-mono text-[10px] text-slate-600">
                  {r.vocabulary}
                </div>
                <div className="col-span-4 truncate text-slate-800">
                  "{r.input_text}"
                </div>
                <div className="col-span-3 truncate">
                  {r.resolved_code ? (
                    <span className="font-mono text-[10px] text-slate-900">
                      <span className="font-bold">{r.resolved_code}</span>
                      {r.resolved_display ? (
                        <span className="text-slate-500"> · {r.resolved_display}</span>
                      ) : null}
                    </span>
                  ) : (
                    <span className="text-slate-300">—</span>
                  )}
                </div>
                <div className="col-span-1 text-right font-mono text-[10px] text-slate-500">
                  {r.confidence != null ? `${Math.round((r.confidence ?? 0) * 100)}%` : "—"}
                  {r.cache_hit ? " · ⚡" : ""}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Safety Alerts → CDS Overrides feed                                */
/* ------------------------------------------------------------------ */

type CdsRow = {
  id: string;
  created_at: string;
  mrn: string;
  alert_type: string;
  severity: string;
  drug_name: string | null;
  condition_name: string | null;
  reason: string;
  physician_name: string | null;
  physician_id?: string | null;
  drug_rxnorm?: string | null;
  condition_snomed?: string | null;
  fired_at?: string | null;
  decision?: string | null;
  patient_name?: string | null;
  facility_name?: string | null;
  risk_score?: number | null;
};

export function CdsOverridesFeed() {
  const [rows, setRows] = useState<CdsRow[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const { data } = await supabase
        .from("cds_overrides")
        .select(
          "id, created_at, mrn, alert_type, severity, drug_name, condition_name, reason, physician_name, physician_id, drug_rxnorm, condition_snomed, fired_at, decision, patient_name, facility_name, risk_score",
        )
        .order("created_at", { ascending: false })
        .limit(25);
      if (!cancelled) setRows((data ?? []) as CdsRow[]);
    };
    load();
    const ch = supabase
      .channel("cds_overrides_feed")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "cds_overrides" },
        load,
      )
      .subscribe();
    return () => {
      cancelled = true;
      supabase.removeChannel(ch);
    };
  }, []);

  return (
    <div className="rounded-xl border border-slate-200 bg-white shadow-sm p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-slate-900 flex items-center gap-2">
          <ShieldAlert className="h-4 w-4 text-orange-600" /> CDS Hook Decisions · Overrides &amp; Rejections
          <InfoHint
            className="ml-1.5"
            text="Historical record of every Safety Alert decision, manual or SLA auto-resolved, including the computed risk score, the auto-decision threshold, and the full rationale behind each Override or Reject."
          />
        </h3>
        <span className="text-[10px] uppercase tracking-wider text-slate-500">
          Physician decisions on contraindication alerts
        </span>
      </div>
      {rows.length === 0 ? (
        <p className="text-xs text-slate-500 px-1 py-3">
          No CDS overrides recorded yet. When a clinician proceeds past a
          drug↔allergy or drug↔condition warning, the override is logged here.
        </p>
      ) : (
        <div className="divide-y divide-slate-100">
          {rows.map((r) => {
            const isOpen = expandedId === r.id;
            const decisionTone =
              r.decision === "Rejected"
                ? "bg-rose-50 text-rose-700 border-rose-200"
                : r.decision === "Overridden"
                  ? "bg-amber-50 text-amber-700 border-amber-200"
                  : "bg-slate-50 text-slate-600 border-slate-200";
            return (
              <div key={r.id}>
                <button
                  type="button"
                  onClick={() => setExpandedId(isOpen ? null : r.id)}
                  className="w-full grid grid-cols-12 gap-2 py-2 text-xs text-left cursor-pointer hover:bg-slate-50 rounded transition-colors items-center"
                  aria-expanded={isOpen}
                >
                  <div className="col-span-2 font-mono text-[10px] text-slate-500 flex items-center gap-1">
                    <ChevronRight
                      className={`h-3 w-3 text-slate-400 transition-transform ${isOpen ? "rotate-90" : ""}`}
                    />
                    {new Date(r.created_at).toLocaleString("en-GB", { hour12: false })}
                  </div>
                  <div className="col-span-1 font-mono text-[10px] text-slate-700">
                    {r.mrn}
                  </div>
                  <div className="col-span-1 truncate text-[10px] text-slate-800 font-semibold">
                    {r.patient_name ?? "—"}
                  </div>
                  <div className="col-span-2">
                    <span className="inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-bold uppercase bg-orange-50 text-orange-700 border-orange-200">
                      {r.alert_type}
                    </span>
                  </div>
                  <div className="col-span-2">
                    <span
                      className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-bold uppercase ${decisionTone}`}
                    >
                      {r.decision ?? "—"}
                    </span>
                  </div>
                  <div className="col-span-1 truncate text-slate-800">
                    {r.drug_name ?? "—"} {r.condition_name ? `× ${r.condition_name}` : ""}
                  </div>
                  <div className="col-span-2 truncate text-slate-600 italic">
                    "{r.reason}"
                  </div>
                  <div className="col-span-1 text-right text-[10px] text-slate-500 truncate">
                    {r.physician_name ?? "—"}
                  </div>
                </button>
                {isOpen && (
                  <div className="ml-4 mb-3 mt-1 rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs space-y-2">
                    <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
                      <DetailField label="MRN" value={r.mrn} mono />
                      <DetailField label="Patient Name" value={r.patient_name ?? "—"} />
                      <DetailField label="Hospital / Facility" value={r.facility_name ?? "—"} />
                      <DetailField label="Alert Type" value={r.alert_type} />
                      <DetailField label="Severity" value={r.severity} />
                      <DetailField label="Decision" value={r.decision ?? "—"} />
                      <DetailField
                        label="Risk Score"
                        value={r.risk_score != null ? `${r.risk_score}/100 (${r.risk_score >= 70 ? "≥70 → auto-Reject band" : "<70 → auto-Override band"})` : "—"}
                        mono
                      />
                      <DetailField label="Drug" value={r.drug_name ?? "—"} />
                      <DetailField label="Drug RxNorm" value={r.drug_rxnorm ?? "—"} mono />
                      <DetailField label="Condition" value={r.condition_name ?? "—"} />
                      <DetailField
                        label="Condition SNOMED"
                        value={r.condition_snomed ?? "—"}
                        mono
                      />
                      <DetailField label="Physician" value={r.physician_name ?? "—"} />
                      <DetailField
                        label="Physician ID"
                        value={r.physician_id ?? "—"}
                        mono
                      />
                      <DetailField
                        label="Fired At"
                        value={
                          r.fired_at
                            ? new Date(r.fired_at).toLocaleString("en-GB", { hour12: false })
                            : "—"
                        }
                        mono
                      />
                      <DetailField
                        label="Created At"
                        value={new Date(r.created_at).toLocaleString("en-GB", { hour12: false })}
                        mono
                      />
                    </div>
                    <div>
                      <div className="text-[10px] uppercase tracking-wider font-semibold text-slate-500 mb-1">
                        Reason
                      </div>
                      <div className="text-slate-800 whitespace-pre-wrap break-words rounded border border-slate-200 bg-white p-2">
                        {r.reason}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function DetailField({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider font-semibold text-slate-500">
        {label}
      </div>
      <div className={`text-slate-800 break-words ${mono ? "font-mono text-[11px]" : ""}`}>
        {value}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  AUTO API → recent events                                          */
/* ------------------------------------------------------------------ */

type EventRow = {
  id: string;
  created_at: string;
  event_type: string;
  mrn: string | null;
  actor: string | null;
  facility_name: string | null;
};

export function AutoApiEventsFeed() {
  const [rows, setRows] = useState<EventRow[]>([]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const { data } = await supabase
        .from("auto_api_events")
        .select("id, created_at, event_type, mrn, actor, facility_name")
        .order("created_at", { ascending: false })
        .limit(15);
      if (!cancelled) setRows((data ?? []) as EventRow[]);
    };
    load();
    const ch = supabase
      .channel("auto_api_events_feed")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "auto_api_events" },
        load,
      )
      .subscribe();
    return () => {
      cancelled = true;
      supabase.removeChannel(ch);
    };
  }, []);

  return (
    <div className="rounded-xl border border-slate-200 bg-white shadow-sm p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-slate-900 flex items-center gap-2">
          <Activity className="h-4 w-4 text-[#0c2340]" /> AUTO API · Event Stream
        </h3>
        <span className="text-[10px] uppercase tracking-wider text-slate-500">
          Last 15 · live · cross-loop telemetry
        </span>
      </div>
      {rows.length === 0 ? (
        <p className="text-xs text-slate-500 px-1 py-3">No AUTO API events yet.</p>
      ) : (
        <div className="divide-y divide-slate-100">
          {rows.map((r) => (
            <div key={r.id} className="grid grid-cols-12 gap-2 py-2 text-xs">
              <div className="col-span-2 font-mono text-[10px] text-slate-500">
                {new Date(r.created_at).toLocaleTimeString("en-GB", { hour12: false })}
              </div>
              <div className="col-span-4">
                <span className="inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-bold uppercase bg-slate-50 text-slate-700 border-slate-200 font-mono">
                  {r.event_type}
                </span>
              </div>
              <div className="col-span-2 font-mono text-[10px] text-slate-600">
                {r.actor ?? "—"}
              </div>
              <div className="col-span-2 font-mono text-[10px] text-slate-600">
                {r.mrn ?? "—"}
              </div>
              <div className="col-span-2 truncate text-[10px] text-slate-500">
                {r.facility_name ?? "—"}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}