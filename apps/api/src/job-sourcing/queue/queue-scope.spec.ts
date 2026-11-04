import { sql } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import { describe, expect, it } from 'vitest'
import { MATCH_RULE_VERSION } from '../runtime/recompute-inputs'
import {
  canonicalUuid,
  type GenerationHead,
  isGenerationServable,
  isJobQueueRole,
  type JobQueueScope,
  listableOpportunityPredicate,
  NONE_SCOPE,
  possibleDuplicateJoin,
  scopedTeamRowPredicate,
  selectScopeTeam,
  STUDIO_SCOPE,
  visibleOpportunityPredicate,
} from './queue-scope'

const TEAM_A = '11111111-1111-4111-8111-111111111111'
const TEAM_B = '22222222-2222-4222-8222-222222222222'
const TEAM_C = 'abcdef01-2345-4678-9abc-def012345678'
const SEN_1 = '33333333-3333-4333-8333-333333333333'
const teamA: JobQueueScope = {
  kind: 'TEAM',
  teamId: TEAM_A,
  seniorIds: [SEN_1],
  versions: [{ seniorId: SEN_1, profile: 'p1', exclusion: 'e1' }],
  inputsVersion: 'inputs-1',
}
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

describe('listableOpportunityPredicate', () => {
  const id = sql`o.id`
  it('STUDIO: refuses an EXCLUDED verdict at the current revision and a suppressed opportunity', () => {
    const { sql: text, params } = render(listableOpportunityPredicate(STUDIO_SCOPE, id))
    expect(flat(text)).toBe(
      `(NOT EXISTS (SELECT 1 FROM job_opportunities xo WHERE xo.id = o.id AND xo.evaluated_revision = xo.revision AND xo.evaluation_verdict = 'EXCLUDED') AND NOT EXISTS (SELECT 1 FROM job_queue_actions sup WHERE sup.opportunity_id = o.id AND sup.kind = 'SUPPRESSED'))`,
    )
    expect(params).toEqual([])
  })
  it('TEAM and NONE: exactly the visibility predicate', () => {
    expect(render(listableOpportunityPredicate(teamA, id))).toEqual(
      render(visibleOpportunityPredicate(teamA, id)),
    )
    expect(render(listableOpportunityPredicate(NONE_SCOPE, id)).sql).toBe('FALSE')
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
  it('an uppercase spelling of an allowed team is that team (canonical lowercase returned)', () => {
    expect(selectScopeTeam(TEAM_C.toUpperCase(), [TEAM_B, TEAM_C])).toBe(TEAM_C)
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
  it('TEAM LEAD branch: current revision, live versions, live senior, live team', () => {
    const q = render(visibleOpportunityPredicate(teamA, id))
    const text = flat(q.sql)
    expect(text).toContain(
      'JOIN jsonb_to_recordset($1::jsonb) AS v(senior_id uuid, profile text, exclusion text) ON v.senior_id = m.senior_id',
    )
    expect(text).toContain("m.outcome = 'LEAD'")
    expect(text).toContain('m.opportunity_revision = mo.revision')
    expect(text).toContain('m.senior_profile_version = v.profile')
    expect(text).toContain('m.exclusion_version = v.exclusion')
    expect(text).toContain('m.rule_version = $2')
    expect(text).toContain("u.role = 'SENIOR' AND u.archived_at IS NULL")
    expect(text).toContain('tm.team_id = $3::uuid AND tm.left_at IS NULL')
    expect(text).toContain(
      "EXISTS (SELECT 1 FROM teams lt WHERE lt.id = $4::uuid AND lt.archived_at IS NULL AND lt.type = 'SENIOR')",
    )
  })

  it('TEAM grant branch: live grant, open opportunity, evaluated OPEN at its current revision, live team', () => {
    const text = flat(render(visibleOpportunityPredicate(teamA, id)).sql)
    expect(text).toContain('OR EXISTS (SELECT 1 FROM job_opportunity_team_triage g')
    expect(text).toContain('g.team_id = $5::uuid')
    expect(text).toContain('g.revoked_at IS NULL')
    expect(text).toContain('g.expires_at > clock_timestamp()')
    expect(text).toContain("gop.availability NOT IN ('CLOSED', 'EXPIRED')")
    // SR-M-2: `= 'OPEN'` and `=` are false on NULL, so never evaluated fails closed.
    // SR-M-1: and only while the recorded inputs version is the LIVE one (NULL never equals it).
    expect(text).toContain(
      "AND gop.evaluated_revision = gop.revision AND gop.evaluation_verdict = 'OPEN' AND gop.evaluated_inputs_version = $6 AND",
    )
    expect(render(visibleOpportunityPredicate(teamA, id)).params[5]).toBe('inputs-1')
    expect(text).not.toContain('job_opportunity_matches x')
    expect(text).toContain(
      "EXISTS (SELECT 1 FROM teams gt WHERE gt.id = $7::uuid AND gt.archived_at IS NULL AND gt.type = 'SENIOR')",
    )
  })

  it('TEAM params: the live versions as JSON, the match rule version, then the team id', () => {
    const q = render(visibleOpportunityPredicate(teamA, id))
    expect(q.params).toEqual([
      '[{"senior_id":"33333333-3333-4333-8333-333333333333","profile":"p1","exclusion":"e1"}]',
      MATCH_RULE_VERSION,
      TEAM_A,
      TEAM_A,
      TEAM_A,
      'inputs-1',
      TEAM_A,
    ])
    expect(MATCH_RULE_VERSION).toBe('eval.1+l1.1')
  })

  it('TEAM: either branch, and never a suppressed opportunity (r5 Task 6.4)', () => {
    const text = flat(render(visibleOpportunityPredicate(teamA, id)).sql)
    expect(text.startsWith('((EXISTS (SELECT 1 FROM job_opportunity_matches m')).toBe(true)
    expect(
      text.endsWith(
        `)) AND NOT EXISTS (SELECT 1 FROM job_queue_actions sup WHERE sup.opportunity_id = 'x'::uuid AND sup.kind = 'SUPPRESSED'))`,
      ),
    ).toBe(true)
  })

  it('TEAM with no live senior versions binds an empty list (the LEAD branch grants nothing)', () => {
    const q = render(visibleOpportunityPredicate({ ...teamA, seniorIds: [], versions: [] }, id))
    expect(q.params[0]).toBe('[]')
  })
})

describe('canonicalUuid', () => {
  it('lowercases a valid UUID', () => {
    expect(canonicalUuid('ABCDEF01-2345-4678-9ABC-DEF012345678')).toBe(
      'abcdef01-2345-4678-9abc-def012345678',
    )
    expect(canonicalUuid(TEAM_A)).toBe(TEAM_A)
  })
  it.each(['not-a-uuid', '', `${TEAM_A}x`, `x${TEAM_A}`, '11111111111141118111111111111111'])(
    'rejects %j',
    (value) => {
      expect(canonicalUuid(value)).toBeNull()
    },
  )
})

describe('possibleDuplicateJoin', () => {
  it('is the target itself, or the same candidate key of a known employer, binding nothing', () => {
    const q = render(possibleDuplicateJoin('t', 'd'))
    expect(flat(q.sql).trim()).toBe(
      '(d.id = t.id OR (t.employer_key IS NOT NULL AND d.employer_key = t.employer_key AND d.title_key = t.title_key))',
    )
    expect(q.params).toEqual([])
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
