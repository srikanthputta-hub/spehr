/**
 * Origin allowlist for the unauthenticated `/api/public/*` TanStack routes
 * (umls-search, umls-validate-code, directory). These routes have no auth of
 * their own — they relay UMLS_API_KEY or read staff-roster data — so this is
 * the equivalent of the Supabase Edge Function CORS allowlist described in
 * docs/edge-function-auth-hardening-plan.md's Stage 0, adapted for
 * Nitro/TanStack request handlers instead of the Supabase `_shared/` folder.
 *
 * Defense-in-depth only, same honest framing as Stage 0: this stops a
 * hostile web page from using a visitor's browser to call these routes
 * cross-origin. It does nothing against curl or server-to-server calls —
 * those never send a browser Origin header, so they are not addressed here.
 * Real protection for the UMLS key is a separate, larger effort (see the
 * plan's later stages).
 */

// spehrancillary.live and spehranalytics.live were removed from this allowlist on 2026-09-19 as
// part of a scope narrowing to spehr.live + MySpehr as the active 2-domain architecture (see
// CLAUDE.md's Product topology section) — NOT because those domains are offline. They're still
// live, just no longer actively maintained or designed around from this repo, so they no longer
// need cross-origin access to these routes.
const ALLOWED_ORIGINS = new Set(["https://spehr.live", "https://www.spehr.live"]);

// Matches the Vite dev server port (vite.config.ts: server.port = 8080) on
// localhost/127.0.0.1/[::1], any port scheme, for local development only.
const LOCALHOST_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]):8080$/;

export function isAllowedOrigin(origin: string | null): boolean {
  if (!origin) return false;
  if (ALLOWED_ORIGINS.has(origin)) return true;
  return LOCALHOST_ORIGIN_RE.test(origin);
}

/**
 * Builds CORS headers for an allowed origin (echoes it back), or an empty
 * object when the origin isn't allowed — callers should treat "no
 * Access-Control-Allow-Origin header" plus a 403 body as the rejection.
 */
export function corsHeadersFor(
  origin: string | null,
  extra: Record<string, string> = {},
): Record<string, string> {
  if (!isAllowedOrigin(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin as string,
    Vary: "Origin",
    ...extra,
  };
}

/**
 * Returns a 403 Response when the request's Origin header is present and not
 * in the allowlist. Returns null when the request should proceed (no Origin
 * header at all — e.g. curl/server-to-server — or an allowed browser Origin).
 */
export function rejectDisallowedOrigin(request: Request): Response | null {
  const origin = request.headers.get("Origin");
  if (origin === null) return null; // non-browser caller; CORS doesn't apply
  if (isAllowedOrigin(origin)) return null;
  return new Response(JSON.stringify({ error: "Origin not allowed" }), {
    status: 403,
    headers: { "Content-Type": "application/json" },
  });
}
