import { useEffect, useRef, useState } from "react";
import { Loader2, Search } from "lucide-react";
import { useAutoApiEnabled } from "@/hooks/useAutomationEnabled";

/**
 * Semantic Autocomplete — debounced UMLS-backed dropdown for CPOE inputs.
 * Falls back to a plain text input when AUTO API is OFF.
 *
 * vocabulary defaults to RxNorm for drug fields; pass "SNOMED-CT" for
 * diagnosis fields, "LOINC" for lab fields, "ICD-10-CM" for ICD coding.
 */
type Suggestion = { code: string; display: string; source: string };

interface Props {
  value: string;
  onChange: (v: string) => void;
  onSelect?: (s: Suggestion) => void;
  placeholder?: string;
  vocabulary?: "RxNorm" | "SNOMED-CT" | "LOINC" | "ICD-10-CM";
  className?: string;
}

export function SemanticAutocomplete({
  value,
  onChange,
  onSelect,
  placeholder,
  vocabulary = "RxNorm",
  className,
}: Props) {
  const autoApi = useAutoApiEnabled();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Suggestion[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const timer = useRef<number | null>(null);
  const lastQuery = useRef<string>("");

  useEffect(() => {
    if (!autoApi) {
      setItems([]);
      setOpen(false);
      return;
    }
    if (timer.current) window.clearTimeout(timer.current);
    const term = value.trim();
    if (term.length < 2) {
      setItems([]);
      setOpen(false);
      return;
    }
    timer.current = window.setTimeout(async () => {
      lastQuery.current = term;
      setLoading(true);
      setErr(null);
      try {
        const r = await fetch("/api/public/umls-search", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ searchTerm: term, vocabulary }),
        });
        const j = await r.json();
        if (lastQuery.current !== term) return;
        if (!r.ok) {
          setErr(j?.error ?? "UMLS unavailable");
          setItems([]);
        } else {
          const results = (j?.result?.results ?? []) as any[];
          setItems(
            results
              .filter((x) => x?.ui && x.ui !== "NONE")
              .slice(0, 8)
              .map((x) => ({
                code: String(x.ui),
                display: String(x.name ?? ""),
                source: String(x.rootSource ?? vocabulary),
              })),
          );
        }
        setOpen(true);
      } catch (e: any) {
        setErr(String(e?.message ?? e));
        setItems([]);
      } finally {
        setLoading(false);
      }
    }, 300);
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, [value, vocabulary, autoApi]);

  return (
    <div className="relative">
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        onFocus={() => items.length > 0 && setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        className={
          className ??
          "w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#0c2340]/30"
        }
      />
      {autoApi && loading && (
        <Loader2 className="absolute right-2 top-2.5 h-4 w-4 animate-spin text-slate-400" />
      )}
      {autoApi && open && (items.length > 0 || err) && (
        <div className="absolute z-30 mt-1 w-full max-h-64 overflow-auto rounded-md border border-slate-200 bg-white shadow-lg">
          {err && (
            <div className="px-3 py-2 text-[11px] text-rose-600">{err}</div>
          )}
          {items.map((s) => (
            <button
              key={s.source + s.code}
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                onChange(s.display);
                onSelect?.(s);
                setOpen(false);
              }}
              className="flex w-full items-start gap-2 px-3 py-2 text-left text-[12px] hover:bg-slate-50 border-b border-slate-100 last:border-0"
            >
              <Search className="h-3 w-3 mt-0.5 text-slate-400 flex-shrink-0" />
              <div className="flex-1">
                <div className="text-slate-900">{s.display}</div>
                <div className="text-[10px] font-mono text-slate-500">
                  {s.source} · {s.code}
                </div>
              </div>
            </button>
          ))}
        </div>
      )}
      {!autoApi && (
        <div className="mt-1 text-[10px] text-amber-700">
          AUTO API off — manual entry (no UMLS lookup).
        </div>
      )}
    </div>
  );
}