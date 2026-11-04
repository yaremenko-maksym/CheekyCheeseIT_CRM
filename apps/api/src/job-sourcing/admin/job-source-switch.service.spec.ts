import { ForbiddenException, HttpException } from '@nestjs/common'
import type { SessionUser } from '@crm/shared'
import { describe, expect, it, vi } from 'vitest'
import type { DatabaseService } from '../../database/database.service'
import type { JobRunLedger, SwitchOutcome } from '../ownership/job-run-ledger'
import { JobSourceAdminService } from './job-source-admin.service'

/**
 * r5 Task 6.5 — the service half of the source switch: the role check in the service body (the
 * guard is not trusted alone) and the mapping of the ledger's outcome onto the typed codes. The
 * ledger's transaction is pinned by job-run-ledger.switch(.integration).spec.ts.
 */

const ADMIN: SessionUser = {
  id: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
  email: 'admin@test.spec',
  displayName: 'Admin',
  avatarUrl: null,
  role: 'ADMIN',
  seniorSharePercent: 0,
  legalFullName: null,
}
const NON_ADMIN: SessionUser['role'][] = ['SENIOR', 'JUNIOR', 'HR', 'ACCOUNTANT', 'DROP']
const SOURCE = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'

function harness(outcome: SwitchOutcome) {
  const setEnabled = vi.fn(async () => outcome)
  const execute = vi.fn()
  const service = new JobSourceAdminService(
    { db: { execute } } as unknown as DatabaseService,
    { setEnabled } as unknown as JobRunLedger,
  )
  return { service, setEnabled, execute }
}

async function httpError(p: Promise<unknown>): Promise<{ status: number; code: unknown }> {
  try {
    await p
  } catch (e) {
    if (e instanceof HttpException) {
      return { status: e.getStatus(), code: (e.getResponse() as { code?: unknown }).code }
    }
    throw e
  }
  throw new Error('expected a rejection')
}

describe('JobSourceAdminService.setEnabled — role check in the service body', () => {
  it.each(NON_ADMIN)('%s is refused before the ledger is called', async (role) => {
    const h = harness({ kind: 'SWITCHED', changed: true, cancelledRuns: 0 })
    await expect(
      h.service.setEnabled(SOURCE, { enabled: true }, { ...ADMIN, role }),
    ).rejects.toThrow(new ForbiddenException('Job source controls are ADMIN only'))
    expect(h.setEnabled).not.toHaveBeenCalled()
    expect(h.execute).not.toHaveBeenCalled()
  })
})

describe('JobSourceAdminService.setEnabled — the outcome mapping', () => {
  it('passes the lower-cased id, the actor and the value', async () => {
    const h = harness({ kind: 'SWITCHED', changed: true, cancelledRuns: 0 })
    await h.service.setEnabled(SOURCE.toUpperCase(), { enabled: false }, ADMIN)
    expect(h.setEnabled).toHaveBeenCalledWith({ sourceId: SOURCE, actor: ADMIN.id, enabled: false })
  })

  it.each([
    [true, { kind: 'SWITCHED', changed: true, cancelledRuns: 0 } as const],
    [false, { kind: 'SWITCHED', changed: true, cancelledRuns: 2 } as const],
    [false, { kind: 'SWITCHED', changed: false, cancelledRuns: 0 } as const],
  ])('enabled=%s, %j -> the switch result', async (enabled, outcome) => {
    const h = harness(outcome)
    expect(await h.service.setEnabled(SOURCE, { enabled }, ADMIN)).toEqual({
      id: SOURCE,
      enabled,
      changed: outcome.changed,
      cancelledRuns: outcome.cancelledRuns,
    })
  })

  it('an unknown source is 404 JOB_SOURCE_NOT_FOUND', async () => {
    const h = harness({ kind: 'NOT_FOUND' })
    expect(await httpError(h.service.setEnabled(SOURCE, { enabled: true }, ADMIN))).toEqual({
      status: 404,
      code: 'JOB_SOURCE_NOT_FOUND',
    })
  })

  it('a readiness refusal is 409 JOB_SOURCE_NOT_READY', async () => {
    const h = harness({ kind: 'REFUSED', reason: 'NOT_READY' })
    expect(await httpError(h.service.setEnabled(SOURCE, { enabled: true }, ADMIN))).toEqual({
      status: 409,
      code: 'JOB_SOURCE_NOT_READY',
    })
  })

  it('an access pause is 409 JOB_SOURCE_AUTH_PAUSED', async () => {
    const h = harness({ kind: 'REFUSED', reason: 'AUTH_PAUSED' })
    expect(await httpError(h.service.setEnabled(SOURCE, { enabled: true }, ADMIN))).toEqual({
      status: 409,
      code: 'JOB_SOURCE_AUTH_PAUSED',
    })
  })
})
