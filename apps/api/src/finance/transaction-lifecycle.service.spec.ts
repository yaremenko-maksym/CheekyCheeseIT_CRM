/**
 * WC-L5a — TransactionLifecycleService, tested directly with a mocked
 * NotificationsService and a stub db. (Through-TransactionsService coverage of
 * the same paths lives in `transaction-notifications.unit.spec.ts`.)
 */
import { describe, expect, it, vi } from 'vitest'
import { NOTIFICATION_TITLES, type SessionUser } from '@crm/shared'
import { TransactionLifecycleService } from './transaction-lifecycle.service'

const ACTOR = { id: 'actor-1', email: 'a@example.com', role: 'ADMIN', name: 'A' } as SessionUser

interface Row {
  id: string
  amount: string
  currency: string
  receiverId: string | null
  projectId: string | null
}

function makeRow(over: Partial<Row> = {}): Row {
  return {
    id: 'tx-1',
    amount: '10.00',
    currency: 'USD',
    receiverId: 'recv-1',
    projectId: 'proj-1',
    ...over,
  }
}

function setup(row: Row | undefined, project: { companyName: string } | undefined = undefined) {
  const invoices = {
    autoCreateForSeniorPayout: vi.fn().mockResolvedValue(undefined),
    autoCreateForSalary: vi.fn().mockResolvedValue(undefined),
    autoCreateForPayout: vi.fn().mockResolvedValue(undefined),
  }
  const auditValues: unknown[] = []
  const insert = vi.fn(() => ({
    values: vi.fn(async (v: unknown) => {
      auditValues.push(v)
    }),
  }))
  const create = vi.fn().mockResolvedValue(null)
  const txFind = vi.fn().mockResolvedValue(row)
  const projFind = vi.fn().mockResolvedValue(project)
  const db = {
    db: {
      query: { transactions: { findFirst: txFind }, projects: { findFirst: projFind } },
      insert,
    },
  } as never
  const svc = new TransactionLifecycleService({ create } as never, db, invoices as never)
  const logger = (svc as unknown as { logger: { error: (m: string, s?: string) => void } }).logger
  const errors: string[] = []
  vi.spyOn(logger, 'error').mockImplementation((m: string) => {
    errors.push(m)
  })
  return { svc, create, txFind, projFind, errors, invoices, auditValues, insert }
}

describe('TransactionLifecycleService.notifyTransactionAdded', () => {
  it('notifies the receiver once with amount/currency/projectName and a dedupe key', async () => {
    const h = setup(makeRow(), { companyName: 'Acme' })
    await h.svc.notifyTransactionAdded('tx-1', ACTOR)
    expect(h.create).toHaveBeenCalledTimes(1)
    expect(h.create).toHaveBeenCalledWith({
      userId: 'recv-1',
      type: 'TRANSACTION_ADDED',
      title: NOTIFICATION_TITLES.TRANSACTION_ADDED,
      subjectType: 'TRANSACTION',
      subjectId: 'tx-1',
      data: { amount: '10.00', currency: 'USD', projectName: 'Acme' },
      dedupeKey: 'TRANSACTION_ADDED:tx-1',
    })
    expect(h.errors).toHaveLength(0)
  })

  it('does nothing when the row is gone or has no receiver', async () => {
    const gone = setup(undefined)
    await gone.svc.notifyTransactionAdded('tx-1', ACTOR)
    expect(gone.create).not.toHaveBeenCalled()
    const noRecv = setup(makeRow({ receiverId: null }))
    await noRecv.svc.notifyTransactionAdded('tx-1', ACTOR)
    expect(noRecv.create).not.toHaveBeenCalled()
    expect(gone.errors.length + noRecv.errors.length).toBe(0)
  })

  it('does not notify the actor about their own action (impersonator wins)', async () => {
    const self = setup(makeRow({ receiverId: 'actor-1' }))
    await self.svc.notifyTransactionAdded('tx-1', ACTOR)
    expect(self.create).not.toHaveBeenCalled()

    const imp = setup(makeRow({ receiverId: 'real-admin' }))
    await imp.svc.notifyTransactionAdded('tx-1', {
      ...ACTOR,
      impersonatorId: 'real-admin',
    } as SessionUser)
    expect(imp.create).not.toHaveBeenCalled()
  })

  it('notifies on a system event (null actor)', async () => {
    const h = setup(makeRow())
    await h.svc.notifyTransactionAdded('tx-1', null)
    expect(h.create).toHaveBeenCalledTimes(1)
  })

  it('swallows a delivery failure and logs it (best-effort)', async () => {
    const h = setup(makeRow())
    h.create.mockRejectedValueOnce(new Error('boom'))
    await expect(h.svc.notifyTransactionAdded('tx-1', ACTOR)).resolves.toBeUndefined()
    expect(h.errors).toHaveLength(1)
    expect(h.errors[0]).toBe('notifyTransactionAdded: failed for transaction=tx-1: boom')
  })
})

describe('TransactionLifecycleService.notifyTransactionStatusChanged', () => {
  it('notifies the receiver with status and a null preview when no reason', async () => {
    const h = setup(makeRow())
    await h.svc.notifyTransactionStatusChanged('tx-1', 'VALIDATED', null, ACTOR)
    expect(h.create).toHaveBeenCalledWith({
      userId: 'recv-1',
      type: 'TRANSACTION_STATUS_CHANGED',
      title: NOTIFICATION_TITLES.TRANSACTION_STATUS_CHANGED,
      subjectType: 'TRANSACTION',
      subjectId: 'tx-1',
      data: { amount: '10.00', currency: 'USD', status: 'VALIDATED', rejectionReasonPreview: null },
      dedupeKey: 'TRANSACTION_STATUS_CHANGED:tx-1:VALIDATED',
    })
  })

  it('carries a rejection-reason preview, and whitespace-only reason becomes null', async () => {
    const h = setup(makeRow())
    await h.svc.notifyTransactionStatusChanged('tx-1', 'REJECTED', 'bad receipt', ACTOR)
    expect(h.create.mock.calls[0]?.[0]).toMatchObject({
      data: { status: 'REJECTED', rejectionReasonPreview: 'bad receipt' },
      dedupeKey: 'TRANSACTION_STATUS_CHANGED:tx-1:REJECTED',
    })
    const blank = setup(makeRow())
    await blank.svc.notifyTransactionStatusChanged('tx-1', 'REJECTED', '   ', ACTOR)
    expect(blank.create.mock.calls[0]?.[0]).toMatchObject({
      data: { rejectionReasonPreview: null },
    })
  })

  it('stays silent for a missing row, no receiver, or the actor themself', async () => {
    const gone = setup(undefined)
    await gone.svc.notifyTransactionStatusChanged('tx-1', 'VALIDATED', null, ACTOR)
    const noRecv = setup(makeRow({ receiverId: null }))
    await noRecv.svc.notifyTransactionStatusChanged('tx-1', 'VALIDATED', null, ACTOR)
    const self = setup(makeRow({ receiverId: 'actor-1' }))
    await self.svc.notifyTransactionStatusChanged('tx-1', 'VALIDATED', null, ACTOR)
    const imp = setup(makeRow({ receiverId: 'real-admin' }))
    await imp.svc.notifyTransactionStatusChanged('tx-1', 'VALIDATED', null, {
      ...ACTOR,
      impersonatorId: 'real-admin',
    } as SessionUser)
    for (const h of [gone, noRecv, self, imp]) {
      expect(h.create).not.toHaveBeenCalled()
      expect(h.errors).toHaveLength(0)
    }
  })

  it('swallows a delivery failure and logs it (best-effort)', async () => {
    const h = setup(makeRow())
    h.create.mockRejectedValueOnce(new Error('boom'))
    await expect(
      h.svc.notifyTransactionStatusChanged('tx-1', 'VALIDATED', null, ACTOR),
    ).resolves.toBeUndefined()
    expect(h.errors).toEqual(['notifyTransactionStatusChanged: failed for transaction=tx-1: boom'])
  })
})

describe('TransactionLifecycleService.loadProjectName', () => {
  it('returns null without a query for a null project id', async () => {
    const h = setup(undefined)
    await expect(h.svc.loadProjectName(null)).resolves.toBeNull()
    expect(h.projFind).not.toHaveBeenCalled()
  })

  it('returns companyName, selecting only that column', async () => {
    const h = setup(undefined, { companyName: 'Acme' })
    await expect(h.svc.loadProjectName('proj-1')).resolves.toBe('Acme')
    expect(h.projFind).toHaveBeenCalledWith(
      expect.objectContaining({ columns: { companyName: true } }),
    )
  })

  it('returns null when the project is gone', async () => {
    const h = setup(undefined, undefined)
    await expect(h.svc.loadProjectName('proj-1')).resolves.toBeNull()
  })
})

describe('TransactionLifecycleService.safeAutoCreateInvoice', () => {
  it.each([
    ['SENIOR_INCOME', 'autoCreateForSeniorPayout'],
    ['SALARY', 'autoCreateForSalary'],
    ['PAYOUT', 'autoCreateForPayout'],
  ] as const)('%s creates exactly one invoice via %s and no other', async (kind, method) => {
    const h = setup(makeRow())
    await h.svc.safeAutoCreateInvoice(kind, 'tx-9')
    const calls = {
      autoCreateForSeniorPayout: h.invoices.autoCreateForSeniorPayout.mock.calls,
      autoCreateForSalary: h.invoices.autoCreateForSalary.mock.calls,
      autoCreateForPayout: h.invoices.autoCreateForPayout.mock.calls,
    }
    expect(calls).toEqual({
      autoCreateForSeniorPayout: [],
      autoCreateForSalary: [],
      autoCreateForPayout: [],
      [method]: [['tx-9']],
    })
  })

  it('swallows an invoice failure and logs a warning (committed money write stays committed)', async () => {
    const h = setup(makeRow())
    h.invoices.autoCreateForSalary.mockRejectedValue(new Error('S3 down'))
    const warn = vi
      .spyOn((h.svc as unknown as { logger: { warn: (m: string) => void } }).logger, 'warn')
      .mockImplementation(() => undefined)
    await expect(h.svc.safeAutoCreateInvoice('SALARY', 'tx-9')).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledWith('auto-create invoice failed for SALARY tx=tx-9: S3 down')
  })
})

describe('TransactionLifecycleService.afterTransactionCreated', () => {
  const created = { type: 'INCOME', amount: '12.50', currency: 'USD' }

  it('writes the CREATE audit row (impersonator attributed) THEN notifies the receiver', async () => {
    const h = setup(makeRow())
    const order: string[] = []
    h.insert.mockImplementation(() => ({
      values: vi.fn(async (v: unknown) => {
        order.push('audit')
        h.auditValues.push(v)
      }),
    }))
    h.create.mockImplementation(async () => {
      order.push('notify')
      return null
    })
    const impersonated = { ...ACTOR, impersonatorId: 'real-admin' } as SessionUser
    await h.svc.afterTransactionCreated('tx-1', created, impersonated)
    expect(h.auditValues).toEqual([
      {
        actorId: 'real-admin',
        targetId: 'tx-1',
        action: 'CREATE',
        metadata: { type: 'INCOME', amount: '12.50', currency: 'USD' },
      },
    ])
    expect(order).toEqual(['audit', 'notify'])
  })

  it('uses the actor id when not impersonating', async () => {
    const h = setup(makeRow())
    await h.svc.afterTransactionCreated('tx-1', created, ACTOR)
    expect(h.auditValues[0]).toMatchObject({ actorId: 'actor-1' })
  })

  it('writes no audit row without an actor (cron) but still notifies', async () => {
    const h = setup(makeRow())
    await h.svc.afterTransactionCreated('tx-1', created, null)
    expect(h.insert).not.toHaveBeenCalled()
    expect(h.create).toHaveBeenCalledTimes(1)
  })

  it('swallows an audit write failure, logs it, and still notifies', async () => {
    const h = setup(makeRow())
    h.insert.mockImplementation(() => ({
      values: vi.fn().mockRejectedValue(new Error('db hiccup')),
    }))
    await expect(h.svc.afterTransactionCreated('tx-1', created, ACTOR)).resolves.toBeUndefined()
    expect(h.errors).toEqual([
      'recordCreationAudit: failed to persist audit record for transaction=tx-1: db hiccup',
    ])
    expect(h.create).toHaveBeenCalledTimes(1)
  })
})
