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
  MAX_REQUEST_REPORTS,
  MAX_SAMPLE_CHARS,
  MAX_SAMPLES,
  assertBuiltBatch,
  redactSecrets,
  redactText,
  redactUrl,
  REDACTED,
  type SourceCoverageScope,
  type StopReason,
  toStoredReportCounts,
  UnbuiltBatchError,
  type ValidatedCheckpoint,
  validatedCheckpointSchema,
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
    counts: { raw: 5, normalized: 0, invalid: 0, quarantined: 0 },
    checkpoint: null,
    invalidSamples: [],
  }

  it('tells an adapter-made literal apart from a built batch', () => {
    const built = buildCollectionBatch({
      observations: [],
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

  it('refuses an adapter-made literal at the collector boundary', () => {
    expect(() => assertBuiltBatch(adapterLiteral)).toThrow(UnbuiltBatchError)
  })

  it.each([[null], [undefined], ['a batch'], [42], [[]]])(
    'does not recognise %s as a batch',
    (value) => {
      expect(isBuiltBatch(value)).toBe(false)
    },
  )

  it('recognises a batch that went through the builder', () => {
    const batch = buildCollectionBatch({
      observations: [],
      facts: facts(),
      requests: [],
      checkpoint: null,
      invalidSamples: [],
    })

    expect(isBuiltBatch(batch)).toBe(true)
    expect(() => assertBuiltBatch(batch)).not.toThrow()
  })

  /** The brand must never reach a database row or a log line — the reason it is non-enumerable. */
  it('keeps the brand out of JSON, keys and spreads', () => {
    const batch = buildCollectionBatch({
      observations: [],
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
  const atTheCap = 'a.'.repeat(MAX_REDACTION_INPUT_CHARS / 2)
  const punctuationAtTheCap = `${'.'.repeat(MAX_REDACTION_INPUT_CHARS - 1)}x`

  it.each([
    ['scheme-ish characters with no `://`', () => atTheCap],
    ['nothing but trailing punctuation', () => punctuationAtTheCap],
    ['a colon with no `@`', () => `a:${'b'.repeat(MAX_REDACTION_INPUT_CHARS - 2)}`],
    [
      // Reaches the trailing-punctuation trim, which only ever ran on an already-matched URL: a
      // huge run of dots INSIDE the match, followed by a non-punctuation character so that every
      // start position in the run fails the end anchor. That is the input the old `/[.,;:!?]+$/`
      // needed, and plain punctuation never reached it.
      'a URL with a huge interior punctuation run',
      () => {
        const head = 'https://api.example.com/'
        const dots = '.'.repeat(MAX_REDACTION_INPUT_CHARS - head.length - 1)
        return `${head}${dots}x`
      },
    ],
  ])('redacts %s at the cap in milliseconds', (_name, make) => {
    const text = make()
    expect(text.length).toBeLessThanOrEqual(MAX_REDACTION_INPUT_CHARS)

    const started = Date.now()
    redactText(text, ['irrelevant'])

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
      const out = redactText(`see https://api.example.com/j?page=1${punct} next`, [])

      expect(out).toContain(`page=1${punct} next`)
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
    // Two `://` inside one span: the second must not start a second span.
    const out = redactText('https://a.example.com/x?u=https://b.example.com/y', [])

    expect(out.match(/REDACTED/g) ?? []).toHaveLength(1)
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
