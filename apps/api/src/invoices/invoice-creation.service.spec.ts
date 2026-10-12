/**
 * InvoiceCreationService — direct unit spec (giant-decomposition leaf L5).
 *
 * The auto-create triggers were moved out of InvoicesService verbatim. This spec drives the new
 * collaborator through its own seam with recording doubles (db / pdf / documents / notifications /
 * facade callbacks), asserting the exact arguments handed to each collaborator, the exact log
 * lines, and the Drizzle predicates (rendered to SQL params through PgDialect, so a narrowed
 * `inArray` list or a wrong id is observable without a live Postgres).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Logger } from '@nestjs/common'
import { PgDialect } from 'drizzle-orm/pg-core'
import type { SQL } from 'drizzle-orm'
import { NOTIFICATION_TITLES } from '@crm/shared'
import type { DatabaseService } from '../database/database.service'
import { invoiceSignatures, nonDeletedTransactions, transactions } from '../database/schema'
import type { DocumentsService } from '../documents/documents.service'
import type { NotificationsService } from '../notifications/notifications.service'
import type { InvoicePdfService } from './invoice-pdf.service'
import { InvoiceCreationService, type InvoiceCreationDeps } from './invoice-creation.service'
import { COMPANY_INFO } from './invoice-company-info.const'

const dialect = new PgDialect()
const params = (p: unknown): unknown[] => dialect.sqlToQuery(p as SQL).params

interface Chain {
  from: (t: unknown) => Chain
  where: (p: unknown) => Chain
  limit: (n: number) => Chain
  then: (res: (rows: unknown[]) => unknown, rej: (e: unknown) => unknown) => Promise<unknown>
}

interface Harness {
  svc: InvoiceCreationService
  froms: unknown[]
  wheres: unknown[]
  userWheres: unknown[]
  projectWheres: unknown[]
  updates: { table: unknown; values: unknown; where: unknown }[]
  inserts: { table: unknown; values: unknown }[]
  pdf: ReturnType<typeof vi.fn>
  upload: ReturnType<typeof vi.fn>
  notify: ReturnType<typeof vi.fn>
  deps: {
    [K in keyof InvoiceCreationDeps]: ReturnType<typeof vi.fn>
  }
  logger: {
    warn: ReturnType<typeof vi.spyOn>
    debug: ReturnType<typeof vi.spyOn>
    error: ReturnType<typeof vi.spyOn>
    log: ReturnType<typeof vi.spyOn>
  }
}

const HASH = 'abcdef0123456789'

function makeHarness(o: {
  selects?: unknown[][]
  users?: unknown[]
  projects?: unknown[]
  aggregate?: unknown
}): Harness {
  const selectQueue = [...(o.selects ?? [])]
  const userQueue = [...(o.users ?? [])]
  const projectQueue = [...(o.projects ?? [])]
  const froms: unknown[] = []
  const wheres: unknown[] = []
  const userWheres: unknown[] = []
  const projectWheres: unknown[] = []
  const updates: Harness['updates'] = []
  const inserts: Harness['inserts'] = []

  const select = vi.fn(() => {
    const chain: Chain = {
      from: (t) => {
        froms.push(t)
        return chain
      },
      where: (p) => {
        wheres.push(p)
        return chain
      },
      limit: () => chain,
      then: (res, rej) => Promise.resolve(selectQueue.shift() ?? []).then(res, rej),
    }
    return chain
  })
  const db = {
    db: {
      select,
      query: {
        users: {
          findFirst: vi.fn(async (a: { where: unknown }) => {
            userWheres.push(a.where)
            return userQueue.shift()
          }),
        },
        projects: {
          findFirst: vi.fn(async (a: { where: unknown }) => {
            projectWheres.push(a.where)
            return projectQueue.shift()
          }),
        },
      },
      update: vi.fn((table: unknown) => ({
        set: (values: unknown) => ({
          where: async (where: unknown) => {
            updates.push({ table, values, where })
          },
        }),
      })),
      insert: vi.fn((table: unknown) => ({
        values: async (values: unknown) => {
          inserts.push({ table, values })
        },
      })),
    },
  } as unknown as DatabaseService

  const pdf = vi.fn(async () => ({ pdfBuffer: Buffer.from('PDF'), sha256Hash: HASH }))
  const upload = vi.fn(async () => ({ id: 'doc-1' }))
  const notify = vi.fn(async () => undefined)
  const deps = {
    getAdminId: vi.fn(async () => 'admin-1'),
    resolvePayoutAggregateAmount: vi.fn(async () =>
      o.aggregate === undefined
        ? { amount: '1500.000000', currency: 'USDT', mixedCurrency: false }
        : o.aggregate,
    ),
    lookupContractNumber: vi.fn(async () => 'CHK-123'),
    buildVerifyUrl: vi.fn((id: string) => `https://verify.example/${id}`),
  }
  const svc = new InvoiceCreationService(
    db,
    { generateSignableInvoicePdf: pdf } as unknown as InvoicePdfService,
    { uploadInternal: upload } as unknown as DocumentsService,
    { create: notify } as unknown as NotificationsService,
    deps as unknown as InvoiceCreationDeps,
  )
  return {
    svc,
    froms,
    wheres,
    userWheres,
    projectWheres,
    updates,
    inserts,
    pdf,
    upload,
    notify,
    deps,
    logger: {
      warn: vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined),
      debug: vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined),
      error: vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined),
      log: vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined),
    },
  }
}

const SENIOR_ID = 'sen-1'
const SENIOR = {
  id: SENIOR_ID,
  displayName: 'Sen Ior',
  role: 'SENIOR',
  locale: 'uk',
  paymentMethod: null,
}
const ADMIN = { id: 'admin-1', displayName: 'Ad Min', role: 'ADMIN', locale: 'uk' }
const SENIOR_INFO = {
  displayName: 'Sen Ior',
  locale: 'uk',
  paymentMethod: null,
  paymentDetails: [],
}

function row(o: Record<string, unknown>) {
  return {
    id: 'aaaaaaaa-1111-2222-3333-444444444444',
    type: 'SENIOR_INCOME',
    status: 'PAID',
    amount: '1000.000000',
    currency: 'USDT',
    senderId: null,
    receiverId: SENIOR_ID,
    projectId: null,
    payoutRequestId: null,
    invoiceDocumentId: null,
    salaryMonth: null,
    txDate: null,
    createdAt: new Date('2026-03-05T10:00:00Z'),
    ...o,
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-05-01T12:00:00Z'))
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('InvoiceCreationService.autoCreateForSeniorPayout', () => {
  it('logs under the facade context (InvoicesService)', () => {
    const h = makeHarness({})
    expect((h.svc as unknown as { logger: { context?: string } }).logger.context).toBe(
      'InvoicesService',
    )
  })

  it('reads the row from the non-deleted view by id', async () => {
    const h = makeHarness({ selects: [[]] })
    await h.svc.autoCreateForSeniorPayout('tx-9')
    expect(h.froms).toEqual([nonDeletedTransactions])
    expect(params(h.wheres[0])).toEqual(['tx-9'])
  })

  it('does nothing when the row is gone', async () => {
    const h = makeHarness({ selects: [[]] })
    await h.svc.autoCreateForSeniorPayout('tx-9')
    expect(h.pdf).not.toHaveBeenCalled()
    expect(h.deps.getAdminId).not.toHaveBeenCalled()
  })

  it('does nothing for a non-SENIOR_INCOME row', async () => {
    const h = makeHarness({ selects: [[row({ type: 'SALARY' })]] })
    await h.svc.autoCreateForSeniorPayout('tx-9')
    expect(h.pdf).not.toHaveBeenCalled()
  })

  it('creates the invoice for a SENIOR_INCOME row', async () => {
    const h = makeHarness({ selects: [[row({})]], users: [SENIOR, ADMIN] })
    await h.svc.autoCreateForSeniorPayout('tx-9')
    expect(h.pdf).toHaveBeenCalledTimes(1)
  })
})

describe('InvoiceCreationService.autoCreateForSalary', () => {
  it('reads the row from the non-deleted view by id', async () => {
    const h = makeHarness({ selects: [[]] })
    await h.svc.autoCreateForSalary('tx-8')
    expect(h.froms).toEqual([nonDeletedTransactions])
    expect(params(h.wheres[0])).toEqual(['tx-8'])
  })

  it('does nothing when the row is gone', async () => {
    const h = makeHarness({ selects: [[]] })
    await h.svc.autoCreateForSalary('tx-8')
    expect(h.pdf).not.toHaveBeenCalled()
  })

  it('does nothing for a non-SALARY row', async () => {
    const h = makeHarness({ selects: [[row({ type: 'SENIOR_INCOME' })]] })
    await h.svc.autoCreateForSalary('tx-8')
    expect(h.pdf).not.toHaveBeenCalled()
  })

  it('creates the invoice for a SALARY row', async () => {
    const h = makeHarness({ selects: [[row({ type: 'SALARY' })]], users: [SENIOR, ADMIN] })
    await h.svc.autoCreateForSalary('tx-8')
    expect(h.pdf).toHaveBeenCalledTimes(1)
  })
})

describe('InvoiceCreationService.autoCreate (via the SENIOR_INCOME / SALARY triggers)', () => {
  it('skips a row that already carries an invoice document', async () => {
    const h = makeHarness({ selects: [[row({ invoiceDocumentId: 'd-0' })]] })
    await h.svc.autoCreateForSeniorPayout('x')
    expect(h.logger.debug).toHaveBeenCalledWith(
      'autoCreate: tx aaaaaaaa-1111-2222-3333-444444444444 already has invoiceDocumentId, skipping',
    )
    expect(h.pdf).not.toHaveBeenCalled()
    expect(h.userWheres).toHaveLength(0)
  })

  it('warns and skips when the row has no counterparty', async () => {
    const h = makeHarness({ selects: [[row({ receiverId: null })]] })
    await h.svc.autoCreateForSeniorPayout('x')
    expect(h.logger.warn).toHaveBeenCalledWith(
      'autoCreate: tx aaaaaaaa-1111-2222-3333-444444444444 has no counterparty — skip',
    )
    expect(h.pdf).not.toHaveBeenCalled()
  })

  it('warns and skips when the counterparty user is missing (looked up by receiver id)', async () => {
    const h = makeHarness({ selects: [[row({})]], users: [undefined] })
    await h.svc.autoCreateForSeniorPayout('x')
    expect(params(h.userWheres[0])).toEqual([SENIOR_ID])
    expect(h.logger.warn).toHaveBeenCalledWith('autoCreate: counterparty sen-1 missing')
    expect(h.deps.getAdminId).not.toHaveBeenCalled()
    expect(h.pdf).not.toHaveBeenCalled()
  })

  it('logs an error and skips when the ADMIN user is missing (looked up by the admin id)', async () => {
    const h = makeHarness({ selects: [[row({})]], users: [SENIOR, undefined] })
    await h.svc.autoCreateForSeniorPayout('x')
    expect(params(h.userWheres[1])).toEqual(['admin-1'])
    expect(h.logger.error).toHaveBeenCalledWith('autoCreate: ADMIN user admin-1 not found')
    expect(h.pdf).not.toHaveBeenCalled()
  })

  it('SENIOR_INCOME with a project: resolves the project name by id and runs the full pipeline', async () => {
    const h = makeHarness({
      selects: [[row({ projectId: 'p-1' })]],
      users: [SENIOR, ADMIN],
      projects: [{ id: 'p-1', name: 'Alpha' }],
    })
    await h.svc.autoCreateForSeniorPayout('x')

    expect(params(h.projectWheres[0])).toEqual(['p-1'])
    expect(h.deps.buildVerifyUrl).toHaveBeenCalledWith('aaaaaaaa-1111-2222-3333-444444444444')
    expect(h.pdf).toHaveBeenCalledWith({
      transaction: {
        id: 'aaaaaaaa-1111-2222-3333-444444444444',
        type: 'SENIOR_INCOME',
        amount: '1000.000000',
        currency: 'USDT',
        projectName: 'Alpha',
        salaryMonth: null,
        // txDate NULL -> falls back to createdAt
        txDate: new Date('2026-03-05T10:00:00Z'),
      },
      company: COMPANY_INFO,
      counterparty: SENIOR_INFO,
      signatures: [
        {
          role: 'COMPANY',
          signerName: 'Ad Min',
          signedAt: new Date('2026-05-01T12:00:00Z'),
          method: 'AUTO_COMPANY',
        },
      ],
      verifyUrl: 'https://verify.example/aaaaaaaa-1111-2222-3333-444444444444',
    })
    expect(h.upload).toHaveBeenCalledWith({
      category: 'INVOICE',
      ownerId: SENIOR_ID,
      file: Buffer.from('PDF'),
      mimeType: 'application/pdf',
      name: 'invoice-aaaaaaaa.pdf',
      uploadedById: 'admin-1',
    })
    expect(h.updates).toHaveLength(1)
    expect(h.updates[0]!.table).toBe(transactions)
    expect(h.updates[0]!.values).toEqual({
      invoiceDocumentId: 'doc-1',
      updatedAt: new Date('2026-05-01T12:00:00Z'),
    })
    expect(params(h.updates[0]!.where)).toEqual(['aaaaaaaa-1111-2222-3333-444444444444'])
    expect(h.inserts).toHaveLength(1)
    expect(h.inserts[0]!.table).toBe(invoiceSignatures)
    expect(h.inserts[0]!.values).toStrictEqual({
      transactionId: 'aaaaaaaa-1111-2222-3333-444444444444',
      signerRole: 'COMPANY',
      signerId: 'admin-1',
      pdfHash: HASH,
      method: 'AUTO_COMPANY',
      ipAddress: null,
      userAgent: null,
    })
    expect(h.notify).toHaveBeenCalledWith({
      userId: SENIOR_ID,
      type: 'INVOICE_SIGN_REQUIRED',
      title: NOTIFICATION_TITLES.INVOICE_SIGN_REQUIRED,
      data: { amount: '1000.000000', currency: 'USDT' },
      link: '/documents?category=INVOICE&openTx=aaaaaaaa-1111-2222-3333-444444444444',
    })
    expect(h.logger.log).toHaveBeenCalledWith(
      'autoCreate: tx=aaaaaaaa-1111-2222-3333-444444444444 type=SENIOR_INCOME counterparty=sen-1 doc=doc-1 hash=abcdef01',
    )
  })

  it('SENIOR_INCOME whose project row is missing: projectName stays null', async () => {
    const h = makeHarness({
      selects: [[row({ projectId: 'p-1' })]],
      users: [SENIOR, ADMIN],
      projects: [undefined],
    })
    await h.svc.autoCreateForSeniorPayout('x')
    const arg = h.pdf.mock.calls[0]![0] as { transaction: { projectName: unknown } }
    expect(arg.transaction.projectName).toBeNull()
  })

  it('SENIOR_INCOME without a project id: no project lookup, projectName null', async () => {
    const h = makeHarness({ selects: [[row({})]], users: [SENIOR, ADMIN] })
    await h.svc.autoCreateForSeniorPayout('x')
    expect(h.projectWheres).toHaveLength(0)
    const arg = h.pdf.mock.calls[0]![0] as { transaction: { projectName: unknown } }
    expect(arg.transaction.projectName).toBeNull()
  })

  it('SALARY: project is irrelevant (no lookup even when projectId is set); salaryMonth and txDate pass through', async () => {
    const h = makeHarness({
      selects: [
        [
          row({
            type: 'SALARY',
            projectId: 'p-1',
            salaryMonth: '2026-03',
            txDate: new Date('2026-04-01T00:00:00Z'),
          }),
        ],
      ],
      users: [SENIOR, ADMIN],
    })
    await h.svc.autoCreateForSalary('x')
    expect(h.projectWheres).toHaveLength(0)
    const arg = h.pdf.mock.calls[0]![0] as { transaction: unknown }
    expect(arg.transaction).toStrictEqual({
      id: 'aaaaaaaa-1111-2222-3333-444444444444',
      type: 'SALARY',
      amount: '1000.000000',
      currency: 'USDT',
      projectName: null,
      salaryMonth: '2026-03',
      txDate: new Date('2026-04-01T00:00:00Z'),
    })
    expect(h.logger.log).toHaveBeenCalledWith(
      'autoCreate: tx=aaaaaaaa-1111-2222-3333-444444444444 type=SALARY counterparty=sen-1 doc=doc-1 hash=abcdef01',
    )
  })
})

describe('InvoiceCreationService.autoCreateForPayout', () => {
  const PAYOUT_ID = 'bbbbbbbb-2222-3333-4444-555555555555'
  const payout = (o: Record<string, unknown> = {}) =>
    row({
      id: PAYOUT_ID,
      type: 'PAYOUT',
      senderId: SENIOR_ID,
      receiverId: null,
      payoutRequestId: 'req-1',
      createdAt: new Date('2026-03-31T10:00:00Z'),
      ...o,
    })
  const income = (o: Record<string, unknown>) =>
    row({ id: 'inc', type: 'SENIOR_INCOME', payoutRequestId: 'req-1', ...o })

  it('reads the PAYOUT row from the non-deleted view by id', async () => {
    const h = makeHarness({ selects: [[]] })
    await h.svc.autoCreateForPayout(PAYOUT_ID)
    expect(h.froms).toEqual([nonDeletedTransactions])
    expect(params(h.wheres[0])).toEqual([PAYOUT_ID])
    expect(h.pdf).not.toHaveBeenCalled()
  })

  it('ignores a non-PAYOUT row', async () => {
    const h = makeHarness({ selects: [[payout({ type: 'SALARY' })]] })
    await h.svc.autoCreateForPayout(PAYOUT_ID)
    expect(h.froms).toHaveLength(1)
    expect(h.pdf).not.toHaveBeenCalled()
  })

  it('warns and stops when the PAYOUT row has no payoutRequestId', async () => {
    const h = makeHarness({ selects: [[payout({ payoutRequestId: null })]] })
    await h.svc.autoCreateForPayout(PAYOUT_ID)
    expect(h.logger.warn).toHaveBeenCalledWith(
      `autoCreateForPayout: PAYOUT tx=${PAYOUT_ID} has no payoutRequestId`,
    )
    expect(h.froms).toHaveLength(1)
  })

  it('is idempotent: a PAYOUT that already has an invoice is skipped', async () => {
    const h = makeHarness({ selects: [[payout({ invoiceDocumentId: 'd-0' })]] })
    await h.svc.autoCreateForPayout(PAYOUT_ID)
    expect(h.logger.debug).toHaveBeenCalledWith(
      `autoCreateForPayout: PAYOUT ${PAYOUT_ID} already has invoice — skip`,
    )
    expect(h.froms).toHaveLength(1)
    expect(h.pdf).not.toHaveBeenCalled()
  })

  it('fetches linked incomes by payoutRequestId restricted to SENIOR_INCOME + DROP_INCOME', async () => {
    const h = makeHarness({ selects: [[payout()], []] })
    await h.svc.autoCreateForPayout(PAYOUT_ID)
    expect(h.froms).toEqual([nonDeletedTransactions, nonDeletedTransactions])
    expect(params(h.wheres[1])).toEqual(['req-1', 'SENIOR_INCOME', 'DROP_INCOME'])
  })

  it('warns and stops when there are no linked incomes', async () => {
    const h = makeHarness({ selects: [[payout()], []] })
    await h.svc.autoCreateForPayout(PAYOUT_ID)
    expect(h.logger.warn).toHaveBeenCalledWith(
      `autoCreateForPayout: PAYOUT ${PAYOUT_ID} has no linked SENIOR_INCOME/DROP_INCOME — skip`,
    )
    expect(h.userWheres).toHaveLength(0)
  })

  it('warns and stops when no linked income has a receiver', async () => {
    const h = makeHarness({ selects: [[payout()], [income({ receiverId: null })]] })
    await h.svc.autoCreateForPayout(PAYOUT_ID)
    expect(h.logger.warn).toHaveBeenCalledWith(
      `autoCreateForPayout: PAYOUT ${PAYOUT_ID} — no receiver found on linked incomes`,
    )
    expect(h.userWheres).toHaveLength(0)
  })

  it('warns and stops when the counterparty user is missing', async () => {
    const h = makeHarness({ selects: [[payout()], [income({})]], users: [undefined] })
    await h.svc.autoCreateForPayout(PAYOUT_ID)
    expect(params(h.userWheres[0])).toEqual([SENIOR_ID])
    expect(h.logger.warn).toHaveBeenCalledWith('autoCreateForPayout: counterparty sen-1 missing')
    expect(h.deps.getAdminId).not.toHaveBeenCalled()
  })

  it('logs an error and stops when the ADMIN user is missing', async () => {
    const h = makeHarness({ selects: [[payout()], [income({})]], users: [SENIOR, undefined] })
    await h.svc.autoCreateForPayout(PAYOUT_ID)
    expect(params(h.userWheres[1])).toEqual(['admin-1'])
    expect(h.logger.error).toHaveBeenCalledWith('autoCreateForPayout: ADMIN user admin-1 not found')
    expect(h.deps.resolvePayoutAggregateAmount).not.toHaveBeenCalled()
  })

  it('logs an error and stops when the aggregate cannot be resolved', async () => {
    const h = makeHarness({
      selects: [[payout()], [income({})]],
      users: [SENIOR, ADMIN],
      aggregate: null,
    })
    await h.svc.autoCreateForPayout(PAYOUT_ID)
    expect(h.deps.resolvePayoutAggregateAmount).toHaveBeenCalledWith('req-1')
    expect(h.logger.error).toHaveBeenCalledWith(
      `autoCreateForPayout: PAYOUT ${PAYOUT_ID} — aggregate amount could not be resolved despite 1 linked income(s) present — skip`,
    )
    expect(h.pdf).not.toHaveBeenCalled()
  })

  it('happy path: aggregates amount, dedupes project names, takes salaryMonth from the earliest income, then uploads / links / signs / notifies', async () => {
    const h = makeHarness({
      selects: [
        [payout()],
        [
          // array order is deliberately NOT chronological: the later income comes first
          income({
            id: 'inc-later',
            receiverId: null,
            projectId: 'p-2',
            salaryMonth: '2026-04',
            createdAt: new Date('2026-04-15T00:00:00Z'),
          }),
          income({
            id: 'inc-earlier',
            projectId: 'p-1',
            salaryMonth: '2026-03',
            createdAt: new Date('2026-03-15T00:00:00Z'),
          }),
          income({
            id: 'inc-dup',
            projectId: 'p-1',
            salaryMonth: '2026-05',
            createdAt: new Date('2026-05-15T00:00:00Z'),
          }),
          income({
            id: 'inc-noproj',
            projectId: null,
            createdAt: new Date('2026-06-01T00:00:00Z'),
          }),
          income({
            id: 'inc-ghost',
            projectId: 'p-3',
            createdAt: new Date('2026-06-02T00:00:00Z'),
          }),
        ],
      ],
      users: [SENIOR, ADMIN],
      projects: [{ id: 'p-2', name: 'Beta' }, { id: 'p-1', name: 'Alpha' }, undefined],
    })
    await h.svc.autoCreateForPayout(PAYOUT_ID)

    // receiver comes from the first income that HAS one (the second array element)
    expect(params(h.userWheres[0])).toEqual([SENIOR_ID])
    // p-2, p-1 (dup skipped), no-project skipped, p-3 (missing row -> no name)
    expect(h.projectWheres.map(params)).toEqual([['p-2'], ['p-1'], ['p-3']])
    expect(h.deps.lookupContractNumber).toHaveBeenCalledWith(SENIOR_ID, 'SENIOR')
    expect(h.deps.buildVerifyUrl).toHaveBeenCalledWith(PAYOUT_ID)
    expect(h.pdf).toHaveBeenCalledWith({
      transaction: {
        id: PAYOUT_ID,
        type: 'SENIOR_INCOME',
        amount: '1500.000000',
        currency: 'USDT',
        projectName: null,
        projectNames: ['Beta', 'Alpha'],
        contractNumber: 'CHK-123',
        salaryMonth: '2026-03',
        txDate: new Date('2026-03-31T10:00:00Z'),
      },
      company: COMPANY_INFO,
      counterparty: SENIOR_INFO,
      signatures: [
        {
          role: 'COMPANY',
          signerName: 'Ad Min',
          signedAt: new Date('2026-05-01T12:00:00Z'),
          method: 'AUTO_COMPANY',
        },
      ],
      verifyUrl: `https://verify.example/${PAYOUT_ID}`,
    })
    expect(h.upload).toHaveBeenCalledWith({
      category: 'INVOICE',
      ownerId: SENIOR_ID,
      file: Buffer.from('PDF'),
      mimeType: 'application/pdf',
      name: 'invoice-bbbbbbbb.pdf',
      uploadedById: 'admin-1',
    })
    expect(h.updates).toHaveLength(1)
    expect(h.updates[0]!.table).toBe(transactions)
    expect(h.updates[0]!.values).toEqual({
      invoiceDocumentId: 'doc-1',
      updatedAt: new Date('2026-05-01T12:00:00Z'),
    })
    expect(params(h.updates[0]!.where)).toEqual([PAYOUT_ID])
    expect(h.inserts[0]!.table).toBe(invoiceSignatures)
    expect(h.inserts[0]!.values).toStrictEqual({
      transactionId: PAYOUT_ID,
      signerRole: 'COMPANY',
      signerId: 'admin-1',
      pdfHash: HASH,
      method: 'AUTO_COMPANY',
      ipAddress: null,
      userAgent: null,
    })
    expect(h.notify).toHaveBeenCalledWith({
      userId: SENIOR_ID,
      type: 'INVOICE_SIGN_REQUIRED',
      title: NOTIFICATION_TITLES.INVOICE_SIGN_REQUIRED,
      data: { amount: '1500.000000', currency: 'USDT' },
      link: `/documents?category=INVOICE&openTx=${PAYOUT_ID}`,
    })
    expect(h.logger.log).toHaveBeenCalledWith(
      `autoCreateForPayout: PAYOUT=${PAYOUT_ID} req=req-1 incomes=5 projects=2 counterparty=sen-1 doc=doc-1 hash=abcdef01`,
    )
  })

  it('an ADMIN counterparty has no contract number (lookup skipped); txDate wins over createdAt; missing salaryMonth -> null', async () => {
    const h = makeHarness({
      selects: [
        [payout({ txDate: new Date('2026-04-02T00:00:00Z') })],
        [income({ salaryMonth: undefined })],
      ],
      users: [{ ...SENIOR, role: 'ADMIN' }, ADMIN],
    })
    await h.svc.autoCreateForPayout(PAYOUT_ID)
    expect(h.deps.lookupContractNumber).not.toHaveBeenCalled()
    const arg = h.pdf.mock.calls[0]![0] as {
      transaction: { contractNumber: unknown; salaryMonth: unknown; txDate: unknown }
    }
    expect(arg.transaction.contractNumber).toBeNull()
    expect(arg.transaction.salaryMonth).toBeNull()
    expect(arg.transaction.txDate).toEqual(new Date('2026-04-02T00:00:00Z'))
  })
})
