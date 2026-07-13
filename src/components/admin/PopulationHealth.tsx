import { useEffect, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Loader2, Download, Activity } from "lucide-react";
import { runPopulationQuery, getCodedKeywordSuggestions } from "@/lib/auto-api.functions";
import { supabase } from "@/integrations/supabase/client";
import { InfoHint } from "@/components/ui/info-hint";

const FACILITIES = [
  "Memorial Hospital",
  "St. Jude Medical Center",
  "City General Infirmary",
  "County Health Pavilion",
  "Srik Health Clinic",
];

const WINDOWS = [
  { label: "Last 6h", hours: 6 },
  { label: "Last 12h", hours: 12 },
  { label: "Last 24h", hours: 24 },
];

type CodeSystem = "SNOMED" | "ICD10" | "LOINC" | "RXNORM";
const CODE_SYSTEMS: Array<{ value: CodeSystem; label: string }> = [
  { value: "SNOMED", label: "SNOMED CT" },
  { value: "ICD10", label: "ICD-10" },
  { value: "LOINC", label: "LOINC" },
  { value: "RXNORM", label: "RxNorm" },
];

export function PopulationHealth() {
  const run = useServerFn(runPopulationQuery);
  const suggest = useServerFn(getCodedKeywordSuggestions);
  const [codeSystem, setCodeSystem] = useState<CodeSystem>("SNOMED");
  const [keyword, setKeyword] = useState("");
  const [suggestions, setSuggestions] = useState<Array<{ code: string; display: string; count: number }>>([]);
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [suggestLoading, setSuggestLoading] = useState(false);
  const suggestTimer = useRef<number | null>(null);
  const suggestReq = useRef(0);
  const [facilities, setFacilities] = useState<string[]>([]);
  const [windowHours, setWindowHours] = useState(24 * 7);
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [valueSetId, setValueSetId] = useState<string>("");
  const [valueSets, setValueSets] = useState<Array<{ id: string; name: string; codes_count: number }>>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from("custom_value_sets")
        .select("id, name, codes")
        .eq("status", "published")
        .order("name", { ascending: true });
      if (cancelled || !data) return;
      setValueSets(
        (data as any[]).map((v) => ({
          id: v.id,
          name: v.name,
          codes_count: Array.isArray(v.codes) ? v.codes.length : 0,
        })),
      );
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (suggestTimer.current) window.clearTimeout(suggestTimer.current);
    const term = keyword.trim();
    if (term.length < 2) {
      setSuggestions([]);
      setSuggestOpen(false);
      return;
    }
    suggestTimer.current = window.setTimeout(async () => {
      const id = ++suggestReq.current;
      setSuggestLoading(true);
      try {
        const r = await suggest({ data: { system: codeSystem, query: term } });
        if (id !== suggestReq.current) return;
        setSuggestions(r.items);
        setSuggestOpen(true);
      } finally {
        if (id === suggestReq.current) setSuggestLoading(false);
      }
    }, 250);
    return () => {
      if (suggestTimer.current) window.clearTimeout(suggestTimer.current);
    };
  }, [keyword, codeSystem, suggest]);

  const toggleFac = (f: string) =>
    setFacilities((p) => (p.includes(f) ? p.filter((x) => x !== f) : [...p, f]));

  const submit = async () => {
    setLoading(true);
    try {
      const useRange = Boolean(fromDate || toDate);
      const since = useRange
        ? (fromDate ? new Date(fromDate + "T00:00:00.000Z").toISOString() : undefined)
        : (windowHours > 0 ? new Date(Date.now() - windowHours * 3600_000).toISOString() : undefined);
      const until = useRange && toDate
        ? new Date(toDate + "T23:59:59.999Z").toISOString()
        : undefined;
      const r = await run({
        data: {
          code_system: keyword.trim() ? codeSystem : undefined,
          keyword: keyword.trim() || undefined,
          facilities: facilities.length > 0 ? facilities : undefined,
          since_iso: since,
          until_iso: until,
          value_set_id: valueSetId || undefined,
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
              AUTO ADMIN · Population Health
            </div>
            <div className="text-sm font-semibold text-slate-900 inline-flex items-center gap-1">
              Cohort Query (Multi-Terminology + Facility Filter)
              <InfoHint text="Choose a code system (SNOMED CT for conditions, ICD-10 for billing diagnoses, LOINC for lab tests, or RxNorm for medications), then type a keyword — the field autosuggests real coded terms actually present in the database for that system, each with its code and patient count. Alternatively, filter by a published value set instead of a single code. Results are scoped to the selected facilities and time window (as fine as the last 6 hours, since this environment's clinical data only spans about 36 hours)." />
            </div>
          </div>
        </div>
      </div>
      <div className="p-5 space-y-3">
        <div className="grid grid-cols-1 md:grid-cols-[160px_1fr] gap-3">
          <label className="text-[11px]">
            <span className="font-semibold uppercase tracking-wider text-slate-500">Code System</span>
            <select
              value={codeSystem}
              onChange={(e) => {
                setCodeSystem(e.target.value as CodeSystem);
                setSuggestions([]);
                setSuggestOpen(false);
              }}
              className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm"
            >
              {CODE_SYSTEMS.map((s) => (
                <option key={s.value} value={s.value}>{s.label}</option>
              ))}
            </select>
          </label>
          <label className="text-[11px] relative">
            <span className="font-semibold uppercase tracking-wider text-slate-500 inline-flex items-center gap-1">
              Keyword
              <InfoHint text="Type to see live coded terms actually present in the database for the selected system. Each suggestion shows its code and the number of records using it. Click one to fill the field with the exact display text." />
            </span>
            <div className="relative">
              <input
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
                onFocus={() => suggestions.length > 0 && setSuggestOpen(true)}
                onBlur={() => setTimeout(() => setSuggestOpen(false), 150)}
                placeholder={
                  codeSystem === "SNOMED" ? "e.g. chest pain, sepsis"
                  : codeSystem === "ICD10" ? "e.g. pneumonia"
                  : codeSystem === "LOINC" ? "e.g. lactate, troponin"
                  : "e.g. aspirin, metformin"
                }
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm"
              />
              {suggestLoading && (
                <Loader2 className="absolute right-2 top-3 h-4 w-4 animate-spin text-slate-400" />
              )}
              {suggestOpen && suggestions.length > 0 && (
                <div className="absolute z-30 mt-1 w-full max-h-64 overflow-auto rounded-md border border-slate-200 bg-white shadow-lg">
                  {suggestions.map((s) => (
                    <button
                      key={s.code + s.display}
                      type="button"
                      onMouseDown={(e) => {
                        e.preventDefault();
                        setKeyword(s.display);
                        setSuggestOpen(false);
                      }}
                      className="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-[12px] hover:bg-slate-50 border-b border-slate-100 last:border-0"
                    >
                      <span className="truncate">
                        <span className="font-mono text-slate-500">{s.code}</span>
                        <span className="mx-1 text-slate-400">·</span>
                        <span className="text-slate-900">{s.display}</span>
                      </span>
                      <span className="font-mono text-[11px] text-slate-500 flex-shrink-0">
                        ({s.count.toLocaleString()})
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </label>
        </div>
        <label className="text-[11px] block">
          <span className="font-semibold uppercase tracking-wider text-slate-500">
            Filter by published value set
          </span>
          <select
            value={valueSetId}
            onChange={(e) => setValueSetId(e.target.value)}
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm bg-white"
          >
            <option value="">None — use keyword search</option>
            {valueSets.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name} ({v.codes_count} codes)
              </option>
            ))}
          </select>
        </label>
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
          <div className="flex flex-wrap items-center gap-2">
            {WINDOWS.map((w) => (
              <button
                key={w.label}
                type="button"
                onClick={() => {
                  setWindowHours(w.hours);
                  setFromDate("");
                  setToDate("");
                }}
                className={`text-[11px] px-2 py-1 rounded border ${!fromDate && !toDate && windowHours === w.hours ? "bg-emerald-600 text-white border-emerald-600" : "bg-white text-slate-700 border-slate-300"}`}
              >
                {w.label}
              </button>
            ))}
            <span className="mx-1 text-[11px] text-slate-400">or</span>
            <label className="inline-flex items-center gap-1 text-[11px] text-slate-600">
              From
              <input
                type="date"
                value={fromDate}
                onChange={(e) => setFromDate(e.target.value)}
                className="rounded border border-slate-300 px-2 py-1 text-[11px]"
              />
            </label>
            <label className="inline-flex items-center gap-1 text-[11px] text-slate-600">
              To
              <input
                type="date"
                value={toDate}
                onChange={(e) => setToDate(e.target.value)}
                className="rounded border border-slate-300 px-2 py-1 text-[11px]"
              />
            </label>
            {(fromDate || toDate) && (
              <button
                type="button"
                onClick={() => { setFromDate(""); setToDate(""); }}
                className="text-[11px] px-2 py-1 rounded border border-slate-300 bg-white text-slate-600"
              >
                Clear
              </button>
            )}
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
            {(result.top_loinc?.length > 0 || result.top_snomed?.length > 0) && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {result.top_loinc?.length > 0 && (
                  <div className="rounded-md border border-slate-200 bg-slate-50/60 p-2">
                    <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500 mb-1">
                      Top LOINC matches
                    </div>
                    <ul className="text-[11px] space-y-0.5">
                      {result.top_loinc.map((x: any) => (
                        <li key={x.label} className="flex justify-between gap-2">
                          <span className="truncate">{x.label}</span>
                          <span className="font-mono text-slate-500">{x.count}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {result.top_snomed?.length > 0 && (
                  <div className="rounded-md border border-slate-200 bg-slate-50/60 p-2">
                    <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500 mb-1">
                      Top SNOMED / ICD-10 matches
                    </div>
                    <ul className="text-[11px] space-y-0.5">
                      {result.top_snomed.map((x: any) => (
                        <li key={x.label} className="flex justify-between gap-2">
                          <span className="truncate">{x.label}</span>
                          <span className="font-mono text-slate-500">{x.count}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
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