/**
 * task-drop-company-debt-and-invoices / task-settle-in-place (ADR 2026-07-14).
 * Unit tests for `PendingSettlementService`.
 *
 * Coverage:
 *   - listSeniorObligations / listCompanyObligations RBAC (DROP cannot list
 *     company obligations).
 *   - settleByCompany: closes COMPANY-debt obligation by FLIPPING the source IOU
 *     row IN PLACE (SENIOR_PENDING_PAYOUT → SENIOR_INCOME, status → PAID) +
 *     triggers invoice auto-create. NO second transaction is inserted (the
 *     phantom bug fixed by ADR 2026-07-14).
 *   - settleByCompany RBAC: ADMIN/ACCOUNTANT only; DROP → 403, SENIOR → 403.
 *   - settleByDrop / listDropObligations removed — no tests for them.
 *   - Edge: already-settled obligation → 400; non-existent obligation → 404.
 */
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common'
import { describe, expect, it, vi } from 'vitest'
import type { SessionUser } from '@crm/shared'
import { pendingObligations, transactions } from '../database/schema'
import { PendingSettlementService } from './pending-settlement.service'
import type { InvoicesService } from '../invoices/invoices.service'
import type { NbuCurrencyService } from './nbu-currency.service'

// ── Fixtures ────────────────────────────────────────────────────────────────

const SENIOR_ID = '11111111-1111-4111-8111-111111111111'
const DROP_ID = '22222222-2222-4222-8222-222222222222'
const OBLIGATION_COMPANY = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const SOURCE_TX_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const PROJECT_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'

const dropUser: SessionUser = {
  id: DROP_ID,
  role: 'DROP',
  displayName: 'Drop',
  email: 'd@x.com',
  avatarUrl: null,
  avatarDocumentId: null,
  seniorSharePercent: 26,
}
const seniorUser: SessionUser = {
  id: SENIOR_ID,
  role: 'SENIOR',
  displayName: 'Senior',
  email: 's@x.com',
  avatarUrl: null,
  avatarDocumentId: null,
  seniorSharePercent: 26,
}
const accountantUser: SessionUser = {
  id: 'acc-1',
  role: 'ACCOUNTANT',
  displayName: 'Accountant',
  email: 'a@x.com',
  avatarUrl: null,
  avatarDocumentId: null,
  seniorSharePercent: 26,
}
const adminUser: SessionUser = {
  id: 'adm-1',
  role: 'ADMIN',
  displayName: 'Admin',
  email: 'ad@x.com',
  avatarUrl: null,
  avatarDocumentId: null,
  seniorSharePercent: 26,
}
const juniorUser: SessionUser = {
  id: 'jun-1',
  role: 'JUNIOR',
  displayName: 'Junior',
  email: 'j@x.com',
  avatarUrl: null,
  avatarDocumentId: null,
  seniorSharePercent: 26,
}

function makeObligation(overrides: Record<string, unknown> = {}) {
  return {
    id: OBLIGATION_COMPANY,
    creditorUserId: SENIOR_ID,
    debtorType: 'COMPANY' as const,
    debtorUserId: null as string | null,
    sourceTransactionId: SOURCE_TX_ID,
    closingTransactionId: null as string | null,
    amount: '560',
    currency: 'USDT' as const,
    status: 'PENDING' as const,
    createdAt: new Date('2026-05-30T12:00:00Z'),
    updatedAt: new Date('2026-05-30T12:00:00Z'),
    ...overrides,
  }
}

function makeSourceTx(overrides: Record<string, unknown> = {}) {
  return {
    id: SOURCE_TX_ID,
    type: 'SENIOR_PENDING_PAYOUT' as const,
    projectId: PROJECT_ID,
    amount: '560',
    currency: 'USDT' as const,
    senderId: null,
    receiverId: SENIOR_ID,
    recipientId: SENIOR_ID,
    senderLabel: 'COMPANY',
    receiverLabel: null,
    status: 'PENDING_PAYMENT' as const,
    // A cascade-sourced IOU carries a payoutRequestId; the flip MUST reset it.
    payoutRequestId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    // Booking stamps the share snapshot on the IOU (amount is ALREADY the net
    // share). The flip MUST null these so getSeniorBalance does not re-apply the
    // percentage to an already-net SENIOR_INCOME (money-critical).
    seniorSharePercent: 26,
    seniorSharePercentSource: 'PROJECT',
    dropSharePercent: null,
    dropSharePercentSource: null,
    fundingSource: null,
    txHash: null,
    validatedBy: null,
    validatedAt: null,
    rejectionReason: null,
    notes: 'Company owes — senior IOU (debtor=COMPANY)',
    salaryMonth: null,
    txDate: null,
    receiptDocumentId: null,
    receiptExternalUrl: null,
    invoiceDocumentId: null,
    createdBy: 'system',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }
}

function makeProject() {
  return { id: PROJECT_ID, name: 'Drop Project' }
}

function makeSeniorRow() {
  return { id: SENIOR_ID, displayName: 'Senior', role: 'SENIOR' }
}

function makeDropRow() {
  return { id: DROP_ID, displayName: 'Drop', role: 'DROP' }
}

// task-senior-settle-owner: admin partners resolvable by id, so an
// ADMIN_PERSONAL settlement can validate the payer is an ADMIN and stamp
// senderId/senderLabel from the row.
const ADMIN_PAYER_ID = 'adm-1'
const ADMIN_PAYER_2_ID = '99999999-9999-4999-8999-999999999999'
function makeAdminRows(): Array<{ id: string; displayName: string; role: string }> {
  return [
    { id: ADMIN_PAYER_ID, displayName: 'Admin', role: 'ADMIN' },
    { id: ADMIN_PAYER_2_ID, displayName: 'Kostya', role: 'ADMIN' },
  ]
}

interface MockState {
  obligations: Map<string, ReturnType<typeof makeObligation>>
  sourceTxs: Map<string, ReturnType<typeof makeSourceTx>>
  project: ReturnType<typeof makeProject> | null
  senior: ReturnType<typeof makeSeniorRow> | null
  drop: ReturnType<typeof makeDropRow> | null
  /** Admin partners resolvable by id (ADMIN_PERSONAL payer validation). */
  admins: Array<{ id: string; displayName: string; role: string }>
  /** task-settle-in-place: settle no longer INSERTs; kept to prove length 0. */
  inserts: Array<{ table: unknown; row: Record<string, unknown> }>
  updates: Array<{ table: unknown; set: Record<string, unknown>; obligationId: string }>
  /**
   * task-settle-in-place: each in-place FLIP of a source IOU transaction
   * (UPDATE transactions … WHERE id=sourceTx AND status='PENDING_PAYMENT'). The
   * money write is now a flip, not an insert — assertions read these.
   */
  flips: Array<{ txId: string; set: Record<string, unknown> }>
  invoiceCalls: string[]
  /** Company-account ledger balance the settleByCompany gate re-reads. */
  companyBalance?: number
  /** Counts ledger select() calls so the mock attributes balance to term 1. */
  ledgerSelectCount?: number
}

function makeService(initial: Partial<MockState> = {}) {
  const state: MockState = {
    obligations: new Map([[OBLIGATION_COMPANY, makeObligation()]]),
    sourceTxs: new Map([[SOURCE_TX_ID, makeSourceTx()]]),
    project: makeProject(),
    senior: makeSeniorRow(),
    drop: makeDropRow(),
    admins: makeAdminRows(),
    inserts: [],
    updates: [],
    flips: [],
    invoiceCalls: [],
    ...initial,
  }

  // Depth 12 (was 6): drizzle's `and(eq(id), eq(status,'PENDING'))` nests the
  // inner column literals deeper than a bare `eq(id)` — the conditional UPDATE
  // added by the MED TOCTOU fix (PR #262) needs both the obligation id AND the
  // literal 'PENDING' to surface so the mock can model the status-guarded flip.
  // `usedTables` is skipped (drizzle leaks raw table names that would pollute the
  // `state.obligations.has(...)` / list-filter `includes(...)` lookups).
  const collectStringValues = (obj: unknown, acc: string[] = [], depth = 0): string[] => {
    if (acc.length > 120 || depth > 12 || obj === null || obj === undefined) return acc
    if (typeof obj === 'string') {
      acc.push(obj)
      return acc
    }
    if (typeof obj !== 'object') return acc
    if (Array.isArray(obj)) {
      for (const item of obj) collectStringValues(item, acc, depth + 1)
      return acc
    }
    for (const [key, val] of Object.entries(obj as Record<string, unknown>)) {
      if (key === 'table' || key === 'schema' || key === 'enumValues' || key === 'usedTables')
        continue
      collectStringValues(val, acc, depth + 1)
    }
    return acc
  }

  let lastUpdateObligationId = ''

  const mkDbtx = () => ({
    // task-drop-payout-company-account: settleByCompany on a COMPANY debt now
    // (1) acquires the company-account advisory lock (pg_advisory_xact_lock via
    // dbtx.execute) and (2) re-reads the ledger balance via select().from().where().
    // The mock returns a large balance so the gate passes; `companyBalance` in
    // overrides lets a test drive the insufficient-funds branch.
    execute: vi.fn(async () => undefined),
    select: () => ({
      from: () => ({
        // computeCompanyAccountBalanceFromLedger sums N ledger terms (one select
        // per term, run in a fixed order via Promise.all). The FIRST term is
        // COMPANY_DEPOSIT (a +credit); attribute the whole balance to it and 0
        // to every other term so the derived balance equals exactly
        // `companyBalance` (default 1_000_000 → gate passes).
        where: async () => {
          const count = state.ledgerSelectCount ?? 0
          state.ledgerSelectCount = count + 1
          const total = count === 0 ? String(state.companyBalance ?? 1_000_000) : '0'
          return [{ total }]
        },
      }),
    }),
    update: (table: unknown) => ({
      set: (patch: Record<string, unknown>) => {
        // task-settle-in-place (ADR 2026-07-14): the settle money-write is now an
        // in-place FLIP of the source IOU transaction — `UPDATE transactions SET
        // type=…, status='PAID', … WHERE id=sourceTx AND status='PENDING_PAYMENT'`
        // `.returning()`. We model it against `state.sourceTxs`: apply + return the
        // flipped row ONLY when the source is still PENDING_PAYMENT; else return []
        // (the defense-in-depth guard matched zero rows).
        const applyTransactionFlip = (predicate: unknown): Array<Record<string, unknown>> => {
          const values = collectStringValues(predicate)
          const txId = values.find((v) => state.sourceTxs.has(v))
          const existing = txId ? state.sourceTxs.get(txId) : undefined
          const isStatusGuarded = values.includes('PENDING_PAYMENT')
          if (!existing) return []
          if (isStatusGuarded && existing.status !== 'PENDING_PAYMENT') return []
          const flipped = { ...existing, ...patch } as ReturnType<typeof makeSourceTx>
          state.sourceTxs.set(txId!, flipped)
          state.flips.push({ txId: txId!, set: patch })
          return [flipped]
        }

        // task-drop-payout-company-account (MED TOCTOU fix, PR #262): the
        // pending_obligations PENDING→PAID flip is a CONDITIONAL UPDATE —
        // `.where(and(eq(id), eq(status,'PENDING'))).returning(…)`. We model both
        // obligation shapes:
        //   1) Status-guarded flip — predicate contains the literal 'PENDING'.
        //      Apply + return [{id}] ONLY when the row is still PENDING; else [].
        //   2) Plain backfill (closingTransactionId) — predicate has only the id.
        const applyObligationUpdate = (predicate: unknown): Array<{ id: string }> => {
          const values = collectStringValues(predicate)
          const oblId = values.find((v) => state.obligations.has(v)) ?? lastUpdateObligationId
          lastUpdateObligationId = oblId
          const isStatusGuarded = values.includes('PENDING') && !values.includes('PENDING_PAYMENT')
          const existing = state.obligations.get(oblId)
          if (isStatusGuarded && existing && existing.status !== 'PENDING') {
            // Conditional UPDATE matched zero rows — already settled/cancelled.
            return []
          }
          state.updates.push({ table, set: patch, obligationId: oblId })
          if (existing) {
            state.obligations.set(oblId, {
              ...existing,
              ...patch,
            } as ReturnType<typeof makeObligation>)
            return [{ id: oblId }]
          }
          return []
        }

        const where = (predicate: unknown) => {
          // Route by target table: the source-IOU flip vs the obligation writes.
          if (table === transactions) {
            const rows = applyTransactionFlip(predicate)
            const result = Promise.resolve(rows) as Promise<Array<Record<string, unknown>>> & {
              returning: (..._args: unknown[]) => Promise<Array<Record<string, unknown>>>
            }
            result.returning = async () => rows
            return result
          }
          const rows = applyObligationUpdate(predicate)
          // Awaitable (plain `.where(...)` backfill) AND chainable with
          // `.returning(...)` (conditional status flip).
          const result = Promise.resolve(rows) as Promise<Array<{ id: string }>> & {
            returning: (..._args: unknown[]) => Promise<Array<{ id: string }>>
          }
          result.returning = async () => rows
          return result
        }
        return { where }
      },
    }),
    // task-settle-in-place: settle no longer inserts a transaction. The insert
    // hook is retained (harmless) so `getInsertsFor(transactions)` can assert 0.
    insert: (table: unknown) => ({
      values: (row: Record<string, unknown>) => {
        const id = `inserted-${state.inserts.length + 1}`
        state.inserts.push({ table, row: { ...row, id } })
        const returning = async () => [{ id, ...row, type: row['type'] }]
        return { returning } as unknown as Promise<unknown[]> & { returning: typeof returning }
      },
    }),
  })

  const drizzleClient = {
    transaction: async (cb: (tx: unknown) => Promise<unknown>) => {
      const dbtx = mkDbtx()
      return cb(dbtx)
    },
    query: {
      pendingObligations: {
        findFirst: vi.fn(async (args: unknown) => {
          const values = collectStringValues(args)
          // 2) task-senior-settle-in-tx-row: source-transaction lookup, checked
          //    FIRST when the predicate is the source-tx form. The
          //    by-source-transaction settle resolves the PENDING obligation via
          //    `and(eq(sourceTransactionId, txId), eq(status, 'PENDING'))` — the
          //    predicate carries the source tx id + the literal 'PENDING' but NOT
          //    the obligation id, so we must NOT fall through to the obligation-id
          //    branch (whose `lastUpdateObligationId` fallback would wrongly
          //    resolve an already-settled row). Match on sourceTransactionId,
          //    scoped to PENDING; if nothing matches return undefined → the
          //    service raises 404 (no open debt for this tx).
          const hasSourceTxPredicate = Array.from(state.obligations.values()).some((r) =>
            values.includes(r.sourceTransactionId),
          )
          if (hasSourceTxPredicate && values.includes('PENDING')) {
            return (
              Array.from(state.obligations.values()).find(
                (r) => r.status === 'PENDING' && values.includes(r.sourceTransactionId),
              ) ?? undefined
            )
          }
          // 1) Direct obligation-id lookup (loadObligation + the refreshed read
          //    inside settleByCompany).
          const obl = values.find((v) => state.obligations.has(v)) ?? lastUpdateObligationId
          if (obl && state.obligations.has(obl)) return state.obligations.get(obl)
          return undefined
        }),
        findMany: vi.fn(async (args: unknown) => {
          const values = collectStringValues(args)
          let rows = Array.from(state.obligations.values())
          rows = rows.filter((r) => r.status === 'PENDING')
          if (values.includes(SENIOR_ID)) {
            rows = rows.filter((r) => r.creditorUserId === SENIOR_ID)
          }
          if (values.includes('TOV')) {
            rows = rows.filter((r) => r.debtorType === 'TOV')
          } else if (values.includes('COMPANY') && !values.includes('DROP')) {
            // listCompanyObligations passes only debtorType='COMPANY'
            rows = rows.filter((r) => r.debtorType === 'COMPANY')
          } else if (values.includes('COMPANY') && values.includes('DROP')) {
            // listSeniorObligations passes inArray(['COMPANY','DROP'])
            rows = rows.filter((r) => r.debtorType === 'COMPANY' || r.debtorType === 'DROP')
          }
          return rows
        }),
      },
      transactions: {
        findFirst: vi.fn(async (args: unknown) => {
          const values = collectStringValues(args)
          for (const v of values) {
            if (state.sourceTxs.has(v)) return state.sourceTxs.get(v)
          }
          return undefined
        }),
        findMany: vi.fn(async () => [] as unknown[]),
      },
      projects: {
        findFirst: vi.fn(async () => state.project ?? undefined),
      },
      users: {
        findFirst: vi.fn(async (args: unknown) => {
          const values = collectStringValues(args)
          if (values.includes(SENIOR_ID)) return state.senior ?? undefined
          if (values.includes(DROP_ID)) return state.drop ?? undefined
          // task-senior-settle-owner: ADMIN_PERSONAL payer lookup by id.
          const admin = state.admins.find((a) => values.includes(a.id))
          if (admin) return admin
          return undefined
        }),
      },
    },
  }
  const dbStub = { db: drizzleClient } as unknown

  // Mock InvoicesService — only `autoCreateForSeniorPayout` is called.
  const invoicesMock = {
    autoCreateForSeniorPayout: vi.fn(async (transactionId: string) => {
      state.invoiceCalls.push(transactionId)
    }),
  } as unknown as InvoicesService

  // task-drop-payout-currency: PendingSettlementService now takes an
  // NbuCurrencyService. Every obligation in this file settles via a
  // SENIOR_PENDING_PAYOUT source row (isDropObligation stays false — see
  // makeSourceTx's default `type`), so `getRates` is never reached — DROP's
  // currency-conversion coverage lives in pending-settlement.drop-currency.spec.ts.
  const nbuMock = { getRates: vi.fn() } as unknown as NbuCurrencyService

  const svc = new PendingSettlementService(dbStub as never, invoicesMock, nbuMock)
  return {
    svc,
    state,
    invoicesMock,
    getInsertsFor: (table: unknown) =>
      state.inserts.filter((i) => i.table === table).map((i) => i.row),
    getUpdatesFor: (table: unknown) =>
      state.updates.filter((u) => u.table === table).map((u) => u.set),
    // task-settle-in-place: the settled row is the FLIPPED source IOU (merged
    // original IOU fields + the flip patch). Assertions read the final row so
    // fields carried over from booking (receiverId/amount) are visible too.
    settledTx: (txId: string = SOURCE_TX_ID) => state.sourceTxs.get(txId),
    getFlips: () => state.flips.map((f) => f.set),
  }
}

// ── settleByCompany ─────────────────────────────────────────────────────────

describe('PendingSettlementService.settleByCompany', () => {
  it('closes COMPANY obligation by flipping the source IOU to SENIOR_INCOME in place (no second tx)', async () => {
    const { svc, getInsertsFor, getUpdatesFor, getFlips, settledTx, state } = makeService()
    const result = await svc.settleByCompany(OBLIGATION_COMPANY, accountantUser)

    // task-settle-in-place: NO second transaction is inserted — the money write
    // is an in-place flip of the source IOU row.
    expect(getInsertsFor(transactions)).toHaveLength(0)

    // Exactly ONE flip of the source IOU: SENIOR_PENDING_PAYOUT → SENIOR_INCOME,
    // status → PAID, carrying the COMPANY_ACCOUNT funding marker.
    const flips = getFlips()
    expect(flips).toHaveLength(1)
    expect(flips[0]?.['type']).toBe('SENIOR_INCOME')
    expect(flips[0]?.['status']).toBe('PAID')
    expect(flips[0]?.['fundingSource']).toBe('COMPANY_ACCOUNT')
    // payoutRequestId is reset on the flip (ADR — avoid payout-aggregation bleed).
    expect(flips[0]?.['payoutRequestId']).toBeNull()
    // task-drop-payout-currency: a SENIOR settle NEVER enters the DROP-only
    // amount-conversion block — the flip patch must carry none of its keys at
    // all (not even as `undefined`-valued — the block's whole
    // `...(isDropObligation ? {...} : {})` spread must contribute nothing).
    expect('originalAmount' in flips[0]!).toBe(false)
    expect('originalCurrency' in flips[0]!).toBe(false)
    expect('exchangeRate' in flips[0]!).toBe(false)
    // The pre-existing `amount` column is left completely untouched too —
    // same invariant, the mirror of the DROP-side assertion elsewhere.
    expect('amount' in flips[0]!).toBe(false)
    // MONEY-CRITICAL: the share snapshot is nulled so getSeniorBalance treats the
    // flipped SENIOR_INCOME amount as NET (already the share), not GROSS. Keeping
    // seniorSharePercent=26 would under-count the senior by ~26× (NET × 26%).
    expect(flips[0]?.['seniorSharePercent']).toBeNull()
    expect(flips[0]?.['seniorSharePercentSource']).toBeNull()
    expect(flips[0]?.['dropSharePercent']).toBeNull()
    expect(flips[0]?.['dropSharePercentSource']).toBeNull()
    // The final flipped row reflects the null share snapshot too.
    expect(settledTx()!['seniorSharePercent']).toBeNull()

    // The FINAL flipped row: type+status changed in place; receiver/amount kept.
    const settled = settledTx()!
    expect(settled['type']).toBe('SENIOR_INCOME')
    expect(settled['status']).toBe('PAID')
    expect(settled['senderLabel']).toBe('COMPANY')
    expect(settled['receiverId']).toBe(SENIOR_ID)
    expect(settled['amount']).toBe('560')

    // Two obligation writes — (1) the atomic conditional flip to status=PAID (the
    // money gate), then (2) the closingTransactionId backfill pointing at the
    // SAME (self) source tx now that it is the settled row.
    const oblUpdates = getUpdatesFor(pendingObligations)
    expect(oblUpdates).toHaveLength(2)
    expect(oblUpdates[0]?.['status']).toBe('PAID')
    expect(oblUpdates[1]?.['closingTransactionId']).toBe(SOURCE_TX_ID)

    expect(result.obligation.status).toBe('PAID')
    expect(result.created).toHaveLength(1)
    expect(result.created[0]?.type).toBe('SENIOR_INCOME')
    expect(state.obligations.get(OBLIGATION_COMPANY)?.status).toBe('PAID')
  })

  it('triggers invoice auto-create on the flipped SENIOR_INCOME row (self id)', async () => {
    const { svc, state } = makeService()
    await svc.settleByCompany(OBLIGATION_COMPANY, accountantUser)
    expect(state.invoiceCalls).toHaveLength(1)
    // The invoice fires on the flipped row — which reuses the source IOU id.
    expect(state.invoiceCalls[0]).toBe(SOURCE_TX_ID)
  })

  it('ADMIN may settle', async () => {
    const { svc, getFlips, getInsertsFor } = makeService()
    await svc.settleByCompany(OBLIGATION_COMPANY, adminUser)
    expect(getFlips()).toHaveLength(1)
    expect(getInsertsFor(transactions)).toHaveLength(0)
  })

  // ── MONEY-PATH idempotency: end-to-end double-settle (MED, PR #262) ────────
  // The user-facing guarantee: a double-clicked / repeated settle of ONE
  // obligation pays the senior EXACTLY ONCE. The SEQUENTIAL second call is caught
  // by the out-of-transaction status read (a partial mitigation that already
  // existed), so this test alone is NOT the TOCTOU proof — see the next test for
  // the concurrent-window negative control that the OLD unconditional UPDATE
  // failed. This test pins the observable invariant: one flip, one PAID
  // obligation flip, second call → BadRequest. It must never regress.
  it('repeated settle of one obligation pays the senior exactly once (idempotent)', async () => {
    const { svc, getInsertsFor, getUpdatesFor, getFlips, state } = makeService()

    // First settle succeeds: one flip, one PAID obligation flip.
    await svc.settleByCompany(OBLIGATION_COMPANY, accountantUser)

    // Second settle of the SAME obligation must be rejected (already closed) and
    // must NOT flip a second time or debit the company again.
    await expect(svc.settleByCompany(OBLIGATION_COMPANY, accountantUser)).rejects.toThrow(
      BadRequestException,
    )

    // EXACTLY ONE source-IOU flip total, and NO inserted second row.
    expect(getInsertsFor(transactions)).toHaveLength(0)
    const seniorIncomeFlips = getFlips().filter((f) => f['type'] === 'SENIOR_INCOME')
    expect(seniorIncomeFlips).toHaveLength(1)
    expect(seniorIncomeFlips[0]?.['fundingSource']).toBe('COMPANY_ACCOUNT')

    // EXACTLY ONE status→PAID flip was recorded (the winning conditional UPDATE).
    const paidFlips = getUpdatesFor(pendingObligations).filter((u) => u['status'] === 'PAID')
    expect(paidFlips).toHaveLength(1)
    expect(state.obligations.get(OBLIGATION_COMPANY)?.status).toBe('PAID')
  })

  // ── TOCTOU negative control (THE bug from PR #262 security-review) ─────────
  // Proves the IN-TRANSACTION conditional UPDATE — not just the out-of-txn read —
  // is the money authority. We simulate the concurrent TOCTOU window: the
  // obligation is read as PENDING by loadObligation (out-of-txn gate passes), but
  // a concurrent winner flips it to PAID before the conditional UPDATE runs. The
  // conditional `UPDATE ... WHERE status='PENDING'` then matches zero rows →
  // BadRequest, and the whole transaction aborts: NO source-IOU flip, NO
  // company-account debit.
  it('conditional UPDATE matching zero rows aborts the settle with no money write', async () => {
    const { svc, getFlips, getInsertsFor, state } = makeService()

    // loadObligation reads via query.pendingObligations.findFirst (mocked off
    // `state`). Wrap it so the FIRST read (the out-of-txn gate) returns a PENDING
    // snapshot, then flip the stored row to PAID — modelling a concurrent settle
    // landing in the TOCTOU window just before our conditional UPDATE executes.
    type ObligationRow = ReturnType<typeof makeObligation>
    const query = (
      svc as unknown as {
        db: {
          db: { query: { pendingObligations: { findFirst: (a: unknown) => Promise<unknown> } } }
        }
      }
    ).db.db.query.pendingObligations
    const baseFindFirst = query.findFirst
    const pendingSnapshot: ObligationRow = makeObligation({ status: 'PENDING' })
    let gateRead = true
    query.findFirst = async (args: unknown) => {
      if (gateRead) {
        gateRead = false
        // A concurrent winner closes the obligation right after our gate read.
        state.obligations.set(OBLIGATION_COMPANY, makeObligation({ status: 'PAID' }))
        return pendingSnapshot
      }
      return baseFindFirst(args)
    }

    await expect(svc.settleByCompany(OBLIGATION_COMPANY, accountantUser)).rejects.toThrow(
      BadRequestException,
    )
    // Transaction aborted: no flip and no insert → no double payout.
    expect(getFlips()).toHaveLength(0)
    expect(getInsertsFor(transactions)).toHaveLength(0)
  })

  // ── Defense-in-depth negative control (review round 1, code-review MED) ────
  // Distinct from the TOCTOU test above: THERE the obligation-level claim itself
  // loses (pending_obligations UPDATE matches zero rows). HERE the obligation
  // claim WINS (obligation.status is genuinely 'PENDING') but the SOURCE IOU row
  // is somehow not 'PENDING_PAYMENT' anymore — a corrupted invariant (e.g. the
  // source tx was mutated out of band). The flip's own
  // `WHERE id=sourceTx AND status='PENDING_PAYMENT'` guard (pending-settlement
  // .service.ts, the `if (!paidRow)` branch right after the UPDATE) must catch
  // this independently and abort — a backstop beyond the obligation-level claim,
  // proven here directly (not just inferred from the obligation-claim test).
  it('defense-in-depth: source IOU not in PENDING_PAYMENT at flip time aborts the settle (corrupted invariant)', async () => {
    const { svc, getFlips, getInsertsFor, getUpdatesFor } = makeService({
      // The obligation is genuinely PENDING (the claim WILL win) …
      sourceTxs: new Map([
        // … but its source IOU row is already 'PAID' — as if some out-of-band
        // process flipped it without going through settleByCompany.
        [SOURCE_TX_ID, makeSourceTx({ status: 'PAID', type: 'SENIOR_INCOME' })],
      ]),
    })

    await expect(svc.settleByCompany(OBLIGATION_COMPANY, accountantUser)).rejects.toThrow(
      BadRequestException,
    )
    // The flip's own status-guarded UPDATE matched zero rows → no flip recorded,
    // no second transaction inserted.
    expect(getFlips()).toHaveLength(0)
    expect(getInsertsFor(transactions)).toHaveLength(0)
    // The obligation-level claim DID win (this test's whole point — it is a
    // DIFFERENT guard catching it), but the mock has no real transactional
    // ROLLBACK semantics; the real-DB proof that the obligation claim is undone
    // together with the failed flip lives in the companion integration test
    // (usdt-income-obligations.integration.spec.ts).
    const paidClaims = getUpdatesFor(pendingObligations).filter((u) => u['status'] === 'PAID')
    expect(paidClaims).toHaveLength(1)
  })

  it('rejects when company balance is insufficient for the obligation', async () => {
    // task-drop-payout-company-account: the company-account debit gate refuses to
    // drive the balance negative. Obligation is 560; balance only 100.
    const { svc, getFlips } = makeService({ companyBalance: 100 })
    await expect(svc.settleByCompany(OBLIGATION_COMPANY, accountantUser)).rejects.toThrow(
      BadRequestException,
    )
    // Nothing flipped when the gate fails.
    expect(getFlips()).toHaveLength(0)
  })

  it('DROP forbidden → 403', async () => {
    const { svc } = makeService()
    await expect(svc.settleByCompany(OBLIGATION_COMPANY, dropUser)).rejects.toThrow(
      ForbiddenException,
    )
  })

  it('SENIOR forbidden → 403', async () => {
    const { svc } = makeService()
    await expect(svc.settleByCompany(OBLIGATION_COMPANY, seniorUser)).rejects.toThrow(
      ForbiddenException,
    )
  })

  it('JUNIOR forbidden → 403', async () => {
    const { svc } = makeService()
    await expect(svc.settleByCompany(OBLIGATION_COMPANY, juniorUser)).rejects.toThrow(
      ForbiddenException,
    )
  })

  it('legacy DROP-debt can also be closed by company (admin clean-up)', async () => {
    const { svc, getFlips, getInsertsFor } = makeService({
      obligations: new Map([
        [OBLIGATION_COMPANY, makeObligation({ debtorType: 'DROP', debtorUserId: DROP_ID })],
      ]),
    })
    await svc.settleByCompany(OBLIGATION_COMPANY, adminUser)
    // Legacy DROP-debt source is a SENIOR_PENDING_PAYOUT → flips to SENIOR_INCOME
    // in place, still no second row.
    expect(getFlips()).toHaveLength(1)
    expect(getInsertsFor(transactions)).toHaveLength(0)
  })

  it('TOV obligation rejected → 400', async () => {
    const { svc } = makeService({
      obligations: new Map([
        [OBLIGATION_COMPANY, makeObligation({ debtorType: 'TOV', debtorUserId: null })],
      ]),
    })
    await expect(svc.settleByCompany(OBLIGATION_COMPANY, accountantUser)).rejects.toThrow(
      BadRequestException,
    )
  })

  it('already-PAID obligation → 400', async () => {
    const { svc } = makeService({
      obligations: new Map([[OBLIGATION_COMPANY, makeObligation({ status: 'PAID' })]]),
    })
    await expect(svc.settleByCompany(OBLIGATION_COMPANY, accountantUser)).rejects.toThrow(
      BadRequestException,
    )
  })

  it('obligation not found → 404', async () => {
    const { svc } = makeService({ obligations: new Map() })
    await expect(svc.settleByCompany(OBLIGATION_COMPANY, accountantUser)).rejects.toThrow(
      NotFoundException,
    )
  })
})

// ── settleByCompanySourceTransaction (task-senior-settle-in-tx-row) ──────────
// The finance-page transactions list pays the senior directly from the
// SENIOR_PENDING_PAYOUT row, which knows the SOURCE transaction id (not the
// obligation id). This wrapper resolves the PENDING obligation by
// sourceTransactionId and delegates to the audited settleByCompany. It must
// inherit settleByCompany's money invariants verbatim (single payout, RBAC,
// idempotency) and add NO new money path.
describe('PendingSettlementService.settleByCompanySourceTransaction', () => {
  it('resolves the obligation by source tx id and flips it in place (one SENIOR_INCOME, no second tx)', async () => {
    const { svc, getInsertsFor, getUpdatesFor, getFlips, settledTx, state } = makeService()
    const result = await svc.settleByCompanySourceTransaction(SOURCE_TX_ID, accountantUser)

    expect(getInsertsFor(transactions)).toHaveLength(0)
    const flips = getFlips()
    expect(flips).toHaveLength(1)
    expect(flips[0]?.['type']).toBe('SENIOR_INCOME')
    expect(flips[0]?.['status']).toBe('PAID')
    // Same company-account debit marker as the obligation-id path.
    expect(flips[0]?.['fundingSource']).toBe('COMPANY_ACCOUNT')
    expect(settledTx()!['receiverId']).toBe(SENIOR_ID)
    expect(settledTx()!['amount']).toBe('560')

    const paidFlips = getUpdatesFor(pendingObligations).filter((u) => u['status'] === 'PAID')
    expect(paidFlips).toHaveLength(1)
    expect(result.obligation.status).toBe('PAID')
    expect(result.created[0]?.type).toBe('SENIOR_INCOME')
    expect(state.obligations.get(OBLIGATION_COMPANY)?.status).toBe('PAID')
  })

  it('triggers invoice auto-create on the resulting SENIOR_INCOME row (self id)', async () => {
    const { svc, state } = makeService()
    await svc.settleByCompanySourceTransaction(SOURCE_TX_ID, accountantUser)
    expect(state.invoiceCalls).toHaveLength(1)
    expect(state.invoiceCalls[0]).toBe(SOURCE_TX_ID)
  })

  it('ADMIN may settle by source tx', async () => {
    const { svc, getFlips } = makeService()
    await svc.settleByCompanySourceTransaction(SOURCE_TX_ID, adminUser)
    expect(getFlips()).toHaveLength(1)
  })

  // MONEY-PATH: a double-clicked «Выплатить» on one SENIOR_PENDING_PAYOUT row
  // pays the senior EXACTLY ONCE. The second call finds NO PENDING obligation
  // for that source tx (the first flipped it to PAID) → 404, no second payout.
  it('repeated settle of one source tx pays the senior exactly once', async () => {
    const { svc, getInsertsFor, getFlips } = makeService()
    await svc.settleByCompanySourceTransaction(SOURCE_TX_ID, accountantUser)
    await expect(
      svc.settleByCompanySourceTransaction(SOURCE_TX_ID, accountantUser),
    ).rejects.toThrow(NotFoundException)

    expect(getInsertsFor(transactions)).toHaveLength(0)
    const seniorIncomeFlips = getFlips().filter((f) => f['type'] === 'SENIOR_INCOME')
    expect(seniorIncomeFlips).toHaveLength(1)
  })

  it('rejects when company balance is insufficient (no money booked)', async () => {
    const { svc, getFlips } = makeService({ companyBalance: 100 })
    await expect(
      svc.settleByCompanySourceTransaction(SOURCE_TX_ID, accountantUser),
    ).rejects.toThrow(BadRequestException)
    expect(getFlips()).toHaveLength(0)
  })

  it('SENIOR forbidden → 403 (and no enumeration: gate before lookup)', async () => {
    const { svc, getFlips } = makeService()
    await expect(svc.settleByCompanySourceTransaction(SOURCE_TX_ID, seniorUser)).rejects.toThrow(
      ForbiddenException,
    )
    expect(getFlips()).toHaveLength(0)
  })

  it('DROP forbidden → 403', async () => {
    const { svc } = makeService()
    await expect(svc.settleByCompanySourceTransaction(SOURCE_TX_ID, dropUser)).rejects.toThrow(
      ForbiddenException,
    )
  })

  it('JUNIOR forbidden → 403', async () => {
    const { svc } = makeService()
    await expect(svc.settleByCompanySourceTransaction(SOURCE_TX_ID, juniorUser)).rejects.toThrow(
      ForbiddenException,
    )
  })

  it('no open obligation for the source tx → 404', async () => {
    // Obligation already PAID → the PENDING-scoped lookup finds nothing.
    const { svc, getFlips } = makeService({
      obligations: new Map([[OBLIGATION_COMPANY, makeObligation({ status: 'PAID' })]]),
    })
    await expect(
      svc.settleByCompanySourceTransaction(SOURCE_TX_ID, accountantUser),
    ).rejects.toThrow(NotFoundException)
    expect(getFlips()).toHaveLength(0)
  })

  it('unknown source tx id → 404', async () => {
    const { svc } = makeService()
    await expect(
      svc.settleByCompanySourceTransaction('ffffffff-ffff-4fff-8fff-ffffffffffff', accountantUser),
    ).rejects.toThrow(NotFoundException)
  })
})

// ── settle with owner / funding selection (task-senior-settle-owner) ─────────
// The senior IOU is now paid via the SAME funding selection as a SALARY: the
// ADMIN/ACCOUNTANT chooses COMPANY_ACCOUNT (default — debits the shared account,
// USDT) or ADMIN_PERSONAL (paid by a chosen admin partner; the company account
// is NOT touched). Proven on BOTH settle entry points (obligation-id +
// source-transaction-id) so neither path drifts. task-settle-in-place: the
// funding fields are now stamped onto the FLIPPED source IOU row, not a new row.
describe('settle senior IOU — funding selection (COMPANY_ACCOUNT | ADMIN_PERSONAL)', () => {
  // task-receipts-backend: settle now requires proof; COMPANY_ACCOUNT → USDT →
  // explorer link.
  const COMPANY_FUNDING = {
    fundingSource: 'COMPANY_ACCOUNT' as const,
    currency: 'USDT' as const,
    receiptExternalUrl: 'https://etherscan.io/tx/0xabc123',
  }
  // BIZ-03 fix: ADMIN_PERSONAL currency must match obligation.currency (USDT).
  // Using USD here would trigger the new currency-guard → BadRequestException.
  const ADMIN_FUNDING = {
    fundingSource: 'ADMIN_PERSONAL' as const,
    payerAdminId: ADMIN_PAYER_2_ID,
    currency: 'USDT' as const,
    // task-receipts-backend: settle proof (USDT → explorer link).
    receiptExternalUrl: 'https://etherscan.io/tx/0xabc123',
  }

  // ── COMPANY_ACCOUNT (explicit) ──────────────────────────────────────────────
  it('COMPANY_ACCOUNT (source tx) → flips IOU to SENIOR_INCOME debiting company (fundingSource=COMPANY_ACCOUNT, USDT, no sender)', async () => {
    const { svc, getInsertsFor, settledTx } = makeService()
    await svc.settleByCompanySourceTransaction(SOURCE_TX_ID, accountantUser, COMPANY_FUNDING)

    expect(getInsertsFor(transactions)).toHaveLength(0)
    const row = settledTx()!
    expect(row['type']).toBe('SENIOR_INCOME')
    expect(row['fundingSource']).toBe('COMPANY_ACCOUNT')
    expect(row['currency']).toBe('USDT')
    expect(row['senderId']).toBeNull()
    expect(row['senderLabel']).toBe('COMPANY')
    expect(row['receiverId']).toBe(SENIOR_ID)
  })

  it('COMPANY_ACCOUNT rejects when company balance is insufficient (no money booked)', async () => {
    const { svc, getFlips } = makeService({ companyBalance: 100 })
    await expect(
      svc.settleByCompanySourceTransaction(SOURCE_TX_ID, accountantUser, COMPANY_FUNDING),
    ).rejects.toThrow(BadRequestException)
    expect(getFlips()).toHaveLength(0)
  })

  // ── ADMIN_PERSONAL ──────────────────────────────────────────────────────────
  it('ADMIN_PERSONAL (source tx) → flips IOU to SENIOR_INCOME senderId=payer, no company marker, chosen currency', async () => {
    const { svc, getInsertsFor, settledTx } = makeService()
    await svc.settleByCompanySourceTransaction(SOURCE_TX_ID, accountantUser, ADMIN_FUNDING)

    expect(getInsertsFor(transactions)).toHaveLength(0)
    const row = settledTx()!
    expect(row['type']).toBe('SENIOR_INCOME')
    // No company-account debit marker → the shared balance must not move.
    expect(row['fundingSource']).toBeNull()
    // Sender = the paying admin partner; currency follows the choice.
    expect(row['senderId']).toBe(ADMIN_PAYER_2_ID)
    expect(row['senderLabel']).toBe('Kostya')
    // BIZ-03 fix: ADMIN_FUNDING.currency is now USDT (matches obligation.currency).
    expect(row['currency']).toBe('USDT')
    expect(row['receiverId']).toBe(SENIOR_ID)
  })

  it('ADMIN_PERSONAL does NOT gate the company balance (settles even with empty company account)', async () => {
    // Company balance is 0, but an ADMIN_PERSONAL payout never touches it → success.
    const { svc, settledTx } = makeService({ companyBalance: 0 })
    await svc.settleByCompanySourceTransaction(SOURCE_TX_ID, accountantUser, ADMIN_FUNDING)
    const row = settledTx()!
    expect(row['fundingSource']).toBeNull()
    expect(row['senderId']).toBe(ADMIN_PAYER_2_ID)
  })

  it('ADMIN_PERSONAL with a non-ADMIN payerAdminId → 400 (and no money booked)', async () => {
    const { svc, getFlips } = makeService()
    await expect(
      svc.settleByCompanySourceTransaction(SOURCE_TX_ID, accountantUser, {
        fundingSource: 'ADMIN_PERSONAL',
        payerAdminId: SENIOR_ID, // a SENIOR, not an ADMIN
        currency: 'USD',
      }),
    ).rejects.toThrow(BadRequestException)
    expect(getFlips()).toHaveLength(0)
  })

  it('ADMIN_PERSONAL defaults payerAdminId to the calling ADMIN when omitted', async () => {
    const { svc, settledTx } = makeService()
    // BIZ-03 fix: currency must match obligation.currency (USDT). EUR would throw.
    await svc.settleByCompanySourceTransaction(SOURCE_TX_ID, adminUser, {
      fundingSource: 'ADMIN_PERSONAL',
      currency: 'USDT',
      receiptExternalUrl: 'https://etherscan.io/tx/0xabc123',
    })
    const row = settledTx()!
    // adminUser.id === ADMIN_PAYER_ID; resolves to an ADMIN → sender = caller.
    expect(row['senderId']).toBe(ADMIN_PAYER_ID)
    expect(row['currency']).toBe('USDT')
    expect(row['fundingSource']).toBeNull()
  })

  // ── task-remove-settle-currency: `currency` omitted → defaults to the ────────
  // obligation's own currency (always USDT). The settle dialog no longer sends
  // this field at all — proves the DEFAULT path (as opposed to the tests above,
  // which all pass an explicit currency through the still-supported safety net).
  it('ADMIN_PERSONAL with NO currency in the payload → defaults to obligation.currency (USDT)', async () => {
    const { svc, settledTx } = makeService()
    await svc.settleByCompanySourceTransaction(SOURCE_TX_ID, accountantUser, {
      fundingSource: 'ADMIN_PERSONAL',
      payerAdminId: ADMIN_PAYER_2_ID,
      receiptExternalUrl: 'https://etherscan.io/tx/0xabc123',
    })
    const row = settledTx()!
    expect(row['currency']).toBe('USDT')
    expect(row['senderId']).toBe(ADMIN_PAYER_2_ID)
    expect(row['fundingSource']).toBeNull()
  })

  it('COMPANY_ACCOUNT with NO currency in the payload → still USDT (forced regardless of default)', async () => {
    const { svc, settledTx } = makeService()
    await svc.settleByCompanySourceTransaction(SOURCE_TX_ID, accountantUser, {
      fundingSource: 'COMPANY_ACCOUNT',
      receiptExternalUrl: 'https://etherscan.io/tx/0xabc123',
    })
    const row = settledTx()!
    expect(row['currency']).toBe('USDT')
    expect(row['fundingSource']).toBe('COMPANY_ACCOUNT')
  })

  // ── idempotency under funding selection ─────────────────────────────────────
  it('repeated ADMIN_PERSONAL settle of one source tx pays the senior exactly once', async () => {
    const { svc, getInsertsFor, getFlips } = makeService()
    await svc.settleByCompanySourceTransaction(SOURCE_TX_ID, accountantUser, ADMIN_FUNDING)
    await expect(
      svc.settleByCompanySourceTransaction(SOURCE_TX_ID, accountantUser, ADMIN_FUNDING),
    ).rejects.toThrow(NotFoundException)
    expect(getInsertsFor(transactions)).toHaveLength(0)
    const seniorIncomeFlips = getFlips().filter((f) => f['type'] === 'SENIOR_INCOME')
    expect(seniorIncomeFlips).toHaveLength(1)
  })

  // ── RBAC (gate runs before funding is consulted) ────────────────────────────
  it('SENIOR forbidden even with ADMIN_PERSONAL funding → 403', async () => {
    const { svc, getFlips } = makeService()
    await expect(
      svc.settleByCompanySourceTransaction(SOURCE_TX_ID, seniorUser, ADMIN_FUNDING),
    ).rejects.toThrow(ForbiddenException)
    expect(getFlips()).toHaveLength(0)
  })

  it('DROP forbidden even with COMPANY_ACCOUNT funding → 403', async () => {
    const { svc } = makeService()
    await expect(
      svc.settleByCompanySourceTransaction(SOURCE_TX_ID, dropUser, COMPANY_FUNDING),
    ).rejects.toThrow(ForbiddenException)
  })

  // ── obligation-id entry point honours the same funding selection ────────────
  it('settleByCompany (obligation id) with ADMIN_PERSONAL → senderId=payer, no company marker', async () => {
    const { svc, settledTx } = makeService()
    await svc.settleByCompany(OBLIGATION_COMPANY, accountantUser, ADMIN_FUNDING)
    const row = settledTx()!
    expect(row['senderId']).toBe(ADMIN_PAYER_2_ID)
    expect(row['fundingSource']).toBeNull()
    // BIZ-03 fix: ADMIN_FUNDING.currency is now USDT (matches obligation.currency).
    expect(row['currency']).toBe('USDT')
  })

  it('settleByCompany (obligation id) with no funding arg keeps legacy COMPANY_ACCOUNT behaviour', async () => {
    const { svc, settledTx } = makeService()
    await svc.settleByCompany(OBLIGATION_COMPANY, accountantUser)
    const row = settledTx()!
    expect(row['fundingSource']).toBe('COMPANY_ACCOUNT')
    expect(row['senderId']).toBeNull()
  })
})

// ── list endpoints RBAC ─────────────────────────────────────────────────────

describe('PendingSettlementService.listSeniorObligations', () => {
  it('SENIOR sees only own obligations', async () => {
    const { svc } = makeService()
    const result = await svc.listSeniorObligations(seniorUser)
    expect(result).toHaveLength(1)
    expect(result[0]?.seniorId).toBe(SENIOR_ID)
    expect(result[0]?.debtorType).toBe('COMPANY')
  })

  it('ACCOUNTANT sees all senior obligations', async () => {
    const { svc } = makeService()
    const result = await svc.listSeniorObligations(accountantUser)
    expect(result).toHaveLength(1)
  })

  it('ADMIN sees all', async () => {
    const { svc } = makeService()
    const result = await svc.listSeniorObligations(adminUser)
    expect(result).toHaveLength(1)
  })

  it('DROP forbidden → 403', async () => {
    const { svc } = makeService()
    await expect(svc.listSeniorObligations(dropUser)).rejects.toThrow(ForbiddenException)
  })

  it('JUNIOR forbidden → 403', async () => {
    const { svc } = makeService()
    await expect(svc.listSeniorObligations(juniorUser)).rejects.toThrow(ForbiddenException)
  })
})

describe('PendingSettlementService.listCompanyObligations', () => {
  it('ADMIN sees pending COMPANY debts', async () => {
    const { svc } = makeService()
    const result = await svc.listCompanyObligations(adminUser)
    expect(result).toHaveLength(1)
    expect(result[0]?.debtorType).toBe('COMPANY')
  })

  it('ACCOUNTANT sees pending COMPANY debts', async () => {
    const { svc } = makeService()
    const result = await svc.listCompanyObligations(accountantUser)
    expect(result).toHaveLength(1)
  })

  it('DROP forbidden → 403', async () => {
    const { svc } = makeService()
    await expect(svc.listCompanyObligations(dropUser)).rejects.toThrow(ForbiddenException)
  })

  it('SENIOR forbidden → 403', async () => {
    const { svc } = makeService()
    await expect(svc.listCompanyObligations(seniorUser)).rejects.toThrow(ForbiddenException)
  })

  it('JUNIOR forbidden → 403', async () => {
    const { svc } = makeService()
    await expect(svc.listCompanyObligations(juniorUser)).rejects.toThrow(ForbiddenException)
  })
})
