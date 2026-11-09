# task-vacancy-7-4-actions — Task 7.4 Actions + i18n (plan r5 §Task 7.4)

## Agent: coder

## Status: not started

## Blockers: PR #1302 (Task 7.3 card) must merge first — this task modifies `JobQueueCard.tsx`, which #1302 creates

## Priority: high

## Model: opus

Cross-zone writes (web actions against the api claim / dismiss / undo contracts and the `packages/shared` catalogs) plus 409 conflict handling (`JOB_QUEUE_POSSIBLE_DUPLICATE_CLAIMED`, version races) — `model-routing.md` "cross-zone contracts" row.

## Depends on: Task 7.3 (#1302) merged into `main`

## Branch: feature/vacancy-7-4-actions

## Design tier: 2 (edit to the existing card; spec `docs/design/vacancy-queue.md` §5.3, §5.6–§5.9 is the reference)

## Context

The 7.3 card shows a vacancy but cannot act on it. 7.4 adds the actions from plan r5 §Task 7.4
(`docs/superpowers/plans/2026-10-10-vacancy-sourcing-plan.r5.md`) and carries over the requirements the
7.3 spec review deferred here (SPEC-M-1 of PR #1302).

## Concrete changes

1. `apps/web/app/components/job-queue/JobQueueCard.tsx` — mount the actions; blocking notes (§5.7, closed source).
2. `apps/web/app/components/job-queue/JobQueueActions.tsx` (new) — per-senior «Записати подачу», duplicate confirm, apply-first reminder, footer actions.
3. `apps/web/app/components/job-queue/DismissMenu.tsx` (new) — «Приховати» reason menu (Radix, keyboard-accessible) + undo toast.
4. `apps/web/app/components/job-queue/__tests__/` — tests listed in the plan (failing first).
5. `packages/shared/src/i18n/locales/{uk,en}/messages.po` — via `pnpm i18n:extract` only, never by hand; fill `en`; `pnpm i18n:compile`.

## Reuse / Regression scope

- `openOriginalPosting` — call synchronously inside the click gesture; `markOpened` independent of it.
- Error codes in `packages/shared/src/schemas/api-errors/job-sourcing.ts` (`JOB_QUEUE_POSSIBLE_DUPLICATE_CLAIMED` and siblings) — reuse, do not add new codes without a shared-schema change in the same PR.
- Must not break: the `/job-queue` list, infinite scroll, chips and senior filter (7.2–7.2d), and the 7.3 card render.

## RBAC

| Role                 | Access                                                                                 |
| -------------------- | -------------------------------------------------------------------------------------- |
| ADMIN                | all actions + ADMIN «⋯» menu (release / reassign / suppress) with conflict state, §5.6 |
| HR / SENIOR (scoped) | per-senior «Записати подачу», «Відкрити оригінал», «Приховати» within their own scope  |
| others               | no queue access (unchanged)                                                            |

## Acceptance criteria

1. [ ] Plan scope: one primary action per senior, disabled + spinner during the request, repeated clicks ignored (double click → one request); 409 → toast/prompt + card refetch; same-action retry; two-team independence; masked conflict name.
2. [ ] (SPEC-M-1 a) Per-senior «Записати подачу» with every state from design §5.3, each senior independent (any order, several may be submitted).
3. [ ] (SPEC-M-1 b) Possible-duplicate inline confirm per §5.8: «Не записувати» is the primary action and takes initial focus; «Так, записати все одно» proceeds; a 409 `JOB_QUEUE_POSSIBLE_DUPLICATE_CLAIMED` from the API opens the same confirm.
4. [ ] (SPEC-M-1 c) Apply-first reminder per §5.3: `data-testid="job-queue-apply-first"`, a persistent note (not a toast), hidden only when every «Записати подачу» button on the card is disabled.
5. [ ] (SPEC-M-1 d) Blocking newer-revision note (§5.7) and closed-source blocking note: while either shows, every «Записати подачу» is disabled until the card is refreshed; an old card cannot claim.
6. [ ] (SPEC-M-1 e) Footer «Відкрити оригінал» (calls `markOpened` once and `openOriginalPosting` with the right URL) and «Приховати» → reason menu → scoped versioned dismiss → undo toast (§5.9), with the undo/version race tested; ADMIN «⋯» menu per §5.6.
7. [ ] (SPEC-M-1 f) i18n: every new string is a Lingui macro (source `uk`) with an `en` translation; `pnpm i18n:extract` leaves no diff; the CI step "i18n catalogs are in sync (lingui extract --clean)" passes locally; `node scripts/devops/check-no-russian-letters.mjs` passes.
8. [ ] Responsive: no horizontal overflow at 320 / 375 / 768 / 1024 / 1280 / 1440 / 1920; touch targets ≥ 44 px on mobile; no hover-only actions.

## Interaction tests

- [ ] Duplicate confirm: initial focus on «Не записувати»; Escape cancels and returns focus to the senior's «Записати подачу».
- [ ] Reason menu: opens and navigates by keyboard (Arrow keys, Enter, Escape) — Radix menu.
- [ ] Undo toast: undo restores the item; a version change between dismiss and undo is surfaced, not silently applied.
- [ ] Disabled-until-refresh: with the newer-revision note shown, no «Записати подачу» is focusable as an enabled button.

## Assumptions

## Do not touch

- API endpoints and `packages/shared/src/schemas/job-sourcing.ts` card fields — the missing card fields are Task 7.3b (backlog item 396), not this task.
- `JobQueueList.tsx`, `JobQueueRow.tsx`, `JobQueueFilters.tsx` beyond what the actions strictly need.

## Verification (Coder before `git push`)

1. `git diff HEAD --name-only` — only files from "Concrete changes".
2. Each AC: a named test or a `grep` for its `data-testid` / string.
3. Playwright screenshots at 320 and 1440 of the card with the actions, the duplicate confirm and the reason menu.
4. Commit: `ac_verified: 1,2,3,4,5,6,7,8` and `vision: ✓ /job-queue`.
