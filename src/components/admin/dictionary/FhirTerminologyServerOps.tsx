import { useEffect, useState } from "react";
import { Loader2, Play, Download } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";

const CODE_SYSTEMS = [
  { label: "SNOMED CT", uri: "http://snomed.info/sct" },
  { label: "ICD-10-CM", uri: "http://hl7.org/fhir/sid/icd-10-cm" },
  { label: "LOINC", uri: "http://loinc.org" },
  { label: "RxNorm", uri: "http://www.nlm.nih.gov/research/umls/rxnorm" },
];

export function FhirTerminologyServerOps() {
  return (
    <div className="space-y-4">
      <div className="rounded-md border border-emerald-200 bg-emerald-50/60 p-5">
        <h3 className="text-lg font-semibold text-slate-900 flex items-center gap-2">
          ⚡ FHIR R4 Terminology Server Operations
        </h3>
        <p className="text-xs text-slate-600 mt-1">
          S.P.E.H.R. exposes a FHIR-compliant terminology server backed by live UMLS data.
        </p>
        <p className="text-[11px] text-slate-700 mt-2 font-mono">Base URL: <strong>https://spehr.live/fhir</strong></p>
      </div>

      <div className="grid xl:grid-cols-3 gap-4">
        <LookupCard />
        <ExpandCard />
        <TranslateCard />
      </div>
    </div>
  );
}

function ResponseBox({ data }: { data: any }) {
  if (!data) return null;
  return (
    <pre className="rounded border border-slate-200 bg-slate-900 text-emerald-300 p-3 text-[10px] overflow-x-auto max-h-72 mt-3">
      {JSON.stringify(data, null, 2)}
    </pre>
  );
}

function LookupCard() {
  const [sys, setSys] = useState(CODE_SYSTEMS[0]);
  const [code, setCode] = useState("22298006");
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<any>(null);

  const run = async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase.functions.invoke("fhir-terminology", {
        body: { operation: "lookup", params: { system: sys.uri, code } },
      });
      if (error) throw error;
      setData(data);
    } catch (e: any) { toast.error(e.message); }
    finally { setLoading(false); }
  };

  return (
    <div className="rounded-md border border-slate-200 bg-white p-4 space-y-2">
      <h4 className="text-sm font-semibold">CodeSystem/$lookup</h4>
      <p className="text-[11px] text-slate-500">Retrieve details about a specific code in a code system.</p>
      <div>
        <div className="text-[10px] uppercase font-semibold text-slate-500 mt-2 mb-1">Code System</div>
        <Select value={sys.label} onValueChange={v => setSys(CODE_SYSTEMS.find(x => x.label === v)!)}>
          <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>{CODE_SYSTEMS.map(c => <SelectItem key={c.label} value={c.label}>{c.label}</SelectItem>)}</SelectContent>
        </Select>
      </div>
      <div>
        <div className="text-[10px] uppercase font-semibold text-slate-500 mt-2 mb-1">Code</div>
        <Input value={code} onChange={(e) => setCode(e.target.value)} className="h-8 text-xs font-mono" />
      </div>
      <Button size="sm" className="w-full bg-[#0c2340] hover:bg-[#0c2340]/90 mt-2" onClick={run} disabled={loading}>
        {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />} Execute $lookup
      </Button>
      <ResponseBox data={data} />
    </div>
  );
}

function ExpandCard() {
  const [valueSets, setValueSets] = useState<string[]>([]);
  const [vs, setVs] = useState<string>("");
  const [filter, setFilter] = useState("");
  const [count, setCount] = useState(20);
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<any>(null);

  useEffect(() => {
    supabase.from("custom_value_sets").select("name").order("name").then(({ data }) => {
      const names = (data ?? []).map((r: any) => r.name);
      setValueSets(names);
      if (names.length && !vs) setVs(names[0]);
    });
  }, []);

  const run = async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase.functions.invoke("fhir-terminology", {
        body: { operation: "expand", params: { valueSet: vs, filter: filter || undefined, count } },
      });
      if (error) throw error;
      setData(data);
    } catch (e: any) { toast.error(e.message); }
    finally { setLoading(false); }
  };

  const exportCsv = () => {
    const rows = data?.expansion?.contains ?? [];
    const csv = ["code,display,system", ...rows.map((r: any) => `${r.code},"${r.display}",${r.system}`)].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = `${vs}-expansion.csv`; a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="rounded-md border border-slate-200 bg-white p-4 space-y-2">
      <h4 className="text-sm font-semibold">ValueSet/$expand</h4>
      <p className="text-[11px] text-slate-500">Expand a value set to get the explicit list of codes.</p>
      <div>
        <div className="text-[10px] uppercase font-semibold text-slate-500 mt-2 mb-1">Value Set</div>
        <Select value={vs} onValueChange={setVs}>
          <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="Choose…" /></SelectTrigger>
          <SelectContent>{valueSets.map(n => <SelectItem key={n} value={n}>{n}</SelectItem>)}</SelectContent>
        </Select>
      </div>
      <div>
        <div className="text-[10px] uppercase font-semibold text-slate-500 mt-2 mb-1">Filter (optional)</div>
        <Input value={filter} onChange={(e) => setFilter(e.target.value)} className="h-8 text-xs" placeholder="optional filter text" />
      </div>
      <div>
        <div className="text-[10px] uppercase font-semibold text-slate-500 mt-2 mb-1">Count</div>
        <Input type="number" value={count} onChange={(e) => setCount(Number(e.target.value))} className="h-8 text-xs w-24" />
      </div>
      <Button size="sm" className="w-full bg-[#0c2340] hover:bg-[#0c2340]/90 mt-2" onClick={run} disabled={loading || !vs}>
        {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />} Execute $expand
      </Button>
      {data?.expansion && (
        <div className="rounded border border-emerald-200 bg-emerald-50 px-3 py-2 text-[11px] mt-2 flex items-center justify-between">
          <span>Returned <strong>{data.expansion.total}</strong> concepts</span>
          <Button size="sm" variant="outline" onClick={exportCsv}><Download className="h-3 w-3" /> CSV</Button>
        </div>
      )}
      <ResponseBox data={data} />
    </div>
  );
}

function TranslateCard() {
  const [src, setSrc] = useState(CODE_SYSTEMS[0]);
  const [tgt, setTgt] = useState(CODE_SYSTEMS[1]);
  const [code, setCode] = useState("422504002");
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<any>(null);

  const run = async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase.functions.invoke("fhir-terminology", {
        body: { operation: "translate", params: { system: src.uri, code, targetSystem: tgt.uri } },
      });
      if (error) throw error;
      setData(data);
    } catch (e: any) { toast.error(e.message); }
    finally { setLoading(false); }
  };

  return (
    <div className="rounded-md border border-slate-200 bg-white p-4 space-y-2">
      <h4 className="text-sm font-semibold">ConceptMap/$translate</h4>
      <p className="text-[11px] text-slate-500">Translate a code from one system to another.</p>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <div className="text-[10px] uppercase font-semibold text-slate-500 mt-2 mb-1">Source System</div>
          <Select value={src.label} onValueChange={v => setSrc(CODE_SYSTEMS.find(x => x.label === v)!)}>
            <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>{CODE_SYSTEMS.map(c => <SelectItem key={c.label} value={c.label}>{c.label}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <div>
          <div className="text-[10px] uppercase font-semibold text-slate-500 mt-2 mb-1">Source Code</div>
          <Input value={code} onChange={(e) => setCode(e.target.value)} className="h-8 text-xs font-mono" />
        </div>
      </div>
      <div>
        <div className="text-[10px] uppercase font-semibold text-slate-500 mt-2 mb-1">Target System</div>
        <Select value={tgt.label} onValueChange={v => setTgt(CODE_SYSTEMS.find(x => x.label === v)!)}>
          <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>{CODE_SYSTEMS.map(c => <SelectItem key={c.label} value={c.label}>{c.label}</SelectItem>)}</SelectContent>
        </Select>
      </div>
      <Button size="sm" className="w-full bg-[#0c2340] hover:bg-[#0c2340]/90 mt-2" onClick={run} disabled={loading}>
        {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />} Execute $translate
      </Button>
      <ResponseBox data={data} />
    </div>
  );
}