# Task sources-12 fix round 1 — PR #1443 (branch `feat/sources-nextleveljobs`, head 3175d5ead)

Original task: `task-sources-12-nextleveljobs.md` (same directory). Reviews: code+security+spec APPROVE (L=4, M
items deferred to the owner), second-opinion beam/flint (2 lows accepted). Resolve all findings below.

## Findings to resolve

| ID | Sev | Where | Decision |
| --- | --- | --- | --- |
| CR-L-1 | L | `providers/sources/nextleveljobs.provider.ts` detail loop (`unseenNewestFirst` + per-run cap 25) | A detail page that keeps failing (404, no JSON-LD) is re-fetched every run, eats the cap and drives a false PARSE_DRIFT. Smallest fix that stops it: failing ids must not starve fresh ids and must not count as drift on their own every run (e.g. a per-run cap on retried-after-failure ids, or exclude permanent 404/410 from the drift ratio). State the choice in a code comment. Test: a sitemap whose newest ids 404 still processes the next fresh ids, and no PARSE_DRIFT from 404s alone |
| CR-L-2 + SO flint | L | `APPLY_BUTTON` regex | `\bhref` also matches `data-href`, and the regex can match an "Apply here" link inside the description. Require whitespace before `href` and scope the match to the apply button (its container/class in the fixture), not any anchor. Tests: `data-href` ignored; no button + description link "Apply here" -> no employer ATS url |
| CR-L-3 | L | `SITEMAP_MAX_BYTES` comment | "8x" headroom is wrong. Write the real ratio vs the current sitemap size measured in the fixture/research (or pin it with a test) |
| CR-L-4 | L | Stryker suppression around `identityKeyOf` | Split the guard so only the equivalent mutant is suppressed, line-scoped, with the reason |
| SO beam | L | `JOB_URL` regex | Accept uppercase hex ids (`[0-9a-fA-F]{24}`) and normalise the id to lowercase before identity/dedup. Test |

Out of scope (owner decision batch, do NOT change): `enabled=false` default; Ashby org-UUID dedup.

## Do

TDD (failing tests first), then fixes. No DDL. Integration specs only on scratch DB `crm_qa_s12_r1`
(`DATABASE_URL` inline, never crm_db). Run the provider unit specs, `pnpm --filter @crm/api test`, typecheck, eslint
on changed files, prettier, mutation gate `node scripts/devops/mutation-gate.mjs --changed`.

The PR branch may be checked out in another worktree. Work on a local branch `fix/sources-12-r1` from
`origin/feat/sources-nextleveljobs` and push fast-forward with `DATABASE_URL= git push origin HEAD:feat/sources-nextleveljobs`.

Commit `fix(job-sourcing): NLJ retry budget, scoped apply button, uppercase ids` with
`ac_verified: CR-L-1,CR-L-2,CR-L-3,CR-L-4,SO-beam,SO-flint`. Report `Worktree:`, `Pushed: <branch> @ <sha>`
(verify with `git ls-remote origin feat/sources-nextleveljobs`), test counts (non-zero), mutation result,
`Findings resolved (6)`.

## Rules

Zone `apps/api/**` only. No `--no-verify`, explicit `git add`. No second-opinion. No external GETs needed (use
fixtures). Notes server: `notes.search` before reading code, `notes.add` facts with file:line.
