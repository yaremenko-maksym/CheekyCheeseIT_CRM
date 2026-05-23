# Coder Lessons

Накопленные уроки от прошлых задач Coder. Формат: `YYYY-MM-DD [task-id] урок`.
См. [`../README.md`](../README.md) для правил и примеров.

---

2026-05-20 [P1] [task-fix-pr22-ui-round5] #layout #regression При правке layout читать существующие классы и контекст ДО замены блока. Round4 регрессия PR #22 = вернул TG в среднюю колонку вместо Pills, потому что не сверился с round3 контрактом.
2026-05-20 [P0] [task-fix-pr22-ui-round4] #commit-hygiene #worktree `git add .` подметает чужие debug-артефакты из worktree (apps/e2e/debug-*.png, test-telegram-ui.*). Только явный список файлов из task-секции "Конкретные изменения".
2026-05-19 [P0] [task-teams-redesign] #testing #data-testid `data-testid` обязателен для back-button, dialog-close, cancel-button — Playwright strict mode падает на дублях с sidebar/content nav-элементами.
2026-05-21 [P0] [task-profile-redesign] #testing #interaction Interaction tests обязательны для autocomplete/combobox/dropdown — Tab + ArrowDown коммит highlighted option должен быть unit-тестом, не только Enter. Smoke-test «Enter добавляет» пропустил Tab-баг в TechAutocomplete. См. coder.md секция 6.1 для чек-листа по типам компонентов.
2026-05-23 [P0] [dev-flow-rca] #chunking #recovery Wip-push после **каждых 2 файлов ИЛИ 5 минут** (раньше было 3 файла/30 мин — слишком мягко, Coder обрывался ДО первого милстоуна). См. coder.md секция 7.
2026-05-23 [P0] [dev-flow-rca] #sentinel #recovery Sentinel-файл `docs/specs/tasks/<task>.progress.md` обязателен — Coder обновляет last_update/last_commit/last_push, PM использует для recovery если silent crash. См. coder.md секция 8.
2026-05-23 [P0] [dev-flow-rca] #zone-of-write Coder ЗАПРЕЩЕНО трогать `scripts/pm/**`, `scripts/devops/**`, `docs/agents/**`, `docs/business/**`, `.github/workflows/**`, `.claude/hooks/**`. Real incident: 2026-05-23 Coder перезаписал PM-patches к scripts/pm/prep-user-testing.sh. См. coder.md «Zone-of-write».
2026-05-23 [P1] [task-coder-watchdog-intent-markers] #recovery #context Intent markers — opt-in semantic layer поверх auto-hook activity log. Перед длинной операцией (test run > 30 сек, AC start, milestone, rebase, migration) — `bash scripts/coder/coder-intent.sh "<intent>"`. Это даёт PM при recovery semantic контекст («что Coder намеревался»), а не только «что писал». См. coder.md секция 8.1.1. Anti-pattern: писать intent на каждый Edit (auto-hook уже покрывает — это spam).
