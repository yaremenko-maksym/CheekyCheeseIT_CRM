import { createHash } from 'node:crypto'
import type { JobQueueListQuery } from '@crm/shared'
import type { SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import { describe, expect, it } from 'vitest'
import {
  cardRow,
  duplicateRows,
  filterIdentity,
  likePattern,
  listFilters,
  policySignature,
  rankSelect,
  queueRowJoins,
  seniorRows,
  seniorTotal,
  sourceRows,
  sourceTotal,
} from './queue-read-sql'
import { MATCH_RULE_VERSION } from '../runtime/recompute-inputs'
import type { JobQueueScope, LiveSeniorVersion } from './queue-scope'

/** What each fragment binds; that the SQL works on real rows is the integration spec's job. */
const TEAM = '11111111-1111-4111-8111-111111111111'
const TEAM_2 = '22222222-2222-4222-8222-222222222222'
const SEN = '33333333-3333-4333-8333-333333333333'
const OPP = '44444444-4444-4444-8444-444444444444'
const versions: LiveSeniorVersion[] = [{ seniorId: SEN, profile: 'p', exclusion: 'e' }]
const team: JobQueueScope = {
  kind: 'TEAM',
  teamId: TEAM,
  seniorIds: [SEN],
  versions,
  inputsVersion: 'inputs-1',
}
const studio: JobQueueScope = { kind: 'STUDIO' }
const render = (q: SQL) => {
  const r = new PgDialect().sqlToQuery(q)
  return { text: r.sql.replace(/\s+/g, ' '), params: r.params }
}
const query = (over: Partial<JobQueueListQuery> = {}): JobQueueListQuery => ({
  tab: 'NEW',
  limit: 20,
  ...over,
})

describe('likePattern', () => {
  it('wraps the text and makes its wildcards literal', () => {
    expect(likePattern('50%_a\\b')).toBe('%50\\%\\_a\\\\b%')
  })
})

describe('listFilters', () => {
  it('always filters by the tab, and adds nothing unasked', () => {
    const filters = listFilters(query({ tab: 'SUBMITTED' }), versions)
    expect(filters).toHaveLength(1)
    expect(render(filters[0] as SQL)).toEqual({ text: 'd.tab = $1', params: ['SUBMITTED'] })
  })

  it('search covers title and employer with one escaped pattern', () => {
    const f = render(listFilters(query({ search: 'a%' }), versions)[1] as SQL)
    expect(f.text).toBe('(o.title ILIKE $1 OR o.employer_name ILIKE $2)')
    expect(f.params).toEqual(['%a\\%%', '%a\\%%'])
  })

  it('source looks at the active links only', () => {
    const f = render(listFilters(query({ source: ['DOU_RSS'] }), versions)[1] as SQL)
    expect(f.text).toContain('fs.unlinked_at IS NULL')
    expect(f.text).toContain('fr.source_url IS NOT NULL AND fr.source_type::text IN')
    expect(f.params).toEqual(['["DOU_RSS"]'])
  })

  it('eligibility, availability and activity read their own expression', () => {
    const f = listFilters(
      query({ eligibility: ['LEAD'], availability: ['OPEN'], activity: ['OPENED'] }),
      versions,
    ).map((x) => render(x))
    expect(f[1]?.text).toContain('d.eligibility IN')
    expect(f[1]?.params).toEqual(['["LEAD"]'])
    expect(f[2]?.text).toContain('o.availability::text IN')
    expect(f[2]?.params).toEqual(['["OPEN"]'])
    expect(f[3]?.text).toContain('d.activity IN')
    expect(f[3]?.params).toEqual(['["OPENED"]'])
  })

  it('a senior filter needs a live match of that senior, never an EXCLUDED row', () => {
    const f = render(listFilters(query({ seniorId: SEN.toUpperCase() }), versions)[1] as SQL)
    expect(f.text).toContain(`m.outcome IN ('LEAD', 'TRIAGE')`)
    expect(f.params).toContain(SEN)
  })
})

describe('filterIdentity', () => {
  it('ignores list order and id case, and not much else', () => {
    expect(
      filterIdentity(query({ source: ['DOU_RSS', 'REMOTEOK_API'], seniorId: SEN.toUpperCase() })),
    ).toEqual(filterIdentity(query({ source: ['REMOTEOK_API', 'DOU_RSS'], seniorId: SEN })))
  })
  it('stores a senior id in its canonical lowercase', () => {
    const upper = 'ABCDEFAB-ABCD-4ABC-8ABC-ABCDEFABCDEF'
    expect(filterIdentity(query({ seniorId: upper }))[6]).toBe(upper.toLowerCase())
  })
  it('holds every filter, with the absent ones explicit', () => {
    expect(filterIdentity(query())).toEqual(['NEW', null, [], [], [], [], null])
    expect(
      filterIdentity(
        query({
          tab: 'HIDDEN',
          search: 's',
          source: ['REMOTEOK_API'],
          eligibility: ['TRIAGE', 'LEAD'],
          availability: ['OPEN', 'CLOSED'],
          activity: ['OPENED', 'NOT_OPENED'],
          seniorId: SEN,
        }),
      ),
    ).toEqual([
      'HIDDEN',
      's',
      ['REMOTEOK_API'],
      ['LEAD', 'TRIAGE'],
      ['CLOSED', 'OPEN'],
      ['NOT_OPENED', 'OPENED'],
      SEN,
    ])
  })
  it('does not reorder the query it was given', () => {
    const q = query({ eligibility: ['TRIAGE', 'LEAD'] })
    filterIdentity(q)
    expect(q.eligibility).toEqual(['TRIAGE', 'LEAD'])
  })
})

describe('policySignature', () => {
  const base = () => policySignature(team, versions)
  it('is a hex digest the generation column can hold', () => {
    expect(base()).toMatch(/^[0-9a-f]{64}$/)
  })
  it('is the sha-256 of the kind, the team, the rule version and the versions', () => {
    const json = JSON.stringify(['TEAM', TEAM, MATCH_RULE_VERSION, versions])
    expect(policySignature(team, versions)).toBe(createHash('sha256').update(json).digest('hex'))
  })
  it('is stable for the same inputs', () => {
    expect(policySignature({ ...team }, [...versions])).toBe(base())
  })
  it.each([
    ['another team', { ...team, teamId: TEAM_2 } as JobQueueScope, versions],
    ['the studio', studio, versions],
    ['another profile version', team, [{ ...versions[0], profile: 'p2' }]],
    ['another exclusion version', team, [{ ...versions[0], exclusion: 'e2' }]],
    ['a roster without the senior', team, []],
  ])('changes with %s', (_label, scope, v) => {
    expect(policySignature(scope, v as LiveSeniorVersion[])).not.toBe(base())
  })
})

describe('field scoping — what each read binds', () => {
  it('match-derived counts use the scope versions only', () => {
    const joins = render(queueRowJoins(team, versions))
    expect(joins.params).toContain(
      JSON.stringify([{ senior_id: SEN, profile: 'p', exclusion: 'e' }]),
    )
    expect(joins.text).toContain('m.senior_profile_version = v.profile')
    expect(joins.text).toContain('m.exclusion_version = v.exclusion')
    expect(joins.text).toContain(`m.evidence->>'stage' = 'SCOPED_RESTRICTIONS'`)
  })

  it('workflow rows of a TEAM scope name that team: submissions, dismissals, opens', () => {
    const { text } = render(queueRowJoins(team, versions))
    for (const column of ['AND a.team_id = $', 'AND d.team_id = $', 'AND qa.team_id = $']) {
      expect(text).toContain(column)
    }
    expect(text).toContain(`qa.kind = 'OPENED'`)
    expect(text).toContain(`a.state = 'TAKEN'`)
    expect(text).toContain('d.undone_at IS NULL')
  })

  it('a STUDIO scope hides on a STUDIO dismissal, not on a team one', () => {
    const { text, params } = render(queueRowJoins(studio, []))
    expect(text).toContain('d.scope_kind = $')
    expect(params).toContain('STUDIO')
  })

  it('the rank reads LEAD rows of the given versions only, with the rank weights', () => {
    const { text, params } = render(rankSelect(versions))
    expect(text).toContain(`m.outcome = 'LEAD'`)
    expect(params).toContain(JSON.stringify([{ senior_id: SEN, profile: 'p', exclusion: 'e' }]))
    expect(params).toEqual(expect.arrayContaining([10]))
  })

  it('the rank is clamped to the 1000 ceiling rankScore documents', () => {
    const { text, params } = render(rankSelect(versions))
    expect(text).toContain('SELECT LEAST((COALESCE(max(')
    expect(text).toMatch(/- 1, 0\)\)::int, \$\d+::int\) AS score/)
    expect(params).toEqual(expect.arrayContaining([1000]))
  })

  it('a match counts only at the current revision, under the current rule (SR-L-2)', () => {
    const { text, params } = render(rankSelect(versions))
    expect(text).toContain('m.opportunity_id = o.id AND m.opportunity_revision = o.revision')
    expect(text).toContain(
      'm.senior_profile_version = v.profile AND m.exclusion_version = v.exclusion',
    )
    expect(text).toContain('AND m.rule_version = $')
    expect(params).toContain(MATCH_RULE_VERSION)
  })

  it('the primary source has a URL and is the first active link (SR-L-2)', () => {
    const { text } = render(queueRowJoins(team, versions))
    expect(text).toContain(
      'WHERE s.opportunity_id = o.id AND s.unlinked_at IS NULL AND r.source_url IS NOT NULL ORDER BY s.linked_at, s.source_record_id LIMIT 1',
    )
  })

  it('the foreign-submission marker is correlated to this senior on this opportunity (SR-M-1)', () => {
    const { text } = render(seniorRows(team, versions, OPP, undefined, 201))
    expect(text).toContain(
      "FROM job_queue_assignments f WHERE f.opportunity_id = o.id AND f.senior_id = ms.senior_id AND f.state = 'TAKEN' AND (f.team_id = $",
    )
    expect(text).toContain(') IS NOT TRUE ) AS submitted_elsewhere')
  })

  it('a card row is re-checked for visibility and uses this scope for the newer-than check', () => {
    const { text, params } = render(cardRow(team, versions, OPP))
    expect(text).toContain('FROM job_opportunity_team_triage g')
    expect(text).toContain('::job_queue_scope_kind AND g.team_id = $')
    expect(text).toContain(`WHERE m.opportunity_id = o.id AND m.outcome = 'LEAD'`)
    expect(text).toContain('b.text AS description')
    expect(params).toEqual(expect.arrayContaining([OPP, TEAM, 'TEAM']))
  })

  it('card seniors select submission columns through the own-scope join only', () => {
    const { text, params } = render(seniorRows(team, versions, OPP, undefined, 201))
    expect(text).toContain(
      `LEFT JOIN job_queue_assignments a ON a.opportunity_id = o.id AND a.senior_id = ms.senior_id AND a.team_id = $`,
    )
    expect(text).toContain(`AND f.state = 'TAKEN' AND (f.team_id = $`)
    expect(text).toContain(') IS NOT TRUE')
    expect(text).toContain('AND TRUE ORDER BY ms.senior_id')
    expect(params).toEqual(expect.arrayContaining([OPP, TEAM, 201]))
  })

  it('card seniors resume after the given key', () => {
    const { text, params } = render(seniorRows(team, versions, OPP, SEN, 201))
    expect(text).toContain('ms.senior_id > $')
    expect(params).toContain(SEN)
  })

  it('the senior total counts the same matched set', () => {
    const { text, params } = render(seniorTotal(versions, OPP))
    expect(text).toContain(`m.outcome IN ('LEAD', 'TRIAGE')`)
    expect(params).toContain(OPP)
  })

  it('sources are the active links of this opportunity', () => {
    const page = render(sourceRows(OPP, undefined, 21))
    expect(page.text).toContain('s.unlinked_at IS NULL AND r.source_url IS NOT NULL')
    expect(page.text).toContain('AND TRUE ORDER BY s.source_record_id')
    expect(page.params).toEqual([OPP, 21])
    expect(render(sourceRows(OPP, SEN, 21)).params).toEqual([OPP, SEN, 21])
    expect(render(sourceTotal(OPP)).params).toEqual([OPP])
  })

  it('duplicates are filtered by visibility in this scope, per duplicate', () => {
    const { text, params } = render(duplicateRows(team, OPP, 5))
    expect(text).toContain(
      'JOIN job_opportunities dup ON (dup.id = o.id OR (o.employer_key IS NOT NULL AND dup.employer_key = o.employer_key AND dup.title_key = o.title_key)) AND dup.id <> o.id',
    )
    expect(text).toContain('m.opportunity_id = dup.id')
    expect(params).toEqual(expect.arrayContaining([OPP, TEAM, 5]))
  })
})
