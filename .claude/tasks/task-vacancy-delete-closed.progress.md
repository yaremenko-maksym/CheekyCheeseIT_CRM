# Progress: task-vacancy-delete-closed

current_milestone: 3/3 (done, pushed, ready for review)
last_commit: fix(vacancies): allow deleting CLOSED vacancies with 0 applications
last_push: DONE (origin/fix/vacancy-delete-closed)

## Milestones

1. Backend guard softened: `VacanciesService.remove()` — `DRAFT|CLOSED` + `applicationsCount === 0`
   deletable; `PUBLISHED` → 409 "Опубликованную вакансию нужно сначала закрыть"; any status with
   applications → 409 "Нельзя удалить вакансию с откликами" (message unchanged, condition widened).
2. Frontend: extracted shared `getVacancyDeleteGate(vacancy)` helper in `constants.ts` (was two
   duplicated inline `canDelete`/`deleteTooltip` blocks in `VacancyCard.tsx` and `$vacancyId.tsx` —
   golden rule #8 reuse) — both consume the same gate now.
3. Tests updated/added across all 4 layers + full verification:
   - unit (`vacancies.service.spec.ts`): PUBLISHED 409, DRAFT+N 409 (unchanged), CLOSED+N 409 (new),
     DRAFT+0 ok (unchanged), CLOSED+0 ok (new) — 5 cases, matches task's 4-case AC + regression.
   - component (`VacancyCard.test.tsx`): CLOSED+0 enabled (new), CLOSED+N disabled+tooltip (new,
     replaces the old "CLOSED always disabled" assertion), DRAFT/PUBLISHED cases unchanged.
   - integration (`vacancies.integration.spec.ts`): real-DB lifecycle — PUBLISHED 409 → CLOSED 204 →
     fresh DRAFT+0 204 (regression pin), against crm_qa.
   - E2E (`apps/e2e/tests/vacancies.spec.ts` test 5): rewrote the stale "CLOSED always disabled"
     assertion into PUBLISHED-disabled-tooltip (new coverage for the full-variant Danger Zone) +
     CLOSED+0-enabled happy-path delete (closes the vacancy created in step 1 — the flow's own
     vacancy no longer needs to be permanent residue, per this task's rule change). Header comment
     doc updated (stale "vacancy row can never be deleted" claim removed).

## blast_radius (getVacancyDeleteGate + VacanciesService.remove condition change)

- `VacancyCard` (list card, icon-variant delete button) — desktop row + mobile kebab, both consume
  `canDelete`/`deleteTooltip` from the new helper; covered by `VacancyCard.test.tsx` (9 cases).
- `$vacancyId.tsx` (detail page, full-variant Danger Zone button) — same helper; covered by E2E
  test 5 (real browser DOM, both PUBLISHED-disabled and CLOSED+0-enabled branches) — no dedicated
  unit test file exists for this route component (pre-existing gap, not introduced here).
- `VacanciesService.remove()` callers: `VacanciesController` DELETE `/vacancies/:id` — only caller,
  covered end-to-end by integration spec + E2E.

## Verification (all green, proof in final report)

- unit: `pnpm test` (root, pre-push hook) → 869/869 passed (web) + api unit suite passed.
- integration: `vitest run src/vacancies/vacancies.integration.spec.ts` against crm_qa → 50/50.
- E2E `vacancies.spec.ts` (scratch stack :3260/:3261, crm_qa, MinIO): 8/8 passed, twice (before and
  after an isolation re-run confirming the branch didn't regress anything).
- Full local `apps/e2e` suite (90 files) on the same scratch stack: 223 failures — confirmed via
  isolated proof (same failures reproduce identically on a detached `origin/main` checkout with zero
  vacancy changes, same scratch stack) to be pre-existing environmental/seed-state gaps in the
  ad-hoc scratch DB, unrelated to this diff (zero overlap with "vacan" in any failure). CI's actual
  gate is the 5-shard allow-list (`ci.yml`), shard 5 includes `tests/vacancies.spec.ts` — verified
  green in isolation both before and after the isolation check.
- Visual: Playwright MCP screenshots — CLOSED+0 vacancy shows an enabled trash-icon delete button on
  the list card; clicking it opens the confirm dialog; confirming deletes it (list returns to empty
  state). PUBLISHED vacancy's detail-page Danger Zone button verified `disabled` via DOM query.
