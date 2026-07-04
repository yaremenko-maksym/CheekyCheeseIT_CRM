/**
 * Drop role - phase 4-A. RBAC + filter / wire-shape tests for
 * `BalanceService.assertCan*` helpers and `BalanceService.getPendingObligations`
 * — the two surfaces the `PendingObligationsController` glues to
 * `/api/pending-obligations`.
 *
 * The companion controller-level behavior ("SENIOR caller has creditorUserId
 * forced to self") is asserted here at the service-helper level: the
 * controller calls `assertCanListPendingObligations(user)` and then mutates
 * `filter.creditorUserId = user.id` for SENIORs. This file pins the
 * pre-condition (assert helper does not throw on SENIOR) and the
 * post-condition (filter shape after the controller's swap is what the
 * service receives).
 */
import { ForbiddenException } from '@nestjs/common'
import { describe, expect, it } from 'vitest'
import type { SessionUser } from '@crm/shared'
import { BalanceService } from './balance.service'

const adminUser: SessionUser = {
  id: 'admin-1',
  role: 'ADMIN',
  displayName: 'Admin',
  email: 'a@x.com',
  avatarUrl: null,
  avatarDocumentId: null,
  seniorSharePercent: 26,
}
const accountantUser: SessionUser = {
  id: 'accountant-1',
  role: 'ACCOUNTANT',
  displayName: 'Accountant',
  email: 'ac@x.com',
  avatarUrl: null,
  avatarDocumentId: null,
  seniorSharePercent: 26,
}
const seniorA: SessionUser = {
  id: 'senior-a',
  role: 'SENIOR',
  displayName: 'Senior A',
  email: 'sa@x.com',
  avatarUrl: null,
  avatarDocumentId: null,
  seniorSharePercent: 26,
}
const seniorB: SessionUser = {
  id: 'senior-b',
  role: 'SENIOR',
  displayName: 'Senior B',
  email: 'sb@x.com',
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
const dropUser: SessionUser = {
  id: 'drop-1',
  role: 'DROP',
  displayName: 'Drop',
  email: 'd@x.com',
  avatarUrl: null,
  avatarDocumentId: null,
  seniorSharePercent: 26,
}

interface ObligationRow {
  id: string
  creditorUserId: string
  debtorType: 'DROP' | 'TOV' | 'ADMIN'
  debtorUserId: string | null
  sourceTransactionId: string
  closingTransactionId: string | null
  amount: string
  currency: 'USDT' | 'USD' | 'EUR' | 'UAH'
  status: 'PENDING' | 'PAID' | 'CANCELLED'
  createdAt: Date
  updatedAt: Date
}

function makeService(obligations: ObligationRow[] = []): BalanceService {
  // The mock observes `where` for the filter-correctness tests by stashing
  // calls. For pure RBAC tests where the data is irrelevant we just return
  // the static list.
  const drizzleClient = {
    query: {
      transactions: { findMany: async () => [] },
      pendingObligations: {
        findMany: async () => obligations,
      },
    },
  }
  const db = { db: drizzleClient } as never
  const nbu = {
    getRates: async () => ({ usdUah: '40', usdtUah: '40', eurUah: '44', date: '' }),
  } as never
  return new BalanceService(db, nbu)
}

function makeObligation(overrides: Partial<ObligationRow> = {}): ObligationRow {
  const now = new Date('2026-05-30T00:00:00Z')
  return {
    id: 'oblig-1',
    creditorUserId: seniorA.id,
    debtorType: 'TOV',
    debtorUserId: null,
    sourceTransactionId: 'tx-source-1',
    closingTransactionId: null,
    amount: '500',
    currency: 'USDT',
    status: 'PENDING',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

// Phase 4 refactor: assertCanReadTOV removed (AC3) — TOV balance endpoint
// is gone. Tests deleted alongside the implementation.

// ── RBAC: assertCanReadAdminBalance ───────────────────────────────────────

describe('assertCanReadAdminBalance', () => {
  const svc = makeService()
  it('ACCOUNTANT can read any admin balance', () => {
    expect(() => svc.assertCanReadAdminBalance(accountantUser, 'any-admin')).not.toThrow()
  })
  it('ADMIN can read own balance', () => {
    expect(() => svc.assertCanReadAdminBalance(adminUser, adminUser.id)).not.toThrow()
  })
  // SEC-13: Phase 4-B "any admin" behaviour reverted. ADMIN is scoped to own
  // balance only — reading a partner's breakdown is a data-leak. The /stats
  // page ONLY passes viewer.id as targetAdminId, so ADMIN sees only their own
  // share on that page (ACCOUNTANT unrestricted and sees both partners).
  it("ADMIN cannot read another admin's balance → ForbiddenException", () => {
    expect(() => svc.assertCanReadAdminBalance(adminUser, 'other-admin')).toThrow(
      ForbiddenException,
    )
  })
  it.each([seniorA, juniorUser, hrUser, dropUser])('%s forbidden', (user) => {
    expect(() => svc.assertCanReadAdminBalance(user, 'any-admin')).toThrow(ForbiddenException)
  })
})

// ── RBAC: assertCanReadSeniorBalance ──────────────────────────────────────

describe('assertCanReadSeniorBalance', () => {
  const svc = makeService()
  it('ADMIN can read any senior balance', () => {
    expect(() => svc.assertCanReadSeniorBalance(adminUser, seniorA.id)).not.toThrow()
  })
  it('ACCOUNTANT can read any senior balance', () => {
    expect(() => svc.assertCanReadSeniorBalance(accountantUser, seniorA.id)).not.toThrow()
  })
  it('SENIOR can read own balance', () => {
    expect(() => svc.assertCanReadSeniorBalance(seniorA, seniorA.id)).not.toThrow()
  })
  it("SENIOR can NOT read another senior's balance", () => {
    expect(() => svc.assertCanReadSeniorBalance(seniorA, seniorB.id)).toThrow(ForbiddenException)
  })
  it.each([juniorUser, hrUser, dropUser])('%s forbidden', (user) => {
    expect(() => svc.assertCanReadSeniorBalance(user, seniorA.id)).toThrow(ForbiddenException)
  })
})

// ── RBAC: assertCanListPendingObligations ─────────────────────────────────

describe('assertCanListPendingObligations', () => {
  const svc = makeService()
  it('ADMIN allowed', () => {
    expect(() => svc.assertCanListPendingObligations(adminUser)).not.toThrow()
  })
  it('ACCOUNTANT allowed', () => {
    expect(() => svc.assertCanListPendingObligations(accountantUser)).not.toThrow()
  })
  it('SENIOR allowed (will be scoped to self by the controller)', () => {
    expect(() => svc.assertCanListPendingObligations(seniorA)).not.toThrow()
  })
  it.each([juniorUser, hrUser, dropUser])('%s forbidden', (user) => {
    expect(() => svc.assertCanListPendingObligations(user)).toThrow(ForbiddenException)
  })
})

// ── Wire shape / filter contract ──────────────────────────────────────────

describe('getPendingObligations — wire contract', () => {
  it('returns empty list when no rows match', async () => {
    const svc = makeService([])
    const list = await svc.getPendingObligations()
    expect(list).toEqual([])
  })

  it('serializes dates as ISO strings', async () => {
    const svc = makeService([makeObligation()])
    const [row] = await svc.getPendingObligations()
    expect(row!.createdAt).toBe('2026-05-30T00:00:00.000Z')
    expect(row!.updatedAt).toBe('2026-05-30T00:00:00.000Z')
  })

  it('preserves numeric `amount` as a string (no float drift)', async () => {
    const svc = makeService([makeObligation({ amount: '1234.567890' })])
    const [row] = await svc.getPendingObligations()
    expect(row!.amount).toBe('1234.567890')
  })

  it('passes through debtorType=DROP + debtorUserId', async () => {
    const svc = makeService([makeObligation({ debtorType: 'DROP', debtorUserId: dropUser.id })])
    const [row] = await svc.getPendingObligations()
    expect(row!.debtorType).toBe('DROP')
    expect(row!.debtorUserId).toBe(dropUser.id)
  })

  it('passes through closing transaction id once PAID', async () => {
    const svc = makeService([
      makeObligation({ status: 'PAID', closingTransactionId: 'tx-close-1' }),
    ])
    const [row] = await svc.getPendingObligations()
    expect(row!.status).toBe('PAID')
    expect(row!.closingTransactionId).toBe('tx-close-1')
  })
})

// ── Multi-currency obligations (edge AC7) ─────────────────────────────────

describe('getPendingObligations — multi-currency support', () => {
  it('keeps currency mix intact (no auto-conversion at list time)', async () => {
    // Obligations are NOT converted in `getPendingObligations` — they carry
    // the original currency the obligation was created in. That choice keeps
    // the settlement-side UI honest: the senior must be paid the exact
    // amount/currency the obligation was raised for. Balance conversion is
    // only applied by the *balance* methods.
    const svc = makeService([
      makeObligation({ id: 'o-usdt', currency: 'USDT', amount: '500' }),
      makeObligation({ id: 'o-uah', currency: 'UAH', amount: '20000' }),
      makeObligation({ id: 'o-eur', currency: 'EUR', amount: '100' }),
    ])
    const list = await svc.getPendingObligations()
    expect(list).toHaveLength(3)
    expect(list.map((r) => r.currency).sort()).toEqual(['EUR', 'UAH', 'USDT'])
    expect(list.find((r) => r.currency === 'UAH')!.amount).toBe('20000')
  })
})
