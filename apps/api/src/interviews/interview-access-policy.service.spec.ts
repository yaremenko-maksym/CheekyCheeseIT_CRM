import { ForbiddenException, HttpException } from '@nestjs/common'
import type { SessionUser } from '@crm/shared'
import { PgDialect } from 'drizzle-orm/pg-core'
import { describe, expect, it, vi } from 'vitest'

import { DatabaseService } from '../database/database.service'
import { InterviewAccessPolicyService } from './interview-access-policy.service'

const HR: SessionUser = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'hr@policy.test',
  displayName: 'HR',
  avatarUrl: null,
  role: 'HR',
  seniorSharePercent: 0,
  locale: 'uk',
  legalFullName: null,
}

const SENIOR: SessionUser = {
  ...HR,
  id: '22222222-2222-4222-8222-222222222222',
  email: 'senior@policy.test',
  displayName: 'Senior',
  role: 'SENIOR',
  seniorSharePercent: 26,
}

function makePolicy(options?: { activeTeamRows?: unknown[]; memberships?: unknown[] }) {
  const limit = vi.fn().mockResolvedValue(options?.activeTeamRows ?? [])
  const where = vi.fn(() => ({ limit }))
  const from = vi.fn(() => ({ where }))
  const select = vi.fn(() => ({ from }))
  const findMany = vi.fn().mockResolvedValue(options?.memberships ?? [])
  const db = {
    db: {
      select,
      query: { teamMembers: { findMany } },
    },
  } as unknown as DatabaseService

  return { policy: new InterviewAccessPolicyService(db), findMany }
}

describe('InterviewAccessPolicyService', () => {
  it('blocks a teamless SENIOR with the existing INTERVIEW_NO_ACTIVE_TEAM error', async () => {
    const { policy } = makePolicy()
    const error = await policy.assertSeniorHasActiveTeam(SENIOR.id).then(
      () => null,
      (reason: unknown) => reason,
    )

    expect(error).toBeInstanceOf(HttpException)
    expect((error as HttpException).getStatus()).toBe(403)
    expect((error as HttpException).getResponse()).toMatchObject({
      code: 'INTERVIEW_NO_ACTIVE_TEAM',
    })
  })

  it('accepts a SENIOR with an active membership', async () => {
    const { policy } = makePolicy({ activeTeamRows: [{ id: 'membership' }] })
    await expect(policy.assertSeniorHasActiveTeam(SENIOR.id)).resolves.toBeUndefined()
  })

  it('returns only active SENIOR members and scopes the HR lookup to active memberships', async () => {
    const activeSeniorId = '33333333-3333-4333-8333-333333333333'
    const leftSeniorId = '44444444-4444-4444-8444-444444444444'
    const { policy, findMany } = makePolicy({
      memberships: [
        {
          team: {
            members: [
              { userId: activeSeniorId, leftAt: null, user: { role: 'SENIOR' } },
              { userId: leftSeniorId, leftAt: new Date(), user: { role: 'SENIOR' } },
              { userId: HR.id, leftAt: null, user: { role: 'HR' } },
              {
                userId: '77777777-7777-4777-8777-777777777777',
                leftAt: null,
                user: null,
              },
            ],
          },
        },
      ],
    })

    await expect(policy.getAccessibleSeniorIds(HR)).resolves.toEqual(new Set([activeSeniorId]))

    const query = findMany.mock.calls[0]![0] as { where: Parameters<PgDialect['sqlToQuery']>[0] }
    const compiled = new PgDialect().sqlToQuery(query.where)
    expect(compiled.sql.replace(/"/g, '')).toContain('team_members.left_at is null')
    expect(compiled.params).toContain(HR.id)
    expect(query).toMatchObject({
      with: {
        team: {
          with: {
            members: {
              with: { user: true },
            },
          },
        },
      },
    })
  })

  it('preserves update semantics for ADMIN, SENIOR ownership/team status, and HR team scope', async () => {
    const { policy } = makePolicy()
    const activeTeam = vi.spyOn(policy, 'assertSeniorHasActiveTeam').mockResolvedValue()
    const accessible = vi
      .spyOn(policy, 'getAccessibleSeniorIds')
      .mockResolvedValue(new Set([SENIOR.id]))

    await expect(
      policy.assertUpdateAccess({ seniorId: SENIOR.id }, { ...HR, role: 'ADMIN' }),
    ).resolves.toBeUndefined()
    await expect(
      policy.assertUpdateAccess({ seniorId: SENIOR.id }, SENIOR),
    ).resolves.toBeUndefined()
    expect(activeTeam).toHaveBeenCalledWith(SENIOR.id)

    await expect(
      policy.assertUpdateAccess({ seniorId: '55555555-5555-4555-8555-555555555555' }, SENIOR),
    ).rejects.toBeInstanceOf(ForbiddenException)

    await expect(policy.assertUpdateAccess({ seniorId: SENIOR.id }, HR)).resolves.toBeUndefined()
    expect(accessible).toHaveBeenCalledWith(HR)

    await expect(
      policy.assertUpdateAccess({ seniorId: '66666666-6666-4666-8666-666666666666' }, HR),
    ).rejects.toBeInstanceOf(ForbiddenException)

    accessible.mockResolvedValue(new Set([SENIOR.id]))
    await expect(
      policy.assertUpdateAccess({ seniorId: SENIOR.id }, { ...HR, role: 'ACCOUNTANT' }),
    ).rejects.toBeInstanceOf(ForbiddenException)
  })
})
