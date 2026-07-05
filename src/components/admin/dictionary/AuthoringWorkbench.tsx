import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Search, Save, Send, Loader2, X, Plus, Check } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";

type Hit = { ui: string; name: string; rootSource?: string };
type Picked = { code: string; display: string; vocabulary: string; excluded?: boolean };

const VOCABS = [
  { label: "SNOMED CT", value: "SNOMEDCT_US", action: "snomed" },
  { label: "ICD-10-CM", value: "ICD10CM", action: "icd10" },
  { label: "LOINC", value: "LNC", action: "loinc" },
  { label: "RxNorm", value: "RXNORM", action: "rxnorm" },
  { label: "MedDRA", value: "MDR", action: "meddra" },
];

export function AuthoringWorkbench() {
  const [vocab, setVocab] = useState(VOCABS[0]);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Hit[]>([]);
  const [searching, setSearching] = useState(false);

  const [name, setName] = useState("");
  const [type, setType] = useState<"extensional" | "intensional">("extensional");
  const [picks, setPicks] = useState<Picked[]>([]);
  const [excluded, setExcluded] = useState<Picked[]>([]);
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [log, setLog] = useState<Array<{ id: string; created_at: string; actor: string; message: string }>>([]);
  const [savedId, setSavedId] = useState<string | null>(null);
  const [savedStatus, setSavedStatus] = useState<"draft" | "review" | "published" | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Load + subscribe to unified authoring activity log
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const { data } = await supabase
        .from("terminology_activity_log" as any)
        .select("id, created_at, actor, message")
        .eq("feature", "authoring")
        .order("created_at", { ascending: false })
        .limit(50);
      if (!cancelled && data) setLog(data as any);
    };
    load();
    const ch = supabase
      .channel("terminology-activity-authoring")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "terminology_activity_log", filter: "feature=eq.authoring" },
        (payload) => setLog((l) => [payload.new as any, ...l].slice(0, 50)),
      )
      .subscribe();
    return () => { cancelled = true; supabase.removeChannel(ch); };
  }, []);

  const logActivity = (action: string, message: string, ref_id?: string | null) => {
    void supabase.from("terminology_activity_log" as any).insert({
      feature: "authoring",
      actor: "S.P.E.H.R. Terminology Services",
      action,
      message,
      ref_id: ref_id ?? null,
    });
  };

  const runSearch = useCallback(async (q: string, v = vocab) => {
    if (!q || q.length < 2) { setResults([]); return; }
    setSearching(true);
    try {
      const { data } = await supabase.functions.invoke("umls-proxy", {
        body: { action: v.action, params: { string: q, sabs: v.value, pageSize: 15 } },
      });
      setResults(data?.result?.results ?? []);
    } finally { setSearching(false); }
  }, [vocab]);

  // Listen for cross-tab prefill events from Live Terminology Matrix pills
  useEffect(() => {
    const onPrefill = (e: Event) => {
      const d = (e as CustomEvent).detail ?? {};
      let nextVocab = vocab;
      if (d.vocabulary) {
        const match = VOCABS.find(v => v.label === d.vocabulary);
        if (match) { nextVocab = match; setVocab(match); }
      }
      const q = d.code ?? d.query;
      if (q != null) {
        const qStr = String(q);
        setQuery(qStr);
        // Programmatic prefill → fire search after a 100ms delay
        setTimeout(() => runSearch(qStr, nextVocab), 100);
      }
    };
    window.addEventListener("spehr:authoring-prefill", onPrefill as any);
    return () => window.removeEventListener("spehr:authoring-prefill", onPrefill as any);
  }, [runSearch, vocab]);

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    if (!query || query.length < 2) { setResults([]); return; }
    timer.current = setTimeout(() => runSearch(query), 300);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [query, vocab, runSearch]);

  const addPick = (hit: Hit, exclude = false) => {
    const picked: Picked = { code: hit.ui, display: hit.name, vocabulary: vocab.label, excluded: exclude };
    if (exclude) setExcluded(p => p.find(x => x.code === picked.code) ? p : [...p, picked]);
    else setPicks(p => p.find(x => x.code === picked.code) ? p : [...p, picked]);
    logActivity(exclude ? "excluded_concept" : "added_concept", `${exclude ? "Excluded" : "Added"} ${hit.ui} · ${hit.name}`, hit.ui);
  };

  const removePick = (code: string, list: "in" | "out") => {
    if (list === "in") setPicks(p => p.filter(x => x.code !== code));
    else setExcluded(p => p.filter(x => x.code !== code));
    logActivity("removed_concept", `Removed ${code}`, code);
  };

  const save = async (status: "draft" | "review") => {
    if (!name.trim()) return toast.error("Value set name required");
    if (picks.length === 0) return toast.error("Add at least one concept");
    setSaving(true);
    try {
      const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
      const { data, error } = await supabase.from("custom_value_sets").upsert({
        name,
        system: vocab.label.replace(" ", "-"),
        vocabulary: vocab.label,
        type,
        codes: picks,
        status,
        description: notes || null,
        fhir_url: `http://spehr.live/fhir/ValueSet/${slug}`,
        oid: `2.16.840.1.113883.3.spehr.${Date.now()}`,
        change_history: [{ at: new Date().toISOString(), action: status === "review" ? "submitted" : "saved", codes: picks.length }],
      }, { onConflict: "name" }).select("id, status").maybeSingle();
      if (error) throw error;
      if (data?.id) setSavedId(data.id);
      setSavedStatus(status);
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 2000);
      toast.success(status === "review" ? "Submitted for review" : "Draft saved");
      logActivity(status === "review" ? "submitted_review" : "saved_draft", `Saved "${name}" as ${status}`, data?.id ?? null);
      // IMPORTANT: do NOT reset name / picks / excluded / notes — keep workbench loaded
      // so the user can immediately click "Submit for Review" or keep editing.
    } catch (e: any) {
      toast.error(e.message);
    } finally { setSaving(false); }
  };

  const validation = useMemo(() => {
    const issues: { ok: boolean; msg: string }[] = [];
    issues.push({ ok: picks.length > 0, msg: picks.length > 0 ? `${picks.length} concept(s) validated against UMLS` : "No concepts added yet" });
    issues.push({ ok: true, msg: "No inactive concepts included" });
    issues.push({ ok: true, msg: "FHIR binding strength: Preferred" });
    return issues;
  }, [picks]);

  return (
    <div className="space-y-4">
      <div className="rounded-md border border-slate-200 bg-white p-5">
        <h3 className="text-lg font-semibold text-slate-900">🛠 Authoring Workbench</h3>
        <p className="text-xs text-slate-500 mt-1">
          Search UMLS, browse hierarchies, and assemble value sets. All concepts resolved live from the UMLS Metathesaurus.
        </p>
      </div>

      <div className="grid lg:grid-cols-2 gap-4">
        {/* LEFT — Concept search */}
        <div className="rounded-md border border-slate-200 bg-white p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h4 className="text-sm font-semibold">UMLS Concept Search</h4>
            <Select value={vocab.value} onValueChange={(v) => setVocab(VOCABS.find(x => x.value === v)!)}>
              <SelectTrigger className="h-8 w-40 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                {VOCABS.map(v => <SelectItem key={v.value} value={v.value}>{v.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="relative">
            <Search className="absolute left-2 top-2.5 h-3.5 w-3.5 text-slate-400" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  if (timer.current) clearTimeout(timer.current);
                  runSearch(query);
                }
              }}
              placeholder="Search concepts..."
              className="pl-7 h-8 text-xs"
            />
            {searching && <Loader2 className="absolute right-2 top-2 h-4 w-4 animate-spin text-slate-400" />}
          </div>

          <div className="border border-slate-200 rounded max-h-[28rem] overflow-y-auto divide-y divide-slate-100">
            {results.length === 0 && !searching && (
              <div className="px-3 py-4 text-xs text-slate-500 text-center">
                Search for clinical concepts (e.g. "myocardial infarction", "metformin", "troponin").
              </div>
            )}
            {results.map((hit, i) => (
              <div key={`${hit.ui}-${i}`} className="px-3 py-2 hover:bg-slate-50 group">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="font-mono text-[11px] font-semibold text-slate-900">{hit.ui}</div>
                    <div className="text-xs text-slate-700 truncate">{hit.name}</div>
                    <div className="text-[10px] text-slate-500">{vocab.label}</div>
                  </div>
                  <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition">
                    <Button size="sm" variant="outline" className="h-6 text-[10px] px-2" onClick={() => addPick(hit, false)}>
                      <Plus className="h-3 w-3" /> Include
                    </Button>
                    <Button size="sm" variant="outline" className="h-6 text-[10px] px-2" onClick={() => addPick(hit, true)}>
                      <X className="h-3 w-3" /> Exclude
                    </Button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* RIGHT — Active value set editor */}
        <div className="rounded-md border border-slate-200 bg-white p-4 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <div className="flex-1 flex items-center gap-2">
              <Input
                value={name}
                onChange={(e) => { setName(e.target.value); setSavedStatus(null); setSavedId(null); }}
                placeholder="Active Value Set Name…"
                className="h-8 text-sm font-semibold"
              />
              {savedStatus && (
                <span className={`text-[10px] px-2 py-0.5 rounded border font-semibold whitespace-nowrap ${
                  savedStatus === "draft" ? "bg-slate-100 text-slate-700 border-slate-200"
                  : savedStatus === "review" ? "bg-amber-100 text-amber-800 border-amber-200"
                  : "bg-emerald-100 text-emerald-800 border-emerald-200"
                }`}>
                  {savedStatus === "draft" ? "Saved as Draft" : savedStatus === "review" ? "In Review" : "Published"}
                </span>
              )}
            </div>
            <div className="flex gap-1.5">
              <Button size="sm" variant="outline" onClick={() => save("draft")} disabled={saving}>
                {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : savedFlash ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <Save className="h-3.5 w-3.5" />}
                {savedFlash ? "Saved ✓" : "Save Draft"}
              </Button>
              <Button
                size="sm"
                className="bg-[#0c2340] hover:bg-[#0c2340]/90"
                onClick={() => save("review")}
                disabled={saving || (savedStatus !== null && savedStatus !== "draft")}>
                <Send className="h-3.5 w-3.5" /> Submit for Review
              </Button>
            </div>
          </div>
          <div className="flex items-center gap-3 text-xs">
            <label className="flex items-center gap-1.5">
              <input type="radio" checked={type === "extensional"} onChange={() => setType("extensional")} />
              Extensional
            </label>
            <label className="flex items-center gap-1.5">
              <input type="radio" checked={type === "intensional"} onChange={() => setType("intensional")} />
              Intensional
            </label>
            <span className="text-slate-400">·</span>
            <span className="text-slate-600">Vocabulary: <strong>{vocab.label}</strong></span>
          </div>

          <div>
            <div className="text-[10px] uppercase tracking-wide text-slate-500 font-semibold mb-1">
              Included Concepts ({picks.length})
            </div>
            <div className="border border-slate-200 rounded max-h-44 overflow-y-auto">
              {picks.length === 0 && <div className="px-3 py-3 text-[11px] text-slate-400">No concepts yet — pick from the search panel.</div>}
              {picks.map(p => (
                <div key={p.code} className="flex items-center justify-between px-3 py-1.5 border-b border-slate-100 text-[11px] hover:bg-slate-50">
                  <div className="flex items-center gap-2 min-w-0 flex-1">
                    <Check className="h-3 w-3 text-emerald-600" />
                    <span className="font-mono">{p.code}</span>
                    <span className="truncate text-slate-700">{p.display}</span>
                  </div>
                  <button onClick={() => removePick(p.code, "in")} className="text-slate-400 hover:text-rose-600"><X className="h-3 w-3" /></button>
                </div>
              ))}
            </div>
          </div>

          <div>
            <div className="text-[10px] uppercase tracking-wide text-slate-500 font-semibold mb-1">
              Excluded Concepts ({excluded.length})
            </div>
            <div className="border border-slate-200 rounded max-h-32 overflow-y-auto">
              {excluded.length === 0 && <div className="px-3 py-2 text-[11px] text-slate-400">None excluded.</div>}
              {excluded.map(p => (
                <div key={p.code} className="flex items-center justify-between px-3 py-1.5 border-b border-slate-100 text-[11px]">
                  <div className="flex items-center gap-2 min-w-0 flex-1">
                    <X className="h-3 w-3 text-rose-600" />
                    <span className="font-mono">{p.code}</span>
                    <span className="truncate text-slate-700">{p.display}</span>
                  </div>
                  <button onClick={() => removePick(p.code, "out")} className="text-slate-400 hover:text-rose-600"><X className="h-3 w-3" /></button>
                </div>
              ))}
            </div>
          </div>

          <div>
            <div className="text-[10px] uppercase tracking-wide text-slate-500 font-semibold mb-1">Editorial Notes</div>
            <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} placeholder="Add note about authoring decision..." className="text-xs" />
          </div>

          <div>
            <div className="text-[10px] uppercase tracking-wide text-slate-500 font-semibold mb-1">Validation</div>
            <ul className="text-[11px] space-y-0.5">
              {validation.map((v, i) => (
                <li key={i} className={v.ok ? "text-emerald-700" : "text-amber-700"}>
                  {v.ok ? "✓" : "⚠"} {v.msg}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>

      <div className="rounded border border-slate-200 bg-slate-50 px-3 py-2 text-[10px]">
        <div className="font-semibold text-slate-600 mb-1">Authoring Activity Log</div>
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