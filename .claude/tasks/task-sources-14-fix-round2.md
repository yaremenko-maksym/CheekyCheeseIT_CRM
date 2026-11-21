# Task sources-14 fix round 2 — PR #1445 (branch `feat/sources-dice-nofluff`, head ca71ed7f2, base `main`)

Earlier: `task-sources-14-fix-round1.md` (same directory). Review round 2: code APPROVE (L=1), security BLOCK
(M=1 L=1), spec PASS, second-opinion 2 more confirmed. Resolve all below. Collector =
`providers/sources/listing-detail.collector.ts` (detail loop in `collectListingDetail`).

| ID | Sev | Where | Decision |
| --- | --- | --- | --- |
| SR2-M-1 | M | `sitemap-jsonld.ts` `CANONICAL_LINK` (used by `canonicalUrlOf`, reached from NFJ through `selectByCanonical`) | `/<link\b[^>]*\brel="canonical"[^>]*>/` is quadratic on repeated unclosed `<link `: measured 1.2 MB = 102 s synchronous block; NFJ detail cap 2 MiB. Pre-existing on main (live for JustJoin), but this PR routes untrusted NFJ pages to it. Replace with an `indexOf` scan: each `<link`, the text up to the next `>` (none = stop), test it for the same `rel="canonical"` + href extraction the current code does. Same results on all existing fixtures; trio + NLJ specs pass unedited. Spec: 2 MiB of repeated `<link ` (no `>`) and of repeated `<link rel="x">` both finish < 100 ms. Grep the job-sourcing tree for other lazy / `[^>]*` regexes run on untrusted page bodies in the files this PR touches and report them (fix only if the same class) |
| SR2-L-2 | L | collector detail loop, `isNoPage` branch | A redirect block (every detail answers 3xx) never stops the run: all detail requests go out, SUCCEEDED with raw 0, every run. Count consecutive detail 3xx (not 404) in a streak; 2 in a row end the run as `ACCESS_POLICY` (a block signal; no evasion, a stop). The 404 skip stays. Spec |
| CR2-L-1 | L | collector streak stop (`MAX_PAGES_WITHOUT_POSTING`) | The head of `due` is the newest unheld items and a page without a posting is never held, so 2 adjacent top postings that answer 200 without JSON-LD end every run at the same two pages; the rest and the turning slot are never read (PR #1443 D-1 starvation, one layer up). Fix so that a stuck head cannot starve the run: e.g. the streak stop fires only when the streak includes a page outside the head (`sorted.slice(0, max - turning)`) or after the turning slot was also tried; or read the turning slot first. Pick the smallest correct one, state it in the PR Assumptions, spec the starvation case (two bad head pages, a good third: the good one is read on that run). The challenge case (every page bad) must still stop early |
| BP2-L-1 | L | collector streak stop | `report()` already recorded the request; `fail()` (which also calls `report`) adds a second request report for the same fetch. Record the failure without a second request report (set the failure on the one report, or a `fail` variant that does not report). Spec: request count equals fetch count on the streak stop |
| BP2-L-2 | L | collector streak stop | It counts `invalid` but pushes no invalid sample (the select branch does). Push the same `json-ld: none` sample before stopping. Spec |
| FL2-L-1 (added after dispatch) | L | collector `isNotRobotsFile` | Prod `fetchText` returns `headers: {}` (`runtime/collection-context.ts` ~437), so the content-type branch never runs in prod; a 200 body that is JSON or plain text (a block message) parses as zero rules = allow-all. Also fail closed when the trimmed body is non-empty and has no line that is a robots directive (`user-agent:`, `disallow:`, `allow:`, `sitemap:`, `crawl-delay:`, case-insensitive, comments `#` and blank lines ignored). An empty body stays allow-all (standard). Spec: JSON body and a plain-text sentence both stop the run |

## Do

TDD (failing tests first), then fixes. No DDL. If manifest outputs change, regenerate (`job-sources:manifest:generate`)
and run the seed-delta integration spec on scratch DB `crm_qa_s14_r2` (`DATABASE_URL` inline, never crm_db; the
filter must contain `integration.spec`). Run `src/job-sourcing` specs, typecheck, eslint on changed files, prettier,
mutation gate `node scripts/devops/mutation-gate.mjs --changed` (alone, not during a push).

Work from `origin/feat/sources-dice-nofluff` (head ca71ed7f2). Push early `wip:` commits (fast-forward). Final commit
`fix(job-sourcing): linear canonical scan, redirect-block and head-starvation stops, review round 2` with
`ac_verified: SR2-M-1,SR2-L-2,CR2-L-1,BP2-L-1,BP2-L-2,FL2-L-1`. Push `DATABASE_URL= git push origin HEAD:feat/sources-dice-nofluff`
(pre-push long: background, wait, one push). PR body: update for the new head (file + `gh pr edit 1445 --body-file`),
read `.claude/rules/common/doc-durability.md` first; add the CR2-L-1 choice to Assumptions; keep the first `Task:` line,
appending `, fix2: task-sources-14-fix-round2.md` inside its parentheses.

Report: `Worktree:`, `Pushed: <branch> @ <sha>` (verify `git ls-remote`), test counts (non-zero), mutation result,
whether trio/NLJ specs changed (they must not), the regex grep result, `Findings resolved (6)`.

## Rules

Zone `apps/api/**` (+ the PR body). Every Edit/Write path starts with your own `git rev-parse --show-toplevel`. No
`--no-verify`, explicit `git add`, never create `.claude/.allow-direct-edits`. No second-opinion. No external GETs.
No secrets or personal data. Notes server: `notes.search` before reading code, `notes.add` facts with file:line.
