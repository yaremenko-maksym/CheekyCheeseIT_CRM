import { PgDialect } from 'drizzle-orm/pg-core'
import type { SQL } from 'drizzle-orm'
import { describe, expect, it, vi } from 'vitest'
import { OutboxRepository } from './notification-email.repository'
import type { DatabaseService } from '../database/database.service'

/**
 * Предикат статуса на терминальных марках — позиция 7a (SR-L-6,
 * security-review PR #673 круг 2).
 *
 * `markSent` / `markSkipped` / `markFailed` без `WHERE status = 'QUEUED'`
 * переписывали БЫ уже терминальную строку, если два прохода крона держат
 * одну и ту же строку (аренда 60 с, пятиминутный байпас зависшего прохода —
 * SR-L-4). Живой Postgres это тоже проверяет
 * (`notification-email-delivery.integration.spec.ts`,
 * «поздний markSkipped после markSent не переписывает отправленную
 * строку»), но гейт мутаций живую базу не исполняет
 * (`mutation-gate-integration-specs.md`) — этот файл даёт ему то же
 * утверждение через мок, компилируя реальный `where` `PgDialect`ом, а не
 * гадая по объекту-моку drizzle.
 *
 * Мокается только ИСПОЛНИТЕЛЬ запроса (`this.db.db.update(...)`), а не
 * построитель: `set(...)` / `where(...)` — настоящие вызовы поверх настоящей
 * таблицы `notificationEmails`, поэтому `where`-аргумент, который сюда
 * долетает, — реальный SQL-фрагмент drizzle, а не то, что тест сам придумал.
 */

function makeCapturingDb(): { db: DatabaseService; wheres: unknown[]; sets: unknown[] } {
  const wheres: unknown[] = []
  const sets: unknown[] = []
  const chain = {
    set: vi.fn((setArg: unknown) => {
      sets.push(setArg)
      return {
        where: vi.fn((whereArg: unknown) => {
          wheres.push(whereArg)
          return Promise.resolve()
        }),
      }
    }),
  }
  const db = { update: vi.fn(() => chain) }
  return { db: { db } as unknown as DatabaseService, wheres, sets }
}

/** Скомпилировать захваченный `where` в то, что реально уйдёт в Postgres. */
function compile(where: unknown): { sql: string; params: unknown[] } {
  return new PgDialect().sqlToQuery(where as SQL)
}

describe('OutboxRepository — предикат status=QUEUED на марках', () => {
  it('markSent требует строку в статусе QUEUED', async () => {
    const { db, wheres } = makeCapturingDb()
    const repo = new OutboxRepository(db)

    await repo.markSent('e-1', 'a@example.com')

    const compiled = compile(wheres[0])
    expect(compiled.sql).toContain('"status" =')
    expect(compiled.params).toEqual(expect.arrayContaining(['e-1', 'QUEUED']))
  })

  it('markSkipped требует строку в статусе QUEUED', async () => {
    const { db, wheres } = makeCapturingDb()
    const repo = new OutboxRepository(db)

    await repo.markSkipped('e-2', 'CHANNEL_OFF')

    const compiled = compile(wheres[0])
    expect(compiled.sql).toContain('"status" =')
    expect(compiled.params).toEqual(expect.arrayContaining(['e-2', 'QUEUED']))
  })

  it('markFailed требует строку в статусе QUEUED', async () => {
    const { db, wheres } = makeCapturingDb()
    const repo = new OutboxRepository(db)

    await repo.markFailed('e-3', 'Resend API HTTP 500')

    const compiled = compile(wheres[0])
    expect(compiled.sql).toContain('"status" =')
    expect(compiled.params).toEqual(expect.arrayContaining(['e-3', 'QUEUED']))
  })

  it('markSent ставит терминальный статус в SET, а не в предикат отбора', () => {
    // Отличает «пишем SENT» от «пишем QUEUED снова»: без этого мутант,
    // заменивший `status: 'SENT'` на `status: 'QUEUED'` в `.set()`, был бы
    // неотличим — `.where()` его не видит по построению.
    const { db, sets } = makeCapturingDb()
    const repo = new OutboxRepository(db)

    void repo.markSent('e-4', 'a@example.com')

    expect(sets[0]).toMatchObject({ status: 'SENT', sentToEmail: 'a@example.com' })
  })
})
