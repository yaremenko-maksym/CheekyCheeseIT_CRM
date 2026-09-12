/**
 * Позиция 7a: форма двух новых таблиц — `notification_emails` (очередь
 * отправки) и `notification_preferences` (настройки каналов).
 *
 * Зачем отдельная спека на объявление таблицы: гейт мутаций не исполняет ни
 * одной интеграционной спеки (`.claude/rules/common/mutation-gate-integration-
 * specs.md`), а значит имена индексов, `onDelete`, умолчания и предикаты
 * частичных индексов не проверяет НИЧЕГО из того, что он умеет запустить.
 * Тот же приём, что у `user-emails-schema.spec.ts` и
 * `pending-obligations-payout-link-schema.spec.ts`: компилируем НАСТОЯЩИЙ
 * объект drizzle из `schema.ts` и утверждаем про него, а не про его
 * пересказ руками. Живая Postgres тут не нужна — `getTableConfig` чисто
 * компиляционная интроспекция.
 */
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core'
import type { SQL } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'

import { notificationEmailStatusEnum, notificationEmails, notificationPreferences } from './schema'

/**
 * Полная форма колонки: имя, SQL-тип, обязательность, умолчание.
 *
 * Таблица целиком, а не выборочные утверждения: `varchar(255)` вместо
 * `varchar(200)`, `timestamp` без часового пояса, потерянный `NOT NULL` — всё
 * это молча расходится с миграцией, которую применяют на проде, и увидеть
 * расхождение можно только сравнив ОБА описания с третьим — вот с этим.
 *
 * Ожидаемое выписано руками из решений задачи, а не снято с самого объекта:
 * снимок согласился бы с любой правкой.
 */
/** Имена колонок индекса — сам индекс хранит выражения, а не имена. */
function columnNamesOf(idx: { config: { columns: unknown[] } } | undefined): string[] {
  return (idx?.config.columns ?? []).map((c) => (c as { name?: string }).name ?? String(c))
}

function shapeOf(table: Parameters<typeof getTableConfig>[0]) {
  return getTableConfig(table).columns.map((c) => ({
    name: c.name,
    type: c.getSQLType(),
    notNull: c.notNull,
    hasDefault: c.hasDefault,
  }))
}

describe('notification_emails — форма объявления', () => {
  it('называется notification_emails', () => {
    expect(getTableConfig(notificationEmails).name).toBe('notification_emails')
  })

  it('колонки — ровно эти, ровно таких типов', () => {
    expect(shapeOf(notificationEmails)).toEqual([
      { name: 'id', type: 'uuid', notNull: true, hasDefault: true },
      { name: 'notification_id', type: 'uuid', notNull: true, hasDefault: false },
      { name: 'user_id', type: 'uuid', notNull: true, hasDefault: false },
      { name: 'status', type: 'notification_email_status', notNull: true, hasDefault: true },
      { name: 'attempts', type: 'integer', notNull: true, hasDefault: true },
      {
        name: 'next_attempt_at',
        type: 'timestamp with time zone',
        notNull: true,
        hasDefault: true,
      },
      { name: 'sent_at', type: 'timestamp with time zone', notNull: false, hasDefault: false },
      // 255 — та же длина, что у `user_emails.email`: сюда попадает ровно
      // значение оттуда, и более короткая колонка обрезала бы адрес.
      { name: 'sent_to_email', type: 'varchar(255)', notNull: false, hasDefault: false },
      { name: 'last_error', type: 'varchar(200)', notNull: false, hasDefault: false },
      { name: 'created_at', type: 'timestamp with time zone', notNull: true, hasDefault: true },
      { name: 'updated_at', type: 'timestamp with time zone', notNull: true, hasDefault: true },
    ])
  })

  it('статус доставки — три значения в этом порядке', () => {
    // `SENDING` здесь нет намеренно: захват выражается арендой, а не статусом
    // (см. комментарий к enum в `schema.ts`). Появись он — это осознанная
    // смена механики, и падать здесь она обязана.
    expect(notificationEmailStatusEnum.enumValues).toEqual(['QUEUED', 'SENT', 'FAILED'])
    expect(notificationEmailStatusEnum.enumName).toBe('notification_email_status')
  })

  it('строка умирает вместе со своим уведомлением (ON DELETE CASCADE)', () => {
    // Уведомление удалил сам получатель (`DELETE /api/notifications/:id`) —
    // слать по нему письмо уже не о чем, а осиротевшая строка очереди
    // ссылалась бы в никуда: текст письма собирается из уведомления в момент
    // отправки, своей копии текста у очереди нет.
    const { foreignKeys } = getTableConfig(notificationEmails)
    const fk = foreignKeys.find((f) => f.reference().foreignTable === undefined)
    expect(fk).toBeUndefined()
    const refs = foreignKeys.map((f) => f.onDelete)
    expect(refs).toHaveLength(2)
    expect(new Set(refs)).toEqual(new Set(['cascade']))
  })

  it('новая строка — QUEUED с нулём попыток', () => {
    const { columns } = getTableConfig(notificationEmails)
    const status = columns.find((c) => c.name === 'status')
    const attempts = columns.find((c) => c.name === 'attempts')
    expect(status?.default).toBe('QUEUED')
    expect(status?.notNull).toBe(true)
    expect(attempts?.default).toBe(0)
    expect(attempts?.notNull).toBe(true)
  })

  it('одно письмо на уведомление — уникальный индекс по notification_id', () => {
    // Идемпотентность второго порядка: уведомление уже гасит повтор события
    // частичным индексом по `dedupe_key`, а этот индекс гасит повтор ПОСТАНОВКИ
    // письма — второй вызов `enqueue` для той же строки ничего не создаёт.
    const { indexes } = getTableConfig(notificationEmails)
    const idx = indexes.find((i) => i.config.name === 'uq_notification_emails_notification')
    expect(
      idx,
      `ожидался индекс 'uq_notification_emails_notification' — есть: ${indexes
        .map((i) => i.config.name)
        .join(', ')}`,
    ).toBeDefined()
    expect(idx?.config.unique).toBe(true)
  })

  it('очередь читается по индексу срока, а не полным сканом', () => {
    const { indexes } = getTableConfig(notificationEmails)
    const idx = indexes.find((i) => i.config.name === 'idx_notification_emails_due')
    expect(idx).toBeDefined()
    expect(idx?.config.unique).toBeFalsy()
    // Именно по сроку: индекс по любой другой колонке не помог бы выборке
    // «созревшие, самые старые вперёд».
    expect(columnNamesOf(idx)).toEqual(['next_attempt_at'])
  })

  it('индекс срока — ЧАСТИЧНЫЙ, только по QUEUED', () => {
    // Отправленные и похороненные строки копятся навсегда. Без предиката
    // индекс растёт вместе с ними, и крон платит за них каждые 15 секунд.
    // Плюс предикат обязан совпадать с условием выборки, иначе Postgres
    // индексом просто не воспользуется.
    const { indexes } = getTableConfig(notificationEmails)
    const idx = indexes.find((i) => i.config.name === 'idx_notification_emails_due')
    const where = new PgDialect().sqlToQuery(idx!.config.where as SQL).sql
    expect(where).toContain('status')
    expect(where).toContain("'QUEUED'")
  })

  it('уникальный индекс стоит на notification_id, а не на чём-то ещё', () => {
    const { indexes } = getTableConfig(notificationEmails)
    const idx = indexes.find((i) => i.config.name === 'uq_notification_emails_notification')
    expect(columnNamesOf(idx)).toEqual(['notification_id'])
  })

  it('ключи ведут к уведомлению и к пользователю', () => {
    const { foreignKeys } = getTableConfig(notificationEmails)
    const refs = foreignKeys.map((fk) => {
      const r = fk.reference()
      return {
        from: r.columns.map((c) => c.name),
        to: getTableConfig(r.foreignTable).name,
        toColumns: r.foreignColumns.map((c) => c.name),
      }
    })
    expect(refs).toEqual(
      expect.arrayContaining([
        { from: ['notification_id'], to: 'notifications', toColumns: ['id'] },
        { from: ['user_id'], to: 'users', toColumns: ['id'] },
      ]),
    )
  })

  it('адрес и текст ошибки — ограниченной длины (в журнал уходит не всё подряд)', () => {
    const { columns } = getTableConfig(notificationEmails)
    const sentTo = columns.find((c) => c.name === 'sent_to_email')
    const lastError = columns.find((c) => c.name === 'last_error')
    expect(sentTo?.notNull).toBe(false)
    expect(lastError?.notNull).toBe(false)
  })

  it('все отметки времени — с часовым поясом', () => {
    const { columns } = getTableConfig(notificationEmails)
    const stamps = columns.filter((c) => c.getSQLType().startsWith('timestamp'))
    expect(stamps.length).toBeGreaterThanOrEqual(4)
    for (const c of stamps) {
      expect(c.getSQLType(), `${c.name} без часового пояса`).toContain('with time zone')
    }
  })
})

describe('notification_preferences — форма объявления', () => {
  it('называется notification_preferences', () => {
    expect(getTableConfig(notificationPreferences).name).toBe('notification_preferences')
  })

  it('колонки — ровно эти, ровно таких типов', () => {
    expect(shapeOf(notificationPreferences)).toEqual([
      { name: 'id', type: 'uuid', notNull: true, hasDefault: true },
      { name: 'user_id', type: 'uuid', notNull: true, hasDefault: false },
      // 50 — та же длина, что у `notifications.type`: это те же значения.
      { name: 'type', type: 'varchar(50)', notNull: true, hasDefault: false },
      { name: 'email_enabled', type: 'boolean', notNull: true, hasDefault: true },
      { name: 'created_at', type: 'timestamp with time zone', notNull: true, hasDefault: true },
      { name: 'updated_at', type: 'timestamp with time zone', notNull: true, hasDefault: true },
    ])
  })

  it('одна строка на пару (пользователь, тип)', () => {
    const { indexes } = getTableConfig(notificationPreferences)
    const idx = indexes.find((i) => i.config.name === 'uq_notification_preferences_user_type')
    expect(
      idx,
      `ожидался индекс 'uq_notification_preferences_user_type' — есть: ${indexes
        .map((i) => i.config.name)
        .join(', ')}`,
    ).toBeDefined()
    expect(idx?.config.unique).toBe(true)
  })

  it('умолчание — письма ИДУТ', () => {
    // Отсутствие строки означает «по умолчанию», и умолчание обязано быть
    // «включено»: иначе подсистема не работает ни для кого, пока каждый
    // сотрудник не зайдёт в настройки и не включит её вручную.
    const { columns } = getTableConfig(notificationPreferences)
    expect(columns.find((c) => c.name === 'email_enabled')?.default).toBe(true)
  })

  it('настройки уходят вместе с пользователем', () => {
    const { foreignKeys } = getTableConfig(notificationPreferences)
    expect(foreignKeys.map((f) => f.onDelete)).toEqual(['cascade'])
  })
})
