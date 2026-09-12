/**
 * task-notification-types-producers (позиция 6) — производитель «ждёт решения:
 * документ на подпись».
 *
 * Событие — перевод договора DRAFT → READY_TO_SIGN, то есть ровно момент,
 * когда от сотрудника начинают ждать подписи. Получатель — он один.
 */
import { ConflictException } from '@nestjs/common'
import { PgDialect } from 'drizzle-orm/pg-core'
import { describe, expect, it, vi } from 'vitest'
import type { SessionUser } from '@crm/shared'
import { EmployeeContractsService } from './employee-contracts.service'
import type { NotificationsService } from '../notifications/notifications.service'
import { makePassThroughEmitInTx } from '../notifications/__test-helpers__/notifications-stub'

const ADMIN = { id: 'admin-1', role: 'ADMIN' } as SessionUser
/** Версия строки ДО перехода — та, из которой строится ключ идемпотентности. */
const CREATED_AT = new Date('2026-09-07T09:00:00.000Z')

/**
 * Условия отбора раскрываются в настоящий SQL и ПРИМЕНЯЮТСЯ к строке — как их
 * применила бы база (CR-M-2, круг 1).
 *
 * Без этого заглушка отдавала бы строку независимо от того, что стоит в
 * `WHERE`, и «UPDATE ... WHERE id = ? AND status = 'DRAFT'» был бы для теста
 * неотличим от «UPDATE ... WHERE id = ?» — то есть ровно та потеря, которую
 * находка и называет. Приём тот же, что в `pending-settlement.spec.ts`:
 * `PgDialect().sqlToQuery` вместо разбора внутренностей drizzle руками.
 */
const COLUMN_TO_FIELD: Record<string, string> = {
  id: 'id',
  user_id: 'userId',
  status: 'status',
}

function whereMatches(condition: unknown, row: Record<string, unknown>): boolean {
  const compiled = new PgDialect().sqlToQuery(condition as Parameters<PgDialect['sqlToQuery']>[0])
  for (const part of compiled.sql.split(/\s+and\s+/i)) {
    const match = /"[^"]+"\."([^"]+)"\s*=\s*\$(\d+)/.exec(part)
    if (match === null) throw new Error(`заглушка не понимает условие: ${part}`)
    const field = COLUMN_TO_FIELD[match[1] as string]
    if (field === undefined) throw new Error(`заглушка не знает колонку: ${match[1]}`)
    if (row[field] !== compiled.params[Number(match[2]) - 1]) return false
  }
  return true
}

function makeHarness(status = 'DRAFT', updateReturnsNothing = false) {
  const created: Record<string, unknown>[] = []
  const notifications = {
    createInTx: vi.fn(async (_tx: unknown, i: Record<string, unknown>) => {
      created.push(i)
      return null
    }),
    emitInTx: makePassThroughEmitInTx(),
  } as unknown as NotificationsService

  // Живая строка: её читает `findFirst`, её же меняет `UPDATE`. Одна строка на
  // две операции — иначе гонку не изобразить.
  const row: Record<string, unknown> = {
    id: 'contract-1',
    userId: 'junior-1',
    status,
    updatedAt: CREATED_AT,
  }
  /** Снимок, который читают ОБА участника гонки: оба видят ещё-черновик. */
  let frozenRead: Record<string, unknown> | null = null

  const updates: unknown[] = []
  const db = {
    db: {
      query: {
        employeeContracts: {
          findFirst: async () => ({ ...(frozenRead ?? row) }),
        },
      },
      transaction: async <T>(cb: (tx: unknown) => Promise<T>): Promise<T> =>
        cb({
          update: () => ({
            // Заглушка ПРИМЕНЯЕТ правку и возвращает строку такой, какой она
            // стала, — как `UPDATE ... RETURNING`. Иначе «перевести договор в
            // ожидание подписи» и «ничего не записать» выглядели бы для теста
            // одинаково: возвращённый статус был бы правильным в обоих случаях.
            set: (v: Record<string, unknown>) => ({
              where: (condition: unknown) => ({
                returning: async () => {
                  updates.push(v)
                  if (updateReturnsNothing) return []
                  if (!whereMatches(condition, row)) return []
                  Object.assign(row, v)
                  return [{ ...row }]
                },
              }),
            }),
          }),
        }),
    },
  } as never

  const svc = new EmployeeContractsService(db, {} as never, notifications)
  return {
    svc,
    created,
    updates,
    row,
    /** Заморозить чтение: с этого момента все читатели видят текущую строку. */
    freezeReads: () => {
      frozenRead = { ...row }
    },
  }
}

describe('«ждёт решения: документ на подпись»', () => {
  it('уходит сотруднику, чей договор готов к подписи, — и никому больше', async () => {
    const h = makeHarness()
    await h.svc.markReady('junior-1', ADMIN)

    expect(h.updates).toHaveLength(1)
    expect(h.created).toHaveLength(1)
    expect(h.created[0]).toMatchObject({
      userId: 'junior-1',
      type: 'DOCUMENT_SIGN_REQUIRED',
      // COPY-H-1/COPY-M-5 (copy-review круг 1, #664): предмет первым, без
      // семейного префикса; документ назван одним словом на всём пути.
      title: 'Контракт на подпись',
      subjectType: 'EMPLOYEE_CONTRACT',
      subjectId: 'contract-1',
      data: { documentTitle: 'Ваш контракт с компанией' },
    })
  })

  /**
   * CR-M-2 (код-ревью круг 1). Ключ строился на `row.updatedAt` — значении,
   * которое пишет ТА ЖЕ операция, которую он должен дедуплицировать: два
   * одновременных перехода получали два РАЗНЫХ ключа, и частичный индекс
   * дубль не ловил.
   *
   * Теперь ключ считается из строки, прочитанной ДО перехода: у обоих
   * участников гонки она одна и та же, значит и ключ один. Версия в ключе при
   * этом сохранена намеренно — возврат договора в черновик и повторная
   * подготовка это НОВАЯ просьба подписать, и она обязана доехать (без версии
   * её погасил бы тот самый индекс).
   *
   * Часы не останавливаются: ожидаемый ключ несёт версию ДО перехода, а её
   * ставит фикстура, а не `Date.now()`.
   */
  it('ключ идемпотентности несёт версию строки ДО перехода — один на оба участника гонки', async () => {
    const h = makeHarness()
    await h.svc.markReady('junior-1', ADMIN)
    expect(h.created[0]?.['dedupeKey']).toBe(
      'DOCUMENT_SIGN_REQUIRED:contract-1:DRAFT@2026-09-07T09:00:00.000Z',
    )
  })

  it('две одновременные подготовки: переход и просьба подписать ровно по разу', async () => {
    const h = makeHarness()
    // Оба запроса успели прочитать договор ещё черновиком — ровно то окно, в
    // котором `getActiveOrThrow` (обычный `findFirst`, без `FOR UPDATE`)
    // пропускает обоих.
    h.freezeReads()

    const results = await Promise.allSettled([
      h.svc.markReady('junior-1', ADMIN),
      h.svc.markReady('junior-1', ADMIN),
    ])

    // Оба дошли до UPDATE — guard по прочитанному статусу их не разделил.
    expect(h.updates).toHaveLength(2)
    // Разделило условие в самом UPDATE: строка перешла один раз...
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.filter((r) => r.status === 'rejected')
    expect(rejected).toHaveLength(1)
    // SR-L-5 (security-review круг 2): проигравшему гонку — 409 с человеческим
    // текстом, а не голая `Error` (500). Одновременность здесь легитимна, и
    // отвечать на неё отказом сервера значит показывать нормальную работу
    // двух админов как поломку — в ответе клиенту и в телеметрии ошибок.
    const reason = (rejected[0] as PromiseRejectedResult).reason as ConflictException
    expect(reason).toBeInstanceOf(ConflictException)
    expect(reason.getStatus()).toBe(409)
    expect(reason.message).toContain('no longer DRAFT')
    // ...и сотрудник получил ОДНУ просьбу подписать, а не две.
    expect(h.created).toHaveLength(1)
  })

  it('договор не в черновике — ни перехода, ни уведомления', async () => {
    const h = makeHarness('READY_TO_SIGN')
    await expect(h.svc.markReady('junior-1', ADMIN)).rejects.toThrow()
    expect(h.updates).toHaveLength(0)
    expect(h.created).toHaveLength(0)
  })

  it('переход записывает ИМЕННО ожидание подписи, а не «что-нибудь»', async () => {
    const h = makeHarness()
    const updated = (await h.svc.markReady('junior-1', ADMIN)) as { status: string }

    expect(h.updates[0]).toMatchObject({ status: 'READY_TO_SIGN' })
    // Возвращённая строка — то, что увидит следующий читатель: просьба
    // подписать без самого перехода была бы просьбой ни о чём.
    expect(updated.status).toBe('READY_TO_SIGN')
  })

  it('правка не вернула строку — честная ошибка, а не просьба подписать пустоту', async () => {
    // Подстраховка: строку только что нашли и заблокировали условием статуса,
    // так что исчезнуть она может лишь на гонке. Проверяется, что в этом
    // случае не рассылается просьба подписать несуществующий договор.
    const h = makeHarness('DRAFT', true)

    await expect(h.svc.markReady('junior-1', ADMIN)).rejects.toThrow(ConflictException)
    expect(h.created).toHaveLength(0)
  })
})
