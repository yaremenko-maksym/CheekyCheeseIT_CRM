# Review round 1 — PR #1444 (branch `feat/sources-sitemap-trio-3`, head 6fb39b422, base `main` @ e7e4bfb02)

READ-ONLY. Do not edit, create or commit any file in any checkout. Do not post to GitHub: return your review text.

## What the PR is

Three new job sources (The Hub, JustJoin.it, Landing.jobs) on a shared sitemap + JSON-LD core
`apps/api/src/job-sourcing/providers/sources/sitemap-jsonld.ts`. Next Level Jobs (already on main, #1443) is
re-expressed as a site config on the same core. A new decision kind `ACCEPT_PROHIBITED_RISK` lets an owner
risk-acceptance lift a ToS-PROHIBITED ledger entry (owner accepted the ToS risk for all platforms; technical blocks —
403 / 429 / bot challenge — stay a hard stop: NO_EVASION). The seed-delta manifest gains 3 entries (22 -> 25).

- Original task: `.claude/tasks/task-sources-13-sitemap-trio.md`
- Rebase round (ports #1443 round-2 fixes D-1..D-4 + future-age into the core): `.claude/tasks/task-sources-13-rebase-r1.md`
- Full diff (3882 lines): `.claude/tasks/pr1444-r1.diff` (all paths are relative to the repo root
  `/Users/maksym/.t3/worktrees/CheekyCheeseIT_CRM/t3-e2d4e8c0-f9e0b534f5d3bb43`; that checkout's HEAD is OLD — read
  PR files with `git show origin/feat/sources-sitemap-trio-3:<path>` after `git fetch origin`, never from the working tree).

Coder claims: api tests 22143 passed; seed-delta 25 passed on scratch DB; mutation 687 killed / 0 survived / 1
zero-test mutant (`sitemap-jsonld.ts:271` comparator, hand-applied: 27 tests fail). Open items the coder flagged:
JustJoin.it `applyUrl` absence assumed to mean in-site apply (no drift signal) — unverified; The Hub / Landing.jobs
have no ATS link (AC3 partial); JustJoin.it reads 20 details per run against ~11k jobs (owner decision, not a finding).

## Your axis

- **code-reviewer**: correctness, edge cases, broken callers/tests, TS strict, zone-of-write (`apps/api/**` only),
  regression risk for Next Level Jobs behaviour on main (its spec must pass unchanged).
- **security-reviewer** (mandatory: a PROHIBITED lift): can `ACCEPT_PROHIBITED_RISK` lift anything other than a ToS
  PROHIBITED entry (e.g. a technical block, a NO_EVASION entry, DOU / WTTJ / The Muse)? Who can create it, is it
  audited, is it scoped per source? SSRF / URL validation on sitemap and detail URLs, response size limits, HTML
  parsing of untrusted input, no UA spoofing / evasion, no secrets.
- **spec-reviewer**: diff vs the two task files: uncovered AC, scope creep, done-wrong.

## Output (first lines exactly, then findings)

code-reviewer: `Verdict: APPROVE` or `Verdict: BLOCK`
security-reviewer: `Security Review: APPROVE` or `Security Review: BLOCK`
spec-reviewer: `Spec Review: PASS` or `Spec Review: FAIL`

Then `Findings: H=<n> M=<n> L=<n> (<total>)`, then one line per finding:
`<id> | <H/M/L> | <path>:<symbol or line> | <problem> | <smallest fix>`. Real problems only, no style nits, no praise.
Notes server: `notes.search` before reading code; `notes.add` facts with file:line.
