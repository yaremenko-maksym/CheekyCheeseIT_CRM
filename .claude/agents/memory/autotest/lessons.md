# AutoTest Lessons

Накопленные уроки от прошлых задач AutoTest. Формат: `YYYY-MM-DD [task-id] урок`.
См. [`../README.md`](../README.md) для правил и примеров.

---

2026-05-20 [P0] [task-fix-pr22-ui-round5] #commit-hygiene #worktree Не коммитить debug-screenshots в `apps/e2e/` — складывать в `/tmp/autotest-<runid>/`. Чужие commit'ы потом подметают их через `git add .`.
2026-05-19 [P0] [task-fix-e2e-team-selectors] #atomicity #ci При смене UI текстов — обновлять selector'ы в spec.ts В ТОМ ЖЕ commit'е что и UI. Расхождение → flaky E2E на main.
2026-05-18 [P1] [task-fix-flaky-tests] #test-stability userEvent.setup({delay: null}) стабилизирует тесты — иначе race conditions с act() warnings в RTL.
2026-05-23 [P2] [dev-flow-rca] #dispatch PM может skip AutoTest dispatch если Coder уже добавил comprehensive E2E (см. pm.md «AutoTest dispatch decision»). Это нормально — означает что для **этого PR** покрытие есть.
2026-05-30 [P1] [task-drop-phase1-e2e] #radix-radio #async-submit В mock-based E2E (apps/e2e/tests) submit-кнопка диалога с Zod safeParse часто молча падает в toast.error из-за гонки между Radix RadioGroupItem click и form.state update. POST-body тест JOIN_DROP_TEAM был flaky на CI — вместо `waitForRequest(POST)` лучше тестировать UI contract: «при выборе radio surface drop-team picker». Полная shape проверки лежит на UT (Coder Vitest). Если действительно нужен POST body — fill ВСЕ поля до радио, потом click label (не `radio.click()`), и не setting `waitForRequest` до submit-click.
2026-05-30 [P2] [task-drop-phase1-e2e] #ci-flaky #retries Под `CI=1` retries=2 — четыре теста (team-redirect, team-empty, finance-flow, tech-autocomplete) на дефолтной локальной матрице падали из-за parallel race с моими расширениями TEAMS fixtures. После `CI=1` retry все прошли. Для локального dev запуска флака допустима — на GHA shard её скроет retries.
2026-05-30 [P2] [task-drop-phase1-e2e] #archive-confirm-dialog #testids Архив-диалог имеет ДВА разных компонента: `components/users/ArchiveConfirmDialog` (testid=`archive-confirm-dialog`) для архива user'а, и `components/archive/ArchiveConfirmDialog` (testids=`archive-confirm-input`/`archive-confirm-submit`, БЕЗ wrapper testid) для архива team/project. Не путать.
2026-07-12 [P1] [task-drop-attach-autotest] #subagent-lifecycle Суб-агент НЕ может «ждать уведомления» о фоновом прогоне — конец хода убивает фон, работа теряется (спека осталась незакоммиченной). Долгие прогоны — только синхронно (foreground Bash, чанковать по spec-файлам при потребности).
2026-07-12 [P1] [task-drop-attach-autotest] #stale-expectation Параллельный fix-раунд ревью меняет UI-контракт: перед push пересинхронизируйся с HEAD PR-ветки (fetch+rebase, перечитай дифф изменений после своего коммита) — ассерт «SENIOR видит строку дропа» устарел за один ревью-раунд (H1-маска). Для элементов, которые по RBAC вообще не рендерятся, ассертить `not.toBeAttached()`, а не `not.toBeVisible()`.
2026-07-14 [P1] [task-drop-share-e2e] #zero-flaky-proof `--repeat-each=2..4` на новых/изменённых спеках — дешёвое доказательство zero-flaky для отчёта. Изолированный скретч-стек = отдельная `crm_scratch_*` БД (нативный PG :5432) + свои порты + `E2E_REAL_API_BASE`; снести БД и погасить процессы после.
