import type { JobExclusionDto } from '@crm/shared'
import type { SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import { describe, expect, it } from 'vitest'
import type { Evaluated, Excluded, ScopeProjection } from '../funnel/evaluate'
import type { SqlExecutor } from '../scheduling/host-state'
import {
  MATCH_RULE_VERSION,
  type RosterInputs,
  exclusionVersion,
  installMatches,
  loadOpportunity,
  loadRoster,
  matchRows,
  profileVersion,
} from './recompute-inputs'

/**
 * r5 Task 4.6 S4a — the recompute worker's database side against a recording executor: the
 * roster and opportunity loaders, the verdict -> per-senior rows mapping, the input versions, and
 * the install statements. The same against a real Postgres: `recompute-worker.integration.spec.ts`.
 */

const dialect = new PgDialect()
type Query = { sql: string; params: unknown[] }

function recording(answer: (q: Query) => Record<string, unknown>[] = () => []) {
  const statements: Query[] = []
  const tx = {
    async execute(query: SQL) {
      const q = dialect.sqlToQuery(query)
      statements.push(q)
      return { rows: answer(q) }
    },
  } as unknown as SqlExecutor
  return { tx, statements }
}

const A = '00000000-0000-4000-8000-00000000000a'
const B = '00000000-0000-4000-8000-00000000000b'
const C = '00000000-0000-4000-8000-00000000000c'
const OPP = '00000000-0000-4000-8000-0000000000f1'

const exclusion = (over: Partial<JobExclusionDto>): JobExclusionDto => ({
  id: 'x1',
  scope: 'GLOBAL',
  seniorId: null,
  kind: 'KEYWORD',
  value: 'php',
  normalizedValue: 'php',
  origin: 'MANUAL',
  sourceLabel: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  ...over,
})

const roster: RosterInputs = {
  rosterSeniorIds: [A, B, C],
  profiles: [
    { seniorId: A, teamIds: ['t1'], techStack: ['Go'] },
    { seniorId: B, teamIds: ['t1'], techStack: ['PHP'] },
    { seniorId: C, teamIds: ['t2'], techStack: ['Rust'] },
  ],
  exclusions: [],
}

const reason = { code: 'R', evidence: ['e'] as [string], ruleVersion: 'v' }
const projection = (scope: string, status: 'LEAD' | 'TRIAGE'): ScopeProjection => ({
  scope,
  status,
  matchCount: 1,
  score: status === 'LEAD' ? 0.5 : null,
  rankWarnings: [],
  reasons: [reason],
  tech: { seniors: [], lowInformation: false } as unknown as ScopeProjection['tech'],
})

const evaluated = (
  projections: ScopeProjection[],
  excluded: Evaluated['audit']['excluded'] = [],
): Evaluated =>
  ({
    kind: 'EVALUATED',
    recordKey: 'k',
    opportunityId: OPP,
    revisionId: '1',
    evaluatedAt: '2026-10-26T10:00:00.000Z',
    status: 'LEAD',
    layer1: {},
    projections,
    trace: [],
    audit: { excluded, noTeamAccess: [], ignoredExclusionIds: [] },
  }) as unknown as Evaluated

describe('matchRows', () => {
  it('LEAD per matched senior scope; studio and team projections are not per-senior rows', () => {
    const rows = matchRows(
      evaluated([
        projection(`SENIOR:${B}`, 'LEAD'),
        projection('STUDIO', 'LEAD'),
        projection('TEAM:t1', 'TRIAGE'),
      ]),
      roster,
    )
    expect(rows).toEqual([
      {
        seniorId: B,
        outcome: 'LEAD',
        evidence: { score: 0.5, reasons: [reason], rankWarnings: [] },
      },
    ])
  })

  it('EXCLUDED per excluded senior, with stage and reasons only; a plain mismatch is no row', () => {
    const rows = matchRows(
      evaluated(
        [projection(`SENIOR:${C}`, 'LEAD')],
        [
          {
            subject: `SENIOR:${A}`,
            stage: 'SCOPED_RESTRICTIONS',
            reasons: [reason],
            inputs: { secret: 1 },
          },
        ],
      ),
      roster,
    )
    expect(rows).toEqual([
      {
        seniorId: A,
        outcome: 'EXCLUDED',
        evidence: { stage: 'SCOPED_RESTRICTIONS', reasons: [reason] },
      },
      expect.objectContaining({ seniorId: C, outcome: 'LEAD' }),
    ])
  })

  it('an opportunity-level exclusion excludes every roster senior, sorted by id', () => {
    const excluded: Excluded = {
      kind: 'EXCLUDED',
      recordKey: 'k',
      opportunityId: OPP,
      revisionId: '1',
      evaluatedAt: '2026-10-26T10:00:00.000Z',
      reasons: [reason],
      trace: [],
      audit: {
        excluded: [
          { subject: 'OPPORTUNITY', stage: 'CLASSIFICATION', reasons: [reason], inputs: {} },
        ],
        noTeamAccess: [],
        ignoredExclusionIds: [],
      },
    }
    const rows = matchRows(excluded, { ...roster, rosterSeniorIds: [C, A, B] })
    expect(rows.map((r) => [r.seniorId, r.outcome])).toEqual([
      [A, 'EXCLUDED'],
      [B, 'EXCLUDED'],
      [C, 'EXCLUDED'],
    ])
    expect(rows[0]?.evidence).toEqual({ stage: 'CLASSIFICATION', reasons: [reason] })
  })
})

describe('input versions', () => {
  it('a profile version is 32 hex, order-insensitive, and moves with the stack or the teams', () => {
    const v = profileVersion({ seniorId: A, teamIds: ['t1', 't2'], techStack: ['Go', 'Rust'] })
    expect(v).toMatch(/^[0-9a-f]{32}$/)
    expect(profileVersion({ seniorId: B, teamIds: ['t2', 't1'], techStack: ['Rust', 'Go'] })).toBe(
      v,
    )
    expect(profileVersion({ seniorId: A, teamIds: ['t1', 't2'], techStack: ['Go'] })).not.toBe(v)
    expect(profileVersion({ seniorId: A, teamIds: ['t1'], techStack: ['Go', 'Rust'] })).not.toBe(v)
    // The digest of `[stack, teams]`, not of the list the other way round.
    expect(
      profileVersion({ seniorId: A, teamIds: ['Go', 'Rust'], techStack: ['t1', 't2'] }),
    ).not.toBe(v)
    expect(profileVersion(undefined)).toMatch(/^[0-9a-f]{32}$/)
    expect(profileVersion(undefined)).not.toBe(v)
  })

  it('an exclusion version covers the studio-wide entries and the senior own, nobody else', () => {
    const global = exclusion({ id: 'g' })
    const mine = exclusion({
      id: 'm',
      scope: 'SENIOR',
      seniorId: A,
      kind: 'COMPANY',
      normalizedValue: 'acme',
    })
    const theirs = exclusion({ id: 't', scope: 'SENIOR', seniorId: B, normalizedValue: 'evil' })
    const v = exclusionVersion([global, mine, theirs], A)
    expect(v).toMatch(/^[0-9a-f]{32}$/)
    expect(exclusionVersion([theirs, mine, global], A)).toBe(v)
    expect(exclusionVersion([global, mine], A)).toBe(v)
    expect(exclusionVersion([global], A)).not.toBe(v)
    expect(exclusionVersion([mine], A)).not.toBe(v)
    expect(exclusionVersion([global, { ...mine, normalizedValue: 'other' }], A)).not.toBe(v)
    expect(exclusionVersion([global, { ...mine, kind: 'KEYWORD' }], A)).not.toBe(v)
    expect(exclusionVersion([global, { ...mine, scope: 'GLOBAL' }], A)).not.toBe(v)
    expect(exclusionVersion([global, { ...mine, id: 'm2' }], A)).not.toBe(v)
  })
})

describe('loadRoster', () => {
  const seniorsRow = [
    { id: A, tech_stack: ['Go'], team_ids: ['t2', 't1'] },
    { id: B, tech_stack: null, team_ids: ['t1'] },
  ]

  it('an empty roster reads no exclusions', async () => {
    const { tx, statements } = recording()
    expect(await loadRoster(tx)).toEqual({ rosterSeniorIds: [], profiles: [], exclusions: [] })
    expect(statements).toHaveLength(1)
    expect(statements[0]?.sql).toMatch(/u\.role = 'SENIOR' AND u\.archived_at IS NULL/)
    expect(statements[0]?.sql).toMatch(/tm\.left_at IS NULL/)
  })

  it('profiles with sorted teams; stored and project-derived exclusions of the roster only', async () => {
    const created = new Date('2026-02-03T04:05:06.789Z')
    const { tx, statements } = recording((q) => {
      if (/FROM users u/.test(q.sql)) return seniorsRow
      if (/FROM job_exclusion_filters/.test(q.sql))
        return [
          {
            id: 'g1',
            senior_id: null,
            kind: 'KEYWORD',
            value: 'PHP',
            normalized_value: 'php',
            created_at: created,
          },
          {
            id: 's1',
            senior_id: A,
            kind: 'COMPANY',
            value: 'Acme',
            normalized_value: 'acme',
            created_at: '2026-02-03T04:05:06.789Z',
          },
        ]
      if (/FROM projects/.test(q.sql))
        return [
          { senior_id: A, name: 'P', company_name: 'Globex', archived_at: null },
          { senior_id: B, name: 'Q', company_name: 'Initech', archived_at: created },
        ]
      return []
    })
    const r = await loadRoster(tx)
    expect(r.rosterSeniorIds).toEqual([A, B])
    expect(r.profiles).toEqual([
      { seniorId: A, teamIds: ['t1', 't2'], techStack: ['Go'] },
      { seniorId: B, teamIds: ['t1'], techStack: [] },
    ])
    expect(r.exclusions).toEqual([
      expect.objectContaining({
        id: 'g1',
        scope: 'GLOBAL',
        seniorId: null,
        createdAt: created.toISOString(),
      }),
      expect.objectContaining({
        id: 's1',
        scope: 'SENIOR',
        seniorId: A,
        normalizedValue: 'acme',
        createdAt: created.toISOString(),
      }),
      expect.objectContaining({
        seniorId: A,
        origin: 'PROJECT',
        value: 'Globex',
        sourceLabel: 'P',
      }),
      expect.objectContaining({
        seniorId: B,
        origin: 'PROJECT',
        value: 'Initech',
        sourceLabel: 'Q',
      }),
    ])
    expect(statements[1]?.sql).toMatch(/senior_id IS NULL OR senior_id IN/)
    expect(statements[1]?.params).toEqual([JSON.stringify([A, B])])
    expect(statements[2]?.params).toEqual([JSON.stringify([A, B])])
  })
})

describe('loadOpportunity', () => {
  const row = (over: Record<string, unknown> = {}) => ({
    id: OPP,
    revision: 3,
    title: 'Go Developer',
    employer_name: 'Acme',
    location: 'Kyiv',
    stack_keywords: ['go'],
    application_url: 'https://acme.test/apply',
    availability: 'OPEN',
    first_seen_at: '2026-08-01T00:00:00.000Z',
    description: 'Body',
    normalized: {
      remote: true,
      employmentType: 'FULL_TIME',
      seniorityHint: 'SENIOR',
      dates: [
        {
          semantics: 'UPDATED',
          contract: 'ISO',
          raw: 'x',
          status: 'OK',
          value: '2026-09-02T00:00:00.000Z',
        },
        { semantics: 'PUBLISHED', contract: 'ISO', raw: 'y', status: 'INVALID', value: null },
        {
          semantics: 'PUBLISHED',
          contract: 'ISO',
          raw: 'z',
          status: 'OK',
          value: '2026-09-01T00:00:00.000Z',
        },
      ],
    },
    evidence: { fields: [{ field: 'title' }] },
    source_type: 'REMOTIVE_API',
    source_url: 'https://agg.test/job',
    grants: ['t1'],
    ...over,
  })

  it('null when the opportunity does not exist', async () => {
    const { tx, statements } = recording()
    expect(await loadOpportunity(tx, OPP)).toBeNull()
    expect(statements[0]?.params).toContain(OPP)
    expect(statements[0]?.sql).not.toMatch(/first_seen_at\s*>|created_at\s*>/)
  })

  it('the canonical revision, with the representative revision fields and trusted dates', async () => {
    const { tx } = recording(() => [row()])
    const loaded = await loadOpportunity(tx, OPP)
    expect(loaded?.revision).toBe(3)
    expect(loaded?.teamTriageGrants).toEqual(['t1'])
    const c = loaded?.canonical
    expect(c).toMatchObject({
      opportunityId: OPP,
      revisionId: '3',
      companyName: 'Acme',
      url: 'https://acme.test/apply',
      sourceType: 'REMOTIVE_API',
      availability: 'OPEN',
      firstSeenKind: 'NORMAL',
    })
    expect(c?.firstSeenAt).toEqual(new Date('2026-08-01T00:00:00.000Z'))
    expect(c?.trustedPublishedAt).toEqual(new Date('2026-09-01T00:00:00.000Z'))
    expect(c?.fields).toMatchObject({
      title: 'Go Developer',
      location: 'Kyiv',
      descriptionMd: 'Body',
      remote: true,
      employmentType: 'FULL_TIME',
      seniorityHint: 'SENIOR',
      tags: ['go'],
      evidence: [{ field: 'title' }],
    })
    expect(c?.fields.dates[0]?.value).toEqual(new Date('2026-09-02T00:00:00.000Z'))
    expect(c?.fields.dates[1]?.value).toBeNull()
  })

  it('defaults when the canonical row and its representative say nothing', async () => {
    const first = new Date('2026-08-01T00:00:00.000Z')
    const { tx } = recording(() => [
      row({
        employer_name: null,
        location: null,
        application_url: null,
        description: null,
        normalized: null,
        evidence: null,
        source_type: null,
        source_url: 'https://agg.test/job',
        first_seen_at: first,
        grants: null,
        stack_keywords: null,
      }),
    ])
    const loaded = await loadOpportunity(tx, OPP)
    const c = loaded?.canonical
    expect(c).toMatchObject({
      companyName: '',
      url: 'https://agg.test/job',
      sourceType: '',
      trustedPublishedAt: null,
    })
    expect(c?.firstSeenAt).toBe(first)
    expect(loaded?.teamTriageGrants).toEqual([])
    expect(c?.fields).toEqual({
      title: 'Go Developer',
      location: null,
      descriptionMd: '',
      remote: null,
      employmentType: null,
      seniorityHint: null,
      tags: [],
      dates: [],
    })
    const { tx: bare } = recording(() => [row({ application_url: null, source_url: null })])
    expect((await loadOpportunity(bare, OPP))?.canonical.url).toBe('')
  })
})

describe('installMatches', () => {
  const result = evaluated([projection(`SENIOR:${A}`, 'LEAD')])
  const withExclusions: RosterInputs = { ...roster, exclusions: [exclusion({ id: 'g' })] }

  it('replaces the rows at this revision and never touches a newer revision', async () => {
    const { tx, statements } = recording()
    expect(await installMatches(tx, OPP, 4, result, withExclusions)).toBe(1)
    const [del, ins] = statements
    expect(del?.sql).toMatch(/DELETE FROM job_opportunity_matches/)
    expect(del?.sql).toMatch(/opportunity_revision <= \$2/)
    expect(del?.params.slice(0, 2)).toEqual([OPP, 4])
    expect(ins?.sql).toMatch(/ON CONFLICT \(opportunity_id, senior_id\) DO UPDATE/)
    expect(ins?.sql).toMatch(
      /WHERE job_opportunity_matches\.opportunity_revision <= EXCLUDED\.opportunity_revision/,
    )
    expect(ins?.params).toEqual([
      OPP,
      4,
      MATCH_RULE_VERSION,
      '2026-10-26T10:00:00.000Z',
      JSON.stringify([
        {
          senior_id: A,
          outcome: 'LEAD',
          evidence: { score: 0.5, reasons: [reason], rankWarnings: [] },
          profile_version: profileVersion(roster.profiles[0]),
          exclusion_version: exclusionVersion(withExclusions.exclusions, A),
        },
      ]),
    ])
    expect(del?.params[2]).toBe(ins?.params[4])
  })

  it('no row to install: only the delete runs', async () => {
    const { tx, statements } = recording()
    expect(await installMatches(tx, OPP, 1, evaluated([]), roster)).toBe(0)
    expect(statements).toHaveLength(1)
    expect(statements[0]?.params[2]).toBe('[]')
  })

  it('the rule version names both stages', () => {
    expect(MATCH_RULE_VERSION).toBe('eval.1+l1.1')
  })
})
