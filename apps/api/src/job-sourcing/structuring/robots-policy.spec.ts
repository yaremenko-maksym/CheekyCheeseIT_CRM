import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FetchedText } from '../providers/reporting-provider'
import { MAX_ROBOTS_BYTES } from './robots-parser'
import { ROBOTS_CACHE_MS, RobotsPolicy } from './robots-policy'

const CAPTURES = new URL('../providers/sources/__raw-captures__/3.2/', import.meta.url)
const capture = (name: string) => readFileSync(new URL(name, CAPTURES), 'utf8')

const ok = (bodyText: string): FetchedText => ({ status: 200, bodyText, headers: {}, etag: null })
const status = (code: number, bodyText = ''): FetchedText => ({
  status: code,
  bodyText,
  headers: {},
  etag: null,
})

function setup(first: FetchedText | Error = ok('User-agent: *\nDisallow: /private\n')) {
  const fetchRobots = vi.fn<(origin: string) => Promise<FetchedText>>(async () => {
    if (first instanceof Error) throw first
    return first
  })
  return { fetchRobots, policy: new RobotsPolicy({ fetchRobots, productToken: 'cheekybot' }) }
}

const T0 = new Date('2026-11-03T10:00:00Z')

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(T0)
})
afterEach(() => vi.useRealTimers())

describe('verdicts from the fetched robots.txt', () => {
  it('allows a permitted path and denies a disallowed one', async () => {
    const { policy } = setup()
    expect(await policy.check('https://a.test/jobs/1')).toEqual({
      verdict: 'ALLOWED',
      reason: null,
      crawlDelaySeconds: null,
      aiInput: 'unspecified',
    })
    const denied = await policy.check('https://a.test/private/x')
    expect(denied.verdict).toBe('DENIED')
    expect(denied.reason).toBe('DISALLOWED_BY_ROBOTS')
  })

  it('exposes crawl-delay and ai-input of the rule set on an allowed and a denied verdict', async () => {
    const { policy } = setup(
      ok('User-agent: *\nCrawl-delay: 3\nContent-Signal: ai-input=no\nDisallow: /p\n'),
    )
    const allowed = await policy.check('https://a.test/x')
    expect([allowed.crawlDelaySeconds, allowed.aiInput]).toEqual([3, 'no'])
    const denied = await policy.check('https://a.test/p')
    expect([denied.crawlDelaySeconds, denied.aiInput]).toEqual([3, 'no'])
  })

  it('applies the rules of the group naming our token', async () => {
    const { policy } = setup(
      ok('User-agent: *\nDisallow: /\nUser-agent: CheekyBot\nDisallow: /only-this\n'),
    )
    expect((await policy.check('https://a.test/free')).verdict).toBe('ALLOWED')
    expect((await policy.check('https://a.test/only-this')).verdict).toBe('DENIED')
  })

  it('matches the path together with its query string', async () => {
    const { policy } = setup(ok('User-agent: *\nDisallow: /*?*\n'))
    expect((await policy.check('https://a.test/jobs?x=1')).verdict).toBe('DENIED')
    expect((await policy.check('https://a.test/jobs#frag')).verdict).toBe('ALLOWED')
  })

  it('treats an empty or comment-only body as allow-all', async () => {
    expect((await setup(ok('')).policy.check('https://a.test/x')).verdict).toBe('ALLOWED')
    expect((await setup(ok('# nothing\n')).policy.check('https://a.test/x')).verdict).toBe(
      'ALLOWED',
    )
  })

  it('asks the fetcher for the origin only, once', async () => {
    const { policy, fetchRobots } = setup()
    await policy.check('https://A.test/deep/path?q=1')
    expect(fetchRobots).toHaveBeenCalledTimes(1)
    expect(fetchRobots).toHaveBeenCalledWith('https://a.test')
  })
})

describe('fail closed', () => {
  it.each([500, 502, 503, 599])('denies %i as unreachable', async (code) => {
    const { policy } = setup(status(code))
    const r = await policy.check('https://a.test/x')
    expect([r.verdict, r.reason]).toEqual(['UNREACHABLE_DENIED', `HTTP_${code}`])
  })

  it('denies a network error as unreachable', async () => {
    const r = await setup(new Error('ECONNRESET')).policy.check('https://a.test/x')
    expect([r.verdict, r.reason]).toEqual(['UNREACHABLE_DENIED', 'NETWORK_ERROR'])
  })

  it.each([100, 199, 301, 302, 304, 400, 418])(
    'denies %i, a status with no RFC meaning',
    async (code) => {
      const r = await setup(status(code)).policy.check('https://a.test/x')
      expect([r.verdict, r.reason]).toEqual(['UNREACHABLE_DENIED', `HTTP_${code}`])
    },
  )

  it('treats 299 as a success and 300 as not', async () => {
    expect(
      (await setup(status(299, 'User-agent: *')).policy.check('https://a.test/x')).verdict,
    ).toBe('ALLOWED')
    expect((await setup(status(300)).policy.check('https://a.test/x')).verdict).toBe(
      'UNREACHABLE_DENIED',
    )
  })

  it('denies an oversize body, but not one of exactly the cap', async () => {
    const head = 'User-agent: *\nDisallow: /p\n'
    const exact = head + '#'.repeat(MAX_ROBOTS_BYTES - head.length)
    expect((await setup(ok(exact)).policy.check('https://a.test/x')).verdict).toBe('ALLOWED')
    const over = await setup(ok(`${exact}#`)).policy.check('https://a.test/x')
    expect([over.verdict, over.reason]).toEqual(['UNREACHABLE_DENIED', 'OVERSIZE'])
  })

  it('measures the cap in bytes', async () => {
    const body = 'é'.repeat(MAX_ROBOTS_BYTES / 2 + 1)
    expect((await setup(ok(body)).policy.check('https://a.test/x')).reason).toBe('OVERSIZE')
  })

  it('denies a body that is not robots.txt at all', async () => {
    const r = await setup(ok('<!doctype html><html>Not found</html>')).policy.check(
      'https://a.test/x',
    )
    expect([r.verdict, r.reason]).toEqual(['UNREACHABLE_DENIED', 'UNPARSEABLE_BODY'])
  })

  it('allows a body with a single recognised line among junk', async () => {
    const { policy } = setup(ok('garbage\nSitemap: https://a.test/s\n'))
    expect((await policy.check('https://a.test/x')).verdict).toBe('ALLOWED')
  })

  it('reports an unreachable verdict without rules or signals', async () => {
    const r = await setup(status(503)).policy.check('https://a.test/x')
    expect([r.crawlDelaySeconds, r.aiInput]).toEqual([null, 'unspecified'])
  })
})

describe('absent or forbidden robots.txt', () => {
  it.each([404, 410])('allows everything on %i (RFC 9309 2.3.1.3)', async (code) => {
    const { policy } = setup(status(code))
    const r = await policy.check('https://a.test/anything?x=1')
    expect(r).toEqual({
      verdict: 'ALLOWED',
      reason: null,
      crawlDelaySeconds: null,
      aiInput: 'unspecified',
    })
  })

  it('ignores whatever body a 404 carries', async () => {
    const html = '<html>Not found</html>' + 'x'.repeat(MAX_ROBOTS_BYTES)
    const r = await setup(status(404, html)).policy.check('https://a.test/x')
    expect(r.verdict).toBe('ALLOWED')
  })

  it.each([401, 403, 429])('pauses on %i, never reading it as a ban or a permit', async (code) => {
    const r = await setup(status(code)).policy.check('https://a.test/x')
    expect([r.verdict, r.reason]).toEqual(['PAUSED', `HTTP_${code}`])
    expect([r.crawlDelaySeconds, r.aiInput]).toEqual([null, 'unspecified'])
  })

  it('asks again after a pause instead of remembering it', async () => {
    const { policy, fetchRobots } = setup(status(403))
    await policy.check('https://a.test/x')
    fetchRobots.mockResolvedValueOnce(ok('User-agent: *\nDisallow: /nope\n'))
    expect((await policy.check('https://a.test/x')).verdict).toBe('ALLOWED')
    expect(fetchRobots).toHaveBeenCalledTimes(2)
  })

  it('asks again after a network error instead of remembering it', async () => {
    const { policy, fetchRobots } = setup(new Error('boom'))
    await policy.check('https://a.test/x')
    fetchRobots.mockResolvedValueOnce(ok(''))
    expect((await policy.check('https://a.test/x')).verdict).toBe('ALLOWED')
  })
})

describe('crawl-delay ceiling', () => {
  const withDelay = (v: string) => setup(ok(`User-agent: *\nCrawl-delay: ${v}\nDisallow: /p\n`))

  it('exposes a delay of exactly 86400 s', async () => {
    const r = await withDelay('86400').policy.check('https://a.test/x')
    expect([r.verdict, r.crawlDelaySeconds]).toEqual(['ALLOWED', 86400])
  })

  it.each(['86401', '2147483648', '9'.repeat(310), '9'.repeat(400)])(
    'pauses on a delay of %s',
    async (v) => {
      const { policy } = withDelay(v)
      const r = await policy.check('https://a.test/x')
      expect(r).toEqual({
        verdict: 'PAUSED',
        reason: 'CRAWL_DELAY_TOO_LONG',
        crawlDelaySeconds: null,
        aiInput: 'unspecified',
      })
      // also for a path the rules disallow, and again from the cache
      expect((await policy.check('https://a.test/p')).verdict).toBe('PAUSED')
    },
  )

  it('pauses on an infinite delay', async () => {
    expect(Number('9'.repeat(310))).toBe(Infinity)
    const r = await withDelay('9'.repeat(310)).policy.check('https://a.test/x')
    expect(r.verdict).toBe('PAUSED')
  })

  it('still honours a zero delay', async () => {
    const r = await withDelay('0').policy.check('https://a.test/x')
    expect([r.verdict, r.crawlDelaySeconds]).toEqual(['ALLOWED', 0])
  })
})

describe('24 h cache', () => {
  it('answers from the cache inside the window, per URL and per path', async () => {
    const { policy, fetchRobots } = setup()
    await policy.check('https://a.test/one')
    vi.setSystemTime(new Date(T0.getTime() + ROBOTS_CACHE_MS - 1))
    const denied = await policy.check('https://a.test/private/two')
    expect(denied.verdict).toBe('DENIED')
    expect((await policy.check('https://a.test/three')).verdict).toBe('ALLOWED')
    expect(fetchRobots).toHaveBeenCalledTimes(1)
  })

  it('refetches at exactly 24 h', async () => {
    const { policy, fetchRobots } = setup()
    await policy.check('https://a.test/one')
    vi.setSystemTime(new Date(T0.getTime() + ROBOTS_CACHE_MS))
    await policy.check('https://a.test/one')
    expect(fetchRobots).toHaveBeenCalledTimes(2)
  })

  it('exposes a 24 hour window', () => {
    expect(ROBOTS_CACHE_MS).toBe(86_400_000)
  })

  it('replaces stale rules with the newly fetched ones', async () => {
    const { policy, fetchRobots } = setup(ok('User-agent: *\nDisallow: /old\n'))
    expect((await policy.check('https://a.test/old')).verdict).toBe('DENIED')
    fetchRobots.mockResolvedValueOnce(ok('User-agent: *\nDisallow: /new\n'))
    vi.setSystemTime(new Date(T0.getTime() + ROBOTS_CACHE_MS + 1))
    expect((await policy.check('https://a.test/old')).verdict).toBe('ALLOWED')
    expect((await policy.check('https://a.test/new')).verdict).toBe('DENIED')
    expect(fetchRobots).toHaveBeenCalledTimes(2)
  })

  it('never serves stale rules when the refetch fails', async () => {
    const { policy, fetchRobots } = setup(ok('User-agent: *\nDisallow: /old\n'))
    await policy.check('https://a.test/free')
    fetchRobots.mockResolvedValueOnce(status(503))
    vi.setSystemTime(new Date(T0.getTime() + ROBOTS_CACHE_MS + 1))
    expect((await policy.check('https://a.test/free')).verdict).toBe('UNREACHABLE_DENIED')
    // and the failure did not leave the stale copy behind
    fetchRobots.mockResolvedValueOnce(status(503))
    expect((await policy.check('https://a.test/free')).verdict).toBe('UNREACHABLE_DENIED')
  })

  it('caches a 404 as allow-all for the window', async () => {
    const { policy, fetchRobots } = setup(status(404))
    await policy.check('https://a.test/x')
    await policy.check('https://a.test/y')
    expect(fetchRobots).toHaveBeenCalledTimes(1)
  })

  it('keeps one entry per origin', async () => {
    const { policy, fetchRobots } = setup()
    await policy.check('https://a.test/x')
    await policy.check('https://b.test/x')
    await policy.check('https://a.test/y')
    expect(fetchRobots.mock.calls.map((c) => c[0])).toEqual(['https://a.test', 'https://b.test'])
  })
})

describe('URL validation, before any robots fetch', () => {
  it.each([
    ['http://a.test/x', 'UNSAFE_SCHEME'],
    ['ftp://a.test/x', 'UNSAFE_SCHEME'],
    ['https://user:pw@a.test/x', 'USERINFO'],
    ['https://a.test:8443/x', 'UNSAFE_PORT'],
    ['https://127.0.0.1/x', 'IP_LITERAL'],
    ['https://169.254.169.254/x', 'IP_LITERAL'],
    ['https://[::1]/x', 'IP_LITERAL'],
    ['https://2852039166../x', 'IP_LITERAL'],
    ['not a url', 'UNPARSEABLE'],
    ['', 'UNPARSEABLE'],
    ['/relative/without/base', 'UNPARSEABLE'],
  ])('rejects %s as %s without calling fetchRobots', async (link, reason) => {
    const { policy, fetchRobots } = setup()
    const r = await policy.check(link)
    expect([r.verdict, r.reason]).toEqual(['DENIED', reason])
    expect(fetchRobots).not.toHaveBeenCalled()
  })

  it('rejects an over-long link', async () => {
    const { policy, fetchRobots } = setup()
    const r = await policy.check(`https://a.test/${'x'.repeat(2100)}`)
    expect(r.reason).toBe('TOO_LONG')
    expect(fetchRobots).not.toHaveBeenCalled()
  })
})

describe('relative links against a validated origin', () => {
  it('resolves a relative link against the origin and checks that path', async () => {
    const { policy, fetchRobots } = setup()
    const allowed = await policy.check('/jobs/7', { baseOrigin: 'https://a.test' })
    expect(allowed.verdict).toBe('ALLOWED')
    const denied = await policy.check('private/x', { baseOrigin: 'https://a.test/' })
    expect(denied.verdict).toBe('DENIED')
    expect(fetchRobots).toHaveBeenCalledWith('https://a.test')
  })

  it('takes the origin from a base that carries a path', async () => {
    const { policy } = setup()
    const r = await policy.check('/private/x', { baseOrigin: 'https://a.test/listing/page' })
    expect(r.verdict).toBe('DENIED')
  })

  it('accepts an absolute link that stays on the origin', async () => {
    const { policy } = setup()
    expect(
      (await policy.check('https://a.test/ok', { baseOrigin: 'https://a.test' })).verdict,
    ).toBe('ALLOWED')
  })

  it.each([['https://evil.test/x'], ['//evil.test/x'], ['https://sub.a.test/x']])(
    'refuses %s as cross-origin without fetching',
    async (link) => {
      const { policy, fetchRobots } = setup()
      const r = await policy.check(link, { baseOrigin: 'https://a.test' })
      expect([r.verdict, r.reason]).toEqual(['DENIED', 'CROSS_ORIGIN'])
      expect(fetchRobots).not.toHaveBeenCalled()
    },
  )

  it('refuses a link that rewrites the scheme or authority into something unsafe', async () => {
    const { policy, fetchRobots } = setup()
    expect((await policy.check('http://a.test/x', { baseOrigin: 'https://a.test' })).reason).toBe(
      'UNSAFE_SCHEME',
    )
    expect(
      (await policy.check('https://u:p@a.test/x', { baseOrigin: 'https://a.test' })).reason,
    ).toBe('USERINFO')
    expect(fetchRobots).not.toHaveBeenCalled()
  })

  it.each([
    ['http://a.test', 'UNSAFE_SCHEME'],
    ['https://127.0.0.1', 'IP_LITERAL'],
    ['https://u@a.test', 'USERINFO'],
    ['nonsense', 'UNPARSEABLE'],
  ])('rejects the base origin %s as %s', async (baseOrigin, reason) => {
    const { policy, fetchRobots } = setup()
    const r = await policy.check('/x', { baseOrigin })
    expect([r.verdict, r.reason]).toEqual(['DENIED', reason])
    expect(fetchRobots).not.toHaveBeenCalled()
  })

  it('refuses a link the URL parser cannot resolve', async () => {
    const { policy, fetchRobots } = setup()
    const r = await policy.check('http://', { baseOrigin: 'https://a.test' })
    expect([r.verdict, r.reason]).toEqual(['DENIED', 'UNPARSEABLE'])
    expect(fetchRobots).not.toHaveBeenCalled()
  })
})

describe('captured robots.txt: Jobgether', () => {
  it('permits posting routes and denies the template and parameterised ones', async () => {
    const { policy } = setup(ok(capture('robots-jobgether.txt')))
    const origin = { baseOrigin: 'https://jobgether.com' }
    const allowed = await policy.check('/offer/6a1b2c3d-some-slug', origin)
    expect(allowed).toEqual({
      verdict: 'ALLOWED',
      reason: null,
      crawlDelaySeconds: 2,
      aiInput: 'yes',
    })
    expect((await policy.check('/search?q=rust', origin)).verdict).toBe('DENIED')
    expect((await policy.check('/offer/%7Bid%7D', origin)).verdict).toBe('DENIED')
    expect((await policy.check('/cdn-cgi/trace', origin)).verdict).toBe('DENIED')
    expect((await policy.check('/astroapi/ai/jobs.json?page=2', origin)).verdict).toBe('ALLOWED')
  })
})
