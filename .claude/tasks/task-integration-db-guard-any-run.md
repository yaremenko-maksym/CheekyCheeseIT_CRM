# task-integration-db-guard-any-run

## Agent: coder

## Model: sonnet

## Branch: fix/integration-db-guard-any-run (off origin/main)

## Design tier: — (not UI)

## Context

Found by a Coder agent on PR #369 and confirmed by the security-reviewer (MED, pre-existing):
a shell in a worktree inherits the ambient `DATABASE_URL` from the root `.env` (it points to the live
`crm_db`). On an **unfiltered** `pnpm --filter @crm/api test` run, integration specs
do NOT self-skip, but actually write to `crm_db`, because all the protection is tied to
`isIntegrationRun`:

- `apps/api/vitest.config.mts:115` — `isIntegrationRun = process.argv.some(arg => arg.includes('integration.spec'))`;
- the globalSetup guard `src/test/integration-db-guard.ts` (fail-fast on crm_db) is attached ONLY when `isIntegrationRun` (lines ~149–153);
- `fileParallelism: false` — also only when `isIntegrationRun` → on an unfiltered run integration specs additionally run IN PARALLEL against one DB (races).
- The comment "unit runs have no DATABASE_URL" (line ~158) is wrong when an ambient `DATABASE_URL` is exported — workers inherit it.

## Goal

Integration specs can NEVER run against `crm_db` — regardless of how they are launched
(filtered/unfiltered, any ambient env), outside CI.

## Preferred design (check feasibility, justify any deviation in the PR)

On an **unfiltered** run integration specs are not executed at all: skip with a loud
one-line warning ("integration specs skipped: run via `vitest run … integration.spec`"),
while unit tests run and stay green. This closes both the write to crm_db and the class of races
from parallel execution. Implementation — for example, an early runtime check in the shared helper
of the integration specs (like the graceful-skip on an empty DATABASE_URL works now — find that mechanism
and extend it) OR an env flag from vitest.config when !isIntegrationRun. Failing the whole run with a throw is
NOT the default option (it breaks DX of unit runs), acceptable only selectively if a spec has already
started against crm_db.

## Invariants (preserve)

1. Empty `DATABASE_URL=` → graceful-skip as now (the pre-push git-policy relies on this).
2. `CI=true` → throwaway container, everything allowed (the guard's current exception).
3. A filtered integration run against crm_qa — no behavior change: guard active,
   `fileParallelism: false`, everything green.
4. Do NOT weaken the guard's fail-fast on crm_db in an integration run.
5. Do not touch production code (outside `apps/api/src/test/**`, `vitest.config.mts`, spec files).

## AC

1. [x] Exported `DATABASE_URL=...crm_db` + `pnpm --filter @crm/api test` (no filter):
       **0 writes to crm_db** (row-count snapshot per table before/after, 25 tables — identical),
       integration specs skipped with an explicit reason (`[vitest.config] non-integration run —
skipping all *.integration.spec.ts files ...`), unit tests green (81 files / 1592 tests).
2. [x] Same with `DATABASE_URL=...crm_qa` (unfiltered): integration specs do not run
       (0 `*.integration.spec.ts` files in the output, row-count diff = empty), unit green
       (81 files / 1592 tests).
3. [x] A filtered `integration.spec` run against crm_qa — mechanism confirmed unchanged:
       guard active (`[integration-db-guard] OK — using database: crm_qa`), sequential
       (fileParallelism gate untouched). 68/71 files green; 3 files (8 tests) fail on a
       PRE-EXISTING crm_qa fixture/business logic (`payment_type` NOT NULL / assertHrCanManageProject),
       NOT related to this fix — proven by an isolated run of the same 3 files on clean
       `origin/main` (detached HEAD, without my changes): identical 8 failures. Outside the zone/scope
       of this task (task invariant #5 — do not touch production code); flagging to PM as a separate
       follow-up (crm_qa data/schema drift or a real bug in createFromInterview payment_type).
4. [x] Empty `DATABASE_URL=` → graceful-skip preserved (log `[integration-db-guard] DATABASE_URL
is not set` via the per-spec dbAvailable guard; our warning is also present), unit green.
5. [x] The comment in vitest.config.mts about "unit runs have no DATABASE_URL" fixed (2 places).
6. [x] `pnpm typecheck` green (`@crm/api`); `mcp__eslint__lint-files` on changed files clean.
7. [x] `git diff --name-only origin/main..HEAD` — only `apps/api/**` + `.claude/tasks/*.md`.

## Verification / git

- Push: `DATABASE_URL= git push`. Commit: `fix(api): ...` / `test(api): ...` + `ac_verified:`.
- PR: normal pipeline, base main. Do NOT touch merge-approved.
- Fresh worktree: `pnpm install --frozen-lockfile`.
