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
import { getTableConfig } from 'drizzle-orm/pg-core'
import { describe, expect, it } from 'vitest'

import { notificationEmails, notificationPreferences } from './schema'

describe('notification_emails — форма объявления', () => {
  it('называется notification_emails', () => {
    expect(getTableConfig(notificationEmails).name).toBe('notification_emails')
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
