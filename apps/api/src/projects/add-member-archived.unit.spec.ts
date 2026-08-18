/**
 * task-archived-user-completeness — AC1, unit-level.
 *
 * The behaviour is proven end-to-end in
 * `users/archived-entitlement.realdb.integration.spec.ts` (real services, real
 * Postgres, membership row read back). This file adds the unit-level twin for
 * the same reason as `finance/archived-money-out.unit.spec.ts`: integration
 * specs are excluded from discovery on any vitest run without the
 * `integration.spec` filter, which is every run the mutation gate and the
 * unit-only CI job make — so without this, deleting the guard is a change no
 * gate rejects.
 *
 * WHY THE GUARD IS HERE AT ALL. A `project_members` row with `left_at IS NULL`
 * is an accrual subscription: `createMonthlySalaries` walks exactly that set
 * and mints a fresh PENDING salary for the junior on it every month. Adding a
 * dismissed junior back is therefore not a bookkeeping detail, it is a standing
 * order to pay them.
 */
import { describe, expect, it, vi } from 'vitest'
import type { SessionUser } from '@crm/shared'

import { ProjectsService } from './projects.service'

const ADMIN: SessionUser = {
  id: '22222222-0000-4000-aa00-000000000001',
  email: 'add-member-archived-admin@test.spec',
  displayName: 'Admin',
  avatarUrl: null,
  role: 'ADMIN',
  seniorSharePercent: 0,
  legalFullName: null,
}
const PROJECT_ID = '22222222-0000-4000-dd00-000000000001'
const USER_ID = '22222222-0000-4000-aa00-000000000002'

const juniorRow = {
  id: USER_ID,
  role: 'JUNIOR' as const,
  archivedAt: null as Date | null,
}

/**
 * Answers the project + user lookups `addMember` makes before the guard, and
 * throws on the INSERT. A permissive insert stub would let a removed guard look
 * like a pass; a loud one keeps the refusal assertion meaningful and doubles as
 * the control's expected outcome.
 */
function makeDb(userRow: unknown) {
  return {
    db: {
      query: {
        projects: {
          findFirst: vi.fn().mockResolvedValue({
            id: PROJECT_ID,
            seniorId: '22222222-0000-4000-aa00-000000000003',
            senior: null,
            drop: null,
            members: [],
          }),
        },
        users: { findFirst: vi.fn().mockResolvedValue(userRow) },
        projectMembers: { findFirst: vi.fn().mockResolvedValue(undefined) },
      },
      insert: vi.fn(() => {
        throw new Error('INSERT REACHED — guard did not fire')
      }),
    },
  } as never
}

function makeService(userRow: unknown): ProjectsService {
  return new ProjectsService(makeDb(userRow), {} as never, {} as never, {} as never)
}

describe('AC1 — addMember refuses an archived user', () => {
  it('refuses, and never reaches the INSERT that opens the accrual subscription', async () => {
    const svc = makeService({ ...juniorRow, archivedAt: new Date('2026-01-31T00:00:00.000Z') })

    await expect(svc.addMember(PROJECT_ID, USER_ID, ADMIN)).rejects.toThrow(/добавить в проект/)
  })

  it('CONTROL: the identical call for an ACTIVE user reaches the INSERT', async () => {
    // Same fixture with one flag cleared — so the refusal above is attributable
    // to `archivedAt` and not to any other precondition of this endpoint.
    const svc = makeService(juniorRow)

    await expect(svc.addMember(PROJECT_ID, USER_ID, ADMIN)).rejects.toThrow(/INSERT REACHED/)
  })
})
