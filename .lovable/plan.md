Replace `extractSnomedCodes` in `src/lib/safety-alerts-engine.ts` with the 6-stream-aware version provided by the user.

Changes:
- Add primary loops for `stream_a` and `stream_b`, reading `snomed_code`, `snomed_display`, `display_text`, and `term`.
- Keep the existing legacy fallback loop for top-level `SNOMED CT` / `snomed` / `SNOMED` / `snomed_ct` keys.
- No other file changes.

No risks or open questions — the implementation code was provided verbatim.