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

function makeHarness(status = 'DRAFT') {
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
            set: (v: unknown) => ({
              where: () => ({
                returning: async () => {
                  updates.push(v)
                  return [{ id: 'contract-1', status: 'READY_TO_SIGN', updatedAt: UPDATED_AT }]
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
    const h = makeHarness()
    await h.svc.markReady('junior-1', ADMIN)
    expect(h.created[0]?.['dedupeKey']).toBe(
      `DOCUMENT_SIGN_REQUIRED:contract-1:${UPDATED_AT.toISOString()}`,
    )
  })

  it('договор не в черновике — ни перехода, ни уведомления', async () => {
    const h = makeHarness('READY_TO_SIGN')
    await expect(h.svc.markReady('junior-1', ADMIN)).rejects.toThrow()
    expect(h.updates).toHaveLength(0)
    expect(h.created).toHaveLength(0)
  })
})
