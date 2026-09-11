/**
 * task-notification-types-producers (позиция 6) — структурный контракт таблицы
 * `notifications` после добавления идентификаторов объекта (AC1).
 *
 * Зачем отдельная спека. Три вещи в объявлении таблицы не наблюдаются ни одним
 * тестом поведения на заглушках, а стоят дорого:
 *   - длина `dedupe_key` — ключ складывается из типа и идентификатора объекта и
 *     обязан поместиться целиком; обрезанный ключ склеил бы РАЗНЫЕ события в
 *     одно и потерял бы второе;
 *   - имя частичного уникального индекса — по нему `ON CONFLICT` находит
 *     ограничение, и без совпадения вставка падает на «no unique or exclusion
 *     constraint matching»;
 *   - его условие (`WHERE dedupe_key IS NOT NULL`) — без него строки БЕЗ ключа
 *     стали бы уникальными по (user_id, NULL) и перестали бы повторяться, хотя
 *     повторное предложение обязано спросить заново.
 *
 * Приём тот же, что в `approvals-schema.spec.ts`: две независимо выведенные
 * стороны — объект из `schema.ts`, скомпилированный настоящим диалектом, и
 * ЛИТЕРАЛ из файла прод-миграции. Совпадение сторон и есть утверждение; ни одна
 * из них не пересказывает другую.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core'
import { describe, expect, it } from 'vitest'

import { notifications } from './schema'

const MIGRATION_FILE = join(
  import.meta.dirname,
  '../../drizzle/manual/2026-09-07_notification_subjects.sql',
)

/** Снимает различия кавычек, квалификации и пробелов — как в соседних спеках. */
function normalize(sqlFragment: string): string {
  return sqlFragment
    .replace(/"/g, '')
    .replace(/\bnotifications\./gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

/** Тип колонки из `ALTER TABLE … ADD COLUMN IF NOT EXISTS <name> <type>;`. */
function columnTypeFromMigration(columnName: string): string {
  const sql = readFileSync(MIGRATION_FILE, 'utf-8')
  const match = new RegExp(
    `add\\s+column\\s+if\\s+not\\s+exists\\s+${columnName}\\s+([^;]+);`,
    'is',
  ).exec(sql)
  if (match === null) throw new Error(`no ADD COLUMN for ${columnName} in the migration`)
  return normalize(match[1]!)
}

/** Условие частичного индекса из `CREATE … INDEX … WHERE <predicate>;`. */
function indexWhereFromMigration(indexName: string): string {
  const sql = readFileSync(MIGRATION_FILE, 'utf-8')
  const match = new RegExp(
    `create\\s+unique\\s+index\\s+if\\s+not\\s+exists\\s+${indexName}\\b[\\s\\S]*?where\\s+([^;]+);`,
    'is',
  ).exec(sql)
  if (match === null) throw new Error(`no partial unique index ${indexName} in the migration`)
  return normalize(match[1]!)
}

describe('notifications — структурные идентификаторы в DDL', () => {
  it('новые колонки объявлены в schema.ts под теми же именами, что в миграции', () => {
    const { columns } = getTableConfig(notifications)
    const names = columns.map((c) => c.name)

    for (const name of ['subject_type', 'subject_id', 'secondary_id', 'data', 'dedupe_key']) {
      expect(names, `колонка ${name} обязана быть в таблице`).toContain(name)
    }
  })

  it('dedupe_key — varchar(200), ровно как в прод-миграции', () => {
    const { columns } = getTableConfig(notifications)
    const column = columns.find((c) => c.name === 'dedupe_key')!

    // Сторона 1 — объявление в schema.ts.
    expect(column.getSQLType().toLowerCase()).toBe('varchar(200)')
    // Сторона 2 — литерал из файла миграции, выведенный независимо.
    expect(column.getSQLType().toLowerCase()).toBe(columnTypeFromMigration('dedupe_key'))
  })

  it('subject_type — varchar(50), ровно как в прод-миграции', () => {
    const { columns } = getTableConfig(notifications)
    const column = columns.find((c) => c.name === 'subject_type')!

    expect(column.getSQLType().toLowerCase()).toBe('varchar(50)')
    expect(column.getSQLType().toLowerCase()).toBe(columnTypeFromMigration('subject_type'))
  })

  it('uq_notifications_user_dedupe — уникальный, по паре (user_id, dedupe_key)', () => {
    const { indexes } = getTableConfig(notifications)
    const index = indexes.find((i) => i.config.name === 'uq_notifications_user_dedupe')

    expect(index, 'индекс идемпотентности обязан существовать под своим именем').not.toBeUndefined()
    expect(index!.config.unique).toBe(true)
    expect(index!.config.columns.map((c) => (c as { name: string }).name)).toEqual([
      'user_id',
      'dedupe_key',
    ])
  })

  it('он ЧАСТИЧНЫЙ: строки без ключа ограничением не связаны', () => {
    const { indexes } = getTableConfig(notifications)
    const index = indexes.find((i) => i.config.name === 'uq_notifications_user_dedupe')!
    expect(index.config.where, 'частичный индекс обязан нести условие').toBeDefined()

    // Сторона 1 — условие из schema.ts, скомпилированное настоящим диалектом.
    const compiled = normalize(new PgDialect().sqlToQuery(index.config.where!, 'indexes').sql)
    expect(compiled.length).toBeGreaterThan(0)
    // Сторона 2 — литерал из файла миграции.
    expect(compiled).toBe(indexWhereFromMigration('uq_notifications_user_dedupe'))
    expect(compiled).toBe('dedupe_key is not null')
  })

  it('оба индекса listForUser тоже на месте — их имена несут смысл для плана запроса', () => {
    const { indexes } = getTableConfig(notifications)
    expect(indexes.map((i) => i.config.name).sort()).toEqual(
      [
        'idx_notifications_user_created',
        'idx_notifications_user_unread',
        'uq_notifications_user_dedupe',
      ].sort(),
    )
  })
})
