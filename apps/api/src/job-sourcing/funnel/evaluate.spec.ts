import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  EVALUATE_RULE_VERSION,
  evaluate,
  evaluateBatch,
  projectionsForViewer,
  type BatchEntry,
  type Evaluated,
  type Excluded,
  type CanonicalRevision,
  type EvaluateInput,
  type Reason,
} from './evaluate'
import { rankScore } from './rank'
import type { SeniorTechProfile } from './tech-match'

/* fixtures */
import type { JobExclusionDto } from '@crm/shared'

const NOW = new Date('2026-10-20T12:00:00Z')

const SENIOR_A = '11111111-1111-4111-8111-111111111111'
const SENIOR_B = '22222222-2222-4222-8222-222222222222'
const SENIOR_C = '44444444-4444-4444-8444-444444444444'
const TEAM_1 = '33333333-3333-4333-8333-333333333333'
const TEAM_2 = '55555555-5555-4555-8555-555555555555'
const TEAM_3 = '66666666-6666-4666-8666-666666666666'

const profile = (seniorId: string, techStack: string[], teamIds: string[]): SeniorTechProfile => ({
  seniorId,
  teamIds,
  techStack,
})

const exclusion = (over: Partial<JobExclusionDto>): JobExclusionDto => ({
  id: '77777777-7777-4777-8777-777777777777',
  scope: 'GLOBAL',
  seniorId: null,
  kind: 'KEYWORD',
  value: 'x',
  normalizedValue: 'x',
  origin: 'MANUAL',
  sourceLabel: null,
  createdAt: null,
  ...over,
})

/** A posting that names its stack, is remote, and is not a layer-1 reject. */
const javaRevision = (over: Partial<CanonicalRevision> = {}): CanonicalRevision => ({
  opportunityId: 'opp-1',
  revisionId: 'rev-1',
  companyName: 'Acme',
  fields: {
    title: 'Senior Java Developer',
    location: null,
    descriptionMd: 'Requirements: Java, Spring. Fully remote.',
    remote: true,
    employmentType: null,
    seniorityHint: 'senior',
    tags: ['java'],
    dates: [],
  },
  availability: 'OPEN',
  firstSeenAt: new Date('2026-10-19T12:00:00Z'),
  firstSeenKind: 'NORMAL',
  trustedPublishedAt: null,
  ...over,
})

/** No tags, no requirements, no keyword: layer 2 cannot judge it. */
const unknownStackRevision = (over: Partial<CanonicalRevision> = {}): CanonicalRevision =>
  javaRevision({
    fields: {
      ...javaRevision().fields,
      title: 'Senior Developer',
      descriptionMd: 'Join our friendly team and build great things. Fully remote.',
      tags: [],
    },
    ...over,
  })

const roster = () => ({
  rosterSeniorIds: [SENIOR_A, SENIOR_B, SENIOR_C],
  profiles: [
    profile(SENIOR_A, ['java', 'kotlin'], [TEAM_1]),
    profile(SENIOR_B, ['python'], [TEAM_2]),
    profile(SENIOR_C, ['java'], [TEAM_1, TEAM_3]),
  ],
})

const input = (over: Partial<EvaluateInput> = {}): EvaluateInput => ({
  recordKey: 'rec-1',
  evaluationTime: NOW,
  revision: javaRevision(),
  ...roster(),
  exclusions: [],
  teamTriageGrants: [],
  ...over,
})

const evaluated = (r: BatchEntry): Evaluated => {
  expect(r.kind).toBe('EVALUATED')
  return r as Evaluated
}
const excluded = (r: BatchEntry): Excluded => {
  expect(r.kind).toBe('EXCLUDED')
  return r as Excluded
}
const scopes = (r: Evaluated) => r.projections.map((p) => p.scope)
const projection = (r: Evaluated, scope: string) => r.projections.find((p) => p.scope === scope)

/** SENIOR_C shares SENIOR_A's stack and is excluded through a senior-scoped company entry. */
const cExcluded = () =>
  exclusion({
    id: '88888888-8888-4888-8888-888888888888',
    scope: 'SENIOR',
    seniorId: SENIOR_C,
    kind: 'COMPANY',
    value: 'Acme',
    normalizedValue: 'acme',
  })

describe('evaluate: stage order (AC 1)', () => {
  it('traces every stage in order for a LEAD, each with a rule version', () => {
    const r = evaluated(evaluate(input({ exclusions: [cExcluded()] })))
    expect(r.trace).toEqual([
      { stage: 'REVISION', ruleVersion: EVALUATE_RULE_VERSION },
      { stage: 'CLASSIFICATION', ruleVersion: 'l1.1' },
      { stage: 'GLOBAL_RESTRICTIONS', ruleVersion: EVALUATE_RULE_VERSION },
      { stage: 'SCOPED_RESTRICTIONS', ruleVersion: EVALUATE_RULE_VERSION },
      { stage: 'SKILL_SIGNALS', ruleVersion: EVALUATE_RULE_VERSION },
      { stage: 'PROJECTIONS', ruleVersion: EVALUATE_RULE_VERSION },
      { stage: 'SCORE', ruleVersion: EVALUATE_RULE_VERSION },
    ])
    expect(r).toMatchObject({
      kind: 'EVALUATED',
      recordKey: 'rec-1',
      opportunityId: 'opp-1',
      revisionId: 'rev-1',
      evaluatedAt: '2026-10-20T12:00:00.000Z',
      status: 'LEAD',
    })
    expect(r.layer1.ruleVersion).toBe('l1.1')
  })

  it('skips SCORE when nothing is a LEAD and stops at the stage that excluded', () => {
    const triage = evaluated(evaluate(input({ revision: unknownStackRevision() })))
    expect(triage.status).toBe('TRIAGE')
    expect(triage.trace.map((t) => t.stage)).toEqual([
      'REVISION',
      'CLASSIFICATION',
      'GLOBAL_RESTRICTIONS',
      'SCOPED_RESTRICTIONS',
      'SKILL_SIGNALS',
      'PROJECTIONS',
    ])
    const closed = excluded(evaluate(input({ revision: javaRevision({ availability: 'CLOSED' }) })))
    expect(closed.trace.map((t) => t.stage)).toEqual(['REVISION', 'CLASSIFICATION'])
  })

  it('emits plain JSON only', () => {
    const r = evaluate(input({ exclusions: [cExcluded()] }))
    expect(JSON.parse(JSON.stringify(r))).toEqual(r)
  })
})

describe('evaluate: determinism (AC 2)', () => {
  const reversed = <T>(items: readonly T[]) => [...items].reverse()
  const exclusions = [
    cExcluded(),
    exclusion({ id: '99999999-9999-4999-8999-999999999999', kind: 'COMPANY', value: 'Other' }),
    exclusion({ id: null, scope: 'SENIOR', seniorId: SENIOR_B, kind: 'KEYWORD', value: 'cobol' }),
  ]

  it('gives toEqual output twice and with shuffled roster, profile and exclusion arrays', () => {
    const plain = evaluate(input({ exclusions, teamTriageGrants: [TEAM_1, TEAM_2] }))
    expect(evaluate(input({ exclusions, teamTriageGrants: [TEAM_1, TEAM_2] }))).toEqual(plain)
    const base = roster()
    const shuffled = evaluate(
      input({
        exclusions: reversed(exclusions),
        teamTriageGrants: [TEAM_2, TEAM_1],
        rosterSeniorIds: reversed(base.rosterSeniorIds),
        profiles: reversed(
          base.profiles.map((p) => ({
            ...p,
            teamIds: reversed(p.teamIds),
            techStack: reversed(p.techStack),
          })),
        ),
      }),
    )
    expect(shuffled).toEqual(plain)
    expect(evaluated(plain).projections.length).toBeGreaterThan(2)
  })

  it('orders projections and audit by key, not by input order', () => {
    const r = evaluated(evaluate(input({ exclusions })))
    expect(scopes(r)).toEqual([...scopes(r)].sort())
    expect(scopes(r)).toEqual([`SENIOR:${SENIOR_A}`, 'STUDIO', `TEAM:${TEAM_1}`])
    expect(r.audit.excluded.map((e) => e.subject)).toEqual([`SENIOR:${SENIOR_C}`])
  })

  it('classifies the same revision identically whatever the roster is', () => {
    const a = evaluated(evaluate(input()))
    const b = evaluated(
      evaluate(
        input({ rosterSeniorIds: [SENIOR_B], profiles: [profile(SENIOR_B, ['python'], [TEAM_2])] }),
      ),
    )
    expect(b.layer1).toEqual(a.layer1)
  })
})

describe('evaluate: hard negatives beat unknowns (AC 3)', () => {
  const unknown = unknownStackRevision().fields
  const cases: [string, Parameters<typeof input>[0], string, string][] = [
    [
      'layer-1 REJECT',
      {
        revision: unknownStackRevision({
          fields: { ...unknown, title: 'Junior Developer', seniorityHint: null },
        }),
      },
      'LAYER1_REJECT',
      'CLASSIFICATION',
    ],
    [
      'CLOSED availability',
      { revision: unknownStackRevision({ availability: 'CLOSED' }) },
      'AVAILABILITY_CLOSED',
      'CLASSIFICATION',
    ],
    [
      'EXPIRED availability',
      { revision: unknownStackRevision({ availability: 'EXPIRED' }) },
      'AVAILABILITY_CLOSED',
      'CLASSIFICATION',
    ],
    [
      'global keyword exclusion',
      {
        revision: unknownStackRevision(),
        exclusions: [exclusion({ kind: 'KEYWORD', value: 'Senior Developer' })],
        teamTriageGrants: [TEAM_1],
      },
      'GLOBAL_EXCLUSION',
      'GLOBAL_RESTRICTIONS',
    ],
    [
      'every roster senior excluded',
      {
        revision: unknownStackRevision(),
        exclusions: [SENIOR_A, SENIOR_B, SENIOR_C].map((seniorId, i) =>
          exclusion({
            id: `0000000${i}-0000-4000-8000-000000000000`,
            scope: 'SENIOR',
            seniorId,
            kind: 'COMPANY',
            value: 'Acme',
            normalizedValue: 'acme',
          }),
        ),
        teamTriageGrants: [TEAM_1],
      },
      'SENIOR_EXCLUSION',
      'SCOPED_RESTRICTIONS',
    ],
  ]

  it.each(cases)('%s stays EXCLUDED with an unknown stack', (_name, over, code, stage) => {
    const r = excluded(evaluate(input(over)))
    expect(r.reasons.map((x) => x.code)).toContain(code)
    expect(r.audit.excluded[0]?.stage).toBe(stage)
    expect(r.trace.at(-1)?.stage).toBe(stage)
    expect(projectionsForViewer(r, { role: 'ADMIN' })).toEqual([])
  })

  it('does not exclude on UNKNOWN availability or an ignored global COMPANY entry', () => {
    const r = evaluate(
      input({
        revision: javaRevision({ availability: 'UNKNOWN' }),
        exclusions: [exclusion({ kind: 'COMPANY', value: 'Acme' })],
      }),
    )
    expect(evaluated(r).status).toBe('LEAD')
    expect(evaluated(r).audit.ignoredExclusionIds).toEqual(['77777777-7777-4777-8777-777777777777'])
  })

  it('keeps a layer-1 REJECT even when the global exclusion also matches', () => {
    const r = excluded(
      evaluate(
        input({
          revision: javaRevision({ availability: 'EXPIRED' }),
          exclusions: [exclusion({ kind: 'KEYWORD', value: 'Java' })],
        }),
      ),
    )
    expect(r.trace.at(-1)?.stage).toBe('CLASSIFICATION')
  })
})

describe('evaluate: reasons carry evidence (AC 4)', () => {
  it('has non-empty evidence and a rule version on every reason of every fixture', () => {
    const results = [
      evaluate(input({ exclusions: [cExcluded()] })),
      evaluate(input({ revision: unknownStackRevision(), teamTriageGrants: [TEAM_1] })),
      evaluate(input({ revision: javaRevision({ availability: 'CLOSED' }) })),
      evaluate(
        input({
          revision: javaRevision({
            fields: { ...javaRevision().fields, title: 'Junior Developer', seniorityHint: null },
          }),
        }),
      ),
      evaluate(input({ exclusions: [exclusion({ kind: 'KEYWORD', value: 'Java' })] })),
      evaluate(
        input({
          exclusions: [SENIOR_A, SENIOR_B, SENIOR_C].map((seniorId) =>
            exclusion({ scope: 'SENIOR', seniorId, kind: 'COMPANY', value: 'Acme' }),
          ),
        }),
      ),
    ]
    const reasons: Reason[] = results.flatMap((r) => {
      if (r.kind === 'EXCLUDED')
        return [...r.reasons, ...r.audit.excluded.flatMap((e) => e.reasons)]
      if (r.kind !== 'EVALUATED') return []
      return [
        ...r.projections.flatMap((p) => p.reasons),
        ...r.audit.excluded.flatMap((e) => e.reasons),
      ]
    })
    expect(reasons.length).toBeGreaterThanOrEqual(8)
    for (const reason of reasons) {
      expect(reason.code).not.toBe('')
      expect(reason.evidence.length).toBeGreaterThan(0)
      for (const line of reason.evidence) expect(line).not.toBe('')
      expect(reason.ruleVersion).not.toBe('')
    }
    expect(new Set(reasons.map((r) => r.code))).toEqual(
      new Set([
        'TECH_MATCH',
        'UNKNOWN_STACK',
        'TEAM_TRIAGE_GRANT',
        'SENIOR_EXCLUSION',
        'AVAILABILITY_CLOSED',
        'LAYER1_REJECT',
        'GLOBAL_EXCLUSION',
      ]),
    )
  })

  it('names the layer-1 dimension and its rule version in a rejection', () => {
    const r = excluded(
      evaluate(
        input({
          revision: javaRevision({
            fields: { ...javaRevision().fields, title: 'Junior Developer', seniorityHint: null },
          }),
        }),
      ),
    )
    const rej = r.reasons.find((x) => x.code === 'LAYER1_REJECT')
    expect(rej?.ruleVersion).toBe('l1.1')
    expect(rej?.evidence[0]).toMatch(/^seniority="JUNIOR"/)
  })
})

describe('evaluate: excluded payloads stay out of counts, rank and explanation (AC 5)', () => {
  it('retains the excluded senior in audit and leaves them out of every projection', () => {
    const r = evaluated(evaluate(input({ exclusions: [cExcluded()] })))
    expect(r.audit.excluded).toEqual([
      {
        subject: `SENIOR:${SENIOR_C}`,
        stage: 'SCOPED_RESTRICTIONS',
        reasons: [
          {
            code: 'SENIOR_EXCLUSION',
            evidence: ['SENIOR:COMPANY:88888888-8888-4888-8888-888888888888'],
            ruleVersion: EVALUATE_RULE_VERSION,
          },
        ],
        inputs: {
          seniorId: SENIOR_C,
          exclusionId: '88888888-8888-4888-8888-888888888888',
          exclusionKind: 'COMPANY',
          exclusionScope: 'SENIOR',
        },
      },
    ])
    expect(JSON.stringify(r.projections)).not.toContain(SENIOR_C)
    expect(scopes(r)).not.toContain(`SENIOR:${SENIOR_C}`)
    // SENIOR_C also knows Java: counted, the studio would see 2 matches.
    const studio = projection(r, 'STUDIO')
    expect(studio?.matchCount).toBe(1)
    expect(studio?.score).toBe(
      rankScore({
        evaluationTime: new Date('2026-10-20T12:00:00Z'),
        trustedPublishedAt: null,
        firstSeenAt: new Date('2026-10-19T12:00:00Z'),
        firstSeenKind: 'NORMAL',
        matchCount: 1,
        unknownSeniority: false,
        unknownStack: false,
        unknownRemote: false,
      }).score,
    )
    // The team that only the excluded senior shares sees nothing.
    expect(projection(r, `TEAM:${TEAM_3}`)).toBeUndefined()
  })

  it('scores a wider scope higher when more seniors match', () => {
    const wide = evaluated(evaluate(input()))
    const narrow = evaluated(evaluate(input({ exclusions: [cExcluded()] })))
    expect(projection(wide, 'STUDIO')?.matchCount).toBe(2)
    expect(projection(wide, `TEAM:${TEAM_1}`)?.matchCount).toBe(2)
    expect(projection(wide, `TEAM:${TEAM_3}`)?.matchCount).toBe(1)
    expect(projection(wide, 'STUDIO')?.score).toBeGreaterThan(
      projection(narrow, 'STUDIO')?.score ?? 0,
    )
  })

  it('never exposes the audit through the viewer', () => {
    const r = evaluate(input({ exclusions: [cExcluded()] }))
    const seen = JSON.stringify([
      projectionsForViewer(r, { role: 'ADMIN' }),
      projectionsForViewer(r, { role: 'HR', teamId: TEAM_1 }),
    ])
    expect(seen).not.toContain(SENIOR_C)
    expect(seen).not.toContain('88888888')
    expect(seen).not.toContain('exclusionId')
  })
})

describe('evaluateBatch (AC 6)', () => {
  it('isolates a throwing record and a malformed one, keeping the others unchanged', () => {
    const throwing = input({ recordKey: 'boom' })
    Object.defineProperty(throwing, 'revision', {
      get() {
        throw new Error('exploded')
      },
    })
    const good = input({ recordKey: 'good' })
    const out = evaluateBatch([
      good,
      throwing,
      null as unknown as ReturnType<typeof input>,
      input({ recordKey: '' }),
      input({ recordKey: 'good2', revision: unknownStackRevision() }),
    ])
    expect(out.map((r) => r.kind)).toEqual([
      'EVALUATED',
      'RECORD_FAILED',
      'RECORD_FAILED',
      'RECORD_FAILED',
      'EVALUATED',
    ])
    expect(out[1]).toEqual({ kind: 'RECORD_FAILED', recordKey: 'boom', code: 'EVALUATION_THREW' })
    expect(out[2]).toEqual({ kind: 'RECORD_FAILED', recordKey: '#2', code: 'MALFORMED_RECORD' })
    expect(out[3]).toEqual({ kind: 'RECORD_FAILED', recordKey: '#3', code: 'MALFORMED_RECORD' })
    expect(out[0]).toEqual(evaluate(input({ recordKey: 'good' })))
    expect(out[4]).toEqual(
      evaluate(input({ recordKey: 'good2', revision: unknownStackRevision() })),
    )
    expect(evaluateBatch([])).toEqual([])
  })

  it('answers a missing or invalid revision with a typed INVALID_INPUT, not a throw', () => {
    const bad = (revision: unknown) => evaluate(input({ revision: revision as never }))
    const fields = javaRevision().fields
    expect(bad(null)).toEqual({
      kind: 'INVALID_INPUT',
      recordKey: 'rec-1',
      code: 'MISSING_REVISION',
      trace: [],
    })
    expect(bad(undefined)).toMatchObject({ code: 'MISSING_REVISION' })
    for (const revision of [
      { ...javaRevision(), opportunityId: '' },
      { ...javaRevision(), revisionId: '' },
      { ...javaRevision(), companyName: 5 },
      { ...javaRevision(), fields: null },
      { ...javaRevision(), fields: { ...fields, title: 7 } },
      { ...javaRevision(), fields: { ...fields, tags: 'java' } },
      { ...javaRevision(), availability: 'GONE' },
      { ...javaRevision(), firstSeenAt: new Date('nope') },
      { ...javaRevision(), firstSeenAt: '2026-10-19' },
    ]) {
      expect(bad(revision)).toMatchObject({ kind: 'INVALID_INPUT', code: 'INVALID_REVISION' })
    }
    expect(evaluate(input({ evaluationTime: new Date('nope') }))).toMatchObject({
      kind: 'INVALID_INPUT',
      code: 'INVALID_EVALUATION_TIME',
    })
    expect(evaluate(input({ evaluationTime: '2026-10-20' as never }))).toMatchObject({
      code: 'INVALID_EVALUATION_TIME',
    })
  })

  it('turns a roster readiness issue into RETRYABLE, never filtered and never a LEAD', () => {
    const r = evaluate(input({ rosterSeniorIds: [SENIOR_A, SENIOR_B, SENIOR_C, 'ghost'] }))
    expect(r).toEqual({
      kind: 'RETRYABLE',
      recordKey: 'rec-1',
      code: 'ROSTER_NOT_READY',
      unavailable: [],
      readiness: [{ code: 'MISSING_ROSTER_PROFILES', seniorIds: ['ghost'] }],
      trace: [
        { stage: 'REVISION', ruleVersion: EVALUATE_RULE_VERSION },
        { stage: 'CLASSIFICATION', ruleVersion: 'l1.1' },
        { stage: 'GLOBAL_RESTRICTIONS', ruleVersion: EVALUATE_RULE_VERSION },
        { stage: 'SCOPED_RESTRICTIONS', ruleVersion: EVALUATE_RULE_VERSION },
      ],
    })
    const dup = evaluate(input({ profiles: [...roster().profiles, roster().profiles[0]!] }))
    expect(dup).toMatchObject({ kind: 'RETRYABLE', code: 'ROSTER_NOT_READY' })
  })

  it('turns inputs the caller could not load into RETRYABLE with a sorted list', () => {
    const r = evaluate(input({ unavailable: ['TEAMS', 'EXCLUSIONS'] }))
    expect(r).toEqual({
      kind: 'RETRYABLE',
      recordKey: 'rec-1',
      code: 'INPUT_UNAVAILABLE',
      unavailable: ['EXCLUSIONS', 'TEAMS'],
      readiness: [],
      trace: [
        { stage: 'REVISION', ruleVersion: EVALUATE_RULE_VERSION },
        { stage: 'CLASSIFICATION', ruleVersion: 'l1.1' },
      ],
    })
    expect(evaluate(input({ unavailable: [] })).kind).toBe('EVALUATED')
  })

  it('still excludes a hard negative that needs no roster, even when inputs are unavailable', () => {
    const r = evaluate(
      input({ unavailable: ['ROSTER'], revision: javaRevision({ availability: 'CLOSED' }) }),
    )
    expect(r.kind).toBe('EXCLUDED')
  })
})

describe('evaluate: visibility (AC 7, owner decision)', () => {
  const hr = (teamId: string | null) => ({ role: 'HR', teamId }) as const

  it('HR with an empty team sees nothing, not even the studio view', () => {
    const r = evaluate(input({ teamTriageGrants: [TEAM_1] }))
    expect(projectionsForViewer(r, hr(null))).toEqual([])
    expect(projectionsForViewer(r, hr(''))).toEqual([])
    expect(evaluated(r).status).toBe('LEAD')
  })

  it('HR of team A sees nothing when only team B matches', () => {
    const r = evaluate(input())
    expect(projectionsForViewer(r, hr(TEAM_2))).toEqual([])
    expect(projectionsForViewer(r, hr('77777777-0000-4000-8000-000000000000'))).toEqual([])
  })

  it('HR of team A sees the item when a senior of A matches, and only A', () => {
    const r = evaluate(input())
    const seen = projectionsForViewer(r, hr(TEAM_1))
    expect(seen.map((p) => p.scope)).toEqual([`TEAM:${TEAM_1}`])
    expect(seen[0]).toMatchObject({ status: 'LEAD', matchCount: 2 })
    expect(JSON.stringify(seen)).not.toContain(SENIOR_B)
  })

  it('HR of team B does not see a team A match even with the same posting', () => {
    const r = evaluate(input())
    expect(projectionsForViewer(r, hr(TEAM_3)).map((p) => p.scope)).toEqual([`TEAM:${TEAM_3}`])
    expect(JSON.stringify(projectionsForViewer(r, hr(TEAM_3)))).not.toContain(SENIOR_A)
  })

  it('an unknown-stack item is invisible to HR without a grant', () => {
    const r = evaluate(input({ revision: unknownStackRevision() }))
    for (const team of [TEAM_1, TEAM_2, TEAM_3]) {
      expect(projectionsForViewer(r, hr(team))).toEqual([])
    }
    expect(scopes(evaluated(r))).toEqual(['STUDIO'])
  })

  it('an unknown-stack item with a grant for team A is visible to A only', () => {
    const r = evaluate(input({ revision: unknownStackRevision(), teamTriageGrants: [TEAM_1] }))
    const a = projectionsForViewer(r, hr(TEAM_1))
    expect(a).toHaveLength(1)
    expect(a[0]).toMatchObject({ scope: `TEAM:${TEAM_1}`, status: 'TRIAGE', score: null })
    expect(a[0]?.reasons.map((x) => x.code)).toEqual(['UNKNOWN_STACK', 'TEAM_TRIAGE_GRANT'])
    expect(projectionsForViewer(r, hr(TEAM_2))).toEqual([])
    expect(projectionsForViewer(r, hr(TEAM_3))).toEqual([])
  })

  it('a grant for a team with no matchable senior shows nothing', () => {
    const r = evaluate(
      input({ revision: unknownStackRevision(), teamTriageGrants: ['ghost-team'] }),
    )
    expect(scopes(evaluated(r))).toEqual(['STUDIO'])
  })

  it('ADMIN reads the studio view, TRIAGE included', () => {
    const lead = projectionsForViewer(evaluate(input()), { role: 'ADMIN' })
    expect(lead.map((p) => p.scope)).toEqual(['STUDIO'])
    const triage = projectionsForViewer(evaluate(input({ revision: unknownStackRevision() })), {
      role: 'ADMIN',
    })
    expect(triage[0]).toMatchObject({ scope: 'STUDIO', status: 'TRIAGE', score: null })
  })

  it('has no global unknown pool: a posting nobody matches reaches no HR', () => {
    const r = evaluate(
      input({
        revision: javaRevision({
          fields: {
            ...javaRevision().fields,
            title: 'Senior Cobol Developer',
            tags: ['cobol'],
            descriptionMd: 'Requirements: Cobol. Fully remote.',
          },
        }),
        teamTriageGrants: [TEAM_1],
      }),
    )
    expect(evaluated(r).status).toBe('NO_MATCH')
    expect(evaluated(r).projections).toEqual([])
    for (const team of [TEAM_1, TEAM_2, TEAM_3]) {
      expect(projectionsForViewer(r, hr(team))).toEqual([])
    }
  })

  it('fails closed for any other role and for non-evaluated results', () => {
    const r = evaluate(input())
    expect(projectionsForViewer(r, { role: 'SENIOR' } as never)).toEqual([])
    expect(projectionsForViewer(r, { role: 'JUNIOR', teamId: TEAM_1 } as never)).toEqual([])
    expect(
      projectionsForViewer(
        { kind: 'RECORD_FAILED', recordKey: 'x', code: 'MALFORMED_RECORD' },
        { role: 'ADMIN' },
      ),
    ).toEqual([])
  })
})

describe('evaluate: purity (AC 8)', () => {
  const source = readFileSync(join(__dirname, 'evaluate.ts'), 'utf8')
  const specifiers = [...source.matchAll(/from '([^']+)'/g)].map((m) => m[1])

  it('imports only the composed pure modules and types', () => {
    expect([...new Set(specifiers)].sort()).toEqual(
      ['../filtering', './evaluate.types', './layer1', './rank', './tech-match'].sort(),
    )
  })

  it('reads no clock, no randomness and no network', () => {
    const trap = () => {
      throw new Error('impure call')
    }
    const guards = [
      vi.spyOn(Date, 'now').mockImplementation(trap),
      vi.spyOn(Math, 'random').mockImplementation(trap),
      vi.spyOn(globalThis, 'fetch').mockImplementation(trap),
    ]
    try {
      expect(evaluate(input()).kind).toBe('EVALUATED')
    } finally {
      for (const guard of guards) guard.mockRestore()
    }
  })
})

describe('evaluate: exact outputs', () => {
  const only = (ids: string[]) => ({
    rosterSeniorIds: ids,
    profiles: roster().profiles.filter((p) => ids.includes(p.seniorId)),
  })
  const expectedScore = (flags: { unknownSeniority: boolean; unknownRemote: boolean }) =>
    rankScore({
      evaluationTime: NOW,
      trustedPublishedAt: null,
      firstSeenAt: new Date('2026-10-19T12:00:00Z'),
      firstSeenKind: 'NORMAL',
      matchCount: 1,
      unknownStack: false,
      ...flags,
    }).score

  it('records a closed posting with its inputs and an empty roster audit', () => {
    const r = excluded(evaluate(input({ revision: javaRevision({ availability: 'CLOSED' }) })))
    expect(r.reasons).toEqual([
      { code: 'AVAILABILITY_CLOSED', evidence: ['availability=CLOSED'], ruleVersion: 'eval.1' },
    ])
    expect(r.audit).toEqual({
      excluded: [
        {
          subject: 'OPPORTUNITY',
          stage: 'CLASSIFICATION',
          reasons: r.reasons,
          inputs: { availability: 'CLOSED', rejectedBy: [] },
        },
      ],
      noTeamAccess: [],
      ignoredExclusionIds: [],
    })
  })

  it('records a layer-1 rejection with the dimension value and every evidence line', () => {
    const fields = { ...javaRevision().fields, title: 'Junior Developer', seniorityHint: null }
    const r = excluded(evaluate(input({ revision: javaRevision({ fields }) })))
    expect(r.reasons).toEqual([
      {
        code: 'LAYER1_REJECT',
        evidence: ['seniority="JUNIOR"', 'TITLE:title:LEVEL_JUNIOR:Junior Developer'],
        ruleVersion: 'l1.1',
      },
    ])
    expect(r.audit.excluded[0]).toMatchObject({
      subject: 'OPPORTUNITY',
      inputs: { availability: 'OPEN', rejectedBy: ['seniority'] },
    })
  })

  it('records a global exclusion with the entry it rests on', () => {
    const entry = exclusion({ kind: 'KEYWORD', value: 'Java' })
    const r = excluded(evaluate(input({ exclusions: [entry] })))
    expect(r.reasons).toEqual([
      { code: 'GLOBAL_EXCLUSION', evidence: ['KEYWORD:Java'], ruleVersion: 'eval.1' },
    ])
    expect(r.audit.excluded).toEqual([
      {
        subject: 'OPPORTUNITY',
        stage: 'GLOBAL_RESTRICTIONS',
        reasons: r.reasons,
        inputs: { exclusion: entry },
      },
    ])
  })

  it('treats a senior-scoped keyword exclusion as that senior only, not the studio', () => {
    const entry = exclusion({ scope: 'SENIOR', seniorId: SENIOR_B, kind: 'KEYWORD', value: 'Java' })
    const r = evaluated(evaluate(input({ exclusions: [entry] })))
    expect(r.status).toBe('LEAD')
    expect(r.audit.excluded.map((e) => e.subject)).toEqual([`SENIOR:${SENIOR_B}`])
  })

  it('reads the company alias from the URL only for the source that defines it', () => {
    const entry = exclusion({ kind: 'KEYWORD', value: 'epam systems' })
    const revision = (sourceType: string) =>
      javaRevision({
        companyName: 'Romashka Digital',
        sourceType,
        url: 'https://jobs.dou.ua/companies/epam-systems/vacancies/1/',
      })
    expect(evaluate(input({ revision: revision('DOU_RSS'), exclusions: [entry] })).kind).toBe(
      'EXCLUDED',
    )
    expect(evaluate(input({ revision: revision('HN'), exclusions: [entry] })).kind).toBe(
      'EVALUATED',
    )
  })

  it('reports the same exclusion when several match, whatever the input order', () => {
    const byCompany = exclusion({
      id: '88888888-8888-4888-8888-888888888888',
      scope: 'SENIOR',
      seniorId: SENIOR_C,
      kind: 'COMPANY',
      value: 'Acme',
    })
    const byKeyword = {
      ...byCompany,
      id: '99999999-9999-4999-8999-999999999999',
      kind: 'KEYWORD' as const,
      value: 'Java',
    }
    const idOf = (exclusions: JobExclusionDto[]) =>
      evaluated(evaluate(input({ exclusions }))).audit.excluded[0]?.inputs['exclusionId']
    expect(idOf([byKeyword, byCompany])).toBe(byCompany.id)
    expect(idOf([byCompany, byKeyword])).toBe(byCompany.id)
  })

  it('names the matched keywords once, sorted, with their strength', () => {
    const fields = { ...javaRevision().fields, tags: ['kotlin', 'java'] }
    const r = evaluated(evaluate(input({ revision: javaRevision({ fields }) })))
    const want = [
      { code: 'TECH_MATCH', evidence: ['java:CORE', 'kotlin:CORE'], ruleVersion: 'eval.1' },
    ]
    expect(projection(r, 'STUDIO')?.reasons).toEqual(want)
    expect(projection(r, `TEAM:${TEAM_1}`)?.reasons).toEqual(want)
    expect(projection(r, `SENIOR:${SENIOR_C}`)?.reasons).toEqual([
      { code: 'TECH_MATCH', evidence: ['java:CORE'], ruleVersion: 'eval.1' },
    ])
    expect(projection(r, 'STUDIO')?.rankWarnings).toEqual([])
  })

  it('gives TRIAGE exact reasons: the grant only on the granted team, none on the studio', () => {
    const r = evaluated(
      evaluate(input({ revision: unknownStackRevision(), teamTriageGrants: [TEAM_1] })),
    )
    const unknown = {
      code: 'UNKNOWN_STACK',
      evidence: ['no tags, requirements or keyword hit'],
      ruleVersion: 'eval.1',
    }
    expect(projection(r, 'STUDIO')).toMatchObject({
      status: 'TRIAGE',
      matchCount: 0,
      score: null,
      rankWarnings: [],
      reasons: [unknown],
    })
    expect(projection(r, `TEAM:${TEAM_1}`)).toMatchObject({
      status: 'TRIAGE',
      matchCount: 0,
      rankWarnings: [],
      reasons: [
        unknown,
        { code: 'TEAM_TRIAGE_GRANT', evidence: [`TEAM:${TEAM_1}`], ruleVersion: 'eval.1' },
      ],
    })
    expect(scopes(r)).toEqual(['STUDIO', `TEAM:${TEAM_1}`])
  })

  it('does not call a known stack unknown for a team that does not match it', () => {
    const fields = {
      ...javaRevision().fields,
      title: 'Senior Developer',
      tags: [],
      descriptionMd: 'We use Java daily. Fully remote.',
    }
    const r = evaluated(
      evaluate(input({ revision: javaRevision({ fields }), teamTriageGrants: [TEAM_1, TEAM_2] })),
    )
    expect(r.status).toBe('LEAD')
    expect(projection(r, `TEAM:${TEAM_1}`)?.status).toBe('LEAD')
    expect(projection(r, `TEAM:${TEAM_2}`)).toBeUndefined()
  })

  it('is NO_MATCH, not excluded, when seniors only lack a team', () => {
    const r = evaluated(
      evaluate(
        input({
          rosterSeniorIds: [SENIOR_A],
          profiles: [profile(SENIOR_A, ['java'], [])],
        }),
      ),
    )
    expect(r.status).toBe('NO_MATCH')
    expect(r.projections).toEqual([])
    expect(r.audit).toEqual({ excluded: [], noTeamAccess: [SENIOR_A], ignoredExclusionIds: [] })
    expect(r.trace.map((t) => t.stage)).not.toContain('SCORE')
    expect(r.trace.at(-1)?.stage).toBe('PROJECTIONS')
  })

  it('lowers the score for an unknown seniority and for an unknown workplace', () => {
    const fields = { ...javaRevision().fields, seniorityHint: null, title: 'Java Developer' }
    const score = (over: Partial<typeof fields>) =>
      projection(
        evaluated(
          evaluate(
            input({
              ...only([SENIOR_A]),
              revision: javaRevision({ fields: { ...fields, ...over } }),
            }),
          ),
        ),
        'STUDIO',
      )?.score
    expect(score({ title: 'Senior Java Developer', seniorityHint: 'senior' })).toBe(
      expectedScore({ unknownSeniority: false, unknownRemote: false }),
    )
    expect(score({})).toBe(expectedScore({ unknownSeniority: true, unknownRemote: false }))
    expect(
      score({
        title: 'Senior Java Developer',
        seniorityHint: 'senior',
        remote: null,
        descriptionMd: 'Requirements: Java.',
      }),
    ).toBe(expectedScore({ unknownSeniority: false, unknownRemote: true }))
  })

  it('lists several missing roster profiles in a stable order', () => {
    const r = evaluate(
      input({ rosterSeniorIds: ['ghost-b', SENIOR_A, 'ghost-a', SENIOR_B, SENIOR_C] }),
    )
    expect(r).toMatchObject({
      readiness: [{ code: 'MISSING_ROSTER_PROFILES', seniorIds: ['ghost-a', 'ghost-b'] }],
    })
  })

  it('rejects an identifier that is not a string', () => {
    const bad = (over: object) =>
      evaluate(input({ revision: { ...javaRevision(), ...over } as never }))
    expect(bad({ opportunityId: 7 })).toMatchObject({ code: 'INVALID_REVISION' })
    expect(bad({ revisionId: 7 })).toMatchObject({ code: 'INVALID_REVISION' })
  })
})
