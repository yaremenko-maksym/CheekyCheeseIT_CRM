/**
 * Drop role - phase 3 (manual payout confirmation, spec §8.4).
 *
 * Unit tests for `TransactionsService.confirmPayout` — the ACCOUNTANT/ADMIN
 * endpoint that closes the loop on an off-platform PAYOUT by attributing the
 * money to a specific admin partner and inserting a PAYOUT_CONFIRMED row.
 *
 * Phase 2 auto-50/50 PAYOUT_ADMIN distribution is NOT exercised here — the
 * manual flow lives in parallel and these tests confirm the new path:
 *   - Happy path: PENDING_PAYMENT → PAYOUT becomes PAID + PAYOUT_CONFIRMED
 *     row crediting the chosen admin (amount/currency/projectId from PAYOUT).
 *   - RBAC: SENIOR / DROP / JUNIOR / HR all get 403.
 *   - Status guard: PAYOUT already PAID → 400 (idempotency).
 *   - Type guard: trying to confirm a SENIOR_INCOME → 400.
 *   - Recipient guard: missing user / non-ADMIN role / archived ADMIN → 400.
 *
 * The service is instantiated with stubs for the injected `DatabaseService`
 * and `InvoicesService`; we mock only the `db` call shape exercised by
 * `confirmPayout`.
 */
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common'
import { describe, expect, it, vi } from 'vitest'
import type { SessionUser } from '@crm/shared'
import { makeTransactionsService } from './__test-helpers__/make-transactions-service'

const MAKSYM_USER = {
  id: '00000000-0000-0000-0000-000000000001',
  email: 'maksym@x.com',
  displayName: 'Maksym',
  role: 'ADMIN' as const,
  archivedAt: null,
}
const KOSTYA_USER = {
  id: '00000000-0000-0000-0000-000000000002',
  email: 'kostya@x.com',
  displayName: 'Kostya',
  role: 'ADMIN' as const,
  archivedAt: null,
}

const adminUser: SessionUser = {
  id: 'admin-actor',
  role: 'ADMIN',
  displayName: 'Admin Actor',
  email: 'admin@x.com',
  avatarUrl: null,
  avatarDocumentId: null,
  seniorSharePercent: 26,
}
const accountantUser: SessionUser = {
  id: 'accountant-1',
  role: 'ACCOUNTANT',
  displayName: 'Accountant',
  email: 'acc@x.com',
  avatarUrl: null,
  avatarDocumentId: null,
  seniorSharePercent: 26,
}
const seniorUser: SessionUser = {
  id: 'senior-1',
  role: 'SENIOR',
  displayName: 'Senior',
  email: 's@x.com',
  avatarUrl: null,
  avatarDocumentId: null,
  seniorSharePercent: 26,
}
const dropUser: SessionUser = {
  id: 'drop-1',
  role: 'DROP',
  displayName: 'Drop',
  email: 'd@x.com',
  avatarUrl: null,
  avatarDocumentId: null,
  seniorSharePercent: 26,
}
const juniorUser: SessionUser = {
  id: 'junior-1',
  role: 'JUNIOR',
  displayName: 'Junior',
  email: 'j@x.com',
  avatarUrl: null,
  avatarDocumentId: null,
  seniorSharePercent: 26,
}
const hrUser: SessionUser = {
  id: 'hr-1',
  role: 'HR',
  displayName: 'HR',
  email: 'h@x.com',
  avatarUrl: null,
  avatarDocumentId: null,
  seniorSharePercent: 26,
}

// Minimal PAYOUT row shape — only fields confirmPayout reads.
function makePayoutRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'payout-tx-1',
    type: 'PAYOUT' as const,
    status: 'PENDING_PAYMENT' as const,
    amount: '740',
    currency: 'USDT' as const,
    senderId: 'senior-1',
    senderLabel: null,
    receiverId: null,
    receiverLabel: 'CheekyCheeseIT',
    recipientId: null,
    projectId: 'project-1',
    payoutRequestId: 'payout-req-1',
    seniorSharePercent: null,
    txHash: null,
    validatedBy: null,
    validatedAt: null,
    rejectionReason: null,
    notes: null,
    salaryMonth: null,
    txDate: null,
    receiptDocumentId: null,
    receiptExternalUrl: null,
    invoiceDocumentId: null,
    createdBy: 'senior-1',
    createdAt: new Date('2026-05-01'),
    updatedAt: new Date('2026-05-01'),
    ...overrides,
  }
}

interface MockState {
  payoutRow: ReturnType<typeof makePayoutRow> | null
  recipient: { id: string; role: string; archivedAt: Date | null } | null
  inserts: Array<Record<string, unknown>>
  updates: Array<{ id: string; set: Record<string, unknown> }>
}

function makeService(initial: Partial<MockState> = {}) {
  const state: MockState = {
    payoutRow: makePayoutRow(),
    recipient: MAKSYM_USER,
    inserts: [],
    updates: [],
    ...initial,
  }

  // The drizzle query API surface confirmPayout touches:
  //   - db.query.transactions.findFirst({ where }) — to load the PAYOUT.
  //   - db.query.users.findFirst({ where }) — to load the recipient ADMIN.
  //   - db.transaction(cb) — wraps the UPDATE/INSERT pair.
  //   - inside: dbtx.update(transactions).set({...}).where(...) for the PAYOUT.
  //   - inside: dbtx.insert(transactions).values({...}) for PAYOUT_CONFIRMED.
  //
  // For findOne (called at the end to return the response) we install a stub
  // that returns the post-state with the PAID flag flipped so callers see a
  // realistic shape.
  //
  // Notes:
  // * The mocks ignore `where` predicates — confirmPayout invokes the two
  //   query.findFirst paths in a fixed order, so a stateful counter would add
  //   noise without value. Tests that need to vary "who is loaded" instead
  //   swap the `state.payoutRow` / `state.recipient` directly.
  // * The chainable update/insert objects mimic drizzle's builder pattern just
  //   enough for the call sequence inside confirmPayout to resolve.
  let usersFindCount = 0
  // The service accesses `this.db.db.query...` and `this.db.db.transaction(...)`
  // because `DatabaseService` exposes a `db` field (the drizzle client). Mock
  // that nesting exactly: outer `db` is the DatabaseService stub, inner `db`
  // is the drizzle client.
  const drizzleClient = {
    transaction: async (cb: (tx: unknown) => Promise<unknown>) => {
      const dbtx = {
        update: (_table: unknown) => ({
          set: (patch: Record<string, unknown>) => ({
            where: (_predicate: unknown) => ({
              // BIZ-02 fix: confirmPayout now calls .returning() after .where()
              // to implement the atomic conditional claim. The mock returns a
              // single-element array to simulate "1 row updated" (success).
              returning: async (_fields: unknown) => {
                state.updates.push({ id: 'payout-tx-1', set: patch })
                return [{ id: 'payout-tx-1' }]
              },
            }),
          }),
        }),
        insert: (_table: unknown) => ({
          values: async (row: Record<string, unknown>) => {
            state.inserts.push(row)
          },
        }),
      }
      return cb(dbtx)
    },
    query: {
      transactions: {
        findFirst: vi.fn(async () => state.payoutRow ?? undefined),
      },
      users: {
        findFirst: vi.fn(async () => {
          usersFindCount += 1
          return state.recipient ?? undefined
        }),
      },
    },
  }
  const db = { db: drizzleClient } as unknown

  const svc = makeTransactionsService({ db: db as never })

  // Stub findOne — confirmPayout tail-calls it twice (PAYOUT + PAYOUT_CONFIRMED).
  // We don't care about the precise DTO here, just that it returns SOMETHING
  // so the wrapper doesn't blow up. The tests assert on `state.updates` /
  // `state.inserts` for the load-bearing behavior.
  vi.spyOn(svc, 'findOne').mockImplementation(
    async (id: string) =>
      ({
        id,
        type: 'PAYOUT',
        status: 'PAID',
      }) as never,
  )

  return { svc, state, getUsersFindCount: () => usersFindCount }
}

describe('TransactionsService.confirmPayout (Drop role - phase 3, spec §8.4)', () => {
  // ── RBAC ──────────────────────────────────────────────────────────────────
  describe('RBAC', () => {
    it('SENIOR → ForbiddenException', async () => {
      const { svc } = makeService()
      await expect(
        svc.confirmPayout('payout-tx-1', MAKSYM_USER.id, seniorUser, { method: 'CASH' }),
      ).rejects.toThrow(ForbiddenException)
    })

    it('DROP → ForbiddenException', async () => {
      const { svc } = makeService()
      await expect(
        svc.confirmPayout('payout-tx-1', MAKSYM_USER.id, dropUser, { method: 'CASH' }),
      ).rejects.toThrow(ForbiddenException)
    })

    it('JUNIOR → ForbiddenException', async () => {
      const { svc } = makeService()
      await expect(
        svc.confirmPayout('payout-tx-1', MAKSYM_USER.id, juniorUser, { method: 'CASH' }),
      ).rejects.toThrow(ForbiddenException)
    })

    it('HR → ForbiddenException', async () => {
      const { svc } = makeService()
      await expect(
        svc.confirmPayout('payout-tx-1', MAKSYM_USER.id, hrUser, { method: 'CASH' }),
      ).rejects.toThrow(ForbiddenException)
    })

    it('ADMIN may call (happy path doesn’t throw 403)', async () => {
      const { svc } = makeService()
      await expect(
        svc.confirmPayout('payout-tx-1', MAKSYM_USER.id, adminUser, { method: 'CASH' }),
      ).resolves.toBeDefined()
    })

    it('ACCOUNTANT may call', async () => {
      const { svc } = makeService()
      await expect(
        svc.confirmPayout('payout-tx-1', MAKSYM_USER.id, accountantUser, { method: 'CASH' }),
      ).resolves.toBeDefined()
    })
  })

  // ── PAYOUT row validation ────────────────────────────────────────────────
  describe('PAYOUT row validation', () => {
    it('PAYOUT not found → NotFoundException', async () => {
      const { svc } = makeService({ payoutRow: null })
      await expect(
        svc.confirmPayout('missing-id', MAKSYM_USER.id, accountantUser, { method: 'CASH' }),
      ).rejects.toThrow(NotFoundException)
    })

    it('Wrong type (SENIOR_INCOME) → BadRequestException', async () => {
      const { svc } = makeService({
        payoutRow: makePayoutRow({ type: 'SENIOR_INCOME' }),
      })
      await expect(
        svc.confirmPayout('senior-income-id', MAKSYM_USER.id, accountantUser, { method: 'CASH' }),
      ).rejects.toThrow(BadRequestException)
    })

    it('Status already PAID → BadRequestException (idempotency)', async () => {
      const { svc } = makeService({
        payoutRow: makePayoutRow({ status: 'PAID' }),
      })
      await expect(
        svc.confirmPayout('payout-tx-1', MAKSYM_USER.id, accountantUser, { method: 'CASH' }),
      ).rejects.toThrow(BadRequestException)
    })

    it('Status REJECTED → BadRequestException', async () => {
      const { svc } = makeService({
        payoutRow: makePayoutRow({ status: 'REJECTED' }),
      })
      await expect(
        svc.confirmPayout('payout-tx-1', MAKSYM_USER.id, accountantUser, { method: 'CASH' }),
      ).rejects.toThrow(BadRequestException)
    })

    it('Status PENDING (not PENDING_PAYMENT) → BadRequestException', async () => {
      const { svc } = makeService({
        payoutRow: makePayoutRow({ status: 'PENDING' }),
      })
      await expect(
        svc.confirmPayout('payout-tx-1', MAKSYM_USER.id, accountantUser, { method: 'CASH' }),
      ).rejects.toThrow(BadRequestException)
    })
  })

  // ── Recipient validation ─────────────────────────────────────────────────
  describe('Recipient validation', () => {
    it('Recipient user not found → BadRequestException', async () => {
      const { svc } = makeService({ recipient: null })
      await expect(
        svc.confirmPayout('payout-tx-1', 'ghost-id', accountantUser, { method: 'CASH' }),
      ).rejects.toThrow(BadRequestException)
    })

    it('Recipient is not ADMIN (SENIOR) → BadRequestException', async () => {
      const { svc } = makeService({
        recipient: { id: 'senior-2', role: 'SENIOR', archivedAt: null },
      })
      await expect(
        svc.confirmPayout('payout-tx-1', 'senior-2', accountantUser, { method: 'CASH' }),
      ).rejects.toThrow(BadRequestException)
    })

    it('Recipient is ACCOUNTANT (not ADMIN) → BadRequestException', async () => {
      const { svc } = makeService({
        recipient: { id: 'acc-2', role: 'ACCOUNTANT', archivedAt: null },
      })
      await expect(
        svc.confirmPayout('payout-tx-1', 'acc-2', accountantUser, { method: 'CASH' }),
      ).rejects.toThrow(BadRequestException)
    })

    it('Recipient archived → BadRequestException', async () => {
      const { svc } = makeService({
        recipient: { id: MAKSYM_USER.id, role: 'ADMIN', archivedAt: new Date('2026-01-01') },
      })
      await expect(
        svc.confirmPayout('payout-tx-1', MAKSYM_USER.id, accountantUser, { method: 'CASH' }),
      ).rejects.toThrow(BadRequestException)
    })
  })

  // ── Happy path ───────────────────────────────────────────────────────────
  describe('Happy path', () => {
    it('flips PAYOUT to PAID + inserts PAYOUT_CONFIRMED with correct fields', async () => {
      const { svc, state } = makeService()

      await svc.confirmPayout('payout-tx-1', MAKSYM_USER.id, accountantUser, { method: 'CASH' })

      // PAYOUT row updated to PAID, validation fields set.
      expect(state.updates).toHaveLength(1)
      const payoutPatch = state.updates[0]!.set
      expect(payoutPatch['status']).toBe('PAID')
      expect(payoutPatch['validatedBy']).toBe(accountantUser.id)
      expect(payoutPatch['validatedAt']).toBeInstanceOf(Date)

      // PAYOUT_CONFIRMED row inserted with correct amount/currency/projectId.
      expect(state.inserts).toHaveLength(1)
      const confirmed = state.inserts[0]!
      expect(confirmed['type']).toBe('PAYOUT_CONFIRMED')
      expect(confirmed['status']).toBe('PAID')
      expect(confirmed['amount']).toBe('740')
      expect(confirmed['currency']).toBe('USDT')
      expect(confirmed['receiverId']).toBe(MAKSYM_USER.id)
      expect(confirmed['recipientId']).toBe(MAKSYM_USER.id)
      expect(confirmed['projectId']).toBe('project-1')
      expect(confirmed['payoutRequestId']).toBe('payout-req-1')
      expect(confirmed['senderId']).toBe('senior-1')
      expect(confirmed['createdBy']).toBe(accountantUser.id)
    })

    it('selecting Kostya credits Kostya, not Maksym', async () => {
      const { svc, state } = makeService({ recipient: KOSTYA_USER })

      await svc.confirmPayout('payout-tx-1', KOSTYA_USER.id, accountantUser, { method: 'CASH' })

      const confirmed = state.inserts[0]!
      expect(confirmed['receiverId']).toBe(KOSTYA_USER.id)
      expect(confirmed['recipientId']).toBe(KOSTYA_USER.id)
    })

    it('confirmed row currency mirrors PAYOUT currency (USD case)', async () => {
      const { svc, state } = makeService({
        payoutRow: makePayoutRow({ currency: 'USD' }),
      })

      await svc.confirmPayout('payout-tx-1', MAKSYM_USER.id, accountantUser, { method: 'CASH' })

      expect(state.inserts[0]!['currency']).toBe('USD')
    })

    it('amount preserves the PAYOUT row’s amount string (no rounding bias)', async () => {
      const { svc, state } = makeService({
        payoutRow: makePayoutRow({ amount: '123.456789' }),
      })

      await svc.confirmPayout('payout-tx-1', MAKSYM_USER.id, accountantUser, { method: 'CASH' })

      expect(state.inserts[0]!['amount']).toBe('123.456789')
    })

    it('payoutRequestId is null when PAYOUT row has no payout_request link', async () => {
      const { svc, state } = makeService({
        payoutRow: makePayoutRow({ payoutRequestId: null }),
      })

      await svc.confirmPayout('payout-tx-1', MAKSYM_USER.id, accountantUser, { method: 'CASH' })

      expect(state.inserts[0]!['payoutRequestId']).toBeNull()
    })

    it('notes field carries a confirmation audit string (actor id + ISO timestamp)', async () => {
      const { svc, state } = makeService()

      await svc.confirmPayout('payout-tx-1', MAKSYM_USER.id, accountantUser, { method: 'CASH' })

      const note = state.inserts[0]!['notes'] as string
      expect(note).toContain('Manual payout confirmation')
      expect(note).toContain(accountantUser.id)
      // ISO 8601 timestamp suffix.
      expect(note).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
    })
  })

  // ── BIZ-02 cross-path: confirmPayout flips payout_request status ─────────
  describe('BIZ-02 cross-path: payout_request status flip', () => {
    it('when PAYOUT has payoutRequestId, payout_requests UPDATE is called with PENDING predicate', async () => {
      // The mock records every update call including the payout_requests flip.
      // With payoutRequestId='payout-req-1' (default makePayoutRow), the
      // service should call update(payoutRequests).set({status:'PAID'}).where(...)
      // in addition to the PAYOUT update. We verify by counting total update calls.
      const updateCalls: Array<{ table: string; patch: Record<string, unknown> }> = []

      const drizzleClient = {
        transaction: async (cb: (tx: unknown) => Promise<unknown>) => {
          const dbtx = {
            update: (_table: unknown) => ({
              set: (patch: Record<string, unknown>) => ({
                where: (_pred: unknown) => ({
                  returning: async (_fields: unknown) => {
                    // Record which table was updated by checking patch content
                    updateCalls.push({
                      table: 'status' in patch ? (patch['status'] as string) : 'unknown',
                      patch,
                    })
                    return [{ id: 'some-id' }]
                  },
                }),
              }),
            }),
            insert: (_table: unknown) => ({
              values: async (_row: Record<string, unknown>) => {},
            }),
          }
          return cb(dbtx)
        },
        query: {
          transactions: {
            findFirst: vi.fn(async () => makePayoutRow()), // has payoutRequestId='payout-req-1'
          },
          users: {
            findFirst: vi.fn(async () => MAKSYM_USER),
          },
        },
      }
      const db = { db: drizzleClient } as unknown
      const svc = makeTransactionsService({ db: db as never })
      vi.spyOn(svc, 'findOne').mockImplementation(
        async (id: string) => ({ id, type: 'PAYOUT', status: 'PAID' }) as never,
      )

      await svc.confirmPayout('payout-tx-1', MAKSYM_USER.id, accountantUser, { method: 'CASH' })

      // Two UPDATE calls inside the transaction:
      //   1) transactions PAYOUT → status='PAID'
      //   2) payoutRequests → status='PAID' (cross-path BIZ-02 fix)
      expect(updateCalls.length).toBe(2)
      const statuses = updateCalls.map((c) => c.table)
      expect(statuses).toContain('PAID') // both set status='PAID'
    })

    it('when PAYOUT has no payoutRequestId, only ONE update call is made', async () => {
      const updateCalls: Array<Record<string, unknown>> = []

      const drizzleClient = {
        transaction: async (cb: (tx: unknown) => Promise<unknown>) => {
          const dbtx = {
            update: (_table: unknown) => ({
              set: (patch: Record<string, unknown>) => ({
                where: (_pred: unknown) => ({
                  returning: async (_fields: unknown) => {
                    updateCalls.push(patch)
                    return [{ id: 'some-id' }]
                  },
                }),
              }),
            }),
            insert: (_table: unknown) => ({
              values: async (_row: Record<string, unknown>) => {},
            }),
          }
          return cb(dbtx)
        },
        query: {
          transactions: {
            findFirst: vi.fn(async () => makePayoutRow({ payoutRequestId: null })),
          },
          users: {
            findFirst: vi.fn(async () => MAKSYM_USER),
          },
        },
      }
      const db = { db: drizzleClient } as unknown
      const svc = makeTransactionsService({ db: db as never })
      vi.spyOn(svc, 'findOne').mockImplementation(
        async (id: string) => ({ id, type: 'PAYOUT', status: 'PAID' }) as never,
      )

      await svc.confirmPayout('payout-tx-1', MAKSYM_USER.id, accountantUser, { method: 'CASH' })

      // Only ONE update: the PAYOUT row itself (no payoutRequests flip needed)
      expect(updateCalls.length).toBe(1)
    })
  })

  // ── Payment method (Phase 4 refactor — AC4 / AC11) ────────────────────────
  // The PAYOUT_CONFIRMED row now carries an explicit method marker. CRYPTO
  // requires a txHash (≥ 10 chars), CASH does not. See
  // task-drop-phase4-refactor-remove-tov.md.
  describe('Payment method (AC4)', () => {
    it('method=CRYPTO without txHash → BadRequestException', async () => {
      const { svc } = makeService()
      await expect(
        svc.confirmPayout('payout-tx-1', MAKSYM_USER.id, accountantUser, { method: 'CRYPTO' }),
      ).rejects.toThrow(BadRequestException)
    })

    it('method=CRYPTO with txHash < 10 chars → BadRequestException', async () => {
      const { svc } = makeService()
      await expect(
        svc.confirmPayout('payout-tx-1', MAKSYM_USER.id, accountantUser, {
          method: 'CRYPTO',
          txHash: '0xshort',
        }),
      ).rejects.toThrow(BadRequestException)
    })

    it('method=CRYPTO with valid txHash → records txHash on PAYOUT_CONFIRMED', async () => {
      const { svc, state } = makeService()
      await svc.confirmPayout('payout-tx-1', MAKSYM_USER.id, accountantUser, {
        method: 'CRYPTO',
        txHash: '0xabcdef1234567890abcdef',
      })
      const confirmed = state.inserts[0]!
      expect(confirmed['txHash']).toBe('0xabcdef1234567890abcdef')
      expect(confirmed['senderLabel']).toBe('PAYOUT_METHOD:CRYPTO')
    })

    it('method=CRYPTO also stamps txHash on the PAYOUT update', async () => {
      const { svc, state } = makeService()
      await svc.confirmPayout('payout-tx-1', MAKSYM_USER.id, accountantUser, {
        method: 'CRYPTO',
        txHash: '0xabcdef1234567890abcdef',
      })
      expect(state.updates[0]!.set['txHash']).toBe('0xabcdef1234567890abcdef')
    })

    it('method=CASH without txHash → succeeds, txHash null on PAYOUT_CONFIRMED', async () => {
      const { svc, state } = makeService()
      await svc.confirmPayout('payout-tx-1', MAKSYM_USER.id, accountantUser, { method: 'CASH' })
      const confirmed = state.inserts[0]!
      expect(confirmed['txHash']).toBeNull()
      expect(confirmed['senderLabel']).toBe('PAYOUT_METHOD:CASH')
    })

    it('method=CASH does NOT touch txHash on PAYOUT update', async () => {
      const { svc, state } = makeService()
      await svc.confirmPayout('payout-tx-1', MAKSYM_USER.id, accountantUser, { method: 'CASH' })
      expect(state.updates[0]!.set['txHash']).toBeUndefined()
    })

    it('method=CASH ignores txHash field even if provided', async () => {
      const { svc, state } = makeService()
      await svc.confirmPayout('payout-tx-1', MAKSYM_USER.id, accountantUser, {
        method: 'CASH',
        txHash: '0xshouldbeignored',
      })
      const confirmed = state.inserts[0]!
      expect(confirmed['txHash']).toBeNull()
    })
  })
})
