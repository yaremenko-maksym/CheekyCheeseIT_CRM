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
import { describe, expect, it, vi } from 'vitest'
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
  const projectsFindFirst = vi.fn(async () => project)
  const db = {
    db: {
      query: {
        projects: { findFirst: projectsFindFirst },
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
  return { db, projectsFindFirst }
}

describe('getProjectFinanceSettings — SR-M-3: ACCOUNTANT cannot read a non-ACTIVE project', () => {
  for (const status of ['DRAFT', 'REJECTED'] as const) {
    it(`ACCOUNTANT refused with NotFoundException on a ${status} project`, async () => {
      const { db } = makeDb({ status })
      const svc = makeTransactionsService({ db: db as never })
      const err = await svc.getProjectFinanceSettings('proj-1', ACCOUNTANT).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(NotFoundException)
      expect((err as NotFoundException).message).toBe('Project not found')
    })
  }

  it('the project fetch is scoped to THIS project id and reads status (not an unscoped/columnless read)', async () => {
    const { db, projectsFindFirst } = makeDb({ status: 'DRAFT' })
    const svc = makeTransactionsService({ db: db as never })
    await svc.getProjectFinanceSettings('proj-1', ACCOUNTANT).catch(() => undefined)

    expect(projectsFindFirst).toHaveBeenCalledTimes(1)
    const callArg = projectsFindFirst.mock.calls[0]?.[0] as
      | { where?: unknown; columns?: unknown }
      | undefined
    expect(callArg).toBeDefined()
    expect(callArg!.where).toBeDefined()
    // columns is a PLAIN object (not a Drizzle SQL expression) — exact-match
    // kills the ObjectLiteral->{} mutant, which would fetch every column
    // instead of the one this gate actually reads.
    expect(callArg!.columns).toEqual({ status: true })
  })

  it('ACCOUNTANT refused with NotFoundException when the project does not exist at all', async () => {
    const { db } = makeDb(undefined)
    const svc = makeTransactionsService({ db: db as never })
    const err = await svc.getProjectFinanceSettings('proj-1', ACCOUNTANT).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(NotFoundException)
    expect((err as NotFoundException).message).toBe('Project not found')
  })

  it('ACCOUNTANT succeeds on an ACTIVE project (positive control — the gate is not blanket-refusing)', async () => {
    const { db } = makeDb({ status: 'ACTIVE' })
    const svc = makeTransactionsService({ db: db as never })
    await expect(svc.getProjectFinanceSettings('proj-1', ACCOUNTANT)).resolves.toBeNull()
  })

  for (const status of ['DRAFT', 'ACTIVE', 'REJECTED'] as const) {
    it(`ADMIN is exempt from the status gate on a ${status} project`, async () => {
      const { db } = makeDb({ status })
      const svc = makeTransactionsService({ db: db as never })
      await expect(svc.getProjectFinanceSettings('proj-1', ADMIN)).resolves.toBeNull()
    })
  }
})

describe('upsertProjectFinanceSettings — SR-M-3: ACCOUNTANT cannot write a non-ACTIVE project', () => {
  for (const status of ['DRAFT', 'REJECTED'] as const) {
    it(`ACCOUNTANT refused with NotFoundException on a ${status} project; never reaches the write`, async () => {
      const { db } = makeDb({ status })
      const svc = makeTransactionsService({ db: db as never })
      const err = await svc
        .upsertProjectFinanceSettings('proj-1', { seniorSharePercentOverride: 30 }, ACCOUNTANT)
        .catch((e: unknown) => e)
      expect(err).toBeInstanceOf(NotFoundException)
      expect((err as NotFoundException).message).toBe('Project not found')
    })
  }

  it('ADMIN reaches the write (transaction) on a DRAFT project — the gate does not block ADMIN', async () => {
    const { db } = makeDb({ status: 'DRAFT' })
    const svc = makeTransactionsService({ db: db as never })
    await expect(
      svc.upsertProjectFinanceSettings('proj-1', { seniorSharePercentOverride: 30 }, ADMIN),
    ).rejects.toThrow('TRANSACTION REACHED')
  })

  it('ACCOUNTANT reaches the write (transaction) on an ACTIVE project — positive control', async () => {
    const { db } = makeDb({ status: 'ACTIVE' })
    const svc = makeTransactionsService({ db: db as never })
    await expect(
      svc.upsertProjectFinanceSettings('proj-1', { seniorSharePercentOverride: 30 }, ACCOUNTANT),
    ).rejects.toThrow('TRANSACTION REACHED')
  })
})
