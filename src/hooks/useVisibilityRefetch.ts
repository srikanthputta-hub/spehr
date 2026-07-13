import { useEffect, useRef } from "react";

/**
 * Re-invokes `callback` when the tab returns to the foreground.
 * Listens to both `visibilitychange` (visible) and `window.focus`,
 * debounced so both firing together only produces one call.
 * Long-idle background tabs get their setInterval timers throttled
 * and realtime channels silently dropped by the browser; this hook
 * gives components an immediate catch-up refetch on tab re-focus.
 */
export function useVisibilityRefetch(callback: () => void | Promise<void>, debounceMs = 150) {
  const cbRef = useRef(callback);
  useEffect(() => {
    cbRef.current = callback;
  }, [callback]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const trigger = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void cbRef.current();
      }, debounceMs);
    };
    const onVis = () => {
      if (document.visibilityState === "visible") trigger();
    };
    const onFocus = () => trigger();
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("focus", onFocus);
    return () => {
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("focus", onFocus);
    };
  }, [debounceMs]);
}

export default useVisibilityRefetch;