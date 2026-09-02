/**
 * security-review round 3 (SR-M-1, task-project-draft-status).
 * `CredentialsService.assertAccess` did not check `project.status` — a
 * JUNIOR seated on a DRAFT/REJECTED project (`ProjectsService.addMember`
 * does not gate on status either — see `resolveJuniorSalaryReceivers`'s
 * SR-H-1 comment in transactions.service.ts for why the fix lives in the
 * resolver, not there) could see and reveal that project's credentials even
 * though the project's own card already 404s that same JUNIOR
 * (`ProjectsService.assertAccess`) — two different answers to "does this
 * project exist for you".
 *
 * No unit spec existed for `CredentialsService`'s RBAC AT ALL before this
 * file (only `credentials.rbac.integration.spec.ts`, which the mutation
 * gate structurally cannot execute — see
 * `.claude/rules/common/mutation-gate-integration-specs.md`). This file is
 * scoped to the status gate this task added, not a full backfill of the
 * pre-existing RBAC matrix (that matrix's own real-DB coverage is untouched
 * and unaffected by this change).
 *
 * Each test calls `svc.list(...)` exactly ONCE (a single rejection is
 * captured, then both its type and message are asserted on the same catch)
 * — `limit` below is a one-shot queue (`mockResolvedValueOnce` per expected
 * `.limit()` call in THAT test's own call path), which cannot support a
 * second invocation of the method under test.
 */
import { NotFoundException, ForbiddenException } from '@nestjs/common'
import { describe, expect, it, vi } from 'vitest'
import type { SessionUser } from '@crm/shared'
import { HrAccessService } from '../common/hr-access.service'
import { CredentialsService } from './credentials.service'
import { CredentialsCryptoService } from './credentials-crypto.service'

const ADMIN: SessionUser = {
  id: 'admin-1',
  role: 'ADMIN',
  displayName: 'Admin',
  email: 'admin@test.spec',
  avatarUrl: null,
  avatarDocumentId: null,
  seniorSharePercent: 26,
}
const JUNIOR: SessionUser = {
  id: 'junior-1',
  role: 'JUNIOR',
  displayName: 'Junior',
  email: 'junior@test.spec',
  avatarUrl: null,
  avatarDocumentId: null,
  seniorSharePercent: 26,
}

const PROJECT_ID = 'proj-1'

/**
 * `db.db.select(...).from(...).where(...).limit(...)` — one shared chain;
 * `limit` is a queue, resolved in the exact order the code under test calls
 * it (`assertAccess`'s project-row select first, then — only if the status
 * gate lets execution continue — `juniorIsActiveMember`'s membership select,
 * then — only past `canAccess` — `list`'s own credentials select).
 */
function makeSvc(...limitResolutions: unknown[][]) {
  const limit = vi.fn()
  for (const rows of limitResolutions) limit.mockResolvedValueOnce(rows)
  const chain = {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    // `list()`'s own credentials query terminates at `.orderBy(...)`
    // directly (no `.limit()`) — resolves empty by default; a test that
    // needs `list()` to actually reach this far overrides it.
    orderBy: vi.fn().mockResolvedValue([]),
    limit,
  }
  const db = { db: { select: vi.fn(() => chain) } }
  const crypto = {} as CredentialsCryptoService
  const hrAccess = new HrAccessService(db as never)
  const svc = new CredentialsService(db as never, crypto, hrAccess)
  return { svc, limit }
}

describe('CredentialsService.list — SR-M-1: a non-ACTIVE project is invisible to a JUNIOR member', () => {
  for (const status of ['DRAFT', 'REJECTED']) {
    it(`JUNIOR gets NotFoundException on a ${status} project — never reaches the membership check`, async () => {
      const { svc, limit } = makeSvc([{ id: PROJECT_ID, seniorId: 'senior-1', status }])

      const err = await svc.list(JUNIOR, PROJECT_ID).catch((e: unknown) => e)

      expect(err).toBeInstanceOf(NotFoundException)
      expect((err as NotFoundException).message).toBe('Проект не найден')
      // Exactly one .limit() call (the project fetch) — the status gate
      // short-circuited before juniorIsActiveMember's own select ran.
      expect(limit).toHaveBeenCalledTimes(1)
    })
  }

  it('an ACTIVE project still enforces real JUNIOR membership (the gate did not swallow the RBAC check)', async () => {
    const { svc } = makeSvc(
      [{ id: PROJECT_ID, seniorId: 'senior-1', status: 'ACTIVE' }], // project select
      [], // juniorIsActiveMember select — no membership row
    )

    const err = await svc.list(JUNIOR, PROJECT_ID).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(ForbiddenException)
  })

  it('ADMIN is exempt from the status gate on a DRAFT project', async () => {
    const { svc } = makeSvc([{ id: PROJECT_ID, seniorId: 'senior-1', status: 'DRAFT' }])

    await expect(svc.list(ADMIN, PROJECT_ID)).resolves.toEqual([])
  })

  it('refuses with NotFoundException when the project does not exist at all — same message as the status gate', async () => {
    const { svc } = makeSvc([]) // no project row

    const err = await svc.list(JUNIOR, PROJECT_ID).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(NotFoundException)
    expect((err as NotFoundException).message).toBe('Проект не найден')
  })
})
