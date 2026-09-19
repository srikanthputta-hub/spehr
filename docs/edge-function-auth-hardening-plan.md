# Edge Function Auth & CORS Hardening — Staged Plan

Design only. Nothing here is implemented yet.

## The real constraint

All 14 functions are called by **anonymous browser sessions** — there is no login on
spehr.live, and role selection is not authentication. Three separately-deployed frontends
(spehr.live, spehrancillary.live, spehranalytics.live) plus MySpehr share these functions,
so any enforcement change made here can break apps outside this repo. `verify_jwt` is
meaningless today: the anon key in the bundle *is* a valid JWT. `_shared/` currently holds
only FHIR/narrative logic — no CORS or auth helper exists.

Realistic goal: stop being an open relay for the UMLS key and the FHIR server. Full
user auth + roles + RLS is a separate, much larger project (Stage 4).

## Stage 0 — `_shared/cors.ts` (cheap, do first)

One helper exporting `corsHeaders(req)`: echo `Origin` only if it is in an allowlist
(`https://spehr.live`, `https://www.spehr.live`, `https://spehrancillary.live`,
`https://spehranalytics.live`, MySpehr's domain, `http://localhost:*`, `*.workers.dev`
previews); otherwise omit `Access-Control-Allow-Origin`. Always send `Vary: Origin`.
Replace the 14 hand-rolled `"*"` literals with it.

Honest framing: this is defense-in-depth against a *hostile web page* using a visitor's
browser. It does nothing against `curl`. Do not treat it as the fix for gap 1.

## Stage 1 — `_shared/auth.ts` in log-only mode

Decode (do not reject on) the bearer JWT and classify the caller: bare anon key vs.
`role: "authenticated"` vs. `service_role`. Log `{fn, action, callerClass, origin}`.
Deploy to `qxyvmvtecnnwqeqaouzh` first. This gives real data on what the other two
domains send before anything is enforced.

## Stage 2 — anonymous sign-in, then enforce

`supabase.auth.signInAnonymously()` on app bootstrap gives every browser session a real
JWT with a distinct `sub` and `role: "authenticated"` — no login wall, no UX change. Then
`_shared/auth.ts` rejects bare-anon-key callers, gated per-function by an env flag
(`REQUIRE_SESSION=1`) so a rollback is a config change, not a redeploy. Requires the
other two frontends to adopt sign-in first — coordinate, do not flip unilaterally.

**Do not** put a shared secret in the browser bundle; it is as public as the anon key.
A shared secret/HMAC header *is* correct for the three `verify_jwt = false`
server-to-server functions (`fhir-inbound-webhook`, `fhir-inbound-poll`,
`fhir-outbound-poll`), which have no JWT at all today.

## Stage 3 — per-`sub` rate limits

Once every caller has a stable `sub`, add quota rows for umls-proxy actions and
fhir-proxy `PUT`/`DELETE`. This, not CORS, is what protects the UMLS key.

## Also fix (independent of the stages)

fhir-proxy Shape 1 forwards any Bundle unvalidated, so a `transaction` Bundle containing
`request.method: "DELETE"` entries bypasses the new passthrough allowlist entirely.
Validate Bundle `type` and per-entry methods against the same allowlist.
