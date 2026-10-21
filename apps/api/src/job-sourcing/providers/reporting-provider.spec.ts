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
  isValidatedConfig,
  markValidated,
  MAX_REQUEST_REPORTS,
  MAX_SAMPLE_CHARS,
  MAX_SAMPLES,
  redactSecrets,
  REDACTED,
  type SourceCoverageScope,
  type StopReason,
  toStoredReportCounts,
  type ValidatedCheckpoint,
} from './reporting-provider'

/**
 * The reporting contract's behaviour. Everything here is a pure function, so the test goes
 * straight through the interface the 25 phase-3 adapters will use — no fake subclass, nothing
 * reached from behind the seam.
 *
 * Every boundary below is asserted on BOTH sides (the value AT the limit accepted, the one past it
 * refused): task 2.1 shipped a correct cap whose test could not tell `>` from `>=`.
 */

const clean: CollectionCounts = { raw: 10, normalized: 10, invalid: 0, quarantined: 0 }

function scope(overrides: Partial<SourceCoverageScope> = {}): SourceCoverageScope {
  return { namespace: 'board', query: null, configVersion: 1, window: null, ...overrides }
}

function facts(overrides: Partial<DerivationFacts> = {}): DerivationFacts {
  return { stop: 'EXHAUSTED', pagesCompleted: 3, counts: clean, scope: scope(), ...overrides }
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
})

/** Every error class names itself, so a log line and an `instanceof`-free check both identify it. */
describe('the error names', () => {
  it('names CountsImbalanceError', () => {
    expect(() =>
      assertCountsBalanced({ raw: 1, normalized: 0, invalid: 0, quarantined: 0 }),
    ).toThrow(expect.objectContaining({ name: 'CountsImbalanceError' }))
  })

  it('names BatchInvariantError', () => {
    expect(() =>
      assertBatchInvariant({ outcome: 'FAILED', coverage: 'FULL_INVENTORY', counts: clean }),
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
    const empty: CollectionCounts = { raw: 0, normalized: 0, invalid: 0, quarantined: 0 }
    expect(deriveOutcome(facts({ counts: empty, pagesCompleted: 1 }))).toBe('SUCCEEDED')
  })
})

describe('deriveCoverage', () => {
  it('claims FULL_INVENTORY only for an exhausted, clean, unqueried, unwindowed scope', () => {
    expect(deriveCoverage(facts())).toBe('FULL_INVENTORY')
  })

  it('drops to PARTIAL when even one item could not be observed', () => {
    expect(
      deriveCoverage(facts({ counts: { raw: 10, normalized: 9, invalid: 1, quarantined: 0 } })),
    ).toBe('PARTIAL')
    expect(
      deriveCoverage(facts({ counts: { raw: 10, normalized: 9, invalid: 0, quarantined: 1 } })),
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
    { raw: 0, normalized: 0, invalid: 0, quarantined: 0 },
    { raw: 4, normalized: 2, invalid: 1, quarantined: 1 },
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
      assertBatchInvariant({ outcome: 'FAILED', coverage: 'FULL_INVENTORY', counts: clean }),
    ).toThrow(/cannot claim FULL_INVENTORY/)
  })

  it('refuses a hand-made CANCELLED batch that claims FULL_INVENTORY', () => {
    expect(() =>
      assertBatchInvariant({ outcome: 'CANCELLED', coverage: 'FULL_INVENTORY', counts: clean }),
    ).toThrow(/cannot claim FULL_INVENTORY/)
  })

  it('accepts the one outcome that may claim FULL_INVENTORY', () => {
    expect(() =>
      assertBatchInvariant({ outcome: 'SUCCEEDED', coverage: 'FULL_INVENTORY', counts: clean }),
    ).not.toThrow()
  })

  it('accepts a FAILED batch that makes no coverage claim', () => {
    expect(() =>
      assertBatchInvariant({ outcome: 'FAILED', coverage: 'PARTIAL', counts: clean }),
    ).not.toThrow()
  })
})

describe('assertCountsBalanced', () => {
  it('accepts counts whose dispositions account for exactly every raw item', () => {
    expect(() =>
      assertCountsBalanced({ raw: 7, normalized: 4, invalid: 2, quarantined: 1 }),
    ).not.toThrow()
  })

  it('refuses one disposition too few', () => {
    expect(() =>
      assertCountsBalanced({ raw: 7, normalized: 4, invalid: 2, quarantined: 0 }),
    ).toThrow(/do not balance/)
  })

  it('refuses one disposition too many', () => {
    expect(() =>
      assertCountsBalanced({ raw: 7, normalized: 5, invalid: 2, quarantined: 1 }),
    ).toThrow(/do not balance/)
  })
})

describe('toStoredReportCounts', () => {
  it('maps raw to received and folds BOTH refusal buckets into the store`s single invalid', () => {
    expect(toStoredReportCounts({ raw: 10, normalized: 6, invalid: 3, quarantined: 1 })).toEqual({
      received: 10,
      invalid: 4,
      normalized: 6,
    })
  })

  it('refuses to project counts that do not balance, rather than emitting a report that cannot', () => {
    expect(() =>
      toStoredReportCounts({ raw: 10, normalized: 6, invalid: 3, quarantined: 0 }),
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
    cursor: 'c-7',
    page: 7,
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
    cursor: null,
    page: 2,
    completedAt: new Date('2026-10-20T10:00:00Z'),
  }

  function build(overrides: Partial<Parameters<typeof buildCollectionBatch>[0]> = {}) {
    return buildCollectionBatch({
      observations: [],
      facts: facts(),
      requests: [],
      checkpoint,
      invalidSamples: [],
      ...overrides,
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
      build({ facts: facts({ counts: { raw: 3, normalized: 1, invalid: 0, quarantined: 0 } }) }),
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
