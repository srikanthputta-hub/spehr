/**
 * Type-ahead combobox used by the admission form. Backed by the
 * `useTerminologySearch` hook (umls-proxy `search`). Falls back to plain
 * text entry when the proxy call fails — submission is never blocked.
 */

import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { useTerminologySearch } from "@/hooks/useTerminologySearch";
import type { TerminologyHit, TerminologySab } from "@/lib/terminology-search";

export interface TerminologyComboboxProps {
  value: string;
  onChange: (text: string) => void;
  onSelect: (hit: TerminologyHit) => void;
  sabs: TerminologySab;
  placeholder?: string;
  className?: string;
  clearOnSelect?: boolean;
}

export function TerminologyCombobox({
  value,
  onChange,
  onSelect,
  sabs,
  placeholder,
  className,
  clearOnSelect,
}: TerminologyComboboxProps) {
  const { query, setQuery, results, loading, error, clear } = useTerminologySearch({ sabs });
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Keep the internal query in sync with the parent-controlled text.
  useEffect(() => {
    if (value !== query) setQuery(value);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (!wrapRef.current) return;
      if (!wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  useEffect(() => {
    setActive(0);
  }, [results]);

  const commit = (hit: TerminologyHit) => {
    onSelect(hit);
    if (clearOnSelect) {
      onChange("");
      clear();
    } else {
      onChange(hit.display);
      setQuery(hit.display);
    }
    setOpen(false);
  };

  const showDropdown = open && query.trim().length >= 2;

  return (
    <div ref={wrapRef} className={`relative ${className ?? ""}`}>
      <input
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (!showDropdown || results.length === 0) return;
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setActive((i) => Math.min(i + 1, results.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((i) => Math.max(i - 1, 0));
          } else if (e.key === "Enter") {
            e.preventDefault();
            commit(results[active]);
          } else if (e.key === "Escape") {
            setOpen(false);
          }
        }}
        placeholder={placeholder}
        className="h-9 w-full rounded-md border border-border bg-background px-3 pr-8 text-sm outline-none focus:ring-2 focus:ring-[var(--teal)]/40 focus:border-[var(--teal)] transition"
      />
      {loading && (
        <Loader2 className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 animate-spin text-muted-foreground" />
      )}
      {showDropdown && (
        <div className="absolute z-40 mt-1 w-full max-h-64 overflow-y-auto rounded-md border border-border bg-popover shadow-lg text-sm">
          {error && (
            <div className="px-3 py-2 text-[11px] text-amber-700 bg-amber-50 border-b border-amber-200">
              Terminology server unavailable — you can still type freely.
            </div>
          )}
          {!error && loading && results.length === 0 && (
            <div className="px-3 py-2 text-[11px] text-muted-foreground">Searching…</div>
          )}
          {!error && !loading && results.length === 0 && (
            <div className="px-3 py-2 text-[11px] text-muted-foreground">No matches</div>
          )}
          {results.map((r, i) => (
            <button
              key={`${r.system}-${r.code}`}
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                commit(r);
              }}
              onMouseEnter={() => setActive(i)}
              className={`w-full text-left px-3 py-1.5 border-b border-border/60 last:border-b-0 transition ${
                i === active ? "bg-[var(--teal)]/10" : "hover:bg-secondary/60"
              }`}
            >
              <div className="text-[12px] font-medium text-slate-800">{r.display}</div>
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                {r.system} · {r.code}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
