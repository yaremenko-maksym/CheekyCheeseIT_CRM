# task-vacancy-7-4-actions — Task 7.4 Actions + i18n (plan r5 §Task 7.4)

## Agent: coder

## Status: done (PR #1306 merged into `main` at `14341a99`, 2026-11-10)

## Blockers: none

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
4. `apps/web/app/components/job-queue/__tests__/` and `apps/web/app/hooks/__tests__/` (`use-job-queue.test.tsx`, `use-job-queue-actions.test.tsx`) — tests listed in the plan and AC 9 (failing first).
5. `packages/shared/src/i18n/locales/{uk,en}/messages.po` — via `pnpm i18n:extract` only, never by hand; fill `en`; `pnpm i18n:compile`.
6. Carried over from PR #1302 live review (AC 9): `apps/web/app/components/job-queue/MatchedSeniors.tsx` (seniors heading count) and `apps/web/app/hooks/use-job-queue.ts` (`useJobQueueCard` and the seniors / sources continuation queries: retry policy).

## Reuse / Regression scope

- `openOriginalPosting` — call synchronously inside the click gesture; the `useMarkJobOpened` mutation is independent of it.
- Error codes in `packages/shared/src/schemas/api-errors/job-sourcing.ts` (`JOB_QUEUE_POSSIBLE_DUPLICATE_CLAIMED` and siblings) — reuse, do not add new codes without a shared-schema change in the same PR.
- Must not break: the `/job-queue` list, infinite scroll, chips and senior filter (7.2–7.2d), and the 7.3 card render.

## RBAC

| Role                 | Access                                                                                 |
| -------------------- | -------------------------------------------------------------------------------------- |
| ADMIN                | all actions + §5.6 menus: vacancy «⋯» (suppress «Приховати для всіх…»; triage «Призначити команді…»), per-senior «⋯» «Скасувати подачу…»; no reassign (dropped, plan r5) |
| HR (scoped)          | per-senior «Записати подачу», «Відкрити оригінал», «Приховати» within their own scope  |
| others               | no queue access (unchanged)                                                            |

## Acceptance criteria

1. [ ] Plan scope: one primary action per senior, disabled + spinner during the request, repeated clicks ignored (double click → one request); 409 → card refetch + the one conflict note «Дані змінилися. Оновіть картку й повторіть.» (§5.6), which never says who or where; same-action retry; two-team independence.
2. [ ] (SPEC-M-1 a) Per-senior «Записати подачу» with every state from design §5.3, each senior independent (any order, several may be submitted).
3. [ ] (SPEC-M-1 b) Possible-duplicate inline confirm per §5.8: «Не записувати» is the primary action and takes initial focus; «Так, записати все одно» proceeds; a 409 `JOB_QUEUE_POSSIBLE_DUPLICATE_CLAIMED` from the API opens the same confirm.
4. [ ] (SPEC-M-1 c) Apply-first reminder per §5.3: `data-testid="job-queue-apply-first"`, a persistent note (not a toast), hidden only when every «Записати подачу» button on the card is disabled.
5. [ ] (SPEC-M-1 d) Two blocking notes, each disabling every «Записати подачу» on the card: (i) the newer-revision note (§5.7) — disabled until the card is refreshed, so an old card cannot claim; (ii) the closed/expired-at-source note (design state "Closed / expired at source") — disabled for good, refresh does not lift it.
6. [ ] (SPEC-M-1 e) Footer «Відкрити оригінал» (fires the `useMarkJobOpened` mutation once and `openOriginalPosting` with the right URL) and «Приховати» → reason menu → scoped versioned dismiss → undo toast (§5.9), with the undo/version race tested; ADMIN «⋯» menus per §5.6 (suppress, triage assign, per-senior cancel submission; no reassign). **Partial:** triage assign is descoped to `task-vacancy-7-4b-triage-assign.md` (owner brief Q1, see Assumptions).
7. [ ] (SPEC-M-1 f) i18n: every new string is a Lingui macro (source `uk`) with an `en` translation; `pnpm i18n:extract` leaves no diff; the CI step "i18n catalogs are in sync (lingui extract --clean)" passes locally; `node scripts/devops/check-no-russian-letters.mjs` passes.
8. [ ] Responsive: no horizontal overflow at 320 / 375 / 768 / 1024 / 1280 / 1440 / 1920; touch targets ≥ 44 px on mobile; no hover-only actions.
9. [ ] Carried over from PR #1302 (three LOW findings moved here; report one line per id):
   - **UX-L-5** (design review 5831045057): a triage card shows «Сеньйори зі збігом 1» above «Сеньйорів не підібрано автоматично». Show the count only when a senior list renders; first read why a triage card carries `seniors.totalCount > 0` and say what it counts.
   - **UX-L-6** (same review): the seniors count sits 8 px after the label; spec §5.1 and the reference `docs/design/assets/vacancy-queue/card-default-1440.png` put it at the right end of the heading row (`ml-auto` on the count span). Assert the class.
   - **QA-LOW-6** (manual-qa review 5831124681): `useJobQueueCard` and the seniors / sources continuation queries inherit the app-wide `retry: 1`, so a 403/404 is requested twice (~1.1 s) before the card closes. Do not retry on 403/404 for those queries; keep the default retry for other errors. Test: a 403 and a 404 each issue exactly one request before the close; a 500 is still retried once.

## Interaction tests

- [ ] Duplicate confirm: initial focus on «Не записувати»; Escape cancels and returns focus to the senior's «Записати подачу».
- [ ] Reason menu: opens and navigates by keyboard (Arrow keys, Enter, Escape) — Radix menu.
- [ ] Undo toast: undo restores the item; a version change between dismiss and undo is surfaced, not silently applied.
- [ ] Disabled-until-refresh: with the newer-revision note shown, no «Записати подачу» is focusable as an enabled button.

## Seams under test (Master proposes, Coder confirms BEFORE writing tests)

- `JobQueueCard` (rendered component) — every AC above is observed through the rendered card: buttons, notes, confirm, menu, toast.
- The job-queue action hooks in `apps/web/app/hooks/use-job-queue.ts` (`useMarkJobOpened` and the submit / dismiss / undo hooks) — request shape, 409 handling and cache updates, tested with `renderHook` as in `use-job-queue-actions.test.tsx`.

## Assumptions

- RBAC: SENIOR has no queue access (redirected), so the scoped row is HR only; the earlier "HR / SENIOR" label was a typo.
- Owner brief Q1 (2026-11-10, recommendation taken): «Призначити команді…» is descoped from AC 6 to `task-vacancy-7-4b-triage-assign.md`, after Task 7.3b; it needs the policy version, a team list for ADMIN and a grant expiry the card did not expose.
- Owner brief Q2 (2026-11-10, recommendation taken): re-hide after undo and a reload answers 409 until the card returns the live dismissal; `dismissal: { scope, version } | null` is added in Task 7.3b. 7.4 fixes the in-session case only.

## Do not touch

- API endpoints and `packages/shared/src/schemas/job-sourcing.ts` card fields — the missing card fields are Task 7.3b (backlog item 396), not this task.
- `JobQueueList.tsx`, `JobQueueRow.tsx`, `JobQueueFilters.tsx` beyond what the actions strictly need.

## Verification (Coder before `git push`)

1. `git diff HEAD --name-only` — only files from "Concrete changes".
2. Each AC: a named test or a `grep` for its `data-testid` / string.
3. Playwright screenshots at 320 and 1440 of the card with the actions, the duplicate confirm and the reason menu.
4. Commit: `ac_verified: 1,2,3,4,5,6,7,8,9` and `vision: ✓ /job-queue`.
