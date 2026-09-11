/**
 * task-notification-types-producers (позиция 6) — производитель «ждёт решения:
 * документ на подпись».
 *
 * Событие — перевод договора DRAFT → READY_TO_SIGN, то есть ровно момент,
 * когда от сотрудника начинают ждать подписи. Получатель — он один.
 */
import { describe, expect, it, vi } from 'vitest'
import type { SessionUser } from '@crm/shared'
import { EmployeeContractsService } from './employee-contracts.service'
import type { NotificationsService } from '../notifications/notifications.service'

const ADMIN = { id: 'admin-1', role: 'ADMIN' } as SessionUser
const UPDATED_AT = new Date('2026-09-07T10:00:00.000Z')

function makeHarness(status = 'DRAFT', updateReturnsNothing = false) {
  const created: Record<string, unknown>[] = []
  const notifications = {
    createInTx: vi.fn(async (_tx: unknown, i: Record<string, unknown>) => {
      created.push(i)
      return null
    }),
  } as unknown as NotificationsService

  const updates: unknown[] = []
  const db = {
    db: {
      query: {
        employeeContracts: {
          findFirst: async () => ({ id: 'contract-1', userId: 'junior-1', status }),
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
              where: () => ({
                returning: async () => {
                  updates.push(v)
                  if (updateReturnsNothing) return []
                  return [{ id: 'contract-1', updatedAt: UPDATED_AT, status, ...v }]
                },
              }),
            }),
          }),
        }),
    },
  } as never

  const svc = new EmployeeContractsService(db, {} as never, notifications)
  return { svc, created, updates }
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
      title: 'Ждёт решения: документ на подпись',
      subjectType: 'EMPLOYEE_CONTRACT',
      subjectId: 'contract-1',
      data: { documentTitle: 'Договор с сотрудником' },
    })
  })

  it('ключ идемпотентности несёт версию строки — повторная подготовка спросит заново', async () => {
    // Часы останавливаются, потому что версию строки проставляет сам переход
    // (`updatedAt: new Date()`), и заглушка возвращает строку уже правленой.
    // Ожидаемый ключ остаётся отдельным литералом, а не вычисляется тем же
    // способом, что и код.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(UPDATED_AT)
    try {
      const h = makeHarness()
      await h.svc.markReady('junior-1', ADMIN)
      expect(h.created[0]?.['dedupeKey']).toBe(
        'DOCUMENT_SIGN_REQUIRED:contract-1:2026-09-07T10:00:00.000Z',
      )
    } finally {
      vi.useRealTimers()
    }
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

    await expect(h.svc.markReady('junior-1', ADMIN)).rejects.toThrow(
      'Failed to mark contract ready',
    )
    expect(h.created).toHaveLength(0)
  })
})
