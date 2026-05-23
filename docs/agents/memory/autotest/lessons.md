# AutoTest Lessons

Накопленные уроки от прошлых задач AutoTest. Формат: `YYYY-MM-DD [task-id] урок`.
См. [`../README.md`](../README.md) для правил и примеров.

---

2026-05-20 [P0] [task-fix-pr22-ui-round5] #commit-hygiene #worktree Не коммитить debug-screenshots в `apps/e2e/` — складывать в `/tmp/autotest-<runid>/`. Чужие commit'ы потом подметают их через `git add .`.
2026-05-19 [P0] [task-fix-e2e-team-selectors] #atomicity #ci При смене UI текстов — обновлять selector'ы в spec.ts В ТОМ ЖЕ commit'е что и UI. Расхождение → flaky E2E на main.
2026-05-18 [P1] [task-fix-flaky-tests] #test-stability userEvent.setup({delay: null}) стабилизирует тесты — иначе race conditions с act() warnings в RTL.
2026-05-23 [P2] [dev-flow-rca] #dispatch PM может skip AutoTest dispatch если Coder уже добавил comprehensive E2E (см. pm.md «AutoTest dispatch decision»). Это нормально — означает что для **этого PR** покрытие есть.
