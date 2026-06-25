import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Loader2, Download, Activity } from "lucide-react";
import { runPopulationQuery } from "@/lib/auto-api.functions";

const FACILITIES = [
  "Memorial Hospital",
  "St. Jude Medical Center",
  "City General Infirmary",
  "County Health Pavilion",
  "Srik Health Clinic",
];

const WINDOWS = [
  { label: "Last 24h", hours: 24 },
  { label: "Last 7d", hours: 24 * 7 },
  { label: "Last 30d", hours: 24 * 30 },
  { label: "All time", hours: 0 },
];

export function PopulationHealth() {
  const run = useServerFn(runPopulationQuery);
  const [condition, setCondition] = useState("");
  const [loinc, setLoinc] = useState("");
  const [facilities, setFacilities] = useState<string[]>([]);
  const [windowHours, setWindowHours] = useState(24 * 7);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<any>(null);

  const toggleFac = (f: string) =>
    setFacilities((p) => (p.includes(f) ? p.filter((x) => x !== f) : [...p, f]));

  const submit = async () => {
    setLoading(true);
    try {
      const since = windowHours > 0 ? new Date(Date.now() - windowHours * 3600_000).toISOString() : undefined;
      const r = await run({
        data: {
          condition_keyword: condition.trim() || undefined,
          loinc_keyword: loinc.trim() || undefined,
          facilities: facilities.length > 0 ? facilities : undefined,
          since_iso: since,
        },
      });
      setResult(r);
    } finally {
      setLoading(false);
    }
  };

  const exportCsv = () => {
    if (!result?.rows) return;
    const headers = ["mrn", "name", "age", "gender", "facility_name", "chief_complaint", "admission_time"];
    const rows = [headers.join(",")];
    for (const r of result.rows) {
      rows.push(headers.map((h) => JSON.stringify(r[h] ?? "")).join(","));
    }
    const blob = new Blob([rows.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `population-cohort-${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="rounded-lg border border-slate-200 bg-white shadow-sm">
      <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3">
        <div className="flex items-center gap-2">
          <Activity className="h-4 w-4 text-[#0c2340]" />
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-500">
              AUTO API · Population Health
            </div>
            <div className="text-sm font-semibold text-slate-900">
              Cohort Query (SNOMED / LOINC + Facility filter)
            </div>
          </div>
        </div>
      </div>
      <div className="p-5 space-y-3">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <label className="text-[11px]">
            <span className="font-semibold uppercase tracking-wider text-slate-500">Condition keyword (SNOMED)</span>
            <input
              value={condition}
              onChange={(e) => setCondition(e.target.value)}
              placeholder="e.g. pneumonia, sepsis"
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm"
            />
          </label>
          <label className="text-[11px]">
            <span className="font-semibold uppercase tracking-wider text-slate-500">Lab keyword (LOINC)</span>
            <input
              value={loinc}
              onChange={(e) => setLoinc(e.target.value)}
              placeholder="e.g. lactate, troponin"
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm"
            />
          </label>
        </div>
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 mb-1">Facilities</div>
          <div className="flex flex-wrap gap-2">
            {FACILITIES.map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => toggleFac(f)}
                className={`text-[11px] px-2 py-1 rounded border ${facilities.includes(f) ? "bg-[#0c2340] text-white border-[#0c2340]" : "bg-white text-slate-700 border-slate-300"}`}
              >
                {f}
              </button>
            ))}
          </div>
        </div>
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 mb-1">Time window</div>
          <div className="flex gap-2">
            {WINDOWS.map((w) => (
              <button
                key={w.label}
                type="button"
                onClick={() => setWindowHours(w.hours)}
                className={`text-[11px] px-2 py-1 rounded border ${windowHours === w.hours ? "bg-emerald-600 text-white border-emerald-600" : "bg-white text-slate-700 border-slate-300"}`}
              >
                {w.label}
              </button>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={loading}
            onClick={submit}
            className="inline-flex items-center gap-2 rounded-md bg-[#0c2340] px-4 py-2 text-sm text-white disabled:opacity-60"
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Activity className="h-4 w-4" />}
            Run Cohort Query
          </button>
          {result && (
            <button
              type="button"
              onClick={exportCsv}
              className="inline-flex items-center gap-2 rounded-md border border-slate-300 px-4 py-2 text-sm"
            >
              <Download className="h-4 w-4" /> Export CSV
            </button>
          )}
        </div>

        {result && (
          <div className="border-t border-slate-100 pt-3 space-y-2">
            <div className="flex gap-6 text-[12px]">
              <div><span className="text-slate-500">Cohort size:</span> <span className="font-mono font-bold text-slate-900">{result.total}</span></div>
              <div><span className="text-slate-500">Avg age:</span> <span className="font-mono">{result.avg_age}</span></div>
              <div><span className="text-slate-500">Gender:</span>{" "}
                {Object.entries(result.gender_distribution as Record<string, number>).map(([g, n]) => (
                  <span key={g} className="font-mono mr-2">{g}={n}</span>
                ))}
              </div>
            </div>
            <div className="max-h-96 overflow-auto border border-slate-200 rounded">
              <table className="w-full text-[11px]">
                <thead className="bg-slate-50 sticky top-0">
                  <tr>
                    <th className="text-left px-2 py-1.5">MRN</th>
                    <th className="text-left px-2 py-1.5">Name</th>
                    <th className="text-left px-2 py-1.5">Age</th>
                    <th className="text-left px-2 py-1.5">Facility</th>
                    <th className="text-left px-2 py-1.5">Chief Complaint</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {(result.rows ?? []).map((r: any) => (
                    <tr key={r.mrn}>
                      <td className="px-2 py-1 font-mono">{r.mrn}</td>
                      <td className="px-2 py-1">{r.name}</td>
                      <td className="px-2 py-1">{r.age ?? "—"}</td>
                      <td className="px-2 py-1">{r.facility_name}</td>
                      <td className="px-2 py-1">{r.chief_complaint ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}