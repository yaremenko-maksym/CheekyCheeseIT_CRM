# Task sources-11 — Admin "Sources" page: real last run + enable switch + reset failures

Owner (2026-11-20, chat): "I cannot do anything with sources in the admin UI". Facts (Master, read-only):
- `apps/web/app/routes/_authenticated/admin/sources.index.tsx` shows "Ще не запускалося" for every source because
  it reads `source.lastCollectedAt` (`fresh(source.lastCollectedAt)`), a legacy column the new runtime never
  writes (prod: NULL for all 38 rows, while `last_attempt_at` / `last_success_at` are set and runs happen hourly).
- The API already has, ADMIN-only: `PATCH /api/job-sourcing/sources/:id` body `{ enabled: boolean }`
  (`JobSourceSwitchController`, schema `setJobSourceEnabledSchema`, answer `jobSourceSwitchResultSchema`) and
  `POST /api/job-sourcing/admin/sources/:id/reset-failures` body `{ reason }` (`JobSourceAdminController`).
  No web code calls either.

Start: `git fetch origin && git checkout -B feat/sources-11-admin-sources-ui origin/main`. Fresh worktree:
`pnpm install --frozen-lockfile`, `pnpm --filter @crm/inference build`, `pnpm --filter @crm/web build`.

## Acceptance criteria

1. The list (and the source detail page if it shows the same thing) shows the last attempt and the last success
   from the fields the runtime writes (`lastAttemptAt` / `lastSuccessAt`; add them to the admin read DTO in
   `job-source-admin.service.ts` + the shared schema if missing). "Never ran" only when there was no attempt.
   Remove the dead `lastCollectedAt` use from this page (keep the column; do not migrate).
2. An enable/disable switch per source (ADMIN only, the page already is admin), calling the PATCH endpoint via a
   TanStack Query mutation that invalidates the list. A source whose readiness is BLOCKED shows the switch disabled
   with the readiness reason. Errors show a toast with the API error text from the catalog.
3. A "Reset failures" action, visible when `consecutiveFailures > 0` or a cooldown is set, asking for a reason
   (required, the endpoint's schema decides the limits), calling the POST endpoint.
4. All new visible strings in `uk` + `en` through Lingui macros (`pnpm i18n:extract`). Use existing shadcn/ui
   components (Switch, Dialog, Button) and existing mutation/toast patterns in `apps/web` (find an analog first).
5. Tests: web unit tests for the switch and reset (mocked API), API unit test for the new DTO fields. E2E: extend
   an existing admin sources spec if one exists, else one spec for the toggle (Playwright, local run before push).
   Typecheck, eslint, prettier, mutation gate on changed lines (`node scripts/devops/mutation-gate.mjs --changed`).

## Rules

Zone `apps/**`, `packages/**` only (do not touch `.claude/**`). Mobile layout must work at 375 px (the owner uses
the page on a phone). Draft PR `feat(admin): sources page shows real runs, enable switch and reset failures`; body
starts with `Task: .claude/tasks/task-sources-11-admin-sources-ui.md` and `Plan: <where>`. Commit with
`ac_verified: 1,2,3,4,5`. Push `DATABASE_URL= git push -u origin HEAD` in the background, verify with
`git ls-remote`; do not end your turn while a command you depend on is running. Never --no-verify. Notes server:
`notes.search` first, `notes.add` facts with file:line. No second-opinion. English only. Report: `Worktree:`,
`Pushed: <branch> @ <sha>`, PR URL, `Tests:` with counts, mutation survivors, a 375 px screenshot path.
