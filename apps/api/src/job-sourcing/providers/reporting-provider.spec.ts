import { describe, expect, it } from 'vitest'
import {
  assertBatchInvariant,
  assertValidatedConfig,
  assertCountsBalanced,
  buildCollectionBatch,
  buildInvalidSample,
  buildRequestReport,
  type CollectionCounts,
  type CollectionOutcome,
  type DerivationFacts,
  decideCheckpoint,
  deriveCoverage,
  deriveOutcome,
  isBuiltBatch,
  isValidatedConfig,
  markValidated,
  MAX_CURSOR_CHARS,
  DROPPED_TOO_LONG,
  MAX_REDACTION_INPUT_CHARS,
  MAX_SCHEME_CHARS,
  REPORTABLE_QUERY_KEYS,
  URL_END_CHARS,
  URL_TRAILING_PUNCTUATION,
  USERINFO_RUN_DELIMITERS,
  MAX_REPORT_URL_CHARS,
  MAX_REQUEST_REPORTS,
  DROPPED_URL_TOO_LONG,
  MAX_SAMPLE_CHARS,
  MAX_SAMPLES,
  redactSecrets,
  redactText,
  redactUrl,
  REDACTED,
  type SourceCoverageScope,
  type StopReason,
  toStoredReportCounts,
  type ValidatedCheckpoint,
  validatedCheckpointSchema,
} from './reporting-provider'
import { buildSourceObservation, type SourceObservation } from '../normalize/observation'

/**
 * The reporting contract's behaviour. Everything here is a pure function, so the test goes
 * straight through the interface the 25 phase-3 adapters will use — no fake subclass, nothing
 * reached from behind the seam.
 *
 * Every boundary below is asserted on BOTH sides (the value AT the limit accepted, the one past it
 * refused): task 2.1 shipped a correct cap whose test could not tell `>` from `>=`.
 */

const clean: CollectionCounts = {
  raw: 10,
  normalized: 10,
  invalid: 0,
  quarantined: 0,
  discarded: 0,
}

/**
 * `n` observations, built through the real builder rather than cast from `{}`.
 *
 * `assertBatchInvariant` compares `counts.normalized` against `observations.LENGTH`, so the
 * contents are irrelevant to every assertion here — but a cast would let `SourceObservation` drift
 * away from what a batch actually carries without a single test noticing, and this file is the one
 * that pins the batch's shape.
 */
function observations(n: number): SourceObservation[] {
  return Array.from({ length: n }, (_, i) => {
    const result = buildSourceObservation(
      {
        provider: 'REMOTEOK_API',
        adapterVersion: 'a1',
        namespace: 'board',
        nativeId: `n${i}`,
        url: `https://jobs.example.com/j/${i}`,
        title: 'Senior Engineer',
        companyName: 'Studio',
      },
      { now: new Date('2026-10-20T10:00:00Z') },
    )
    if (!result.ok) throw new Error(`fixture observation ${i} was refused: ${result.reason}`)
    return result.observation
  })
}

function scope(overrides: Partial<SourceCoverageScope> = {}): SourceCoverageScope {
  return { namespace: 'board', query: null, configVersion: 1, window: null, ...overrides }
}

function facts(overrides: Partial<DerivationFacts> = {}): DerivationFacts {
  return {
    stop: 'EXHAUSTED',
    pagesCompleted: 3,
    counts: clean,
    scope: scope(),
    resumed: false,
    ...overrides,
  }
}

/**
 * The REDACTED placeholder, asserted against its literal text ONCE. Everywhere else the tests use
 * the imported constant — which on its own is a tautology: raise the constant and every assertion
 * rises with it. One literal assertion is what anchors the rest.
 */
describe('the constants', () => {
  it('redacts with the literal marker a reader of a log would recognise', () => {
    expect(REDACTED).toBe('[REDACTED]')
  })

  it('samples at 200 characters and keeps at most 5 of them', () => {
    expect(MAX_SAMPLE_CHARS).toBe(200)
    expect(MAX_SAMPLES).toBe(5)
    expect(MAX_REQUEST_REPORTS).toBe(200)
  })

  /**
   * The URL cap and its marker, anchored to literals for the reason the `REDACTED` note above
   * gives. Every other assertion about the cap compares against the imported constants, which on
   * their own is a tautology — and the mutation gate said so: it emptied the whole
   * `DROPPED_URL_TOO_LONG` template and every test still passed, because both sides of
   * `toBe(DROPPED_URL_TOO_LONG)` became `''` together.
   */
  it('drops an over-long URL at 2048 characters, with the bound named in the marker', () => {
    expect(MAX_REPORT_URL_CHARS).toBe(2048)
    expect(DROPPED_URL_TOO_LONG).toBe('[REDACTED] (url dropped: over 2048 characters)')
  })
})

/** Every error class names itself, so a log line and an `instanceof`-free check both identify it. */
describe('the error names', () => {
  it('names CountsImbalanceError', () => {
    expect(() =>
      assertCountsBalanced({ raw: 1, normalized: 0, invalid: 0, quarantined: 0, discarded: 0 }),
    ).toThrow(expect.objectContaining({ name: 'CountsImbalanceError' }))
  })

  it('names BatchInvariantError', () => {
    expect(() =>
      assertBatchInvariant({
        outcome: 'FAILED',
        coverage: 'FULL_INVENTORY',
        counts: clean,
        observations: observations(clean.normalized),
      }),
    ).toThrow(expect.objectContaining({ name: 'BatchInvariantError' }))
  })

  it('names UnvalidatedConfigError', () => {
    expect(() => assertValidatedConfig({ namespace: 'b', configVersion: 1 })).toThrow(
      expect.objectContaining({ name: 'UnvalidatedConfigError' }),
    )
  })
})

describe('deriveOutcome', () => {
  /**
   * The reason `deriveOutcome` is an exhaustive switch and not a fall-through. A stop reason it
   * does not recognise must not become a SUCCESS — that is the one answer it may never invent, and
   * a fall-through `return 'SUCCEEDED'` invents it for every future branch that forgets to set one.
   */
  it('throws on a stop reason it does not recognise, rather than calling it a success', () => {
    const bogus = facts({ stop: 'NOT_A_STOP' as StopReason })
    expect(() => deriveOutcome(bogus)).toThrow(/unknown stop reason/)
  })

  it('reports CANCELLED whatever else happened, because an aborted run claims nothing', () => {
    expect(deriveOutcome(facts({ stop: 'CANCELLED', pagesCompleted: 7 }))).toBe('CANCELLED')
  })

  it('reports FAILED when an error arrived before a single page was persisted', () => {
    expect(deriveOutcome(facts({ stop: 'ERROR', pagesCompleted: 0 }))).toBe('FAILED')
  })

  it('reports PARTIAL when an error arrived after at least one page was persisted', () => {
    expect(deriveOutcome(facts({ stop: 'ERROR', pagesCompleted: 1 }))).toBe('PARTIAL')
  })

  it('treats a cost stop like any other stop: PARTIAL once work is preserved', () => {
    expect(deriveOutcome(facts({ stop: 'COST_STOP', pagesCompleted: 2 }))).toBe('PARTIAL')
    expect(deriveOutcome(facts({ stop: 'COST_STOP', pagesCompleted: 0 }))).toBe('FAILED')
  })

  it('reports SUCCEEDED for our OWN bounds — a page cap and a cursor cycle are not failures', () => {
    expect(deriveOutcome(facts({ stop: 'PAGE_CAP' }))).toBe('SUCCEEDED')
    expect(deriveOutcome(facts({ stop: 'CURSOR_CYCLE' }))).toBe('SUCCEEDED')
  })

  it('reports SUCCEEDED for an exhausted scope that returned nothing at all', () => {
    const empty: CollectionCounts = {
      raw: 0,
      normalized: 0,
      invalid: 0,
      quarantined: 0,
      discarded: 0,
    }
    expect(deriveOutcome(facts({ counts: empty, pagesCompleted: 1 }))).toBe('SUCCEEDED')
  })
})

describe('deriveCoverage', () => {
  it('claims FULL_INVENTORY only for an exhausted, clean, unqueried, unwindowed scope', () => {
    expect(deriveCoverage(facts())).toBe('FULL_INVENTORY')
  })

  it('drops to PARTIAL when even one item could not be observed', () => {
    expect(
      deriveCoverage(
        facts({ counts: { raw: 10, normalized: 9, invalid: 1, quarantined: 0, discarded: 0 } }),
      ),
    ).toBe('PARTIAL')
    expect(
      deriveCoverage(
        facts({ counts: { raw: 10, normalized: 9, invalid: 0, quarantined: 1, discarded: 0 } }),
      ),
    ).toBe('PARTIAL')
  })

  it('calls a page cap on a SEARCH scope a WINDOW — a search never enumerated an inventory', () => {
    expect(deriveCoverage(facts({ stop: 'PAGE_CAP', scope: scope({ query: 'golang' }) }))).toBe(
      'WINDOW',
    )
  })

  it('calls the SAME page cap on a full-inventory scope PARTIAL — we were to see everything', () => {
    expect(deriveCoverage(facts({ stop: 'PAGE_CAP', scope: scope({ query: null }) }))).toBe(
      'PARTIAL',
    )
  })

  it('applies the same split to a cursor cycle', () => {
    expect(deriveCoverage(facts({ stop: 'CURSOR_CYCLE', scope: scope({ query: 'go' }) }))).toBe(
      'WINDOW',
    )
    expect(deriveCoverage(facts({ stop: 'CURSOR_CYCLE', scope: scope({ query: null }) }))).toBe(
      'PARTIAL',
    )
  })

  it('reports WINDOW for a scope that asked for a time window, even when exhausted', () => {
    const window = { from: new Date('2026-10-01T00:00:00Z'), to: new Date('2026-10-20T00:00:00Z') }
    expect(deriveCoverage(facts({ scope: scope({ window }) }))).toBe('WINDOW')
  })

  it('reports WINDOW for an exhausted SEARCH scope — a query is not an inventory', () => {
    expect(deriveCoverage(facts({ scope: scope({ query: 'rust' }) }))).toBe('WINDOW')
  })

  it.each(['ERROR', 'COST_STOP', 'CANCELLED'] as const)(
    'reports PARTIAL for a %s stop whatever the scope claimed',
    (stop) => {
      expect(deriveCoverage(facts({ stop, pagesCompleted: 4 }))).toBe('PARTIAL')
    },
  )
})

/**
 * AC1 as a PROPERTY over the whole cross-product rather than a sampled example: there is no
 * combination of stop reason, persisted pages, counts and scope for which a non-SUCCEEDED attempt
 * claims FULL_INVENTORY. This is the test that notices a future `deriveCoverage` branch added
 * without its invariant in mind.
 */
describe('the invariant above all others', () => {
  const stops: StopReason[] = [
    'EXHAUSTED',
    'PAGE_CAP',
    'CURSOR_CYCLE',
    'ERROR',
    'CANCELLED',
    'COST_STOP',
  ]
  const countsCases: CollectionCounts[] = [
    clean,
    { raw: 0, normalized: 0, invalid: 0, quarantined: 0, discarded: 0 },
    { raw: 4, normalized: 2, invalid: 1, quarantined: 1, discarded: 0 },
  ]
  const scopes = [
    scope(),
    scope({ query: 'q' }),
    scope({ window: { from: new Date(0), to: new Date(1) } }),
  ]

  it('never pairs a non-SUCCEEDED outcome with FULL_INVENTORY coverage', () => {
    const offenders: string[] = []
    for (const stop of stops) {
      for (const pagesCompleted of [0, 1, 5]) {
        for (const counts of countsCases) {
          for (const s of scopes) {
            const f = facts({ stop, pagesCompleted, counts, scope: s })
            const outcome = deriveOutcome(f)
            const coverage = deriveCoverage(f)
            if (outcome !== 'SUCCEEDED' && coverage === 'FULL_INVENTORY') {
              offenders.push(`${stop}/${pagesCompleted}/${counts.raw}/${s.query ?? 'null'}`)
            }
          }
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('never claims SUCCEEDED for a stop that lost work', () => {
    const lossy: StopReason[] = ['ERROR', 'COST_STOP', 'CANCELLED']
    const claimed: CollectionOutcome[] = lossy.map((stop) =>
      deriveOutcome(facts({ stop, pagesCompleted: 9 })),
    )
    expect(claimed).not.toContain('SUCCEEDED')
  })
})

describe('assertBatchInvariant', () => {
  it('refuses a hand-made batch that pairs FAILED with FULL_INVENTORY', () => {
    expect(() =>
      assertBatchInvariant({
        outcome: 'FAILED',
        coverage: 'FULL_INVENTORY',
        counts: clean,
        observations: observations(clean.normalized),
      }),
    ).toThrow(/cannot claim FULL_INVENTORY/)
  })

  it('refuses a hand-made CANCELLED batch that claims FULL_INVENTORY', () => {
    expect(() =>
      assertBatchInvariant({
        outcome: 'CANCELLED',
        coverage: 'FULL_INVENTORY',
        counts: clean,
        observations: observations(clean.normalized),
      }),
    ).toThrow(/cannot claim FULL_INVENTORY/)
  })

  it('accepts the one outcome that may claim FULL_INVENTORY', () => {
    expect(() =>
      assertBatchInvariant({
        outcome: 'SUCCEEDED',
        coverage: 'FULL_INVENTORY',
        counts: clean,
        observations: observations(clean.normalized),
      }),
    ).not.toThrow()
  })

  it('accepts a FAILED batch that makes no coverage claim', () => {
    expect(() =>
      assertBatchInvariant({
        outcome: 'FAILED',
        coverage: 'PARTIAL',
        counts: clean,
        observations: observations(clean.normalized),
      }),
    ).not.toThrow()
  })

  /**
   * `counts.normalized === observations.length`, both sides. The ACCEPTANCE half is first and is
   * not a restatement of the finding: a batch whose two numbers agree must pass, including at
   * zero, or the guard could be satisfied by refusing everything.
   */
  it('accepts a batch whose normalized count matches the observations it carries', () => {
    expect(() =>
      assertBatchInvariant({
        outcome: 'SUCCEEDED',
        coverage: 'PARTIAL',
        counts: { raw: 4, normalized: 3, invalid: 1, quarantined: 0, discarded: 0 },
        observations: observations(3),
      }),
    ).not.toThrow()
  })

  it('accepts a batch that carries no observations and claims none', () => {
    expect(() =>
      assertBatchInvariant({
        outcome: 'SUCCEEDED',
        coverage: 'PARTIAL',
        counts: { raw: 2, normalized: 0, invalid: 2, quarantined: 0, discarded: 0 },
        observations: [],
      }),
    ).not.toThrow()
  })

  it('refuses a batch that claims more normalized items than it carries', () => {
    expect(() =>
      assertBatchInvariant({
        outcome: 'FAILED',
        coverage: 'PARTIAL',
        counts: { raw: 5, normalized: 2, invalid: 0, quarantined: 0, discarded: 3 },
        observations: [],
      }),
    ).toThrow(/counts.normalized=2 does not match observations.length=0/)
  })

  it('refuses a batch that carries more observations than it claims', () => {
    // The other direction, which no finding asked for: a batch handing over rows it did not
    // account for is as unbalanced as one accounting for rows it did not hand over.
    expect(() =>
      assertBatchInvariant({
        outcome: 'SUCCEEDED',
        coverage: 'PARTIAL',
        counts: { raw: 1, normalized: 1, invalid: 0, quarantined: 0, discarded: 0 },
        observations: observations(2),
      }),
    ).toThrow(/does not match observations.length=2/)
  })

  it('refuses a SUCCEEDED batch that threw a page away', () => {
    // Every path that discards a page ends the attempt with a failure, so this pairing cannot be
    // produced today — which is exactly why it is a guard for phase 3's 25 adapters and is tested
    // against a hand-made batch, the only way such a guard can have a failing test at all.
    expect(() =>
      assertBatchInvariant({
        outcome: 'SUCCEEDED',
        coverage: 'PARTIAL',
        counts: { raw: 3, normalized: 1, invalid: 0, quarantined: 0, discarded: 2 },
        observations: observations(1),
      }),
    ).toThrow(/cannot have discarded a page/)
  })

  it('accepts a PARTIAL batch that threw a page away', () => {
    expect(() =>
      assertBatchInvariant({
        outcome: 'PARTIAL',
        coverage: 'PARTIAL',
        counts: { raw: 3, normalized: 1, invalid: 0, quarantined: 0, discarded: 2 },
        observations: observations(1),
      }),
    ).not.toThrow()
  })
})

describe('assertCountsBalanced', () => {
  it('accepts counts whose dispositions account for exactly every raw item', () => {
    expect(() =>
      assertCountsBalanced({ raw: 7, normalized: 4, invalid: 2, quarantined: 1, discarded: 0 }),
    ).not.toThrow()
  })

  it('refuses one disposition too few', () => {
    expect(() =>
      assertCountsBalanced({ raw: 7, normalized: 4, invalid: 2, quarantined: 0, discarded: 0 }),
    ).toThrow(/do not balance/)
  })

  it('refuses one disposition too many', () => {
    expect(() =>
      assertCountsBalanced({ raw: 7, normalized: 5, invalid: 2, quarantined: 1, discarded: 0 }),
    ).toThrow(/do not balance/)
  })

  /**
   * `discarded` is a disposition like the other three, so it balances like them. Both sides: a
   * discarded item accounts for its raw item, and a `raw` that forgets it does not balance. Added
   * because a fourth summand is exactly the kind of thing that gets declared and then left out of
   * the sum — and the balance check is the one place that would not notice, since dropping it from
   * the sum makes the check STRICTER, not looser, and every pre-existing case still passes.
   */
  it('counts a discarded item as accounting for its raw item', () => {
    expect(() =>
      assertCountsBalanced({ raw: 7, normalized: 3, invalid: 2, quarantined: 1, discarded: 1 }),
    ).not.toThrow()
  })

  it('refuses counts whose raw does not cover the discarded items', () => {
    expect(() =>
      assertCountsBalanced({ raw: 6, normalized: 3, invalid: 2, quarantined: 1, discarded: 1 }),
    ).toThrow(/do not balance/)
  })

  it('names the discarded bucket in the imbalance it reports', () => {
    expect(() =>
      assertCountsBalanced({ raw: 9, normalized: 3, invalid: 2, quarantined: 1, discarded: 1 }),
    ).toThrow(/discarded=1/)
  })
})

describe('toStoredReportCounts', () => {
  it('maps raw to received and folds ALL non-kept buckets into the store`s single invalid', () => {
    expect(
      toStoredReportCounts({ raw: 10, normalized: 6, invalid: 3, quarantined: 1, discarded: 0 }),
    ).toEqual({
      received: 10,
      invalid: 4,
      normalized: 6,
    })
  })

  it('folds discarded items into the store`s invalid, keeping received whole', () => {
    // The store has ONE column for "received a row for nothing", and a page we read and then
    // threw away belongs in it. `received` still accounts for every item, because the store's
    // refine is "exactly one disposition per received item" — a received item with no disposition
    // is a report the store refuses, which is what `normalized: 2` with no rows produced (CR-M-5).
    expect(
      toStoredReportCounts({ raw: 10, normalized: 4, invalid: 2, quarantined: 1, discarded: 3 }),
    ).toEqual({
      received: 10,
      invalid: 6,
      normalized: 4,
    })
  })

  it('refuses to project counts that do not balance, rather than emitting a report that cannot', () => {
    expect(() =>
      toStoredReportCounts({ raw: 10, normalized: 6, invalid: 3, quarantined: 0, discarded: 0 }),
    ).toThrow(/do not balance/)
  })
})

describe('redactSecrets', () => {
  it('removes the secret and leaves a marker where it was', () => {
    const out = redactSecrets('https://api.example.com/jobs?key=s3cr3t-value', ['s3cr3t-value'])
    expect(out).not.toContain('s3cr3t-value')
    expect(out).toContain(REDACTED)
  })

  it('redacts a long secret before its own prefix, so no tail of it survives', () => {
    const out = redactSecrets('acct=abcd key=abcdefgh', ['abcd', 'abcdefgh'])
    expect(out).not.toContain('abcdefgh')
    expect(out).toBe(`acct=${REDACTED} key=${REDACTED}`)
  })

  it('removes every occurrence, not only the first', () => {
    expect(redactSecrets('k=zz&also=zz', ['zz'])).toBe(`k=${REDACTED}&also=${REDACTED}`)
  })

  it('ignores a one-character secret, which would redact the whole URL and say nothing', () => {
    expect(redactSecrets('https://a.example.com/x', ['a'])).toBe('https://a.example.com/x')
  })

  it('accepts a two-character secret — the boundary of what is usable', () => {
    expect(redactSecrets('q=ab', ['ab'])).toBe(`q=${REDACTED}`)
  })

  it('leaves a string with no secret in it byte-for-byte alone', () => {
    expect(redactSecrets('https://api.example.com/jobs?page=2', ['nope'])).toBe(
      'https://api.example.com/jobs?page=2',
    )
  })
})

describe('buildRequestReport', () => {
  const base = {
    attempt: 1,
    page: 2,
    status: 200,
    startedAt: new Date('2026-10-20T10:00:00Z'),
    endedAt: new Date('2026-10-20T10:00:01Z'),
    cost: { unit: 'REQUEST' as const, amount: 1 },
  }

  it('reports a credential-free URL', () => {
    const report = buildRequestReport(
      { ...base, url: 'https://api.example.com/j?key=TOPSECRET', error: null },
      ['TOPSECRET'],
    )
    expect(report.url).toBe(`https://api.example.com/j?key=${REDACTED}`)
  })

  it('redacts the error message too — an upstream body can echo the key back', () => {
    const report = buildRequestReport(
      {
        ...base,
        url: 'https://api.example.com/j',
        error: { code: 'UPSTREAM', message: 'invalid key TOPSECRET supplied' },
      },
      ['TOPSECRET'],
    )
    expect(report.error?.message).not.toContain('TOPSECRET')
    expect(report.error?.message).toContain(REDACTED)
  })

  it('keeps an error message of exactly 500 characters whole', () => {
    const message = 'x'.repeat(500)
    const report = buildRequestReport(
      { ...base, url: 'https://api.example.com/j', error: { code: 'UPSTREAM', message } },
      [],
    )
    expect(report.error?.message).toHaveLength(500)
  })

  /**
   * The URL bound, both sides of it. THE ACCEPTANCE HALF IS FIRST AND IS THE ONE THAT MATTERS
   * HERE: the cap's whole risk is that it swallows URLs an operator needs to read, so the test
   * that an ordinary long-but-reasonable URL survives intact comes before the test that an absurd
   * one is dropped. From the finding alone only the second would exist, and `MAX_REPORT_URL_CHARS`
   * could have been 20 without a test objecting.
   */
  const longButReportable = (chars: number): string => {
    const prefix = 'https://api.example.com/jobs?cursor='
    return prefix + 'c'.repeat(chars - prefix.length)
  }

  it('reports an ordinary long URL in full', () => {
    const url = longButReportable(900)
    const report = buildRequestReport({ ...base, url, error: null }, [])

    expect(report.url).toBe(url)
  })

  it('reports a URL of exactly the cap in full', () => {
    const url = longButReportable(MAX_REPORT_URL_CHARS)
    const report = buildRequestReport({ ...base, url, error: null }, [])

    expect(report.url).toHaveLength(MAX_REPORT_URL_CHARS)
    expect(report.url).toBe(url)
  })

  it('drops the URL one character past the cap', () => {
    const url = longButReportable(MAX_REPORT_URL_CHARS + 1)
    const report = buildRequestReport({ ...base, url, error: null }, [])

    expect(report.url).toBe(DROPPED_URL_TOO_LONG)
  })

  it('drops rather than truncates, so no prefix of the URL is emitted', () => {
    // The `DROPPED_TOO_LONG` principle: a bound that cannot be satisfied drops the field. A
    // truncation would emit the first 2048 characters, and the first 2048 characters of a URL are
    // where its credentials live.
    //
    // `cursor` is a REPORTABLE key on purpose. An unreportable one (`api_key=…`) has its value
    // replaced wholesale, so redaction SHRINKS the URL and the cap is never reached — which the
    // first version of this test discovered by failing. The length only survives redaction in a
    // value we keep, and a provider's opaque cursor is exactly that.
    const url = `https://api.example.com/jobs?cursor=hunter2${'p'.repeat(MAX_REPORT_URL_CHARS)}`
    const report = buildRequestReport({ ...base, url, error: null }, ['hunter2'])

    expect(report.url).toBe(DROPPED_URL_TOO_LONG)
    expect(report.url).not.toContain('api.example.com')
    expect(report.url).not.toContain('hunter2')
  })

  it('bounds the URL even when redaction made it longer than it arrived', () => {
    // Redaction EXPANDS as well as shrinks: an unreportable key's value becomes a 10-character
    // marker, so `a7=v` grows to `a7=[REDACTED]`. The cap is therefore applied to the REDACTED
    // string — the one that gets persisted — and not to the input. Applied to the input, a URL
    // that arrives at 919 characters would be stored at 2 269.
    const params = Array.from({ length: 150 }, (_, i) => `a${i}=v`).join('&')
    const url = `https://api.example.com/jobs?${params}`
    const report = buildRequestReport({ ...base, url, error: null }, [])

    expect(url.length).toBeLessThan(MAX_REPORT_URL_CHARS)
    expect(redactUrl(url, []).length).toBeGreaterThan(MAX_REPORT_URL_CHARS)
    expect(report.url).toBe(DROPPED_URL_TOO_LONG)
  })

  it('truncates an error message of 501 characters', () => {
    const message = 'x'.repeat(501)
    const report = buildRequestReport(
      { ...base, url: 'https://api.example.com/j', error: { code: 'UPSTREAM', message } },
      [],
    )
    expect(report.error?.message).toHaveLength(500)
  })

  it('carries attempt, page, status, timestamps and metered cost through unchanged', () => {
    const report = buildRequestReport(
      { ...base, url: 'https://api.example.com/j', error: null },
      [],
    )
    expect(report).toMatchObject({
      attempt: 1,
      page: 2,
      status: 200,
      startedAt: base.startedAt,
      endedAt: base.endedAt,
      cost: { unit: 'REQUEST', amount: 1 },
      error: null,
    })
  })

  it('reports a null status when no response arrived', () => {
    const report = buildRequestReport(
      {
        ...base,
        status: null,
        url: 'https://api.example.com/j',
        error: { code: 'TRANSIENT_NETWORK', message: 'socket hang up' },
      },
      [],
    )
    expect(report.status).toBeNull()
  })
})

describe('buildInvalidSample', () => {
  it(`keeps a sample of exactly ${MAX_SAMPLE_CHARS} characters whole`, () => {
    // A string item is sampled as itself, so this is exactly the cap, unquoted.
    const sample = buildInvalidSample(1, 'ITEM_SCHEMA', 'y'.repeat(MAX_SAMPLE_CHARS), [])
    expect(sample.sample).toBe('y'.repeat(MAX_SAMPLE_CHARS))
  })

  it('truncates a sample one character past the cap', () => {
    const sample = buildInvalidSample(1, 'ITEM_SCHEMA', 'y'.repeat(MAX_SAMPLE_CHARS + 1), [])
    expect(sample.sample).toHaveLength(MAX_SAMPLE_CHARS)
  })

  it('redacts a secret that reached us inside a bad item', () => {
    const sample = buildInvalidSample(3, 'ITEM_SCHEMA', { token: 'TOPSECRET' }, ['TOPSECRET'])
    expect(sample.sample).not.toContain('TOPSECRET')
    expect(sample.sample).toContain(REDACTED)
  })

  it('survives an unserializable item rather than failing the batch over diagnostics', () => {
    const circular: Record<string, unknown> = { a: 1 }
    circular.self = circular
    expect(buildInvalidSample(1, 'ITEM_SCHEMA', circular, []).sample).toBe('[unserializable]')
  })

  it('records the page the bad item came from', () => {
    expect(buildInvalidSample(4, 'MAPPER_THREW', { a: 1 }, []).page).toBe(4)
  })

  /** The REASON is bounded too, not only the sample: a Zod issue message can carry the offending
   * value, and an unbounded reason is an unbounded log line. */
  it('bounds the reason as well as the sample', () => {
    const sample = buildInvalidSample(1, `ITEM_SCHEMA: ${'r'.repeat(400)}`, 'x', [])
    expect(sample.reason).toHaveLength(MAX_SAMPLE_CHARS)
  })

  it('keeps a reason of exactly the cap whole', () => {
    const sample = buildInvalidSample(1, 'r'.repeat(MAX_SAMPLE_CHARS), 'x', [])
    expect(sample.reason).toBe('r'.repeat(MAX_SAMPLE_CHARS))
  })
})

describe('decideCheckpoint', () => {
  const current = { configVersion: 2, policyVersion: 5, adapterVersion: 'a3' }
  const stored: ValidatedCheckpoint = {
    configVersion: 2,
    policyVersion: 5,
    adapterVersion: 'a3',
    position: { kind: 'CURSOR', page: 7, cursor: 'c-7' },
    completedAt: new Date('2026-10-20T09:00:00Z'),
  }

  it('starts fresh when nothing was stored', () => {
    expect(decideCheckpoint(null, current)).toEqual({ kind: 'FRESH' })
  })

  it('resumes a checkpoint minted under the same three versions', () => {
    expect(decideCheckpoint(stored, current)).toEqual({ kind: 'RESUME', from: stored })
  })

  it.each([
    ['CONFIG_VERSION', { ...stored, configVersion: 1 }],
    ['POLICY_VERSION', { ...stored, policyVersion: 4 }],
    ['ADAPTER_VERSION', { ...stored, adapterVersion: 'a2' }],
  ] as const)('restarts with overlap on a %s mismatch', (mismatch, cp) => {
    expect(decideCheckpoint(cp, current)).toEqual({
      kind: 'RESTART_WITH_OVERLAP',
      discarded: cp,
      mismatch,
    })
  })

  it('reports the first mismatch deterministically when several moved at once', () => {
    const decision = decideCheckpoint(
      { ...stored, configVersion: 1, policyVersion: 4, adapterVersion: 'a2' },
      current,
    )
    expect(decision).toMatchObject({ kind: 'RESTART_WITH_OVERLAP', mismatch: 'CONFIG_VERSION' })
  })
})

describe('buildCollectionBatch', () => {
  const checkpoint: ValidatedCheckpoint = {
    configVersion: 1,
    policyVersion: 1,
    adapterVersion: 'a1',
    position: { kind: 'CURSOR', page: 2, cursor: 'c-2' },
    completedAt: new Date('2026-10-20T10:00:00Z'),
  }

  function build(overrides: Partial<Parameters<typeof buildCollectionBatch>[0]> = {}) {
    const resolved = overrides.facts ?? facts()
    return buildCollectionBatch({
      // The observations MATCH `counts.normalized` by default, since that is the invariant every
      // batch must satisfy. A test about something else does not have to restate it; a test about
      // the invariant passes `observations` explicitly in order to break it.
      observations: observations(resolved.counts.normalized),
      requests: [],
      checkpoint,
      invalidSamples: [],
      ...overrides,
      facts: resolved,
    })
  }

  it('derives outcome and coverage instead of accepting them', () => {
    const batch = build({ facts: facts({ stop: 'ERROR', pagesCompleted: 1 }) })
    expect(batch.outcome).toBe('PARTIAL')
    expect(batch.coverage).toBe('PARTIAL')
  })

  it(`keeps exactly ${MAX_SAMPLES} samples`, () => {
    const samples = Array.from({ length: MAX_SAMPLES }, (_, i) =>
      buildInvalidSample(i, 'ITEM_SCHEMA', i, []),
    )
    expect(build({ invalidSamples: samples }).invalidSamples).toHaveLength(MAX_SAMPLES)
  })

  it('drops the sample one past the cap', () => {
    const samples = Array.from({ length: MAX_SAMPLES + 1 }, (_, i) =>
      buildInvalidSample(i, 'ITEM_SCHEMA', i, []),
    )
    expect(build({ invalidSamples: samples }).invalidSamples).toHaveLength(MAX_SAMPLES)
  })

  it(`keeps exactly ${MAX_REQUEST_REPORTS} request reports`, () => {
    const requests = Array.from({ length: MAX_REQUEST_REPORTS }, (_, i) =>
      buildRequestReport(
        {
          attempt: 1,
          page: i,
          status: 200,
          startedAt: new Date(0),
          endedAt: new Date(1),
          cost: null,
          url: 'https://api.example.com/j',
          error: null,
        },
        [],
      ),
    )
    expect(build({ requests }).requests).toHaveLength(MAX_REQUEST_REPORTS)
  })

  it('drops the request report one past the cap', () => {
    const requests = Array.from({ length: MAX_REQUEST_REPORTS + 1 }, (_, i) =>
      buildRequestReport(
        {
          attempt: 1,
          page: i,
          status: 200,
          startedAt: new Date(0),
          endedAt: new Date(1),
          cost: null,
          url: 'https://api.example.com/j',
          error: null,
        },
        [],
      ),
    )
    expect(build({ requests }).requests).toHaveLength(MAX_REQUEST_REPORTS)
  })

  it('refuses to produce a batch whose counts do not balance', () => {
    expect(() =>
      build({
        facts: facts({
          counts: { raw: 3, normalized: 1, invalid: 0, quarantined: 0, discarded: 0 },
        }),
      }),
    ).toThrow(/do not balance/)
  })
})

describe('config validation marker', () => {
  it('accepts a config that a schema validated', () => {
    expect(isValidatedConfig(markValidated({ namespace: 'b', configVersion: 1 }))).toBe(true)
  })

  it('refuses a config shaped right that nothing validated', () => {
    expect(isValidatedConfig({ namespace: 'b', configVersion: 1 })).toBe(false)
  })

  it('refuses a non-object', () => {
    expect(isValidatedConfig(null)).toBe(false)
    expect(isValidatedConfig('config')).toBe(false)
  })

  /**
   * `undefined` specifically. A symbol lookup on a string or a number yields `undefined` and
   * answers `false` anyway, so those two cases do not exercise the `typeof` guard at all — only
   * `undefined` does, because a property lookup on it throws. Without the guard this call is a
   * TypeError rather than a `false`.
   */
  it('refuses undefined without throwing', () => {
    expect(isValidatedConfig(undefined)).toBe(false)
  })

  /**
   * The reason the marker is NON-ENUMERABLE and not merely symbol-keyed. A symbol never reaches
   * `JSON.stringify` whatever its enumerability — but object spread DOES copy enumerable symbol
   * properties, and spreading a config to tweak one field is the obvious thing a phase-3 adapter
   * does. An enumerable marker would make that copy claim a validation it never had.
   */
  it('does not survive a spread, so a tweaked copy cannot claim it was validated', () => {
    const config = markValidated({ namespace: 'board', configVersion: 3 })
    expect(isValidatedConfig({ ...config, namespace: 'other' })).toBe(false)
  })

  it('never serializes the marker, so it cannot reach a log line or a row', () => {
    const config = markValidated({ namespace: 'board', configVersion: 3 })
    expect(JSON.parse(JSON.stringify(config))).toEqual({ namespace: 'board', configVersion: 3 })
    expect(isValidatedConfig(JSON.parse(JSON.stringify(config)))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Round-1 review findings, part two: redaction and the construction brands.
// ---------------------------------------------------------------------------

/**
 * THE SECRET THE OLD TESTS SHOULD HAVE USED.
 *
 * Every pre-existing redaction test used `TOPSECRET123` — alphanumeric, so its raw form and its
 * every encoded form are the SAME STRING, and exact matching handles it. That is the defect in the
 * test INPUTS, and it is the same shape of mistake as the tautological `REDACTED` assertion found
 * earlier in this file: the check could not fail because the input could not exercise it.
 *
 * This secret contains `/ + = & space`, each of which changes under at least one of the encodings
 * an adapter builds a URL with.
 */
const HOSTILE_SECRET = 'ab/cd+ef=gh&ij k'
const UNICODE_SECRET = 'ключ-доступу'

const reportBase = {
  attempt: 1,
  page: 1,
  status: 200,
  startedAt: new Date('2026-10-20T10:00:00Z'),
  endedAt: new Date('2026-10-20T10:00:01Z'),
  cost: null,
  error: null,
}

describe('redaction survives the encodings a URL is actually built with (SR-H-4 / CR-H-1)', () => {
  /**
   * WITHOUT THE FIX each of these reports the secret in full. Measured on the exact-match version:
   * a registered `ab/cd+ef=gh&ij k` came back as `?api_key=ab%2Fcd%2Bef%3Dgh%26ij%20k` through
   * `encodeURIComponent` and `...%26ij+k` through `URLSearchParams` — both entirely unredacted. So
   * "credential-free by construction" was false for any adapter that built a URL the normal way.
   */
  it.each([
    ['raw', (s: string) => s],
    ['encodeURIComponent', (s: string) => encodeURIComponent(s)],
    // Distinct from the above: `encodeURI` leaves `/ + = &` alone, which is exactly the set that
    // defeated exact matching, so an adapter putting a secret in a PATH segment needs this form.
    ['encodeURI', (s: string) => encodeURI(s)],
    ['URLSearchParams', (s: string) => new URLSearchParams([['v', s]]).toString().slice(2)],
    ['base64', (s: string) => Buffer.from(s, 'utf8').toString('base64')],
    ['base64url', (s: string) => Buffer.from(s, 'utf8').toString('base64url')],
  ])('redacts a hostile secret written in its %s form', (_name, encode) => {
    const encoded = encode(HOSTILE_SECRET)
    const out = redactText(`upstream said: api_key=${encoded} is invalid`, [HOSTILE_SECRET])

    expect(out).not.toContain(encoded)
    expect(out).toContain(REDACTED)
  })

  it('redacts a unicode secret in its percent-encoded form', () => {
    const out = redactText(`q=${encodeURIComponent(UNICODE_SECRET)}`, [UNICODE_SECRET])

    expect(out).not.toContain(encodeURIComponent(UNICODE_SECRET))
    expect(out).toBe(`q=${REDACTED}`)
  })

  it('redacts a hostile secret carried in a reported request URL', () => {
    const url = `https://api.example.com/j?api_key=${encodeURIComponent(HOSTILE_SECRET)}`
    const report = buildRequestReport({ ...reportBase, url }, [HOSTILE_SECRET])

    expect(report.url).not.toContain('ab%2Fcd')
    expect(report.url).toContain(REDACTED)
  })

  it('still redacts the boring alphanumeric case the old tests covered', () => {
    const report = buildRequestReport(
      { ...reportBase, url: 'https://api.example.com/j?key=TOPSECRET123' },
      ['TOPSECRET123'],
    )

    expect(report.url).toBe(`https://api.example.com/j?key=${REDACTED}`)
  })
})

describe('redaction is STRUCTURAL first, so an unregistered credential still goes', () => {
  /**
   * WITHOUT THE FIX this reports the URL verbatim. `secrets: []` — nothing was registered, so
   * exact matching had nothing to match, and the report carried a password and a token:
   * `https://bob:hunter2@api.example.com/j?token=abc123`. A secret list is a list of the leaks
   * someone remembered; across 25 adapters that is not a guarantee.
   */
  it('strips userinfo even with no secrets registered', () => {
    const out = redactUrl('https://bob:hunter2@api.example.com/j?token=abc123', [])

    expect(out).not.toContain('bob')
    expect(out).not.toContain('hunter2')
    expect(out).not.toContain('abc123')
  })

  /**
   * A URL carrying a username and NO password. `user:pass@` by shape cannot see this one — the
   * regex needs the colon — so it is the case that keeps `URL.username` load-bearing. A token
   * pasted into the userinfo slot is a real shape: several providers document it.
   */
  it('strips a username-only credential, which has no colon to match on', () => {
    const out = redactUrl('https://tok3n-in-the-userinfo@api.example.com/j?page=1', [])

    expect(out).not.toContain('tok3n-in-the-userinfo')
    expect(out).toContain('api.example.com')
  })

  it('redacts a query value whose key is not on the allowlist', () => {
    expect(redactUrl('https://api.example.com/j?api_key=zzz', [])).toBe(
      `https://api.example.com/j?api_key=${REDACTED}`,
    )
  })

  it.each(['token', 'key', 'api_key', 'apikey', 'access_token', 'signature', 'sig', 'auth'])(
    'redacts the value of `%s`',
    (param) => {
      const out = redactUrl(`https://api.example.com/j?${param}=abc123`, [])

      expect(out).not.toContain('abc123')
      expect(out).toContain(REDACTED)
    },
  )

  it('keeps the pagination and search parameters an operator needs to read', () => {
    const out = redactUrl('https://api.example.com/j?page=2&per_page=50&q=react&sort=date', [])

    expect(out).toBe('https://api.example.com/j?page=2&per_page=50&q=react&sort=date')
  })

  it('drops a fragment, which is never part of what we asked for', () => {
    expect(redactUrl('https://api.example.com/j?page=1#tok=abc123', [])).not.toContain('abc123')
  })

  /**
   * This one was found by the test, not by a reviewer. The string PARSES — as scheme `bob:` with
   * everything after it in an opaque path — so `URL.username` and `URL.password` are both empty
   * and the userinfo strip finds nothing to strip. The credential reached the report through the
   * PATH, which is why `user:pass@` is now redacted by shape wherever it appears.
   */
  it('redacts credentials hidden in an opaque scheme`s path', () => {
    const out = redactUrl('bob:hunter2@api.example.com/x?token=abc123', [])

    expect(out).not.toContain('hunter2')
    expect(out).toContain(REDACTED)
  })

  it('refuses to report a URL it cannot parse at all, rather than passing it through', () => {
    expect(redactUrl('not a url at all', [])).toBe(`${REDACTED} (unparsable url)`)
  })

  /**
   * WITHOUT THE FIX this passes through unchanged. With `bob` and `hunter2` BOTH registered,
   * `Authorization: Basic Ym9iOmh1bnRlcjI=` survived exact matching, because the base64 of the
   * PAIR is not the base64 of either half. Redacting the scheme's token structurally handles it
   * without an n-squared sweep over pairs of a list whose length we do not control.
   */
  it.each(['Basic', 'Bearer', 'Token', 'ApiKey'])('redacts a `%s` credential', (scheme) => {
    const out = redactText(`Authorization: ${scheme} Ym9iOmh1bnRlcjI=`, ['bob', 'hunter2'])

    expect(out).toBe(`Authorization: ${scheme} ${REDACTED}`)
  })
})

describe('a bad item`s sample cannot carry a credential (SR-L-3)', () => {
  /**
   * WITHOUT THE FIX the sample reported
   * `{"ref":"https://u:p@api.example.com/x?api_key=ab%2Fcd..."}` with the userinfo intact and the
   * registered key unredacted — `buildInvalidSample` ran the same exact-match pass as a URL field,
   * and a sample is free text that happens to contain a URL.
   */
  it('redacts an embedded credentialed URL inside a refused item', () => {
    const sample = buildInvalidSample(
      3,
      'ITEM_SCHEMA',
      { ref: `https://u:pw@api.example.com/x?api_key=${encodeURIComponent(HOSTILE_SECRET)}` },
      [HOSTILE_SECRET],
    )

    expect(sample.sample).not.toContain('pw@')
    expect(sample.sample).not.toContain('ab%2Fcd')
    expect(sample.sample).toContain(REDACTED)
  })

  /**
   * The assertion that actually pins `redactText` rather than plain secret matching: a credential
   * that was NEVER registered, carried in a query parameter inside a sample. Only the per-URL
   * allowlist pass can remove it — exact matching has nothing to match, and that is precisely the
   * "credential-free by construction" claim this finding falsified.
   */
  it('redacts an UNREGISTERED credential in a URL inside a refused item', () => {
    const sample = buildInvalidSample(
      3,
      'ITEM_SCHEMA',
      { ref: 'https://api.example.com/x?access_token=never-registered-9x' },
      [],
    )

    expect(sample.sample).not.toContain('never-registered-9x')
    expect(sample.sample).toContain(REDACTED)
  })

  it('redacts an embedded credentialed URL inside a reason', () => {
    const sample = buildInvalidSample(1, 'fetching https://u:pw@api.example.com/x failed', {}, [])

    expect(sample.reason).not.toContain('pw@')
  })

  it('redacts BEFORE truncating, so a cut can never leave half a credential standing', () => {
    const sample = buildInvalidSample(
      1,
      'r',
      { pad: 'x'.repeat(MAX_SAMPLE_CHARS), token: HOSTILE_SECRET },
      [HOSTILE_SECRET],
    )

    expect(sample.sample).not.toContain('ab/cd')
    expect(sample.sample.length).toBeLessThanOrEqual(MAX_SAMPLE_CHARS)
  })
})

describe('construction is the only path to a batch (CR-H-2)', () => {
  /**
   * WITHOUT THE FIX there is nothing to test, which is the finding. `CollectionBatch` was a plain
   * exported interface, so any adapter implementing `ReportingJobSourceProvider` could return an
   * object literal and `assertBatchInvariant` would never run — across 25 adapters, the difference
   * between an invariant and a hope.
   *
   * This constructs the bad batch THE WAY AN ADAPTER WOULD: directly, as a literal, not through a
   * helper nobody is obliged to call. The literal below is a `FAILED` attempt claiming
   * `FULL_INVENTORY` with counts that do not balance — everything `buildCollectionBatch` refuses.
   */
  const adapterLiteral = {
    observations: [],
    outcome: 'FAILED' as const,
    coverage: 'FULL_INVENTORY' as const,
    scope: scope(),
    requests: [],
    counts: { raw: 5, normalized: 0, invalid: 0, quarantined: 0, discarded: 0 },
    checkpoint: null,
    invalidSamples: [],
  }

  it('tells an adapter-made literal apart from a built batch', () => {
    const built = buildCollectionBatch({
      observations: observations(clean.normalized),
      facts: facts(),
      requests: [],
      checkpoint: null,
      invalidSamples: [],
    })

    // Paired on purpose: the negative half alone passes for a predicate that answers `false` to
    // everything, which is a check that cannot fail.
    expect(isBuiltBatch(adapterLiteral)).toBe(false)
    expect(isBuiltBatch(built)).toBe(true)
  })

  it.each([[null], [undefined], ['a batch'], [42], [[]]])(
    'does not recognise %s as a batch',
    (value) => {
      expect(isBuiltBatch(value)).toBe(false)
    },
  )

  it('recognises a batch that went through the builder', () => {
    const batch = buildCollectionBatch({
      observations: observations(clean.normalized),
      facts: facts(),
      requests: [],
      checkpoint: null,
      invalidSamples: [],
    })

    expect(isBuiltBatch(batch)).toBe(true)
  })

  /** The brand must never reach a database row or a log line — the reason it is non-enumerable. */
  it('keeps the brand out of JSON, keys and spreads', () => {
    const batch = buildCollectionBatch({
      observations: observations(clean.normalized),
      facts: facts(),
      requests: [],
      checkpoint: null,
      invalidSamples: [],
    })

    expect(JSON.stringify(batch)).not.toContain('batchBuilt')
    expect(Object.keys(batch)).not.toContain('batchBuilt')
    expect(isBuiltBatch({ ...batch })).toBe(false)
  })

  it('brands a request report the same way', () => {
    const report = buildRequestReport({ ...reportBase, url: 'https://api.example.com/j' }, [])

    expect(JSON.stringify(report)).not.toContain('requestReportBuilt')
    expect(Object.keys(report)).not.toContain('requestReportBuilt')
  })
})

describe('a stored checkpoint is parsed at the boundary (SR-H-2)', () => {
  const current = { configVersion: 2, policyVersion: 5, adapterVersion: 'a3' }

  /**
   * WITHOUT THE FIX every one of these is a `RESUME` carrying the value verbatim, because the
   * parameter was typed `ValidatedCheckpoint | null` and the name was the only guarantee. `page:
   * NaN` then disabled the page cap entirely.
   */
  it.each([
    ['page NaN', { kind: 'CURSOR', page: NaN, cursor: 'c' }],
    ['page as a string', { kind: 'CURSOR', page: '7', cursor: 'c' }],
    ['page zero', { kind: 'CURSOR', page: 0, cursor: 'c' }],
    ['page negative', { kind: 'CURSOR', page: -1, cursor: 'c' }],
    ['page fractional', { kind: 'CURSOR', page: 1.5, cursor: 'c' }],
    ['a cursor that is not a string', { kind: 'CURSOR', page: 1, cursor: 7 }],
    ['an empty cursor', { kind: 'CURSOR', page: 1, cursor: '' }],
    [
      'a cursor past the length cap',
      { kind: 'CURSOR', page: 1, cursor: 'c'.repeat(MAX_CURSOR_CHARS + 1) },
    ],
    ['an unknown kind', { kind: 'PAGE', page: 1 }],
    ['no kind', { page: 1, cursor: 'c' }],
  ])('restarts with overlap on %s', (_name, position) => {
    const decision = decideCheckpoint(
      {
        configVersion: 2,
        policyVersion: 5,
        adapterVersion: 'a3',
        position,
        completedAt: new Date('2026-10-20T09:00:00Z'),
      },
      current,
    )

    expect(decision).toEqual({
      kind: 'RESTART_WITH_OVERLAP',
      discarded: null,
      mismatch: 'UNPARSABLE',
    })
  })

  it('accepts a cursor exactly at the length cap', () => {
    const decision = decideCheckpoint(
      {
        configVersion: 2,
        policyVersion: 5,
        adapterVersion: 'a3',
        position: { kind: 'CURSOR', page: 1, cursor: 'c'.repeat(MAX_CURSOR_CHARS) },
        completedAt: new Date('2026-10-20T09:00:00Z'),
      },
      current,
    )

    expect(decision.kind).toBe('RESUME')
  })

  it('restarts with overlap when the whole value is the wrong shape', () => {
    expect(decideCheckpoint('a checkpoint', current)).toEqual({
      kind: 'RESTART_WITH_OVERLAP',
      discarded: null,
      mismatch: 'UNPARSABLE',
    })
  })

  it('starts fresh on undefined, as on null', () => {
    expect(decideCheckpoint(undefined, current)).toEqual({ kind: 'FRESH' })
  })

  /**
   * CR-M-6: an exhausted position used to be stored as `cursor: null`, which a cursor API read as
   * "start at page one" — the same representation for two different facts. A `RESTART` position
   * says only one thing, and it is not a resume instruction.
   */
  it('starts fresh on a RESTART position rather than resuming it', () => {
    expect(
      decideCheckpoint(
        {
          configVersion: 2,
          policyVersion: 5,
          adapterVersion: 'a3',
          position: { kind: 'RESTART', page: 9 },
          completedAt: new Date('2026-10-20T09:00:00Z'),
        },
        current,
      ),
    ).toEqual({ kind: 'FRESH' })
  })

  it('parses a date that arrived as a string, the way a JSON column returns it', () => {
    const parsed = validatedCheckpointSchema.safeParse({
      configVersion: 2,
      policyVersion: 5,
      adapterVersion: 'a3',
      position: { kind: 'CURSOR', page: 1, cursor: 'c' },
      completedAt: '2026-10-20T09:00:00.000Z',
    })

    expect(parsed.success).toBe(true)
  })
})

describe('a resumed attempt loses the FULL_INVENTORY claim (SPEC-L-2)', () => {
  it('reports PARTIAL for an exhausted, clean, unwindowed RESUMED scope', () => {
    expect(deriveCoverage(facts({ resumed: true }))).toBe('PARTIAL')
  })

  it('reports FULL_INVENTORY for the same facts unresumed', () => {
    expect(deriveCoverage(facts({ resumed: false }))).toBe('FULL_INVENTORY')
  })
})

describe('redaction cannot be made to hang by the text it redacts', () => {
  /**
   * A DENIAL OF SERVICE INTRODUCED BY THE FIX FOR A CREDENTIAL LEAK — worth naming as such, since
   * hardening that trades one security defect for another is the failure mode of this whole round.
   *
   * `USERINFO_RE` shipped as `([^\s:/?#@]+):([^\s:/?#@]+)@`. On text shaped `'a:' + 'b'.repeat(n)`
   * — allowed characters, one colon, NO `@` — the second group scans to the end and backtracks one
   * character at a time from every start position. Measured on the shipped version: 119 ms at
   * 10 KB, 2 786 ms at 50 KB, 11 773 ms at 100 KB. Clean O(n²), on text that comes from the
   * provider's own error body, after the byte cap has already been spent.
   *
   * THIS IS A TIMING ASSERTION BECAUSE NOTHING ELSE SEPARATES THE TWO VERSIONS. The redacted
   * output is identical either way, which is exactly why the quadratic version passed its tests.
   */
  const hostile = `a:${'b'.repeat(200_000)}`

  it('redacts 200 KB of backtracking bait in milliseconds, not minutes', () => {
    const started = Date.now()
    redactSecrets(hostile, ['irrelevant-secret'])
    const elapsed = Date.now() - started

    // The shipped quadratic version needed ~45 s for this input; the bounded one needs ~1 ms,
    // because the input bound truncates before the passes even run. 1 s leaves room for a loaded
    // CI box without leaving room for the defect.
    expect(elapsed).toBeLessThan(1_000)
  })

  it.each([
    ['a URL field', (t: string) => redactUrl(t, [])],
    ['free text', (t: string) => redactText(t, [])],
    ['a bad item`s sample', (t: string) => buildInvalidSample(1, 'r', t, []).sample],
  ])('holds for %s too', (_name, redact) => {
    const started = Date.now()
    redact(hostile)

    expect(Date.now() - started).toBeLessThan(1_000)
  })

  it('DROPS a field past the bound rather than emitting a truncated one', () => {
    const out = redactSecrets(`${'x'.repeat(MAX_REDACTION_INPUT_CHARS)}SECRETTAIL`, ['SECRETTAIL'])

    expect(out).toBe(DROPPED_TOO_LONG)
  })
})

describe('the registered-secret pass runs BEFORE the structural ones', () => {
  /**
   * THE ORDERING DEFECT. The first edition ran `USERINFO_RE` first, so a registered secret shaped
   * like `u:p@ss-tail` was mangled into `[REDACTED]:[REDACTED]@ss-tail` before the secret loop
   * ever ran — and `ss-tail` was then no longer part of any registered form, matched nothing, and
   * reached the report. The structural passes destroy the very text the secret loop needs in order
   * to recognise a secret, so they must go last.
   *
   * The assertion is that NO PART survives, not that the whole string is absent: "the whole string
   * is absent" is true of the broken version too, which is how it got through.
   */
  const SECRET_WITH_DELIMITERS = 'u:p@ss-tail'

  it.each(['u:p@ss-tail', 'u:p@ss', 'p@ss-tail', 'ss-tail', 'u:p'])(
    'leaves no trace of the fragment `%s`',
    (fragment) => {
      const out = redactSecrets(`upstream rejected ${SECRET_WITH_DELIMITERS} as a credential`, [
        SECRET_WITH_DELIMITERS,
      ])

      expect(out).not.toContain(fragment)
    },
  )

  it('replaces such a secret with exactly one marker', () => {
    expect(redactSecrets(`key=${SECRET_WITH_DELIMITERS}`, [SECRET_WITH_DELIMITERS])).toBe(
      `key=${REDACTED}`,
    )
  })

  it('leaves no trace of a secret carrying an `@` in a reported URL', () => {
    const report = buildRequestReport(
      {
        ...reportBase,
        url: `https://api.example.com/j?page=1&sig=${encodeURIComponent(SECRET_WITH_DELIMITERS)}`,
      },
      [SECRET_WITH_DELIMITERS],
    )

    expect(report.url).not.toContain('ss-tail')
    expect(report.url).not.toContain(encodeURIComponent('ss-tail'))
  })

  /** The structural pass must still fire on what the secret pass left behind. */
  it('still removes a Basic credential whose base64 prefix a registered secret already matched', () => {
    const out = redactSecrets('Authorization: Basic Ym9iOmh1bnRlcjI=', ['bob', 'hunter2'])

    expect(out).toBe(`Authorization: Basic ${REDACTED}`)
  })
})

describe('every redaction bound is asserted AT and PAST its limit', () => {
  /**
   * THE DEFECT CLASS THIS SECTION EXISTS FOR. Three bounds added while fixing a quadratic regex
   * all failed OPEN, and every one would have been caught by a single over-the-bound case:
   *
   *  - `{4,1024}` on an auth token redacted the first 1024 characters and EMITTED THE TAIL.
   *  - `{1,256}` on userinfo stopped matching a 300-character password entirely, emitting the
   *    whole credential; a 300-character username matched but left its first 44 characters in the
   *    output — a partial leak that reads as success, because the output did change and the full
   *    credential is absent. So these assert on the CONTENT, never merely that something changed.
   *  - `slice(0, bound)` before redaction cut a registered secret in half and emitted the prefix.
   *
   * The rule the tests encode: a bound that cannot be satisfied DROPS the field. Nothing is ever
   * emitted partially redacted.
   */

  describe('an auth-scheme token, at any length', () => {
    it.each([4, 1023, 1024, 1025, 4096])('redacts a %s-character Bearer token whole', (n) => {
      const token = 'a'.repeat(n)
      const out = redactSecrets(`Authorization: Bearer ${token}`, [])

      expect(out).toBe(`Authorization: Bearer ${REDACTED}`)
      expect(out).not.toContain('aa')
    })

    it('leaves no tail of an over-long token', () => {
      const out = redactSecrets(`Bearer ${'z'.repeat(5000)}`, [])

      expect(out).not.toContain('z')
    })

    it('still redacts a token separated by several spaces', () => {
      expect(redactSecrets('Bearer    abcd1234', [])).toBe(`Bearer ${REDACTED}`)
    })
  })

  describe('userinfo, at any length', () => {
    it.each([1, 255, 256, 257, 300, 4096])('redacts a %s-character PASSWORD whole', (n) => {
      // 'Z' cannot occur anywhere else in this URL, so the needle means what it says — unlike a
      // 'p', which `?page=1` supplies for free.
      const password = 'Z'.repeat(n)
      const out = redactUrl(`https://user:${password}@api.example.com/j?page=1`, [])

      // Content, not "it changed": the capped version emitted this credential in FULL.
      expect(out).not.toContain(password)
      expect(out).not.toContain('Z')
      expect(out).toContain('api.example.com')
    })

    it.each([1, 255, 256, 257, 300, 4096])('redacts a %s-character USERNAME whole', (n) => {
      const username = 'Y'.repeat(n)
      const out = redactUrl(`https://${username}:pw@api.example.com/j?page=1`, [])

      // The capped version matched here but kept the username's FIRST characters — the partial
      // leak that passes a "did it change" assertion.
      expect(out).not.toContain('Y')
      expect(out).not.toContain(username)
    })

    /**
     * THE PATH WHERE THE CAP ACTUALLY BIT. A parseable URL is already handled by
     * `URL.username` / `URL.password`, which have no length limit — so a `redactUrl` test cannot
     * tell the capped version from the scan. Free text can: there is no parse, only the structural
     * pass, and that is where a 300-character credential went out verbatim.
     */
    it.each([1, 255, 256, 257, 300, 4096])(
      'redacts a %s-character PASSWORD in free text, where no URL parse helps',
      (n) => {
        const password = 'Q'.repeat(n)
        const out = redactText(`fetch failed for bob:${password}@host/x`, [])

        expect(out).not.toContain('Q')
      },
    )

    it.each([1, 255, 256, 257, 300, 4096])(
      'redacts a %s-character USERNAME in free text, asserting on content',
      (n) => {
        const username = 'W'.repeat(n)
        const out = redactText(`fetch failed for ${username}:pw@host/x`, [])

        // The capped version matched and redacted only the LAST 256 characters, leaving the first
        // ones in the output while the assertion "the whole credential is absent" still held.
        expect(out).not.toContain('W')
      },
    )
  })

  describe('a field past the redaction budget', () => {
    const overBudget = (tail: string) => `${'x'.repeat(MAX_REDACTION_INPUT_CHARS)}${tail}`

    it.each([
      ['free text', (t: string) => redactText(t, ['SECRETTAIL'])],
      ['a registered-secret pass', (t: string) => redactSecrets(t, ['SECRETTAIL'])],
    ])('drops %s rather than emitting a half-redacted version', (_name, redact) => {
      const out = redact(overBudget('SECRETTAIL'))

      expect(out).toBe(DROPPED_TOO_LONG)
      expect(out).not.toContain('xxxx')
    })

    it('drops an over-budget URL', () => {
      const url = `https://api.example.com/j?page=1&pad=${'x'.repeat(MAX_REDACTION_INPUT_CHARS)}`

      expect(redactUrl(url, [])).toBe(DROPPED_TOO_LONG)
    })

    it('still processes a field exactly AT the budget', () => {
      const atBudget = 'x'.repeat(MAX_REDACTION_INPUT_CHARS)

      expect(redactSecrets(atBudget, [])).toBe(atBudget)
    })

    it('never emits a prefix of a secret the bound cut in half', () => {
      // The `slice`-before-redact bypass: the secret straddles the budget, so truncating would
      // leave `SECRET` (matching no registered form) in the output.
      const straddling = `${'x'.repeat(MAX_REDACTION_INPUT_CHARS - 3)}SECRETVALUE`
      const out = redactSecrets(straddling, ['SECRETVALUE'])

      expect(out).toBe(DROPPED_TOO_LONG)
      expect(out).not.toContain('SECRET')
    })
  })
})

describe('the reportable-query allowlist, both halves', () => {
  /**
   * Thirty string literals in `REPORTABLE_QUERY_KEYS` survived mutation: turn `'per_page'` into
   * `''` and nothing failed, because no test named `per_page`. The gate was right — the data was
   * untested. Driving the test off the exported set covers every entry and keeps covering new ones.
   */
  /**
   * WRITTEN OUT INDEPENDENTLY, not derived from `REPORTABLE_QUERY_KEYS`. The first version of this
   * block was `it.each([...REPORTABLE_QUERY_KEYS])`, which is tautological in the exact way the
   * mutation gate exposes: mutating `'per_page'` to `''` does not FAIL the per-key test, it
   * DELETES it — the case list came from the mutated data — so the mutant survived with the suite
   * green. The expected value has to come from somewhere the mutation cannot reach.
   */
  const EXPECTED_REPORTABLE_KEYS = [
    'page',
    'per_page',
    'pagesize',
    'page_size',
    'limit',
    'offset',
    'start',
    'cursor',
    'after',
    'before',
    'q',
    'query',
    'search',
    'keywords',
    'sort',
    'order',
    'direction',
    'from',
    'to',
    'since',
    'until',
    'date',
    'updated_at',
    'location',
    'category',
    'remote',
    'format',
    'lang',
    'locale',
    'version',
    'v',
  ]

  it('is exactly the set this test names, entry for entry', () => {
    expect([...REPORTABLE_QUERY_KEYS].sort()).toEqual([...EXPECTED_REPORTABLE_KEYS].sort())
  })

  it.each(EXPECTED_REPORTABLE_KEYS)('keeps the value of the reportable key `%s`', (key) => {
    const out = redactUrl(`https://api.example.com/j?${key}=keepme7`, [])

    expect(out).toContain(`${key}=keepme7`)
    expect(out).not.toContain(REDACTED)
  })

  it.each(EXPECTED_REPORTABLE_KEYS)('has `%s` lowercased, since lookup lowercases', (key) => {
    expect(key).toBe(key.toLowerCase())
  })

  it.each(['token', 'api_key', 'secret', 'password', 'hmac', 'anything_else'])(
    'redacts the value of `%s`, which is not on the allowlist',
    (key) => {
      const out = redactUrl(`https://api.example.com/j?${key}=keepme7`, [])

      expect(out).not.toContain('keepme7')
      expect(out).toContain(REDACTED)
    },
  )

  it('matches an allowlisted key case-insensitively', () => {
    expect(redactUrl('https://api.example.com/j?PAGE=2', [])).toContain('PAGE=2')
  })
})

describe('the userinfo scan, character by character', () => {
  /**
   * The scan replaced a regex that produced two defects (quadratic, then a cap that leaked). Its
   * own logic is therefore pinned at every branch rather than trusted — and its delimiter set is
   * DATA, asserted against an independently written list, because the seven-way `||` it started as
   * put twenty-six unkillable mutants on one line.
   */

  const EXPECTED_DELIMITERS = [' ', '\t', '\n', '\r', '/', '?', '#']

  it('is exactly the delimiter set this test names', () => {
    expect([...USERINFO_RUN_DELIMITERS].sort()).toEqual([...EXPECTED_DELIMITERS].sort())
  })

  it.each(EXPECTED_DELIMITERS.map((d) => [JSON.stringify(d), d] as const))(
    'treats %s as the end of a run, so the colon before it is not a credential',
    (_label, delim) => {
      // `user:pw` then a delimiter, then a bare `host@tail`: the `@` belongs to a run with no
      // colon in it, so nothing here is userinfo and nothing is redacted.
      const out = redactSecrets(`user:pw${delim}host@tail`, [])

      expect(out).toBe(`user:pw${delim}host@tail`)
    },
  )

  it('redacts when no delimiter breaks the run', () => {
    expect(redactSecrets('user:pw@tail', [])).toBe(`${REDACTED}:${REDACTED}@tail`)
  })

  it('leaves a bare `name@host` alone — that is an email, not a credential', () => {
    expect(redactSecrets('mail bob@example.com now', [])).toBe('mail bob@example.com now')
  })

  it('leaves an `@` with an empty run before it alone', () => {
    expect(redactSecrets('@host', [])).toBe('@host')
  })

  it('redacts a credential that ends the string', () => {
    expect(redactSecrets('u:p@', [])).toBe(`${REDACTED}:${REDACTED}@`)
  })

  it('redacts BOTH credentials in one string, keeping the text between them', () => {
    const out = redactSecrets('first a:b@one and second c:d@two', [])

    expect(out).toBe(`first ${REDACTED}:${REDACTED}@one and second ${REDACTED}:${REDACTED}@two`)
  })

  it('keeps the text before, between and after untouched', () => {
    expect(redactSecrets('GET https://u:p@api.example.com/x?page=1 -> 200', [])).toBe(
      `GET https://${REDACTED}:${REDACTED}@api.example.com/x?page=1 -> 200`,
    )
  })

  it('redacts the whole run when it holds several colons', () => {
    // Wider than the regex was (it matched only the last `x:y@`). Redacting more is the safe
    // direction, and the assertion records that this is intended rather than incidental.
    expect(redactSecrets('a:b:c@tail', [])).toBe(`${REDACTED}:${REDACTED}@tail`)
  })

  it('leaves text with no `@` at all untouched, however many colons it has', () => {
    expect(redactSecrets('a:b:c:d', [])).toBe('a:b:c:d')
  })

  it('leaves an empty string alone', () => {
    expect(redactSecrets('', [])).toBe('')
  })

  it('does not treat a second `@` as reopening the first credential', () => {
    // After an `@` the run restarts, so `b` alone (no colon) is not userinfo.
    expect(redactSecrets('u:p@b@c', [])).toBe(`${REDACTED}:${REDACTED}@b@c`)
  })
})

describe('the URL finder is linear, and timed AT the bound', () => {
  /**
   * FOURTH ROUND OF THE SAME SHAPE, and the first one found by auditing rather than by being told.
   * `\b[a-z][a-z0-9+.-]*:\/\/…` is «class»`*` followed by a literal delimiter, so text with no
   * `://` makes it scan to the end and backtrack per start position. Measured on the regex:
   * 77.9 ms at 16 KB, 305.6 ms at 32 KB, 1 252.1 ms at 64 KB — double the input, quadruple the
   * time. `/[.,;:!?]+$/` was worse: 2 472.4 ms at 64 KB.
   *
   * THE TIMING ASSERTION IS AT `MAX_REDACTION_INPUT_CHARS`, not at a convenient size. That is the
   * point: every one of these four rounds would have been caught by one timing case at the bound,
   * and the bound is the largest input the code will ever process. At this size the replaced
   * regexes take 1 252 ms and 2 472 ms, and the linear scan takes single-digit milliseconds — so
   * the 1 s threshold is 500× clear of the fix and comfortably under both defects.
   */
  /**
   * EACH SHAPE AT THE FULL CAP, in its own case. An earlier edition packed all three into one
   * 64 KiB input to save the mutation gate work; splitting the cap three ways dropped each shape
   * to ~21 KiB, where the quadratic versions finish in well under a second and the assertion stops
   * discriminating. The cap is the largest input the code will ever see, so that is where the
   * guarantee has to be asserted — and the linear passes make each case ~2 ms, so the cost is
   * nominal.
   */
  it.each([
    [
      'scheme-ish characters that never reach `://`',
      () => 'a.'.repeat(MAX_REDACTION_INPUT_CHARS / 2),
    ],
    [
      'a URL with a huge interior punctuation run',
      () => {
        const head = 'https://api.example.com/'
        return `${head}${'.'.repeat(MAX_REDACTION_INPUT_CHARS - head.length - 1)}x`
      },
    ],
    ['a colon with no `@` after it', () => `a:${'b'.repeat(MAX_REDACTION_INPUT_CHARS - 2)}`],
  ])('redacts %s at the cap in milliseconds', (_name, make) => {
    const text = make()
    expect(text.length).toBeLessThanOrEqual(MAX_REDACTION_INPUT_CHARS)

    const started = Date.now()
    redactText(text, ['irrelevant'])

    // The replaced regexes needed 1 876 ms, 4 655 ms and ~11 s on inputs of this size; the linear
    // passes need single-digit milliseconds, so 1 s is clear of both by a wide margin.
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  it('finds a URL at the cap in milliseconds, not only a non-URL', () => {
    const url = `https://api.example.com/j?page=1&pad=${'z'.repeat(1000)}`
    const text = `${'word '.repeat(2000)}${url} ${'tail '.repeat(2000)}`
    const started = Date.now()
    const out = redactText(text, [])

    expect(Date.now() - started).toBeLessThan(1_000)
    expect(out).toContain('page=1')
  })
})

describe('finding a URL inside free text', () => {
  it('redacts a credential in a URL embedded in a sentence', () => {
    const out = redactText(
      'upstream failed: GET https://api.example.com/j?token=abc123 gave 500',
      [],
    )

    expect(out).not.toContain('abc123')
    expect(out).toContain('upstream failed: GET ')
    expect(out).toContain(' gave 500')
  })

  /** Written out here, NOT read from `URL_END_CHARS`: a case list derived from the data under test
   *  disappears when the data is mutated instead of failing. */
  const EXPECTED_URL_END_CHARS = [' ', '\t', '\n', '\r', '"', "'", '<', '>', '\\', ')', ']', '}']
  const EXPECTED_URL_TRAILING_PUNCTUATION = ['.', ',', ';', ':', '!', '?']

  it('ends URLs at exactly the characters this test names', () => {
    expect([...URL_END_CHARS].sort()).toEqual([...EXPECTED_URL_END_CHARS].sort())
  })

  it('trims exactly the trailing punctuation this test names', () => {
    expect([...URL_TRAILING_PUNCTUATION].sort()).toEqual(
      [...EXPECTED_URL_TRAILING_PUNCTUATION].sort(),
    )
  })

  it.each(EXPECTED_URL_END_CHARS.map((c) => [JSON.stringify(c), c] as const))(
    'ends a URL at %s, leaving the character itself in place',
    (_label, delim) => {
      const out = redactText(`see https://api.example.com/j?token=abc123${delim}then`, [])

      expect(out).not.toContain('abc123')
      expect(out).toContain(`${delim}then`)
    },
  )

  it.each(EXPECTED_URL_TRAILING_PUNCTUATION.map((c) => [JSON.stringify(c), c] as const))(
    'does not swallow a trailing %s into the URL',
    (_label, punct) => {
      // A NON-allowlisted key, deliberately. With `page=1.` the value is reportable either way, so
      // the assertion could not tell trimming from not trimming. With `token=t1.` the untrimmed
      // span swallows the `.` into the redacted VALUE and it vanishes from the output — so the
      // punctuation surviving outside the URL is the trim, observed.
      const out = redactText(`see https://api.example.com/j?token=t1${punct} next`, [])

      expect(out).toBe(`see https://api.example.com/j?token=${REDACTED}${punct} next`)
    },
  )

  it.each([
    ['https', 'https://api.example.com/j?token=t1'],
    ['a scheme with a digit', 's3://bucket/key?token=t1'],
    ['a scheme with a plus', 'grpc+proto://host/x?token=t1'],
    ['a scheme with a dot', 'x.y://host/p?token=t1'],
    ['a scheme with a hyphen', 'my-scheme://host/p?token=t1'],
    ['an uppercase scheme', 'HTTPS://api.example.com/j?token=t1'],
  ])('finds a URL whose scheme is %s', (_name, url) => {
    expect(redactText(`before ${url} after`, [])).not.toContain('t1')
  })

  it('does not treat a scheme starting with a digit as a URL', () => {
    // `1a://` — the old regex required a leading letter and so does the scan. The text is left
    // alone rather than being parsed as a URL.
    const out = redactText('1a://host/x', [])

    expect(out).toContain('1a://host/x')
  })

  it('redacts BOTH URLs in one message, keeping the text between them', () => {
    const out = redactText(
      'a https://x.example.com/?token=t1 b https://y.example.com/?key=t2 c',
      [],
    )

    expect(out).not.toContain('t1')
    expect(out).not.toContain('t2')
    expect(out).toContain(' b ')
    expect(out).toContain(' c')
  })

  it('leaves a bare `://` with no scheme letters alone', () => {
    expect(redactText('weird ://host/x end', [])).toContain('://host/x')
  })

  it('walks back no further than a plausible scheme, on both sides of the bound', () => {
    /**
     * A long run of scheme characters running into `://` is genuinely ambiguous — `QQQhttps` is a
     * syntactically valid scheme — so `MAX_SCHEME_CHARS` caps what gets absorbed rather than
     * resolving it.
     *
     * THE RUN IS UPPERCASE for a reason: a substring assertion cannot see the split at all,
     * because the absorbed prefix and the plain prefix are the same character and concatenating
     * them hides the boundary. `URL` serialisation LOWERCASES the scheme, so the absorbed part
     * comes back lowercased and the boundary becomes visible — exactly `MAX_SCHEME_CHARS`
     * characters of scheme, no more. Unbounded, all 100 would be absorbed and all 100 lowercased.
     */
    const run = 100
    const absorbed = MAX_SCHEME_CHARS - 'https'.length
    const out = redactText(`${'Q'.repeat(run)}https://api.example.com/j?token=abc123`, [])

    expect(out).not.toContain('abc123')
    expect(out.startsWith(`${'Q'.repeat(run - absorbed)}${'q'.repeat(absorbed)}https://`)).toBe(
      true,
    )
  })
})

describe('the userinfo scan and URL finder, branch by branch', () => {
  /**
   * The gate named each of these branches: an `@` with no colon, an `@` at the very start of a
   * run, the slice bookkeeping that copies the text between credentials, and the `://` skip when
   * no scheme letter precedes it. Each one decides whether a credential is found, so each gets an
   * input rather than a suppression.
   */

  it('keeps the text between two credentials exactly, not just their markers', () => {
    // Pins the `slice(copiedTo, runStart)` bookkeeping: a wrong index here silently drops or
    // duplicates the text around a redaction.
    expect(redactSecrets('L a:b@M c:d@R', [])).toBe(
      `L ${REDACTED}:${REDACTED}@M ${REDACTED}:${REDACTED}@R`,
    )
  })

  it('redacts a credential at the very start of the text', () => {
    expect(redactSecrets('a:b@rest', [])).toBe(`${REDACTED}:${REDACTED}@rest`)
  })

  /**
   * ADJACENT credentials, with nothing between them. This is what pins `runStart = i + 1`: with
   * `i - 1` the next run begins before the at-sign instead of after it, so the slice that copies
   * the text between the two redactions runs backwards and silently drops the separator. A
   * credential comfortably in the middle of a sentence distinguishes nothing here — the mutant
   * only shows where one run ends exactly where the next begins.
   */
  it('redacts two credentials with nothing between them, keeping both at-signs', () => {
    expect(redactSecrets('a:b@c:d@e', [])).toBe(`${REDACTED}:${REDACTED}@${REDACTED}:${REDACTED}@e`)
  })

  it('redacts a credential immediately after a delimiter', () => {
    expect(redactSecrets('x/a:b@e', [])).toBe(`x/${REDACTED}:${REDACTED}@e`)
  })

  it('leaves a colon-free run before an `@` alone, however long', () => {
    expect(redactSecrets(`${'n'.repeat(500)}@host`, [])).toBe(`${'n'.repeat(500)}@host`)
  })

  it('starts a fresh run after each `@`, so a later colon does not revive the earlier one', () => {
    expect(redactSecrets('nocolon@then x:y@z', [])).toBe(`nocolon@then ${REDACTED}:${REDACTED}@z`)
  })

  it('finds a second URL after the first one ended', () => {
    const out = redactText('https://a.example.com/?k=1 https://b.example.com/?k=2', [])

    expect(out).toBe(`https://a.example.com/?k=${REDACTED} https://b.example.com/?k=${REDACTED}`)
  })

  it('does not rescan the text a URL already covered', () => {
    // Two `://` inside one span: the second must not start a second span. Asserted as the WHOLE
    // string — counting markers passed even when the scan restarted inside the first span, because
    // the re-found URL had no query to redact.
    const out = redactText('https://a.example.com/x?u=https://b.example.com/y', [])

    expect(out).toBe(`https://a.example.com/x?u=${REDACTED}`)
  })

  it('leaves a `://` with no scheme letter at all as plain text', () => {
    expect(redactText('x ://host/p?token=t1 y', [])).toContain('://host/p?token=t1')
  })

  it('trims only the trailing punctuation, not punctuation inside the URL', () => {
    const out = redactText('see https://api.example.com/a.b.c?page=1.. end', [])

    expect(out).toContain('a.b.c')
    expect(out).toContain('page=1.. end')
  })

  it('reports a URL that is the whole text', () => {
    expect(redactText('https://api.example.com/j?token=t1', [])).toBe(
      `https://api.example.com/j?token=${REDACTED}`,
    )
  })
})

describe('every encoded form of a secret is generated', () => {
  /**
   * `secretForms` is a list of encodings; each `forms.add(...)` line is a mutant that only an
   * input in THAT encoding can kill. The hostile secret below differs in every one of them, which
   * is what makes the cases distinguishable at all — an alphanumeric secret has one form.
   */
  const SECRET = 'ab/cd+ef=gh&ij k'

  it('produces a different string in each encoding, or the cases below prove nothing', () => {
    const forms = new Set([
      SECRET,
      encodeURIComponent(SECRET),
      encodeURI(SECRET),
      new URLSearchParams([['v', SECRET]]).toString().slice('v='.length),
      Buffer.from(SECRET, 'utf8').toString('base64'),
      Buffer.from(SECRET, 'utf8').toString('base64url'),
    ])

    expect(forms.size).toBe(6)
  })

  it('ignores a secret whose every form is one character or shorter', () => {
    // The `length > 1` filter: a single character would redact the whole report and say nothing.
    expect(redactSecrets('https://a.example.com/x', ['a'])).toBe('https://a.example.com/x')
  })

  it('redacts a two-character secret, which is just inside the filter', () => {
    expect(redactSecrets('q=ab', ['ab'])).toBe(`q=${REDACTED}`)
  })
})

describe('redactUrl, branch by branch', () => {
  /**
   * The gate named each branch below. They decide whether a credential reaches a report, so each
   * gets an input: the userinfo-present check, the fragment strip, the marker re-decoding, and the
   * two markers themselves.
   */

  it('passes a URL with no userinfo through untouched', () => {
    // The other side of `username !== '' || password !== ''`: entering that branch for a URL with
    // no userinfo must change nothing.
    expect(redactUrl('https://api.example.com/j?page=1', [])).toBe(
      'https://api.example.com/j?page=1',
    )
  })

  it('strips a username with no password', () => {
    const out = redactUrl('https://onlyuser@api.example.com/j?page=1', [])

    expect(out).not.toContain('onlyuser')
    expect(out).toContain('page=1')
  })

  it('strips a password with no username', () => {
    const out = redactUrl('https://:onlypass@api.example.com/j?page=1', [])

    expect(out).not.toContain('onlypass')
  })

  it('keeps a URL that has no fragment unchanged by the fragment strip', () => {
    expect(redactUrl('https://api.example.com/j?page=2', [])).toBe(
      'https://api.example.com/j?page=2',
    )
  })

  it('drops a fragment even when it looks harmless', () => {
    expect(redactUrl('https://api.example.com/j?page=2#section', [])).toBe(
      'https://api.example.com/j?page=2',
    )
  })

  it('reports the marker in readable form, not percent-encoded', () => {
    // `searchParams.set` encodes the brackets; the re-decoding is what makes a report legible.
    const out = redactUrl('https://api.example.com/j?token=t1', [])

    expect(out).toBe(`https://api.example.com/j?token=${REDACTED}`)
    expect(out).not.toContain('%5B')
  })

  it('names an unparsable URL as such, distinctly from an over-long one', () => {
    expect(redactUrl('not a url at all', [])).toBe(`${REDACTED} (unparsable url)`)
    expect(redactUrl(`https://a.example.com/?p=${'x'.repeat(MAX_REDACTION_INPUT_CHARS)}`, [])).toBe(
      DROPPED_TOO_LONG,
    )
  })

  it('states both markers in the text a reader of a report would see', () => {
    expect(DROPPED_TOO_LONG).toBe('[REDACTED] (field dropped: too long to redact)')
  })

  it('redacts every non-allowlisted key when a URL carries several', () => {
    const out = redactUrl('https://api.example.com/j?page=1&token=t1&key=k1&sort=date', [])

    expect(out).not.toContain('t1')
    expect(out).not.toContain('k1')
    expect(out).toContain('page=1')
    expect(out).toContain('sort=date')
  })

  it('redacts a repeated non-allowlisted key', () => {
    const out = redactUrl('https://api.example.com/j?token=t1&token=t2', [])

    expect(out).not.toContain('t1')
    expect(out).not.toContain('t2')
  })

  it('leaves a URL with no query string alone', () => {
    expect(redactUrl('https://api.example.com/jobs', [])).toBe('https://api.example.com/jobs')
  })
})

describe('the request-report brand is installed the same way as the batch brand', () => {
  it('recognises a built report and not a literal', () => {
    const report = buildRequestReport(
      {
        attempt: 1,
        page: 1,
        url: 'https://api.example.com/j',
        status: 200,
        startedAt: new Date('2026-10-20T10:00:00Z'),
        endedAt: new Date('2026-10-20T10:00:01Z'),
        cost: null,
        error: null,
      },
      [],
    )

    // The brand must be present (so the type's runtime half is real) and non-enumerable (so it
    // never reaches a database row) — both halves, since either alone passes trivially.
    expect(Object.getOwnPropertySymbols(report)).toHaveLength(1)
    expect(Object.keys(report)).toEqual([
      'attempt',
      'page',
      'url',
      'status',
      'startedAt',
      'endedAt',
      'error',
      'cost',
    ])
    expect(JSON.parse(JSON.stringify(report))).not.toHaveProperty('requestReportBuilt')
  })
})

describe('each redaction bound, at the exact character of its limit', () => {
  /**
   * The gate named `url.length > MAX` → `>=` and `text.length > MAX` → `>=` as surviving: a field
   * of EXACTLY the cap must be processed, not dropped. One-sided again — the drop cases above
   * prove over-the-cap behaviour and say nothing about the limit itself.
   */
  it('processes a URL of exactly the cap', () => {
    const head = 'https://api.example.com/j?page=1&pad='
    const url = `${head}${'x'.repeat(MAX_REDACTION_INPUT_CHARS - head.length)}`
    expect(url.length).toBe(MAX_REDACTION_INPUT_CHARS)

    const out = redactUrl(url, [])

    expect(out).not.toBe(DROPPED_TOO_LONG)
    expect(out).toContain('page=1')
  })

  it('drops a URL one character over the cap', () => {
    const head = 'https://api.example.com/j?page=1&pad='
    const url = `${head}${'x'.repeat(MAX_REDACTION_INPUT_CHARS - head.length + 1)}`
    expect(url.length).toBe(MAX_REDACTION_INPUT_CHARS + 1)

    expect(redactUrl(url, [])).toBe(DROPPED_TOO_LONG)
  })

  it('processes free text of exactly the cap', () => {
    const text = `hello ${'y'.repeat(MAX_REDACTION_INPUT_CHARS - 6)}`
    expect(text.length).toBe(MAX_REDACTION_INPUT_CHARS)

    expect(redactText(text, [])).toBe(text)
  })

  /**
   * `redactText`'s OWN guard, not the one inside `redactSecrets` it delegates to. For most inputs
   * the two are indistinguishable — over-budget text reaches `redactSecrets`, which drops it
   * anyway. The case that separates them is text that SHRINKS below the cap while its URLs are
   * redacted: without `redactText`'s guard the shrunken text sails through, and an over-budget
   * field is reported after all.
   */
  it('drops over-budget text even when redacting its URLs would shrink it under the cap', () => {
    const pad = 'z'.repeat(MAX_REDACTION_INPUT_CHARS)
    // The PREFIX is what makes this distinguishable. Without it the shrunken text happens to equal
    // `DROPPED_TOO_LONG` anyway — the over-long URL becomes that very marker — so the assertion
    // held whether or not `redactText` had a guard of its own. With a prefix, the unguarded path
    // reports `before [REDACTED] (field dropped…)` and the guarded one reports the marker alone.
    const text = `before https://api.example.com/j?token=${pad}`
    expect(text.length).toBeGreaterThan(MAX_REDACTION_INPUT_CHARS)

    expect(redactText(text, [])).toBe(DROPPED_TOO_LONG)
  })
})

describe('redactUrl`s userinfo strip is load-bearing on its own', () => {
  /**
   * The gate named the `username !== '' || password !== ''` branch as surviving in both
   * directions. The reason the obvious tests do not reach it: `redactSecrets` runs afterwards and
   * its `user:pass@` scan catches the COLON form regardless. The cases below are the ones only the
   * URL-level strip can handle, asserted on the whole output string so there is nothing to slip
   * through.
   */
  it('removes a username-only credential, which the `user:pass@` scan cannot see', () => {
    expect(redactUrl('https://tok3n@api.example.com/j?page=1', [])).toBe(
      'https://api.example.com/j?page=1',
    )
  })

  it('removes a password-only credential', () => {
    expect(redactUrl('https://:pw0rd@api.example.com/j?page=1', [])).toBe(
      'https://api.example.com/j?page=1',
    )
  })

  it('removes both halves at once', () => {
    expect(redactUrl('https://u:pw@api.example.com/j?page=1', [])).toBe(
      'https://api.example.com/j?page=1',
    )
  })

  it('leaves a URL without userinfo byte-identical', () => {
    expect(redactUrl('https://api.example.com/j?page=1', [])).toBe(
      'https://api.example.com/j?page=1',
    )
  })

  it('redacts every non-allowlisted key and no allowlisted one, in one URL', () => {
    // Both directions of the allowlist condition in one assertion on the whole string.
    expect(redactUrl('https://api.example.com/j?page=1&token=t1', [])).toBe(
      `https://api.example.com/j?page=1&token=${REDACTED}`,
    )
  })
})

describe('the URL finder`s walks, at their boundaries', () => {
  it('skips leading characters that cannot begin a scheme', () => {
    // `+x://` — the walk back covers `+x`, and the forward trim drops the `+` because a scheme
    // must begin with a letter. Without the trim the span starts at `+` and no longer parses.
    const out = redactText('ref +x://host/p?token=t1 end', [])

    expect(out).not.toContain('t1')
    expect(out).toContain('ref +')
    expect(out).not.toContain('(unparsable url)')
  })

  it('refuses a separator with no host rather than reporting it', () => {
    // `new URL('https://')` throws — there is no host — so the span becomes the unparsable
    // marker. Fail-closed is the right answer here: a string we cannot parse is exactly where a
    // credential would hide from the structural pass.
    expect(redactText('bare https:// end', [])).toBe(`bare ${REDACTED} (unparsable url) end`)
  })

  it('keeps a URL that ends exactly at the end of the text', () => {
    expect(redactText('go https://api.example.com/j?page=9', [])).toBe(
      'go https://api.example.com/j?page=9',
    )
  })

  it('trims a punctuation run back to the separator without looping', () => {
    // Every character after `://` is trailing punctuation, so the trim walks back to `end === sep
    // + 3`; the `end > sep` guard and the `Math.max` on `from` are what stop this from stalling.
    const out = redactText('a x://... b https://api.example.com/j?token=t1 c', [])

    expect(out).not.toContain('t1')
    expect(out).toContain(' c')
  })

  it('still finds a later URL after one whose body was entirely trimmed', () => {
    const out = redactText('x://.. https://api.example.com/j?token=t2', [])

    expect(out).not.toContain('t2')
  })
})

describe('the secret-form encodings are each generated', () => {
  const SECRET = 'ab/cd+ef=gh&ij k'

  it.each([
    [
      'the URLSearchParams form',
      new URLSearchParams([['v', SECRET]]).toString().slice('v='.length),
    ],
    ['the base64 form', Buffer.from(SECRET, 'utf8').toString('base64')],
    ['the base64url form', Buffer.from(SECRET, 'utf8').toString('base64url')],
  ])('redacts %s with nothing else in the text to help', (_name, form) => {
    // Deliberately bare: no `@`, no auth scheme, no URL — so ONLY the registered-form match can
    // remove it, and a missing form in `secretForms` is the difference.
    const out = redactSecrets(`k=${form}`, [SECRET])

    expect(out).toBe(`k=${REDACTED}`)
  })

  it('generates the URLSearchParams form without its `v=` prefix', () => {
    // Pins the `slice('v='.length)`: a wrong slice leaves `v=` glued to the form, which then
    // matches nothing.
    const out = redactSecrets(`k=${new URLSearchParams([['v', SECRET]]).toString().slice(2)}`, [
      SECRET,
    ])

    expect(out).toBe(`k=${REDACTED}`)
    expect(out).not.toContain('v=')
  })
})

describe('the request-report brand carries the value `true`', () => {
  it('installs the brand as a non-enumerable `true`, not merely as a key', () => {
    const report = buildRequestReport(
      {
        attempt: 1,
        page: 1,
        url: 'https://api.example.com/j',
        status: 200,
        startedAt: new Date('2026-10-20T10:00:00Z'),
        endedAt: new Date('2026-10-20T10:00:01Z'),
        cost: null,
        error: null,
      },
      [],
    )

    const [brand] = Object.getOwnPropertySymbols(report)
    expect(brand).toBeDefined()

    const descriptor =
      brand === undefined ? undefined : Object.getOwnPropertyDescriptor(report, brand)

    // The VALUE, not just the symbol's presence: `{}` and `{ value: false }` both leave a symbol
    // in place, so asserting the key exists cannot tell a real brand from an empty one.
    expect(descriptor?.value).toBe(true)
    expect(descriptor?.enumerable).toBe(false)
  })
})
