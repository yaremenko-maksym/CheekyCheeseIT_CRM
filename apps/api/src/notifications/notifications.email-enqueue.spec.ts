import { Logger } from '@nestjs/common'
import { describe, expect, it, vi } from 'vitest'
import { NOTIFICATION_TITLES } from '@crm/shared'
import { notificationEmails, notifications, users } from '../database/schema'
import { NotificationsService } from './notifications.service'

/**
 * Постановка письма в очередь — AC1 позиции 7a: строка `notification_emails`
 * пишется В ТОЙ ЖЕ транзакции, что и само уведомление.
 *
 * Почему юнит, а не только интеграция: гейт мутаций не исполняет
 * интеграционных спек (`.claude/rules/common/mutation-gate-integration-
 * specs.md`), а порча условия «ставить ли письмо» ничем другим не
 * наблюдается. Живая проверка того, что откат события уносит и письмо, —
 * в `notification-email-delivery.integration.spec.ts`: ROLLBACK выполняет
 * Postgres, и мок, «откатывающий» то, что сам записал, проверял бы себя.
 *
 * Заглушка маршрутизирует по ТАБЛИЦЕ (а не игнорирует её, как делала
 * прежняя): с этой задачи сервис пишет в две таблицы и читает из третьей, и
 * заглушка, складывающая всё в один массив, показала бы зелёным даже запись
 * письма вместо уведомления.
 *
 * **Круг 2 (SPEC-H-1 / SPEC-H-2).** Постановка больше не читает настройку
 * канала — её смотрит отправщик, в момент отправки. Зато читает состояние
 * получателя: архивированному строка заводится сразу `SKIPPED/USER_ARCHIVED`.
 * И строка теперь заводится ВСЕГДА: «строки нет» не отвечает на вопрос,
 * почему письма не было.
 */

interface Harness {
  notifications: Record<string, unknown>[]
  emails: Record<string, unknown>[]
  /** Имена колонок, по которым гасится повтор постановки. */
  conflictTargets: string[]
  /** Что сервис отдал в телеметрию ошибок. */
  recorded: Record<string, unknown>[]
  service: NotificationsService
  tx: unknown
}

function makeHarness(archivedAt: Date | null = null): Harness {
  const notificationRows: Record<string, unknown>[] = []
  const emailRows: Record<string, unknown>[] = []
  const conflictTargets: string[] = []
  const recorded: Record<string, unknown>[] = []

  const tx = {
    // Проецирует по ЗАПРОШЕННЫМ полям: сервис, забывший попросить
    // `archivedAt`, обязан получить строку без него — иначе проверка «письмо
    // архивированному не уходит» проходила бы и тогда, когда сервис читает не
    // те колонки.
    select: (fields?: Record<string, unknown>) => ({
      from: (table: unknown) => ({
        where: async (_p: unknown) => {
          if (table !== users) return []
          const names = Object.keys(fields ?? {})
          const projected: Record<string, unknown> = {}
          for (const n of names) projected[n] = { archivedAt }[n as 'archivedAt']
          return [projected]
        },
      }),
    }),
    insert: (table: unknown) => ({
      values: (v: Record<string, unknown>) => {
        const insertRow = () => {
          if (table === notificationEmails) {
            const row = { id: `e-${emailRows.length}`, status: 'QUEUED', attempts: 0, ...v }
            emailRows.push(row)
            return [row]
          }
          const row = {
            id: `n-${notificationRows.length}`,
            readAt: null,
            createdAt: new Date(),
            ...v,
          }
          notificationRows.push(row)
          return [row]
        }
        return {
          returning: async () => insertRow(),
          onConflictDoNothing: (opts?: { target?: { name: string } | { name: string }[] }) => {
            if (table === notificationEmails) {
              const t = opts?.target
              const cols = t === undefined ? [] : Array.isArray(t) ? t : [t]
              conflictTargets.push(...cols.map((c) => c.name))
            }
            return { returning: async () => insertRow() }
          },
        }
      },
    }),
  }

  const telemetry = {
    recordError: (p: Record<string, unknown>) => {
      recorded.push(p)
      return Promise.resolve()
    },
  }
  const db = { db: { transaction: async <T>(cb: (t: unknown) => Promise<T>) => cb(tx) } }
  const service = new NotificationsService(db as never, telemetry as never)
  return {
    notifications: notificationRows,
    emails: emailRows,
    conflictTargets,
    recorded,
    service,
    tx,
  }
}

const PROJECT_ID = '44444444-4444-4444-8444-444444444444'

function informingInput() {
  return {
    userId: 'u-1',
    type: 'PROJECT_MEMBER_ADDED' as const,
    title: NOTIFICATION_TITLES.PROJECT_MEMBER_ADDED,
    subjectType: 'PROJECT' as const,
    subjectId: PROJECT_ID,
    data: { projectName: 'Мобильный банк' },
  }
}

describe('createInTx ставит письмо в очередь', () => {
  it('пишет строку очереди той же транзакцией, что и уведомление', async () => {
    const h = makeHarness()
    await h.service.createInTx(h.tx as never, informingInput())

    expect(h.notifications).toHaveLength(1)
    expect(h.emails).toHaveLength(1)
    expect(h.emails[0]).toMatchObject({
      notificationId: h.notifications[0]!['id'],
      userId: 'u-1',
    })
  })

  it('строка встаёт QUEUED без единой причины пропуска', async () => {
    const h = makeHarness()
    await h.service.createInTx(h.tx as never, informingInput())

    expect(h.emails[0]).toMatchObject({ status: 'QUEUED', skipReason: null })
  })

  it('настройку канала при постановке НЕ читает вовсе', async () => {
    // SPEC-H-2 / CR-H-2 / SR-M-2: настройку смотрит отправщик. Круг 1 решал
    // это здесь, и человек, включивший канал между событием и отправкой,
    // письма уже не получал — строки не было и появиться ей было негде.
    // Заглушка отвечает только на `users`, поэтому запрос к настройкам вернул
    // бы пусто; проверяется ЧИСЛО запросов — читаем одну таблицу, не две.
    const h = makeHarness()
    const spy = vi.spyOn(h.tx as { select: (f?: unknown) => unknown }, 'select')
    await h.service.createInTx(h.tx as never, informingInput())

    expect(spy).toHaveBeenCalledTimes(1)
    expect(h.emails[0]).toMatchObject({ status: 'QUEUED' })
  })

  it('запертый тип встаёт в очередь так же, как любой другой', async () => {
    const h = makeHarness()
    await h.service.createInTx(h.tx as never, {
      userId: 'u-1',
      type: 'DOCUMENT_SIGN_REQUIRED',
      title: NOTIFICATION_TITLES.DOCUMENT_SIGN_REQUIRED,
      subjectType: 'EMPLOYEE_CONTRACT',
      subjectId: PROJECT_ID,
      data: { documentTitle: 'Ваш контракт' },
    })

    expect(h.emails).toHaveLength(1)
    expect(h.emails[0]).toMatchObject({ status: 'QUEUED' })
  })

  it('архивированному получателю строка заводится сразу SKIPPED/USER_ARCHIVED', async () => {
    // SPEC-H-4 / SR-H-1, первая половина гварда: крону такая строка не
    // достанется вовсе (`claimDue` берёт только `QUEUED`), а в очереди
    // остаётся ответ на вопрос, почему письма не было.
    const h = makeHarness(new Date('2026-08-01T00:00:00Z'))
    await h.service.createInTx(h.tx as never, informingInput())

    expect(h.notifications).toHaveLength(1)
    expect(h.emails[0]).toMatchObject({ status: 'SKIPPED', skipReason: 'USER_ARCHIVED' })
  })

  it('старому типу строка заводится SKIPPED/LEGACY_TYPE, а не пропускается молча', async () => {
    // SPEC-H-1: у трёх старых типов (инвойсы, вакансии) письма нет ни
    // шаблона, ни настройки — но след «письма не полагалось» нужен ровно так
    // же, как всем остальным причинам.
    const h = makeHarness()
    await h.service.createInTx(h.tx as never, {
      userId: 'u-1',
      type: 'INVOICE_SIGN_REQUIRED',
      title: 'Инвойс ждёт подписи',
      link: '/finance/invoices/abc',
    })

    expect(h.notifications).toHaveLength(1)
    expect(h.emails[0]).toMatchObject({ status: 'SKIPPED', skipReason: 'LEGACY_TYPE' })
  })

  it('строка очереди ставится с погашением повтора по уведомлению', async () => {
    // Цель конфликта — `uq_notification_emails_notification`. Без неё Postgres
    // упал бы на «no unique constraint matching», и это уронило бы… ничего:
    // отказ проглатывается. То есть письмо молча не появлялось бы.
    const h = makeHarness()
    await h.service.createInTx(h.tx as never, informingInput())
    expect(h.conflictTargets).toEqual(['notification_id'])
  })

  it('погашенное идемпотентностью уведомление письма не порождает', async () => {
    // `createInTx` вернул `null` — строки нет, значит и слать нечего.
    // Иначе повторная доставка события давала бы второе письмо там, где
    // уведомление осознанно погашено.
    const h = makeHarness()
    const tx = {
      ...(h.tx as Record<string, unknown>),
      insert: (_table: unknown) => ({
        values: (v: Record<string, unknown>) => ({
          returning: async () => [{ id: 'x', ...v }],
          onConflictDoNothing: (_t: unknown) => ({ returning: async () => [] }),
        }),
      }),
    }
    const emailsBefore = h.emails.length
    const result = await h.service.createInTx(tx as never, {
      ...informingInput(),
      dedupeKey: 'PROJECT_MEMBER_ADDED:x',
    })

    expect(result).toBeNull()
    expect(h.emails).toHaveLength(emailsBefore)
  })

  it('отказ очереди не отменяет уведомление', async () => {
    // Письмо — канал, уведомление — факт. Упавшая постановка в очередь не
    // имеет права уносить с собой событие: это ровно то вето, которое
    // security-review круга 1 (#664) снял у разбора данных.
    const h = makeHarness()
    const tx = {
      select: (h.tx as { select: unknown }).select,
      insert: (table: unknown) => {
        if (table === notificationEmails) {
          return {
            values: () => ({
              returning: async () => {
                throw new Error('queue is down')
              },
              onConflictDoNothing: () => ({
                returning: async () => {
                  throw new Error('queue is down')
                },
              }),
            }),
          }
        }
        return (h.tx as { insert: (t: unknown) => unknown }).insert(table)
      },
    }

    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
    const result = await h.service.createInTx(tx as never, informingInput())
    expect(result).not.toBeNull()
    expect(h.notifications).toHaveLength(1)

    // Пропуск ГРОМКИЙ: тихо потерянное письмо — второй конец той же палки.
    const said = String(error.mock.calls[0]?.[0] ?? '')
    expect(said).toContain('Failed to enqueue notification email')
    expect(said).toContain('queue is down')
    expect(said).toContain('PROJECT_MEMBER_ADDED')
    error.mockRestore()

    expect(h.recorded).toEqual([
      {
        source: 'API',
        message: 'Notification email not queued',
        route: '/api/notifications',
        userId: 'u-1',
        // Ни заголовка, ни данных: дайджест уходит в отдельный репозиторий.
        meta: { type: 'PROJECT_MEMBER_ADDED' },
      },
    ])
  })

  it('отказ, брошенный не исключением, тоже попадает в журнал', async () => {
    const h = makeHarness()
    const tx = {
      select: (h.tx as { select: unknown }).select,
      insert: (table: unknown) => {
        if (table === notificationEmails) {
          return {
            values: () => ({
              onConflictDoNothing: () => ({
                returning: async () => {
                  throw 'the queue is unreachable'
                },
              }),
            }),
          }
        }
        return (h.tx as { insert: (t: unknown) => unknown }).insert(table)
      },
    }
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)

    const result = await h.service.createInTx(tx as never, informingInput())

    expect(result).not.toBeNull()
    expect(String(error.mock.calls[0]?.[0] ?? '')).toContain('the queue is unreachable')
    error.mockRestore()
  })

  it('createManyInTx ставит письмо каждому получателю', async () => {
    const h = makeHarness()
    await h.service.createManyInTx(h.tx as never, [
      { ...informingInput(), userId: 'u-1' },
      { ...informingInput(), userId: 'u-2' },
    ])

    expect(h.notifications).toHaveLength(2)
    expect(h.emails).toHaveLength(2)
    expect(h.emails.map((e) => e['userId'])).toEqual(['u-1', 'u-2'])
  })

  it('состояние получателя читается на КАЖДОГО из них, а не один раз на пачку', async () => {
    // Иначе архив одного применился бы ко всем: пачка `createManyInTx` — это
    // разные люди, и «уволен ли он» у каждого свой.
    const h = makeHarness()
    const spy = vi.spyOn(h.tx as { select: (f?: unknown) => unknown }, 'select')
    await h.service.createManyInTx(h.tx as never, [
      { ...informingInput(), userId: 'u-1' },
      { ...informingInput(), userId: 'u-2' },
    ])
    expect(spy).toHaveBeenCalledTimes(2)
  })
})

/** Держит `notifications` в импорте — таблица маршрутизирует заглушку. */
void notifications
