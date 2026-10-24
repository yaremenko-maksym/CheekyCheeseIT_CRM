import { describe, expect, it } from 'vitest'
import { fakeCollectionContext } from '../../../test/fake-collection-context'
import {
  ATS_MAX_BOARDS_PER_GROUP,
  atsBoardGroupSchema,
  atsBoardSlug,
  collectBoardGroup,
  DNS_LABEL_MAX_CHARS,
  DNS_LABEL_PATTERN,
  nonBlank,
  PERSONIO_KIND,
  placeOf,
  RECRUITEE_KIND,
  SMARTRECRUITERS_KIND,
  WORKABLE_KIND,
} from './ats-config'
import { personioProvider } from './personio.provider'
import { recruiteeProvider } from './recruitee.provider'
import { smartrecruitersProvider } from './smartrecruiters.provider'
import { workableProvider } from './workable.provider'

/**
 * The security surface of Task 3.4: a tenant or slug becomes a HOST (Recruitee, Personio) or a path
 * segment (Workable, SmartRecruiters). One table of hostile strings, run against all four
 * providers; every refusal happens in `parseConfig`, before any request exists, and the fetch stub
 * is asserted UNCALLED. The acceptance side is asserted too: a table that only refuses could be
 * passed by a schema that refuses everything.
 */

const FOUR = [
  ['workable', workableProvider, WORKABLE_KIND],
  ['smartrecruiters', smartrecruitersProvider, SMARTRECRUITERS_KIND],
  ['recruitee', recruiteeProvider, RECRUITEE_KIND],
  ['personio', personioProvider, PERSONIO_KIND],
] as const

/** Personio alone takes (and requires) a language; the others refuse it as an unknown key. */
const input = (name: string, board: unknown) => ({
  configVersion: 1,
  board,
  ...(name === 'personio' ? { language: 'en' } : {}),
})
const refused = (
  name: string,
  provider: { parseConfig(raw: unknown): unknown },
  board: unknown,
) => {
  try {
    provider.parseConfig(input(name, board))
    return false
  } catch {
    return true
  }
}

/** Refused by every provider: each can change a host, a path or a request in some way. */
const HOSTILE: readonly [string, unknown][] = [
  ['empty', ''],
  ['protocol-relative host', '//evil.example'],
  ['protocol-relative host with a path', '//evil.example/x'],
  ['a full URL', 'https://evil.example'],
  ['a full URL with a path', 'https://evil.example/a'],
  ['a scheme-less host', 'evil.example'],
  ['a dot inside the slug', 'a.b'],
  ['a trailing dot (fully qualified)', 'acme.'],
  ['a leading dot', '.acme'],
  ['a single dot', '.'],
  ['dot-dot', '..'],
  ['traversal', '../x'],
  ['traversal inside', 'a/../b'],
  ['a slash', 'a/b'],
  ['a backslash', 'a\\b'],
  ['an encoded slash', 'a%2Fb'],
  ['an encoded dot', 'a%2eb'],
  ['a percent sign', 'a%'],
  ['userinfo', 'user@host'],
  ['userinfo with a password', 'user:pw@host'],
  ['a port', 'host:443'],
  ['a colon', 'a:b'],
  ['a space', 'a b'],
  ['a leading space', ' a'],
  ['a trailing space', 'a '],
  ['a newline', 'a\nb'],
  ['a trailing newline', 'acme\n'],
  ['a carriage return', 'a\rb'],
  ['a tab', 'a\tb'],
  ['a NUL', 'a\u0000b'],
  ['a query', 'a?b=1'],
  ['a fragment', 'a#b'],
  ['a semicolon', 'a;b'],
  ['a comma', 'a,b'],
  ['an at sign alone', '@'],
  ['a cyrillic lookalike of a latin letter', 'аcme'],
  ['a fullwidth form', 'ａｃｍｅ'],
  ['a roman numeral', 'ⅰ'],
  ['a dotless i', 'acmı'],
  ['a right-to-left override', 'a‮b'],
  ['a zero-width space', 'a​b'],
  ['a zero-width joiner', 'a‍b'],
  ['a combining mark', 'á'],
  ['an emoji', 'a😀'],
  ['a null', null],
  ['a number', 1],
  ['an object', {}],
  ['an array', ['acme']],
  ['undefined', undefined],
]

describe.each(FOUR)(
  '%s: hostile tenants and slugs are refused before any request',
  (name, provider) => {
    it.each(HOSTILE)('refuses %s', (_label, board) => {
      expect(refused(name, provider, board)).toBe(true)
    })

    it('refuses every hostile string without calling the network: the fetch stub is uncalled', async () => {
      const f = fakeCollectionContext({ responses: [] })
      let contexts = 0
      const run = await collectBoardGroup(
        provider as never,
        HOSTILE.map(([, board]) => input(name, board)),
        () => {
          contexts += 1
          return f.ctx
        },
      )
      expect(f.sent).toEqual([])
      expect(contexts).toBe(0)
      expect(run.boards.every((b) => b.verdict === 'CONFIG_INVALID')).toBe(true)
      expect(run.boards).toHaveLength(HOSTILE.length)
      expect(run.deadBoards).toEqual([])
    })

    it('refuses a host, base URL or namespace given as a key of the config', () => {
      for (const extra of [
        { host: 'evil.example' },
        { baseUrl: 'https://evil.example' },
        { url: 'https://evil.example' },
        { subdomain: 'evil' },
        { namespace: 'greenhouse:stripe' },
      ]) {
        expect(() => provider.parseConfig({ ...input(name, 'acme'), ...extra })).toThrow()
      }
    })

    it('accepts an ordinary tenant', () => {
      expect(() => provider.parseConfig(input(name, 'acme'))).not.toThrow()
    })
  },
)

describe('Recruitee and Personio: the tenant is a DNS label (the host half of the surface)', () => {
  const dns = [
    ['recruitee', recruiteeProvider],
    ['personio', personioProvider],
  ] as const

  describe.each(dns)('%s', (name, provider) => {
    it.each([
      ['uppercase', 'Acme'],
      ['an underscore', 'a_b'],
      ['a leading hyphen', '-acme'],
      ['a trailing hyphen', 'acme-'],
      ['the punycode prefix', 'xn--80ak6aa92e'],
      ['any reserved label form (hyphens at 3-4)', 'ab--cd'],
      ['the punycode prefix in uppercase', 'XN--80ak6aa92e'],
      ['a label of 64 characters', 'a'.repeat(64)],
      ['a 64-character label with inner hyphens', `a${'-'.repeat(62)}b`],
    ])('refuses %s', (_label, board) => {
      expect(refused(name, provider, board)).toBe(true)
    })

    it.each([
      ['a single character', 'a'],
      ['a single digit', '7'],
      ['only digits', '123456'],
      ['inner hyphens', 'a-b-c'],
      ['a double hyphen NOT at positions 3-4', 'a--b'],
      ['a hyphen at position 3 only', 'ab-cd'],
      ['the longest label, 63 characters', 'a'.repeat(63)],
      ['63 characters ending in a digit', `${'a'.repeat(62)}9`],
      ['63 characters with inner hyphens', `a${'-'.repeat(61)}b`],
    ])('accepts %s', (_label, board) => {
      const config = provider.parseConfig(input(name, board)) as {
        board: string
        namespace: string
      }
      expect(config.board).toBe(board)
      expect(config.namespace.endsWith(`:${board}`)).toBe(true)
    })
  })

  it('the pattern and the cap are the DNS ones', () => {
    expect(DNS_LABEL_MAX_CHARS).toBe(63)
    expect(RECRUITEE_KIND.slugMaxChars).toBe(63)
    expect(PERSONIO_KIND.slugMaxChars).toBe(63)
    expect(RECRUITEE_KIND.slugPattern).toBe(DNS_LABEL_PATTERN)
    expect(PERSONIO_KIND.slugPattern).toBe(DNS_LABEL_PATTERN)
  })

  it('a valid tenant at the maximum length is requested at exactly that host', async () => {
    const board = 'a'.repeat(63)
    const f = fakeCollectionContext({
      responses: [{ status: 200, bodyText: '{"offers":[]}' }],
    })
    await recruiteeProvider.collectReport(
      recruiteeProvider.parseConfig({ configVersion: 1, board }),
      f.ctx,
    )
    expect(f.sent[0]?.url).toBe(`https://${board}.recruitee.com/api/offers/`)
    expect(new URL(f.sent[0]?.url ?? '').host).toBe(`${board}.recruitee.com`)
  })
})

describe('Workable and SmartRecruiters: the slug is one path segment', () => {
  it.each([
    ['uppercase', 'Acme', 'workable', false],
    ['uppercase', 'Acme', 'smartrecruiters', false],
    ['an underscore', 'a_b', 'workable', false],
    ['an underscore', 'a_b', 'smartrecruiters', true],
    ['a trailing hyphen', 'acme-', 'workable', false],
    ['a trailing hyphen', 'acme-', 'smartrecruiters', false],
    ['a trailing underscore', 'acme_', 'smartrecruiters', false],
    ['a doubled separator', 'a--b', 'smartrecruiters', false],
    ['a leading hyphen', '-acme', 'smartrecruiters', false],
    ['digits and letters', 'mcdonalds1', 'smartrecruiters', true],
    ['mixed case', 'McDonalds1', 'smartrecruiters', false],
  ])('%s %j for %s: accepted=%s', (_label, board, which, accepted) => {
    const provider = which === 'workable' ? workableProvider : smartrecruitersProvider
    expect(refused(which, provider, board)).toBe(!accepted)
  })

  it('the slug is accepted at 64 characters and refused at 65, for both', () => {
    for (const [name, provider, kind] of [
      ['workable', workableProvider, WORKABLE_KIND],
      ['smartrecruiters', smartrecruitersProvider, SMARTRECRUITERS_KIND],
    ] as const) {
      expect(kind.slugMaxChars).toBe(64)
      expect(refused(name, provider, 'a'.repeat(64))).toBe(false)
      expect(refused(name, provider, 'a'.repeat(65))).toBe(true)
    }
  })

  it('the slug is exactly one path segment of the requests', async () => {
    const w = fakeCollectionContext({
      responses: [{ status: 200, bodyText: '{"name":"X","jobs":[]}' }],
    })
    await workableProvider.collectReport(
      workableProvider.parseConfig({ configVersion: 1, board: 'a-b' }),
      w.ctx,
    )
    expect(new URL(w.sent[0]?.url ?? '').pathname).toBe('/api/v1/widget/accounts/a-b')
  })
})

describe('the shared pieces the four providers add to (Task 3.3 call sites unchanged)', () => {
  it("atsBoardSlug applies the kind's own pattern and cap", () => {
    expect(atsBoardSlug(RECRUITEE_KIND).safeParse('a'.repeat(63)).success).toBe(true)
    expect(atsBoardSlug(RECRUITEE_KIND).safeParse('a'.repeat(64)).success).toBe(false)
    expect(atsBoardSlug(WORKABLE_KIND).safeParse('a'.repeat(64)).success).toBe(true)
  })

  it('a Recruitee group holds up to 300 boards and refuses the 301st', () => {
    const boards = (n: number) => Array.from({ length: n }, (_, i) => ({ board: `tenant-${i}` }))
    const group = atsBoardGroupSchema(RECRUITEE_KIND)
    expect(ATS_MAX_BOARDS_PER_GROUP).toBe(300)
    expect(group.safeParse({ configVersion: 1, boards: boards(300) }).success).toBe(true)
    expect(group.safeParse({ configVersion: 1, boards: boards(301) }).success).toBe(false)
  })

  it('a Recruitee group refuses a hostile tenant and a repeated one', () => {
    const group = atsBoardGroupSchema(RECRUITEE_KIND)
    expect(group.safeParse({ configVersion: 1, boards: [{ board: 'evil.example' }] }).success).toBe(
      false,
    )
    expect(
      group.safeParse({ configVersion: 1, boards: [{ board: 'a' }, { board: 'a' }] }).success,
    ).toBe(false)
  })

  it('namespaces are provider:board with no region, for all four', () => {
    expect(
      FOUR.map(
        ([name, provider]) =>
          (provider.parseConfig(input(name, 'acme')) as { namespace: string }).namespace,
      ),
    ).toEqual(['workable:acme', 'smartrecruiters:acme', 'recruitee:acme', 'personio:acme'])
  })

  it('a stated namespace must be the derived one', () => {
    expect(() =>
      recruiteeProvider.parseConfig({
        configVersion: 1,
        board: 'acme',
        namespace: 'recruitee:other',
      }),
    ).toThrow()
    expect(
      recruiteeProvider.parseConfig({
        configVersion: 1,
        board: 'acme',
        namespace: 'recruitee:acme',
      }),
    ).toMatchObject({
      namespace: 'recruitee:acme',
    })
  })

  it('a query or a window is refused: a board is the scope', () => {
    expect(() =>
      recruiteeProvider.parseConfig({ configVersion: 1, board: 'acme', query: 'x' }),
    ).toThrow()
    expect(() =>
      recruiteeProvider.parseConfig({
        configVersion: 1,
        board: 'acme',
        window: { from: '2026-01-01', to: '2026-02-01' },
      }),
    ).toThrow()
  })
})

describe('nonBlank and placeOf', () => {
  it.each([
    [null, null],
    [undefined, null],
    ['', null],
    ['   ', null],
    ['\n\t', null],
    ['x', 'x'],
    ['  x y  ', 'x y'],
  ])('nonBlank(%j) is %j', (value, expected) => {
    expect(nonBlank(value)).toBe(expected)
  })

  it.each([
    [[], null],
    [[null, undefined, '', '  '], null],
    [['Paris'], 'Paris'],
    [['Paris', 'Île-de-France', 'France'], 'Paris, Île-de-France, France'],
    [['New York', 'New York', 'United States'], 'New York, United States'],
    [['Paris', '', 'France'], 'Paris, France'],
    [[' Paris ', null, ' France '], 'Paris, France'],
    [['France', 'Paris', 'France'], 'France, Paris, France'],
    [['a', 'a', 'a'], 'a'],
  ])('placeOf(%j) is %j', (parts, expected) => {
    expect(placeOf(parts)).toBe(expected)
  })
})
