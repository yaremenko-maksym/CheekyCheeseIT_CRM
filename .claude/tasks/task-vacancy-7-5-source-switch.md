# task-vacancy-7-5-source-switch — Task 7.5 ADMIN source switch in `SourceBudgetPanel` (plan r5 §Task 7.5)

## Agent: coder

## Status: ready

## Blockers: none

## Priority: high

## Model: opus

## Depends on: Task 6.5 (`PATCH /job-sourcing/sources/:id`) — in `main`

## Branch: feature/vacancy-7-5-source-switch

## Design tier: 2 (spec `docs/design/vacancy-queue.md` §7; reference PNGs `docs/design/assets/vacancy-queue/sources-{320,320-en,768,1440}.png`)

## Context

ADMIN turns a vacancy source on and off from the panel. The endpoint is
`PATCH /job-sourcing/sources/:id` (`apps/api/src/job-sourcing/admin/job-source-admin.controller.ts`, body
`setJobSourceEnabledSchema` = `{ enabled: boolean }`, strict). The panel is
`apps/web/app/components/job-sourcing/SourceBudgetPanel.tsx`; it stays inside `JobSuggestionDialog` and is also placed on the
queue page for ADMIN as the collapsed section «Джерела вакансій» (§7).

## Concrete changes

1. `apps/web/app/hooks/use-job-sourcing.ts` — `useSetJobSourceEnabled` (PATCH with the inverted value, then refetch the
   source list and health).
2. `apps/web/app/components/job-sourcing/SourceBudgetPanel.tsx` (+ small children if the file would pass ~400 lines) — per
   design §7:
   - name + icon + `Switch` (`role="switch"`, 44×44 hit area, `aria-label` = source name);
   - three separate states with chip + explanation line: disabled, paused (cooldown / 429 / challenge, with the «до <час>»
     time), readiness-blocked (policy / auth);
   - unit and quota line + the three-segment bar (used / reserved / uncertain, hatched), `role="img"` with all three numbers;
   - timestamps `dl`: last attempt, last success, last non-empty, policy until, authorization until («ніколи» when none);
   - enable failure: the destructive note with the readiness reason; the switch returns to its previous position; no
     toggle clears policy or cost state;
   - the collapsed summary with uk/en plurals (0, 1, 2, 5, 11, 21, 22 in uk; 1, 2, 5, 21 in en).
3. The queue page renders the collapsed section for ADMIN only.
4. Lingui catalogs for every new string.

## Reuse / Regression scope

- Existing `SourceBudgetPanel` tests (including "non-ADMIN panel not rendered") stay green.
- `apps/e2e/tests/job-source-admin-responsive.spec.ts` and `job-source-admin-rbac-api.spec.ts` stay green.

## RBAC

| Role   | Access                                               |
| ------ | ---------------------------------------------------- |
| ADMIN  | the panel, the switch, the queue-page section        |
| others | not rendered; the API answers 403 (Task 6.5 proves it) |

## Acceptance criteria

1. [ ] Toggle sends `PATCH /job-sourcing/sources/:id` with `{ enabled: !current }` and refetches; double activation sends one
       request.
2. [ ] Disabled, paused and readiness-blocked render as three different chips with their explanation lines (§7 table).
3. [ ] Quota bar: used / reserved / uncertain with a legend of numbers; `aria-label` carries all three.
4. [ ] Timestamps per §7, relative, «ніколи» when null.
5. [ ] Enable failure: the readiness reason is shown, the switch returns to the previous position, cached policy/cost state is
       unchanged (test).
6. [ ] Non-ADMIN: the panel and the queue-page section are not rendered.
7. [ ] i18n: Lingui macros (source `uk`) with `en`; plural forms verified for the counts above; `pnpm i18n:extract` leaves no diff.
8. [ ] Responsive 320 / 375 / 768 / 1024 / 1280 / 1440 / 1920: no horizontal overflow; `dl` one column on mobile, three from
       560 px; targets ≥ 44 px.
9. [ ] PR body has a ui-ux-designer conformance note against the reference PNGs.

## Seams under test (Master proposes, Coder confirms BEFORE writing tests)

- `SourceBudgetPanel` (rendered component) for states, bar, timestamps, failure.
- `useSetJobSourceEnabled` via `renderHook`: request shape and refetch.

## Assumptions

- A1 (Master): the design step of plan r5 ("Design Tier 2") is covered by the existing spec §7 and the four reference PNGs; no
  new Claude Design run. Mode B on the live stack checks conformance.

## Verification (Coder before `git push`)

1. `git diff HEAD --name-only` — only files from "Concrete changes".
2. Each AC: a named test or a `grep` for its testid / string.
3. Commit: `ac_verified: 1,...,8 (9 — PR body note, checked at PR time)` and `vision: ✓ /job-queue`.
