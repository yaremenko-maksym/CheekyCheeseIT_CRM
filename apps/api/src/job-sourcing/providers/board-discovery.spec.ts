import { describe, expect, it } from 'vitest'
import {
  BOARD_URL_SHAPES,
  boardTokenFromUrl,
  discoverBoardTokens,
  knownBoardTokens,
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
  })
})

describe('knownBoardTokens', () => {
  it('lists the committed boards as provider:token', () => {
    const known = knownBoardTokens()
    expect(known.has('ashby:linear')).toBe(true)
    expect(known.has('ashby:supabase')).toBe(true)
  })

  it('reads lines it is given, ignoring regional lever boards', () => {
    const known = knownBoardTokens({
      lever: [{ token: 'a' }, { token: 'b', region: 'eu' }],
      ashby: [{ token: 'c' }],
    })
    expect([...known].sort()).toEqual(['ashby:c', 'lever:a'])
  })
})

const row = (over: Partial<DiscoveryRow>): DiscoveryRow => ({
  original_url: null,
  display_url: null,
  application_url: null,
  opportunity_id: null,
  matches: 0,
  ...over,
})

const db = (rows: DiscoveryRow[]): Queryable & { sql: string[] } => {
  const sql: string[] = []
  return {
    sql,
    query: (text) => {
      sql.push(text)
      return Promise.resolve({ rows })
    },
  } as Queryable & { sql: string[] }
}

describe('discoverBoardTokens', () => {
  it('counts a token once across URL variants and records, per distinct opportunity', async () => {
    const out = await discoverBoardTokens(
      db([
        row({
          original_url: 'https://boards.greenhouse.io/Acme/jobs/1',
          display_url: 'https://boards.greenhouse.io/acme/jobs/1?gh_src=x',
          opportunity_id: 'o1',
          matches: 2,
        }),
        row({
          application_url: 'https://boards.greenhouse.io/acme/jobs/2',
          opportunity_id: 'o1',
          matches: 2,
        }),
        row({
          original_url: 'https://boards.greenhouse.io/acme/jobs/3',
          opportunity_id: 'o2',
          matches: 1,
        }),
        row({ original_url: 'https://boards.greenhouse.io/acme/jobs/4' }),
      ]),
      new Set(),
    )
    expect(out).toEqual([{ provider: 'greenhouse', token: 'acme', opportunities: 2, matches: 3 }])
  })

  it('omits tokens already in a board file but not the same token under another provider', async () => {
    const out = await discoverBoardTokens(
      db([
        row({ original_url: 'https://jobs.lever.co/acme/1', opportunity_id: 'o1' }),
        row({ original_url: 'https://jobs.ashbyhq.com/acme/1', opportunity_id: 'o2' }),
      ]),
      new Set(['lever:acme']),
    )
    expect(out.map((o) => `${o.provider}:${o.token}`)).toEqual(['ashby:acme'])
  })

  it('orders by opportunities, then matches, then provider and token', async () => {
    const out = await discoverBoardTokens(
      db([
        row({ original_url: 'https://jobs.lever.co/b/1', opportunity_id: 'o1', matches: 1 }),
        row({ original_url: 'https://jobs.lever.co/a/1', opportunity_id: 'o2', matches: 1 }),
        row({ original_url: 'https://jobs.lever.co/c/1', opportunity_id: 'o3', matches: 5 }),
        row({ original_url: 'https://jobs.lever.co/d/1', opportunity_id: 'o4', matches: 1 }),
        row({ original_url: 'https://jobs.lever.co/d/2', opportunity_id: 'o5', matches: 1 }),
      ]),
      new Set(),
    )
    expect(out.map((o) => o.token)).toEqual(['d', 'c', 'a', 'b'])
  })

  it('lists a token with no linked opportunity with zero counts', async () => {
    const out = await discoverBoardTokens(
      db([row({ original_url: 'https://jobs.lever.co/solo/1' })]),
      new Set(),
    )
    expect(out).toEqual([{ provider: 'lever', token: 'solo', opportunities: 0, matches: 0 }])
  })

  it('sends one SELECT and nothing else', async () => {
    const d = db([])
    await discoverBoardTokens(d, new Set())
    expect(d.sql).toHaveLength(1)
    expect(d.sql[0]).toMatch(/^\s*SELECT\b/i)
    expect(d.sql[0]).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|CREATE|DROP)\b/i)
  })
})
