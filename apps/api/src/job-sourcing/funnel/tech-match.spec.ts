import { describe, expect, it } from 'vitest'
import type { JobExclusionDto, SeniorSelectableRole, TechnicalRole } from '@crm/shared'
import {
  forViewer,
  matchTech,
  type SeniorTechProfile,
  type TechMatchInput,
  type TechMatchPosting,
  type TechMatchReady,
} from './tech-match'

const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'
const C = '77777777-7777-4777-8777-777777777777'
const TEAM = '33333333-3333-4333-8333-333333333333'
const EXCLUSION_ID = '44444444-4444-4444-8444-444444444444'

const profile = (
  seniorId: string,
  roles: SeniorSelectableRole[] = ['BACKEND_ENGINEER'],
  teamIds: string[] = [TEAM],
  skills: string[] | null = null,
): SeniorTechProfile => ({ seniorId, teamIds, roles, skills })

const posting = (over: Partial<TechMatchPosting> = {}): TechMatchPosting => ({
  title: 'Software Engineer',
  companyName: 'Acme',
  body: null,
  roles: ['BACKEND_ENGINEER'],
  ...over,
})

function exclusion(over: Partial<JobExclusionDto>): JobExclusionDto {
  return {
    id: EXCLUSION_ID,
    scope: 'SENIOR',
    seniorId: A,
    kind: 'COMPANY',
    value: 'Acme',
    normalizedValue: 'acme',
    origin: 'MANUAL',
    sourceLabel: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    ...over,
  }
}

function run(
  p: Partial<TechMatchPosting>,
  profiles: SeniorTechProfile[],
  exclusions: JobExclusionDto[] = [],
  roster: string[] = profiles.map((x) => x.seniorId),
): TechMatchReady {
  const input: TechMatchInput = {
    posting: posting(p),
    rosterSeniorIds: roster,
    profiles,
    exclusions,
  }
  const result = matchTech(input)
  if (result.status !== 'READY') throw new Error(`not ready: ${JSON.stringify(result)}`)
  return result
}

const senior = (r: { seniors: TechMatchReady['seniors'] }, id: string) => {
  const s = r.seniors.find((x) => x.seniorId === id)
  if (!s) throw new Error('not matchable')
  return s
}

const roles = (r: TechMatchReady, id: string) => senior(r, id).matchedRoles

describe('role match', () => {
  it('an own role matches and is not widened', () => {
    const r = run({ roles: ['BACKEND_ENGINEER'] }, [profile(A)])
    expect(roles(r, A)).toEqual([{ role: 'BACKEND_ENGINEER', widened: false }])
  })

  it('one hop of the widening matrix matches and is marked widened', () => {
    const r = run({ roles: ['FULLSTACK_ENGINEER'] }, [profile(A)])
    expect(roles(r, A)).toEqual([{ role: 'FULLSTACK_ENGINEER', widened: true }])
  })

  it('the matrix is never applied twice', () => {
    // BACKEND -> FULLSTACK -> FRONTEND would be two hops.
    const r = run({ roles: ['FRONTEND_ENGINEER'] }, [profile(A)])
    expect(roles(r, A)).toEqual([])
  })

  it('a role outside own roles and one hop is a mismatch, but the senior stays matchable', () => {
    const r = run({ roles: ['DATA_SCIENTIST'] }, [profile(A)])
    expect(r.matchableSeniorIds).toEqual([A])
    expect(roles(r, A)).toEqual([])
  })

  it('a multi-role vacancy matches on any covered role, in vacancy order', () => {
    const r = run({ roles: ['DATA_SCIENTIST', 'SOFTWARE_ENGINEER', 'BACKEND_ENGINEER'] }, [
      profile(A),
    ])
    expect(roles(r, A)).toEqual([
      { role: 'SOFTWARE_ENGINEER', widened: true },
      { role: 'BACKEND_ENGINEER', widened: false },
    ])
  })

  it('a vacancy with no stored roles matches nobody', () => {
    const r = run({ roles: [] }, [profile(A)])
    expect(roles(r, A)).toEqual([])
  })

  it('a senior with no roles matches nothing', () => {
    const r = run({ roles: ['BACKEND_ENGINEER'] }, [profile(A, [])])
    expect(roles(r, A)).toEqual([])
  })

  it('each senior is matched on their own roles only', () => {
    const vacancy: TechnicalRole[] = ['ML_ENGINEER']
    const r = run({ roles: vacancy }, [profile(A), profile(B, ['DATA_SCIENTIST'])])
    expect(roles(r, A)).toEqual([])
    expect(roles(r, B)).toEqual([{ role: 'ML_ENGINEER', widened: true }])
  })
})

describe('skills overlap (display-only)', () => {
  const body = 'We use Python and PostgreSQL. React is a plus.'

  it('counts the vacancy technologies the senior resume has', () => {
    const r = run({ body }, [profile(A, undefined, undefined, ['python', 'Go'])])
    expect(senior(r, A).skillOverlap).toEqual({ matched: ['Python'], total: 3 })
  })

  it('reads the title as well as the body', () => {
    const r = run({ title: 'React Developer', body: null }, [
      profile(A, undefined, undefined, ['React']),
    ])
    expect(senior(r, A).skillOverlap).toEqual({ matched: ['React'], total: 1 })
  })

  it('a senior with no resume skills is NO_RESUME, never 0 of n', () => {
    const r = run({ body }, [
      profile(A, undefined, undefined, null),
      profile(B, undefined, undefined, []),
    ])
    expect(senior(r, A).skillOverlap).toBe('NO_RESUME')
    expect(senior(r, B).skillOverlap).toBe('NO_RESUME')
  })

  it('a vacancy that names no technology gives no indicator', () => {
    const r = run({ title: 'Engineer', body: 'Great team, remote.' }, [
      profile(A, undefined, undefined, ['Python']),
    ])
    expect(senior(r, A).skillOverlap).toBeNull()
  })

  it("each senior's overlap uses that senior's skills only", () => {
    const r = run({ body }, [
      profile(A, undefined, undefined, ['Python']),
      profile(B, undefined, undefined, ['React', 'PostgreSQL']),
    ])
    expect(senior(r, A).skillOverlap).toEqual({ matched: ['Python'], total: 3 })
    expect(senior(r, B).skillOverlap).toEqual({ matched: ['PostgreSQL', 'React'], total: 3 })
  })

  it('the overlap does not change the role match', () => {
    const none = run({ body, roles: ['DATA_SCIENTIST'] }, [
      profile(A, undefined, undefined, ['Python', 'React', 'PostgreSQL']),
    ])
    expect(senior(none, A).skillOverlap).toEqual({
      matched: ['PostgreSQL', 'Python', 'React'],
      total: 3,
    })
    expect(roles(none, A)).toEqual([])
  })
})

describe('exclusions run before matching', () => {
  it('an excluded profile is not matched and is listed under audit only', () => {
    const r = run({}, [profile(A), profile(B)], [exclusion({ seniorId: A })])
    expect(r.matchableSeniorIds).toEqual([B])
    expect(r.seniors.map((s) => s.seniorId)).toEqual([B])
    expect(r.audit.excluded).toEqual([
      {
        seniorId: A,
        exclusionId: EXCLUSION_ID,
        exclusionKind: 'COMPANY',
        exclusionScope: 'SENIOR',
      },
    ])
  })

  it("another senior's exclusion does not apply", () => {
    const r = run({}, [profile(A)], [exclusion({ seniorId: B })])
    expect(r.matchableSeniorIds).toEqual([A])
  })

  it('a GLOBAL keyword exclusion excludes everyone, against the title not the body', () => {
    const global = exclusion({
      scope: 'GLOBAL',
      seniorId: null,
      kind: 'KEYWORD',
      value: 'php',
      normalizedValue: 'php',
    })
    const hit = run({ title: 'PHP Developer' }, [profile(A), profile(B)], [global])
    expect(hit.matchableSeniorIds).toEqual([])
    expect(hit.audit.excluded.map((e) => e.seniorId)).toEqual([A, B])
    expect(run({ body: 'php legacy' }, [profile(A)], [global]).matchableSeniorIds).toEqual([A])
  })

  it('a senior KEYWORD exclusion applies to that senior only', () => {
    const mine = exclusion({
      seniorId: B,
      kind: 'KEYWORD',
      value: 'engineer',
      normalizedValue: 'engineer',
    })
    const r = run({}, [profile(A), profile(B)], [mine])
    expect(r.matchableSeniorIds).toEqual([A])
    expect(r.audit.excluded.map((e) => e.seniorId)).toEqual([B])
  })

  it('a GLOBAL company exclusion is unused (A1g) and reported, not applied', () => {
    const g = exclusion({
      scope: 'GLOBAL',
      seniorId: null,
      id: '55555555-5555-4555-8555-555555555555',
    })
    const keyword = exclusion({
      scope: 'GLOBAL',
      seniorId: null,
      kind: 'KEYWORD',
      value: 'cobol',
      normalizedValue: 'cobol',
      id: '66666666-6666-4666-8666-666666666666',
    })
    const r = run({}, [profile(A)], [g, keyword])
    expect(r.matchableSeniorIds).toEqual([A])
    expect(r.audit.ignoredExclusionIds).toEqual(['55555555-5555-4555-8555-555555555555'])
    expect(run({}, [profile(A)], [{ ...g, id: null }]).audit.ignoredExclusionIds).toEqual([])
  })

  it('a malformed GLOBAL company exclusion that carries a senior id still does not apply', () => {
    const r = run({}, [profile(A)], [exclusion({ scope: 'GLOBAL', seniorId: A })])
    expect(r.matchableSeniorIds).toEqual([A])
  })

  it('reports the GLOBAL exclusion when a global and a personal one both match', () => {
    const globalKw = exclusion({
      scope: 'GLOBAL',
      seniorId: null,
      kind: 'KEYWORD',
      value: 'engineer',
      normalizedValue: 'engineer',
      id: '66666666-6666-4666-8666-666666666666',
    })
    const r = run({}, [profile(A)], [exclusion({}), globalKw])
    expect(r.audit.excluded[0]).toMatchObject({
      exclusionScope: 'GLOBAL',
      exclusionKind: 'KEYWORD',
      exclusionId: '66666666-6666-4666-8666-666666666666',
    })
  })

  it('exclusion wins over missing team access', () => {
    const r = run({}, [profile(A, undefined, [])], [exclusion({})])
    expect(r.audit.excluded.map((e) => e.seniorId)).toEqual([A])
    expect(r.audit.noTeamAccess).toEqual([])
  })
})

describe('team access and roster', () => {
  it('a senior with no active team is skipped and listed under audit', () => {
    const r = run({}, [profile(A, undefined, []), profile(B)])
    expect(r.audit.noTeamAccess).toEqual([A])
    expect(r.matchableSeniorIds).toEqual([B])
    expect(r.seniors.map((s) => s.seniorId)).toEqual([B])
  })

  it('profiles outside the roster are ignored', () => {
    const r = run({}, [profile(A), profile(B)], [], [A])
    expect(r.matchableSeniorIds).toEqual([A])
    expect(r.seniors).toHaveLength(1)
  })

  it('an empty roster is ready, with nobody matchable', () => {
    expect(run({}, []).matchableSeniorIds).toEqual([])
  })
})

describe('readiness', () => {
  const ready = (rosterSeniorIds: string[], profiles: SeniorTechProfile[]) =>
    matchTech({ posting: posting(), rosterSeniorIds, profiles, exclusions: [] })

  it('a roster senior without a profile is a typed issue, not an empty result', () => {
    expect(ready([A, B, B], [profile(A)])).toEqual({
      status: 'READINESS_ISSUE',
      issues: [{ code: 'MISSING_ROSTER_PROFILES', seniorIds: [B] }],
    })
  })

  it('a profile repeated three times is reported once', () => {
    expect(ready([A], [profile(A), profile(A), profile(A)])).toEqual({
      status: 'READINESS_ISSUE',
      issues: [{ code: 'DUPLICATE_PROFILES', seniorIds: [A] }],
    })
  })

  it('duplicate profiles are reported together with missing ones', () => {
    expect(ready([A, B], [profile(A), profile(A)])).toEqual({
      status: 'READINESS_ISSUE',
      issues: [
        { code: 'MISSING_ROSTER_PROFILES', seniorIds: [B] },
        { code: 'DUPLICATE_PROFILES', seniorIds: [A] },
      ],
    })
  })
})

describe('forViewer — no excluded senior, exclusion or hidden overlap leaks', () => {
  const build = () =>
    run(
      { body: 'Python and React' },
      [
        profile(A, undefined, undefined, ['Python']),
        profile(B, undefined, undefined, ['React']),
        profile(C, undefined, [], ['React']),
      ],
      [exclusion({ seniorId: B })],
    )

  it('the full result keeps who was excluded under audit only', () => {
    const r = build()
    expect(r.audit.excluded.map((e) => e.seniorId)).toEqual([B])
    expect(r.audit.noTeamAccess).toEqual([C])
    expect(JSON.stringify(r.seniors)).not.toContain(B)
    expect(JSON.stringify(r.seniors)).not.toContain(EXCLUSION_ID)
  })

  it('the viewer shape has no audit and nothing about excluded or inaccessible seniors', () => {
    const view = forViewer(build(), { visibleSeniorIds: [A, B, C] })
    const text = JSON.stringify(view)
    expect('audit' in view).toBe(false)
    for (const secret of [B, C, EXCLUSION_ID, 'exclusion', 'noTeamAccess', 'audit']) {
      expect(text).not.toContain(secret)
    }
    expect(view).toEqual({
      status: 'READY',
      matchableSeniorIds: [A],
      seniors: [
        {
          seniorId: A,
          matchedRoles: [{ role: 'BACKEND_ENGINEER', widened: false }],
          skillOverlap: { matched: ['Python'], total: 2 },
        },
      ],
    })
  })

  it("a team view carries only its own seniors' overlap", () => {
    const r = run({ body: 'Python and React' }, [
      profile(A, undefined, undefined, ['Python']),
      profile(B, undefined, undefined, ['React']),
    ])
    const view = forViewer(r, { visibleSeniorIds: [B] })
    expect(view.matchableSeniorIds).toEqual([B])
    expect(view.seniors).toEqual([senior(r, B)])
    expect(JSON.stringify(view)).not.toContain('Python')
  })
})
