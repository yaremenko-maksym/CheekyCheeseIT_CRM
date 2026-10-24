import { describe, expect, it } from 'vitest'
import { ZodError } from 'zod'
import { fakeCollectionContext } from '../../../test/fake-collection-context'
import { readProvenance } from '../../../test/fixture-provenance'
import { sourceFixtureText } from '../../../test/source-fixtures'
import { ownershipCountOf } from '../manifest.ownership'
import { UnvalidatedConfigError } from '../reporting-provider'
import {
  ASHBY_KIND,
  ATS_MAX_BOARDS_PER_GROUP,
  ATS_PROPOSED_REQUEST_GAP_MS,
  ATS_SLUG_MAX_CHARS,
  atsBoardGroupSchema,
  atsNamespace,
  boardConfigsOf,
  boardVerdictOf,
  collectBoardGroup,
  GREENHOUSE_KIND,
  LEVER_KIND,
  presentStrings,
} from './ats-config'
import { ashbyProvider } from './ashby.provider'
import { greenhouseProvider } from './greenhouse.provider'
import { leverProvider } from './lever.provider'

/**
 * The shared ATS board config: the slug refusal table (the security surface of this task), the
 * employer-evidence rule, the 300-board group, and the board-level verdicts. Expected values are
 * literals written from the task's refusal table and the documented/observed slug facts, never
 * produced by calling the schema under test.
 */

const PROVIDERS = [
  { label: 'greenhouse', provider: greenhouseProvider, kind: GREENHOUSE_KIND },
  { label: 'lever', provider: leverProvider, kind: LEVER_KIND },
  { label: 'ashby', provider: ashbyProvider, kind: ASHBY_KIND },
] as const

/** Every entry is a way to make a board slug steer a request somewhere else, or to name two boards as one. */
const REFUSED_SLUGS = [
  ['a parent-directory hop', '../x'],
  ['a parent-directory hop, deeper', '../../etc/passwd'],
  ['a path separator', 'a/b'],
  ['a leading path separator', '/a'],
  ['a backslash separator', 'a\\b'],
  ['an encoded separator', 'a%2Fb'],
  ['an encoded separator, lowercase', 'a%2fb'],
  ['an encoded dot-dot', '%2e%2e'],
  ['a bare percent', 'a%'],
  ['a single dot', '.'],
  ['dot-dot', '..'],
  ['a dot inside the name', 'a.b'],
  ['userinfo', 'user@host'],
  ['userinfo with a password', 'user:pw@host'],
  ['a foreign host', 'evil.example'],
  ['a foreign host with a path', 'evil.example/x'],
  ['a full URL', 'https://evil.example'],
  ['a protocol-relative URL', '//evil.example'],
  ['a port', 'host:8080'],
  ['a query string', 'a?x=1'],
  ['a fragment', 'a#frag'],
  ['a space', 'a b'],
  ['a leading space', ' a'],
  ['a trailing newline', 'a\n'],
  ['a NUL', 'a\u0000b'],
  ['uppercase (one board would get two namespaces)', 'Linear'],
  ['a leading hyphen', '-a'],
  ['a leading underscore', '_a'],
  ['non-ASCII letters', 'café'],
  ['a full-width letter', 'ａ'],
  ['the empty string', ''],
  ['one past the maximum length', 'a'.repeat(ATS_SLUG_MAX_CHARS + 1)],
] as const

const goodConfig = (board: string, extra: Record<string, unknown> = {}) => ({
  configVersion: 1,
  board,
  ...extra,
})

function trailingHyphenVerdict(
  provider: { parseConfig(raw: unknown): unknown },
  slug: string,
): 'accepted' | 'refused' {
  try {
    provider.parseConfig(goodConfig(slug))
    return 'accepted'
  } catch {
    return 'refused'
  }
}

function issuePaths(fn: () => unknown): string[] {
  try {
    fn()
  } catch (error) {
    // De-duplicated: the empty string breaks two rules (min length and alphabet) on one field.
    if (error instanceof ZodError) return [...new Set(error.issues.map((i) => i.path.join('.')))]
    throw error
  }
  throw new Error('expected a ZodError, got no throw')
}

describe.each(PROVIDERS)('$label: board slug refusal table', ({ provider, kind }) => {
  it.each(REFUSED_SLUGS)('refuses %s (%j) in parseConfig, naming the board field', (_why, slug) => {
    expect(issuePaths(() => provider.parseConfig(goodConfig(slug)))).toEqual(['board'])
  })

  it('refuses every row of the table BEFORE any context exists, so no request can be made', async () => {
    const built: string[] = []
    const run = await collectBoardGroup(
      provider as never,
      REFUSED_SLUGS.map(([, slug]) => goodConfig(slug)),
      (namespace) => {
        built.push(namespace)
        throw new Error('a context was built for a refused config')
      },
    )
    expect(built).toEqual([])
    expect(run.boards).toHaveLength(REFUSED_SLUGS.length)
    expect(run.boards.every((b) => b.verdict === 'CONFIG_INVALID')).toBe(true)
    expect(run.boards.every((b) => b.batch === null && b.namespace === null)).toBe(true)
    // A refused config is a CONFIG problem, not an outage of the source.
    expect(run.sourceFailure).toBe(false)
    expect(run.deadBoards).toEqual([])
  })

  it('refuses a hand-built config that skipped parseConfig, and the fetch stub is never called', async () => {
    const f = fakeCollectionContext({ responses: [{ status: 200, bodyText: '[]' }] })
    await expect(
      provider.collectReport({ ...goodConfig('../x'), namespace: 'x' } as never, f.ctx),
    ).rejects.toBeInstanceOf(UnvalidatedConfigError)
    expect(f.sent).toEqual([])
  })

  it('accepts a slug of exactly the maximum length, and refuses the next one', () => {
    const max = 'a'.repeat(ATS_SLUG_MAX_CHARS)
    expect(ATS_SLUG_MAX_CHARS).toBe(64)
    expect(provider.parseConfig(goodConfig(max)).board).toBe(max)
    expect(() => provider.parseConfig(goodConfig(max + 'a'))).toThrow(ZodError)
  })

  it.each(['a', 'x1', '1password', 'data-science', 'leverdemo-8', 'siteimprove'])(
    'accepts the real-shaped slug %j',
    (slug) => {
      expect(provider.parseConfig(goodConfig(slug)).board).toBe(slug)
    },
  )

  it.each(['a--b', 'a_b', 'snake_case', 'a_', 'a-_b', 'a--', 'x1--', 'a---'])(
    'refuses %j: no board read needs an underscore or a doubled hyphen',
    (slug) => {
      expect(issuePaths(() => provider.parseConfig(goodConfig(slug)))).toEqual(['board'])
    },
  )

  it.each(['a-', 'quantco-', 'x1-'])(
    'a trailing hyphen (%j) is accepted only where it is evidenced: Lever',
    (slug) => {
      expect(trailingHyphenVerdict(provider, slug)).toBe(
        kind.label === 'lever' ? 'accepted' : 'refused',
      )
    },
  )

  it.each([
    ['host', 'evil.example'],
    ['baseUrl', 'https://evil.example'],
    ['url', 'https://evil.example/v1/boards/x/jobs'],
    ['endpoint', '/v1/boards'],
    ['employerName', 'Stripe'],
  ])('the config cannot carry a %s: hosts belong to the adapter, never to config', (key, value) => {
    expect(() => provider.parseConfig(goodConfig('ok', { [key]: value }))).toThrow(ZodError)
  })

  it('derives the namespace from the board and refuses a different one', () => {
    const cfg = provider.parseConfig(goodConfig('ok'))
    expect(cfg.namespace).toBe(atsNamespace(kind, 'global', 'ok'))
    expect(provider.parseConfig(goodConfig('ok', { namespace: cfg.namespace })).namespace).toBe(
      cfg.namespace,
    )
    expect(
      issuePaths(() => provider.parseConfig(goodConfig('ok', { namespace: 'other:ok' }))),
    ).toEqual([''])
  })

  it('refuses a search query and a date window: an ATS board has neither', () => {
    expect(() => provider.parseConfig(goodConfig('ok', { query: 'python' }))).toThrow(ZodError)
    expect(() =>
      provider.parseConfig(
        goodConfig('ok', { window: { from: '2026-10-01T00:00:00Z', to: '2026-10-02T00:00:00Z' } }),
      ),
    ).toThrow(ZodError)
  })

  it('has no employer unless somebody supplied evidence: a title-cased slug is never a company name', () => {
    expect(provider.parseConfig(goodConfig('stripe')).employer).toBeNull()
  })
})

describe('namespaces', () => {
  it('are literal: provider label, then region only where the provider has regions, then the slug', () => {
    expect(atsNamespace(GREENHOUSE_KIND, 'global', 'stripe')).toBe('greenhouse:stripe')
    expect(atsNamespace(ASHBY_KIND, 'global', 'linear')).toBe('ashby:linear')
    expect(atsNamespace(LEVER_KIND, 'global', 'spotify')).toBe('lever:global:spotify')
    expect(atsNamespace(LEVER_KIND, 'eu', 'siteimprove')).toBe('lever:eu:siteimprove')
  })

  it('give the same Lever slug on the two hosts two different identities', () => {
    const global = leverProvider.parseConfig(goodConfig('x', { region: 'global' }))
    const eu = leverProvider.parseConfig(goodConfig('x', { region: 'eu' }))
    expect([global.namespace, eu.namespace]).toEqual(['lever:global:x', 'lever:eu:x'])
  })

  it.each(PROVIDERS)(
    '$label: the default region is global, and global may also be named',
    ({ provider }) => {
      expect(provider.parseConfig(goodConfig('x')).region).toBe('global')
      expect(provider.parseConfig(goodConfig('x', { region: 'global' })).region).toBe('global')
    },
  )

  it('exist only for the regions a provider really has', () => {
    expect(() => greenhouseProvider.parseConfig(goodConfig('x', { region: 'eu' }))).toThrow(
      ZodError,
    )
    expect(() => ashbyProvider.parseConfig(goodConfig('x', { region: 'eu' }))).toThrow(ZodError)
    expect(() => leverProvider.parseConfig(goodConfig('x', { region: 'us' }))).toThrow(ZodError)
    expect(leverProvider.parseConfig(goodConfig('x')).region).toBe('global')
  })
})

describe('employer evidence', () => {
  // The count is READ from the provenance notes (backlog 285), not kept here as a second copy.
  const airbnb = ownershipCountOf(
    readProvenance('greenhouse', 'airbnb-board.provenance.json').notes,
  )!
  const employer = {
    name: 'Airbnb',
    domain: 'careers.airbnb.com',
    evidence: `company_name is "Airbnb" on ${airbnb.matched} of ${airbnb.total} jobs in the payload`,
  }

  it('is carried verbatim when given', () => {
    expect(greenhouseProvider.parseConfig(goodConfig('airbnb', { employer })).employer).toEqual(
      employer,
    )
  })

  it('trims the name and defaults the domain to null', () => {
    const e = greenhouseProvider.parseConfig(
      goodConfig('airbnb', { employer: { name: '  Airbnb ', evidence: ' how ' } }),
    ).employer
    expect(e).toEqual({ name: 'Airbnb', domain: null, evidence: 'how' })
  })

  it.each([
    ['an empty name', { ...employer, name: '' }],
    ['a blank name', { ...employer, name: '   ' }],
    ['a name past 255 characters', { ...employer, name: 'n'.repeat(256) }],
    ['no evidence', { name: 'Airbnb', domain: null }],
    ['blank evidence', { ...employer, evidence: ' ' }],
    ['evidence past 500 characters', { ...employer, evidence: 'e'.repeat(501) }],
    ['a URL as the domain', { ...employer, domain: 'https://careers.airbnb.com' }],
    ['a domain with a path', { ...employer, domain: 'careers.airbnb.com/jobs' }],
    ['a domain with userinfo', { ...employer, domain: 'a@careers.airbnb.com' }],
    ['a single-label domain', { ...employer, domain: 'localhost' }],
    ['an unexpected key', { ...employer, logo: 'x' }],
    ['an upper-case domain', { ...employer, domain: 'Careers.Airbnb.com' }],
    ['a domain label starting with a hyphen', { ...employer, domain: '-a.airbnb.com' }],
    ['a domain label ending with a hyphen', { ...employer, domain: 'a-.airbnb.com' }],
    ['an empty domain label', { ...employer, domain: 'careers..airbnb.com' }],
    ['a trailing dot', { ...employer, domain: 'careers.airbnb.com.' }],
    ['a domain with a port', { ...employer, domain: 'careers.airbnb.com:443' }],
    [
      'a domain of 254 characters',
      {
        ...employer,
        domain: `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(59)}.co`,
      },
    ],
  ])('refuses %s', (_why, bad) => {
    expect(() => greenhouseProvider.parseConfig(goodConfig('airbnb', { employer: bad }))).toThrow(
      ZodError,
    )
  })

  it.each([
    ['a hyphen inside a label', 'my-company.example.com'],
    ['digits', 'a1.b2.example'],
    ['a punycode label', 'xn--bcher-kva.example'],
    ['two labels', 'airbnb.com'],
    ['single-character labels', 'a.b'],
    ['a one-letter label, then a longer one', 'a.bc'],
    ['a longer label, then a one-letter one', 'ab.c'],
    [
      'a domain of exactly 253 characters',
      `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(58)}.co`,
    ],
  ])('accepts a domain with %s', (_why, domain) => {
    expect(
      greenhouseProvider.parseConfig(goodConfig('airbnb', { employer: { ...employer, domain } }))
        .employer?.domain,
    ).toBe(domain)
  })

  it('accepts a name of exactly 255 and evidence of exactly 500 characters', () => {
    const e = greenhouseProvider.parseConfig(
      goodConfig('airbnb', { employer: { name: 'n'.repeat(255), evidence: 'e'.repeat(500) } }),
    ).employer
    expect([e?.name.length, e?.evidence.length]).toEqual([255, 500])
  })
})

describe('a manifest group of boards', () => {
  const group = atsBoardGroupSchema(LEVER_KIND)
  const boards = (n: number) => Array.from({ length: n }, (_, i) => ({ board: `board-${i}` }))

  it('accepts 300 boards and refuses the 301st', () => {
    expect(ATS_MAX_BOARDS_PER_GROUP).toBe(300)
    expect(group.parse({ configVersion: 1, boards: boards(300) }).boards).toHaveLength(300)
    expect(() => group.parse({ configVersion: 1, boards: boards(301) })).toThrow(ZodError)
  })

  it('refuses an empty group and an unknown key', () => {
    expect(() => group.parse({ configVersion: 1, boards: [] })).toThrow(ZodError)
    expect(() => group.parse({ configVersion: 1, boards: boards(1), host: 'x.example' })).toThrow(
      ZodError,
    )
  })

  it('refuses a board listed twice, but allows one slug on both Lever hosts', () => {
    expect(() =>
      group.parse({ configVersion: 1, boards: [{ board: 'a' }, { board: 'a' }] }),
    ).toThrow(ZodError)
    const both = group.parse({
      configVersion: 1,
      boards: [
        { board: 'a', region: 'global' },
        { board: 'a', region: 'eu' },
      ],
    })
    expect(both.boards.map((b) => b.region)).toEqual(['global', 'eu'])
  })

  it('refuses a bad slug inside the group with the entry that carries it', () => {
    const r = group.safeParse({ configVersion: 1, boards: [{ board: 'ok' }, { board: '../x' }] })
    expect(r.success).toBe(false)
    expect(r.error?.issues.map((i) => i.path.join('.'))).toEqual(['boards.1.board'])
  })

  it('refuses a configVersion the store would refuse', () => {
    expect(() => group.parse({ configVersion: 0, boards: boards(1) })).toThrow(ZodError)
    expect(() => group.parse({ configVersion: 2 ** 31, boards: boards(1) })).toThrow(ZodError)
    expect(group.parse({ configVersion: 2 ** 31 - 1, boards: boards(1) }).configVersion).toBe(
      2 ** 31 - 1,
    )
  })

  it('turns into per-board provider configs, in order, each carrying the group version', () => {
    const parsed = group.parse({
      configVersion: 7,
      boards: [
        { board: 'a', employer: { name: 'A Corp', evidence: 'x' } },
        { board: 'b', region: 'eu' },
      ],
    })
    expect(boardConfigsOf(parsed)).toEqual([
      {
        configVersion: 7,
        board: 'a',
        region: 'global',
        employer: { name: 'A Corp', domain: null, evidence: 'x' },
      },
      { configVersion: 7, board: 'b', region: 'eu', employer: null },
    ])
  })
})

describe('running a group: independent boards, independent failures', () => {
  const NOW = new Date('2026-10-24T04:00:00Z')
  const spotify = sourceFixtureText('lever', 'spotify-page1')
  const eu = sourceFixtureText('lever', 'siteimprove-eu-board')
  const notFound = sourceFixtureText('lever', 'board-not-found')

  function harness(script: Record<string, { status: number; bodyText: string }>) {
    const contexts = new Map<string, ReturnType<typeof fakeCollectionContext>>()
    const order: string[] = []
    return {
      contexts,
      order,
      contextFor: (namespace: string) => {
        order.push(namespace)
        const response = script[namespace]
        if (response === undefined) throw new Error(`no script for ${namespace}`)
        const f = fakeCollectionContext({ now: NOW, responses: [response] })
        contexts.set(namespace, f)
        return f.ctx
      },
    }
  }

  const inputs = [
    goodConfig('spotify', {
      employer: { name: 'Spotify', evidence: 'posting text names Spotify' },
    }),
    goodConfig('cheeky-nonexistent-board-0001'),
    goodConfig('siteimprove', {
      region: 'eu',
      employer: { name: 'Siteimprove', evidence: 'posting text names Siteimprove' },
    }),
  ]

  it('a dead board (404) is a BOARD error: the other boards still run and the source did not fail', async () => {
    const h = harness({
      'lever:global:spotify': { status: 200, bodyText: spotify },
      'lever:global:cheeky-nonexistent-board-0001': { status: 404, bodyText: notFound },
      'lever:eu:siteimprove': { status: 200, bodyText: eu },
    })
    const run = await collectBoardGroup(leverProvider, inputs, h.contextFor)
    expect(run.boards.map((b) => [b.namespace, b.verdict])).toEqual([
      ['lever:global:spotify', 'SUCCEEDED'],
      ['lever:global:cheeky-nonexistent-board-0001', 'BOARD_NOT_FOUND'],
      ['lever:eu:siteimprove', 'SUCCEEDED'],
    ])
    expect(run.deadBoards).toEqual(['lever:global:cheeky-nonexistent-board-0001'])
    expect(run.sourceFailure).toBe(false)
    expect(run.boards.map((b) => b.batch?.counts.normalized)).toEqual([6, 0, 3])
  })

  it('each board gets its own context, built in order, and only its own request is sent on it', async () => {
    const h = harness({
      'lever:global:spotify': { status: 200, bodyText: spotify },
      'lever:global:cheeky-nonexistent-board-0001': { status: 404, bodyText: notFound },
      'lever:eu:siteimprove': { status: 200, bodyText: eu },
    })
    await collectBoardGroup(leverProvider, inputs, h.contextFor)
    expect(h.order).toEqual([
      'lever:global:spotify',
      'lever:global:cheeky-nonexistent-board-0001',
      'lever:eu:siteimprove',
    ])
    expect([...h.contexts.values()].map((f) => f.sent.length)).toEqual([1, 1, 1])
    expect(h.contexts.get('lever:global:spotify')?.sent[0]?.url).toBe(
      'https://api.lever.co/v0/postings/spotify?mode=json&limit=50&skip=0',
    )
    expect(h.contexts.get('lever:eu:siteimprove')?.sent[0]?.url).toBe(
      'https://api.eu.lever.co/v0/postings/siteimprove?mode=json&limit=50&skip=0',
    )
  })

  it('checkpoints are per board: the 404 board saves none and does not touch its neighbours', async () => {
    const h = harness({
      'lever:global:spotify': { status: 200, bodyText: spotify },
      'lever:global:cheeky-nonexistent-board-0001': { status: 404, bodyText: notFound },
      'lever:eu:siteimprove': { status: 200, bodyText: eu },
    })
    await collectBoardGroup(leverProvider, inputs, h.contextFor)
    expect(h.contexts.get('lever:global:spotify')?.saved).toHaveLength(1)
    expect(h.contexts.get('lever:global:cheeky-nonexistent-board-0001')?.saved).toHaveLength(0)
    expect(h.contexts.get('lever:eu:siteimprove')?.saved).toHaveLength(1)
  })

  it('a 5xx is a SOURCE failure, and it does not stop the boards after it', async () => {
    const h = harness({
      'lever:global:spotify': { status: 503, bodyText: 'unavailable' },
      'lever:global:cheeky-nonexistent-board-0001': { status: 404, bodyText: notFound },
      'lever:eu:siteimprove': { status: 200, bodyText: eu },
    })
    const run = await collectBoardGroup(leverProvider, inputs, h.contextFor)
    expect(run.boards.map((b) => b.verdict)).toEqual([
      'SOURCE_FAILED',
      'BOARD_NOT_FOUND',
      'SUCCEEDED',
    ])
    expect(run.sourceFailure).toBe(true)
    expect(run.deadBoards).toEqual(['lever:global:cheeky-nonexistent-board-0001'])
  })

  it('a refused config in the middle makes no request and the run goes on', async () => {
    const h = harness({
      'lever:global:spotify': { status: 200, bodyText: spotify },
      'lever:eu:siteimprove': { status: 200, bodyText: eu },
    })
    const run = await collectBoardGroup(
      leverProvider,
      [inputs[0], goodConfig('../x'), inputs[2]],
      h.contextFor,
    )
    expect(run.boards.map((b) => [b.index, b.verdict])).toEqual([
      [0, 'SUCCEEDED'],
      [1, 'CONFIG_INVALID'],
      [2, 'SUCCEEDED'],
    ])
    expect(h.order).toEqual(['lever:global:spotify', 'lever:eu:siteimprove'])
    expect(run.boards[1]?.configError).toContain('board')
  })

  it('a config refusal that is not an Error object still yields a stated reason', async () => {
    const odd = {
      type: 'LEVER_ATS',
      parseConfig: () => {
        throw 'plain string'
      },
      collectReport: () => {
        throw new Error('must not be called')
      },
    } as unknown as typeof leverProvider
    const run = await collectBoardGroup(odd, [{}], () => {
      throw new Error('no context expected')
    })
    expect(run.boards[0]).toEqual({
      index: 0,
      namespace: null,
      verdict: 'CONFIG_INVALID',
      batch: null,
      configError: 'config refused',
    })
  })

  it('reports nothing dead and no failure for an empty list of inputs', async () => {
    const run = await collectBoardGroup(leverProvider, [], () => {
      throw new Error('no context expected')
    })
    expect(run).toEqual({ boards: [], deadBoards: [], sourceFailure: false })
  })
})

describe('boardVerdictOf', () => {
  async function batchFor(status: number, bodyText: string) {
    const f = fakeCollectionContext({ responses: [{ status, bodyText }] })
    return leverProvider.collectReport(leverProvider.parseConfig(goodConfig('ok')), f.ctx)
  }

  it('reads a 404 from the STATUS, not from the body text', async () => {
    expect(boardVerdictOf(await batchFor(404, '[]'))).toBe('BOARD_NOT_FOUND')
    expect(boardVerdictOf(await batchFor(500, '{"error":"Document not found"}'))).toBe(
      'SOURCE_FAILED',
    )
  })

  it.each([
    [401, 'SOURCE_FAILED'],
    [403, 'SOURCE_FAILED'],
    [429, 'SOURCE_FAILED'],
    [500, 'SOURCE_FAILED'],
    [410, 'SOURCE_FAILED'],
  ])('HTTP %i is %s (only 404 means the board does not exist)', async (status, verdict) => {
    expect(boardVerdictOf(await batchFor(status, '{}'))).toBe(verdict)
  })

  it('a 200 with drifted content is a source failure, not a dead board', async () => {
    expect(boardVerdictOf(await batchFor(200, '{"not":"an array"}'))).toBe('SOURCE_FAILED')
  })

  it('a clean 200 is SUCCEEDED', async () => {
    expect(boardVerdictOf(await batchFor(200, '[]'))).toBe('SUCCEEDED')
  })

  it('a page that landed before the next one failed is PARTIAL, not a dead board or a failure', async () => {
    const full = JSON.stringify(
      Array.from({ length: 50 }, (_, i) => ({
        id: `id-${i}`,
        text: 'Role',
        hostedUrl: `https://jobs.lever.co/ok/id-${i}`,
      })),
    )
    const f = fakeCollectionContext({
      responses: [
        { status: 200, bodyText: full },
        { status: 404, bodyText: '[]' },
      ],
    })
    const batch = await leverProvider.collectReport(
      leverProvider.parseConfig(goodConfig('ok', { employer: { name: 'Ok Co', evidence: 'e' } })),
      f.ctx,
    )
    expect(batch.outcome).toBe('PARTIAL')
    expect(boardVerdictOf(batch)).toBe('PARTIAL')
  })

  it('a cancelled run is CANCELLED', async () => {
    const f = fakeCollectionContext({ responses: [{ status: 200, bodyText: '[]' }] })
    f.ctx.signal = AbortSignal.abort()
    const batch = await leverProvider.collectReport(
      leverProvider.parseConfig(goodConfig('ok')),
      f.ctx,
    )
    expect(f.sent).toEqual([])
    expect(boardVerdictOf(batch)).toBe('CANCELLED')
  })

  it('a run that made no request at all (the deadline had passed) is a source failure, not a dead board', async () => {
    const f = fakeCollectionContext({ responses: [{ status: 404, bodyText: '[]' }] })
    f.ctx.deadline = new Date(0)
    const batch = await leverProvider.collectReport(
      leverProvider.parseConfig(goodConfig('ok')),
      f.ctx,
    )
    expect(f.sent).toEqual([])
    expect(batch.requests.map((r) => [r.status, r.error?.code])).toEqual([[null, 'DEADLINE']])
    expect(boardVerdictOf(batch)).toBe('SOURCE_FAILED')
  })

  it.each([
    ['no request report at all', [], 'SOURCE_FAILED'],
    ['a 404', [404], 'BOARD_NOT_FOUND'],
    [
      'a transient failure and then a 404: the last word is the board is gone',
      [503, 404],
      'BOARD_NOT_FOUND',
    ],
    ['a 404 and then a transient failure: not known to be gone', [404, 503], 'SOURCE_FAILED'],
    ['a request with no response and then a 404', [null, 404], 'BOARD_NOT_FOUND'],
    ['only non-404 answers', [500, 502], 'SOURCE_FAILED'],
  ])('a FAILED batch with %s is %s', (_why, statuses, verdict) => {
    expect(
      boardVerdictOf({ outcome: 'FAILED', requests: statuses.map((status) => ({ status })) }),
    ).toBe(verdict)
  })
})

describe('what a refusal says', () => {
  const messages = (fn: () => unknown): string[] => {
    try {
      fn()
    } catch (error) {
      if (error instanceof ZodError) return error.issues.map((i) => i.message)
      throw error
    }
    throw new Error('expected a ZodError, got no throw')
  }

  it('a search query: the board is the scope', () => {
    expect(
      messages(() => leverProvider.parseConfig(goodConfig('ok', { query: 'python' }))),
    ).toEqual(['ATS boards are not searched; the board is the scope'])
  })

  it('a date window: boards have none', () => {
    const window = { from: '2026-10-01T00:00:00Z', to: '2026-10-02T00:00:00Z' }
    expect(messages(() => leverProvider.parseConfig(goodConfig('ok', { window })))).toEqual([
      'ATS boards have no date window',
    ])
  })

  it('a foreign namespace: it is derived, not chosen', () => {
    expect(messages(() => leverProvider.parseConfig(goodConfig('ok', { namespace: 'x' })))).toEqual(
      ['namespace is derived from the board and region and cannot be set to anything else'],
    )
  })

  it('a board listed twice in a group', () => {
    expect(
      messages(() =>
        atsBoardGroupSchema(LEVER_KIND).parse({
          configVersion: 1,
          boards: [{ board: 'a' }, { board: 'a' }],
        }),
      ),
    ).toEqual(['a board is listed twice in the group'])
  })
})

describe('presentStrings', () => {
  it('keeps the strings, in order, and drops null and undefined', () => {
    expect(presentStrings(['a', null, undefined, 'b'])).toEqual(['a', 'b'])
  })

  it('keeps an empty string (it is a string; the normalizer decides what it is worth)', () => {
    expect(presentStrings(['', 'x'])).toEqual(['', 'x'])
  })

  it('an empty list, an all-absent list and no list at all are all empty', () => {
    expect(presentStrings([])).toEqual([])
    expect(presentStrings([null, undefined])).toEqual([])
    expect(presentStrings(null)).toEqual([])
    expect(presentStrings(undefined)).toEqual([])
  })
})

describe('the proposed request gap', () => {
  it('is recorded as 500 ms, a PROPOSAL: nothing in the module waits on it', () => {
    expect(ATS_PROPOSED_REQUEST_GAP_MS).toBe(500)
  })
})
