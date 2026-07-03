import { useCallback, useEffect, useRef } from "react";

/**
 * Coalesces bursts of realtime events into a single trailing call.
 * Use it to wrap `load()` so a flood of postgres_changes updates
 * doesn't fire dozens of parallel Supabase queries or flash the
 * "loading" skeleton on every event.
 */
export function useDebouncedRefresh(fn: () => void | Promise<void>, delayMs = 250) {
  const fnRef = useRef(fn);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    fnRef.current = fn;
  }, [fn]);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  return useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      void fnRef.current();
    }, delayMs);
  }, [delayMs]);
}

export default useDebouncedRefresh;