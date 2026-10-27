import { useEffect, useRef, useState } from "react";
import { ChevronDown, Plus, Save, Send, Trash2, X, Search, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { saveValueSet, listValueSets } from "@/lib/auto-api.functions";

type Pill = { code: string; display: string };

const VOCAB_OPTIONS: { label: string; value: string }[] = [
  { label: "SNOMED CT", value: "SNOMED-CT" },
  { label: "ICD-10", value: "ICD-10-CM" },
  { label: "LOINC", value: "LOINC" },
  { label: "RxNorm", value: "RxNorm" },
  { label: "Mixed", value: "Mixed" },
];

async function umlsSearch(term: string, vocab: string): Promise<Pill[]> {
  if (vocab === "Mixed") vocab = "SNOMED-CT";
  const r = await fetch("/api/public/umls-search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ searchTerm: term, vocabulary: vocab }),
  });
  if (!r.ok) return [];
  const json = await r.json();
  const results: Pill[] =
    json?.result?.results?.map((x: any) => ({
      code: String(x.ui ?? ""),
      display: String(x.name ?? ""),
    })) ?? [];
  return results.filter((x) => x.code && x.code !== "NONE");
}

export function ValueSetBuilder() {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [system, setSystem] = useState("SNOMED-CT");
  const [description, setDescription] = useState("");
  const [search, setSearch] = useState("");
  const [results, setResults] = useState<Pill[]>([]);
  const [selected, setSelected] = useState<Pill[]>([]);
  const [searching, setSearching] = useState(false);
  const [saving, setSaving] = useState(false);
  const [published, setPublished] = useState<any[]>([]);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    listValueSets().then((r) => setPublished(r.items ?? []));
  }, []);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (search.trim().length < 2) {
      setResults([]);
      return;
    }
    debounceRef.current = setTimeout(async () => {
      setSearching(true);
      try {
        const r = await umlsSearch(search.trim(), system);
        setResults(r);
      } finally {
        setSearching(false);
      }
    }, 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [search, system]);

  const add = (p: Pill) => {
    if (selected.some((s) => s.code === p.code)) return;
    setSelected([...selected, p]);
  };
  const remove = (code: string) => setSelected(selected.filter((s) => s.code !== code));
  const clearAll = () => {
    setName("");
    setDescription("");
    setSearch("");
    setResults([]);
    setSelected([]);
  };

  const submit = async (publish: boolean) => {
    if (!name.trim() || selected.length === 0) return;
    setSaving(true);
    try {
      await saveValueSet({
        data: {
          name: name.trim(),
          system,
          codes: selected.map((s) => ({ code: s.code, display: s.display, system })),
          description: description.trim(),
          publish,
        },
      });
      const fresh = await listValueSets();
      setPublished(fresh.items ?? []);
      clearAll();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mt-4 rounded-xl border border-slate-200 bg-white shadow-sm overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between gap-2 px-4 py-3 hover:bg-slate-50"
      >
        <div className="text-left">
          <div className="text-sm font-bold text-slate-900">Custom Value Set Builder</div>
          <div className="text-[11px] text-slate-500">
            Construct and publish custom groupings of SNOMED CT, ICD-10, LOINC, or RxNorm codes —
            AUTO API UMLS-backed search.
          </div>
        </div>
        <ChevronDown
          className={`h-4 w-4 text-slate-500 transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open && (
        <div className="border-t border-slate-100 p-4 space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                Value Set Name
              </label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Sepsis Cohort 2026"
                className="mt-1"
              />
            </div>
            <div>
              <label className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                Terminology System
              </label>
              <Select value={system} onValueChange={setSystem}>
                <SelectTrigger className="mt-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {VOCAB_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div>
            <label className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
              Code Search (UMLS live query)
            </label>
            <div className="mt-1 relative">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-400" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Type a clinical concept…"
                className="pl-7"
              />
              {searching && (
                <Loader2 className="absolute right-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-400 animate-spin" />
              )}
            </div>
            {results.length > 0 && (
              <div className="mt-2 max-h-48 overflow-y-auto rounded-lg border border-slate-200 bg-white">
                {results.map((r) => (
                  <button
                    key={r.code}
                    type="button"
                    onClick={() => add(r)}
                    className="w-full flex items-center justify-between gap-2 px-3 py-2 text-left text-xs hover:bg-violet-50 border-b border-slate-100 last:border-b-0"
                  >
                    <span className="truncate">{r.display}</span>
                    <span className="font-mono text-[10px] text-slate-500 shrink-0">{r.code}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <div>
            <label className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
              Selected Codes ({selected.length})
            </label>
            <div className="mt-1 min-h-[60px] rounded-lg border border-dashed border-slate-300 bg-slate-50/60 p-2 flex flex-wrap gap-1.5">
              {selected.length === 0 && (
                <div className="text-xs text-slate-400 italic">
                  No codes selected yet — search above and click to stage.
                </div>
              )}
              {selected.map((s) => (
                <span
                  key={s.code}
                  className="inline-flex items-center gap-1.5 rounded-full bg-violet-100 text-violet-800 border border-violet-200 px-2 py-0.5 text-[11px]"
                >
                  <span className="font-mono">{s.code}</span>
                  <span className="truncate max-w-[160px]">{s.display}</span>
                  <button onClick={() => remove(s.code)}>
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
            </div>
          </div>
          <div>
            <label className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
              Description / clinical rationale
            </label>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="mt-1"
              rows={2}
            />
          </div>
          <div className="flex items-center justify-end gap-2">
            <Button variant="outline" size="sm" onClick={clearAll}>
              <Trash2 className="h-3.5 w-3.5 mr-1.5" /> Clear
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => submit(false)}
              disabled={saving || !name.trim() || selected.length === 0}
            >
              <Save className="h-3.5 w-3.5 mr-1.5" /> Save Draft
            </Button>
            <Button
              size="sm"
              className="bg-violet-600 hover:bg-violet-700 text-white"
              onClick={() => submit(true)}
              disabled={saving || !name.trim() || selected.length === 0}
            >
              <Send className="h-3.5 w-3.5 mr-1.5" /> Publish to VSAC Aligned Sets
            </Button>
          </div>
          {published.length > 0 && (
            <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-2">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500 mb-1">
                Published / Drafts ({published.length})
              </div>
              <div className="space-y-1 max-h-32 overflow-y-auto">
                {published.map((p) => (
                  <div key={p.id} className="flex items-center justify-between text-xs">
                    <div className="flex items-center gap-2 min-w-0">
                      <Plus className="h-3 w-3 text-violet-500" />
                      <span className="font-semibold truncate">{p.name}</span>
                      <span className="text-[10px] text-slate-500">
                        · {p.system} · {(p.codes ?? []).length} codes
                      </span>
                    </div>
                    <span
                      className={`text-[10px] uppercase font-semibold ${
                        p.status === "published" ? "text-emerald-600" : "text-slate-500"
                      }`}
                    >
                      {p.status}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
