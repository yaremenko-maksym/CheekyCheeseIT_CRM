# Task sources-04 fix round 1 — PR #1429 (Working Nomads, The Muse, SmartRecruiters)

Parent task: `.claude/tasks/task-sources-04-wn-muse-smartrecruiters.md`. Branch
`feat/sources-04-wn-muse-smartrecruiters`, head `e421448b6`.

Reviews on the PR (read each in full: `gh api repos/yaremenko-maksym/CheekyCheeseIT_CRM/pulls/1429/reviews`):
code review (Verdict: BLOCK, 11 findings), spec review (APPROVE / ISSUES, 5), security review
(APPROVE, 3). Total 19. Resolve all of them; for any you disagree with, say why in the PR body.

## Blocking (CI red on this head)

- **CR-H-1** `manifest.seed-delta.integration.spec.ts` — 5 cases fail in `Integration Tests (Postgres)`
  (row count 15→16, Muse no longer BLOCKED, Working Nomads no longer the blocked-type-no-entry row,
  VERIFIED-vs-BLOCKED, step-5 refresh at :470). Update them. The blocked-type-no-entry case needs a
  constructed row (`euremotejobs.rss.feed` IS a claiming entry). Run integration specs against a
  scratch DB with `DATABASE_URL` inline (`SELECT current_database()` first; never `crm_db`) — a push
  with `DATABASE_URL=` empty skips them, so local green proves nothing here.
- **CR-H-2** Mutation Gate (@crm/api): 28 survivors + 15 NOT VERIFIED in
  `boards/smartrecruiters.boards.ts`, `sources/workingnomads.provider.ts`, `manifest.definitions.ts`.
  Add killing assertions (board-table pin, `nativeIdOf` table incl. trailing slash / suffixed path /
  non-job URL, `tagsOf` boundaries, `pageRequest` header + cache key, `limits` assertion). Suppress
  only genuinely unobservable ones with a line-scoped `// Stryker disable next-line <mutator>: <why>`.
  Run the mutation gate locally on the changed files before the final push (see
  `docs/runbooks/mutation-gate-runbook.md`); report the survivor count.

## Body / docs / small code

- **CR-M-1** Rewrite the A2 SmartRecruiters decision honestly: offset paging over a reordering list
  SKIPS postings; "nothing is lost" is false. State the real trade-off (skips + ~304 runs per pass;
  the 2/min figure is the uniform BOARD-host floor of owner decision 11). Recommendation stays
  owner-side. Paging by a stable key only if the API offers one — otherwise say it does not.
- **SPEC-M-1** AC 3 "enabled" half: rows land `enabled = false` by design; enabling is ADMIN
  (`setEnabled`). Record it under `## Assumptions` and narrow the final commit trailer to
  `ac_verified: 1,2,4 (3 — rows land disabled; enabling is an ADMIN action outside the deploy path)`.
- **SPEC-M-2** The SmartRecruiters detail GET: the owner brief for this program says "External GETs
  to the listed job sites are owner-approved for diagnosis, captures and smokes". Cite that in the
  body; keep the capture.
- **SPEC-M-3 / CR-L-3** Complete the out-of-zone file list in the body (registry pair, 3 registry
  specs, both fixture-provenance specs, `job-sourcing-collect-all-types.spec.ts`, the trim script),
  each with the AC that required it.
- **SPEC-L-1** Note in the body that `smartrecruiters` is a control board; a third hiring board is a
  follow-up (Master records it). Do not edit the parent task file.
- **SPEC-L-2 / CR-L-1** Comment in `job-sourcing-collect-all-types.spec.ts`: name `WORKINGNOMADS_API`.
- **CR-L-2** Step attribution: step 1 (adopt), not step 5, lifts the Working Nomads block — fix the
  body and the `manifest.drift.spec.ts` comment.
- **CR-L-4** `manifest.boards.spec.ts` watchlist arithmetic: derive cost from each type's
  `requestsPerRun`.
- **CR-L-5** One shared exported `PAGED_BOUNDS` test helper instead of three copies.
- **CR-L-6 / SR-L-3** Muse `perHour` below the vendor's 500 keyless ceiling (e.g. 400), and pin it.
- **CR-L-7** Drop the tautological `toBeLessThanOrEqual(5)` or assert the budget instead.
- **CR-L-8** Reconcile the Working Nomads provenance sentences and the `pub_date` example.
- **SR-L-1** `SMARTRECRUITERS_ATS` catalog `detailMode` / `detailPerRun` must reflect the detail
  request per posting.
- **SR-L-2** Stale seed-SQL header ("no source is runnable … until plan Task 2.5") — correct the
  generator text and regenerate.

## Rules

Regenerate artefacts with `pnpm --filter @crm/api job-sources:manifest:generate`, never by hand.
`wip:` pushes as you go; push with `DATABASE_URL= git push` (background for long pushes); final
commit carries the narrowed `ac_verified:`. Never --no-verify. Update the PR body via
`gh pr edit 1429 --body-file`. No IP addresses or personal data. Notes server: `notes.search` before
reading code, `notes.add` for facts with file:line. Do not run second-opinion.

Report: `Worktree:`, `Pushed: <branch> @ <sha>` (ls-remote), `Findings: resolved N / disagreed M (ids)`,
`Tests:` unit + integration counts, mutation survivors, `Skills:`.
