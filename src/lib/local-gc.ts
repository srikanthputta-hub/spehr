import { supabase } from "@/integrations/supabase/client";

// 48-hour TTL for any locally-cached data.
const TTL_MS = 48 * 60 * 60 * 1000;

// localStorage keys treated as local cache. Pattern-matched too (prefix `spehr.`).
const KNOWN_KEYS = ["spehr.pending_writes.v1"];

function purgeLocalStorage(): number {
  if (typeof window === "undefined") return 0;
  let purged = 0;
  const now = Date.now();
  const cutoffISO = new Date(now - TTL_MS).toISOString();

  // 1) Outbox-style arrays of { at: ISO } items — drop expired entries
  for (const key of KNOWN_KEYS) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      const list = JSON.parse(raw);
      if (!Array.isArray(list)) continue;
      const kept = list.filter((it: { at?: string; created_at?: string }) => {
        const ts = it?.at ?? it?.created_at;
        return !ts || ts > cutoffISO;
      });
      const removed = list.length - kept.length;
      if (removed > 0) {
        purged += removed;
        if (kept.length === 0) localStorage.removeItem(key);
        else localStorage.setItem(key, JSON.stringify(kept));
      }
    } catch {
      /* ignore */
    }
  }

  // 2) Generic `spehr.cache.*` keys storing `{ at, value }`
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith("spehr.cache.")) continue;
      try {
        const v = JSON.parse(localStorage.getItem(k) ?? "null");
        const ts: string | number | undefined = v?.at ?? v?.created_at ?? v?.expires_at;
        const expired =
          typeof ts === "number"
            ? ts < now - TTL_MS
            : typeof ts === "string"
              ? new Date(ts).getTime() < now - TTL_MS
              : false;
        if (expired) {
          localStorage.removeItem(k);
          purged++;
        }
      } catch {
        /* ignore single key */
      }
    }
  } catch {
    /* ignore */
  }

  return purged;
}

/**
 * Garbage-collect local cache entries older than 48 hours.
 *
 * SAFETY: Touches ONLY the local app cache (browser localStorage + the
 * project's local mirror tables via the `purge_expired_local_cache` RPC).
 * It NEVER issues DELETE requests to the external Medblocks FHIR server —
 * that remains the permanent source of truth.
 */
export async function purgeExpiredLocalData(): Promise<void> {
  const localPurged = purgeLocalStorage();

  let dbPurged = 0;
  try {
    const { data } = await supabase.rpc("purge_expired_local_cache" as never);
    if (data && typeof data === "object") {
      dbPurged = Object.entries(data as Record<string, unknown>)
        .filter(([k]) => k !== "cutoff")
        .reduce((sum, [, v]) => sum + (typeof v === "number" ? v : 0), 0);
    }
  } catch {
    /* offline / RPC missing — local sweep still runs */
  }

  const total = localPurged + dbPurged;
  // eslint-disable-next-line no-console
  console.info(`[Garbage Collection] Successfully purged ${total} expired local FHIR records`);
}

let scheduled = false;
/** Run a sweep now and every 6h thereafter. Idempotent. */
export function startLocalGcSweeper(): void {
  if (scheduled || typeof window === "undefined") return;
  scheduled = true;
  // Defer initial sweep so it never blocks first paint
  setTimeout(() => { void purgeExpiredLocalData(); }, 4_000);
  setInterval(() => { void purgeExpiredLocalData(); }, 6 * 60 * 60 * 1000);

  // Sanitize local state between sessions
  try {
    supabase.auth.onAuthStateChange((event) => {
      if (event === "SIGNED_IN" || event === "SIGNED_OUT") {
        void purgeExpiredLocalData();
      }
    });
  } catch {
    /* ignore */
  }
}