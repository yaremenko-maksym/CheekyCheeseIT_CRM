/**
 * Unit tests for AC4 (task-project-draft-status, decision Д2): "Транзакция
 * на проект в статусе DRAFT или REJECTED отбивается на сервере". Covers all
 * FOUR transaction-creation entry points that take a `projectId` —
 * createAdminIncome, declareUsdtProjectIncome, createSeniorIncome,
 * createDropIncome — each on BOTH refused statuses.
 *
 * Each test asserts the SPECIFIC `PROJECT_NOT_ACTIVE_MESSAGE` (not just "any
 * BadRequestException") — the fixture is otherwise valid for that entry
 * point's OWN later checks (payment type, ownership, receipt), so a pass
 * here proves the Д2 gate fired, not some other guard down the line.
 *
 * The ACTIVE-status happy path for each of these four methods is already
 * exercised end-to-end by admin-income-unified.unit.spec.ts /
 * senior-summary.unit.spec.ts / pending-accrual-archived-guard.unit.spec.ts
 * (all of which now require `status: 'ACTIVE'` on their project fixtures —
 * see those files' own task-project-draft-status comments) — not duplicated
 * here.
 */
import { BadRequestException } from '@nestjs/common'
import { describe, expect, it } from 'vitest'
import type { SessionUser } from '@crm/shared'
import { makeTransactionsService } from './__test-helpers__/make-transactions-service'
import { PROJECT_NOT_ACTIVE_MESSAGE } from '../projects/project-status.util'

const ADMIN: SessionUser = {
  id: 'admin-1',
  role: 'ADMIN',
  displayName: 'Admin',
  email: 'admin@test.spec',
  avatarUrl: null,
  avatarDocumentId: null,
  seniorSharePercent: 26,
}
const SENIOR: SessionUser = {
  id: 'senior-1',
  role: 'SENIOR',
  displayName: 'Senior',
  email: 'senior@test.spec',
  avatarUrl: null,
  avatarDocumentId: null,
  seniorSharePercent: 26,
}
const DROP: SessionUser = {
  id: 'drop-1',
  role: 'DROP',
  displayName: 'Drop',
  email: 'drop@test.spec',
  avatarUrl: null,
  avatarDocumentId: null,
  seniorSharePercent: 26,
}

/**
 * A DB stub whose `projects.findFirst` returns a project row consistent
 * with EVERY entry point's own later RBAC checks (seniorId=SENIOR.id,
 * dropId=DROP.id, paymentType=FOP so the USDT-only/FOP-only gates never
 * fire first) — the ONLY thing that varies is `status`, so a thrown
 * BadRequestException can only be attributed to the Д2 guard.
 */
function makeDb(status: 'DRAFT' | 'REJECTED' | 'ACTIVE') {
  return {
    db: {
      query: {
        // No idempotency replay for any of the four entry points.
        transactions: { findFirst: async () => undefined },
        projects: {
          findFirst: async () => ({
            id: 'proj-1',
            seniorId: SENIOR.id,
            dropId: DROP.id,
            paymentType: 'FOP',
            status,
            financeSettings: null,
          }),
        },
        users: { findFirst: async () => ({ ...SENIOR, archivedAt: null }) },
      },
    },
  }
}

const BASE_PAYLOAD = {
  projectId: 'proj-1',
  amount: 100,
  currency: 'USD',
  idempotencyKey: 'idem-key-1',
}

describe('Д2 — transaction creation refuses a DRAFT or REJECTED project', () => {
  for (const status of ['DRAFT', 'REJECTED'] as const) {
    it(`createAdminIncome refuses a ${status} project`, async () => {
      const svc = makeTransactionsService({ db: makeDb(status) as never })
      await expect(svc.createAdminIncome(BASE_PAYLOAD, ADMIN)).rejects.toThrow(
        PROJECT_NOT_ACTIVE_MESSAGE,
      )
      await expect(svc.createAdminIncome(BASE_PAYLOAD, ADMIN)).rejects.toBeInstanceOf(
        BadRequestException,
      )
    })

    it(`declareUsdtProjectIncome refuses a ${status} project`, async () => {
      const svc = makeTransactionsService({ db: makeDb(status) as never })
      await expect(
        svc.declareUsdtProjectIncome(
          {
            ...BASE_PAYLOAD,
            receiverId: ADMIN.id,
            // Valid explorer-only receipt so receiptMandatoryError never
            // fires first — isolates the assertion to the Д2 gate.
            receiptExternalUrl: 'https://etherscan.io/address/0xabc',
          },
          ADMIN,
        ),
      ).rejects.toThrow(PROJECT_NOT_ACTIVE_MESSAGE)
    })

    it(`createSeniorIncome refuses a ${status} project`, async () => {
      const svc = makeTransactionsService({ db: makeDb(status) as never })
      await expect(svc.createSeniorIncome(BASE_PAYLOAD, SENIOR)).rejects.toThrow(
        PROJECT_NOT_ACTIVE_MESSAGE,
      )
    })

    it(`createDropIncome refuses a ${status} project`, async () => {
      const svc = makeTransactionsService({ db: makeDb(status) as never })
      await expect(svc.createDropIncome(BASE_PAYLOAD, DROP)).rejects.toThrow(
        PROJECT_NOT_ACTIVE_MESSAGE,
      )
    })
  }
})
