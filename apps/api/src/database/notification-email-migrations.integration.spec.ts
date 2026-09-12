/**
 * Идемпотентность двух миграций позиции 7a — AC6.
 *
 * `deploy.yml` применяет каждый файл `manual/*.sql` НА КАЖДОМ деплое, а не
 * один раз: реестра применённых миграций у нас нет, и «применить ещё раз»
 * обязано быть безвредным навсегда. Проверяется исполнением — файл гоняется
 * ДВАЖДЫ подряд, и второй прогон обязан пройти без единой ошибки.
 *
 * Почему это не проверить глазами: `CREATE TABLE IF NOT EXISTS` заметен, а вот
 * `CREATE TYPE` у Postgres формы `IF NOT EXISTS` НЕ имеет — enum приходится
 * оборачивать `DO $$ … END $$`, и именно эту обёртку легко забыть. Ошибка
 * всплыла бы вторым деплоем, то есть уже на проде.
 *
 * Прогон идёт в ОТДЕЛЬНОЙ схеме, а не в `public`: файлы создают те же
 * таблицы, что уже есть у scratch-базы после `drizzle-kit push`, и без
 * изоляции первый же `CREATE TABLE IF NOT EXISTS` не создал бы ничего и
 * доказал бы ровно ничего.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { hasDatabaseUrl } from '../test/require-real-db'

const MIGRATIONS = [
  '2026-09-12_notification_emails.sql',
  '2026-09-12_notification_preferences.sql',
] as const

const SCHEMA = 'mig_7a_check'

let pool: Pool

function sqlFor(name: string): string {
  return readFileSync(join(__dirname, '..', '..', 'drizzle', 'manual', name), 'utf8')
}

describe.skipIf(!hasDatabaseUrl())('миграции позиции 7a идемпотентны', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env['DATABASE_URL'] })
    await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
    await pool.query(`CREATE SCHEMA ${SCHEMA}`)
    // Обе миграции ссылаются на `notifications` и `users` внешними ключами.
    // Настоящие таблицы в изолированной схеме не нужны — нужны их ключи, и
    // минимальные заглушки дают ровно это.
    await pool.query(`CREATE TABLE ${SCHEMA}.users (id uuid PRIMARY KEY)`)
    await pool.query(`CREATE TABLE ${SCHEMA}.notifications (id uuid PRIMARY KEY)`)
  })

  afterAll(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
    await pool.end()
  })

  it.each(MIGRATIONS)('%s применяется дважды подряд без ошибок', async (name) => {
    const sql = sqlFor(name)
    const client = await pool.connect()
    try {
      await client.query(`SET search_path TO ${SCHEMA}`)
      await client.query(sql)
      // Второй прогон — то, что делает каждый следующий деплой.
      await client.query(sql)
    } finally {
      client.release()
    }

    // Не «не упало», а «объекты на месте»: миграция, целиком закомментированная
    // по ошибке, тоже не падает дважды.
    const tableName = name.includes('emails') ? 'notification_emails' : 'notification_preferences'
    const tables = await pool.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2`,
      [SCHEMA, tableName],
    )
    expect(tables.rowCount).toBe(1)
  })

  it('очередь получила оба своих индекса, а не только таблицу', async () => {
    const idx = await pool.query(
      `SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND tablename = 'notification_emails'`,
      [SCHEMA],
    )
    const names = idx.rows.map((r: { indexname: string }) => r.indexname)
    expect(names).toContain('uq_notification_emails_notification')
    expect(names).toContain('idx_notification_emails_due')
  })

  it('настройки получили свой уникальный индекс', async () => {
    const idx = await pool.query(
      `SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND tablename = 'notification_preferences'`,
      [SCHEMA],
    )
    expect(idx.rows.map((r: { indexname: string }) => r.indexname)).toContain(
      'uq_notification_preferences_user_type',
    )
  })

  it('тип статуса создан ровно один раз и несёт три значения', async () => {
    // Именно здесь ловится забытая обёртка `DO $$ … END $$`: без неё второй
    // прогон упал бы на «type already exists» ещё в тесте выше.
    // Схема указывается явно: у scratch-базы уже есть одноимённый тип в
    // `public` (его создал `drizzle-kit push`), и запрос без неё сложил бы
    // значения двух разных типов в один список.
    const labels = await pool.query(
      `SELECT enumlabel FROM pg_enum e
         JOIN pg_type t ON t.oid = e.enumtypid
         JOIN pg_namespace n ON n.oid = t.typnamespace
        WHERE t.typname = 'notification_email_status' AND n.nspname = $1
        ORDER BY e.enumsortorder`,
      [SCHEMA],
    )
    expect(labels.rows.map((r: { enumlabel: string }) => r.enumlabel)).toEqual([
      'QUEUED',
      'SENT',
      'FAILED',
    ])
  })

  it('умолчания совпадают с тем, что объявляет schema.ts', async () => {
    // Два описания одной таблицы — файл миграции и `schema.ts`. Разойдутся —
    // прод будет вести себя не так, как тесты на drizzle-объекте.
    const cols = await pool.query(
      `SELECT column_name, column_default, is_nullable
         FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = 'notification_emails'`,
      [SCHEMA],
    )
    const byName = new Map(
      cols.rows.map((r: { column_name: string; column_default: string | null }) => [
        r.column_name,
        r.column_default,
      ]),
    )
    expect(byName.get('status')).toContain('QUEUED')
    expect(byName.get('attempts')).toBe('0')
    expect(byName.get('next_attempt_at')).toContain('now()')
  })
})
