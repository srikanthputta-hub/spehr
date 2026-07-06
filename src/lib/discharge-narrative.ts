/**
 * Discharge Narrative Builder — thin re-export.
 *
 * The actual implementation lives in
 * `supabase/functions/_shared/discharge-narrative.ts` so that both the
 * client-side physician-board discharge flow and the server-side
 * `ghost-discharge-worker` edge function share the exact same
 * `buildDischargeMarkdown` logic. Do NOT duplicate or fork the source
 * here — every rule change must land in the shared file so the two
 * discharge paths stay bit-identical.
 */
export * from "../../supabase/functions/_shared/discharge-narrative";