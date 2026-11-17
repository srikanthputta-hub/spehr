/**
 * Auto Terminologist cycle — thin re-export.
 *
 * The actual implementation lives in
 * `supabase/functions/_shared/auto-terminologist-cycle.ts` so that both
 * `src/hooks/useAutoTerminologist.ts` (client-side, convenience trigger
 * while a tab is open) and the server-side `auto-terminologist-cycle`
 * edge function (invoked every 10 minutes by `pg_cron`, regardless of
 * whether any tab is open — this is what actually fixes the reliability
 * gap) share the exact same cycle logic. Do NOT duplicate or fork the
 * source here — every rule change must land in the shared file so the two
 * trigger paths stay bit-identical. Same pattern as
 * `discharge-narrative.ts` → `supabase/functions/_shared/discharge-narrative.ts`.
 */
export * from "../../supabase/functions/_shared/auto-terminologist-cycle";
