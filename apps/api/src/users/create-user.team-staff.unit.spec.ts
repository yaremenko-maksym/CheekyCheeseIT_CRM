/**
 * SR-M-1 (security-review #990): team-staff role validation + HR self-only
 * enrollment in `UsersService.createUser`'s CREATE_NEW branch, plus the SR-M-2
 * creation-time share pin. Same recording-double harness as the
 * characterization spec (create-user.unit.spec.ts).
 */
import { describe, expect, it, vi } from 'vitest'
import {
  CREATED,
  baseInput,
  code,
  inserts,
  makeHarness,
  usersInsertValues,
  type CreateUserInput,
  type Log,
} from '../test/create-user-harness'
// r5 4.6 S5: the roster dirty producers are proven in job-sourcing; here they are inert.
vi.mock('../job-sourcing/dirty-producers')

const senior = { ...CREATED, role: 'SENIOR' }
const STAFF = {
  'hr-1': 'HR',
  'hr-2': 'HR',
  'hr-9': 'HR',
  'adm-1': 'ADMIN',
  'jun-1': 'JUNIOR',
  'sen-1': 'SENIOR',
}
type Harness = ReturnType<typeof makeHarness>

const memberIds = (log: Log) =>
  inserts(log, 'team_members').map((m) => (m.values as { userId: string }).userId)
const roleProbes = (log: Log) =>
  log.filter((e) => e.op === 'select' && String(e.where).includes(' in ('))
const nothingWritten = (h: Harness) => {
  expect(h.db.transaction).not.toHaveBeenCalled()
  expect(inserts(h.log, 'users')).toHaveLength(0)
  expect(inserts(h.log, 'teams')).toHaveLength(0)
  expect(inserts(h.log, 'team_members')).toHaveLength(0)
  expect(h.auditRecord).not.toHaveBeenCalled()
}
const create = (h: Harness, over: Partial<CreateUserInput>) =>
  h.service.createUser(baseInput({ role: 'SENIOR', ...over }))
const withStaff = () => makeHarness({ created: senior, staffRoles: STAFF })

describe('createUser team staff — role invariant (ADMIN actor)', () => {
  it.each(['adm-1', 'jun-1', 'sen-1', 'ghost'])(
    'non-HR hrIds entry %s -> 400 TEAM_HR_MEMBER_MUST_BE_HR, nothing written',
    async (bad) => {
      const h = withStaff()
      await expect(create(h, { hrIds: ['hr-1', bad] })).rejects.toMatchObject(
        code('TEAM_HR_MEMBER_MUST_BE_HR', 400),
      )
      nothingWritten(h)
    },
  )

  it('valid staff: ONE role probe over hrIds, everyone enrolled in order', async () => {
    const h = withStaff()
    await create(h, { hrIds: ['hr-1', 'hr-2'] })
    expect(roleProbes(h.log)).toEqual([
      {
        op: 'select',
        table: 'users',
        where: '("users"."id" in ($1, $2) and "users"."archived_at" is null)',
        params: ['hr-1', 'hr-2'],
      },
    ])
    expect(memberIds(h.log)).toEqual(['user-new', 'hr-1', 'hr-2'])
  })

  it('no hrIds: no role probe at all', async () => {
    const h = makeHarness({ created: senior })
    await create(h, {})
    expect(roleProbes(h.log)).toEqual([])
    expect(memberIds(h.log)).toEqual(['user-new'])
  })

  it('duplicate hrIds are probed and enrolled once', async () => {
    const h = withStaff()
    await create(h, { hrIds: ['hr-1', 'hr-1'] })
    expect(roleProbes(h.log)[0]).toMatchObject({ params: ['hr-1'] })
    expect(memberIds(h.log)).toEqual(['user-new', 'hr-1'])
  })

  it('the role probe runs before the email pre-flight', async () => {
    const h = withStaff()
    await expect(create(h, { hrIds: ['adm-1'] })).rejects.toMatchObject(
      code('TEAM_HR_MEMBER_MUST_BE_HR', 400),
    )
    expect(h.log.some((e) => e.where === '"users"."email" = $1')).toBe(false)
  })

  it('JOIN_DROP_TEAM is not subject to staff validation (hrIds unused there)', async () => {
    const h = makeHarness({ created: senior, isMember: true })
    await create(h, {
      actorRole: 'HR',
      actorId: 'hr-9',
      teamMode: 'JOIN_DROP_TEAM',
      dropTeamId: 'dt-1',
      hrIds: ['adm-1'],
    })
    expect(roleProbes(h.log)).toEqual([])
    expect(h.addSeniorToDropTeam).toHaveBeenCalledWith('dt-1', 'user-new')
  })
})

describe('createUser team staff — archived users are not enrollable (CR-M-1 / SR-L-1)', () => {
  const withArchived = (...archivedStaffIds: string[]) =>
    makeHarness({ created: senior, staffRoles: STAFF, archivedStaffIds })

  it('an archived HR in hrIds -> 400 TEAM_HR_MEMBER_MUST_BE_HR, nothing written', async () => {
    const h = withArchived('hr-2')
    await expect(create(h, { hrIds: ['hr-1', 'hr-2'] })).rejects.toMatchObject(
      code('TEAM_HR_MEMBER_MUST_BE_HR', 400),
    )
    nothingWritten(h)
  })

  it('the probe WHERE carries the archived_at IS NULL predicate', async () => {
    const h = withArchived()
    await create(h, { hrIds: ['hr-1'] })
    expect(roleProbes(h.log)[0]).toMatchObject({
      where: expect.stringContaining('"users"."archived_at" is null'),
    })
  })

  it('an archived acting HR is rejected too', async () => {
    const h = withArchived('hr-9')
    await expect(create(h, { actorRole: 'HR', actorId: 'hr-9' })).rejects.toMatchObject(
      code('TEAM_HR_MEMBER_MUST_BE_HR', 400),
    )
    nothingWritten(h)
  })
})

describe('createUser team staff — HR actor self-only', () => {
  const hr = { actorRole: 'HR', actorId: 'hr-9' } as const

  it.each([[['hr-1']], [['hr-9', 'hr-1']], [['hr-1', 'hr-9']], [['adm-1']]])(
    'hrIds %j contains someone other than the acting HR -> 403 HR_TEAM_SELF_ONLY before any db access',
    async (ids) => {
      const h = withStaff()
      await expect(create(h, { ...hr, hrIds: ids })).rejects.toMatchObject(
        code('HR_TEAM_SELF_ONLY', 403),
      )
      expect(h.log).toEqual([])
    },
  )

  it.each([[undefined], [[]], [['hr-9']], [['hr-9', 'hr-9']]])(
    'hrIds %j -> the team gets exactly the acting HR',
    async (hrIds) => {
      const h = withStaff()
      await create(h, { ...hr, ...(hrIds !== undefined && { hrIds }) })
      expect(memberIds(h.log)).toEqual(['user-new', 'hr-9'])
      expect(roleProbes(h.log)[0]).toMatchObject({ params: ['hr-9'] })
    },
  )

  it('an acting "HR" whose stored role is not HR is still rejected by the role probe', async () => {
    const h = makeHarness({ created: senior, staffRoles: { 'hr-9': 'JUNIOR' } })
    await expect(create(h, { ...hr })).rejects.toMatchObject(code('TEAM_HR_MEMBER_MUST_BE_HR', 400))
    nothingWritten(h)
  })

  it('self-only is HR-actor-only: ADMIN may pick any HR users', async () => {
    const h = withStaff()
    await create(h, { actorRole: 'ADMIN', actorId: 'admin-1', hrIds: ['hr-1', 'hr-2'] })
    expect(memberIds(h.log)).toEqual(['user-new', 'hr-1', 'hr-2'])
  })
})

describe('SR-M-2 pin — HR sets the base share at creation (0..100)', () => {
  it.each([0, 100])(
    'HR creates a senior with seniorSharePercent %i -> stored as given',
    async (pct) => {
      const h = withStaff()
      await create(h, { actorRole: 'HR', actorId: 'hr-9', seniorSharePercent: pct })
      expect(usersInsertValues(h.log).seniorSharePercent).toBe(pct)
    },
  )
})
