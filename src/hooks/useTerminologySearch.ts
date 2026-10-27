/**
 * Debounced type-ahead hook backed by `searchTerminology` (umls-proxy).
 * Cancels stale requests via a request-id ref so rapid typing only shows
 * the latest response. On network failure returns `error` so the caller
 * can surface the "Terminology server unavailable" hint.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  searchTerminology,
  type TerminologyHit,
  type TerminologySab,
} from "@/lib/terminology-search";

export interface UseTerminologySearchOpts {
  sabs: TerminologySab;
  debounceMs?: number;
  pageSize?: number;
  minChars?: number;
}

export interface UseTerminologySearchResult {
  query: string;
  setQuery: (next: string) => void;
  results: TerminologyHit[];
  loading: boolean;
  error: string | null;
  clear: () => void;
}

export function useTerminologySearch(opts: UseTerminologySearchOpts): UseTerminologySearchResult {
  const { sabs, debounceMs = 300, pageSize = 10, minChars = 2 } = opts;
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<TerminologyHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reqIdRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    const term = query.trim();
    if (term.length < minChars) {
      setResults([]);
      setLoading(false);
      setError(null);
      return;
    }
    timerRef.current = setTimeout(async () => {
      const id = ++reqIdRef.current;
      setLoading(true);
      setError(null);
      try {
        const hits = await searchTerminology({ query: term, sabs, pageSize });
        if (id === reqIdRef.current) setResults(hits);
      } catch (e) {
        if (id === reqIdRef.current) {
          setError(e instanceof Error ? e.message : "Terminology server unavailable");
          setResults([]);
        }
      } finally {
        if (id === reqIdRef.current) setLoading(false);
      }
    }, debounceMs);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [query, sabs, debounceMs, pageSize, minChars]);

  const clear = useCallback(() => {
    reqIdRef.current++;
    setQuery("");
    setResults([]);
    setError(null);
    setLoading(false);
  }, []);

  return { query, setQuery, results, loading, error, clear };
}
