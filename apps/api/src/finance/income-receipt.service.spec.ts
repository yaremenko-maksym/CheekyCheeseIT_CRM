/**
 * Characterization net for the income-receipt cluster of TransactionsService
 * (finance D prerequisite): `updateSeniorIncome`, `updateDropIncome`,
 * `attachOrReplaceReceipt` and the shared `replaceReceiptAtomic` they all route
 * through.
 *
 * PURPOSE. These methods were only covered by an integration spec (real
 * Postgres); a prior extraction attempt left 133 un-killed mutants. This is the
 * UNIT net that pins CURRENT observable behaviour over a db-double so a later
 * verbatim move into an `IncomeReceiptService` reports 0 survivors without
 * Stryker directives. Characterization only: it asserts what the code does today
 * (including documented quirks), not a redesign.
 *
 * The db-double records every operation in ONE ordered event log so the
 * ordering-sensitive contract is pinned, not just the payloads:
 *   bind-check read -> old-doc S3-key read -> BEGIN -> UPDATE tx (deleted_at IS
 *   NULL, returning) -> DELETE old document -> on-chain claim -> divergence ->
 *   audit INSERT -> (post-commit) S3 delete -> findOne read-back.
 *
 * `findOne` read-backs stay on the facade: it is stubbed and asserted via the
 * facade (`findOne(id, currentUser)`), never re-implemented here.
 */
import { BadRequestException, ForbiddenException, HttpException } from '@nestjs/common'
import { PgDialect } from 'drizzle-orm/pg-core'
import type { SessionUser } from '@crm/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { documents, transactionAuditLog, transactions } from '../database/schema'
import { makeTransactionsService } from './__test-helpers__/make-transactions-service'

// The claim primitive is the registry's own unit (onchain-claim / onchain-tx
// specs). Here we only pin HOW the cluster calls it.
const consumeTxHashMock = vi.hoisted(() => vi.fn())
vi.mock('./onchain-tx', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./onchain-tx')>()
  return { ...actual, consumeTxHash: consumeTxHashMock }
})

const FROZEN_NOW = new Date('2026-03-04T05:06:07.000Z')

function compile(where: unknown): { sql: string; params: unknown[] } {
  return new PgDialect().sqlToQuery(where as Parameters<PgDialect['sqlToQuery']>[0])
}

function user(
  id: string,
  role: SessionUser['role'],
  extra: Record<string, unknown> = {},
): SessionUser {
  return { id, role, ...extra } as unknown as SessionUser
}

const SENIOR = user('user-senior', 'SENIOR')
const DROP = user('user-drop', 'DROP')
const ADMIN = user('user-admin', 'ADMIN')
const ACCOUNTANT = user('user-accountant', 'ACCOUNTANT')
const HR = user('user-hr', 'HR')

const EXPLORER_URL_A = `https://etherscan.io/tx/0x${'a'.repeat(64)}`

interface Harness {
  svc: ReturnType<typeof makeTransactionsService>
  events: string[]
  txFindFirst: ReturnType<typeof vi.fn>
  usersFindFirst: ReturnType<typeof vi.fn>
  docsFindFirst: ReturnType<typeof vi.fn>
  transaction: ReturnType<typeof vi.fn>
  dbtx: Record<string, unknown>
  setPayloads: unknown[]
  updateWheres: Array<{ sql: string; params: unknown[] }>
  updateTables: unknown[]
  deleteWheres: Array<{ sql: string; params: unknown[] }>
  deleteTables: unknown[]
  insertTables: unknown[]
  insertValues: unknown[]
  returningCols: unknown[]
  deleteS3Keys: ReturnType<typeof vi.fn>
  findOne: ReturnType<typeof vi.fn>
  debug: ReturnType<typeof vi.fn>
  onChain: {
    resolveReceiptHashTransition: ReturnType<typeof vi.fn>
    recordReclaimAfterRelease: ReturnType<typeof vi.fn>
    recordReceiptClaimDivergence: ReturnType<typeof vi.fn>
  }
}

interface HarnessOpts {
  tx?: unknown
  receiver?: unknown
  /** Map docId -> documents row for `documents.findFirst`. Keyed by the compiled WHERE param. */
  docs?: Record<string, unknown>
  updatedRows?: Array<{ id: string }>
  transition?: {
    txHashPatch: { txHash?: string | null }
    claimHash: string | null
    staleClaim: boolean
  }
}

function makeHarness(opts: HarnessOpts = {}): Harness {
  const events: string[] = []
  const setPayloads: unknown[] = []
  const updateWheres: Harness['updateWheres'] = []
  const updateTables: unknown[] = []
  const deleteWheres: Harness['deleteWheres'] = []
  const deleteTables: unknown[] = []
  const insertTables: unknown[] = []
  const insertValues: unknown[] = []
  const returningCols: unknown[] = []

  const txFindFirst = vi.fn().mockImplementation(async () => {
    events.push('read:tx')
    return opts.tx
  })
  const usersFindFirst = vi.fn().mockImplementation(async () => {
    events.push('read:receiver')
    return opts.receiver
  })
  const docsFindFirst = vi.fn().mockImplementation(async (arg: { where: unknown }) => {
    const id = compile(arg.where).params[0] as string
    events.push(`read:doc:${id}`)
    return opts.docs?.[id]
  })

  const dbtx = {
    update: (table: unknown) => {
      updateTables.push(table)
      return {
        set: (v: unknown) => {
          setPayloads.push(v)
          return {
            where: (w: unknown) => {
              updateWheres.push(compile(w))
              return {
                returning: async (cols: unknown) => {
                  returningCols.push(cols)
                  events.push('tx:update')
                  return opts.updatedRows ?? [{ id: 'row' }]
                },
              }
            },
          }
        },
      }
    },
    delete: (table: unknown) => {
      deleteTables.push(table)
      return {
        where: async (w: unknown) => {
          deleteWheres.push(compile(w))
          events.push('tx:delete')
        },
      }
    },
    insert: (table: unknown) => {
      insertTables.push(table)
      return {
        values: async (v: unknown) => {
          insertValues.push(v)
          events.push('tx:audit-insert')
        },
      }
    },
  }

  const transaction = vi.fn().mockImplementation(async (cb: (t: unknown) => Promise<void>) => {
    events.push('tx:begin')
    const result = await cb(dbtx)
    events.push('tx:commit')
    return result
  })

  const db = {
    db: {
      query: {
        transactions: { findFirst: txFindFirst },
        users: { findFirst: usersFindFirst },
        documents: { findFirst: docsFindFirst },
      },
      transaction,
    },
  } as never

  const deleteS3Keys = vi.fn().mockImplementation(async () => {
    events.push('s3:delete')
  })
  const svc = makeTransactionsService({
    db,
    documentsService: { deleteS3Keys } as never,
  })

  const findOne = vi.fn().mockImplementation(async () => {
    events.push('facade:findOne')
    return { readBack: true }
  })
  vi.spyOn(svc, 'findOne').mockImplementation(findOne as never)

  const onChain = {
    resolveReceiptHashTransition: vi.fn().mockImplementation(async () => {
      events.push('claim:resolve')
      return opts.transition ?? { txHashPatch: {}, claimHash: null, staleClaim: false }
    }),
    recordReclaimAfterRelease: vi.fn().mockImplementation(async () => {
      events.push('claim:record-reclaim')
    }),
    recordReceiptClaimDivergence: vi.fn().mockImplementation(async () => {
      events.push('claim:record-divergence')
    }),
  }
  ;(svc as unknown as { onChainClaim: unknown }).onChainClaim = onChain

  consumeTxHashMock.mockImplementation(async () => {
    events.push('claim:consume')
    return { claimed: true, reclaimedAfterRelease: false }
  })

  const debug = vi.fn()
  ;(svc as unknown as { logger: { debug: unknown } }).logger.debug = debug

  return {
    svc,
    events,
    txFindFirst,
    usersFindFirst,
    docsFindFirst,
    transaction,
    dbtx,
    setPayloads,
    updateWheres,
    updateTables,
    deleteWheres,
    deleteTables,
    insertTables,
    insertValues,
    returningCols,
    deleteS3Keys,
    findOne,
    debug,
    onChain,
  }
}

function incomeRow(kind: 'SENIOR_INCOME' | 'DROP_INCOME', over: Record<string, unknown> = {}) {
  const owner = kind === 'SENIOR_INCOME' ? SENIOR : DROP
  return {
    id: 'tx-1',
    type: kind,
    status: 'REJECTED',
    receiverId: owner.id,
    createdBy: owner.id,
    receiptDocumentId: null,
    receiptExternalUrl: 'https://drive.example/old',
    amount: '1000',
    currency: 'USD',
    notes: 'old notes',
    deletedAt: null,
    ...over,
  }
}

function receiptDoc(id: string, ownerId: string, over: Record<string, unknown> = {}) {
  return {
    id,
    ownerId,
    category: 'RECEIPT',
    s3Key: `s3/${id}`,
    thumbnailS3Key: `s3/${id}.thumb`,
    ...over,
  }
}

async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p
  } catch (e) {
    return e
  }
  throw new Error('expected rejection')
}

function apiCode(err: unknown): { code: unknown; status: number } {
  const e = err as HttpException
  return {
    code: (e.getResponse() as { code?: unknown }).code,
    status: e.getStatus(),
  }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(FROZEN_NOW)
  consumeTxHashMock.mockReset()
})

afterEach(() => {
  vi.useRealTimers()
})

// ───────────────────────────────────────────────────────────────────────────
// updateSeniorIncome / updateDropIncome — identical contract, parameterised.
// ───────────────────────────────────────────────────────────────────────────

const KINDS = [
  {
    name: 'updateSeniorIncome',
    kind: 'SENIOR_INCOME' as const,
    owner: SENIOR,
    otherType: 'DROP_INCOME',
    wrongTypeCode: 'FINANCE_EDIT_SENIOR_INCOME_ONLY',
  },
  {
    name: 'updateDropIncome',
    kind: 'DROP_INCOME' as const,
    owner: DROP,
    otherType: 'SENIOR_INCOME',
    wrongTypeCode: 'FINANCE_EDIT_DROP_INCOME_ONLY',
  },
]

describe.each(KINDS)('$name — resubmit a REJECTED income', ({ name, kind, owner, ...k }) => {
  type Data = Parameters<ReturnType<typeof makeHarness>['svc']['updateSeniorIncome']>[1]
  const call = (h: Harness, data: Data, who: SessionUser = owner) =>
    (h.svc as unknown as Record<string, (id: string, d: Data, u: SessionUser) => Promise<unknown>>)[
      name
    ]!('tx-1', data, who)

  describe('guards (order + codes)', () => {
    if (kind === 'DROP_INCOME') {
      it('non-DROP role -> ForbiddenException BEFORE any db read', async () => {
        const h = makeHarness({ tx: incomeRow(kind) })
        const err = await rejection(call(h, {}, SENIOR))
        expect(err).toBeInstanceOf(ForbiddenException)
        expect(h.txFindFirst).not.toHaveBeenCalled()
        expect(h.events).toEqual([])
      })
      it.each([ADMIN, ACCOUNTANT, HR])('role $role is refused', async (who) => {
        const h = makeHarness({ tx: incomeRow(kind) })
        expect(await rejection(call(h, {}, who))).toBeInstanceOf(ForbiddenException)
      })
    }

    it('looks the row up by id (WHERE id = $1) and 404s when absent', async () => {
      const h = makeHarness({ tx: undefined })
      const err = await rejection(call(h, {}))
      expect(apiCode(err)).toEqual({ code: 'FINANCE_TRANSACTION_NOT_FOUND', status: 404 })
      const arg = h.txFindFirst.mock.calls[0]![0] as { where: unknown }
      const q = compile(arg.where)
      expect(q.params).toEqual(['tx-1'])
      expect(q.sql).toContain('"transactions"."id" = $1')
      expect(h.events).toEqual(['read:tx'])
    })

    it('soft-deleted row: owner (non-privileged) sees 404, never reaches later checks', async () => {
      const h = makeHarness({ tx: incomeRow(kind, { deletedAt: new Date(), type: k.otherType }) })
      const err = await rejection(call(h, {}))
      expect(apiCode(err)).toEqual({ code: 'FINANCE_TRANSACTION_NOT_FOUND', status: 404 })
    })

    if (kind === 'SENIOR_INCOME') {
      it('soft-deleted row: privileged caller gets 400 restore-first (runs before type/status checks)', async () => {
        const h = makeHarness({
          tx: incomeRow(kind, { deletedAt: new Date(), type: 'DROP_INCOME', status: 'PAID' }),
        })
        const err = await rejection(call(h, {}, ADMIN))
        expect(apiCode(err)).toEqual({
          code: 'FINANCE_TRANSACTION_DELETED_RESTORE_FIRST',
          status: 400,
        })
      })
    }

    it('wrong type -> 400 (checked before status and ownership)', async () => {
      const h = makeHarness({
        tx: incomeRow(kind, { type: k.otherType, status: 'PAID', receiverId: 'someone-else' }),
      })
      const err = await rejection(call(h, {}))
      expect(apiCode(err)).toEqual({ code: k.wrongTypeCode, status: 400 })
    })

    it.each(['PENDING', 'PAID', 'APPROVED'])('status %s -> 400 REJECTED-only', async (status) => {
      const h = makeHarness({ tx: incomeRow(kind, { status, receiverId: 'someone-else' }) })
      const err = await rejection(call(h, {}))
      expect(apiCode(err)).toEqual({ code: 'FINANCE_EDIT_REJECTED_ONLY', status: 400 })
    })

    it('not the receiver -> ForbiddenException (even ADMIN)', async () => {
      const h = makeHarness({ tx: incomeRow(kind, { receiverId: 'someone-else' }) })
      expect(await rejection(call(h, {}))).toBeInstanceOf(ForbiddenException)
      const h2 = makeHarness({ tx: incomeRow(kind, { receiverId: 'someone-else' }) })
      expect(await rejection(call(h2, {}, ADMIN))).toBeInstanceOf(ForbiddenException)
      expect(h.events).toEqual(['read:tx'])
    })

    it("archived receiver -> 403 INCOME_RECEIVER_ARCHIVED; queries the CALLER's row; no write", async () => {
      const h = makeHarness({ tx: incomeRow(kind), receiver: { archivedAt: new Date() } })
      const err = await rejection(call(h, { amount: 5 }))
      expect(apiCode(err)).toEqual({ code: 'FINANCE_INCOME_RECEIVER_ARCHIVED', status: 403 })
      const q = compile((h.usersFindFirst.mock.calls[0]![0] as { where: unknown }).where)
      expect(q.params).toEqual([owner.id])
      expect(q.sql).toContain('"users"."id" = $1')
      expect(h.transaction).not.toHaveBeenCalled()
      expect(h.events).toEqual(['read:tx', 'read:receiver'])
    })

    it('active (archivedAt null) or unresolved receiver passes the gate', async () => {
      for (const receiver of [{ archivedAt: null }, undefined]) {
        const h = makeHarness({ tx: incomeRow(kind), receiver })
        await call(h, {})
        expect(h.transaction).toHaveBeenCalledTimes(1)
      }
    })
  })

  describe('write payload (amount / currency / notes / reset-to-PENDING)', () => {
    it('no fields -> keeps amount/currency/notes/receipt, resets review state to PENDING', async () => {
      const row = incomeRow(kind)
      const h = makeHarness({ tx: row })
      const out = await call(h, {})
      expect(out).toEqual({ readBack: true })
      expect(h.setPayloads).toEqual([
        {
          amount: '1000',
          currency: 'USD',
          receiptDocumentId: null,
          receiptExternalUrl: 'https://drive.example/old',
          notes: 'old notes',
          status: 'PENDING',
          rejectionReason: null,
          validatedBy: null,
          validatedAt: null,
          updatedAt: FROZEN_NOW,
        },
      ])
    })

    it('amount is stringified (incl. 0), currency overridden, notes overridden', async () => {
      const h = makeHarness({ tx: incomeRow(kind) })
      await call(h, { amount: 1250.5, currency: 'EUR', notes: 'new' })
      expect(h.setPayloads[0]).toMatchObject({ amount: '1250.5', currency: 'EUR', notes: 'new' })

      const h0 = makeHarness({ tx: incomeRow(kind) })
      await call(h0, { amount: 0 })
      expect(h0.setPayloads[0]).toMatchObject({ amount: '0' })
    })

    it('notes: explicit null clears; undefined keeps', async () => {
      const h = makeHarness({ tx: incomeRow(kind) })
      await call(h, { notes: null })
      expect(h.setPayloads[0]).toMatchObject({ notes: null })

      const h2 = makeHarness({ tx: incomeRow(kind, { notes: null }) })
      await call(h2, { notes: 'x' })
      expect(h2.setPayloads[0]).toMatchObject({ notes: 'x' })
    })

    it('goes through the atomic path with the row id and returns the facade read-back', async () => {
      const h = makeHarness({ tx: incomeRow(kind) })
      const out = await call(h, {})
      expect(out).toEqual({ readBack: true })
      expect(h.findOne).toHaveBeenCalledTimes(1)
      expect(h.findOne).toHaveBeenCalledWith('tx-1', owner)
      expect(h.updateTables).toEqual([transactions])
      expect(h.events.at(-1)).toBe('facade:findOne')
      expect(h.events.at(-2)).toBe('tx:commit')
    })
  })

  describe('XOR receipt resolution', () => {
    const bound = (id: string) => ({ [id]: receiptDoc(id, owner.id) })

    it('only a NEW doc id -> doc wins, url cleared to null', async () => {
      const h = makeHarness({ tx: incomeRow(kind), docs: bound('doc-new') })
      await call(h, { receiptDocumentId: 'doc-new' })
      expect(h.setPayloads[0]).toMatchObject({
        receiptDocumentId: 'doc-new',
        receiptExternalUrl: null,
      })
    })

    it('only a truthy url -> url wins, doc cleared to null (old doc deleted)', async () => {
      const h = makeHarness({
        tx: incomeRow(kind, { receiptDocumentId: 'doc-old', receiptExternalUrl: null }),
        docs: bound('doc-old'),
      })
      await call(h, { receiptExternalUrl: 'https://x.example/r' })
      expect(h.setPayloads[0]).toMatchObject({
        receiptDocumentId: null,
        receiptExternalUrl: 'https://x.example/r',
      })
      expect(h.deleteWheres).toHaveLength(1)
      expect(h.deleteWheres[0]!.params).toEqual(['doc-old'])
    })

    it('url explicitly null (falsy) with no doc field -> doc kept, url cleared', async () => {
      const h = makeHarness({
        tx: incomeRow(kind, { receiptDocumentId: 'doc-old', receiptExternalUrl: null }),
        docs: bound('doc-old'),
      })
      await call(h, { receiptExternalUrl: null })
      expect(h.setPayloads[0]).toMatchObject({
        receiptDocumentId: 'doc-old',
        receiptExternalUrl: null,
      })
      expect(h.deleteWheres).toEqual([])
    })

    it('doc explicitly null (falsy) with no url field -> doc cleared, existing url kept', async () => {
      const h = makeHarness({
        tx: incomeRow(kind, { receiptDocumentId: 'doc-old', receiptExternalUrl: 'https://keep' }),
        docs: bound('doc-old'),
      })
      await call(h, { receiptDocumentId: null })
      expect(h.setPayloads[0]).toMatchObject({
        receiptDocumentId: null,
        receiptExternalUrl: 'https://keep',
      })
      expect(h.deleteWheres[0]!.params).toEqual(['doc-old'])
    })

    it('neither field -> both columns unchanged, no bind check, no delete', async () => {
      const h = makeHarness({
        tx: incomeRow(kind, { receiptDocumentId: 'doc-old', receiptExternalUrl: 'https://keep' }),
      })
      await call(h, {})
      expect(h.setPayloads[0]).toMatchObject({
        receiptDocumentId: 'doc-old',
        receiptExternalUrl: 'https://keep',
      })
      expect(h.docsFindFirst).not.toHaveBeenCalled()
      expect(h.deleteWheres).toEqual([])
      expect(h.deleteS3Keys).not.toHaveBeenCalled()
    })

    it('doc + url together (non-falsy): doc id wins its column, url is kept as given (current quirk)', async () => {
      const h = makeHarness({ tx: incomeRow(kind), docs: bound('doc-new') })
      await call(h, { receiptDocumentId: 'doc-new', receiptExternalUrl: 'https://both' })
      expect(h.setPayloads[0]).toMatchObject({
        receiptDocumentId: 'doc-new',
        receiptExternalUrl: 'https://both',
      })
    })
  })

  describe('receipt bind guard (IDOR / HIGH-1) — runs BEFORE any transaction', () => {
    const base = () => incomeRow(kind, { receiptDocumentId: 'doc-old', receiptExternalUrl: null })

    it('missing document -> 404, no transaction opened', async () => {
      const h = makeHarness({ tx: base(), docs: {} })
      const err = await rejection(call(h, { receiptDocumentId: 'doc-ghost' }))
      expect(apiCode(err)).toEqual({ code: 'FINANCE_RECEIPT_DOCUMENT_NOT_FOUND', status: 404 })
      expect(h.transaction).not.toHaveBeenCalled()
      expect(h.events).toEqual(['read:tx', 'read:receiver', 'read:doc:doc-ghost'])
    })

    it('non-RECEIPT category -> 400', async () => {
      const h = makeHarness({
        tx: base(),
        docs: { 'doc-c': receiptDoc('doc-c', owner.id, { category: 'CONTRACT' }) },
      })
      const err = await rejection(call(h, { receiptDocumentId: 'doc-c' }))
      expect(apiCode(err)).toEqual({ code: 'FINANCE_RECEIPT_DOCUMENT_WRONG_CATEGORY', status: 400 })
      expect(h.transaction).not.toHaveBeenCalled()
    })

    it("someone else's RECEIPT document -> 403 (cross-owner binding refused), old doc untouched", async () => {
      const h = makeHarness({
        tx: base(),
        docs: { 'doc-x': receiptDoc('doc-x', 'victim-user') },
      })
      const err = await rejection(call(h, { receiptDocumentId: 'doc-x' }))
      expect(apiCode(err)).toEqual({ code: 'FINANCE_RECEIPT_DOCUMENT_NOT_OWNED', status: 403 })
      expect(h.transaction).not.toHaveBeenCalled()
      expect(h.deleteWheres).toEqual([])
      expect(h.deleteS3Keys).not.toHaveBeenCalled()
    })

    it('the bind lookup is keyed by the incoming doc id', async () => {
      const h = makeHarness({ tx: base(), docs: { 'doc-n': receiptDoc('doc-n', owner.id) } })
      await call(h, { receiptDocumentId: 'doc-n' })
      const q = compile((h.docsFindFirst.mock.calls[0]![0] as { where: unknown }).where)
      expect(q.params).toEqual(['doc-n'])
      expect(q.sql).toContain('"documents"."id" = $1')
    })

    it('re-sending the SAME doc id skips the bind check, old-doc lookup and delete', async () => {
      const h = makeHarness({ tx: base() })
      await call(h, { receiptDocumentId: 'doc-old' })
      expect(h.docsFindFirst).not.toHaveBeenCalled()
      expect(h.deleteWheres).toEqual([])
      expect(h.deleteS3Keys).not.toHaveBeenCalled()
      expect(h.setPayloads[0]).toMatchObject({ receiptDocumentId: 'doc-old' })
    })

    it('doc -> null (no new doc) does not run the bind check', async () => {
      const h = makeHarness({ tx: base(), docs: { 'doc-old': receiptDoc('doc-old', owner.id) } })
      await call(h, { receiptDocumentId: null })
      // only the old-doc S3 key read, never a bind read before BEGIN
      expect(h.events.indexOf('read:doc:doc-old')).toBeGreaterThan(
        h.events.indexOf('read:receiver'),
      )
      expect(h.docsFindFirst).toHaveBeenCalledTimes(1)
    })
  })

  describe('atomic replace order (STEP A in tx, STEP B post-commit)', () => {
    it('swap doc: bind -> old keys read -> BEGIN -> UPDATE -> DELETE old -> COMMIT -> S3 -> findOne', async () => {
      const h = makeHarness({
        tx: incomeRow(kind, { receiptDocumentId: 'doc-old', receiptExternalUrl: null }),
        docs: {
          'doc-new': receiptDoc('doc-new', owner.id),
          'doc-old': receiptDoc('doc-old', owner.id, { s3Key: 'k-old', thumbnailS3Key: 'k-thumb' }),
        },
      })
      await call(h, { receiptDocumentId: 'doc-new' })
      expect(h.events).toEqual([
        'read:tx',
        'read:receiver',
        'read:doc:doc-new',
        'read:doc:doc-old',
        'tx:begin',
        'tx:update',
        'tx:delete',
        'tx:commit',
        's3:delete',
        'facade:findOne',
      ])
      expect(h.deleteS3Keys).toHaveBeenCalledWith('k-old', 'k-thumb')
      expect(h.deleteS3Keys).toHaveBeenCalledTimes(1)
      expect(h.debug).toHaveBeenCalledWith(
        'receipt replace: old S3 key="k-old" scheduled for cleanup (post-commit)',
      )
    })

    it('UPDATE targets transactions, is guarded by deleted_at IS NULL and returns only id', async () => {
      const h = makeHarness({
        tx: incomeRow(kind, { receiptDocumentId: 'doc-old', receiptExternalUrl: null }),
        docs: { 'doc-old': receiptDoc('doc-old', owner.id) },
      })
      await call(h, { receiptExternalUrl: 'https://x.example/r' })
      expect(h.updateTables).toEqual([transactions])
      expect(h.updateWheres).toHaveLength(1)
      expect(h.updateWheres[0]!.params).toEqual(['tx-1'])
      expect(h.updateWheres[0]!.sql).toBe(
        '("transactions"."id" = $1 and "transactions"."deleted_at" is null)',
      )
      expect(h.returningCols).toEqual([{ id: transactions.id }])
    })

    it('DELETE targets documents row of the OLD doc id only', async () => {
      const h = makeHarness({
        tx: incomeRow(kind, { receiptDocumentId: 'doc-old', receiptExternalUrl: null }),
        docs: { 'doc-old': receiptDoc('doc-old', owner.id) },
      })
      await call(h, { receiptExternalUrl: 'https://x.example/r' })
      expect(h.deleteTables).toEqual([documents])
      expect(h.deleteWheres[0]!.sql).toBe('"documents"."id" = $1')
      expect(h.deleteWheres[0]!.params).toEqual(['doc-old'])
    })

    it('old-doc S3 keys are read by the old doc id', async () => {
      const h = makeHarness({
        tx: incomeRow(kind, { receiptDocumentId: 'doc-old', receiptExternalUrl: null }),
        docs: { 'doc-old': receiptDoc('doc-old', owner.id) },
      })
      await call(h, { receiptExternalUrl: 'https://x.example/r' })
      const q = compile((h.docsFindFirst.mock.calls[0]![0] as { where: unknown }).where)
      expect(q.params).toEqual(['doc-old'])
      expect(q.sql).toBe('"documents"."id" = $1')
    })

    it('missing thumbnail key is forwarded as null', async () => {
      const h = makeHarness({
        tx: incomeRow(kind, { receiptDocumentId: 'doc-old', receiptExternalUrl: null }),
        docs: { 'doc-old': receiptDoc('doc-old', owner.id, { thumbnailS3Key: undefined }) },
      })
      await call(h, { receiptExternalUrl: 'https://x.example/r' })
      expect(h.deleteS3Keys).toHaveBeenCalledWith('s3/doc-old', null)
    })

    it('old document row already gone: DB delete still runs, S3 cleanup skipped', async () => {
      const h = makeHarness({
        tx: incomeRow(kind, { receiptDocumentId: 'doc-old', receiptExternalUrl: null }),
        docs: {},
      })
      await call(h, { receiptExternalUrl: 'https://x.example/r' })
      expect(h.deleteWheres).toHaveLength(1)
      expect(h.deleteS3Keys).not.toHaveBeenCalled()
      expect(h.debug).not.toHaveBeenCalled()
    })

    it('no previous document: no old-key read, no delete, no S3 cleanup', async () => {
      const h = makeHarness({ tx: incomeRow(kind) })
      await call(h, { amount: 3 })
      expect(h.docsFindFirst).not.toHaveBeenCalled()
      expect(h.deleteWheres).toEqual([])
      expect(h.deleteS3Keys).not.toHaveBeenCalled()
      expect(h.events).toEqual([
        'read:tx',
        'read:receiver',
        'tx:begin',
        'tx:update',
        'tx:commit',
        'facade:findOne',
      ])
    })

    it('empty old s3Key -> no S3 cleanup call', async () => {
      const h = makeHarness({
        tx: incomeRow(kind, { receiptDocumentId: 'doc-old', receiptExternalUrl: null }),
        docs: { 'doc-old': receiptDoc('doc-old', owner.id, { s3Key: '' }) },
      })
      await call(h, { receiptExternalUrl: 'https://x.example/r' })
      expect(h.deleteS3Keys).not.toHaveBeenCalled()
    })

    it('row deleted in flight (0 rows updated): 400 restore-first, old receipt NOT deleted, no S3, no read-back', async () => {
      const h = makeHarness({
        tx: incomeRow(kind, { receiptDocumentId: 'doc-old', receiptExternalUrl: null }),
        docs: { 'doc-old': receiptDoc('doc-old', owner.id) },
        updatedRows: [],
      })
      const err = await rejection(call(h, { receiptExternalUrl: 'https://x.example/r' }))
      expect(apiCode(err)).toEqual({
        code: 'FINANCE_TRANSACTION_DELETED_RESTORE_FIRST',
        status: 400,
      })
      expect(h.deleteWheres).toEqual([])
      expect(h.deleteS3Keys).not.toHaveBeenCalled()
      expect(h.findOne).not.toHaveBeenCalled()
      expect(h.events).not.toContain('tx:commit')
    })
  })
})

// ───────────────────────────────────────────────────────────────────────────
// attachOrReplaceReceipt
// ───────────────────────────────────────────────────────────────────────────

describe('attachOrReplaceReceipt', () => {
  const AUTHOR = SENIOR
  function row(over: Record<string, unknown> = {}) {
    return {
      id: 'tx-1',
      type: 'SENIOR_INCOME',
      status: 'PENDING',
      createdBy: AUTHOR.id,
      currency: 'USD',
      receiptDocumentId: null,
      receiptExternalUrl: null,
      deletedAt: null,
      ...over,
    }
  }
  const attach = (h: Harness, data: Record<string, unknown>, who: SessionUser = AUTHOR) =>
    h.svc.attachOrReplaceReceipt('tx-1', data as never, who)

  describe('lookup + visibility', () => {
    it('absent -> 404 NOT_FOUND, WHERE id = $1', async () => {
      const h = makeHarness({ tx: undefined })
      const err = await rejection(attach(h, { receiptExternalUrl: 'https://a' }))
      expect(apiCode(err)).toEqual({ code: 'FINANCE_TRANSACTION_NOT_FOUND', status: 404 })
      const q = compile((h.txFindFirst.mock.calls[0]![0] as { where: unknown }).where)
      expect(q.params).toEqual(['tx-1'])
      expect(q.sql).toBe('"transactions"."id" = $1')
      expect(h.events).toEqual(['read:tx'])
    })

    it('deleted + non-privileged author -> 404 (existence hidden)', async () => {
      const h = makeHarness({ tx: row({ deletedAt: new Date() }) })
      const err = await rejection(attach(h, { receiptExternalUrl: 'https://a' }))
      expect(apiCode(err)).toEqual({ code: 'FINANCE_TRANSACTION_NOT_FOUND', status: 404 })
    })

    it.each([ADMIN, ACCOUNTANT])('deleted + $role -> 400 restore-first', async (who) => {
      const h = makeHarness({ tx: row({ deletedAt: new Date() }) })
      const err = await rejection(attach(h, { receiptExternalUrl: 'https://a' }, who))
      expect(apiCode(err)).toEqual({
        code: 'FINANCE_TRANSACTION_DELETED_RESTORE_FIRST',
        status: 400,
      })
      expect(h.transaction).not.toHaveBeenCalled()
    })
  })

  describe('RBAC', () => {
    it.each([ADMIN, ACCOUNTANT])('$role may attach to a tx they did not create', async (who) => {
      const h = makeHarness({ tx: row() })
      await attach(h, { receiptExternalUrl: 'https://a' }, who)
      expect(h.transaction).toHaveBeenCalledTimes(1)
    })

    it('the author may attach to their own tx', async () => {
      const h = makeHarness({ tx: row() })
      await attach(h, { receiptExternalUrl: 'https://a' })
      expect(h.transaction).toHaveBeenCalledTimes(1)
    })

    it.each([SENIOR, DROP, HR])(
      'non-author $role (non-privileged) -> 403 ATTACH_FORBIDDEN, nothing else read',
      async (who) => {
        const h = makeHarness({ tx: row({ createdBy: 'someone-else' }) })
        const err = await rejection(attach(h, { receiptExternalUrl: 'https://a' }, who))
        expect(apiCode(err)).toEqual({ code: 'FINANCE_RECEIPT_ATTACH_FORBIDDEN', status: 403 })
        expect(h.events).toEqual(['read:tx'])
        expect(h.onChain.resolveReceiptHashTransition).not.toHaveBeenCalled()
      },
    )

    it('author cannot REPLACE (doc) a PAID receipt -> 403 REPLACE_AFTER_PAID', async () => {
      const h = makeHarness({ tx: row({ status: 'PAID', receiptDocumentId: 'doc-old' }) })
      const err = await rejection(attach(h, { receiptExternalUrl: 'https://a' }))
      expect(apiCode(err)).toEqual({
        code: 'FINANCE_RECEIPT_REPLACE_AFTER_PAID_FORBIDDEN',
        status: 403,
      })
      expect(h.transaction).not.toHaveBeenCalled()
    })

    it('author cannot REPLACE (url) a PAID receipt -> 403 REPLACE_AFTER_PAID', async () => {
      const h = makeHarness({ tx: row({ status: 'PAID', receiptExternalUrl: 'https://old' }) })
      const err = await rejection(attach(h, { receiptExternalUrl: 'https://a' }))
      expect(apiCode(err)).toEqual({
        code: 'FINANCE_RECEIPT_REPLACE_AFTER_PAID_FORBIDDEN',
        status: 403,
      })
    })

    it.each([ADMIN, ACCOUNTANT])('$role may replace a PAID receipt', async (who) => {
      const h = makeHarness({ tx: row({ status: 'PAID', receiptExternalUrl: 'https://old' }) })
      await attach(h, { receiptExternalUrl: 'https://a' }, who)
      expect(h.transaction).toHaveBeenCalledTimes(1)
    })

    it('author may ATTACH (no prior receipt) on a PAID tx', async () => {
      const h = makeHarness({ tx: row({ status: 'PAID' }) })
      await attach(h, { receiptExternalUrl: 'https://a' })
      expect(h.transaction).toHaveBeenCalledTimes(1)
    })

    it('author may replace a non-PAID receipt', async () => {
      const h = makeHarness({ tx: row({ status: 'PENDING', receiptExternalUrl: 'https://old' }) })
      await attach(h, { receiptExternalUrl: 'https://a' })
      expect(h.transaction).toHaveBeenCalledTimes(1)
    })
  })

  describe('currency-aware validation (400 before any bind / claim / write)', () => {
    const cases: Array<[string, Record<string, unknown>, string, string]> = [
      ['neither doc nor url', {}, 'USD', 'RECEIPT_REQUIRED'],
      [
        'both doc and url',
        { receiptDocumentId: 'd', receiptExternalUrl: 'https://a' },
        'USD',
        'RECEIPT_BOTH_NOT_ALLOWED',
      ],
      ['USDT + file', { receiptDocumentId: 'd' }, 'USDT', 'RECEIPT_USDT_LINK_ONLY'],
      [
        'USDT + non-explorer url',
        { receiptExternalUrl: 'https://drive.example/x' },
        'USDT',
        'RECEIPT_USDT_LINK_REQUIRED',
      ],
    ]
    it.each(cases)('%s -> 400 %s', async (_n, data, currency, code) => {
      const h = makeHarness({ tx: row({ currency }) })
      const err = await rejection(attach(h, data))
      expect(err).toBeInstanceOf(BadRequestException)
      expect((err as BadRequestException).getResponse()).toMatchObject({
        statusCode: 400,
        code,
      })
      expect(h.docsFindFirst).not.toHaveBeenCalled()
      expect(h.onChain.resolveReceiptHashTransition).not.toHaveBeenCalled()
      expect(h.transaction).not.toHaveBeenCalled()
    })

    it('validates against the EXISTING tx currency (USDT explorer link accepted)', async () => {
      const h = makeHarness({ tx: row({ currency: 'USDT' }) })
      await attach(h, { receiptExternalUrl: EXPLORER_URL_A })
      expect(h.transaction).toHaveBeenCalledTimes(1)
    })

    it('non-USDT accepts a plain file', async () => {
      const h = makeHarness({
        tx: row({ currency: 'EUR' }),
        docs: { 'doc-n': receiptDoc('doc-n', AUTHOR.id) },
      })
      await attach(h, { receiptDocumentId: 'doc-n' })
      expect(h.transaction).toHaveBeenCalledTimes(1)
    })

    it('null-valued fields are treated as absent', async () => {
      const h = makeHarness({ tx: row() })
      const err = await rejection(attach(h, { receiptDocumentId: null, receiptExternalUrl: null }))
      expect((err as BadRequestException).getResponse()).toMatchObject({ code: 'RECEIPT_REQUIRED' })
    })
  })

  describe('receipt bind guard (IDOR) — the caller must own the new RECEIPT document', () => {
    it('missing doc -> 404 before claim resolution and before BEGIN', async () => {
      const h = makeHarness({ tx: row(), docs: {} })
      const err = await rejection(attach(h, { receiptDocumentId: 'doc-ghost' }))
      expect(apiCode(err)).toEqual({ code: 'FINANCE_RECEIPT_DOCUMENT_NOT_FOUND', status: 404 })
      expect(h.onChain.resolveReceiptHashTransition).not.toHaveBeenCalled()
      expect(h.transaction).not.toHaveBeenCalled()
    })

    it('wrong category -> 400', async () => {
      const h = makeHarness({
        tx: row(),
        docs: { 'doc-c': receiptDoc('doc-c', AUTHOR.id, { category: 'INVOICE' }) },
      })
      const err = await rejection(attach(h, { receiptDocumentId: 'doc-c' }))
      expect(apiCode(err)).toEqual({ code: 'FINANCE_RECEIPT_DOCUMENT_WRONG_CATEGORY', status: 400 })
    })

    it("someone else's doc -> 403, for the author", async () => {
      const h = makeHarness({ tx: row(), docs: { 'doc-x': receiptDoc('doc-x', 'victim') } })
      const err = await rejection(attach(h, { receiptDocumentId: 'doc-x' }))
      expect(apiCode(err)).toEqual({ code: 'FINANCE_RECEIPT_DOCUMENT_NOT_OWNED', status: 403 })
      expect(h.transaction).not.toHaveBeenCalled()
    })

    it.each([ADMIN, ACCOUNTANT])(
      'privileged $role still cannot bind a doc they do not own (ownership = caller)',
      async (who) => {
        const h = makeHarness({
          tx: row(),
          docs: { 'doc-x': receiptDoc('doc-x', AUTHOR.id) },
        })
        const err = await rejection(attach(h, { receiptDocumentId: 'doc-x' }, who))
        expect(apiCode(err)).toEqual({ code: 'FINANCE_RECEIPT_DOCUMENT_NOT_OWNED', status: 403 })
      },
    )

    it('privileged caller binding their OWN doc succeeds', async () => {
      const h = makeHarness({
        tx: row(),
        docs: { 'doc-a': receiptDoc('doc-a', ADMIN.id) },
      })
      await attach(h, { receiptDocumentId: 'doc-a' }, ADMIN)
      expect(h.transaction).toHaveBeenCalledTimes(1)
    })

    it('re-attaching the SAME doc id skips the bind lookup (and does not delete it)', async () => {
      const h = makeHarness({ tx: row({ receiptDocumentId: 'doc-same' }) })
      await attach(h, { receiptDocumentId: 'doc-same' })
      expect(h.docsFindFirst).not.toHaveBeenCalled()
      expect(h.deleteWheres).toEqual([])
      expect(h.deleteS3Keys).not.toHaveBeenCalled()
    })

    it('url-only attach never runs the bind check', async () => {
      const h = makeHarness({ tx: row() })
      await attach(h, { receiptExternalUrl: 'https://a' })
      expect(h.docsFindFirst).not.toHaveBeenCalled()
    })
  })

  describe('claim transition', () => {
    it('is resolved with (existing row, new url) AFTER bind and BEFORE the transaction opens', async () => {
      const existing = row()
      const h = makeHarness({ tx: existing, docs: {} })
      await attach(h, { receiptExternalUrl: 'https://a' })
      expect(h.onChain.resolveReceiptHashTransition).toHaveBeenCalledWith(existing, 'https://a')
      expect(h.events.indexOf('claim:resolve')).toBeLessThan(h.events.indexOf('tx:begin'))
    })

    it('for a doc attach the url argument is null', async () => {
      const existing = row()
      const h = makeHarness({
        tx: existing,
        docs: { 'doc-n': receiptDoc('doc-n', AUTHOR.id) },
      })
      await attach(h, { receiptDocumentId: 'doc-n' })
      expect(h.onChain.resolveReceiptHashTransition).toHaveBeenCalledWith(existing, null)
      expect(h.events.indexOf('read:doc:doc-n')).toBeLessThan(h.events.indexOf('claim:resolve'))
    })

    it('a hash already spent elsewhere (resolver throws) aborts: no BEGIN, no claim, no audit', async () => {
      const h = makeHarness({ tx: row() })
      h.onChain.resolveReceiptHashTransition.mockRejectedValueOnce(new Error('spent'))
      await expect(attach(h, { receiptExternalUrl: 'https://a' })).rejects.toThrow('spent')
      expect(h.transaction).not.toHaveBeenCalled()
      expect(consumeTxHashMock).not.toHaveBeenCalled()
    })
  })

  describe('write + audit (atomic)', () => {
    it('ATTACH to an empty row: exact SET, exact audit row, order, read-back via facade', async () => {
      const existing = row()
      const h = makeHarness({ tx: existing })
      const out = await attach(h, { receiptExternalUrl: 'https://a' })
      expect(out).toEqual({ readBack: true })
      expect(h.setPayloads).toEqual([
        { receiptDocumentId: null, receiptExternalUrl: 'https://a', updatedAt: FROZEN_NOW },
      ])
      expect(h.insertTables).toEqual([transactionAuditLog])
      expect(h.insertValues).toEqual([
        {
          actorId: AUTHOR.id,
          targetId: 'tx-1',
          action: 'ATTACH',
          metadata: {
            oldDocId: null,
            oldExtUrl: null,
            newDocId: null,
            newExtUrl: 'https://a',
            receiptKind: 'url',
          },
        },
      ])
      expect(h.events).toEqual([
        'read:tx',
        'claim:resolve',
        'tx:begin',
        'tx:update',
        'tx:audit-insert',
        'tx:commit',
        'facade:findOne',
      ])
      expect(h.findOne).toHaveBeenCalledWith('tx-1', AUTHOR)
      // does NOT touch status / amount / review fields (unlike the resubmit path)
      expect(Object.keys(h.setPayloads[0] as object).sort()).toEqual([
        'receiptDocumentId',
        'receiptExternalUrl',
        'updatedAt',
      ])
    })

    it('REPLACE (doc -> new doc): action REPLACE, audit carries old+new ids, old doc deleted then audit, S3 after commit', async () => {
      const h = makeHarness({
        tx: row({ receiptDocumentId: 'doc-old', receiptExternalUrl: null }),
        docs: {
          'doc-new': receiptDoc('doc-new', AUTHOR.id),
          'doc-old': receiptDoc('doc-old', AUTHOR.id, { s3Key: 'k-old', thumbnailS3Key: null }),
        },
      })
      await attach(h, { receiptDocumentId: 'doc-new' })
      expect(h.insertValues).toEqual([
        {
          actorId: AUTHOR.id,
          targetId: 'tx-1',
          action: 'REPLACE',
          metadata: {
            oldDocId: 'doc-old',
            oldExtUrl: null,
            newDocId: 'doc-new',
            newExtUrl: null,
            receiptKind: 'document',
          },
        },
      ])
      expect(h.setPayloads[0]).toEqual({
        receiptDocumentId: 'doc-new',
        receiptExternalUrl: null,
        updatedAt: FROZEN_NOW,
      })
      expect(h.events).toEqual([
        'read:tx',
        'read:doc:doc-new',
        'claim:resolve',
        'read:doc:doc-old',
        'tx:begin',
        'tx:update',
        'tx:delete',
        'tx:audit-insert',
        'tx:commit',
        's3:delete',
        'facade:findOne',
      ])
      expect(h.deleteWheres[0]!.params).toEqual(['doc-old'])
      expect(h.deleteS3Keys).toHaveBeenCalledWith('k-old', null)
    })

    it('REPLACE by an existing URL only (hadReceipt via url) -> action REPLACE', async () => {
      const h = makeHarness({ tx: row({ receiptExternalUrl: 'https://old' }) })
      await attach(h, { receiptExternalUrl: 'https://new' })
      expect((h.insertValues[0] as { action: string }).action).toBe('REPLACE')
      expect((h.insertValues[0] as { metadata: unknown }).metadata).toEqual({
        oldDocId: null,
        oldExtUrl: 'https://old',
        newDocId: null,
        newExtUrl: 'https://new',
        receiptKind: 'url',
      })
    })

    it('file replaced by a link deletes the old document (1:1 invariant)', async () => {
      const h = makeHarness({
        tx: row({ receiptDocumentId: 'doc-old' }),
        docs: { 'doc-old': receiptDoc('doc-old', AUTHOR.id) },
      })
      await attach(h, { receiptExternalUrl: 'https://new' })
      expect(h.deleteWheres[0]!.params).toEqual(['doc-old'])
      expect(h.deleteS3Keys).toHaveBeenCalledWith('s3/doc-old', 's3/doc-old.thumb')
    })

    it('audit actor is the IMPERSONATOR when impersonating, else the user', async () => {
      const imp = user('user-admin', 'ADMIN', { impersonatorId: 'real-admin' })
      const h = makeHarness({ tx: row() })
      await attach(h, { receiptExternalUrl: 'https://a' }, imp)
      expect((h.insertValues[0] as { actorId: string }).actorId).toBe('real-admin')
    })

    it('0 rows updated (deleted in flight) -> 400 restore-first; no audit, no claim, no read-back', async () => {
      const h = makeHarness({ tx: row(), updatedRows: [] })
      const err = await rejection(attach(h, { receiptExternalUrl: 'https://a' }))
      expect(apiCode(err)).toEqual({
        code: 'FINANCE_TRANSACTION_DELETED_RESTORE_FIRST',
        status: 400,
      })
      expect(h.insertValues).toEqual([])
      expect(consumeTxHashMock).not.toHaveBeenCalled()
      expect(h.findOne).not.toHaveBeenCalled()
    })
  })

  describe('on-chain hash claim inside the same transaction', () => {
    const HASH = `0x${'b'.repeat(64)}`

    it('txHashPatch is merged into the SET (before updatedAt)', async () => {
      const h = makeHarness({
        tx: row(),
        transition: { txHashPatch: { txHash: HASH }, claimHash: null, staleClaim: false },
      })
      await attach(h, { receiptExternalUrl: 'https://a' })
      expect(h.setPayloads[0]).toEqual({
        receiptDocumentId: null,
        receiptExternalUrl: 'https://a',
        txHash: HASH,
        updatedAt: FROZEN_NOW,
      })
    })

    it('claimHash -> consumeTxHash(dbtx, ADMIN_INCOME claim) BEFORE the audit insert', async () => {
      const h = makeHarness({
        tx: row(),
        transition: { txHashPatch: { txHash: HASH }, claimHash: HASH, staleClaim: false },
      })
      await attach(h, { receiptExternalUrl: 'https://a' })
      expect(consumeTxHashMock).toHaveBeenCalledTimes(1)
      expect(consumeTxHashMock).toHaveBeenCalledWith(h.dbtx, {
        txHash: HASH,
        purpose: 'ADMIN_INCOME',
        referenceId: 'tx-1',
        consumedByUserId: AUTHOR.id,
      })
      expect(h.onChain.recordReclaimAfterRelease).not.toHaveBeenCalled()
      expect(h.onChain.recordReceiptClaimDivergence).not.toHaveBeenCalled()
      expect(h.events).toEqual([
        'read:tx',
        'claim:resolve',
        'tx:begin',
        'tx:update',
        'claim:consume',
        'tx:audit-insert',
        'tx:commit',
        'facade:findOne',
      ])
    })

    it('consumedByUserId is the session user even when impersonated (actor field differs)', async () => {
      const imp = user('user-admin', 'ADMIN', { impersonatorId: 'real-admin' })
      const h = makeHarness({
        tx: row(),
        transition: { txHashPatch: {}, claimHash: HASH, staleClaim: false },
      })
      await attach(h, { receiptExternalUrl: 'https://a' }, imp)
      expect(consumeTxHashMock).toHaveBeenCalledWith(
        h.dbtx,
        expect.objectContaining({ consumedByUserId: 'user-admin' }),
      )
    })

    it('reclaimedAfterRelease -> recordReclaimAfterRelease(dbtx, ...) with the actor (impersonator-aware)', async () => {
      const imp = user('user-admin', 'ADMIN', { impersonatorId: 'real-admin' })
      const h = makeHarness({
        tx: row(),
        transition: { txHashPatch: {}, claimHash: HASH, staleClaim: false },
      })
      consumeTxHashMock.mockImplementationOnce(async () => {
        h.events.push('claim:consume')
        return { claimed: true, reclaimedAfterRelease: true }
      })
      await attach(h, { receiptExternalUrl: 'https://a' }, imp)
      expect(h.onChain.recordReclaimAfterRelease).toHaveBeenCalledWith(h.dbtx, {
        path: 'attachOrReplaceReceipt',
        txHash: HASH,
        referenceId: 'tx-1',
        actorId: 'real-admin',
      })
      expect(h.events.indexOf('claim:consume')).toBeLessThan(
        h.events.indexOf('claim:record-reclaim'),
      )
      expect(h.events.indexOf('claim:record-reclaim')).toBeLessThan(
        h.events.indexOf('tx:audit-insert'),
      )
    })

    it('reclaim actor falls back to the user id without impersonation', async () => {
      const h = makeHarness({
        tx: row(),
        transition: { txHashPatch: {}, claimHash: HASH, staleClaim: false },
      })
      consumeTxHashMock.mockResolvedValueOnce({ claimed: true, reclaimedAfterRelease: true })
      await attach(h, { receiptExternalUrl: 'https://a' })
      expect(h.onChain.recordReclaimAfterRelease).toHaveBeenCalledWith(
        h.dbtx,
        expect.objectContaining({ actorId: AUTHOR.id }),
      )
    })

    it('staleClaim -> recordReceiptClaimDivergence(dbtx, ...) (no claim); order consume < divergence < audit', async () => {
      const h = makeHarness({
        tx: row(),
        transition: { txHashPatch: {}, claimHash: null, staleClaim: true },
      })
      await attach(h, { receiptExternalUrl: 'https://a' })
      expect(consumeTxHashMock).not.toHaveBeenCalled()
      expect(h.onChain.recordReceiptClaimDivergence).toHaveBeenCalledWith(h.dbtx, {
        path: 'attachOrReplaceReceipt',
        transactionId: 'tx-1',
        actorId: AUTHOR.id,
      })
      expect(h.events).toEqual([
        'read:tx',
        'claim:resolve',
        'tx:begin',
        'tx:update',
        'claim:record-divergence',
        'tx:audit-insert',
        'tx:commit',
        'facade:findOne',
      ])
    })

    it('divergence actor is the impersonator when present', async () => {
      const imp = user('user-admin', 'ADMIN', { impersonatorId: 'real-admin' })
      const h = makeHarness({
        tx: row(),
        transition: { txHashPatch: {}, claimHash: null, staleClaim: true },
      })
      await attach(h, { receiptExternalUrl: 'https://a' }, imp)
      expect(h.onChain.recordReceiptClaimDivergence).toHaveBeenCalledWith(
        h.dbtx,
        expect.objectContaining({ actorId: 'real-admin' }),
      )
    })

    it('claim + stale together: consume, (reclaim), divergence, audit in that order', async () => {
      const h = makeHarness({
        tx: row(),
        transition: { txHashPatch: {}, claimHash: HASH, staleClaim: true },
      })
      consumeTxHashMock.mockImplementationOnce(async () => {
        h.events.push('claim:consume')
        return { claimed: true, reclaimedAfterRelease: true }
      })
      await attach(h, { receiptExternalUrl: 'https://a' })
      expect(h.events.slice(h.events.indexOf('tx:update'), h.events.indexOf('tx:commit'))).toEqual([
        'tx:update',
        'claim:consume',
        'claim:record-reclaim',
        'claim:record-divergence',
        'tx:audit-insert',
      ])
    })

    it('no transition work -> no claim calls at all', async () => {
      const h = makeHarness({ tx: row() })
      await attach(h, { receiptExternalUrl: 'https://a' })
      expect(consumeTxHashMock).not.toHaveBeenCalled()
      expect(h.onChain.recordReclaimAfterRelease).not.toHaveBeenCalled()
      expect(h.onChain.recordReceiptClaimDivergence).not.toHaveBeenCalled()
    })
  })

  describe('claim-collision mapping', () => {
    function violation(constraint: string) {
      return Object.assign(new Error('duplicate key'), { code: '23505', constraint })
    }
    const transition = { txHashPatch: {}, claimHash: `0x${'c'.repeat(64)}`, staleClaim: false }

    it.each(['uq_consumed_tx_hashes_active_tx_hash', 'uq_consumed_tx_hashes_tx_hash'])(
      'registry unique violation (%s) -> 400 TX_HASH_ALREADY_CONSUMED',
      async (constraint) => {
        const h = makeHarness({ tx: row(), transition })
        consumeTxHashMock.mockRejectedValueOnce(violation(constraint))
        const err = await rejection(attach(h, { receiptExternalUrl: 'https://a' }))
        expect(apiCode(err)).toEqual({ code: 'FINANCE_TX_HASH_ALREADY_CONSUMED', status: 400 })
        expect(h.findOne).not.toHaveBeenCalled()
      },
    )

    it('a drizzle-wrapped registry violation (cause chain) is also mapped', async () => {
      const h = makeHarness({ tx: row(), transition })
      consumeTxHashMock.mockRejectedValueOnce(
        Object.assign(new Error('wrapped'), {
          cause: violation('uq_consumed_tx_hashes_active_tx_hash'),
        }),
      )
      const err = await rejection(attach(h, { receiptExternalUrl: 'https://a' }))
      expect(apiCode(err)).toEqual({ code: 'FINANCE_TX_HASH_ALREADY_CONSUMED', status: 400 })
    })

    it('an UNRELATED unique violation is rethrown untouched (not blamed on the hash)', async () => {
      const h = makeHarness({ tx: row(), transition })
      const other = violation('uq_transactions_receipt_document_id')
      consumeTxHashMock.mockRejectedValueOnce(other)
      expect(await rejection(attach(h, { receiptExternalUrl: 'https://a' }))).toBe(other)
    })

    it('a non-DB error is rethrown untouched', async () => {
      const h = makeHarness({ tx: row(), transition })
      const boom = new Error('boom')
      consumeTxHashMock.mockRejectedValueOnce(boom)
      expect(await rejection(attach(h, { receiptExternalUrl: 'https://a' }))).toBe(boom)
    })

    it('after a collision the S3 object is NOT deleted (swap rolled back)', async () => {
      const h = makeHarness({
        tx: row({ receiptDocumentId: 'doc-old' }),
        docs: { 'doc-old': receiptDoc('doc-old', AUTHOR.id) },
        transition,
      })
      consumeTxHashMock.mockRejectedValueOnce(violation('uq_consumed_tx_hashes_active_tx_hash'))
      await rejection(attach(h, { receiptExternalUrl: 'https://a' }))
      expect(h.deleteS3Keys).not.toHaveBeenCalled()
      expect(h.events).not.toContain('tx:commit')
    })
  })
})
