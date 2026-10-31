import type { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import {
  BOARD_URL_SHAPES,
  boardTokenFromUrl,
  discoverBoardTokens,
  knownBoardTokens,
  queryablePool,
  type DiscoveryRow,
  type Queryable,
} from './board-discovery'

describe('boardTokenFromUrl', () => {
  it.each([
    ['https://boards.greenhouse.io/acme/jobs/123', 'greenhouse', 'acme'],
    ['https://jobs.lever.co/acme/abc-def', 'lever', 'acme'],
    ['https://jobs.ashbyhq.com/acme/uuid', 'ashby', 'acme'],
    ['https://acme.recruitee.com/o/some-job', 'recruitee', 'acme'],
    ['https://acme.jobs.personio.de/job/1', 'personio', 'acme'],
    ['https://apply.workable.com/acme/j/ABC/', 'workable', 'acme'],
  ])('%s -> %s:%s', (url, provider, token) => {
    expect(boardTokenFromUrl(url)).toEqual({ provider, token })
  })

  it.each([
    ['https://job-boards.greenhouse.io/acme/jobs/1', 'greenhouse', 'acme'],
    ['https://boards.eu.greenhouse.io/acme/jobs/1', 'greenhouse', 'acme'],
    ['https://job-boards.eu.greenhouse.io/acme/jobs/1', 'greenhouse', 'acme'],
    ['https://jobs.eu.lever.co/acme/abc', 'lever', 'acme'],
    ['https://acme.jobs.personio.com/job/1', 'personio', 'acme'],
  ])('also reads the hosts ats-job-key treats as board hosts: %s', (url, provider, token) => {
    expect(boardTokenFromUrl(url)).toEqual({ provider, token })
  })

  it('lists a single DNS label such as help or api as a candidate (reviewed by a human)', () => {
    expect(boardTokenFromUrl('https://help.recruitee.com/')).toEqual({
      provider: 'recruitee',
      token: 'help',
    })
    expect(boardTokenFromUrl('https://api.jobs.personio.de/')).toEqual({
      provider: 'personio',
      token: 'api',
    })
    expect(boardTokenFromUrl('https://boards.greenhouse.io/embed/job_app')).toEqual({
      provider: 'greenhouse',
      token: 'embed',
    })
    // the one label ats-job-key's own recruitee pattern already refuses
    expect(boardTokenFromUrl('https://www.recruitee.com/')).toBeNull()
  })

  it('has exactly the six providers', () => {
    expect(BOARD_URL_SHAPES.map((s) => s.provider).sort()).toEqual([
      'ashby',
      'greenhouse',
      'lever',
      'personio',
      'recruitee',
      'workable',
    ])
  })

  it('lower-cases the host and the token', () => {
    expect(boardTokenFromUrl('https://Boards.Greenhouse.IO/ACME/jobs/1')).toEqual({
      provider: 'greenhouse',
      token: 'acme',
    })
  })

  it('refuses a URL that matches no shape', () => {
    expect(boardTokenFromUrl('https://example.com/acme')).toBeNull()
    expect(boardTokenFromUrl('https://evil.example/boards.greenhouse.io/acme')).toBeNull()
    expect(boardTokenFromUrl('https://boards.greenhouse.io.evil.example/acme')).toBeNull()
  })

  it('refuses non-https and unparsable input', () => {
    expect(boardTokenFromUrl('http://boards.greenhouse.io/acme')).toBeNull()
    expect(boardTokenFromUrl('not a url')).toBeNull()
  })

  it('refuses a path shape with no token', () => {
    expect(boardTokenFromUrl('https://boards.greenhouse.io/')).toBeNull()
    expect(boardTokenFromUrl('https://boards.greenhouse.io')).toBeNull()
  })

  it('applies the adapter token gate (alphabet and length)', () => {
    expect(boardTokenFromUrl('https://boards.greenhouse.io/a_b')).toBeNull()
    expect(boardTokenFromUrl('https://boards.greenhouse.io/a.b')).toBeNull()
    expect(boardTokenFromUrl(`https://boards.greenhouse.io/${'a'.repeat(65)}`)).toBeNull()
    expect(boardTokenFromUrl(`https://boards.greenhouse.io/${'a'.repeat(64)}`)?.token).toBe(
      'a'.repeat(64),
    )
    // Lever alone accepts a trailing hyphen; Greenhouse does not.
    expect(boardTokenFromUrl('https://jobs.lever.co/quantco-/x')?.token).toBe('quantco-')
    expect(boardTokenFromUrl('https://boards.greenhouse.io/quantco-/x')).toBeNull()
  })

  it('applies the DNS-label gate to a subdomain token', () => {
    // two labels: not a tenant of the host
    expect(boardTokenFromUrl('https://a.b.recruitee.com/')).toBeNull()
    expect(boardTokenFromUrl('https://xn--abc.recruitee.com/')).toBeNull()
    expect(boardTokenFromUrl(`https://${'a'.repeat(63)}.recruitee.com/`)?.token).toBe(
      'a'.repeat(63),
    )
    expect(boardTokenFromUrl(`https://${'a'.repeat(64)}.recruitee.com/`)).toBeNull()
    // the bare host has no tenant
    expect(boardTokenFromUrl('https://recruitee.com/')).toBeNull()
    expect(boardTokenFromUrl('https://jobs.personio.de/')).toBeNull()
    // a path on a subdomain-shaped host is not a token, nor is a subdomain of a path-shaped host
    expect(boardTokenFromUrl('https://recruitee.com/acme')).toBeNull()
    expect(boardTokenFromUrl('https://jobs.personio.de/acme')).toBeNull()
    expect(boardTokenFromUrl('https://x.boards.greenhouse.io/acme')).toBeNull()
    expect(boardTokenFromUrl('https://x.apply.workable.com/acme')).toBeNull()
  })
})

describe('knownBoardTokens', () => {
  it('lists the committed boards as provider:token', () => {
    const known = knownBoardTokens()
    expect(known.has('ashby:linear')).toBe(true)
    expect(known.has('ashby:supabase')).toBe(true)
  })

  it('ignores a line without a string token', () => {
    const known = knownBoardTokens({ ashby: [{ token: 1 }, {}, { token: 'ok' }] })
    expect([...known]).toEqual(['ashby:ok'])
  })

  it('reads every line it is given, regional ones included', () => {
    const known = knownBoardTokens({
      lever: [{ token: 'a' }, { token: 'b', region: 'eu' }],
      ashby: [{ token: 'c' }],
    })
    expect([...known].sort()).toEqual(['ashby:c', 'lever:a', 'lever:b'])
  })
})

const row = (over: Partial<DiscoveryRow>): DiscoveryRow => ({
  urls: [],
  opportunity_id: null,
  matches: 0,
  ...over,
})

const db = (rows: DiscoveryRow[]) => {
  const sql: string[] = []
  const values: unknown[][] = []
  const q: Queryable & { sql: string[]; values: unknown[][] } = {
    sql,
    values,
    query: (text, vals) => {
      sql.push(text)
      values.push(vals ?? [])
      return Promise.resolve({ rows })
    },
  }
  return q
}

describe('queryablePool', () => {
  it('passes text and values through and returns only the rows', async () => {
    const calls: unknown[][] = []
    const r = row({ urls: ['https://jobs.lever.co/a/1'] })
    const fake = (text: string, values?: unknown[]) => {
      calls.push([text, values])
      return Promise.resolve({ rows: [r], rowCount: 1 })
    }
    const q = queryablePool({ query: fake as Pool['query'] })
    expect(await q.query('SELECT 1', [1])).toEqual({ rows: [r] })
    expect(calls).toEqual([['SELECT 1', [1]]])
  })
})

describe('discoverBoardTokens', () => {
  it('counts a token once across URL variants and records, per distinct opportunity', async () => {
    const out = await discoverBoardTokens(
      db([
        row({
          urls: [
            'https://boards.greenhouse.io/Acme/jobs/1',
            'https://boards.greenhouse.io/acme/jobs/1?gh_src=x',
          ],
          opportunity_id: 'o1',
          matches: 2,
        }),
        row({
          urls: ['https://example.com/not-a-board', 'https://boards.greenhouse.io/acme/jobs/2'],
          opportunity_id: 'o1',
          matches: 2,
        }),
        row({
          urls: ['https://boards.greenhouse.io/acme/jobs/3'],
          opportunity_id: 'o2',
          matches: 1,
        }),
        row({ urls: ['https://boards.greenhouse.io/acme/jobs/4'] }),
      ]),
      new Set(),
    )
    expect(out).toEqual([{ provider: 'greenhouse', token: 'acme', opportunities: 2, matches: 3 }])
  })

  it('omits tokens already in a board file but not the same token under another provider', async () => {
    const out = await discoverBoardTokens(
      db([
        row({ urls: ['https://jobs.lever.co/acme/1'], opportunity_id: 'o1' }),
        row({ urls: ['https://jobs.ashbyhq.com/acme/1'], opportunity_id: 'o2' }),
      ]),
      new Set(['lever:acme']),
    )
    expect(out.map((o) => `${o.provider}:${o.token}`)).toEqual(['ashby:acme'])
  })

  it('orders by opportunities, then matches, then provider and token', async () => {
    const out = await discoverBoardTokens(
      db([
        row({ urls: ['https://jobs.lever.co/b/1'], opportunity_id: 'o1', matches: 1 }),
        row({ urls: ['https://jobs.lever.co/a/1'], opportunity_id: 'o2', matches: 1 }),
        row({ urls: ['https://jobs.lever.co/c/1'], opportunity_id: 'o3', matches: 5 }),
        row({ urls: ['https://jobs.lever.co/d/1'], opportunity_id: 'o4', matches: 1 }),
        row({ urls: ['https://jobs.lever.co/d/2'], opportunity_id: 'o5', matches: 1 }),
        row({ urls: ['https://jobs.ashbyhq.com/a/1'], opportunity_id: 'o6', matches: 1 }),
      ]),
      new Set(),
    )
    expect(out.map((o) => `${o.provider}:${o.token}`)).toEqual([
      'lever:d',
      'lever:c',
      'ashby:a',
      'lever:a',
      'lever:b',
    ])
  })

  it('does not return a token that a board file lists only as a regional (EU) board', async () => {
    const known = knownBoardTokens({ lever: [{ token: 'eu-only', region: 'eu' }] })
    const out = await discoverBoardTokens(
      db([
        row({ urls: ['https://jobs.lever.co/eu-only/1'], opportunity_id: 'o1' }),
        row({ urls: ['https://jobs.eu.lever.co/eu-only/2'], opportunity_id: 'o2' }),
        row({ urls: ['https://jobs.lever.co/other/1'], opportunity_id: 'o3' }),
      ]),
      known,
    )
    expect(out.map((o) => o.token)).toEqual(['other'])
  })

  it('discovers tokens seen only under job-boards.greenhouse.io or jobs.personio.com', async () => {
    const out = await discoverBoardTokens(
      db([
        row({ urls: ['https://job-boards.greenhouse.io/ghonly/jobs/1'], opportunity_id: 'o1' }),
        row({ urls: ['https://pe-only.jobs.personio.com/job/1'], opportunity_id: 'o2' }),
      ]),
      new Set(),
    )
    expect(out.map((o) => `${o.provider}:${o.token}`).sort()).toEqual([
      'greenhouse:ghonly',
      'personio:pe-only',
    ])
  })

  it('lists a token with no linked opportunity with zero counts', async () => {
    const out = await discoverBoardTokens(
      db([row({ urls: ['https://jobs.lever.co/solo/1'] })]),
      new Set(),
    )
    expect(out).toEqual([{ provider: 'lever', token: 'solo', opportunities: 0, matches: 0 }])
  })

  it('asks for the six board hosts, nothing else', async () => {
    const d = db([])
    await discoverBoardTokens(d, new Set())
    expect(d.values).toEqual([
      [
        [
          '%greenhouse.io%',
          '%lever.co%',
          '%jobs.ashbyhq.com%',
          '%apply.workable.com%',
          '%recruitee.com%',
          '%jobs.personio.%',
        ],
      ],
    ])
  })

  it('sends one SELECT over the three URL columns and nothing else', async () => {
    const d = db([])
    await discoverBoardTokens(d, new Set())
    expect(d.sql).toHaveLength(1)
    expect(d.sql[0]).toMatch(/^\s*SELECT\b/i)
    for (const c of ['original_url', 'display_url', 'application_url']) {
      expect(d.sql[0]).toContain(`r.${c} ILIKE ANY($1)`)
    }
    expect(d.sql[0]).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|CREATE|DROP)\b/i)
  })
})
