# Lint Cleanup Plan: Line-Ending Normalization

## Root cause
No `.gitattributes` exists. `.prettierrc` has no `endOfLine` key, so Prettier defaults to `"lf"`.
Local `git config core.autocrlf` is `true`, which checks files out with CRLF on Windows. Every
`.ts`/`.tsx` file sampled has CRLF terminators. Result: `prettier/prettier` flags nearly every
line as "Delete `␍`" — mechanical noise, not real style violations, accounting for the bulk of
the ~67k errors.

## 1. Safe normalization sequence
1. Add `.gitattributes` at repo root: `* text=auto eol=lf` (plus explicit `binary` rules for
   known binaries — images, fonts, `.ico`, etc. — `text=auto` alone usually detects binaries
   correctly via content-sniffing, but pin known ones explicitly to be safe).
2. Commit `.gitattributes` by itself.
3. Run `git add --renormalize .` — this rewrites tracked files' line endings in the index per
   the new attributes without touching the working tree content meaning, then `git status` to
   review scope (should be almost every text file, zero binaries).
4. Commit as a single, dedicated commit, e.g. "Normalize line endings to LF repo-wide", nothing
   else in that commit.
5. Do NOT change `core.autocrlf` mid-stream for other contributors without telling them — after
   `.gitattributes` lands, Git normalizes on checkout/checkin regardless of local `autocrlf`, but
   existing local clones should `git add --renormalize .` themselves once, or re-clone.

## 2. Is `eslint --fix` alone safe repo-wide?
Not recommended unsupervised, even though most errors are mechanical. `eslint --fix` invokes
Prettier's formatter, which can also reflow wrapping, quote style, and trailing commas in files
that were never actually reviewed — mixing "delete stray CR" with substantive formatting churn
in the same diff, and running it before line endings are fixed means it would fight
`core.autocrlf` and reintroduce CRLF on the next checkout. Better: do the `.gitattributes` +
renormalize pass first (step 1) — that alone should eliminate the vast majority of the 67k
errors. Then run `eslint --fix` as its own separate, reviewed commit to catch whatever real
Prettier-formatting deltas remain, diffed and skimmed before merging.

## 3. Recommended order of operations
1. `.gitattributes` commit (schema/policy only, no file content changes).
2. `git add --renormalize .` commit (line-ending normalization only — large diff, but
   mechanical/reviewable via `--stat` and spot checks, and git blame `-w` ignores whitespace).
3. Separate PR/commit: `eslint --fix` for genuine remaining formatting issues, hand-reviewed.
4. Only after 1–3 land and `npm run lint` is clean (or has a small, triaged remainder), turn on
   lint as a CI gate in a final, separate change.

Keep each step its own commit/PR so review stays tractable and `git blame` only needs `-w` to
see past the normalization commit.
