# Review round 1 — PR #1445 (branch `feat/sources-dice-nofluff`, head 422daa5e6, base `main` @ 4c1d2bc1f)

READ-ONLY. Do not edit, create or commit any file in any checkout. Do not post to GitHub: return your review text.

## What the PR is

Two new job sources: Dice (`DICE_HTML`: the /jobs listing pages' flight payload + /job-detail JSON-LD, robots.txt
obeyed in code) and No Fluff Jobs (`NOFLUFF_HTML`), on main's shared collectors (`createMeteredFetch`,
`selectByIdentity`, `canonicalUrlOf`). Dice's terms are PROHIBITED: it carries main's `ACCEPT_PROHIBITED_RISK`
owner decision (owner accepted the ToS risk for every site; technical blocks — 403 / 429 / bot challenge — stay a
hard stop: NO_EVASION). NFJ is UNCLEAR and carries `ACCEPT_RISK`. Seed-delta pin 25 -> 27.

- Original task: `.claude/tasks/task-sources-14-dice-nofluff.md`; rebase: `.claude/tasks/task-sources-14-rebase-r1.md`
- Full diff (4391 lines): `.claude/tasks/pr1445-r1.diff` (paths relative to the repo root
  `/Users/maksym/.t3/worktrees/CheekyCheeseIT_CRM/t3-e2d4e8c0-f9e0b534f5d3bb43`; that checkout's HEAD is OLD — read
  PR files with `git show origin/feat/sources-dice-nofluff:<path>` after `git fetch origin`, never from the working tree).

Coder claims: `src/job-sourcing` 270 files / 11 296 tests passed; seed-delta + production-registry integration 28
passed on a scratch DB; mutation 621 / 613 killed / 0 survived. Rebase notes: `job-sourcing-collect-all-types.spec`
lost the check "a SCHEDULED-only source is skipped on a MANUAL run" (WTTJ is now the only HTML type without an
adapter); `jsonLdDates` duplicates dates mapping that main does inline in `mapSitePosting` (listed as follow-up).

## Your axis

- **code-reviewer**: correctness, edge cases (listing payload parsing, pagination, robots rules, detail cap,
  identity/dedup), broken callers/tests, TS strict, zone-of-write (`apps/api/**` only), regression risk for the
  sitemap trio and Next Level Jobs (their specs must pass unchanged), the lost collect-all-types check.
- **security-reviewer** (mandatory: a PROHIBITED lift): is `ACCEPT_PROHIBITED_RISK` scoped to Dice's own endpoint
  variant only; can anything here lift a technical block, a NO_EVASION entry, DOU / WTTJ / The Muse? Robots.txt
  rules really enforced before any fetch; SSRF / URL validation of listing and detail URLs (host pinning, redirects);
  response size and parse limits on untrusted HTML / flight payload; regex ReDoS; no UA spoofing / evasion; no
  secrets or personal data in fixtures.
- **spec-reviewer**: diff vs the two task files: uncovered AC, scope creep, done-wrong.

## Output (first lines exactly, then findings)

code-reviewer: `Verdict: APPROVE` or `Verdict: BLOCK`
security-reviewer: `Security Review: APPROVE` or `Security Review: BLOCK`
spec-reviewer: `Spec Review: PASS` or `Spec Review: FAIL`

Then `Findings: H=<n> M=<n> L=<n> (<total>)`, then one line per finding:
`<id> | <H/M/L> | <path>:<symbol or line> | <problem> | <smallest fix>`. Real problems only, no style nits, no praise.
Notes server: `notes.search` before reading code; `notes.add` facts with file:line.
