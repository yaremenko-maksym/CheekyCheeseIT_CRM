/**
 * security-review round 3 (SR-M-3, task-project-draft-status).
 * `getProjectFinanceSettings` / `upsertProjectFinanceSettings` carry no project
 * status gate: ADMIN legitimately configures finance settings before
 * confirmation (the SAME override `create()` already accepts on a still-DRAFT
 * project), so a DRAFT / ACTIVE / REJECTED project all reach the read and the
 * write. These cases pin that ADMIN keeps the right on every status.
 */
import { describe, expect, it } from 'vitest'
import type { SessionUser } from '@crm/shared'
import { makeTransactionsService } from './__test-helpers__/make-transactions-service'

const ADMIN: SessionUser = {
  id: 'admin-1',
  role: 'ADMIN',
  displayName: 'Admin',
  email: 'admin@test.spec',
  avatarUrl: null,
  avatarDocumentId: null,
  seniorSharePercent: 26,
}

function makeDb(project: { status: 'DRAFT' | 'ACTIVE' | 'REJECTED' } | undefined) {
  const db = {
    db: {
      query: {
        projects: { findFirst: async () => project },
        projectFinanceSettings: { findFirst: async () => null },
      },
      transaction: async (_fn: (tx: unknown) => Promise<unknown>) => {
        // Sentinel: the write tests assert this IS reached — it never needs to
        // resolve for real.
        throw new Error('TRANSACTION REACHED')
      },
    },
  }
  return { db }
}

describe('getProjectFinanceSettings — ADMIN reads on every project status', () => {
  for (const status of ['DRAFT', 'ACTIVE', 'REJECTED'] as const) {
    it(`ADMIN reads the settings of a ${status} project`, async () => {
      const { db } = makeDb({ status })
      const svc = makeTransactionsService({ db: db as never })
      await expect(svc.getProjectFinanceSettings('proj-1', ADMIN)).resolves.toBeNull()
    })
  }
})

describe('upsertProjectFinanceSettings — ADMIN writes on every project status', () => {
  for (const status of ['DRAFT', 'ACTIVE', 'REJECTED'] as const) {
    it(`ADMIN reaches the write (transaction) on a ${status} project`, async () => {
      const { db } = makeDb({ status })
      const svc = makeTransactionsService({ db: db as never })
      await expect(
        svc.upsertProjectFinanceSettings('proj-1', { seniorSharePercentOverride: 30 }, ADMIN),
      ).rejects.toThrow('TRANSACTION REACHED')
    })
  }
})
