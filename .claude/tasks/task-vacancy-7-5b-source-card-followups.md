# task-vacancy-7-5b-source-card-followups — Task 7.5b: follow-ups to the ADMIN source switch card (PR #1312 round 3)

## Agent: coder

## Status: ready (after PR #1312 merges)

## Blockers: none

## Priority: medium

## Model: opus

## Depends on: Task 7.5 (PR #1312) merged into `main`

## Branch: feature/vacancy-7-5b-source-card-followups

## Design tier: 1 (edit to an existing card; spec `docs/design/vacancy-queue.md` §7, §8; PNGs `docs/design/assets/vacancy-queue/sources-{320,320-en,768,1440}.png`)

## Context

PR #1312 merged at round 3 with every required verdict PASS. Its round-3 reviews left LOW and plausible findings that
were moved here instead of a fifth review round. Each item below names the finding id from the PR #1312 reviews.

## Concrete changes

1. `apps/web/app/components/job-sourcing/SourceSwitchCard.tsx` / `SourceBudgetRow.tsx`:
   - (SO-S2-M, CR4-L-2, COPY4-L-2) a source with a quota meter (`meter.limit` > 0) still shows the budget-state row when
     the per-source budget is `MISCONFIGURED` or `EXHAUSTED` (with its reset time); only `ACTIVE` and `UNLIMITED` are
     hidden behind the meter. This replaces the UX-01 A1 line of Task 7.5.
   - (SPEC4-L-1) the trigger label («за розкладом» / «за кнопкою») in the job-suggestion dialog (`showTrigger`) renders
     outside the budget row, so a metered source keeps it in the dialog. The queue-page card still shows none.
   - (QA4-LOW-1) a legacy-counter source (no meter, `ACTIVE` / `EXHAUSTED` with a limit) states its limit once: the
     quota bar, without the duplicate «Залишилось N з M» line; `EXHAUSTED` keeps its reset time.
   - (UX4-01) the boxed notes and the refused-enable alert use `rounded-lg` (design §8).
   - (UX4-02) the legend figures are `font-semibold`.
2. `apps/web/app/hooks/use-job-sourcing.ts` — (CR4-L-1) the comment says what the code does: the switch shows the old
   value while the request is pending and stays guarded until the fresh value arrives.
3. Tests (`SourceSwitch.test.tsx` and neighbours) — (SO-S2-L) the focus test fails if native `disabled` returns (assert
   the attribute is absent and `aria-disabled="true"` while pending); the double-send test isolates the ref guard
   (two activations before the pending state re-renders); the time-zone test fails if `timeZone: 'UTC'` is removed
   (run under a non-UTC zone set before the formatter is built, or inject the zone).

## Acceptance criteria

1. [ ] Metered source + budget `MISCONFIGURED`: the «збір зупинено» warning renders; + `EXHAUSTED`: «Ліміт вичерпано»
       and the reset time render; + `ACTIVE` / `UNLIMITED`: only the meter (tests for all four).
2. [ ] Dialog (`showTrigger`) shows the trigger label for a metered and a non-metered source; the queue-page card shows
       none (tests).
3. [ ] A legacy-counter source shows its limit once (test).
4. [ ] Notes and alert `rounded-lg`; legend figures semibold (class assertions).
5. [ ] Each strengthened test fails on the regression it guards (state the mutation tried in the report).
6. [ ] i18n: no new strings expected; if any, Lingui uk + en and `pnpm i18n:extract` leaves no diff.
7. [ ] Mutation gate: 0 survivors on the changed files (run by Master in WSL).

## Assumptions

- A1 (Master): one PR for all items; no API change (the budget state and the meter are already in `jobSourceSchema`).
- A1 (Coder): beside a quota bar, the «Ліміт вичерпано» line and its reset time come from the per-source `budget.resetsAt`,
  not from the meter's `resetsAt` (the two windows are independent).
- A1 (Coder): the trigger label is its own muted line, «(за розкладом)» / «(за кнопкою)», rendered between the note and
  the budget row (`SourceTriggerLabel`, `data-testid="job-source-trigger"`); the queue-page card renders none.
- A1 (Coder): the budget row keeps its `sm:flex-row sm:justify-between` layout classes; only its placement changes.
- A1 (Coder): tests add a `NO_LIMIT_METER` fixture (a meter with a null limit) so the "no bar, legacy row" branch is
  covered next to the metered states.

## Verification (Coder before `git push`)

1. `git diff HEAD --name-only` — only files from "Concrete changes".
2. Each AC: a named test.
3. Commit: `ac_verified: 1,...,7` and `vision: ✓ /job-queue`.
