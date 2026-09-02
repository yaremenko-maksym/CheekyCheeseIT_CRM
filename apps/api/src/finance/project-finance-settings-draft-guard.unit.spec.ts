/**
 * security-review round 3 (SR-M-3, task-project-draft-status).
 * `getProjectFinanceSettings` / `upsertProjectFinanceSettings` let ACCOUNTANT
 * read and WRITE finance settings (including the senior-share override) for
 * a project `ProjectsService.assertAccess` would already 404 them on
 * directly — a DRAFT/REJECTED project, since ACCOUNTANT is neither ADMIN nor
 * an invited approver (see that method's own existence-oracle comment).
 * ADMIN is exempt (mirrors `assertAccess`'s own ADMIN exemption) — an admin
 * legitimately configures finance settings before confirmation, the SAME
 * override `create()` already accepts on a still-DRAFT project.
 */
import { NotFoundException } from '@nestjs/common'
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
const ACCOUNTANT: SessionUser = {
  id: 'accountant-1',
  role: 'ACCOUNTANT',
  displayName: 'Accountant',
  email: 'accountant@test.spec',
  avatarUrl: null,
  avatarDocumentId: null,
  seniorSharePercent: 26,
}

function makeDb(project: { status: 'DRAFT' | 'ACTIVE' | 'REJECTED' } | undefined) {
  return {
    db: {
      query: {
        projects: { findFirst: async () => project },
        projectFinanceSettings: { findFirst: async () => null },
      },
      transaction: async (_fn: (tx: unknown) => Promise<unknown>) => {
        // Sentinel: every test in this file asserts either the status gate
        // fires BEFORE this is reached (NotFoundException) or that it IS
        // reached (positive control) — never needs to resolve for real.
        throw new Error('TRANSACTION REACHED')
      },
    },
  }
}

describe('getProjectFinanceSettings — SR-M-3: ACCOUNTANT cannot read a non-ACTIVE project', () => {
  for (const status of ['DRAFT', 'REJECTED'] as const) {
    it(`ACCOUNTANT refused with NotFoundException on a ${status} project`, async () => {
      const svc = makeTransactionsService({ db: makeDb({ status }) as never })
      await expect(svc.getProjectFinanceSettings('proj-1', ACCOUNTANT)).rejects.toBeInstanceOf(
        NotFoundException,
      )
    })
  }

  it('ACCOUNTANT refused with NotFoundException when the project does not exist at all', async () => {
    const svc = makeTransactionsService({ db: makeDb(undefined) as never })
    await expect(svc.getProjectFinanceSettings('proj-1', ACCOUNTANT)).rejects.toBeInstanceOf(
      NotFoundException,
    )
  })

  it('ACCOUNTANT succeeds on an ACTIVE project (positive control — the gate is not blanket-refusing)', async () => {
    const svc = makeTransactionsService({ db: makeDb({ status: 'ACTIVE' }) as never })
    await expect(svc.getProjectFinanceSettings('proj-1', ACCOUNTANT)).resolves.toBeNull()
  })

  for (const status of ['DRAFT', 'ACTIVE', 'REJECTED'] as const) {
    it(`ADMIN is exempt from the status gate on a ${status} project`, async () => {
      const svc = makeTransactionsService({ db: makeDb({ status }) as never })
      await expect(svc.getProjectFinanceSettings('proj-1', ADMIN)).resolves.toBeNull()
    })
  }
})

describe('upsertProjectFinanceSettings — SR-M-3: ACCOUNTANT cannot write a non-ACTIVE project', () => {
  for (const status of ['DRAFT', 'REJECTED'] as const) {
    it(`ACCOUNTANT refused with NotFoundException on a ${status} project; never reaches the write`, async () => {
      const svc = makeTransactionsService({ db: makeDb({ status }) as never })
      await expect(
        svc.upsertProjectFinanceSettings('proj-1', { seniorSharePercentOverride: 30 }, ACCOUNTANT),
      ).rejects.toBeInstanceOf(NotFoundException)
    })
  }

  it('ADMIN reaches the write (transaction) on a DRAFT project — the gate does not block ADMIN', async () => {
    const svc = makeTransactionsService({ db: makeDb({ status: 'DRAFT' }) as never })
    await expect(
      svc.upsertProjectFinanceSettings('proj-1', { seniorSharePercentOverride: 30 }, ADMIN),
    ).rejects.toThrow('TRANSACTION REACHED')
  })

  it('ACCOUNTANT reaches the write (transaction) on an ACTIVE project — positive control', async () => {
    const svc = makeTransactionsService({ db: makeDb({ status: 'ACTIVE' }) as never })
    await expect(
      svc.upsertProjectFinanceSettings('proj-1', { seniorSharePercentOverride: 30 }, ACCOUNTANT),
    ).rejects.toThrow('TRANSACTION REACHED')
  })
})
