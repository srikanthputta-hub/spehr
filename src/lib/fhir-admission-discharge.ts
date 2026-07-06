/**
 * FHIR R4 Admission + Discharge bundle builders — thin re-export.
 *
 * The actual implementation lives in
 * `supabase/functions/_shared/fhir-admission-discharge.ts` so both the
 * client-side Auto Doc server pipeline and the server-side
 * `ghost-discharge-worker` edge function share ONE Composition builder
 * (Hospital Course, Labs, Meds sections all sourced from the same
 * per-encounter data). Do NOT fork the source here.
 */
export * from "../../supabase/functions/_shared/fhir-admission-discharge";