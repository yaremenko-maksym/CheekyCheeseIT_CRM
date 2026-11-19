# Task sources-09 — RSS sources read 0 items on prod (root cause + fix)

Owner requirement: Djinni MUST store postings on prod. New PR from `origin/main` (branch
`fix/sources-09-rss-received-zero`). Merge order: #1433 (Djinni namespace) first, then #1428 (WWR), then this PR (CR-L-5, fix round 1).

## Master facts (prod, read-only aggregates, 2026-11-19, deploy 3cb9f9cae)

- Every enabled source built on `defineRssProvider` reads zero items: DJINNI_RSS 91 runs, sum(received) 0;
  WWR_RSS 34 runs, received 0. HTTP 200, `bytes_read` ≈ 420 KB for Djinni, `request_count` 1, no `error_code`,
  outcome SUCCEEDED, coverage PARTIAL, `newest_item_published_at` NULL.
- The sibling `defineXmlProvider` source works on the same build (PERSONIO_ATS 713 received / 72 created), and 18
  non-feed types read items. So XML decoding is not globally broken.
- `received` is `counts.raw`, and `counts.raw += 1` runs for every item in `observePage` BEFORE any quarantine
  (`providers/reporting-provider.ts`). So the namespace quarantine (PR #1428 / #1433) does NOT explain
  `received 0`: items never reach `observePage`.
- The same Djinni body (97 `<item>`) parses to 96 entries locally on main through the test path.
- Two surviving hypotheses: (a) `extractItems` / `decodeEnvelope` in `providers/rss.provider.ts` returns empty on
  the real runtime input (response headers: content-type/charset, content-encoding, the bytes vs string the
  transport hands over, a BOM, a size cap in the transport); (b) a short-circuit before `observePage` (the
  conditional-GET / validators branch: prod checkpoints carry `lastModified`, `etag null`; a RECENT-feed filter
  against the checkpoint; a page/byte limit).

## Do

1. Skill `diagnosing-bugs`: no hypothesis without a red command. Reproduce through the REAL runtime path
   (the transport + `CollectionContext` + the RSS binding as the cron runs it, not the unit-test fake), with the
   prod-shaped config (`{"primaryKeyword":"Python"}`, config_version 1), a checkpoint like prod's (validators
   `etag null`, `lastModified` set), and the live response INCLUDING its real headers. External GETs to djinni.co
   and weworkremotely.com are owner-approved for diagnosis; a 403/429/challenge ends it (no UA change, proxy or
   headless; record it). Run nothing inside the prod containers except the psql SELECT below; the prod
   image tag and env names (not values) may be read with `ssh crm-vps 'docker inspect ...'`. Prod DB: SELECT only, aggregates only, via
   `ssh crm-vps 'docker exec crm-postgres-1 psql -U crm_user -d crm_db -c "..."'`; run
   `SELECT current_database()` first.
2. Fix the root cause once in the shared code. Regression test that FAILS on main's behaviour (red-check it on
   main's code) and passes after, for both a Djinni-shaped and a WWR-shaped feed.
3. State the root cause in one sentence with file:line in the PR body. If you cannot locate it, stop and report
   what you ruled out with the commands — do not ship a guess.

## Rules

Zone `apps/**`, `packages/**`. Typecheck, eslint, prettier, unit tests, mutation gate on changed lines
(`node scripts/devops/mutation-gate.mjs --changed`). Integration specs only on a scratch DB, `DATABASE_URL`
inline, never `crm_db`. Commit with `ac_verified: 1,2,3`; first push early as a draft PR
(`DATABASE_URL= git push`, in the background; verify `git ls-remote`). PR title
`fix(job-sourcing): RSS sources read zero items on prod`, body with `Plan: .claude/tasks/task-sources-09-rss-received-zero.md`.
Never --no-verify. Notes server: `notes.search` first, `notes.add` facts with file:line. No second-opinion.
English only. Report: `Worktree:`, `Pushed:`, PR URL, root cause with file:line, `Tests:` counts, survivors.

## Assumptions

- A1: the counters are made honest at the TERMINAL write (`endRun` adds the attempt's non-kept
  count to both `received` and `invalid`), while `paged` and `last_nonempty_at` keep their
  "persisted" meaning — a run that stored nothing is still "not paged", it is merely no longer
  indistinguishable from an empty feed. Rollback is this one PR.
- A1: the regression cases use inline shaped feed bodies and pin the refusal on `MISSING_TITLE`
  rather than the committed captures' `MISSING_COMPANY` / `INVALID_NAMESPACE`, because those two
  refusal reasons are exactly what PRs #1428 and #1433 remove — a case resting on them would pass
  vacuously days from now. Both reasons land in the same `invalid` bucket of
  `toStoredReportCounts`, so the mechanism under test is the one prod hit.
- A1: the Task 4.6 single-writer guard (`write-gate.spec.ts`) is relaxed from "exactly one
  statement in the ledger increments `received`" to "exactly two, both the ledger's own, each
  identified by its own job". The fact the guard exists to protect — no file other than the ledger
  reaches the run row's counters — is unchanged and still asserted.

### Fix round 1 (2026-11-19)

- A1 (CR-M-1 / SO-E1): the terminal increment is SPLIT in two, not one `invalid`. An item the
  provider read and we refused goes to `received + invalid` (`RunEnding.refused`); an item we
  OBSERVED and then lost to our own failed page write goes to `received + persistence_errors`
  (`RunEnding.lost`), and only when the ending's `errorCode` is `PERSISTENCE`. `refusalOf`
  (`runtime/job-run-worker.ts`) is the pure function that decides. Rollback is this one PR.
- A1 (CR-L-1 / SO-E2): a page above `MAX_OBSERVATIONS_PER_PAGE` is written chunk per
  transaction, so the chunks that committed before the failing one are ALREADY in the persisted
  `received`. The worker tallies them (`committedInLostPages`) and nets them off `lost`, so
  neither increment double-counts them. Rollback is this one PR.
- A1 (SO-E3): `nonEmpty` for `last_nonempty_at` is computed from the run row's `received` PLUS
  the terminal increment, because the row was read before that increment. An attempt that read
  items and kept none did answer with something, so the column moves for it. This REVERSES the
  round-0 assumption above ("`last_nonempty_at` keeps its persisted meaning").
- A2 (CR-M-2) — OPEN, see the decision brief in the fix-round report: the Master bucket table
  wants `quarantined` counted in `received` ALONE. The run row has no `quarantined` column and
  `ck_job_collection_runs_succeeded_complete` demands
  `created + revised + unchanged + duplicates + invalid = received` on a SUCCEEDED run, so such
  an increment is refused by Postgres (measured on a scratch DB:
  `ERROR: ... violates check constraint "ck_job_collection_runs_succeeded_complete"`). Quarantine
  therefore stays inside `invalid` in this PR, which keeps the health detectors' `SCHEMA_DRIFT`
  rule reading quarantine as drift. Separating the two needs DDL plus deploy wiring
  (`.github/workflows/deploy.yml` enumerates every `drizzle/manual/*.sql` by hand) — not this PR.
