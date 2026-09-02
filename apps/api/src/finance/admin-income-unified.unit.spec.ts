/**
 * task-admin-income-unified — unit-level (mocked db) coverage of
 * `createAdminIncome`'s receiver-resolution rewrite (§2, owner decision
 * 2026-08-12).
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM THE INTEGRATION SPECS: the mutation
 * gate (task-mutation-gate, #507) runs vitest in NON-integration mode, which
 * structurally excludes every `*.integration.spec.ts` file (see
 * `vitest.config.mts` / `INTEGRATION_SPEC_EXCLUDE_GLOB`) — so real-DB
 * coverage in `admin-income-unified.integration.spec.ts` /
 * `transactions.create-accountant.rbac.integration.spec.ts` is INVISIBLE to
 * it. Without a mocked-db unit spec, the entire new receiver-resolution
 * block (RBAC-for-receiverId, the 3-way undefined/COMPANY_ACCOUNT/specific-
 * admin branch, the active-ADMIN validation, and the currency-forcing that
 * follows from it) reports 0% mutation coverage — confirmed by a real run
 * that surfaced exactly this gap before this file existed.
 *
 * Scope: only the code BEFORE/AROUND `db.transaction(...)` that decides
 * `receiverId` / `fundingSource` / effective currency — the same lines the
 * mutation report flagged (transactions.service.ts:1637-1715). Business
 * outcomes (obligations booked, real persisted rows) stay proven on a real
 * DB in the integration specs; this file is deliberately narrow.
 */
import { BadRequestException, ForbiddenException } from '@nestjs/common'
import { describe, expect, it, vi } from 'vitest'
import type { SessionUser } from '@crm/shared'
import { COMPANY_ACCOUNT_RECEIVER } from '@crm/shared'
import { makeTransactionsService } from './__test-helpers__/make-transactions-service'

const ADMIN: SessionUser = {
  id: 'admin-caller',
  role: 'ADMIN',
  displayName: 'Admin Caller',
  email: 'admin-caller@x.com',
  avatarUrl: null,
  seniorSharePercent: 0,
}
const ACCOUNTANT: SessionUser = { ...ADMIN, id: 'accountant-caller', role: 'ACCOUNTANT' }

const PROJECT_ID = 'project-1'
const OTHER_ADMIN_ID = 'other-admin-1'

// An address-style explorer link — passes `receiptMandatoryError`'s
// explorer-only check (needs a recognised host + something after it) but
// carries NO extractable 0x+64hex hash, so `consumeTxHash` short-circuits to
// {claimed:false} without touching a `consumed_tx_hashes` table this mock
// does not model. Same trick `onchain-tx-cross-path.integration.spec.ts`
// uses for the identical reason ("An address link passes receipt validation
// but carries no tx hash").
const EXPLORER_NO_HASH = 'https://etherscan.io/address/0xabc'
const PLAIN_URL = 'https://example.com/receipt.png'

function makeProjectRow(overrides: Record<string, unknown> = {}) {
  return {
    id: PROJECT_ID,
    seniorId: ADMIN.id,
    companyName: 'Test Co',
    paymentType: 'FOP',
    // task-project-draft-status: required by `assertProjectActive`'s fused
    // fetch+status guard (Д2) — this suite tests receiver resolution, not
    // project confirmation, so every row here is already confirmed.
    status: 'ACTIVE',
    ...overrides,
  }
}

interface MockState {
  projectRow: ReturnType<typeof makeProjectRow> | undefined
  // `users.findFirst` is called AT MOST twice per request (ACCOUNTANT's
  // owner lookup, OR ADMIN's specific-receiver lookup — never both in the
  // same call) — a plain shift-queue, same convention as the sibling
  // `usdt-income-idempotency.unit.spec.ts` mock.
  userQueue: Array<{ id: string; role: string; archivedAt: Date | null } | undefined>
  inserts: Array<{
    table: 'transactions' | 'transactionAuditLog' | 'unknown'
    row: Record<string, unknown>
  }>
  // Captures the `where` argument of every `users.findFirst` call — the mock
  // otherwise ignores it entirely (returns the next queued row regardless of
  // what was asked for), which would let a mutant that drops the `where`
  // clause survive silently.
  usersFindFirstArgs: unknown[]
}

function makeService(initial: Partial<MockState> = {}) {
  const state: MockState = {
    projectRow: makeProjectRow(),
    userQueue: [],
    inserts: [],
    usersFindFirstArgs: [],
    ...initial,
  }

  function classify(
    row: Record<string, unknown>,
  ): 'transactions' | 'transactionAuditLog' | 'unknown' {
    if (row['type'] === 'ADMIN_INCOME') return 'transactions'
    if (row['action'] !== undefined) return 'transactionAuditLog'
    return 'unknown'
  }

  const makeInsertBuilder = () => ({
    values: (row: Record<string, unknown>) => {
      const insertedRow = { id: 'generated-tx-id', ...row }
      state.inserts.push({ table: classify(insertedRow), row: insertedRow })
      // Supports BOTH call shapes createAdminIncome/recordUnclaimedCredit use:
      //   await dbtx.insert(transactions).values({...}).returning()
      //   await dbtx.insert(transactionAuditLog).values({...})            (no .returning())
      return { returning: async () => [insertedRow] }
    },
  })

  const drizzleClient = {
    insert: () => makeInsertBuilder(),
    transaction: async (cb: (tx: unknown) => Promise<unknown>) => {
      const dbtx = { insert: () => makeInsertBuilder() }
      return cb(dbtx)
    },
    query: {
      projects: { findFirst: async () => state.projectRow },
      users: {
        findFirst: async (args: unknown) => {
          state.usersFindFirstArgs.push(args)
          return state.userQueue.shift()
        },
      },
    },
  }
  const db = { db: drizzleClient } as unknown
  const svc = makeTransactionsService({ db: db as never })
  vi.spyOn(svc, 'findOne').mockImplementation(
    async (id: string) => ({ id, type: 'ADMIN_INCOME' }) as never,
  )
  return { svc, state }
}

describe('createAdminIncome — receiver resolution (unit, mocked db)', () => {
  describe('ACCOUNTANT: cannot choose a specific admin (§2, AC10)', () => {
    it('receiverId = a specific admin uuid → ForbiddenException, nothing inserted', async () => {
      const { svc, state } = makeService({
        projectRow: makeProjectRow({ seniorId: OTHER_ADMIN_ID }),
        userQueue: [{ id: OTHER_ADMIN_ID, role: 'ADMIN', archivedAt: null }], // owner lookup
      })
      await expect(
        svc.createAdminIncome(
          {
            projectId: PROJECT_ID,
            amount: 500,
            currency: 'USD',
            receiptExternalUrl: PLAIN_URL,
            receiverId: OTHER_ADMIN_ID,
          },
          ACCOUNTANT,
        ),
      ).rejects.toThrow(
        new ForbiddenException('ACCOUNTANT cannot choose who receives ADMIN_INCOME'),
      )
      expect(state.inserts).toHaveLength(0)
    })

    it('receiverId = COMPANY_ACCOUNT_RECEIVER → allowed (not a specific-admin choice)', async () => {
      const { svc, state } = makeService({
        projectRow: makeProjectRow({ seniorId: OTHER_ADMIN_ID }),
        userQueue: [{ id: OTHER_ADMIN_ID, role: 'ADMIN', archivedAt: null }],
      })
      const res = await svc.createAdminIncome(
        {
          projectId: PROJECT_ID,
          amount: 500,
          currency: 'USD',
          receiptExternalUrl: EXPLORER_NO_HASH,
          receiverId: COMPANY_ACCOUNT_RECEIVER,
        },
        ACCOUNTANT,
      )
      expect(res).toBeDefined()
      const txInsert = state.inserts.find((i) => i.table === 'transactions')!
      expect(txInsert.row['receiverId']).toBe(ACCOUNTANT.id)
      expect(txInsert.row['fundingSource']).toBe('COMPANY_ACCOUNT')
      expect(txInsert.row['currency']).toBe('USDT')
    })

    it('receiverId undefined → legacy default, credits the project owner (unchanged behaviour)', async () => {
      const { svc, state } = makeService({
        projectRow: makeProjectRow({ seniorId: OTHER_ADMIN_ID }),
        userQueue: [{ id: OTHER_ADMIN_ID, role: 'ADMIN', archivedAt: null }],
      })
      await svc.createAdminIncome(
        { projectId: PROJECT_ID, amount: 500, currency: 'USD', receiptExternalUrl: PLAIN_URL },
        ACCOUNTANT,
      )
      const txInsert = state.inserts.find((i) => i.table === 'transactions')!
      expect(txInsert.row['receiverId']).toBe(OTHER_ADMIN_ID)
      expect(txInsert.row['fundingSource']).toBeNull()
    })
  })

  describe('ADMIN: the 3-way receiverId branch', () => {
    it('receiverId undefined → legacy default, credits self, fundingSource stays null', async () => {
      const { svc, state } = makeService({ projectRow: makeProjectRow({ seniorId: ADMIN.id }) })
      await svc.createAdminIncome(
        { projectId: PROJECT_ID, amount: 500, currency: 'USD', receiptExternalUrl: PLAIN_URL },
        ADMIN,
      )
      const txInsert = state.inserts.find((i) => i.table === 'transactions')!
      expect(txInsert.row['receiverId']).toBe(ADMIN.id)
      expect(txInsert.row['fundingSource']).toBeNull()
      expect(txInsert.row['currency']).toBe('USD')
    })

    it('receiverId = COMPANY_ACCOUNT_RECEIVER → caller is the nominal receiverId, fundingSource=COMPANY_ACCOUNT, currency forced USDT', async () => {
      const { svc, state } = makeService({ projectRow: makeProjectRow({ seniorId: ADMIN.id }) })
      await svc.createAdminIncome(
        {
          projectId: PROJECT_ID,
          amount: 500,
          currency: 'UAH',
          receiptExternalUrl: EXPLORER_NO_HASH,
          receiverId: COMPANY_ACCOUNT_RECEIVER,
        },
        ADMIN,
      )
      const txInsert = state.inserts.find((i) => i.table === 'transactions')!
      expect(txInsert.row['receiverId']).toBe(ADMIN.id)
      expect(txInsert.row['fundingSource']).toBe('COMPANY_ACCOUNT')
      expect(txInsert.row['currency']).toBe('USDT')
    })

    it('receiverId = a uuid with no matching user → BadRequestException, nothing inserted', async () => {
      const { svc, state } = makeService({
        projectRow: makeProjectRow({ seniorId: ADMIN.id }),
        userQueue: [undefined],
      })
      await expect(
        svc.createAdminIncome(
          {
            projectId: PROJECT_ID,
            amount: 500,
            currency: 'USD',
            receiptExternalUrl: PLAIN_URL,
            receiverId: OTHER_ADMIN_ID,
          },
          ADMIN,
        ),
      ).rejects.toThrow(new BadRequestException('Получатель должен быть активным администратором'))
      expect(state.inserts).toHaveLength(0)
      // The mock's `findFirst` returns the next queued row regardless of
      // ARGS — without this, a mutant that drops the `where` clause entirely
      // (`findFirst({})`) would still pass every assertion above.
      expect(state.usersFindFirstArgs[0]).toHaveProperty('where')
    })

    it('receiverId = a uuid whose user is NOT an ADMIN → BadRequestException', async () => {
      const { svc, state } = makeService({
        projectRow: makeProjectRow({ seniorId: ADMIN.id }),
        userQueue: [{ id: OTHER_ADMIN_ID, role: 'SENIOR', archivedAt: null }],
      })
      await expect(
        svc.createAdminIncome(
          {
            projectId: PROJECT_ID,
            amount: 500,
            currency: 'USD',
            receiptExternalUrl: PLAIN_URL,
            receiverId: OTHER_ADMIN_ID,
          },
          ADMIN,
        ),
      ).rejects.toThrow(new BadRequestException('Получатель должен быть активным администратором'))
      expect(state.inserts).toHaveLength(0)
      expect(state.usersFindFirstArgs[0]).toHaveProperty('where')
    })

    it('receiverId = an ARCHIVED admin → BadRequestException', async () => {
      const { svc, state } = makeService({
        projectRow: makeProjectRow({ seniorId: ADMIN.id }),
        userQueue: [{ id: OTHER_ADMIN_ID, role: 'ADMIN', archivedAt: new Date('2026-01-01') }],
      })
      await expect(
        svc.createAdminIncome(
          {
            projectId: PROJECT_ID,
            amount: 500,
            currency: 'USD',
            receiptExternalUrl: PLAIN_URL,
            receiverId: OTHER_ADMIN_ID,
          },
          ADMIN,
        ),
      ).rejects.toThrow(BadRequestException)
      expect(state.inserts).toHaveLength(0)
    })

    it('receiverId = an ACTIVE admin → credits THAT admin, fundingSource stays null, currency NOT forced', async () => {
      const { svc, state } = makeService({
        projectRow: makeProjectRow({ seniorId: ADMIN.id }),
        userQueue: [{ id: OTHER_ADMIN_ID, role: 'ADMIN', archivedAt: null }],
      })
      await svc.createAdminIncome(
        {
          projectId: PROJECT_ID,
          amount: 500,
          currency: 'UAH',
          receiptExternalUrl: PLAIN_URL,
          receiverId: OTHER_ADMIN_ID,
        },
        ADMIN,
      )
      const txInsert = state.inserts.find((i) => i.table === 'transactions')!
      expect(txInsert.row['receiverId']).toBe(OTHER_ADMIN_ID)
      expect(txInsert.row['fundingSource']).toBeNull()
      expect(txInsert.row['currency']).toBe('UAH')
    })
  })

  describe('receipt currency resolution follows fundingSource, not data.currency directly', () => {
    it('COMPANY_ACCOUNT + a non-explorer receipt → rejected (effective currency forced to USDT)', async () => {
      const { svc } = makeService({ projectRow: makeProjectRow({ seniorId: ADMIN.id }) })
      await expect(
        svc.createAdminIncome(
          {
            projectId: PROJECT_ID,
            amount: 500,
            currency: 'UAH',
            receiptExternalUrl: PLAIN_URL,
            receiverId: COMPANY_ACCOUNT_RECEIVER,
          },
          ADMIN,
        ),
      ).rejects.toThrow(BadRequestException)
    })

    it('personal (non-company) income + a non-explorer url + non-USDT currency → accepted (currency NOT forced)', async () => {
      const { svc, state } = makeService({ projectRow: makeProjectRow({ seniorId: ADMIN.id }) })
      await svc.createAdminIncome(
        { projectId: PROJECT_ID, amount: 500, currency: 'UAH', receiptExternalUrl: PLAIN_URL },
        ADMIN,
      )
      const txInsert = state.inserts.find((i) => i.table === 'transactions')!
      expect(txInsert.row['currency']).toBe('UAH')
    })
  })

  // AC4 — unit-level complement to the real-DB proof in
  // admin-income-unified.integration.spec.ts: fires identically regardless of
  // which receiverId shape the (now-irrelevant, since it throws first) caller sent.
  describe('USDT-project guard (AC4) — runs before receiverId is ever used', () => {
    it('paymentType=USDT → BadRequestException naming the correct route, nothing inserted', async () => {
      const { svc, state } = makeService({
        projectRow: makeProjectRow({ seniorId: ADMIN.id, paymentType: 'USDT' }),
      })
      await expect(
        svc.createAdminIncome(
          {
            projectId: PROJECT_ID,
            amount: 500,
            currency: 'USDT',
            receiptExternalUrl: EXPLORER_NO_HASH,
          },
          ADMIN,
        ),
      ).rejects.toThrow(/declareUsdtProjectIncome/)
      expect(state.inserts).toHaveLength(0)
    })
  })
})
