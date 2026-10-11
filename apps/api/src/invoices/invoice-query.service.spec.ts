/**
 * Unit spec for InvoiceQueryService (read side extracted from InvoicesService,
 * giant-decomposition leaf L4).
 *
 * The Drizzle double RECORDS the query it is given (select fields, joins, the
 * WHERE predicate) and the spec COMPILES that predicate with `PgDialect` — so
 * the assertions pin the actual SQL text and bound params (RBAC scoping, the
 * type / status filters, the `voided_at IS NULL` scoping), not just "a query
 * was made". Expected SQL fragments are hand-written literals.
 */
import { describe, expect, it } from 'vitest'
import { PgDialect } from 'drizzle-orm/pg-core'
import type { SQL } from 'drizzle-orm'
import type { SessionUser } from '@crm/shared'
import type { DatabaseService } from '../database/database.service'
import { InvoiceQueryService } from './invoice-query.service'

const dialect = new PgDialect()

const viewer = (role: SessionUser['role'], id = 'viewer-1'): SessionUser =>
  ({ id, role }) as SessionUser

interface Recorded {
  fields?: Record<string, unknown>
  joins: Array<{ on: SQL }>
  where?: SQL
  ordered: boolean
}

function makeDb(rows: unknown[], tx?: unknown) {
  const rec: Recorded = { joins: [], ordered: false }
  const builder: Record<string, unknown> = {
    from: () => builder,
    leftJoin: (_t: unknown, on: SQL) => {
      rec.joins.push({ on })
      return builder
    },
    where: (cond: SQL) => {
      rec.where = cond
      return builder
    },
    orderBy: () => {
      rec.ordered = true
      return builder
    },
    then: (resolve: (v: unknown[]) => unknown) => resolve(rows),
  }
  const db = {
    db: {
      select: (fields: Record<string, unknown>) => {
        rec.fields = fields
        return builder
      },
      query: { transactions: { findFirst: () => Promise.resolve(tx) } },
    },
  } as unknown as DatabaseService
  return { svc: new InvoiceQueryService(db), rec }
}

const compile = (q: SQL) => dialect.sqlToQuery(q)

const norm = (s: string) => s.replace(/\s+/g, ' ')

describe('InvoiceQueryService.listInvoices — compiled query', () => {
  it('ADMIN with no filters: invoice-eligible types + has-document only, no counterparty clause', async () => {
    const { svc, rec } = makeDb([])
    await svc.listInvoices(viewer('ADMIN'), {})
    const q = compile(rec.where!)
    expect(q.sql).toContain('"type" in ($1, $2, $3)')
    expect(q.params).toEqual(['SENIOR_INCOME', 'SALARY', 'PAYOUT'])
    expect(q.sql).toContain('"invoice_document_id" is not null')
    expect(q.sql).not.toContain('"receiver_id" = ')
    expect(q.sql).not.toContain('invoice_signatures')
    expect(rec.ordered).toBe(true)
  })

  it('ACCOUNTANT is unscoped like ADMIN', async () => {
    const { svc, rec } = makeDb([])
    await svc.listInvoices(viewer('ACCOUNTANT'), {})
    const q = compile(rec.where!)
    expect(q.params).toEqual(['SENIOR_INCOME', 'SALARY', 'PAYOUT'])
  })

  it.each(['SENIOR', 'JUNIOR', 'HR'] as const)(
    '%s is scoped to own invoices (receiver for income/salary, sender for payout)',
    async (role) => {
      const { svc, rec } = makeDb([])
      await svc.listInvoices(viewer(role, 'me-7'), {})
      const q = compile(rec.where!)
      const sqlText = norm(q.sql)
      expect(sqlText).toContain(
        `(("non_deleted_transactions"."type" IN ('SENIOR_INCOME', 'SALARY') AND "non_deleted_transactions"."receiver_id" = $4) OR ("non_deleted_transactions"."type" = 'PAYOUT' AND "non_deleted_transactions"."sender_id" = $5))`,
      )
      expect(q.params).toEqual(['SENIOR_INCOME', 'SALARY', 'PAYOUT', 'me-7', 'me-7'])
    },
  )

  it('type=SENIOR_INCOME also includes aggregated PAYOUT rows', async () => {
    const { svc, rec } = makeDb([])
    await svc.listInvoices(viewer('ADMIN'), { type: 'SENIOR_INCOME' })
    const q = compile(rec.where!)
    expect(norm(q.sql)).toContain(
      `and "non_deleted_transactions"."type" IN ('SENIOR_INCOME', 'PAYOUT'))`,
    )
    expect(q.params).toEqual(['SENIOR_INCOME', 'SALARY', 'PAYOUT'])
  })

  it('type=SALARY is an equality filter bound as a param', async () => {
    const { svc, rec } = makeDb([])
    await svc.listInvoices(viewer('ADMIN'), { type: 'SALARY' })
    const q = compile(rec.where!)
    expect(q.params).toEqual(['SENIOR_INCOME', 'SALARY', 'PAYOUT', 'SALARY'])
    expect(q.sql).not.toContain(`'PAYOUT')`)
  })

  it('status=PENDING adds NOT EXISTS over ACTIVE counterparty signatures', async () => {
    const { svc, rec } = makeDb([])
    await svc.listInvoices(viewer('ADMIN'), { status: 'PENDING' })
    const sqlText = norm(compile(rec.where!).sql)
    expect(sqlText).toContain(
      `NOT EXISTS (SELECT 1 FROM invoice_signatures WHERE transaction_id = "non_deleted_transactions"."id" AND signer_role = 'COUNTERPARTY' AND voided_at IS NULL)`,
    )
  })

  it('status=SIGNED adds a positive EXISTS (not NOT EXISTS)', async () => {
    const { svc, rec } = makeDb([])
    await svc.listInvoices(viewer('ADMIN'), { status: 'SIGNED' })
    const sqlText = norm(compile(rec.where!).sql)
    expect(sqlText).toContain(
      `and EXISTS (SELECT 1 FROM invoice_signatures WHERE transaction_id = "non_deleted_transactions"."id" AND signer_role = 'COUNTERPARTY' AND voided_at IS NULL)`,
    )
    expect(sqlText).not.toContain('NOT EXISTS')
  })

  it('selects the list columns, the COALESCE counterparty name and the signed flag; joins users via COALESCE(receiver, sender)', async () => {
    const { svc, rec } = makeDb([])
    await svc.listInvoices(viewer('ADMIN'), {})
    expect(Object.keys(rec.fields!)).toEqual([
      'id',
      'type',
      'amount',
      'currency',
      'receiverId',
      'counterpartyName',
      'createdAt',
      'signedFlag',
    ])
    expect(norm(compile(rec.fields!['counterpartyName'] as SQL).sql)).toBe(
      `COALESCE("users"."display_name", '—')`,
    )
    expect(norm(compile(rec.fields!['signedFlag'] as SQL).sql)).toBe(
      `EXISTS (SELECT 1 FROM invoice_signatures WHERE transaction_id = "non_deleted_transactions"."id" AND signer_role = 'COUNTERPARTY' AND voided_at IS NULL)`,
    )
    expect(rec.joins).toHaveLength(1)
    expect(norm(compile(rec.joins[0]!.on).sql)).toBe(
      `"users"."id" = COALESCE("non_deleted_transactions"."receiver_id", "non_deleted_transactions"."sender_id")`,
    )
  })

  it('maps rows to list items (PAYOUT surfaces as SENIOR_INCOME, flag drives status)', async () => {
    const { svc } = makeDb([
      {
        id: 't1',
        type: 'PAYOUT',
        amount: '10.00',
        currency: 'USD',
        counterpartyName: 'Alice',
        signedFlag: true,
        createdAt: new Date('2026-01-02T03:04:05.000Z'),
      },
    ])
    expect(await svc.listInvoices(viewer('ADMIN'), {})).toEqual([
      {
        transactionId: 't1',
        status: 'SIGNED',
        type: 'SENIOR_INCOME',
        amount: '10.00',
        currency: 'USD',
        counterpartyName: 'Alice',
        createdAt: '2026-01-02T03:04:05.000Z',
      },
    ])
  })
})

const txRow = (over: Record<string, unknown> = {}) => ({
  id: 'tx-1',
  type: 'SENIOR_INCOME',
  amount: '5.00',
  currency: 'USD',
  deletedAt: null,
  invoiceDocumentId: 'doc-1',
  senderId: 'sender-1',
  receiverId: 'receiver-1',
  salaryMonth: null,
  createdAt: new Date('2026-02-03T00:00:00.000Z'),
  receiver: { id: 'receiver-1', displayName: 'Rita' },
  sender: { id: 'sender-1', displayName: 'Sam' },
  project: null,
  ...over,
})

describe('InvoiceQueryService.getInvoice', () => {
  it.each(['SENIOR_INCOME', 'SALARY', 'PAYOUT'])(
    '%s transactions are invoice-eligible',
    async (type) => {
      const { svc } = makeDb([], txRow({ type }))
      const dto = await svc.getInvoice(viewer('ADMIN'), 'tx-1')
      expect(dto.transactionId).toBe('tx-1')
      expect(dto.documentId).toBe('doc-1')
    },
  )

  it('a non-invoice transaction type is 404 INVOICE_NOT_APPLICABLE_FOR_TX_TYPE', async () => {
    const { svc } = makeDb([], txRow({ type: 'DROP_INCOME' }))
    await expect(svc.getInvoice(viewer('ADMIN'), 'tx-1')).rejects.toMatchObject({
      response: { code: 'INVOICE_NOT_APPLICABLE_FOR_TX_TYPE', statusCode: 404 },
    })
  })

  it('a transaction without a generated document is 404 INVOICE_NOT_GENERATED_YET', async () => {
    const { svc } = makeDb([], txRow({ invoiceDocumentId: null }))
    await expect(svc.getInvoice(viewer('ADMIN'), 'tx-1')).rejects.toMatchObject({
      response: { code: 'INVOICE_NOT_GENERATED_YET', statusCode: 404 },
    })
  })

  it('missing transaction is 404 and no signature query runs', async () => {
    const { svc, rec } = makeDb([], undefined)
    await expect(svc.getInvoice(viewer('ADMIN'), 'nope')).rejects.toMatchObject({
      response: { statusCode: 404 },
    })
    expect(rec.fields).toBeUndefined()
  })

  it('RBAC: a non-counterparty SENIOR is 403 INVOICE_ACCESS_DENIED before any signature read', async () => {
    const { svc, rec } = makeDb([], txRow())
    await expect(svc.getInvoice(viewer('SENIOR', 'stranger'), 'tx-1')).rejects.toMatchObject({
      response: { code: 'INVOICE_ACCESS_DENIED', statusCode: 403 },
    })
    expect(rec.fields).toBeUndefined()
  })

  it('RBAC: the counterparty may read; signatures feed the DTO status', async () => {
    const { svc } = makeDb(
      [
        {
          id: 's1',
          transactionId: 'tx-1',
          signerRole: 'COUNTERPARTY',
          signerId: 'receiver-1',
          signerName: 'Rita',
          signedAt: new Date('2026-02-04T00:00:00.000Z'),
          pdfHash: 'a'.repeat(64),
          method: 'MANUAL_CLICK',
          amountSnapshot: null,
          currencySnapshot: null,
        },
      ],
      txRow(),
    )
    const dto = await svc.getInvoice(viewer('SENIOR', 'receiver-1'), 'tx-1')
    expect(dto.status).toBe('SIGNED')
    expect(dto.signatures).toHaveLength(1)
  })

  it('a soft-deleted transaction is hidden (404) from a non-privileged viewer, visible to ADMIN', async () => {
    const deleted = txRow({ deletedAt: new Date('2026-03-01T00:00:00.000Z') })
    const hidden = makeDb([], deleted)
    await expect(
      hidden.svc.getInvoice(viewer('SENIOR', 'receiver-1'), 'tx-1'),
    ).rejects.toMatchObject({
      response: { statusCode: 404 },
    })
    const seen = makeDb([], deleted)
    await expect(seen.svc.getInvoice(viewer('ADMIN'), 'tx-1')).resolves.toMatchObject({
      transactionId: 'tx-1',
    })
  })
})

describe('InvoiceQueryService.getSignaturesWithSignerNames', () => {
  it('scopes to the transaction AND active (voided_at IS NULL) rows, joins signer names, selects the signature columns', async () => {
    const { svc, rec } = makeDb([])
    await svc.getSignaturesWithSignerNames('tx-9')
    const q = compile(rec.where!)
    expect(norm(q.sql)).toBe(
      `("invoice_signatures"."transaction_id" = $1 and "invoice_signatures"."voided_at" is null)`,
    )
    expect(q.params).toEqual(['tx-9'])
    expect(Object.keys(rec.fields!)).toEqual([
      'id',
      'transactionId',
      'signerRole',
      'signerId',
      'signerName',
      'signedAt',
      'pdfHash',
      'method',
      'amountSnapshot',
      'currencySnapshot',
    ])
    expect(rec.joins).toHaveLength(1)
  })

  it('returns COMPANY first, then COUNTERPARTY, with a placeholder for a missing signer name', async () => {
    const row = (signerRole: string, day: number, signerName: string | null) => ({
      id: `${signerRole}-${day}`,
      transactionId: 'tx-9',
      signerRole,
      signerId: 'u',
      signerName,
      signedAt: new Date(`2026-01-0${day}T00:00:00.000Z`),
      pdfHash: 'b'.repeat(64),
      method: 'MANUAL_CLICK',
      amountSnapshot: null,
      currencySnapshot: null,
    })
    const { svc } = makeDb([row('COUNTERPARTY', 2, null), row('COMPANY', 3, 'Co')])
    const out = await svc.getSignaturesWithSignerNames('tx-9')
    expect(out.map((s) => s.signerRole)).toEqual(['COMPANY', 'COUNTERPARTY'])
    expect(out[1]!.signerName).toBe('—')
  })
})
