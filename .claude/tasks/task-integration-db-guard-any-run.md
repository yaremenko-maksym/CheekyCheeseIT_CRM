# task-integration-db-guard-any-run

## Агент: coder

## Модель: sonnet

## Ветка: fix/integration-db-guard-any-run (от origin/main)

## Design tier: — (не UI)

## Контекст

Найдено Coder-агентом на PR #369 и подтверждено security-reviewer'ом (MED, pre-existing):
shell в worktree наследует амбиентный `DATABASE_URL` из корневого `.env` (указывает на живую
`crm_db`). При **нефильтрованном** прогоне `pnpm --filter @crm/api test` integration-спеки
НЕ делают self-skip, а реально пишут в `crm_db`, потому что вся защита привязана к
`isIntegrationRun`:

- `apps/api/vitest.config.mts:115` — `isIntegrationRun = process.argv.some(arg => arg.includes('integration.spec'))`;
- globalSetup-guard `src/test/integration-db-guard.ts` (fail-fast на crm_db) подключается ТОЛЬКО при `isIntegrationRun` (строки ~149–153);
- `fileParallelism: false` — тоже только при `isIntegrationRun` → на нефильтрованном прогоне integration-спеки ещё и бегут ПАРАЛЛЕЛЬНО против одной БД (гонки).
- Комментарий «unit runs have no DATABASE_URL» (строка ~158) неверен при экспортированном ambient `DATABASE_URL` — воркеры его наследуют.

## Цель

Integration-спеки НИКОГДА не могут выполниться против `crm_db` — независимо от способа запуска
(фильтрованный/нефильтрованный, любой ambient env), вне CI.

## Предпочтительный дизайн (проверить осуществимость, отклонение — обосновать в PR)

На **нефильтрованном** прогоне integration-спеки вообще НЕ выполняются: skip с громким
однострочным warning'ом («integration specs skipped: run via `vitest run … integration.spec`»),
unit-тесты при этом бегут и остаются зелёными. Это закрывает и запись в crm_db, и класс гонок
параллельного выполнения. Реализация — например, ранний runtime-чек в общем helper'e
integration-спек (как сейчас работает graceful-skip при пустом DATABASE_URL — найти этот механизм
и расширить) ЛИБО env-флаг из vitest.config при !isIntegrationRun. Fail-throw всего прогона —
НЕ вариант по умолчанию (ломает DX unit-прогонов), допустим только точечно если спека уже
стартовала против crm_db.

## Инварианты (сохранить)

1. Пустой `DATABASE_URL=` → graceful-skip как сейчас (на этом стоит pre-push git-policy).
2. `CI=true` → throwaway container, всё разрешено (текущее исключение guard'а).
3. Фильтрованный integration-прогон против crm_qa — без изменений поведения: guard активен,
   `fileParallelism: false`, всё зелёное.
4. Guard fail-fast на crm_db в integration-прогоне НЕ ослаблять.
5. Production-код (вне `apps/api/src/test/**`, `vitest.config.mts`, spec-файлов) не трогать.

## AC

1. [x] Экспортирован `DATABASE_URL=...crm_db` + `pnpm --filter @crm/api test` (без фильтра):
       **0 записей в crm_db** (row-count снапшот по таблицам до/после, 25 таблиц — identical),
       integration-спеки скипнуты с явной причиной (`[vitest.config] non-integration run —
skipping all *.integration.spec.ts files ...`), unit-тесты зелёные (81 files / 1592 tests).
2. [x] То же с `DATABASE_URL=...crm_qa` (нефильтрованный): integration-спеки не выполняются
       (0 файлов `*.integration.spec.ts` в выводе, row-count diff = пусто), unit зелёные
       (81 files / 1592 tests).
3. [x] Фильтрованный прогон `integration.spec` против crm_qa — механизм подтверждён неизменным:
       guard активен (`[integration-db-guard] OK — using database: crm_qa`), последовательно
       (fileParallelism gate untouched). 68/71 файлов зелёные; 3 файла (8 тестов) падают на
       ПРЕДСУЩЕСТВУЮЩЕЙ crm_qa-фикстуре/бизнес-логике (`payment_type` NOT NULL / assertHrCanManageProject),
       НЕ связанной с этим фиксом — доказано isolated-прогоном тех же 3 файлов на чистом
       `origin/main` (detached HEAD, без моих изменений): идентичные 8 failures. Вне зоны/scope
       этой задачи (task инвариант #5 — production-код не трогать); флагирую PM как отдельный
       follow-up (crm_qa data/schema drift или reál баг в createFromInterview payment_type).
4. [x] Пустой `DATABASE_URL=` → graceful-skip сохранён (лог `[integration-db-guard] DATABASE_URL
is not set` через per-spec dbAvailable-guard; наш warning тоже присутствует), unit зелёные.
5. [x] Комментарий в vitest.config.mts про «unit runs have no DATABASE_URL» исправлен (2 места).
6. [x] `pnpm typecheck` зелёный (`@crm/api`); `mcp__eslint__lint-files` на изменённых файлах чистый.
7. [x] `git diff --name-only origin/main..HEAD` — только `apps/api/**` + `.claude/tasks/*.md`.

## Верификация / git

- Push: `DATABASE_URL= git push`. Commit: `fix(api): ...` / `test(api): ...` + `ac_verified:`.
- PR: обычный пайплайн, base main. НЕ трогать merge-approved.
- Свежий worktree: `pnpm install --frozen-lockfile`.
