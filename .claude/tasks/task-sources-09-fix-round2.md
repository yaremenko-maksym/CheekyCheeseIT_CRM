# Task sources-09 fix round 2 — PR #1434 (quarantined items: do not count them yet)

PR #1434, branch `fix/sources-09-rss-received-zero`, head `4f25c8952`. Fix round 1 resolved everything except
CR-M-2, which the round-1 agent measured as not representable: `ck_job_collection_runs_succeeded_complete` (on
SUCCEEDED, `created + revised + unchanged + duplicates + invalid = received`) and
`ck_job_collection_runs_dispositions_bounded` leave no column for "received, refused by the identity seam".
Shipped now: quarantined items go into `received` AND `invalid`.

Start: `git fetch origin && git checkout -B fix-1434-r2 origin/fix/sources-09-rss-received-zero`.
Fresh worktree: `pnpm install --frozen-lockfile` and `pnpm --filter @crm/web build` before the first push.

## Master decision (A1, recorded; put it in the PR body "Assumptions")

Do NOT count quarantined items in any persisted counter in this PR — exactly as on main. Count only:
schema-invalid -> `received` + `invalid`; lost (our page write failed) -> `received` + `persistence_errors`
(round 1's netting of committed chunks stays).

Why: prod has 3 enabled `LEVER_ATS` and 2 enabled `ASHBY_ATS` sources (read-only SELECT, 2026-11-20); their committed
captures are 100% `MISSING_COMPANY` quarantine (Lever/Spotify 6/6, Ashby/Linear 4/4). With quarantine in `invalid`,
`detectFormatDrift` (`invalid / received > 0.1`) turns every such board `SCHEMA_DRIFT` -> `DEGRADED` -> alert on the
first run after deploy: a new false alert for a steady state. Leaving quarantine uncounted keeps those boards exactly
as on main and needs no DDL. The Djinni / WWR case this PR started from is fixed at the source (#1433 merged and
verified on prod: Djinni stores postings; #1428 for WWR). The proper counter — a `quarantined` column in both CHECKs
(staged DDL + deploy wiring) — is a follow-up: add a backlog entry text to the PR body under "Follow-ups" (Master
files it in the docs PR).

## Do

1. Change the split so quarantined items contribute to no persisted counter (find where round 1 folds them into
   `refused`: `refusalOf` in `runtime/job-run-worker.ts`, `terminalCounters` in `ownership/ledger-policy.ts`).
   `last_nonempty_at` (SO-E3): moves for schema-invalid and lost items, not for quarantine-only runs; state it.
2. Tests: invert the round-1 `detectors.spec.ts` case — a 100%-quarantined source stays as on main (no
   `SCHEMA_DRIFT`, no `NO_NEW_ITEMS`, no `EMPTY_RESPONSE`); keep red/green for schema-invalid and lost; the
   Djinni-shaped regression test now asserts the honest counters on a feed with schema-invalid items (or state why
   it no longer applies, since Djinni no longer quarantines). Red-check the quarantine case against `4f25c8952`.
   Ledger/counts integration specs on a scratch DB (`DATABASE_URL` inline, `crm_qa_s09_r2`, never `crm_db`).
3. Typecheck, eslint, prettier, unit, integration, mutation gate on changed lines
   (`node scripts/devops/mutation-gate.mjs --changed`).
4. PR body: rewrite the bucket table and the per-detector "Alert consequence" to match; CR-M-2 row in a "Fix round 2"
   table (outcome + evidence); "Follow-ups" with the `quarantined` column item. Edit with
   `gh pr view 1434 --json body --jq .body > f`, edit, `gh pr edit 1434 --body-file f`.

## Rules

Zone `apps/**`, `packages/**`. Commit with `ac_verified: 1,2,3` plus `CR-M-2`. Push
`DATABASE_URL= git push origin HEAD:fix/sources-09-rss-received-zero` in the background, verify with `git ls-remote`;
do not end your turn while a command you depend on runs — wait on it with a bounded loop. Never --no-verify. Notes
server: `notes.search` first, `notes.add` facts with file:line. No second-opinion. English only. Report: `Worktree:`,
`Pushed: <branch> @ <sha>`, `Findings: resolved N / disagreed M`, `Tests:` with counts (red/green), mutation survivors.
