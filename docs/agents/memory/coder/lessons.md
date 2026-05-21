# Coder Lessons

Накопленные уроки от прошлых задач Coder. Формат: `YYYY-MM-DD [task-id] урок`.
См. [`../README.md`](../README.md) для правил и примеров.

---

2026-05-20 [task-fix-pr22-ui-round5] При правке layout читать существующие классы и контекст ДО замены блока. Round4 регрессия PR #22 = вернул TG в среднюю колонку вместо Pills, потому что не сверился с round3 контрактом.
2026-05-20 [task-fix-pr22-ui-round4] `git add .` подметает чужие debug-артефакты из worktree (apps/e2e/debug-*.png, test-telegram-ui.*). Только явный список файлов из task-секции "Конкретные изменения".
2026-05-19 [task-teams-redesign] `data-testid` обязателен для back-button, dialog-close, cancel-button — Playwright strict mode падает на дублях с sidebar/content nav-элементами.
2026-05-21 [task-profile-redesign] Interaction tests обязательны для autocomplete/combobox/dropdown — Tab + ArrowDown коммит highlighted option должен быть unit-тестом, не только Enter. Smoke-test «Enter добавляет» пропустил Tab-баг в TechAutocomplete. См. coder.md секция 6.1 для чек-листа по типам компонентов.
