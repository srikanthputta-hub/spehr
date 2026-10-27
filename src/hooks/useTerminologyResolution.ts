/**
 * React hook over `resolveConcept` — handy for semantic autocomplete
 * inputs (CPOE drug picker, problem list, lab catalog). Debounces input,
 * exposes loading / suggestions / chosen state, and de-dupes in-flight
 * requests so rapid typing only triggers the latest query.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  resolveConcept,
  type ResolveOptions,
  type ResolvedConcept,
  type Vocabulary,
} from "@/lib/terminology-resolver";

export interface UseTerminologyResolutionOptions extends ResolveOptions {
  vocabulary: Vocabulary;
  debounceMs?: number;
  enabled?: boolean;
}

export interface UseTerminologyResolutionResult {
  query: string;
  setQuery: (next: string) => void;
  concept: ResolvedConcept | null;
  loading: boolean;
  error: string | null;
  clear: () => void;
  refresh: () => Promise<void>;
}

export function useTerminologyResolution(
  opts: UseTerminologyResolutionOptions,
): UseTerminologyResolutionResult {
  const { vocabulary, debounceMs = 350, enabled = true, ...resolveOpts } = opts;

  const [query, setQuery] = useState("");
  const [concept, setConcept] = useState<ResolvedConcept | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Track the latest request so stale responses don't overwrite fresh state
  const requestIdRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const run = useCallback(
    async (text: string) => {
      const id = ++requestIdRef.current;
      setLoading(true);
      setError(null);
      try {
        const result = await resolveConcept(text, vocabulary, resolveOpts);
        if (id === requestIdRef.current) {
          setConcept(result);
        }
      } catch (e) {
        if (id === requestIdRef.current) {
          setError((e as Error).message ?? "Resolution failed");
          setConcept(null);
        }
      } finally {
        if (id === requestIdRef.current) setLoading(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [vocabulary, resolveOpts.resourceType, resolveOpts.mrn, resolveOpts.resourceId],
  );

  useEffect(() => {
    if (!enabled) return;
    if (timerRef.current) clearTimeout(timerRef.current);
    if (!query || query.trim().length < 2) {
      setConcept(null);
      setLoading(false);
      return;
    }
    timerRef.current = setTimeout(() => {
      void run(query);
    }, debounceMs);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [query, enabled, debounceMs, run]);

  const clear = useCallback(() => {
    requestIdRef.current++;
    setQuery("");
    setConcept(null);
    setError(null);
    setLoading(false);
  }, []);

  const refresh = useCallback(async () => {
    if (query) await run(query);
  }, [query, run]);

  return { query, setQuery, concept, loading, error, clear, refresh };
}
