import { PgDialect } from 'drizzle-orm/pg-core'
import type { SQL } from 'drizzle-orm'
import { describe, expect, it, vi } from 'vitest'
import { OutboxRepository } from './notification-email.repository'
import type { DatabaseService } from '../database/database.service'
import { approvals, projects } from '../database/schema'
import type { NotificationEmailSource } from './notification-email-copy'

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

  it('markSkipped ставит терминальный статус и причину в SET', () => {
    // Тот же пробел, что и у markSent выше, но на markSkipped: `.where()`
    // проверяет только предикат отбора, а `status: 'SKIPPED'` в `.set()`
    // никто не видел — гейт мутаций поймал ровно это (StringLiteral →
    // `''`, ObjectLiteral → `{}` на этой строке пережили прогон).
    const { db, sets } = makeCapturingDb()
    const repo = new OutboxRepository(db)

    void repo.markSkipped('e-5', 'CHANNEL_OFF')

    expect(sets[0]).toMatchObject({ status: 'SKIPPED', skipReason: 'CHANNEL_OFF' })
  })

  it('markFailed ставит терминальный статус и причину в SET', () => {
    const { db, sets } = makeCapturingDb()
    const repo = new OutboxRepository(db)

    void repo.markFailed('e-6', 'Resend API HTTP 500')

    expect(sets[0]).toMatchObject({ status: 'FAILED', lastError: 'Resend API HTTP 500' })
  })
})

/**
 * `resolveSubjectState` — бэклог 208. Собирает `SubjectRef` из четырёх полей
 * письма (`type`, `subjectType`, `subjectId`, `data.approvalId`) и отдаёт их
 * `NotificationSubjectStateService.resolveOne` — ТОМУ ЖЕ сервису, что и попап
 * (`NotificationsService`), не второй копии запроса. Полное покрытие всех
 * веток `loadSubjectStates` — в `notification-subject-state.service.spec.ts`;
 * здесь — только то, что специфично для ЭТОГО метода: правильная сборка
 * `SubjectRef` из `NotificationEmailSource`.
 */
function makeSelectDb(seed: {
  projects?: { id: string; archivedAt: Date | null }[]
  approvals?: { id: string; status: string; approverUserId: string; supersededAt: Date | null }[]
}): DatabaseService {
  const db = {
    db: {
      select: (_fields?: unknown) => ({
        from: (t: unknown) => {
          if (t === projects) {
            return { where: async () => seed.projects ?? [] }
          }
          if (t === approvals) {
            return {
              where: async () =>
                (seed.approvals ?? []).map((r) => ({ id: r.id, status: r.status })),
            }
          }
          throw new Error('makeSelectDb: unexpected table')
        },
      }),
    },
  }
  return db as unknown as DatabaseService
}

function emailSource(over: Partial<NotificationEmailSource> = {}): NotificationEmailSource {
  return {
    type: 'PROJECT_CONFIRM_REQUIRED',
    title: 'Проект ждёт решения',
    body: null,
    link: null,
    subjectType: 'PROJECT',
    subjectId: 'p-1',
    data: { approvalId: '3fa85f64-5717-4562-b3fc-2c963f66afa6' },
    ...over,
  }
}

describe('OutboxRepository.resolveSubjectState — бэклог 208', () => {
  it('проект жив, согласование живое и принадлежит получателю — active', async () => {
    const db = makeSelectDb({
      projects: [{ id: 'p-1', archivedAt: null }],
      approvals: [
        {
          id: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
          status: 'PENDING',
          approverUserId: 'u-1',
          supersededAt: null,
        },
      ],
    })
    const repo = new OutboxRepository(db)

    const state = await repo.resolveSubjectState('u-1', emailSource())

    expect(state).toBe('active')
  })

  it('объект отсутствует — missing', async () => {
    const db = makeSelectDb({ projects: [] })
    const repo = new OutboxRepository(db)

    const state = await repo.resolveSubjectState('u-1', emailSource())

    expect(state).toBe('missing')
  })

  it('data без approvalId — SubjectRef несёт approvalId=null, объект всё равно проверяется', async () => {
    const db = makeSelectDb({ projects: [{ id: 'p-1', archivedAt: null }] })
    const repo = new OutboxRepository(db)

    // Уведомление, требующее согласования, но без опознанной строки
    // (`approvalIdFromData` вернула `null` из-за отсутствия поля) — проверить
    // согласование нечем, и `computeSubjectState` оставляет объект активным,
    // раз сам проект жив (см. doc-комментарий `computeSubjectState`, QA-H-1).
    const state = await repo.resolveSubjectState('u-1', emailSource({ data: {} }))

    expect(state).toBe('active')
  })
})
