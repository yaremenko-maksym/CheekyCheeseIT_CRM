# task-integration-spec-cleanup

## Агент: coder

## Модель: sonnet

## Ветка: test/integration-spec-cleanup (от origin/main)

## Design tier: — (не UI; diff не трогает apps/web / apps/landing)

## Контекст

Backend-coder на PR #367 (2026-07-13) задокументировал с isolated proof **pre-existing** проблему:
`apps/api/src/finance/income-compliance.integration.spec.ts` и
`apps/api/src/admin/admin-summary.integration.spec.ts` падают ТОЛЬКО при полном последовательном
прогоне integration-набора против общей `crm_qa` (16/16 идентичных падений на чистом base-коде со
стэшем изменений), а изолированно на свежем re-seed проходят 30/30.

**Причина** — межспековое загрязнение общей БД: часть integration-спек не убирает за собой данные
(строки в `transactions` / `pending_obligations` / `projects` / `users` / `project_members` /
`payout_requests` и др.), а эти две спеки считают company-wide агрегаты (суммы по ВСЕЙ базе),
которые дрейфуют от чужих остатков.

Технический контекст:

- Integration-прогоны уже последовательные: `apps/api/vitest.config.mts` ставит
  `fileParallelism: false` для integration-запусков (см. `isIntegrationRun` в конфиге).
- БД-таргет: `.env.test` → `crm_qa` (vitest подхватывает автоматически);
  `apps/api/src/test/integration-db-guard.ts` блокирует запуск против `crm_db` — его семантику НЕ менять.
- Реальная dev-БД — нативный postgres `localhost:5432` (НЕ docker-контейнер).
- Эталонный паттерн «убирает за собой» — новая спека PR #367:
  `apps/api/src/finance/usdt-income-obligations.integration.spec.ts` на ветке
  `feature/drop-share-override-and-receiver` (читать через
  `git fetch origin feature/drop-share-override-and-receiver` +
  `git show origin/feature/drop-share-override-and-receiver:apps/api/src/finance/usdt-income-obligations.integration.spec.ts`).
  Ветку #367 НЕ трогать и НЕ мержить — только читать как образец.

## Scope / зона

- ТОЛЬКО `apps/api/**`: `*.integration.spec.ts` + при необходимости общий тест-хелпер в
  `apps/api/src/test/` (например, утилита scoped-фикстур/cleanup).
- Production-код (не-spec файлы в `apps/api/src`) НЕ менять. Если пришёл к выводу, что загрязнение
  вызвано багом продакшен-кода (endpoint оставляет сирот) — НЕ фиксить самому, задокументировать в
  `.claude/tasks/task-integration-spec-cleanup.blocked.md` + отметить в PR.

## Конкретные изменения

1. **Аудит cleanup-дисциплины** всех `*.integration.spec.ts` в `apps/api` (~71 файл).
   Классифицировать каждую: (a) создаёт строки и полностью убирает в afterAll/afterEach;
   (b) создаёт и НЕ убирает (нарушитель); (c) read-only. Первичный метод — чтение
   beforeAll/afterAll; при сомнении — эмпирика (row-count снапшоты до/после файла против crm_qa).
2. **Паттерн A — нарушители:** project-scoped/prefixed фикстуры (уникальный префикс спеки в
   email/названиях) + `afterAll`-cleanup, удаляющий ВСЁ созданное (children → parents по FK).
   Образец — спека из PR #367 выше.
3. **Паттерн B — company-wide агрегатные спеки** (`income-compliance`, `admin-summary`; проверить
   на ту же хрупкость `senior-summary`, `accountant-summary`, `hr-summary`, `total-earned`,
   `transactions.summary.rbac` и другие summary-спеки): переписать assert'ы на **дельту**
   (снапшот агрегата до вставки scoped-фикстур → assert `after == before + ожидаемая дельта`)
   ЛИБО изолированный расчёт по scoped-фикстурам. Абсолютные company-wide суммы — убрать.
   Выделенный порядок прогона / отдельная БД — только как fallback с обоснованием в PR.
4. **Запрещено:** удалять/скипать падающие тесты, ослаблять assert'ы «чтобы прошло»
   (расширение допусков без scoped-логики), менять `integration-db-guard.ts`, трогать `apps/e2e/**`.

## AC

1. [ ] В PR body — аудит-таблица: `спека → какие таблицы пачкает → применённый фикс (A/B/read-only)`
       по всем ~71 integration-спекам.
2. [ ] Все спеки-нарушители получили prefixed-фикстуры + afterAll-cleanup (паттерн A).
3. [ ] Company-wide агрегатные спеки assert'ят дельты / scoped-расчёт, не абсолюты (паттерн B).
4. [ ] Верификация: re-seed crm_qa один раз (baseline) → полный последовательный integration-прогон
       **×2 подряд БЕЗ re-seed между прогонами** — оба зелёные. Итоговые summary-строки обоих
       прогонов — в PR body. (Второй зелёный прогон доказывает cleanup-дисциплину.)
5. [ ] `pnpm --filter @crm/api test` (unit, без DATABASE_URL) зелёный; `pnpm typecheck` зелёный;
       `mcp__eslint__lint-files` на всех изменённых файлах чистый.
6. [ ] `pnpm --filter @crm/e2e test` локально зелёный перед финальным push (в diff есть код).
7. [ ] Diff не содержит файлов вне `apps/api/**` (spec + test-хелперы) — проверить
       `git diff --name-only origin/main..HEAD`.

## Верификация / git

- Push: `DATABASE_URL= git push` (пустой — git-policy; integration-спеки graceful-skip в pre-push).
- Commit: `test(api): ...` + `ac_verified: ...`.
- PR: обычный пайплайн, base main. НЕ трогать лейблы merge-approved.
- Свежий worktree: `pnpm install --frozen-lockfile` перед работой (husky/worktree gotcha).
