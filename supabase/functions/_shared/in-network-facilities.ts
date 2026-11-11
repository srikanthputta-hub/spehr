// Single source of truth for which destination facilities are considered
// "in-network" for the SPEHR system.
//
// Both the admin-dashboard UI (src/routes/admin-dashboard.tsx) and the
// transfer-delete-worker edge function (supabase/functions/transfer-delete-worker)
// import this SAME array — no forked copy on either side — so the two can
// never drift out of sync the way they did before this fix (the UI decided
// "in-network vs. outside-network" purely client-side, while the edge
// function that actually performs the irreversible delete never looked at
// `destination_facility` at all).
//
// Plain TS, no Deno- or browser-specific APIs, so it loads unmodified in
// both the Vite/browser bundle and the Deno edge runtime.
export const IN_NETWORK_FACILITIES_LIST = [
  "Memorial Hospital",
  "St. Jude Medical Center",
  "City General Infirmary",
  "County Health Pavilion",
  "Srik Health Clinic",
] as const;

export type InNetworkFacility = (typeof IN_NETWORK_FACILITIES_LIST)[number];

export function isInNetworkFacility(facility: string | null | undefined): boolean {
  if (!facility) return false;
  return (IN_NETWORK_FACILITIES_LIST as readonly string[]).includes(facility);
}
