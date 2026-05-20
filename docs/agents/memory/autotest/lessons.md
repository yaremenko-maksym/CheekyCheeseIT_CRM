# AutoTest Lessons

Накопленные уроки от прошлых задач AutoTest. Формат: `YYYY-MM-DD [task-id] урок`.
См. [`../README.md`](../README.md) для правил и примеров.

---

2026-05-20 [task-fix-pr22-ui-round5] Не коммитить debug-screenshots в `apps/e2e/` — складывать в `/tmp/autotest-<runid>/`. Чужие commit'ы потом подметают их через `git add .`.
2026-05-19 [task-fix-e2e-team-selectors] При смене UI текстов — обновлять selector'ы в spec.ts В ТОМ ЖЕ commit'е что и UI. Расхождение → flaky E2E на main.
2026-05-18 [task-fix-flaky-tests] userEvent.setup({delay: null}) стабилизирует тесты — иначе race conditions с act() warnings в RTL.
