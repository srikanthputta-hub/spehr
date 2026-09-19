# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Earlier project history predates this changelog and is not reconstructed here — entries start from
2026-09-18.

## [Unreleased]

### Removed

- Lovable dependency fully removed from the codebase: no `@lovable.dev/*` packages, no `.lovable/`
  directory, no Lovable preview-auth broker, no Lovable-generated MCP routes. The app's own MCP server
  (`/mcp`, 3 tools) now runs on the official `@modelcontextprotocol/sdk`.
- `.env` untracked from git (was previously committed; now removed and covered by an explicit
  `.gitignore` rule, see below).

### Changed

- AI concept extraction (`nlp-extract-concepts` Edge Function) switched from OpenAI to Google Gemini
  (`gemini-3.5-flash-lite`, free tier) via a raw `fetch` call. Env var renamed `OPENAI_API_KEY` →
  `GEMINI_API_KEY`; fallback contract unchanged (429/error → `{concepts: [], error: ...}`, HTTP 200).
- `www.spehr.live` custom domain added alongside `spehr.live`.
- Supabase client error messages (`src/integrations/supabase/client.ts`,
  `client.server.ts`, `auth-middleware.ts`) updated to reference plain environment variables instead of
  "Connect Supabase in Lovable Cloud."
- Site metadata in `src/routes/__root.tsx`: `author` meta tag changed from "Lovable" to "S Group";
  `twitter:site` (`@Lovable`) removed.
- Comment in `src/routes/api/public/umls-search.ts` updated to no longer reference Lovable auth.
- `codeShapeMatches` in `src/hooks/useAutoTerminologist.ts` exported (was module-private); the pending
  `terminology_requests` query now also selects `requested_at`.
- `package.json` gains an explicit `engines` field (`node: "^20.19.0 || >=22.12.0"`).

### Added

- `.gitignore` now explicitly excludes `.env`, `.env.*` (with a `.env.example` exception) to prevent
  secrets from landing in git history.
