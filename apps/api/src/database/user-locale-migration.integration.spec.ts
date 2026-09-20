/**
 * Идемпотентность миграции `2026-09-20_user_locale.sql` (task-i18n-stage2,
 * Task 3) — по образцу `notification-email-migrations.integration.spec.ts`.
 *
 * `deploy.yml` применяет каждый файл `manual/*.sql` НА КАЖДОМ деплое, а не
 * один раз: реестра применённых миграций у нас нет, и «применить ещё раз»
 * обязано быть безвредным навсегда. Проверяется исполнением — файл гоняется
 * ДВАЖДЫ подряд, и второй прогон обязан пройти без единой ошибки.
 *
 * Почему это не проверить глазами: `CREATE TYPE` у Postgres формы
 * `IF NOT EXISTS` НЕ имеет — enum приходится оборачивать `DO $$ … END $$`, и
 * именно эту обёртку легко забыть. Ошибка всплыла бы вторым деплоем, то есть
 * уже на проде (`ALTER TABLE … ADD COLUMN IF NOT EXISTS` формы имеет, поэтому
 * колонка сама по себе не поймала бы забытую обёртку типа).
 *
 * Прогон идёт в ОТДЕЛЬНОЙ схеме, а не в `public`: у scratch-базы после
 * `drizzle-kit push` уже есть тип `user_locale` и колонка `users.locale`, и
 * без изоляции `CREATE TYPE`/`ADD COLUMN` не создали бы ничего и доказали бы
 * ровно ничего про ЭТОТ файл.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { hasDatabaseUrl } from '../test/require-real-db'

const MIGRATION_FILE = '2026-09-20_user_locale.sql'
const SCHEMA = 'mig_user_locale_check'

let pool: Pool

function sqlFor(name: string): string {
  return readFileSync(join(__dirname, '..', '..', 'drizzle', 'manual', name), 'utf8')
}

describe.skipIf(!hasDatabaseUrl())('миграция users.locale идемпотентна', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env['DATABASE_URL'] })
    await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
    await pool.query(`CREATE SCHEMA ${SCHEMA}`)
    // Файл ссылается только на `users` (ALTER TABLE) — минимальная заглушка
    // с той же формой, что и настоящая таблица (id + role-ish columns не
    // нужны, только сама таблица должна существовать).
    await pool.query(`CREATE TABLE ${SCHEMA}.users (id uuid PRIMARY KEY)`)
  })

  afterAll(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
    await pool.end()
  })

  it('применяется дважды подряд без ошибок', async () => {
    const sql = sqlFor(MIGRATION_FILE)
    const client = await pool.connect()
    try {
      await client.query(`SET search_path TO ${SCHEMA}`)
      await client.query(sql)
      // Второй прогон — то, что делает каждый следующий деплой.
      await client.query(sql)
    } finally {
      client.release()
    }

    // Не «не упало», а «колонка на месте»: миграция, целиком закомментированная
    // по ошибке, тоже не падает дважды.
    const cols = await pool.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = 'users' AND column_name = 'locale'`,
      [SCHEMA],
    )
    expect(cols.rowCount).toBe(1)
  })

  it('тип создан ровно один раз и несёт два значения', async () => {
    // Именно здесь ловится забытая обёртка `DO $$ … END $$`: без неё второй
    // прогон упал бы на «type already exists» ещё в тесте выше. Схема
    // указывается явно: у scratch-базы уже есть одноимённый тип в `public`
    // (его создал `drizzle-kit push`), и запрос без неё сложил бы значения
    // двух разных типов в один список.
    const labels = await pool.query(
      `SELECT enumlabel FROM pg_enum e
         JOIN pg_type t ON t.oid = e.enumtypid
         JOIN pg_namespace n ON n.oid = t.typnamespace
        WHERE t.typname = 'user_locale' AND n.nspname = $1
        ORDER BY e.enumsortorder`,
      [SCHEMA],
    )
    expect(labels.rows.map((r: { enumlabel: string }) => r.enumlabel)).toEqual(['uk', 'en'])
  })

  it('колонка NOT NULL с умолчанием uk — совпадает с тем, что объявляет schema.ts', async () => {
    // Два описания одной колонки — файл миграции и `schema.ts`. Разойдутся —
    // прод будет вести себя не так, как тесты на drizzle-объекте.
    const cols = await pool.query(
      `SELECT column_default, is_nullable
         FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = 'users' AND column_name = 'locale'`,
      [SCHEMA],
    )
    expect(cols.rowCount).toBe(1)
    expect(cols.rows[0].is_nullable).toBe('NO')
    expect(cols.rows[0].column_default).toContain('uk')
  })

  it('«locale» доезжает и до базы, которая помнит версию таблицы без него', async () => {
    // Сценарий «была таблица users без locale → применили файл» — как у
    // соседнего теста для STALE skip reason (notification-email-migrations).
    const legacy = 'mig_user_locale_legacy'
    const client = await pool.connect()
    try {
      await client.query(`DROP SCHEMA IF EXISTS ${legacy} CASCADE`)
      await client.query(`CREATE SCHEMA ${legacy}`)
      await client.query(`SET search_path TO ${legacy}`)
      await client.query(`CREATE TABLE users (id uuid PRIMARY KEY)`)

      await client.query(sqlFor(MIGRATION_FILE))

      const cols = await client.query(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = $1 AND table_name = 'users'`,
        [legacy],
      )
      expect(cols.rows.map((r: { column_name: string }) => r.column_name)).toContain('locale')
    } finally {
      await client.query(`DROP SCHEMA IF EXISTS ${legacy} CASCADE`).catch(() => undefined)
      client.release()
    }
  })
})
