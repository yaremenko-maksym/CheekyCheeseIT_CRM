# task-infra-drizzle-migrations-sync

## Агент: devops

## Приоритет: medium (не блокирует User Testing — dev DB работает)

## Ветка: claude/youthful-hermann-8df1d5

## Контекст

После Coder rebuild migration journal в PR #28 (commit `de38903`) `drizzle-kit migrate` не работает на dev-окружении:

```
db:migrate ENV: false
PostgresError: column "..." of relation "users" already exists
code: '42701' (column_name_collision)
```

Корень проблемы: на dev-машине таблица `__drizzle_migrations` отсутствует, так как все миграции применялись вручную через psql на ранних этапах разработки. `drizzle-kit migrate` видит пустую таблицу → пытается применить ВСЕ SQL с нуля → дубликаты колонок.

Production OK: fresh deploy создаст таблицу автоматически.

## Что сделать

1. **Создать `__drizzle_migrations` таблицу** на dev DB:

   ```sql
   CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
     id SERIAL PRIMARY KEY,
     hash text NOT NULL,
     created_at bigint
   );
   ```

   (Drizzle создаёт её в схеме `drizzle` или `public` в зависимости от config — проверь `drizzle.config.ts`.)

2. **Заполнить hash'и применённых миграций**. Для каждого SQL файла в `apps/api/drizzle/migrations/` (после rebuild journal'а — 0000..0008/0005 в зависимости от итоговой нумерации) вычислить SHA256 hash содержимого и вставить в таблицу.

3. **Альтернативно**: написать helper-script `apps/api/src/database/init-migrations-tracking.ts` который инициализирует таблицу — для удобства повторного выполнения.

4. **Документировать** в `apps/api/README.md` (создай если нет) шаг для dev-окружения: "Если БД была инициализирована до commit `de38903` — выполни `pnpm --filter @crm/api db:init-tracking` перед первым `db:migrate`".

5. **Проверить через `pnpm --filter @crm/api db:migrate`** что после fix таблица `__drizzle_migrations` имеет hash'и всех применённых миграций и `migrate` выдаёт "No migrations to apply".

## Acceptance

- `pnpm --filter @crm/api db:migrate` на текущей dev БД выдаёт "No migrations to apply" (или равноценный no-op)
- `bash scripts/pm/prep-user-testing.sh claude/youthful-hermann-8df1d5` проходит без ошибок
- На fresh БД (`DROP SCHEMA public CASCADE; CREATE SCHEMA;`) `db:migrate` всё ещё работает корректно (не сломали production path)
- Push в `claude/youthful-hermann-8df1d5`

## После завершения

Короткий summary: SHA коммита, hash'и для скольки миграций добавлены, верификация passed.
