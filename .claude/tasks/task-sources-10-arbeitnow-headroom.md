# Task sources-10 — Arbeitnow: 24 MiB cap + early warning before the cap

Owner decision (2026-11-20, chat): "Limit 24 MiB + alert". Arbeitnow page 1 measured 9 569 670 bytes
decoded on 2026-11-19 (4 209 793 on 2026-10-24: 2.3x in four weeks) against `ARBEITNOW_MAX_BYTES` =
`MAX_RESPONSE_BYTES_CEILING` = 10 MiB (~9% headroom). The page size cannot be chosen (see the docblock in
`apps/api/src/job-sourcing/providers/sources/arbeitnow.provider.ts`). Prod: the 2026-11-20 19:22Z run
SUCCEEDED (1500 received). Prod API memory 188 MiB of 7.5 GiB.

Start: `git fetch origin && git checkout -B feat/sources-10-arbeitnow-headroom origin/main`. Fresh worktree:
`pnpm install --frozen-lockfile`, `pnpm --filter @crm/inference build`, `pnpm --filter @crm/web build`.

## Acceptance criteria

1. Arbeitnow may declare 24 MiB (`ARBEITNOW_MAX_BYTES = 24 * 1024 * 1024`), honoured by BOTH the transport
   (`FetchRequest.maxBytes` / `boundedFetchText`) and `parseBoundedJson`. Every OTHER source keeps the 10 MiB
   ceiling: a declaration above 10 MiB by any other source is still refused at config time (the 13.9 MB Ashby
   board stays refused). Smallest shape: an explicit, named higher ceiling that only an allow-listed source may
   use (e.g. a second exported constant plus the check in `api-json.provider.ts` and `bounded-fetch.ts`), not a
   raised global ceiling. Tests: Arbeitnow 24 MiB accepted; another source at 24 MiB refused; a body over 24 MiB
   still fails `PAYLOAD_TOO_LARGE`.
2. Early warning: each Arbeitnow page's decoded byte size is observable, and a page at >= 80% of the declared
   cap raises a visible signal BEFORE the cap fails the run. Reuse what exists (the health detectors in
   `health/detectors.ts`, run report / structured log) — find the cheapest channel the owner already sees
   (health status in the admin UI / alert path). No DDL unless unavoidable; if a migration is needed, stop and
   report the options instead (A2). Test red/green for: below 80% no signal, >= 80% signal, applies to any
   source with a declared cap (or state why Arbeitnow-only).
3. Docblocks updated (Arbeitnow adapter, ceiling constant): the new numbers, the owner decision date, the
   80% warning. Typecheck, eslint, prettier, unit, the job-sourcing integration specs touched (scratch DB
   `crm_qa_s10`, DATABASE_URL inline, never crm_db), mutation gate on changed lines
   (`node scripts/devops/mutation-gate.mjs --changed`).

## Rules

Zone `apps/**`, `packages/**`. Draft PR titled `feat(job-sourcing): Arbeitnow 24 MiB cap + near-cap warning`;
body starts with `Task: .claude/tasks/task-sources-10-arbeitnow-headroom.md` and `Plan: <where>`; an
"Assumptions" block for A1 choices. Commit with `ac_verified: 1,2,3`. Push
`DATABASE_URL= git push -u origin HEAD` in the background, verify with `git ls-remote`; do not end your turn while
a command you depend on is running. Never --no-verify. Notes server: `notes.search` first, `notes.add` facts with
file:line. No second-opinion. English only. Report: `Worktree:`, `Pushed: <branch> @ <sha>`, PR URL, `Tests:`
with counts (red/green), mutation survivors.

## Fact added by Master (2026-11-20 20:10Z)

Prod `job_collection_runs` already has `bytes_read`, `request_count` and `last_http_status` columns. For AC 2,
check first whether `bytes_read` is written per run (and whether it is the decoded page size or a sum over pages)
before adding any new metric; prefer reusing it.
