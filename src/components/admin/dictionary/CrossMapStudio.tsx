import { useEffect, useState } from "react";
import { ArrowRight, Loader2, Download, Copy } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";

const VOCABS = [
  { label: "SNOMED CT", uri: "http://snomed.info/sct" },
  { label: "ICD-10-CM", uri: "http://hl7.org/fhir/sid/icd-10-cm" },
  { label: "LOINC", uri: "http://loinc.org" },
  { label: "RxNorm", uri: "http://www.nlm.nih.gov/research/umls/rxnorm" },
  { label: "CPT", uri: "http://www.ama-assn.org/go/cpt" },
];

const VOCAB_TO_SAB: Record<string, string> = {
  "SNOMED CT": "SNOMEDCT_US",
  "ICD-10-CM": "ICD10CM",
  "LOINC": "LNC",
  "RxNorm": "RXNORM",
  "CPT": "CPT",
};
const vocabToSab = (v: string) => VOCAB_TO_SAB[v] ?? v;

const REFERENCE_CROSSWALKS = [
  { src: "22298006", srcName: "Myocardial infarction", srcVocab: "SNOMED CT", cui: "C0027051", tgt: "I21.9", tgtName: "Acute MI, unspecified", tgtVocab: "ICD-10-CM", map: "Equivalent" },
  { src: "233604007", srcName: "Pneumonia", srcVocab: "SNOMED CT", cui: "C0032285", tgt: "J18.9", tgtName: "Pneumonia, unspecified", tgtVocab: "ICD-10-CM", map: "Equivalent" },
  { src: "59282003", srcName: "Pulmonary embolism", srcVocab: "SNOMED CT", cui: "C0034065", tgt: "I26.09", tgtName: "PE without cor pulmonale", tgtVocab: "ICD-10-CM", map: "Equivalent" },
  { src: "718-7", srcName: "Hemoglobin", srcVocab: "LOINC", cui: "C0019029", tgt: "85018", tgtName: "Hgb, blood test", tgtVocab: "CPT", map: "Equivalent" },
  { src: "38341003", srcName: "Hypertension", srcVocab: "SNOMED CT", cui: "C0020538", tgt: "I10", tgtName: "Essential hypertension", tgtVocab: "ICD-10-CM", map: "Equivalent" },
  { src: "84757009", srcName: "Epilepsy", srcVocab: "SNOMED CT", cui: "C0014544", tgt: "G40.909", tgtName: "Epilepsy, unspecified", tgtVocab: "ICD-10-CM", map: "Broader" },
  { src: "44054006", srcName: "T2DM", srcVocab: "SNOMED CT", cui: "C0011860", tgt: "E11.9", tgtName: "T2DM without complications", tgtVocab: "ICD-10-CM", map: "Equivalent" },
  { src: "422504002", srcName: "Acute ischemic stroke", srcVocab: "SNOMED CT", cui: "C0948008", tgt: "I63.9", tgtName: "Cerebral infarction, unspecified", tgtVocab: "ICD-10-CM", map: "Wider" },
  { src: "13645005", srcName: "COPD", srcVocab: "SNOMED CT", cui: "C0024117", tgt: "J44.9", tgtName: "Chronic obstructive pulmonary disease, unspecified", tgtVocab: "ICD-10-CM", map: "Equivalent" },
  { src: "84114007", srcName: "Heart failure", srcVocab: "SNOMED CT", cui: "C0018802", tgt: "I50.9", tgtName: "Heart failure, unspecified", tgtVocab: "ICD-10-CM", map: "Equivalent" },
];

type MapMatch = {
  equivalence: string;
  code: string;
  display: string;
  system: string;
};

export function CrossMapStudio() {
  const [src, setSrc] = useState(VOCABS[0]);
  const [tgt, setTgt] = useState(VOCABS[1]);
  const [code, setCode] = useState("");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<{ matches: MapMatch[]; conceptMap: any } | null>(null);

  const [batchText, setBatchText] = useState("");
  const [batchRunning, setBatchRunning] = useState(false);
  const [batchResults, setBatchResults] = useState<any[]>([]);

  const [log, setLog] = useState<Array<{ id: string; created_at: string; actor: string; message: string }>>([]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const { data } = await supabase
        .from("terminology_activity_log" as any)
        .select("id, created_at, actor, message")
        .eq("feature", "crossmap")
        .order("created_at", { ascending: false })
        .limit(50);
      if (!cancelled && data) setLog(data as any);
    };
    load();
    const ch = supabase
      .channel("terminology-activity-crossmap")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "terminology_activity_log", filter: "feature=eq.crossmap" },
        (payload) => setLog((l) => [payload.new as any, ...l].slice(0, 50)),
      )
      .subscribe();
    return () => { cancelled = true; supabase.removeChannel(ch); };
  }, []);

  const logActivity = (action: string, message: string) => {
    void supabase.from("terminology_activity_log" as any).insert({
      feature: "crossmap",
      actor: "S.P.E.H.R. Terminology Services",
      action,
      message,
    });
  };

  // Listen for prefill events from Live Terminology Matrix pills
  useEffect(() => {
    const onPrefill = (e: Event) => {
      const d = (e as CustomEvent).detail ?? {};
      if (d.sourceVocab) {
        const match = VOCABS.find(v => v.label === d.sourceVocab || v.label.startsWith(d.sourceVocab));
        if (match) setSrc(match);
      }
      if (d.targetVocab) {
        const match = VOCABS.find(v => v.label === d.targetVocab || v.label.startsWith(d.targetVocab));
        if (match) setTgt(match);
      }
      if (d.code) setCode(String(d.code));
    };
    window.addEventListener("spehr:crossmap-prefill", onPrefill as any);
    return () => window.removeEventListener("spehr:crossmap-prefill", onPrefill as any);
  }, []);

  const translate = async () => {
    if (!code.trim()) return toast.error("Enter a source code");
    setRunning(true);
    try {
      const { data, error } = await supabase.functions.invoke("umls-proxy", {
        body: {
          action: "crosswalk",
          params: {
            fromSab: vocabToSab(src.label),
            fromCode: code.trim(),
            toSab: vocabToSab(tgt.label),
          },
        },
      });
      if (error) throw error;
      const raw = Array.isArray(data?.matches) ? data.matches : (data?.result ? [data.result] : []);
      const matches: MapMatch[] = raw.map((m: any) => ({
        equivalence: "equivalent",
        code: m.code,
        display: m.name,
        system: tgt.uri,
      }));
      // Resolve source display name (validate against source vocab)
      let sourceDisplayName = code.trim();
      try {
        const { data: vd } = await supabase.functions.invoke("umls-proxy", {
          body: {
            action: "validate",
            params: { code: code.trim(), sab: vocabToSab(src.label) },
          },
        });
        const resolvedName =
          vd?.result?.name ||
          vd?.result?.display ||
          (Array.isArray(vd?.matches) ? vd.matches[0]?.name : null) ||
          null;
        if (resolvedName) sourceDisplayName = resolvedName;
        console.log("[CrossMap] validate →", { code: code.trim(), sab: vocabToSab(src.label), resolvedName, raw: vd });
      } catch { /* fall back to code */ }

      const conceptMapId = `${src.label}-to-${tgt.label}-${code.trim()}`
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");
      const conceptMap = {
        resourceType: "ConceptMap",
        id: conceptMapId,
        sourceUri: src.uri,
        targetUri: tgt.uri,
        group: [{
          source: src.uri, target: tgt.uri,
          element: [{
            code: code.trim(),
            display: sourceDisplayName || code.trim(),
            target: matches.map(m => ({ code: m.code, display: m.display, equivalence: m.equivalence })),
          }],
        }],
      };
      setResult({ matches, conceptMap });
      toast.success(`${matches.length} match(es)`);
      logActivity("translated", `Translated ${code.trim()} (${src.label} → ${tgt.label}) — ${matches.length} match(es)`);
    } catch (e: any) { toast.error(e.message); }
    finally { setRunning(false); }
  };

  const runBatch = async () => {
    const codes = batchText.split(/[\n,]+/).map(s => s.trim()).filter(Boolean);
    if (codes.length === 0) return toast.error("Paste codes (one per line)");
    setBatchRunning(true);
    setBatchResults([]);
    try {
      const rows: any[] = [];
      for (const c of codes) {
        try {
          const { data } = await supabase.functions.invoke("umls-proxy", {
            body: {
              action: "crosswalk",
              params: { fromSab: vocabToSab(src.label), fromCode: c, toSab: vocabToSab(tgt.label) },
            },
          });
          const first = data?.result ?? (Array.isArray(data?.matches) ? data.matches[0] : null);
          if (first) {
            rows.push({ sourceCode: c, targetCode: first.code, targetDisplay: first.name, equivalence: "equivalent" });
          } else {
            rows.push({ sourceCode: c, targetCode: "—", targetDisplay: "No match", equivalence: "unmatched" });
          }
        } catch {
          rows.push({ sourceCode: c, targetCode: "—", targetDisplay: "Error", equivalence: "error" });
        }
      }
      setBatchResults(rows);
      toast.success(`Resolved ${rows.length} code(s)`);
      logActivity("batch_crosswalk", `Batch crosswalk: ${rows.length} code(s) ${src.label} → ${tgt.label}`);
    } finally { setBatchRunning(false); }
  };

  const exportBatchCsv = () => {
    const csv = ["source_code,target_code,target_display,equivalence", ...batchResults.map(r => `${r.sourceCode},${r.targetCode},"${r.targetDisplay}",${r.equivalence}`)].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `crosswalk-${src.label}-to-${tgt.label}.csv`; a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-4">
      <div className="rounded-md border border-slate-200 bg-white p-5">
        <h3 className="text-lg font-semibold text-slate-900">🔀 Cross-Map Studio</h3>
        <p className="text-xs text-slate-500 mt-1">
          Translate clinical concepts across SNOMED CT, ICD-10-CM, LOINC, RxNorm, and CPT. All mappings
          validated via the UMLS Metathesaurus CUI layer. Powered by AUTO API crosswalk endpoint.
        </p>
      </div>

      {/* Single translator */}
      <div className="rounded-md border border-slate-200 bg-white p-5 space-y-3">
        <div className="grid md:grid-cols-[1fr_auto_1fr_auto_1fr_auto] gap-3 items-end">
          <div>
            <div className="text-[10px] uppercase font-semibold text-slate-500 mb-1">Source Vocabulary</div>
            <Select value={src.label} onValueChange={v => setSrc(VOCABS.find(x => x.label === v)!)}>
              <SelectTrigger className="h-9 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>{VOCABS.map(v => <SelectItem key={v.label} value={v.label}>{v.label}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <ArrowRight className="h-4 w-4 text-slate-400 mb-2.5" />
          <div>
            <div className="text-[10px] uppercase font-semibold text-slate-500 mb-1">Concept</div>
            <Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="Source code (e.g. 422504002)" className="h-9 text-xs" />
          </div>
          <ArrowRight className="h-4 w-4 text-slate-400 mb-2.5" />
          <div>
            <div className="text-[10px] uppercase font-semibold text-slate-500 mb-1">Target Vocabulary</div>
            <Select value={tgt.label} onValueChange={v => setTgt(VOCABS.find(x => x.label === v)!)}>
              <SelectTrigger className="h-9 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>{VOCABS.map(v => <SelectItem key={v.label} value={v.label}>{v.label}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <Button className="h-9 bg-[#0c2340] hover:bg-[#0c2340]/90" onClick={translate} disabled={running}>
            {running ? <Loader2 className="h-4 w-4 animate-spin" /> : "🔀"} Translate
          </Button>
        </div>

        {result && (
          <div className="space-y-3">
            <div className="rounded border border-slate-200 bg-slate-50 p-3">
              <div className="text-xs font-semibold mb-2">Crosswalk Results — {src.label} → {tgt.label}</div>
              <div className="text-[11px] text-slate-600 mb-3 font-mono">
                Source: {code}
              </div>
              {result.matches.length === 0 ? (
                <div className="text-xs text-amber-700">No crosswalk found in UMLS Metathesaurus.</div>
              ) : (
                <table className="w-full text-[11px]">
                  <thead className="text-slate-600 border-b border-slate-200">
                    <tr>
                      <th className="text-left py-1 font-semibold">Target Code</th>
                      <th className="text-left py-1 font-semibold">Display Name</th>
                      <th className="text-left py-1 font-semibold">Equivalence</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {result.matches.map((m, i) => (
                      <tr key={i}>
                        <td className="py-1 font-mono">{m.code}</td>
                        <td className="py-1">{m.display}</td>
                        <td className="py-1 capitalize">{m.equivalence}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            <details>
              <summary className="text-xs font-semibold cursor-pointer text-slate-700 hover:text-slate-900">
                View FHIR ConceptMap JSON
              </summary>
              <div className="flex justify-end mt-2">
                <Button size="sm" variant="outline" onClick={() => { navigator.clipboard.writeText(JSON.stringify(result.conceptMap, null, 2)); toast.success("Copied"); }}>
                  <Copy className="h-3.5 w-3.5" /> Copy
                </Button>
              </div>
              <pre className="mt-1 rounded border border-slate-200 bg-slate-900 text-emerald-300 p-3 text-[10px] overflow-x-auto max-h-72">
                {JSON.stringify(result.conceptMap, null, 2)}
              </pre>
            </details>
          </div>
        )}
      </div>

      {/* Batch */}
      <div className="rounded-md border border-slate-200 bg-white p-5 space-y-3">
        <h4 className="text-sm font-semibold">Batch Crosswalk</h4>
        <Textarea
          value={batchText}
          onChange={(e) => setBatchText(e.target.value)}
          rows={5}
          className="font-mono text-xs"
          placeholder={`22298006\n422504002\n233604007\n59282003`}
        />
        <div className="flex items-center gap-3 flex-wrap">
          <span className="text-xs">Source: <strong>{src.label}</strong></span>
          <ArrowRight className="h-3.5 w-3.5 text-slate-400" />
          <span className="text-xs">Target: <strong>{tgt.label}</strong></span>
          <Button size="sm" onClick={runBatch} disabled={batchRunning} className="bg-[#0c2340] hover:bg-[#0c2340]/90">
            {batchRunning ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "▶"} Run Batch Crosswalk
          </Button>
          {batchResults.length > 0 && (
            <Button size="sm" variant="outline" onClick={exportBatchCsv}>
              <Download className="h-3.5 w-3.5" /> Export CSV
            </Button>
          )}
        </div>
        {batchResults.length > 0 && (
          <table className="w-full text-[11px] border border-slate-200 mt-2">
            <thead className="bg-slate-50 text-slate-600">
              <tr>
                <th className="text-left px-2 py-1.5 font-semibold">Source Code</th>
                <th className="text-left px-2 py-1.5 font-semibold">Target Code</th>
                <th className="text-left px-2 py-1.5 font-semibold">Target Display</th>
                <th className="text-left px-2 py-1.5 font-semibold">Equivalence</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {batchResults.map((r, i) => (
                <tr key={i} className="hover:bg-slate-50">
                  <td className="px-2 py-1 font-mono">{r.sourceCode}</td>
                  <td className="px-2 py-1 font-mono">{r.targetCode}</td>
                  <td className="px-2 py-1">{r.targetDisplay}</td>
                  <td className="px-2 py-1 capitalize">{r.equivalence}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Reference table */}
      <div className="rounded-md border border-slate-200 bg-white p-5">
        <h4 className="text-sm font-semibold mb-3">Pre-populated Crosswalk Library</h4>
        <div className="overflow-x-auto">
          <table className="w-full text-[11px] border border-slate-200">
            <thead className="bg-slate-50 text-slate-600">
              <tr>
                <th className="text-left px-2 py-1.5 font-semibold">Source Code</th>
                <th className="text-left px-2 py-1.5 font-semibold">Source Name</th>
                <th className="text-left px-2 py-1.5 font-semibold">Vocab</th>
                <th className="text-left px-2 py-1.5 font-semibold">CUI</th>
                <th className="text-left px-2 py-1.5 font-semibold">Target Code</th>
                <th className="text-left px-2 py-1.5 font-semibold">Target Name</th>
                <th className="text-left px-2 py-1.5 font-semibold">Vocab</th>
                <th className="text-left px-2 py-1.5 font-semibold">Map Type</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {REFERENCE_CROSSWALKS.map(r => (
                <tr key={`${r.src}-${r.tgt}`} className="hover:bg-slate-50">
                  <td className="px-2 py-1 font-mono">{r.src}</td>
                  <td className="px-2 py-1">{r.srcName}</td>
                  <td className="px-2 py-1 text-slate-600">{r.srcVocab}</td>
                  <td className="px-2 py-1 font-mono text-slate-600">{r.cui}</td>
                  <td className="px-2 py-1 font-mono">{r.tgt}</td>
                  <td className="px-2 py-1">{r.tgtName}</td>
                  <td className="px-2 py-1 text-slate-600">{r.tgtVocab}</td>
                  <td className="px-2 py-1">{r.map}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="rounded border border-slate-200 bg-slate-50 px-3 py-2 text-[10px]">
        <div className="font-semibold text-slate-600 mb-1">Cross-Map Activity Log</div>
        {log.length === 0 ? (
          <div className="text-slate-400">No activity yet.</div>
        ) : (
          <ul className="font-mono text-slate-700 space-y-0.5 max-h-40 overflow-y-auto">
            {log.map((e) => (
              <li key={e.id}>
                <span className="text-slate-400">{new Date(e.created_at).toLocaleTimeString()}</span>
                {" · "}
                <span className="text-slate-500">{e.actor}</span>
                {" · "}
                <span>{e.message}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}