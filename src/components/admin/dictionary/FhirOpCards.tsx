import { useEffect, useState } from "react";
import { Loader2, Play, Download, Copy, Check } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";

const CODE_SYSTEMS = [
  { label: "SNOMED CT", uri: "http://snomed.info/sct" },
  { label: "ICD-10-CM", uri: "http://hl7.org/fhir/sid/icd-10-cm" },
  { label: "LOINC", uri: "http://loinc.org" },
  { label: "RxNorm", uri: "http://www.nlm.nih.gov/research/umls/rxnorm" },
];

const SAB_MAP: Record<string, string> = {
  "SNOMED CT": "SNOMEDCT_US",
  "ICD-10-CM": "ICD10CM",
  LOINC: "LNC",
  RxNorm: "RXNORM",
  CPT: "CPT",
};
const toSab = (label: string) => SAB_MAP[label] ?? label;

function ResponseBox({ data, latencyMs }: { data: any; latencyMs?: number | null }) {
  const [copied, setCopied] = useState(false);
  if (!data) return null;
  const json = JSON.stringify(data, null, 2);
  const copy = async () => {
    await navigator.clipboard.writeText(json);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="mt-3 space-y-1">
      <div className="flex items-center justify-between">
        <span className="text-[10px] text-slate-500">
          {latencyMs != null
            ? `Response in ${latencyMs}ms · Powered by UMLS API`
            : "Powered by UMLS API"}
        </span>
        <button
          type="button"
          onClick={copy}
          className="inline-flex items-center gap-1 rounded border border-slate-300 bg-white px-1.5 py-0.5 text-[10px] hover:bg-slate-50"
        >
          {copied ? <Check className="h-3 w-3 text-emerald-600" /> : <Copy className="h-3 w-3" />}
          {copied ? "Copied!" : "Copy JSON"}
        </button>
      </div>
      <pre className="rounded border border-slate-200 bg-slate-900 text-emerald-300 p-3 text-[10px] overflow-x-auto max-h-72">
        {json}
      </pre>
    </div>
  );
}

const NEG_RESULT = {
  resourceType: "Parameters",
  parameter: [{ name: "result", valueBoolean: false }],
};

export function LookupCard() {
  const [sys, setSys] = useState(CODE_SYSTEMS[0]);
  const [code, setCode] = useState("22298006");
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<any>(null);
  const [latency, setLatency] = useState<number | null>(null);

  const run = async () => {
    setLoading(true);
    const t0 = performance.now();
    try {
      console.log("[$lookup] firing, code:", code, "system:", sys.label, "sab:", toSab(sys.label));
      const { data, error } = await supabase.functions.invoke("umls-proxy", {
        body: { action: "validate", params: { code, sab: toSab(sys.label) } },
      });
      console.log("[$lookup] proxy returned:", JSON.stringify(data), "error:", error);
      if (error) throw error;
      const r = data?.result;
      if (r && r.name) {
        setData({
          resourceType: "Parameters",
          parameter: [
            { name: "result", valueBoolean: true },
            { name: "display", valueString: r.name },
            { name: "active", valueBoolean: r.status === "active" },
            { name: "property", part: [{ name: "code", valueCode: code }] },
          ],
        });
      } else {
        setData(NEG_RESULT);
      }
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setLatency(Math.round(performance.now() - t0));
      setLoading(false);
    }
  };

  return (
    <div className="rounded-md border border-slate-200 bg-white p-4 space-y-2">
      <h4 className="text-sm font-semibold">CodeSystem/$lookup</h4>
      <p className="text-[11px] text-slate-500">
        Retrieve details about a specific code in a code system.
      </p>
      <div>
        <div className="text-[10px] uppercase font-semibold text-slate-500 mt-2 mb-1">
          Code System
        </div>
        <Select
          value={sys.label}
          onValueChange={(v) => setSys(CODE_SYSTEMS.find((x) => x.label === v)!)}
        >
          <SelectTrigger className="h-8 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {CODE_SYSTEMS.map((c) => (
              <SelectItem key={c.label} value={c.label}>
                {c.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div>
        <div className="text-[10px] uppercase font-semibold text-slate-500 mt-2 mb-1">Code</div>
        <Input
          value={code}
          onChange={(e) => setCode(e.target.value)}
          className="h-8 text-xs font-mono"
        />
      </div>
      <Button
        size="sm"
        className="w-full bg-[#0c2340] hover:bg-[#0c2340]/90 mt-2"
        onClick={run}
        disabled={loading}
      >
        {loading ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Play className="h-3.5 w-3.5" />
        )}{" "}
        Execute $lookup
      </Button>
      <ResponseBox data={data} latencyMs={latency} />
    </div>
  );
}

export function ExpandCard() {
  const [valueSets, setValueSets] = useState<string[]>([]);
  const [vs, setVs] = useState<string>("");
  const [filter, setFilter] = useState("");
  const [count, setCount] = useState(20);
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<any>(null);
  const [latency, setLatency] = useState<number | null>(null);

  useEffect(() => {
    supabase
      .from("custom_value_sets")
      .select("name")
      .order("name")
      .then(({ data }) => {
        const names = (data ?? []).map((r: any) => r.name);
        setValueSets(names);
        if (names.length && !vs) setVs(names[0]);
      });
  }, []);

  const run = async () => {
    setLoading(true);
    const t0 = performance.now();
    try {
      const { data: row, error } = await supabase
        .from("custom_value_sets")
        .select("codes, status, name")
        .eq("name", vs)
        .maybeSingle();
      if (error) throw error;
      let codes: any[] = Array.isArray((row as any)?.codes) ? (row as any).codes : [];
      if (filter) {
        const f = filter.toLowerCase();
        codes = codes.filter(
          (c) =>
            String(c.code ?? "")
              .toLowerCase()
              .includes(f) ||
            String(c.display ?? "")
              .toLowerCase()
              .includes(f),
        );
      }
      codes = codes.slice(0, count);
      const sysFor = (v: string) =>
        v === "ICD-10-CM"
          ? "http://hl7.org/fhir/sid/icd-10-cm"
          : v === "SNOMED CT"
            ? "http://snomed.info/sct"
            : v === "LOINC"
              ? "http://loinc.org"
              : v === "RxNorm"
                ? "http://www.nlm.nih.gov/research/umls/rxnorm"
                : v === "CPT"
                  ? "http://www.ama-assn.org/go/cpt"
                  : "unknown";
      setData({
        resourceType: "ValueSet",
        status: (row as any)?.status ?? "unknown",
        expansion: {
          timestamp: new Date().toISOString(),
          total: codes.length,
          contains: codes.map((c: any) => ({
            system: sysFor(c.vocabulary),
            code: c.code,
            display: c.display,
          })),
        },
      });
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setLatency(Math.round(performance.now() - t0));
      setLoading(false);
    }
  };

  const exportCsv = () => {
    const rows = data?.expansion?.contains ?? [];
    const csv = [
      "code,display,system",
      ...rows.map((r: any) => `${r.code},"${r.display}",${r.system}`),
    ].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${vs}-expansion.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="rounded-md border border-slate-200 bg-white p-4 space-y-2">
      <h4 className="text-sm font-semibold">ValueSet/$expand</h4>
      <p className="text-[11px] text-slate-500">
        Expand a value set to get the explicit list of codes.
      </p>
      <div>
        <div className="text-[10px] uppercase font-semibold text-slate-500 mt-2 mb-1">
          Value Set
        </div>
        <Select value={vs} onValueChange={setVs}>
          <SelectTrigger className="h-8 text-xs">
            <SelectValue placeholder="Choose…" />
          </SelectTrigger>
          <SelectContent>
            {valueSets.map((n) => (
              <SelectItem key={n} value={n}>
                {n}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div>
        <div className="text-[10px] uppercase font-semibold text-slate-500 mt-2 mb-1">
          Filter (optional)
        </div>
        <Input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="h-8 text-xs"
          placeholder="optional filter text"
        />
      </div>
      <div>
        <div className="text-[10px] uppercase font-semibold text-slate-500 mt-2 mb-1">Count</div>
        <Input
          type="number"
          value={count}
          onChange={(e) => setCount(Number(e.target.value))}
          className="h-8 text-xs w-24"
        />
      </div>
      <Button
        size="sm"
        className="w-full bg-[#0c2340] hover:bg-[#0c2340]/90 mt-2"
        onClick={run}
        disabled={loading || !vs}
      >
        {loading ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Play className="h-3.5 w-3.5" />
        )}{" "}
        Execute $expand
      </Button>
      {data?.expansion && (
        <div className="rounded border border-emerald-200 bg-emerald-50 px-3 py-2 text-[11px] mt-2 flex items-center justify-between">
          <span>
            Returned <strong>{data.expansion.total}</strong> concepts
          </span>
          <Button size="sm" variant="outline" onClick={exportCsv}>
            <Download className="h-3 w-3" /> CSV
          </Button>
        </div>
      )}
      <ResponseBox data={data} latencyMs={latency} />
    </div>
  );
}

export function TranslateCard() {
  const [src, setSrc] = useState(CODE_SYSTEMS[0]);
  const [tgt, setTgt] = useState(CODE_SYSTEMS[1]);
  const [code, setCode] = useState("422504002");
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<any>(null);
  const [latency, setLatency] = useState<number | null>(null);

  const run = async () => {
    setLoading(true);
    const t0 = performance.now();
    try {
      const { data, error } = await supabase.functions.invoke("umls-proxy", {
        body: {
          action: "crosswalk",
          params: { fromSab: toSab(src.label), fromCode: code, toSab: toSab(tgt.label) },
        },
      });
      if (error) throw error;
      const first = data?.result ?? (Array.isArray(data?.matches) ? data.matches[0] : null);
      if (first) {
        setData({
          resourceType: "Parameters",
          parameter: [
            { name: "result", valueBoolean: true },
            {
              name: "match",
              part: [
                { name: "equivalence", valueCode: "equivalent" },
                {
                  name: "concept",
                  valueCoding: { system: tgt.uri, code: first.code, display: first.name },
                },
              ],
            },
          ],
        });
      } else {
        setData(NEG_RESULT);
      }
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setLatency(Math.round(performance.now() - t0));
      setLoading(false);
    }
  };

  return (
    <div className="rounded-md border border-slate-200 bg-white p-4 space-y-2">
      <h4 className="text-sm font-semibold">ConceptMap/$translate</h4>
      <p className="text-[11px] text-slate-500">Translate a code from one system to another.</p>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <div className="text-[10px] uppercase font-semibold text-slate-500 mt-2 mb-1">
            Source System
          </div>
          <Select
            value={src.label}
            onValueChange={(v) => setSrc(CODE_SYSTEMS.find((x) => x.label === v)!)}
          >
            <SelectTrigger className="h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CODE_SYSTEMS.map((c) => (
                <SelectItem key={c.label} value={c.label}>
                  {c.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <div className="text-[10px] uppercase font-semibold text-slate-500 mt-2 mb-1">
            Source Code
          </div>
          <Input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            className="h-8 text-xs font-mono"
          />
        </div>
      </div>
      <div>
        <div className="text-[10px] uppercase font-semibold text-slate-500 mt-2 mb-1">
          Target System
        </div>
        <Select
          value={tgt.label}
          onValueChange={(v) => setTgt(CODE_SYSTEMS.find((x) => x.label === v)!)}
        >
          <SelectTrigger className="h-8 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {CODE_SYSTEMS.map((c) => (
              <SelectItem key={c.label} value={c.label}>
                {c.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <Button
        size="sm"
        className="w-full bg-[#0c2340] hover:bg-[#0c2340]/90 mt-2"
        onClick={run}
        disabled={loading}
      >
        {loading ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Play className="h-3.5 w-3.5" />
        )}{" "}
        Execute $translate
      </Button>
      <ResponseBox data={data} latencyMs={latency} />
    </div>
  );
}
