import { sql } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import { describe, expect, it } from 'vitest'
import {
  type GenerationHead,
  isGenerationServable,
  isJobQueueRole,
  type JobQueueScope,
  NONE_SCOPE,
  scopedTeamRowPredicate,
  selectScopeTeam,
  STUDIO_SCOPE,
  visibleOpportunityPredicate,
} from './queue-scope'

const TEAM_A = '11111111-1111-4111-8111-111111111111'
const TEAM_B = '22222222-2222-4222-8222-222222222222'
const teamA: JobQueueScope = { kind: 'TEAM', teamId: TEAM_A, seniorIds: [] }
const render = (q: ReturnType<typeof sql>) => new PgDialect().sqlToQuery(q)
const flat = (s: string) => s.replace(/\s+/g, ' ')

describe('isJobQueueRole', () => {
  it.each([
    ['ADMIN', true],
    ['HR', true],
    ['SENIOR', false],
    ['JUNIOR', false],
    ['ACCOUNTANT', false],
    ['DROP', false],
  ])('%s -> %s', (role, expected) => {
    expect(isJobQueueRole(role)).toBe(expected)
  })
})

describe('selectScopeTeam', () => {
  it('defaults to the first allowed team in the given order', () => {
    expect(selectScopeTeam(undefined, [TEAM_B, TEAM_A])).toBe(TEAM_B)
  })
  it('honours a requested team the actor belongs to, even when it is not the first', () => {
    expect(selectScopeTeam(TEAM_A, [TEAM_B, TEAM_A])).toBe(TEAM_A)
  })
  it('a requested team outside the allowed list is null — never a fallback to another team', () => {
    expect(selectScopeTeam(TEAM_A, [TEAM_B])).toBeNull()
  })
  it('no allowed team at all is null', () => {
    expect(selectScopeTeam(undefined, [])).toBeNull()
    expect(selectScopeTeam(TEAM_A, [])).toBeNull()
  })
})

describe('visibleOpportunityPredicate', () => {
  const id = sql`'x'::uuid`
  it('STUDIO sees every opportunity', () => {
    expect(render(visibleOpportunityPredicate(STUDIO_SCOPE, id)).sql).toBe('TRUE')
  })
  it('NONE sees nothing', () => {
    expect(render(visibleOpportunityPredicate(NONE_SCOPE, id)).sql).toBe('FALSE')
  })
  it('TEAM: a current-revision LEAD of a live team senior, or a live triage grant for the team', () => {
    const q = render(visibleOpportunityPredicate(teamA, id))
    const text = flat(q.sql)
    expect(text).toContain("m.outcome = 'LEAD'")
    expect(text).toContain('m.opportunity_revision = mo.revision')
    expect(text).toContain("u.role = 'SENIOR' AND u.archived_at IS NULL")
    expect(text).toContain('tm.team_id = $1::uuid AND tm.left_at IS NULL')
    expect(text).toContain('OR EXISTS (SELECT 1 FROM job_opportunity_team_triage g')
    expect(text).toContain('g.team_id = $2::uuid')
    expect(text).toContain('g.revoked_at IS NULL')
    expect(text).toContain('g.expires_at > clock_timestamp()')
    expect(q.params).toEqual([TEAM_A, TEAM_A])
  })
})

describe('scopedTeamRowPredicate', () => {
  const col = sql.raw('d.team_id')
  it('STUDIO spans teams', () => {
    expect(render(scopedTeamRowPredicate(STUDIO_SCOPE, col)).sql).toBe('TRUE')
  })
  it('NONE reads nothing', () => {
    expect(render(scopedTeamRowPredicate(NONE_SCOPE, col)).sql).toBe('FALSE')
  })
  it('TEAM reads only its own team rows', () => {
    const q = render(scopedTeamRowPredicate(teamA, col))
    expect(q.sql).toBe('d.team_id = $1::uuid')
    expect(q.params).toEqual([TEAM_A])
  })
})

describe('isGenerationServable', () => {
  const now = new Date('2026-11-04T12:00:00Z')
  const later = new Date('2026-11-04T12:00:01Z')
  const studioGen: GenerationHead = {
    scopeKind: 'STUDIO',
    teamId: null,
    status: 'PUBLISHED',
    expiresAt: later,
  }
  const teamAGen: GenerationHead = {
    scopeKind: 'TEAM',
    teamId: TEAM_A,
    status: 'PUBLISHED',
    expiresAt: later,
  }

  it('a live STUDIO generation is served to STUDIO only', () => {
    expect(isGenerationServable(STUDIO_SCOPE, studioGen, now)).toBe(true)
    expect(isGenerationServable(teamA, studioGen, now)).toBe(false)
    expect(isGenerationServable(NONE_SCOPE, studioGen, now)).toBe(false)
  })
  it('a live TEAM generation is served to that same team only', () => {
    expect(isGenerationServable(teamA, teamAGen, now)).toBe(true)
    expect(isGenerationServable({ ...teamA, teamId: TEAM_B }, teamAGen, now)).toBe(false)
    expect(isGenerationServable(STUDIO_SCOPE, teamAGen, now)).toBe(false)
    expect(isGenerationServable(NONE_SCOPE, teamAGen, now)).toBe(false)
  })
  it('a TEAM-kind generation must match on kind, not only on team id', () => {
    const forged: GenerationHead = { ...studioGen, teamId: TEAM_A }
    expect(isGenerationServable(teamA, forged, now)).toBe(false)
  })
  it('never serves an expired generation, the boundary instant included', () => {
    expect(isGenerationServable(teamA, { ...teamAGen, expiresAt: now }, now)).toBe(false)
    expect(isGenerationServable(STUDIO_SCOPE, { ...studioGen, expiresAt: now }, now)).toBe(false)
  })
  it('never serves a BUILDING or INVALIDATED generation', () => {
    expect(isGenerationServable(teamA, { ...teamAGen, status: 'BUILDING' }, now)).toBe(false)
    expect(isGenerationServable(teamA, { ...teamAGen, status: 'INVALIDATED' }, now)).toBe(false)
  })
})
