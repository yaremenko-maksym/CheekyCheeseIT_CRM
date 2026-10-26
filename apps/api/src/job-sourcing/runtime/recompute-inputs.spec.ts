import { createHash } from 'node:crypto'
import type { JobExclusionDto } from '@crm/shared'
import type { SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import { describe, expect, it } from 'vitest'
import type { Evaluated, Excluded, ScopeProjection } from '../funnel/evaluate'
import type { SqlExecutor } from '../scheduling/host-state'
import {
  MATCH_RULE_VERSION,
  RecomputePoisonError,
  type RosterInputs,
  exclusionVersion,
  installMatches,
  loadOpportunity,
  loadRoster,
  matchRows,
  profileVersion,
  rosterVersions,
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

const profiles = [
  { seniorId: A, teamIds: ['t1'], techStack: ['Go'] },
  { seniorId: B, teamIds: ['t1'], techStack: ['PHP'] },
  { seniorId: C, teamIds: ['t2'], techStack: ['Rust'] },
]
const rosterWith = (exclusions: JobExclusionDto[]): RosterInputs => ({
  rosterSeniorIds: [A, B, C],
  profiles,
  exclusions,
  versions: rosterVersions(profiles, exclusions),
})
const roster = rosterWith([])

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

  it('SR-L-1: a projection never overwrites an EXCLUDED entry of the same senior', () => {
    const excluded = [
      {
        subject: `SENIOR:${A}`,
        stage: 'SCOPED_RESTRICTIONS' as const,
        reasons: [reason],
        inputs: {},
      },
    ]
    const rows = matchRows(
      evaluated([projection(`SENIOR:${A}`, 'LEAD'), projection(`SENIOR:${B}`, 'LEAD')], excluded),
      roster,
    )
    expect(rows.map((r) => [r.seniorId, r.outcome])).toEqual([
      [A, 'EXCLUDED'],
      [B, 'LEAD'],
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
  })

  it('an exclusion version is order-insensitive and moves with every identifying field', () => {
    const global = exclusion({ id: 'g' })
    const mine = exclusion({
      id: 'm',
      scope: 'SENIOR',
      seniorId: A,
      kind: 'COMPANY',
      normalizedValue: 'acme',
    })
    const v = exclusionVersion([global, mine])
    expect(v).toMatch(/^[0-9a-f]{32}$/)
    expect(exclusionVersion([mine, global])).toBe(v)
    expect(exclusionVersion([global])).not.toBe(v)
    expect(exclusionVersion([global, { ...mine, normalizedValue: 'other' }])).not.toBe(v)
    expect(exclusionVersion([global, { ...mine, kind: 'KEYWORD' }])).not.toBe(v)
    expect(exclusionVersion([global, { ...mine, scope: 'GLOBAL' }])).not.toBe(v)
    expect(exclusionVersion([global, { ...mine, id: 'm2' }])).not.toBe(v)
  })

  it('rosterVersions: per senior, the studio-wide entries plus their own, nobody else', () => {
    const global = exclusion({ id: 'g' })
    const mine = exclusion({ id: 'm', scope: 'SENIOR', seniorId: A, normalizedValue: 'acme' })
    const mine2 = exclusion({ id: 'm2', scope: 'SENIOR', seniorId: A, normalizedValue: 'beta' })
    const theirs = exclusion({ id: 't', scope: 'SENIOR', seniorId: B, normalizedValue: 'evil' })
    const versions = rosterVersions(profiles, [theirs, mine, global, mine2])
    expect([...versions.keys()]).toEqual([A, B, C])
    expect(versions.get(A)).toEqual({
      profile: profileVersion(profiles[0] as (typeof profiles)[0]),
      exclusion: exclusionVersion([global, mine, mine2]),
    })
    expect(versions.get(B)?.exclusion).toBe(exclusionVersion([global, theirs]))
    expect(versions.get(C)?.exclusion).toBe(exclusionVersion([global]))
    expect(rosterVersions(profiles, []).get(C)?.exclusion).toBe(exclusionVersion([]))
  })

  it('CR-M-5: the single-pass rosterVersions gives exactly the hashes of exclusionVersion over each senior own + studio-wide set', () => {
    // Keys that interleave when sorted: studio-wide and own entries alternate, and some own
    // entries sort before every studio-wide one and some after, so both merge branches run.
    const seniors = [A, B, C]
    const all: JobExclusionDto[] = []
    for (let n = 0; n < 24; n += 1) {
      const studioWide = n % 3 === 0
      all.push(
        exclusion({
          id: `x${String((n * 7) % 24).padStart(2, '0')}`,
          scope: studioWide ? 'GLOBAL' : 'SENIOR',
          seniorId: studioWide ? null : (seniors[n % seniors.length] as string),
          kind: n % 2 === 0 ? 'KEYWORD' : 'COMPANY',
          normalizedValue: `v${(n * 5) % 11}`,
        }),
      )
    }
    // The pre-round-2 formula, as an independent oracle: sha256 of the WHOLE applicable set sorted.
    const oracle = (set: JobExclusionDto[]) =>
      createHash('sha256')
        .update(
          JSON.stringify(
            set.map((e) => JSON.stringify([e.scope, e.kind, e.normalizedValue, e.id])).sort(),
          ),
        )
        .digest('hex')
        .slice(0, 32)
    const versions = rosterVersions(profiles, all)
    for (const id of seniors) {
      const applicable = all.filter((e) => e.seniorId === null || e.seniorId === id)
      expect(exclusionVersion(applicable)).toBe(oracle(applicable))
      expect(versions.get(id)?.exclusion).toBe(oracle(applicable))
    }
    // An inconsistent row (no senior, yet scope SENIOR) still goes into the studio-wide part
    // FIRST: the split is by senior, not by the sort order the scope happens to give.
    const odd = exclusion({ id: 'z1', scope: 'SENIOR', seniorId: null, normalizedValue: 'zzz' })
    const own = exclusion({ id: 'a1', scope: 'SENIOR', seniorId: A, normalizedValue: 'aaa' })
    const inOrder = (set: JobExclusionDto[]) =>
      createHash('sha256')
        .update(
          JSON.stringify(
            set.map((e) => JSON.stringify([e.scope, e.kind, e.normalizedValue, e.id])),
          ),
        )
        .digest('hex')
        .slice(0, 32)
    expect(exclusionVersion([own, odd])).toBe(inOrder([odd, own]))
    expect(exclusionVersion([own, odd])).not.toBe(oracle([own, odd]))
    expect(rosterVersions(profiles, [own, odd]).get(A)?.exclusion).toBe(inOrder([odd, own]))
    // Input order does not matter.
    const reversed = rosterVersions(profiles, [...all].reverse())
    for (const id of seniors) expect(reversed.get(id)).toEqual(versions.get(id))
  })
})

describe('loadRoster', () => {
  const seniorsRow = [
    { id: A, tech_stack: ['Go'], team_ids: ['t2', 't1'] },
    { id: B, tech_stack: null, team_ids: ['t1'] },
  ]

  it('an empty roster reads no exclusions', async () => {
    const { tx, statements } = recording()
    expect(await loadRoster(tx)).toEqual({
      rosterSeniorIds: [],
      profiles: [],
      exclusions: [],
      versions: new Map(),
    })
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
          // A second project of the same senior joins their group (not a new one).
          { senior_id: A, name: 'R', company_name: 'Umbrella', archived_at: null },
        ]
      return []
    })
    const r = await loadRoster(tx)
    expect(r.rosterSeniorIds).toEqual([A, B])
    // Versions come with the load, computed from exactly what it returns (CR-M-3).
    expect(r.versions).toEqual(rosterVersions(r.profiles, r.exclusions))
    expect(r.profiles).toEqual([
      { seniorId: A, teamIds: ['t1', 't2'], techStack: ['Go'] },
      { seniorId: B, teamIds: ['t1'], techStack: [] },
    ])
    expect(r.exclusions).toEqual([
      expect.objectContaining({
        id: 'g1',
        scope: 'GLOBAL',
        seniorId: null,
        kind: 'KEYWORD',
        value: 'PHP',
        normalizedValue: 'php',
        createdAt: created.toISOString(),
      }),
      expect.objectContaining({
        id: 's1',
        scope: 'SENIOR',
        seniorId: A,
        kind: 'COMPANY',
        value: 'Acme',
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
        seniorId: A,
        origin: 'PROJECT',
        value: 'Umbrella',
        sourceLabel: 'R',
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
    // No date window (AC 7): the opportunity is read by id alone.
    expect(statements[0]?.sql).not.toMatch(/first_seen_at\s*>|created_at\s*>/)
    // The representative revision: the title's, else the lowest-id ACTIVE member's latest.
    expect(statements[0]?.sql).toMatch(/o\.field_revisions->>'title'/)
    expect(statements[0]?.sql).toMatch(/s\.unlinked_at IS NULL/)
    expect(statements[0]?.sql).toMatch(/ORDER BY c\.prio, c\.record_id\s+LIMIT 1/)
    // Triage grants: unrevoked and unexpired only.
    expect(statements[0]?.sql).toMatch(
      /t\.revoked_at IS NULL\s+AND t\.expires_at > clock_timestamp\(\)/,
    )
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
  const withExclusions = rosterWith([exclusion({ id: 'g' })])

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
          profile_version: withExclusions.versions.get(A)?.profile,
          exclusion_version: withExclusions.versions.get(A)?.exclusion,
        },
      ]),
    ])
    expect(del?.params[2]).toBe(ins?.params[4])
  })

  it('SR-L-3: a verdict senior missing from the roster is poison, never a TypeError, and nothing is written', async () => {
    const { tx, statements } = recording()
    const stranger = '00000000-0000-4000-8000-0000000000ee'
    const err = await installMatches(
      tx,
      OPP,
      1,
      evaluated([projection(`SENIOR:${stranger}`, 'LEAD')]),
      roster,
    ).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(RecomputePoisonError)
    expect(err).toMatchObject({ code: 'VERDICT_SENIOR_NOT_IN_ROSTER' })
    expect(statements).toEqual([])
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
