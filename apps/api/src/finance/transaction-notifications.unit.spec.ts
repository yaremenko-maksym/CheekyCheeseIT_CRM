/**
 * task-notification-types-producers (позиция 6) — производитель уведомлений в
 * `finance/transactions`.
 *
 * Два типа: «транзакция добавлена» и «статус транзакции изменился». Проверяется
 * то, что задание требует дословно: «событие → запись нужного типа нужным
 * получателям И НИКОМУ БОЛЬШЕ», плюс правило раскрытия (§10): отправитель
 * парной строки раздела не должен узнать сумму другой стороны.
 */
import { describe, expect, it, vi } from 'vitest'
import type { SessionUser } from '@crm/shared'
import { makeTransactionsService } from './__test-helpers__/make-transactions-service'
import type { NotificationsService } from '../notifications/notifications.service'
import type { TransactionsService } from './transactions.service'

const ADMIN: SessionUser = {
  id: 'admin-1',
  email: 'admin@example.com',
  role: 'ADMIN',
  name: 'Админ',
} as SessionUser

type TxRow = {
  id: string
  type: string
  status: string
  amount: string
  currency: string
  receiverId: string | null
  senderId: string | null
  projectId: string | null
  deletedAt: Date | null
}

function makeTxRow(over: Partial<TxRow> = {}): TxRow {
  return {
    id: 'tx-1',
    type: 'SENIOR_INCOME',
    status: 'PENDING',
    amount: '1200.00',
    currency: 'USD',
    receiverId: 'senior-1',
    senderId: 'drop-1',
    projectId: 'proj-1',
    deletedAt: null,
    ...over,
  }
}

function makeHarness(tx: TxRow, projectName: string | null = 'Acme') {
  const created: Record<string, unknown>[] = []
  const notifications = {
    create: vi.fn(async (input: Record<string, unknown>) => {
      created.push(input)
      return null
    }),
  } as unknown as NotificationsService

  const auditInserts: unknown[] = []
  const dbtx = {
    update: () => ({
      set: () => ({
        where: () => ({ returning: async () => [{ id: tx.id }] }),
      }),
    }),
    insert: () => ({
      values: async (v: unknown) => {
        auditInserts.push(v)
      },
    }),
  }

  const db = {
    db: {
      query: {
        transactions: { findFirst: async () => tx },
        projects: {
          findFirst: async () => (projectName === null ? undefined : { name: projectName }),
        },
      },
      insert: () => ({ values: async () => undefined }),
      transaction: async <T>(cb: (t: unknown) => Promise<T>): Promise<T> => cb(dbtx),
    },
  } as never

  const svc = makeTransactionsService({ db, notificationsService: notifications })
  return { svc, created, notifications, auditInserts }
}

/** `afterTransactionCreated` — приватный шов, который зовут все пути создания. */
function created(svc: TransactionsService) {
  return svc as unknown as {
    afterTransactionCreated: (
      txId: string,
      created: { type: string; amount: string; currency: string },
      user: SessionUser,
    ) => Promise<void>
  }
}

describe('«транзакция добавлена»', () => {
  it('уходит получателю денег — одной записью нужного типа', async () => {
    const tx = makeTxRow()
    const h = makeHarness(tx)
    await created(h.svc).afterTransactionCreated(tx.id, tx, ADMIN)

    expect(h.created).toHaveLength(1)
    expect(h.created[0]).toMatchObject({
      userId: 'senior-1',
      type: 'TRANSACTION_ADDED',
      title: 'Добавлена транзакция',
      subjectType: 'TRANSACTION',
      subjectId: 'tx-1',
      dedupeKey: 'TRANSACTION_ADDED:tx-1',
    })
  })

  it('и НИКОМУ больше — отправитель парной строки не узнаёт чужую сумму (§10)', async () => {
    const tx = makeTxRow({ type: 'PAYOUT_DROP', receiverId: 'drop-1', senderId: 'senior-1' })
    const h = makeHarness(tx)
    await created(h.svc).afterTransactionCreated(tx.id, tx, ADMIN)

    expect(h.created.map((c) => c['userId'])).toEqual(['drop-1'])
  })

  it('данные несут сумму и снятое название проекта, а заголовок — нет', async () => {
    const tx = makeTxRow()
    const h = makeHarness(tx)
    await created(h.svc).afterTransactionCreated(tx.id, tx, ADMIN)

    expect(h.created[0]?.['data']).toEqual({
      amount: '1200.00',
      currency: 'USD',
      projectName: 'Acme',
    })
    expect(h.created[0]?.['title']).not.toContain('1200')
  })

  it('транзакция без проекта — название null, а не выдуманное', async () => {
    const tx = makeTxRow({ projectId: null })
    const h = makeHarness(tx)
    await created(h.svc).afterTransactionCreated(tx.id, tx, ADMIN)
    expect(h.created[0]?.['data']).toMatchObject({ projectName: null })
  })

  it('проект исчез между событием и чтением — название null', async () => {
    const tx = makeTxRow()
    const h = makeHarness(tx, null)
    await created(h.svc).afterTransactionCreated(tx.id, tx, ADMIN)
    expect(h.created[0]?.['data']).toMatchObject({ projectName: null })
  })

  it('автор действия сам себе уведомления не шлёт — своё подтверждает тост (§8.1)', async () => {
    const tx = makeTxRow({ receiverId: ADMIN.id })
    const h = makeHarness(tx)
    await created(h.svc).afterTransactionCreated(tx.id, tx, ADMIN)
    expect(h.created).toHaveLength(0)
  })

  it('под входом за другого сотрудника автором считается реальный оператор', async () => {
    const tx = makeTxRow({ receiverId: 'real-admin' })
    const h = makeHarness(tx)
    await created(h.svc).afterTransactionCreated(tx.id, tx, {
      ...ADMIN,
      id: 'senior-1',
      impersonatorId: 'real-admin',
    } as SessionUser)
    expect(h.created).toHaveLength(0)
  })

  it('строка без получателя не порождает уведомления', async () => {
    const tx = makeTxRow({ receiverId: null })
    const h = makeHarness(tx)
    await created(h.svc).afterTransactionCreated(tx.id, tx, ADMIN)
    expect(h.created).toHaveLength(0)
  })

  it('строки уже нет — молча ничего', async () => {
    const tx = makeTxRow()
    const h = makeHarness(tx)
    const db = (h.svc as unknown as { db: { db: { query: { transactions: unknown } } } }).db
    db.db.query.transactions = { findFirst: async () => undefined }
    await created(h.svc).afterTransactionCreated(tx.id, tx, ADMIN)
    expect(h.created).toHaveLength(0)
  })

  it('сбой доставки не превращает записанные деньги в ошибку', async () => {
    const tx = makeTxRow()
    const h = makeHarness(tx)
    ;(h.notifications.create as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('нет связи'),
    )
    await expect(created(h.svc).afterTransactionCreated(tx.id, tx, ADMIN)).resolves.toBeUndefined()
  })
})

describe('«статус транзакции изменился»', () => {
  it('проверка дохода → получателю, с суммой и статусом VALIDATED', async () => {
    const tx = makeTxRow()
    const h = makeHarness(tx)
    vi.spyOn(h.svc, 'findOne').mockResolvedValue({} as never)

    await h.svc.validateTransaction('tx-1', 'validate', null, ADMIN)

    expect(h.created).toHaveLength(1)
    expect(h.created[0]).toMatchObject({
      userId: 'senior-1',
      type: 'TRANSACTION_STATUS_CHANGED',
      title: 'Статус транзакции изменился',
      subjectType: 'TRANSACTION',
      subjectId: 'tx-1',
      dedupeKey: 'TRANSACTION_STATUS_CHANGED:tx-1:VALIDATED',
    })
    expect(h.created[0]?.['data']).toMatchObject({ status: 'VALIDATED', rejectionReason: null })
  })

  it('отклонение → получателю, с причиной в данных', async () => {
    const tx = makeTxRow()
    const h = makeHarness(tx)
    vi.spyOn(h.svc, 'findOne').mockResolvedValue({} as never)

    await h.svc.validateTransaction('tx-1', 'reject', 'Нет чека', ADMIN)

    expect(h.created).toHaveLength(1)
    expect(h.created[0]).toMatchObject({
      userId: 'senior-1',
      dedupeKey: 'TRANSACTION_STATUS_CHANGED:tx-1:REJECTED',
    })
    expect(h.created[0]?.['data']).toMatchObject({
      status: 'REJECTED',
      rejectionReason: 'Нет чека',
    })
  })

  it('отказ в доступе не порождает уведомления — события не было', async () => {
    const tx = makeTxRow()
    const h = makeHarness(tx)
    const junior = { ...ADMIN, id: 'junior-1', role: 'JUNIOR' } as SessionUser
    await expect(h.svc.validateTransaction('tx-1', 'validate', null, junior)).rejects.toThrow()
    expect(h.created).toHaveLength(0)
  })

  it('строка уже не PENDING — ни перехода, ни уведомления', async () => {
    const tx = makeTxRow({ status: 'VALIDATED' })
    const h = makeHarness(tx)
    await expect(h.svc.validateTransaction('tx-1', 'validate', null, ADMIN)).rejects.toThrow()
    expect(h.created).toHaveLength(0)
  })

  it('отклонение без причины отклоняется до всякой записи', async () => {
    const tx = makeTxRow()
    const h = makeHarness(tx)
    await expect(h.svc.validateTransaction('tx-1', 'reject', null, ADMIN)).rejects.toThrow()
    expect(h.created).toHaveLength(0)
  })
})
