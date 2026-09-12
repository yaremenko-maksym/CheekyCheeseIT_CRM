import { Logger } from '@nestjs/common'
import { describe, expect, it, vi } from 'vitest'
import { NOTIFICATION_TITLES } from '@crm/shared'
import { notificationEmails, notificationPreferences, notifications } from '../database/schema'
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

function makeHarness(prefRows: { type: string; emailEnabled: boolean }[] = []): Harness {
  const notificationRows: Record<string, unknown>[] = []
  const emailRows: Record<string, unknown>[] = []
  const conflictTargets: string[] = []
  const recorded: Record<string, unknown>[] = []

  const tx = {
    // Проецирует по ЗАПРОШЕННЫМ полям: сервис, забывший попросить
    // `emailEnabled`, обязан получить строку без него — иначе проверка «письмо
    // не ставится выключенному типу» проходила бы и тогда, когда сервис читает
    // не те колонки.
    select: (fields?: Record<string, unknown>) => ({
      from: (table: unknown) => ({
        where: async (_p: unknown) => {
          if (table !== notificationPreferences) return []
          const names = Object.keys(fields ?? {})
          return prefRows.map((r) => {
            const projected: Record<string, unknown> = {}
            for (const n of names) projected[n] = (r as unknown as Record<string, unknown>)[n]
            return projected
          })
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

  it('не ставит письмо, если пользователь выключил этот тип', async () => {
    const h = makeHarness([{ type: 'PROJECT_MEMBER_ADDED', emailEnabled: false }])
    await h.service.createInTx(h.tx as never, informingInput())

    expect(h.notifications).toHaveLength(1)
    expect(h.emails).toHaveLength(0)
  })

  it('ставит письмо типа, требующего действия, вопреки выключенной записи', async () => {
    const h = makeHarness([{ type: 'DOCUMENT_SIGN_REQUIRED', emailEnabled: false }])
    await h.service.createInTx(h.tx as never, {
      userId: 'u-1',
      type: 'DOCUMENT_SIGN_REQUIRED',
      title: NOTIFICATION_TITLES.DOCUMENT_SIGN_REQUIRED,
      subjectType: 'EMPLOYEE_CONTRACT',
      subjectId: PROJECT_ID,
      data: { documentTitle: 'Ваш контракт' },
    })

    expect(h.emails).toHaveLength(1)
  })

  it('старому типу очередь не заводит и настроек НЕ читает', async () => {
    // Ранний выход, а не «дошёл и передумал»: у старых типов письма нет по
    // построению, и лишний запрос к настройкам на каждое такое уведомление —
    // плата за ничто.
    const h = makeHarness()
    const spy = vi.spyOn(h.tx as { select: (f?: unknown) => unknown }, 'select')
    await h.service.createInTx(h.tx as never, {
      userId: 'u-1',
      type: 'INVOICE_SIGN_REQUIRED',
      title: 'Инвойс ждёт подписи',
      link: '/finance/invoices/abc',
    })

    expect(h.notifications).toHaveLength(1)
    expect(h.emails).toHaveLength(0)
    expect(spy).not.toHaveBeenCalled()
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
    expect(said).toContain('Письмо не поставлено в очередь')
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
                  throw 'очередь недоступна'
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
    expect(String(error.mock.calls[0]?.[0] ?? '')).toContain('очередь недоступна')
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

  it('настройки читаются по получателю, а не по всем подряд', async () => {
    const h = makeHarness()
    const spy = vi.spyOn(h.tx as { select: (f?: unknown) => unknown }, 'select')
    await h.service.createInTx(h.tx as never, informingInput())
    expect(spy).toHaveBeenCalled()
  })
})

/** Держит `notifications` в импорте — таблица маршрутизирует заглушку. */
void notifications
