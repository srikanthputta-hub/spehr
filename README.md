# S.P.E.H.R.

S.P.E.H.R. is an autonomous, AI-driven virtual hospital simulation running on **100% synthetic data** —
no real PHI. It self-admits and self-discharges simulated patients on a schedule and generates its own
clinical activity (orders, notes, vitals, billing, logs) organically over time, rather than replaying a
fixed dataset.

Paired with **MySpehr**, a separate FHIR-native patient portal that reads the same FHIR server but does
not talk to S.P.E.H.R. directly.

Live at [spehr.live](https://spehr.live) / [www.spehr.live](https://www.spehr.live).

## Stack

- **Frontend**: React + TypeScript, [TanStack Start](https://tanstack.com/start), hosted standalone on
  Cloudflare Workers (built via nitro's `cloudflare-module` preset). No third-party app-builder platform
  is involved in the runtime or build.
- **Backend**: [Supabase](https://supabase.com) (PostgreSQL, ~70 tables + Edge Functions/Deno).
- **Terminology**: [Medblocks](https://medblocks.com) HAPI FHIR R4 server, plus UMLS terminology lookups
  via the `umls-proxy` Supabase Edge Function.
- **MCP server**: the app exposes its own MCP server at `/mcp` (3 tools), built on the official
  `@modelcontextprotocol/sdk`.

## Running locally

Requires Node `^20.19.0` or `>=22.12.0` (see `engines` in `package.json`).

```bash
npm install
npm run dev
```

Other scripts (see `package.json`):

| Script | Purpose |
|---|---|
| `npm run dev` | Start the Vite dev server (`vite dev`) |
| `npm run build` | Production build (`vite build`) |
| `npm run build:dev` | Development-mode build |
| `npm run preview` | Preview a production build |
| `npm run lint` | Lint with ESLint |
| `npm run format` | Format with Prettier |

You'll need a `.env` with Supabase connection details (`SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`,
`SUPABASE_SERVICE_ROLE_KEY`, plus a `VITE_`-prefixed publishable key/URL pair for the client) and the
Edge Function secrets documented in `CLAUDE.md` (`UMLS_API_KEY`, `FHIR_SERVER_URL`, `FHIR_BEARER_TOKEN`,
`GEMINI_API_KEY`) — `.env` is gitignored and not included in this repo.

Two Supabase projects currently exist (production, and a migration target being staged) — see
`CLAUDE.md` for which one is which and the current migration status before pointing a local build at
either.

## Disclaimer

All patient data in this project is synthetic. No real patient information is used or stored anywhere
in this system.

## More detail

`CLAUDE.md` at the project root has the full picture: architecture notes, the in-progress Supabase
migration, active vs. retired Edge Functions, the Medical Dictionary subsystem, and known non-bugs.
