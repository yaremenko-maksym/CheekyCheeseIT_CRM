/**
 * Unit tests for TransactionsService.getDropSelfSummary — the self-only DROP
 * summary behind `GET /api/finance/drop/me/summary` (task-drop-1-backend AC4).
 *
 * Coverage:
 *
 *  RBAC (self-only):
 *   1. Every non-DROP role (SENIOR / JUNIOR / HR / ACCOUNTANT / ADMIN) → 403.
 *   2. DROP → resolves with the four-field DTO.
 *   3. DROP whose user row is missing → 404 (defensive).
 *
 *  debtToCompany formula (the load-bearing money math). The debt is the sum of
 *  the placeholder PAYOUT rows booked at DROP_INCOME validation that the
 *  company-payment step has NOT yet flipped to PAID — i.e. PAYOUT rows with
 *  `senderId = drop.id` AND `status = 'PENDING_PAYMENT'` (verified against
 *  transactions.service `validateTransaction` + payment-channel `closePayout`):
 *   4. No incomes at all → debtToCompany = 0.
 *   5. One validated-unsettled income (PAYOUT PENDING_PAYMENT) → debt = its amount.
 *   6. Partially paid: one PENDING_PAYMENT + one already-PAID PAYOUT → debt counts
 *      only the PENDING_PAYMENT one.
 *   7. Fully paid: PAYOUT PAID only → debt = 0.
 *   8. Isolation: another drop's PENDING_PAYMENT PAYOUT must NOT leak into this
 *      drop's debt (the helper filters on senderId).
 *   9. balance + pendingIncomesCount mirror the admin dropBalances semantics
 *      (PAYOUT_DROP received − sent; DROP_INCOME PENDING|VALIDATED count).
 *
 *  pendingObligationAmount/Count (task-drop-sees-own-obligations — the reverse
 *  leg of debtToCompany: what the COMPANY owes THIS drop, booked but not yet
 *  paid). Σ over DROP_PENDING_PAYOUT rows where `receiverId = drop.id` AND
 *  `status = 'PENDING_PAYMENT'`:
 *   10. No obligations → pendingObligationAmount = 0, pendingObligationCount = 0.
 *   11. One booked-unpaid obligation → amount = its amount, count = 1.
 *   12. Settled obligation (row flipped to PAYOUT_DROP/PAID) does NOT count.
 *   13. Isolation: another drop's DROP_PENDING_PAYOUT must NOT leak in.
 *   14. balance stays the money ALREADY PAID (PAID PAYOUT_DROP) — a pending
 *       obligation never inflates it (accrued ≠ paid, §AC2).
 *
 * Pure stub for DatabaseService — no Postgres. The integration spec
 * (drop.rbac.integration.spec.ts) pins the same behaviour against a real DB.
 */
import { ForbiddenException, NotFoundException } from '@nestjs/common'
import { describe, expect, it, vi } from 'vitest'
import type { SessionUser } from '@crm/shared'
import { makeTransactionsService } from './__test-helpers__/make-transactions-service'
import type { NbuCurrencyService } from './nbu-currency.service'
import { collectParamValues } from './__test-helpers__/drizzle-where-introspection'

// ── Session user factory ────────────────────────────────────────────────────

function user(role: SessionUser['role'], id = `${role.toLowerCase()}-1`): SessionUser {
  return {
    id,
    role,
    displayName: `Test ${role}`,
    email: `${id}@test.com`,
    avatarUrl: null,
    avatarDocumentId: null,
    seniorSharePercent: 26,
  }
}

// ── DB stub builder ─────────────────────────────────────────────────────────

type TxStub = {
  id: string
  type: string
  status: string
  amount: string
  currency?: string
  // task-drop-payout-currency (MED-3): the obligation snapshot a currency-
  // converted DROP settle stamps — see computeDropAggregate/settleByCompany.
  originalAmount?: string | null
  originalCurrency?: string | null
  senderId: string | null
  receiverId: string | null
}

type UserRow = {
  id: string
  displayName: string
  dropSharePercent: number | null
}

/**
 * Build a TransactionsService whose DatabaseService returns:
 *  - users.findFirst → the supplied self row (or undefined to simulate 404)
 *  - transactions.findMany → the supplied ledger
 */
function makeSvc(
  self: UserRow | undefined,
  txs: TxStub[],
  nbuCurrencyService?: NbuCurrencyService,
) {
  const dbStub = {
    db: {
      query: {
        users: {
          findFirst: () => Promise.resolve(self),
        },
        transactions: {
          findMany: () => Promise.resolve(txs),
        },
      },
    },
  }
  return makeTransactionsService({ db: dbStub as never, nbuCurrencyService })
}

/**
 * task-drop-sees-own-obligations (security-review PR #523 round 2, MED-7).
 * `makeSvc` above stubs `transactions.findMany` with a bare `() => ...` that
 * IGNORES its `where` argument entirely — every test using it proves the
 * IN-MEMORY math in `computeDropAggregate` is right, but is structurally
 * blind to whether the SQL-level scope added for MED-1 (round 1) is right.
 * That gap was real: MED-1 replaced an unscoped `findMany` with one scoped
 * to `(receiverId = self OR senderId = self) AND type IN (four types)` —
 * get that predicate WRONG (e.g. drop one of the four types, or narrow the
 * OR to only `receiverId`) and NOT ONE test here would notice, because
 * `makeSvc`'s stub returns the same canned `txs` regardless of what `where`
 * it was called with. The failure direction is an UNDER-count — a drop
 * would see LESS than they are owed, the exact defect this task exists to
 * fix — which is why this is closed with an observing test, not left as a
 * documented gap.
 *
 * This variant CAPTURES the real `where` AST instead of ignoring it, so the
 * tests below can walk it (via `collectParamValues`) and assert on what it
 * actually binds.
 */
function makeSvcCapturingWhere(
  self: UserRow | undefined,
  txs: TxStub[],
): { svc: ReturnType<typeof makeTransactionsService>; getWhere: () => unknown } {
  let capturedWhere: unknown
  const dbStub = {
    db: {
      query: {
        users: {
          findFirst: () => Promise.resolve(self),
        },
        transactions: {
          findMany: (args?: { where?: unknown }) => {
            capturedWhere = args?.where
            return Promise.resolve(txs)
          },
        },
      },
    },
  }
  return { svc: makeTransactionsService({ db: dbStub as never }), getWhere: () => capturedWhere }
}

const DROP_ID = 'drop-A'
const OTHER_DROP_ID = 'drop-B'

const selfRow: UserRow = { id: DROP_ID, displayName: 'Drop A', dropSharePercent: 5 }

// Booked at DROP_INCOME validation: type=PAYOUT, senderId=drop, amount = payable.
function payout(
  senderId: string,
  status: string,
  amount: string,
  id = `payout-${amount}-${status}`,
): TxStub {
  return { id, type: 'PAYOUT', status, amount, senderId, receiverId: null }
}

// task-drop-sees-own-obligations: booked by bookCompanyObligations on the
// admin-USDT declare path / drop-payout cascade — type=DROP_PENDING_PAYOUT,
// receiverId=drop, status=PENDING_PAYMENT until settleByCompany flips it.
function obligation(
  receiverId: string,
  status: string,
  amount: string,
  id = `obligation-${amount}-${status}`,
): TxStub {
  return { id, type: 'DROP_PENDING_PAYOUT', status, amount, senderId: null, receiverId }
}

// ── RBAC ─────────────────────────────────────────────────────────────────────

describe('getDropSelfSummary — RBAC (self-only)', () => {
  const forbiddenRoles: SessionUser['role'][] = ['SENIOR', 'JUNIOR', 'HR', 'ACCOUNTANT', 'ADMIN']

  for (const role of forbiddenRoles) {
    it(`throws ForbiddenException for role ${role}`, async () => {
      const svc = makeSvc(selfRow, [])
      await expect(svc.getDropSelfSummary(user(role))).rejects.toBeInstanceOf(ForbiddenException)
    })
  }

  it('resolves the six-field DTO for DROP', async () => {
    const svc = makeSvc(selfRow, [])
    const res = await svc.getDropSelfSummary(user('DROP', DROP_ID))
    expect(res).toEqual({
      balance: 0,
      dropSharePercent: 5,
      pendingIncomesCount: 0,
      debtToCompany: 0,
      pendingObligationAmount: 0,
      pendingObligationCount: 0,
    })
  })

  it('throws NotFoundException when the drop user row is missing', async () => {
    const svc = makeSvc(undefined, [])
    await expect(svc.getDropSelfSummary(user('DROP', DROP_ID))).rejects.toBeInstanceOf(
      NotFoundException,
    )
  })
})

// task-drop-sees-own-obligations — mutation-gate MED-7 (security-review PR
// #523 round 2): the MED-1 (round 1) SQL-level scope on `getDropSelfSummary`'s
// `findMany` was invisible to every test above (`makeSvc`'s stub ignores
// `where`). Ports the same `makeSvcCapturingWhere` + `collectParamValues`
// harness already proven in transactions.drop-self-feeds.spec.ts to THIS
// query. The risk direction is under-count (a drop seeing LESS than they are
// owed), so these assert the predicate is a SUPERSET covering every type +
// relation `computeDropAggregate` actually reads — narrowing any of it would
// fail these tests.
describe('getDropSelfSummary — DB-level scope (mutation-gate MED-7)', () => {
  const OBLIGATION_TYPES = ['PAYOUT_DROP', 'DROP_INCOME', 'PAYOUT', 'DROP_PENDING_PAYOUT']

  it('WHERE clause binds all four types computeDropAggregate reads — none dropped (no under-count)', async () => {
    const { svc, getWhere } = makeSvcCapturingWhere(selfRow, [])
    await svc.getDropSelfSummary(user('DROP', DROP_ID))
    const bound = collectParamValues(getWhere())

    const boundTypes = bound.filter(
      (v): v is string => typeof v === 'string' && OBLIGATION_TYPES.includes(v),
    )
    expect(boundTypes.sort()).toEqual([...OBLIGATION_TYPES].sort())
  })

  it('WHERE clause binds self.id for BOTH sides of the receiverId/senderId OR-scope', async () => {
    const { svc, getWhere } = makeSvcCapturingWhere(selfRow, [])
    await svc.getDropSelfSummary(user('DROP', DROP_ID))
    const bound = collectParamValues(getWhere())

    // and(isNull(deletedAt), or(eq(receiverId, self.id), eq(senderId, self.id)), inArray(type, [...]))
    // binds self.id TWICE (once per side of the OR) plus the four type
    // literals — six Params total. Asserting the exact count (not just
    // "contains") catches a mutant that silently drops one side of the OR
    // (e.g. narrows to receiverId-only), which would under-count exactly
    // the same way a missing type would.
    const selfIdOccurrences = bound.filter((v) => v === DROP_ID)
    expect(selfIdOccurrences.length).toBe(2)
    expect(bound.length).toBe(2 + OBLIGATION_TYPES.length)
  })

  it('a different drop id is NEVER bound in the WHERE (no cross-drop leak in the SQL scope itself, §AC5)', async () => {
    const { svc, getWhere } = makeSvcCapturingWhere(selfRow, [])
    await svc.getDropSelfSummary(user('DROP', DROP_ID))
    const bound = collectParamValues(getWhere())
    expect(bound).not.toContain(OTHER_DROP_ID)
  })
})

// ── debtToCompany formula ─────────────────────────────────────────────────────

describe('getDropSelfSummary — debtToCompany formula', () => {
  it('no incomes → debtToCompany = 0', async () => {
    const svc = makeSvc(selfRow, [])
    const res = await svc.getDropSelfSummary(user('DROP', DROP_ID))
    expect(res.debtToCompany).toBe(0)
  })

  it('one validated-unsettled income → debt = booked payable', async () => {
    // income 1000, share 5% → drop keeps 50, owes company 950 (PAYOUT placeholder).
    const svc = makeSvc(selfRow, [payout(DROP_ID, 'PENDING_PAYMENT', '950')])
    const res = await svc.getDropSelfSummary(user('DROP', DROP_ID))
    expect(res.debtToCompany).toBe(950)
  })

  it('partially paid → only PENDING_PAYMENT payouts count', async () => {
    const svc = makeSvc(selfRow, [
      payout(DROP_ID, 'PENDING_PAYMENT', '950', 'p-open'),
      payout(DROP_ID, 'PAID', '475', 'p-paid'),
    ])
    const res = await svc.getDropSelfSummary(user('DROP', DROP_ID))
    expect(res.debtToCompany).toBe(950)
  })

  it('fully paid → debtToCompany = 0', async () => {
    const svc = makeSvc(selfRow, [payout(DROP_ID, 'PAID', '950')])
    const res = await svc.getDropSelfSummary(user('DROP', DROP_ID))
    expect(res.debtToCompany).toBe(0)
  })

  it('sums multiple PENDING_PAYMENT payouts (float-safe)', async () => {
    // 0.1 + 0.2 must not produce 0.30000000000000004 — scaled-integer guard.
    const svc = makeSvc(selfRow, [
      payout(DROP_ID, 'PENDING_PAYMENT', '0.1', 'p1'),
      payout(DROP_ID, 'PENDING_PAYMENT', '0.2', 'p2'),
    ])
    const res = await svc.getDropSelfSummary(user('DROP', DROP_ID))
    expect(res.debtToCompany).toBe(0.3)
  })

  it("ignores another drop's PENDING_PAYMENT payout (no cross-drop leak)", async () => {
    const svc = makeSvc(selfRow, [
      payout(DROP_ID, 'PENDING_PAYMENT', '100', 'mine'),
      payout(OTHER_DROP_ID, 'PENDING_PAYMENT', '999', 'theirs'),
    ])
    const res = await svc.getDropSelfSummary(user('DROP', DROP_ID))
    expect(res.debtToCompany).toBe(100)
  })
})

// ── balance + pendingIncomesCount mirror admin dropBalances ──────────────────

describe('getDropSelfSummary — balance & pendingIncomesCount', () => {
  it('balance = Σ PAYOUT_DROP received − sent (PAID only)', async () => {
    const txs: TxStub[] = [
      {
        id: 'r1',
        type: 'PAYOUT_DROP',
        status: 'PAID',
        amount: '50',
        senderId: null,
        receiverId: DROP_ID,
      },
      {
        id: 'r2',
        type: 'PAYOUT_DROP',
        status: 'PAID',
        amount: '30',
        senderId: null,
        receiverId: DROP_ID,
      },
      {
        id: 's1',
        type: 'PAYOUT_DROP',
        status: 'PAID',
        amount: '20',
        senderId: DROP_ID,
        receiverId: null,
      },
      // PENDING PAYOUT_DROP must NOT count toward balance.
      {
        id: 'r3',
        type: 'PAYOUT_DROP',
        status: 'PENDING',
        amount: '999',
        senderId: null,
        receiverId: DROP_ID,
      },
    ]
    const svc = makeSvc(selfRow, txs)
    const res = await svc.getDropSelfSummary(user('DROP', DROP_ID))
    expect(res.balance).toBe(60) // 50 + 30 − 20
  })

  /**
   * task-sender-receiver-invariant (backlog A-2, security-review round 2
   * follow-up). A self-referential PAYOUT_DROP (senderId === receiverId ===
   * drop.id — mega-audit wave 2, C-1) is now IMPOSSIBLE to insert at all
   * (the `ck_transactions_sender_ne_receiver` DB CHECK rejects it), so the
   * REAL-DB regression that used to prove this (`total-earned.integration
   * .spec.ts`'s C-1 test) can no longer seed its fixture and was `it.skip`'d
   * with a note pointing here. This UNIT test keeps the coverage alive the
   * cheap way — `computeDropAggregate` is pure arithmetic over an in-memory
   * array, so a mocked query result exercises the SAME "nets to zero" branch
   * without touching a real Postgres CHECK at all: a self-loop row counts
   * once as `received` (receiverId=drop.id) and once as `sent`
   * (senderId=drop.id), and the two cancel exactly — proving the defensive
   * `received − sent` formula still holds even for the shape the DB now
   * structurally forbids (belt-and-suspenders, not a redundant check).
   */
  it('a self-referential PAYOUT_DROP (senderId===receiverId===drop.id) nets to zero (C-1, unit-level)', async () => {
    const txs: TxStub[] = [
      {
        id: 'r1',
        type: 'PAYOUT_DROP',
        status: 'PAID',
        amount: '50',
        senderId: null,
        receiverId: DROP_ID,
      },
      {
        id: 'self-loop',
        type: 'PAYOUT_DROP',
        status: 'PAID',
        amount: '333.33',
        senderId: DROP_ID,
        receiverId: DROP_ID,
      },
    ]
    const svc = makeSvc(selfRow, txs)
    const res = await svc.getDropSelfSummary(user('DROP', DROP_ID))
    // 50 (received) + 0 net from the self-loop (counted as BOTH received AND
    // sent, cancelling) — NOT 50 + 333.33 and NOT 50 − 333.33.
    expect(res.balance).toBe(50)
  })

  it('pendingIncomesCount = DROP_INCOME rows (PENDING|VALIDATED) for this drop', async () => {
    const txs: TxStub[] = [
      {
        id: 'i1',
        type: 'DROP_INCOME',
        status: 'PENDING',
        amount: '500',
        senderId: null,
        receiverId: DROP_ID,
      },
      {
        id: 'i2',
        type: 'DROP_INCOME',
        status: 'VALIDATED',
        amount: '500',
        senderId: null,
        receiverId: DROP_ID,
      },
      // PAID income → not pending.
      {
        id: 'i3',
        type: 'DROP_INCOME',
        status: 'PAID',
        amount: '500',
        senderId: null,
        receiverId: DROP_ID,
      },
      // Another drop's income → must not count.
      {
        id: 'i4',
        type: 'DROP_INCOME',
        status: 'PENDING',
        amount: '500',
        senderId: null,
        receiverId: OTHER_DROP_ID,
      },
    ]
    const svc = makeSvc(selfRow, txs)
    const res = await svc.getDropSelfSummary(user('DROP', DROP_ID))
    expect(res.pendingIncomesCount).toBe(2)
  })

  it('dropSharePercent falls back to default 5 when NULL', async () => {
    const svc = makeSvc({ id: DROP_ID, displayName: 'Drop A', dropSharePercent: null }, [])
    const res = await svc.getDropSelfSummary(user('DROP', DROP_ID))
    expect(res.dropSharePercent).toBe(5)
  })
})

// ── task-drop-sees-own-obligations: pendingObligationAmount/Count ────────────
// The core bug: a drop with a booked DROP_PENDING_PAYOUT (admin-USDT declare /
// drop-payout cascade) saw balance=$0 and no hint anything was owed. These
// pin the reverse-of-debtToCompany figure the self-summary now surfaces.
describe('getDropSelfSummary — pendingObligationAmount/Count (§AC1/§AC2)', () => {
  it('no obligations → pendingObligationAmount = 0, pendingObligationCount = 0', async () => {
    const svc = makeSvc(selfRow, [])
    const res = await svc.getDropSelfSummary(user('DROP', DROP_ID))
    expect(res.pendingObligationAmount).toBe(0)
    expect(res.pendingObligationCount).toBe(0)
  })

  it('one booked-unpaid obligation → amount = its amount, count = 1', async () => {
    const svc = makeSvc(selfRow, [obligation(DROP_ID, 'PENDING_PAYMENT', '800.48')])
    const res = await svc.getDropSelfSummary(user('DROP', DROP_ID))
    expect(res.pendingObligationAmount).toBe(800.48)
    expect(res.pendingObligationCount).toBe(1)
  })

  it('sums multiple PENDING_PAYMENT obligations (float-safe)', async () => {
    const svc = makeSvc(selfRow, [
      obligation(DROP_ID, 'PENDING_PAYMENT', '0.1', 'o1'),
      obligation(DROP_ID, 'PENDING_PAYMENT', '0.2', 'o2'),
    ])
    const res = await svc.getDropSelfSummary(user('DROP', DROP_ID))
    expect(res.pendingObligationAmount).toBe(0.3)
    expect(res.pendingObligationCount).toBe(2)
  })

  it('a settled obligation (flipped to PAYOUT_DROP/PAID) does NOT count as pending', async () => {
    const svc = makeSvc(selfRow, [
      {
        id: 'settled',
        type: 'PAYOUT_DROP',
        status: 'PAID',
        amount: '300',
        senderId: null,
        receiverId: DROP_ID,
      },
    ])
    const res = await svc.getDropSelfSummary(user('DROP', DROP_ID))
    expect(res.pendingObligationAmount).toBe(0)
    expect(res.pendingObligationCount).toBe(0)
    // AC2: the settled obligation IS reflected — as balance, not obligation.
    expect(res.balance).toBe(300)
  })

  it("ignores another drop's DROP_PENDING_PAYOUT (no cross-drop leak, §AC5)", async () => {
    const svc = makeSvc(selfRow, [
      obligation(DROP_ID, 'PENDING_PAYMENT', '100', 'mine'),
      obligation(OTHER_DROP_ID, 'PENDING_PAYMENT', '999', 'theirs'),
    ])
    const res = await svc.getDropSelfSummary(user('DROP', DROP_ID))
    expect(res.pendingObligationAmount).toBe(100)
    expect(res.pendingObligationCount).toBe(1)
  })

  // Mutation-gate (security-review PR #523 round 1, MED-2): the two tests
  // above always vary type AND status together (obligation vs settled), so a
  // mutant that drops EITHER the `type === 'DROP_PENDING_PAYOUT'` OR the
  // `status === 'PENDING_PAYMENT'` clause alone can still survive — the OTHER
  // clause happens to filter the row out anyway. These two isolate each
  // clause: same receiverId, only ONE of {type, status} differs from a real
  // pending obligation.
  it('right receiverId + PENDING_PAYMENT status but wrong type → excluded (isolates the type check)', async () => {
    const svc = makeSvc(selfRow, [
      // Same shape as a real pending obligation (receiverId, status) but a
      // DIFFERENT type — e.g. a PAYOUT row a drop owes the company (debt-to-
      // company direction). Must never be read as money owed TO the drop.
      {
        id: 'wrong-type',
        type: 'PAYOUT',
        status: 'PENDING_PAYMENT',
        amount: '500',
        senderId: null,
        receiverId: DROP_ID,
      },
    ])
    const res = await svc.getDropSelfSummary(user('DROP', DROP_ID))
    expect(res.pendingObligationAmount).toBe(0)
    expect(res.pendingObligationCount).toBe(0)
  })

  it('right receiverId + DROP_PENDING_PAYOUT type but wrong status → excluded (isolates the status check)', async () => {
    const svc = makeSvc(selfRow, [
      // Same type + receiverId as a real pending obligation, but a status
      // that is NOT 'PENDING_PAYMENT' — e.g. REJECTED. Must not be counted
      // as still owed.
      {
        id: 'wrong-status',
        type: 'DROP_PENDING_PAYOUT',
        status: 'REJECTED',
        amount: '500',
        senderId: null,
        receiverId: DROP_ID,
      },
    ])
    const res = await svc.getDropSelfSummary(user('DROP', DROP_ID))
    expect(res.pendingObligationAmount).toBe(0)
    expect(res.pendingObligationCount).toBe(0)
  })

  it('§AC2: pending obligation and paid balance are NEVER summed into one figure', async () => {
    const svc = makeSvc(selfRow, [
      obligation(DROP_ID, 'PENDING_PAYMENT', '800.48'),
      {
        id: 'paid',
        type: 'PAYOUT_DROP',
        status: 'PAID',
        amount: '120',
        senderId: null,
        receiverId: DROP_ID,
      },
    ])
    const res = await svc.getDropSelfSummary(user('DROP', DROP_ID))
    // Two distinct fields, each carrying its own money — NOT one blended
    // total (920.48). This is the exact regression this task closes: a
    // drop seeing 800 booked and 0 in their wallet must never read that as
    // "$920.48 balance".
    expect(res.balance).toBe(120)
    expect(res.pendingObligationAmount).toBe(800.48)
  })
})

// ── Audit 2026-06-28 (#3): PAYOUT_DROP must NOT be a self-loop ─────────────────
describe('getDropSelfSummary — #3: PAYOUT_DROP self-loop regression', () => {
  it('company-funded PAYOUT_DROP (senderId=null, receiverId=drop) → balance = the slice', async () => {
    // The FIX: the payout cascade now books PAYOUT_DROP with senderId=null
    // (sender = COMPANY) and receiverId=drop, so the drop is purely the receiver.
    const svc = makeSvc(selfRow, [
      {
        id: 'slice',
        type: 'PAYOUT_DROP',
        status: 'PAID',
        amount: '50',
        senderId: null,
        receiverId: DROP_ID,
      },
    ])
    const res = await svc.getDropSelfSummary(user('DROP', DROP_ID))
    expect(res.balance).toBe(50) // credited, NOT cancelled to 0
  })

  it('OLD BUG shape (sender == receiver == drop) self-loops to 0 — the regression we fixed', async () => {
    // Documents the broken pre-fix row: when senderId == receiverId == drop the
    // received and sent legs cancel → 0. The cascade no longer produces this.
    const svc = makeSvc(selfRow, [
      {
        id: 'self-loop',
        type: 'PAYOUT_DROP',
        status: 'PAID',
        amount: '50',
        senderId: DROP_ID,
        receiverId: DROP_ID,
      },
    ])
    const res = await svc.getDropSelfSummary(user('DROP', DROP_ID))
    expect(res.balance).toBe(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// MED-3 (security-review PR #521 round 1) — a currency-converted DROP settle
// (task-drop-payout-currency) stamps `original_amount`/`original_currency`
// (always USDT, pegged 1:1 to USD) alongside the FACT (`amount`/`currency`,
// e.g. UAH). Re-converting the FACT at CURRENT NBU rates on every read makes
// an already-closed, immutable payout drift over time purely because rates
// moved after the fact — the pinned snapshot exists specifically to prevent
// that.
// ─────────────────────────────────────────────────────────────────────────────
// security-review PR #521 round 3 (MED-B): the MED-3 "pinned obligation
// snapshot" behaviour this describe block used to test was REVERTED per the
// owner's explicit decision — the SAME transaction was reading as 3
// different numbers in different parts of the app (this endpoint pinned to
// the booked snapshot; getTotalEarned / adminBalances.sent kept
// reconverting at today's rate), and the owner chose uniformity over
// pinning: «везде по сегодняшнему курсу». `computeDropAggregate` now ALWAYS
// reconverts at the CURRENT rate, same as every other balance reader —
// `original_amount`/`original_currency` stay on the schema as a fact record
// (see settleByCompany) but are no longer consulted here.
describe('getDropSelfSummary — MED-B: uniform current-rate reconversion (no pinning)', () => {
  function rateStub(usdUah: string): NbuCurrencyService {
    return {
      getRates: vi.fn().mockResolvedValue({
        usdUah,
        usdtUah: usdUah,
        eurUah: '44.80',
        date: '2026-08-13',
      }),
    } as unknown as NbuCurrencyService
  }

  it('a UAH-settled PAYOUT_DROP reconverts at the CURRENT rate — an original_amount/original_currency snapshot is a fact record only, never read here', async () => {
    // Settled when 1000 USDT ≈ 41 500 UAH (rate 41.50) — the row the real
    // settleByCompany would have written (original_amount/original_currency
    // stamped as the fact of what was originally owed).
    const row: TxStub = {
      id: 'uah-settle',
      type: 'PAYOUT_DROP',
      status: 'PAID',
      amount: '41500',
      currency: 'UAH',
      originalAmount: '1000',
      originalCurrency: 'USDT',
      senderId: null,
      receiverId: DROP_ID,
    }
    // The rate has since moved to 50.00 (a month later, say). Per the
    // owner's decision, this is the CORRECT reading — every balance reader
    // uniformly reconverts at today's rate, matching getTotalEarned /
    // adminBalances.sent, which never pinned in the first place.
    const svc = makeSvc(selfRow, [row], rateStub('50.00'))
    const res = await svc.getDropSelfSummary(user('DROP', DROP_ID))
    expect(res.balance).toBe(830) // 41500 / 50.00 — the current-rate figure
  })

  it('the SAME reconversion happens whether or not an original_amount/original_currency snapshot is present on the row', async () => {
    const withSnapshot: TxStub = {
      id: 'uah-settle-with-snapshot',
      type: 'PAYOUT_DROP',
      status: 'PAID',
      amount: '41500',
      currency: 'UAH',
      originalAmount: '1000',
      originalCurrency: 'USDT',
      senderId: null,
      receiverId: DROP_ID,
    }
    const withoutSnapshot: TxStub = {
      ...withSnapshot,
      id: 'uah-settle-no-snapshot',
      originalAmount: null,
      originalCurrency: null,
    }
    const resWith = await makeSvc(selfRow, [withSnapshot], rateStub('50.00')).getDropSelfSummary(
      user('DROP', DROP_ID),
    )
    const resWithout = await makeSvc(
      selfRow,
      [withoutSnapshot],
      rateStub('50.00'),
    ).getDropSelfSummary(user('DROP', DROP_ID))
    expect(resWith.balance).toBe(resWithout.balance)
    expect(resWith.balance).toBe(830)
  })

  it('a same-currency USDT settle needs no rate either way (identity, not pinning)', async () => {
    const row: TxStub = {
      id: 'usdt-settle',
      type: 'PAYOUT_DROP',
      status: 'PAID',
      amount: '1000',
      currency: 'USDT',
      originalAmount: '1000',
      originalCurrency: 'USDT',
      senderId: null,
      receiverId: DROP_ID,
    }
    const svc = makeSvc(selfRow, [row], rateStub('999.99'))
    const res = await svc.getDropSelfSummary(user('DROP', DROP_ID))
    expect(res.balance).toBe(1000)
  })
})
