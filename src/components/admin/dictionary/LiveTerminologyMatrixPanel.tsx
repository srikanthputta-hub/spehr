import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Activity, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type Row = {
  mrn: string;
  system: "SNOMED" | "ICD-10" | "CPT" | "LOINC" | "RxNorm";
  code: string;
  display: string;
  source: string;
  at: string;
};

const SYSTEM_COLOR: Record<Row["system"], string> = {
  "SNOMED":  "border-sky-200 bg-sky-50 text-sky-700",
  "ICD-10":  "border-violet-200 bg-violet-50 text-violet-700",
  "CPT":     "border-fuchsia-200 bg-fuchsia-50 text-fuchsia-700",
  "LOINC":   "border-emerald-200 bg-emerald-50 text-emerald-700",
  "RxNorm":  "border-orange-200 bg-orange-50 text-orange-700",
};

async function loadRows(): Promise<Row[]> {
  const rows: Row[] = [];

  const [conds, meds, labOrders, labResults, vitals, procedures] = await Promise.all([
    supabase.from("conditions").select("mrn, icd10_code, snomed_code, display_text, source_section, updated_at").order("updated_at", { ascending: false }).limit(400),
    supabase.from("medication_orders").select("patient_mrn, rxnorm_code, drug_name, updated_at").order("updated_at", { ascending: false }).limit(400),
    supabase.from("lab_orders").select("patient_mrn, loinc_code, test_type, updated_at").order("updated_at", { ascending: false }).limit(200),
    supabase.from("lab_results" as any).select("patient_mrn, loinc_code, loinc_display, test_name, updated_at").order("updated_at", { ascending: false }).limit(400).then(r => r, () => ({ data: [] as any[] })),
    supabase.from("vitals" as any).select("patient_mrn, loinc_map, updated_at").order("updated_at", { ascending: false }).limit(200).then(r => r, () => ({ data: [] as any[] })),
    supabase.from("procedures" as any).select("patient_mrn, cpt_code, display, updated_at").order("updated_at", { ascending: false }).limit(200).then(r => r, () => ({ data: [] as any[] })),
  ]);

  for (const c of (conds.data ?? []) as any[]) {
    if (c.snomed_code) rows.push({ mrn: c.mrn, system: "SNOMED", code: String(c.snomed_code), display: c.display_text ?? "", source: c.source_section ?? "condition", at: c.updated_at });
    if (c.icd10_code) rows.push({ mrn: c.mrn, system: "ICD-10", code: String(c.icd10_code), display: c.display_text ?? "", source: c.source_section ?? "condition", at: c.updated_at });
  }
  for (const m of (meds.data ?? []) as any[]) {
    if (m.rxnorm_code) rows.push({ mrn: m.patient_mrn, system: "RxNorm", code: String(m.rxnorm_code), display: m.drug_name ?? "", source: "medication", at: m.updated_at });
  }
  for (const l of (labOrders.data ?? []) as any[]) {
    if (l.loinc_code) rows.push({ mrn: l.patient_mrn, system: "LOINC", code: String(l.loinc_code), display: l.test_type ?? "", source: "lab_order", at: l.updated_at });
  }
  for (const l of ((labResults as any).data ?? []) as any[]) {
    if (l.loinc_code) rows.push({ mrn: l.patient_mrn, system: "LOINC", code: String(l.loinc_code), display: l.loinc_display ?? l.test_name ?? "", source: "lab_result", at: l.updated_at });
  }
  for (const v of ((vitals as any).data ?? []) as any[]) {
    const map = v.loinc_map && typeof v.loinc_map === "object" ? v.loinc_map : {};
    for (const [field, code] of Object.entries(map)) {
      if (code) rows.push({ mrn: v.patient_mrn, system: "LOINC", code: String(code), display: field, source: "vitals", at: v.updated_at });
    }
  }
  for (const p of ((procedures as any).data ?? []) as any[]) {
    if (p.cpt_code) rows.push({ mrn: p.patient_mrn, system: "CPT", code: String(p.cpt_code), display: p.display ?? "", source: "procedure", at: p.updated_at });
  }

  return rows.sort((a, b) => (b.at ?? "").localeCompare(a.at ?? ""));
}

export default function LiveTerminologyMatrixPanel() {
  const [rows, setRows] = useState<Row[]>([]);
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(true);

  const refresh = async () => {
    setLoading(true);
    setRows(await loadRows());
    setLoading(false);
  };

  useEffect(() => {
    refresh();
    // Admin dictionary tooling, not patient-safety-critical. Loosened
    // 15s -> 30s to cut Supabase egress (Free-plan bandwidth quota mitigation).
    const id = setInterval(refresh, 30_000);
    return () => clearInterval(id);
  }, []);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return rows.slice(0, 400);
    return rows.filter((r) =>
      r.mrn.toLowerCase().includes(needle) ||
      r.code.toLowerCase().includes(needle) ||
      r.display.toLowerCase().includes(needle) ||
      r.system.toLowerCase().includes(needle) ||
      r.source.toLowerCase().includes(needle)
    ).slice(0, 400);
  }, [rows, q]);

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const r of rows) c[r.system] = (c[r.system] ?? 0) + 1;
    return c;
  }, [rows]);

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-slate-900 flex items-center gap-2">
            <Activity className="h-4 w-4 text-indigo-600" /> Live Terminology Matrix
          </h2>
          <p className="text-sm text-slate-600 mt-1 max-w-3xl">
            Real-time view of every SNOMED · ICD-10 · CPT · LOINC · RxNorm code
            currently bound to patient data across S.P.E.H.R. Refreshes every 15s.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={refresh}>
          <RefreshCw className="h-4 w-4" /> Refresh
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {(["SNOMED","ICD-10","CPT","LOINC","RxNorm"] as const).map((s) => (
          <span key={s} className={`inline-flex items-center gap-1 rounded border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${SYSTEM_COLOR[s]}`}>
            {s} · {counts[s] ?? 0}
          </span>
        ))}
      </div>

      <Input
        placeholder="Filter by MRN, code, display, system, source…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        className="max-w-md"
      />

      <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
        <div className="scroll-feed">
          <table className="w-full text-xs">
            <thead className="bg-slate-50 border-b border-slate-200 sticky top-0">
              <tr className="text-left text-[10px] uppercase tracking-wider text-slate-500">
                <th className="px-3 py-2">MRN</th>
                <th className="px-3 py-2">System</th>
                <th className="px-3 py-2">Code</th>
                <th className="px-3 py-2">Display</th>
                <th className="px-3 py-2">Source</th>
                <th className="px-3 py-2">Updated</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={6} className="px-3 py-6 text-center text-slate-500">Loading…</td></tr>
              ) : filtered.length === 0 ? (
                <tr><td colSpan={6} className="px-3 py-6 text-center text-slate-500">No coded rows yet.</td></tr>
              ) : filtered.map((r, i) => (
                <tr key={i} className="border-b border-slate-100 hover:bg-slate-50">
                  <td className="px-3 py-2 font-mono text-[11px] text-slate-700">{r.mrn}</td>
                  <td className="px-3 py-2">
                    <span className={`inline-flex items-center rounded border px-1.5 py-0.5 font-mono text-[10px] font-bold ${SYSTEM_COLOR[r.system]}`}>{r.system}</span>
                  </td>
                  <td className="px-3 py-2 font-mono text-[11px] text-slate-900">{r.code}</td>
                  <td className="px-3 py-2 text-slate-700 truncate max-w-xs">{r.display}</td>
                  <td className="px-3 py-2 text-[10px] uppercase tracking-wider text-slate-500">{r.source}</td>
                  <td className="px-3 py-2 text-[10px] text-slate-500">{r.at ? new Date(r.at).toLocaleTimeString() : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}