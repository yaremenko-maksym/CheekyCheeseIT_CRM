# Review round 2 — PR #1445 (branch `feat/sources-dice-nofluff`, head ca71ed7f2, base `main` @ 4c1d2bc1f)

READ-ONLY. Do not edit, create or commit any file in any checkout. Do not post to GitHub: return your review text.

## What changed since round 1 (head 422daa5e6)

One commit, `ca71ed7f2`, resolves the 14 round-1 findings listed in `.claude/tasks/task-sources-14-fix-round1.md`
(read it first: it is the spec for this round). Delta diff (1545 lines): `.claude/tasks/pr1445-r2.diff`. Paths are
relative to the repo root `/Users/maksym/.t3/worktrees/CheekyCheeseIT_CRM/t3-e2d4e8c0-f9e0b534f5d3bb43`. That
checkout's HEAD is OLD: read files with `git show origin/feat/sources-dice-nofluff:<path>` after `git fetch origin`.
Earlier context: `task-sources-14-dice-nofluff.md`, `task-sources-14-rebase-r1.md`, `task-sources-14-review-r1.md`.

The round touches SHARED code used by already-live sources (JustJoin / Landing / The Hub sitemap trio and Next Level
Jobs): `providers/sources/metered-fetch.ts` (redirect admission) and `providers/sources/sitemap-jsonld.ts` (extracted
`turningSelectionOf`, `countsTowardDrift`, `isDetailDrift`, `siteIdentityKey`). The coder says their specs were not
edited and pass.

Coder claims: `src/job-sourcing` 270 files / 11 329 tests passed; seed-delta integration 25 passed on scratch DB;
typecheck 0; mutation `--changed` 754 mutants / 746 killed / 0 survived / 7 ignored (one new suppression on
`roundRobin` `i <= longest`). Coder assumptions (PR body): robots content-type judged only when a header is present
(prod passes no response headers to adapters, so only the "body starts with `<`" check applies); a detail 3xx/404 is a
request but not counted in `raw`; NFJ foreign-canonical samples now read `json-ld: none`. Known risk: two adjacent
top postings both 200 without JSON-LD end every run early until the listing changes.

## Your axis

- **code-reviewer**: correctness of the delta; behaviour change for the sitemap trio and NLJ through the shared
  helpers and `metered-fetch` (any change to what they fetch, select, or count as drift is a finding); the indexOf
  scans (same results as the old regexes, terminator handling); round-robin + turning share; per-item listing
  tolerance; the restored collect-all-types check; TS strict; zone `apps/api/**`.
- **security-reviewer** (mandatory, PROHIBITED lift): redirects never followed for listing / detail / robots, and
  nothing can reach a robots-disallowed or off-host URL; robots fail-closed really holds in prod given no headers;
  challenge early-stop cannot be bypassed and is not an evasion; no ReDoS left in the delta; `metered-fetch`
  change does not open redirects for other callers; the owner-decision lift still scoped to Dice's own variant.
- **spec-reviewer**: delta vs `task-sources-14-fix-round1.md`: each of the 14 IDs resolved as decided, nothing
  missing, no scope creep; the PR body (`gh pr view 1445 --json body`) has the S3/S4/S6 text.

Also say whether each round-1 finding of your axis is resolved.

## Output (first lines exactly, then findings)

code-reviewer: `Verdict: APPROVE` or `Verdict: BLOCK`
security-reviewer: `Security Review: APPROVE` or `Security Review: BLOCK`
spec-reviewer: `Spec Review: PASS` or `Spec Review: FAIL`

Then `Findings: H=<n> M=<n> L=<n> (<total>)`, then one line per finding:
`<id> | <H/M/L> | <path>:<symbol or line> | <problem> | <smallest fix>`. Real problems only, no style nits, no praise.
Notes server: `notes.search` before reading code; `notes.add` facts with file:line.
