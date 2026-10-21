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
