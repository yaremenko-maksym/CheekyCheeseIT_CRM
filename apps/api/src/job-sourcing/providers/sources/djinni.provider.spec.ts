import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { fakeCollectionContext } from '../../../test/fake-collection-context'
import { parseSourceDate } from '../../normalize/date-policy'
import { collectFeedPages } from '../rss.provider'
import { UnvalidatedConfigError } from '../reporting-provider'
import {
  DJINNI_EXP_LEVELS,
  DJINNI_MEASURED_COVERAGE_BOUND_MS,
  DJINNI_PRIMARY_KEYWORDS,
  djinniProvider,
  djinniSpec,
} from './djinni.provider'

/**
 * Djinni, through the base's public collect path with a stubbed fetch.
 *
 * Every expected value below was read by hand from the committed capture
 * (`__fixtures__/djinni/primary-keyword-rust.xml`, a complete real response) or from the
 * measurements in its provenance notes. None comes from running the mapper.
 *
 * THE FEED CARRIES NO EMPLOYER. So no Djinni item can become an observation (the builder refuses an
 * item without a company), and the mapped fields are observed on the way INTO the builder, through a
 * recording wrapper around the real `mapEntry` rather than by reading observations that cannot exist.
 */

const FIXTURES = join(__dirname, '__fixtures__', 'djinni')
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8')

const NOW = new Date('2026-10-23T20:00:00Z')
const HOUR = 60 * 60 * 1000

const config = (overrides: Record<string, unknown> = {}) =>
  djinniProvider.parseConfig({
    namespace: 'djinni',
    configVersion: 1,
    primaryKeyword: 'Rust',
    ...overrides,
  })

async function collect(bodyText: string, overrides: Record<string, unknown> = {}) {
  const f = fakeCollectionContext({ responses: [{ bodyText }], now: NOW })
  const mapped: ReturnType<typeof djinniSpec.mapEntry>[] = []
  const recording = {
    ...djinniSpec,
    mapEntry: (...args: Parameters<typeof djinniSpec.mapEntry>) => {
      const fields = djinniSpec.mapEntry(...args)
      mapped.push(fields)
      return fields
    },
  }
  const batch = await collectFeedPages(recording, config(overrides), f.ctx)
  return { batch, f, mapped }
}

describe('config is closed and refused before any network call', () => {
  const refused: Array<[string, Record<string, unknown>]> = [
    ['a keyword the site does not list', { primaryKeyword: 'NoSuchKeywordZZ' }],
    ['a group label the feed lists but the filter UI does not', { primaryKeyword: 'Development' }],
    ['the right keyword in the wrong case', { primaryKeyword: 'rust' }],
    ['no keyword at all', { primaryKeyword: undefined }],
    ['an unknown experience level', { expLevel: 'bogus' }],
    ['one year past the last level', { expLevel: '11y' }],
    ['a zero-year level', { expLevel: '0y' }],
    ['a free-text query', { query: 'rust' }],
    ['a window (a RECENT feed cannot be asked for one)', { window: { from: NOW, to: NOW } }],
  ]

  it.each(refused)('rejects %s, and the fetch stub is never called', async (_label, overrides) => {
    const f = fakeCollectionContext({
      responses: [{ bodyText: fixture('primary-keyword-rust.xml') }],
    })
    expect(() => config(overrides)).toThrow()
    // The only way to reach the network is a validated config; a raw one is refused by the provider.
    await expect(
      djinniProvider.collectReport(
        { namespace: 'djinni', configVersion: 1, ...overrides } as never,
        f.ctx,
      ),
    ).rejects.toBeInstanceOf(UnvalidatedConfigError)
    expect(f.sent).toEqual([])
  })

  it('accepts the 157 keywords the filter UI lists, including the awkward spellings', () => {
    expect(DJINNI_PRIMARY_KEYWORDS).toHaveLength(157)
    for (const keyword of ['C++', 'Node.js', '.NET', 'ASIC / Chip Design', 'UI UX', 'React.js']) {
      expect(config({ primaryKeyword: keyword }).primaryKeyword).toBe(keyword)
    }
  })

  it('accepts exactly no_exp and 1y..10y as experience levels', () => {
    expect(DJINNI_EXP_LEVELS).toEqual([
      'no_exp',
      '1y',
      '2y',
      '3y',
      '4y',
      '5y',
      '6y',
      '7y',
      '8y',
      '9y',
      '10y',
    ])
    expect(config({ expLevel: '10y' }).expLevel).toBe('10y')
    expect(config({ expLevel: 'no_exp' }).expLevel).toBe('no_exp')
  })
})

describe('the filter reaches the request and the scope', () => {
  it('asks for the keyword and nothing else when no level is configured', async () => {
    const { f } = await collect(fixture('primary-keyword-rust.xml'))
    expect(f.sent.map((r) => r.url)).toEqual(['https://djinni.co/jobs/rss/?primary_keyword=Rust'])
  })

  it('adds the experience level after the keyword', async () => {
    const { f } = await collect(fixture('primary-keyword-rust.xml'), { expLevel: '5y' })
    expect(f.sent.map((r) => r.url)).toEqual([
      'https://djinni.co/jobs/rss/?primary_keyword=Rust&exp_level=5y',
    ])
  })

  it('percent-encodes the characters the live site was measured to accept', async () => {
    const plus = await collect(fixture('primary-keyword-rust.xml'), { primaryKeyword: 'C++' })
    expect(plus.f.sent[0]?.url).toBe('https://djinni.co/jobs/rss/?primary_keyword=C%2B%2B')
    const slash = await collect(fixture('primary-keyword-rust.xml'), {
      primaryKeyword: 'ASIC / Chip Design',
    })
    expect(slash.f.sent[0]?.url).toBe(
      'https://djinni.co/jobs/rss/?primary_keyword=ASIC+%2F+Chip+Design',
    )
  })

  it('sends the honest user agent', async () => {
    const { f } = await collect(fixture('primary-keyword-rust.xml'))
    expect(f.sent[0]?.headers?.['user-agent']).toBe(
      'CheekyCheeseIT-CRM/1.0 (job sourcing; +https://cheekycheese.tech)',
    )
  })

  it('scopes the run by the filter, so two keywords never share a coverage claim', async () => {
    const rust = await collect(fixture('primary-keyword-rust.xml'))
    const rust5 = await collect(fixture('primary-keyword-rust.xml'), { expLevel: '5y' })
    const go = await collect(fixture('primary-keyword-rust.xml'), { primaryKeyword: 'Golang' })
    expect(rust.batch.scope.query).toBe('primary_keyword=Rust')
    expect(rust5.batch.scope.query).toBe('primary_keyword=Rust&exp_level=5y')
    expect(go.batch.scope.query).toBe('primary_keyword=Golang')
  })
})

describe('the real Rust capture', () => {
  it('reads all 8 entries and maps the first one to the values written in the feed', async () => {
    const { mapped, batch } = await collect(fixture('primary-keyword-rust.xml'))
    expect(batch.counts.raw).toBe(8)
    expect(mapped).toHaveLength(8)
    const first = mapped[0]
    expect(first?.title).toBe('Lead Rust Engineer')
    expect(first?.url).toBe('https://djinni.co/jobs/854780-lead-rust-engineer/')
    expect(first?.descriptionKind).toBe('html')
    expect(
      first?.description?.startsWith('<p><strong>Own your future</strong></p><p>Our culture'),
    ).toBe(true)
    expect(first?.tags).toEqual(['Rust'])
    expect(first?.namespace).toBe('djinni')
  })

  it('keeps every title exactly as the feed wrote it, in feed order', async () => {
    const { mapped } = await collect(fixture('primary-keyword-rust.xml'))
    expect(mapped.map((m) => m.title)).toEqual([
      'Lead Rust Engineer',
      'Rust Engineer',
      'Rust Developer',
      'Rust Developer',
      'Senior Rust Backend Engineer',
      'Senior Stellar / Soroban / Rust Engineer /Blockchain',
      'Software Engineer for the Networking Stream (IRC305579)',
      'Rust Engineer',
    ])
  })

  it('reads the published date as RFC 2822 with its +0300 offset, i.e. 08:24:39 UTC', async () => {
    const { mapped } = await collect(fixture('primary-keyword-rust.xml'))
    const dates = mapped[0]?.dates ?? []
    expect(dates).toHaveLength(1)
    expect(dates[0]).toMatchObject({
      raw: 'Fri, 23 Oct 2026 11:24:39 +0300',
      contract: 'RFC_2822',
      semantics: 'PUBLISHED',
    })
    const parsed = parseSourceDate(dates[0] as never, NOW)
    expect(parsed?.status).toBe('OK')
    expect(parsed?.value?.toISOString()).toBe('2026-10-23T08:24:39.000Z')
  })

  it('keeps two same-titled postings apart by their links', async () => {
    const { mapped } = await collect(fixture('primary-keyword-rust.xml'))
    const developers = mapped.filter((m) => m.title === 'Rust Developer')
    expect(developers.map((m) => m.url)).toEqual([
      'https://djinni.co/jobs/818600-rust-developer/',
      'https://djinni.co/jobs/853129-rust-developer/',
    ])
  })
})

describe('the employer is never invented', () => {
  it('maps no company for any of the 8 items: the feed has none, and the title is not a source', async () => {
    const { mapped } = await collect(fixture('primary-keyword-rust.xml'))
    expect(mapped.map((m) => m.companyName)).toEqual(Array(8).fill(null))
  })

  it('therefore quarantines every item as a missing company, and reports the run as partial', async () => {
    const { batch } = await collect(fixture('primary-keyword-rust.xml'))
    expect(batch.observations).toEqual([])
    expect(batch.counts).toEqual({
      raw: 8,
      normalized: 0,
      invalid: 0,
      quarantined: 8,
      discarded: 0,
    })
    expect(batch.coverage).toBe('PARTIAL')
  })
})

describe('description source (synthetic)', () => {
  const feedWith = (inner: string) =>
    `<?xml version="1.0"?><rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>t</title><item>` +
    `<title>Engineer</title><link>https://djinni.co/jobs/x</link><guid>https://djinni.co/jobs/x</guid>` +
    `<pubDate>Fri, 23 Oct 2026 16:55:36 +0000</pubDate>${inner}</item></channel></rss>`

  it('prefers the full content:encoded body over the short description when both arrive', async () => {
    const { mapped } = await collect(
      feedWith(
        '<description>short summary</description><content:encoded>full body</content:encoded>',
      ),
    )
    expect(mapped[0]?.description).toBe('full body')
  })

  it('falls back to the description when there is no content:encoded', async () => {
    const { mapped } = await collect(feedWith('<description>short summary</description>'))
    expect(mapped[0]?.description).toBe('short summary')
  })
})

describe('source identity', () => {
  it('declares the source type that routes its observations: DJINNI_RSS', () => {
    expect(djinniSpec.type).toBe('DJINNI_RSS')
    expect(djinniProvider.type).toBe('DJINNI_RSS')
  })
})

describe('adapter version', () => {
  it('is djinni-1: the field that invalidates checkpoints, changed only on purpose', () => {
    expect(djinniSpec.adapterVersion).toBe('djinni-1')
  })
})

describe('window semantics', () => {
  it('declares a 1 hour recent window, from the measured 6.9 h span and 32/hour peak', () => {
    expect(djinniSpec.inventory).toEqual({ kind: 'RECENT', windowMs: HOUR })
  })

  it('keeps the declared window under the measured bound: 100 items at a 32/hour peak = 3.125 h', () => {
    // 3.125 h written out independently of the constant (100 / 32 hours).
    expect(DJINNI_MEASURED_COVERAGE_BOUND_MS).toBe(11_250_000)
    expect(djinniSpec.inventory.kind).toBe('RECENT')
    const windowMs =
      djinniSpec.inventory.kind === 'RECENT' ? djinniSpec.inventory.windowMs : Infinity
    expect(windowMs).toBeLessThan(DJINNI_MEASURED_COVERAGE_BOUND_MS)
  })

  it('reports WINDOW coverage and a [now - 1h, now] scope for a complete run', async () => {
    const { batch } = await collect(fixture('primary-keyword-asic-chip-design.empty.xml'))
    expect(batch.outcome).toBe('SUCCEEDED')
    expect(batch.coverage).toBe('WINDOW')
    expect(batch.scope.window).toEqual({ from: new Date(NOW.getTime() - HOUR), to: NOW })
  })

  it('does not claim a window it did not cover when the run is cut short', async () => {
    const { batch } = await collect(fixture('primary-keyword-rust.truncated.xml'))
    expect(batch.outcome).toBe('FAILED')
    expect(batch.coverage).toBe('PARTIAL')
  })
})

describe('envelopes', () => {
  it('a real valid feed with no items succeeds with zero entries', async () => {
    const { batch, mapped } = await collect(fixture('primary-keyword-asic-chip-design.empty.xml'))
    expect(batch.outcome).toBe('SUCCEEDED')
    expect(batch.counts).toEqual({
      raw: 0,
      normalized: 0,
      invalid: 0,
      quarantined: 0,
      discarded: 0,
    })
    expect(mapped).toEqual([])
    expect(batch.requests.map((r) => r.error)).toEqual([null])
  })

  it('a transfer cut off after the third item is drift, and nothing from it is trusted', async () => {
    const { batch, mapped } = await collect(fixture('primary-keyword-rust.truncated.xml'))
    expect(batch.outcome).toBe('FAILED')
    expect(batch.requests.at(-1)?.error?.code).toBe('PARSE_DRIFT')
    expect(batch.requests.at(-1)?.error?.message).toMatch(/^MALFORMED: /)
    expect(mapped).toEqual([])
  })
})
