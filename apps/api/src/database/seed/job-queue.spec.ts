import { createHash } from 'node:crypto'
import { PgDialect } from 'drizzle-orm/pg-core'
import type { SQL } from 'drizzle-orm'
import type { JobExclusionDto } from '@crm/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  loadRoster,
  MATCH_RULE_VERSION,
  opportunityInputsVersion,
  type RosterInputs,
  type SeniorVersions,
} from '../../job-sourcing/runtime/recompute-inputs'
import { ARTEM_ID, DMYTRO_ID, HR0_ID, HR2_ID, OLEKSIY_ID, SENIOR_SHARED_ID } from './ids'
import {
  jobQueueSeedProblems,
  seedJobQueue,
  verifyJobQueueSeed,
  type JobQueueSeedFacts,
} from './job-queue'
import { leadEvidence, SEED_QUEUE_OPPORTUNITIES } from './job-queue.data'
import type { SeedDb } from './shared'

vi.mock('../../job-sourcing/runtime/recompute-inputs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../job-sourcing/runtime/recompute-inputs')>()),
  loadRoster: vi.fn(),
}))

/**
 * Task 7.6a — what the job-queue seed writes and how its read-back check fails. The db is a
 * recording fake: every `execute` is compiled by the real Postgres dialect, so the assertions
 * are on the exact SQL text and parameters the seed sends.
 */
interface Statement {
  readonly text: string
  readonly params: unknown[]
}

const dialect = new PgDialect()
const compile = (q: SQL): Statement => {
  const { sql, params } = dialect.sqlToQuery(q)
  return { text: sql.replace(/\s+/g, ' ').trim(), params }
}

const versionsOf = (id: string): SeniorVersions => ({ profile: `p-${id}`, exclusion: `x-${id}` })
const LIVE = new Map(
  [OLEKSIY_ID, SENIOR_SHARED_ID, ARTEM_ID, DMYTRO_ID].map((id) => [id, versionsOf(id)]),
)
// One studio-wide and one senior-owned keyword: only the studio-wide one versions an opportunity.
const STUDIO_WIDE = { seniorId: null, scope: 'GLOBAL', kind: 'KEYWORD', value: 'gambling' }
const SENIOR_OWNED = { seniorId: OLEKSIY_ID, scope: 'GLOBAL', kind: 'KEYWORD', value: 'crypto' }
const roster = (versions: ReadonlyMap<string, SeniorVersions>): RosterInputs => ({
  rosterSeniorIds: [...versions.keys()],
  profiles: [],
  exclusions: [STUDIO_WIDE, SENIOR_OWNED] as unknown as JobExclusionDto[],
  versions,
})

let log: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
  vi.mocked(loadRoster).mockResolvedValue(roster(LIVE))
})
afterEach(() => vi.restoreAllMocks())

describe('seedJobQueue — the rows it writes', () => {
  const run = async (): Promise<Statement[]> => {
    const statements: Statement[] = []
    const ids = { opp: 0, rec: 0 }
    const db = {
      execute: (q: SQL) => {
        const s = compile(q)
        statements.push(s)
        if (s.text.startsWith('INSERT INTO job_opportunities ')) {
          return Promise.resolve({ rows: [{ id: `opp-${++ids.opp}` }] })
        }
        if (s.text.startsWith('INSERT INTO job_source_records ')) {
          return Promise.resolve({ rows: [{ id: `rec-${++ids.rec}` }] })
        }
        return Promise.resolve({ rows: [] })
      },
    } as unknown as SeedDb
    await seedJobQueue({ db })
    return statements
  }
  const into = (statements: Statement[], table: string) =>
    statements.filter((s) => s.text.startsWith(`INSERT INTO ${table} `)).map((s) => s.params)
  const text = (key: string) => SEED_QUEUE_OPPORTUNITIES.find((o) => o.key === key)!.description
  const sha = (key: string) => createHash('sha256').update(text(key), 'utf8').digest('hex')
  const IV = opportunityInputsVersion([STUDIO_WIDE] as unknown as JobExclusionDto[])

  it('stores each description once, keyed by its sha256', async () => {
    const keys = SEED_QUEUE_OPPORTUNITIES.map((o) => o.key)
    expect(into(await run(), 'job_text_blobs')).toEqual(keys.map((k) => [sha(k), text(k)]))
  })

  it('writes every opportunity OPEN at the inputs version of the studio-wide exclusions only', async () => {
    expect(IV).not.toBe(opportunityInputsVersion([]))
    expect(into(await run(), 'job_opportunities')).toEqual([
      // title, title key, employer, employer key, verified, keywords..., sha, [published days], first-seen days, inputs version, role family
      [
        'Seed: React Platform Engineer',
        'seed-react-platform',
        'Seed Platform Labs',
        'seed platform labs',
        true,
        'React',
        'TypeScript',
        'Node.js',
        sha('react-platform'),
        1,
        1,
        IV,
        'SOFTWARE',
      ],
      [
        'Seed: Data Pipeline Engineer',
        'seed-data-pipeline',
        'Seed Data Works',
        'seed data works',
        true,
        'Python',
        'PostgreSQL',
        sha('data-pipeline'),
        2,
        2,
        IV,
        'DATA',
      ],
      [
        'Seed: Unclear Stack Vacancy',
        'seed-unclear-stack',
        'Seed Mystery Startup',
        'seed mystery startup',
        false,
        sha('unclear-stack'),
        3,
        3,
        IV,
        null,
      ],
      [
        'Seed: Unsafe Description',
        'seed-unsafe-description',
        'Seed Hostile Markup Inc',
        'seed hostile markup inc',
        true,
        'React',
        'TypeScript',
        sha('unsafe-description'),
        1,
        1,
        IV,
        'SOFTWARE',
      ],
      // No trusted published date: published_at is NULL, first seen a day ago.
      [
        'Seed: Uncertain Match',
        'seed-uncertain-match',
        'Seed Fuzzy Signals',
        'seed fuzzy signals',
        true,
        'Python',
        'AWS',
        sha('uncertain-match'),
        1,
        IV,
        'SOFTWARE',
      ],
    ])
  })

  it('upserts one seed-namespace source record per source, alternating the two ATS types', async () => {
    const url = (key: string, n: number) => `https://jobs.example.test/seed/${key}/${n}`
    expect(into(await run(), 'job_source_records')).toEqual([
      ['GREENHOUSE_ATS', 'seed', 'seed-react-platform-1', url('react-platform', 1)],
      ['LEVER_ATS', 'seed', 'seed-react-platform-2', url('react-platform', 2)],
      ['GREENHOUSE_ATS', 'seed', 'seed-data-pipeline-1', url('data-pipeline', 1)],
      ['GREENHOUSE_ATS', 'seed', 'seed-unclear-stack-1', url('unclear-stack', 1)],
      ['GREENHOUSE_ATS', 'seed', 'seed-unsafe-description-1', url('unsafe-description', 1)],
      ['GREENHOUSE_ATS', 'seed', 'seed-uncertain-match-1', url('uncertain-match', 1)],
    ])
  })

  it('links each record to its opportunity, the first one earliest (the primary source)', async () => {
    // record id, opportunity id, seconds before now()
    expect(into(await run(), 'job_opportunity_sources')).toEqual([
      ['rec-1', 'opp-1', 2],
      ['rec-2', 'opp-1', 1],
      ['rec-3', 'opp-2', 1],
      ['rec-4', 'opp-3', 1],
      ['rec-5', 'opp-4', 1],
      ['rec-6', 'opp-5', 1],
    ])
  })

  it('stamps every LEAD with the live versions of its senior and the current rule version', async () => {
    const lead = (opp: string, id: string, title: string) => {
      const l = SEED_QUEUE_OPPORTUNITIES.find((o) => o.title === title)!.leads.find(
        (x) => x.seniorId === id,
      )!
      return [opp, id, `p-${id}`, `x-${id}`, MATCH_RULE_VERSION, JSON.stringify(leadEvidence(l))]
    }
    expect(into(await run(), 'job_opportunity_matches')).toEqual([
      lead('opp-1', OLEKSIY_ID, 'Seed: React Platform Engineer'),
      lead('opp-1', SENIOR_SHARED_ID, 'Seed: React Platform Engineer'),
      lead('opp-1', ARTEM_ID, 'Seed: React Platform Engineer'),
      lead('opp-2', DMYTRO_ID, 'Seed: Data Pipeline Engineer'),
      lead('opp-4', OLEKSIY_ID, 'Seed: Unsafe Description'),
      lead('opp-5', OLEKSIY_ID, 'Seed: Uncertain Match'),
    ])
  })

  it('sends exactly these statements', async () => {
    expect([...new Set((await run()).map((s) => s.text))]).toMatchInlineSnapshot(`
      [
        "INSERT INTO job_text_blobs (sha256, text) VALUES ($1, $2) ON CONFLICT DO NOTHING",
        "INSERT INTO job_opportunities (title, title_key, revision, availability, employer_name, employer_key, employer_verified, stack_keywords, description_sha256, published_at, first_seen_at, last_observed_at, evaluated_revision, evaluation_verdict, evaluated_inputs_version, role_family) VALUES ($1, $2, 1, 'OPEN', $3, $4, $5, ARRAY[$6, $7, $8]::text[], $9, now() - make_interval(days => $10::int), now() - make_interval(days => $11::int), now(), 1, 'OPEN', $12, $13) RETURNING id",
        "INSERT INTO job_source_records (source_type, namespace, identity_kind, identity_key, source_url) VALUES ($1::job_source_type, $2, 'NATIVE_ID', $3, $4) ON CONFLICT (source_type, namespace, identity_key) DO UPDATE SET last_observed_at = now() RETURNING id",
        "INSERT INTO job_opportunity_sources (source_record_id, opportunity_id, rule_version, linked_at) VALUES ($1::uuid, $2::uuid, 'r1', now() - make_interval(secs => $3::int))",
        "INSERT INTO job_opportunity_matches (opportunity_id, senior_id, opportunity_revision, senior_profile_version, exclusion_version, rule_version, outcome, evidence) VALUES ($1::uuid, $2::uuid, 1, $3, $4, $5, 'LEAD', $6::jsonb)",
        "INSERT INTO job_opportunities (title, title_key, revision, availability, employer_name, employer_key, employer_verified, stack_keywords, description_sha256, published_at, first_seen_at, last_observed_at, evaluated_revision, evaluation_verdict, evaluated_inputs_version, role_family) VALUES ($1, $2, 1, 'OPEN', $3, $4, $5, ARRAY[$6, $7]::text[], $8, now() - make_interval(days => $9::int), now() - make_interval(days => $10::int), now(), 1, 'OPEN', $11, $12) RETURNING id",
        "INSERT INTO job_opportunities (title, title_key, revision, availability, employer_name, employer_key, employer_verified, stack_keywords, description_sha256, published_at, first_seen_at, last_observed_at, evaluated_revision, evaluation_verdict, evaluated_inputs_version, role_family) VALUES ($1, $2, 1, 'OPEN', $3, $4, $5, ARRAY[]::text[], $6, now() - make_interval(days => $7::int), now() - make_interval(days => $8::int), now(), 1, 'OPEN', $9, $10) RETURNING id",
        "INSERT INTO job_opportunities (title, title_key, revision, availability, employer_name, employer_key, employer_verified, stack_keywords, description_sha256, published_at, first_seen_at, last_observed_at, evaluated_revision, evaluation_verdict, evaluated_inputs_version, role_family) VALUES ($1, $2, 1, 'OPEN', $3, $4, $5, ARRAY[$6, $7]::text[], $8, NULL, now() - make_interval(days => $9::int), now(), 1, 'OPEN', $10, $11) RETURNING id",
      ]
    `)
  })

  it('logs the phase and what it inserted', async () => {
    await run()
    expect(log.mock.calls).toEqual([
      ['\n[7b/8] Inserting job-queue opportunities...'],
      ['  ✓ 5 opportunities, 6 LEAD matches inserted'],
    ])
  })

  it('refuses a matched senior who is not on a team (no live versions to stamp)', async () => {
    const withoutArtem = new Map([...LIVE].filter(([id]) => id !== ARTEM_ID))
    vi.mocked(loadRoster).mockResolvedValue(roster(withoutArtem))
    await expect(run()).rejects.toThrow(
      new Error(`job-queue seed: senior ${ARTEM_ID} not on a team`),
    )
  })
})

/** The read-back of a correct seed; listed in reverse so no check may rely on row order. */
const goodFacts = (): JobQueueSeedFacts => ({
  sources: SEED_QUEUE_OPPORTUNITIES.map((o) => ({
    title: o.title,
    sources: o.sourceCount,
  })).reverse(),
  leads: SEED_QUEUE_OPPORTUNITIES.flatMap((o) =>
    o.leads.map((l) => ({ title: o.title, seniorId: l.seniorId, ...flat(versionsOf(l.seniorId)) })),
  ).reverse(),
  memberships: [
    { userId: SENIOR_SHARED_ID, team: 'Team Marchenko' },
    { userId: SENIOR_SHARED_ID, team: 'Team Kovalenko' },
    { userId: HR2_ID, team: 'Team Kovalenko' },
  ],
  versions: LIVE,
})
const flat = (v: SeniorVersions) => ({ profile: v.profile, exclusion: v.exclusion })
const REACT = 'Seed: React Platform Engineer'
const DATA = 'Seed: Data Pipeline Engineer'
const withLeads = (f: JobQueueSeedFacts, leads: JobQueueSeedFacts['leads']): JobQueueSeedFacts => ({
  ...f,
  leads,
})

describe('jobQueueSeedProblems — every drift the queue would show silently', () => {
  it('finds nothing in a correct seed', () => {
    expect(jobQueueSeedProblems(goodFacts())).toEqual([])
  })

  it('reports a missing opportunity', () => {
    const f = goodFacts()
    const problems = jobQueueSeedProblems({
      ...withLeads(
        f,
        f.leads.filter((l) => l.title !== DATA),
      ),
      sources: f.sources.filter((s) => s.title !== DATA),
    })
    expect(problems).toEqual([
      `${DATA}: 0 linked sources, expected 1`,
      `${DATA}: LEAD seniors differ from the contract`,
    ])
  })

  it('reports an unlinked source', () => {
    const f = goodFacts()
    const sources = f.sources.map((s) => (s.title === REACT ? { ...s, sources: 1 } : s))
    expect(jobQueueSeedProblems({ ...f, sources })).toEqual([
      `${REACT}: 1 linked sources, expected 2`,
    ])
  })

  it('reports a lost match', () => {
    const f = goodFacts()
    const leads = f.leads.filter((l) => !(l.title === REACT && l.seniorId === ARTEM_ID))
    expect(jobQueueSeedProblems(withLeads(f, leads))).toEqual([
      `${REACT}: LEAD seniors differ from the contract`,
    ])
  })

  it('reports a match moved to another senior', () => {
    const f = goodFacts()
    const leads = f.leads.map((l) =>
      l.title === REACT && l.seniorId === ARTEM_ID
        ? { ...l, seniorId: DMYTRO_ID, ...flat(versionsOf(DMYTRO_ID)) }
        : l,
    )
    expect(jobQueueSeedProblems(withLeads(f, leads))).toEqual([
      `${REACT}: LEAD seniors differ from the contract`,
    ])
  })

  it.each([
    ['profile', { profile: 'stale' }],
    ['exclusion', { exclusion: 'stale' }],
  ])('reports a match whose %s version is not the live one', (_, stale) => {
    const f = goodFacts()
    const leads = f.leads.map((l) => (l.title === DATA ? { ...l, ...stale } : l))
    expect(jobQueueSeedProblems(withLeads(f, leads))).toEqual([
      `${DATA}: the match of ${DMYTRO_ID} is not at the live roster versions`,
    ])
  })

  it('reports a match whose senior has no live versions (left every team)', () => {
    const versions = new Map([...LIVE].filter(([id]) => id !== DMYTRO_ID))
    expect(jobQueueSeedProblems({ ...goodFacts(), versions })).toEqual([
      `${DATA}: the match of ${DMYTRO_ID} is not at the live roster versions`,
    ])
  })

  it('reports U-HR2 outside Team Kovalenko', () => {
    const f = goodFacts()
    const memberships = f.memberships.filter((m) => m.userId !== HR2_ID)
    expect(jobQueueSeedProblems({ ...f, memberships })).toEqual([
      'U-HR2: teams [], expected [Team Kovalenko]',
    ])
  })

  it('reports U-HR0 in any team', () => {
    const f = goodFacts()
    const memberships = [...f.memberships, { userId: HR0_ID, team: 'Team Marchenko' }]
    expect(jobQueueSeedProblems({ ...f, memberships })).toEqual([
      'U-HR0: teams [Team Marchenko], expected []',
    ])
  })

  it('reports S-SHARED not in both teams', () => {
    const f = goodFacts()
    const memberships = f.memberships.filter((m) => m.team !== 'Team Marchenko')
    expect(jobQueueSeedProblems({ ...f, memberships })).toEqual([
      'S-SHARED: teams [Team Kovalenko], expected [Team Kovalenko, Team Marchenko]',
    ])
  })
})

describe('verifyJobQueueSeed — reads the facts back and fails the seed on a problem', () => {
  const run = async (facts: JobQueueSeedFacts): Promise<Statement[]> => {
    const statements: Statement[] = []
    const db = {
      execute: (q: SQL) => {
        const s = compile(q)
        statements.push(s)
        if (
          s.text.includes(
            'LEFT JOIN job_opportunity_sources s ON s.opportunity_id = o.id AND s.unlinked_at IS NULL',
          )
        ) {
          return Promise.resolve({ rows: facts.sources })
        }
        if (
          s.text.includes(
            "FROM job_opportunity_matches m JOIN job_opportunities o ON o.id = m.opportunity_id WHERE m.outcome = 'LEAD'",
          )
        ) {
          return Promise.resolve({ rows: facts.leads })
        }
        if (
          s.text.includes(
            'FROM team_members tm JOIN teams t ON t.id = tm.team_id WHERE tm.left_at IS NULL',
          )
        ) {
          return Promise.resolve({ rows: facts.memberships })
        }
        return Promise.resolve({ rows: [] })
      },
    } as unknown as SeedDb
    vi.mocked(loadRoster).mockResolvedValue(roster(facts.versions))
    await verifyJobQueueSeed({ db })
    return statements
  }

  it('passes a correct seed, asking for exactly the contract titles and users', async () => {
    const titles = SEED_QUEUE_OPPORTUNITIES.map((o) => o.title)
    const statements = await run(goodFacts())
    expect(statements.map((s) => s.params)).toEqual([
      titles,
      titles,
      [HR2_ID, HR0_ID, SENIOR_SHARED_ID],
    ])
    expect(statements.map((s) => s.text)).toMatchInlineSnapshot(`
      [
        "SELECT o.title, count(s.source_record_id)::int AS sources FROM job_opportunities o LEFT JOIN job_opportunity_sources s ON s.opportunity_id = o.id AND s.unlinked_at IS NULL WHERE o.title IN ($1, $2, $3, $4, $5) GROUP BY o.title",
        "SELECT o.title, m.senior_id::text AS "seniorId", m.senior_profile_version AS profile, m.exclusion_version AS exclusion FROM job_opportunity_matches m JOIN job_opportunities o ON o.id = m.opportunity_id WHERE m.outcome = 'LEAD' AND o.title IN ($1, $2, $3, $4, $5)",
        "SELECT tm.user_id::text AS "userId", t.name AS team FROM team_members tm JOIN teams t ON t.id = tm.team_id WHERE tm.left_at IS NULL AND tm.user_id IN ($1, $2, $3)",
      ]
    `)
    expect(log.mock.calls).toEqual([['  Job-queue seed opportunities: 5 (expected: 5)']])
  })

  it('throws every problem in one error', async () => {
    const f = goodFacts()
    const facts = {
      ...f,
      sources: f.sources.filter((s) => s.title !== REACT),
      memberships: f.memberships.filter((m) => m.userId !== HR2_ID),
    }
    await expect(run(facts)).rejects.toThrow(
      new Error(
        `job-queue seed incomplete: ${REACT}: 0 linked sources, expected 2; ` +
          'U-HR2: teams [], expected [Team Kovalenko]',
      ),
    )
    expect(log.mock.calls).toEqual([['  Job-queue seed opportunities: 4 (expected: 5)']])
  })
})
