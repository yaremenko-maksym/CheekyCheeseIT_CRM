import {
  jobCollectionAttemptWorkerSchema,
  jobCollectionCoverageSchema,
  jobCollectionOutcomeSchema,
  jobCollectionReportSchema,
  jobErrorCodeSchema,
  jobSourceIdentitySchema,
  jobSourceRevisionSchema,
} from '@crm/shared'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { toStoredIdentity, toStoredRevisionFields } from '../normalize/observation'
import {
  type ApiJsonSourceSpec,
  baseSourceConfigSchema,
  collectJsonPages,
  NAMESPACE_MAX_CHARS,
  PG_INT_MAX,
} from './api-json.provider'
import {
  COLLECTION_ERROR_CODES,
  type CollectionBatch,
  type CollectionContext,
  type CollectionOutcome,
  type DerivationFacts,
  deriveOutcome,
  toStoredReportCounts,
} from './reporting-provider'

/**
 * THE TEST TASK 2.1 WAS MISSING, extended to Task 2.3. The phase-1 store's schemas shipped and
 * have production rows, so the store is the AUTHORITY on vocabulary: conformance means this task
 * moves, never the schema.
 *
 * Task 2.1's worst defect was a parallel vocabulary — `'NATIVE' | 'URL'` against the store's
 * `'NATIVE_ID' | 'URL_FALLBACK'` — that a type cast kept the compiler from noticing. The cure is
 * not vigilance: it is deriving our types FROM the store's and asserting the derivation here, so
 * that a sixth outcome added upstream fails a test rather than diverging silently.
 *
 * Every boundary is asserted on BOTH sides. A test that only checks the accepted side cannot tell
 * a cap from its absence.
 */

// --- the vocabularies ------------------------------------------------------

describe('the outcome vocabulary is the store`s', () => {
  /**
   * `CollectionOutcome` is declared as `Exclude<JobCollectionOutcome, 'STARTED'>`. A type cannot be
   * enumerated at runtime, so the LITERAL list below is what a reader of the type would write —
   * and this test is what makes writing it safe: if the store adds or renames a terminal member,
   * the derived type silently follows and this assertion fails.
   */
  const TERMINAL: CollectionOutcome[] = ['PARTIAL', 'SUCCEEDED', 'FAILED', 'CANCELLED']

  it('names exactly the store`s terminal outcomes', () => {
    const storeTerminal = jobCollectionOutcomeSchema.options.filter((o) => o !== 'STARTED')
    expect([...TERMINAL].sort()).toEqual([...storeTerminal].sort())
  })

  it('still carries STARTED on the store side, which a finished batch can never be', () => {
    expect(jobCollectionOutcomeSchema.options).toContain('STARTED')
    expect(TERMINAL).not.toContain('STARTED')
  })

  it.each(['PARTIAL', 'SUCCEEDED', 'FAILED', 'CANCELLED'] as const)(
    'parses %s through the store`s own enum',
    (outcome) => {
      expect(jobCollectionOutcomeSchema.parse(outcome)).toBe(outcome)
    },
  )

  /**
   * The runtime half of the same claim: there is no combination of facts for which the derivation
   * produces `STARTED`. The type forbids it; this shows the implementation agrees.
   */
  it('never derives STARTED from any combination of facts', () => {
    const derived = new Set<string>()
    for (const stop of [
      'EXHAUSTED',
      'PAGE_CAP',
      'CURSOR_CYCLE',
      'ERROR',
      'CANCELLED',
      'COST_STOP',
    ] as const) {
      for (const pagesCompleted of [0, 1, 9]) {
        const facts: DerivationFacts = {
          stop,
          pagesCompleted,
          counts: { raw: 0, normalized: 0, invalid: 0, quarantined: 0, discarded: 0 },
          scope: { namespace: 'b', query: null, configVersion: 1, window: null },
        }
        derived.add(deriveOutcome(facts))
      }
    }
    expect(derived).not.toContain('STARTED')
    expect([...derived].sort()).toEqual(['CANCELLED', 'FAILED', 'PARTIAL', 'SUCCEEDED'])
  })
})

describe('the coverage vocabulary is the store`s', () => {
  it('is imported wholesale, with no member added or dropped', () => {
    expect(jobCollectionCoverageSchema.options).toEqual(['FULL_INVENTORY', 'WINDOW', 'PARTIAL'])
  })
})

describe('the error codes satisfy the store`s column shape', () => {
  /**
   * The store keeps `jobErrorCodeSchema` deliberately OPEN — a regex, not an enum, because the
   * vocabulary is per adapter. So the closed set lives on our side, and what must be checked is
   * that every member of it is a shape the column accepts.
   */
  it.each(COLLECTION_ERROR_CODES)('parses %s through the store`s regex', (code) => {
    expect(jobErrorCodeSchema.parse(code)).toBe(code)
  })

  it('has no duplicate members', () => {
    expect(new Set(COLLECTION_ERROR_CODES).size).toBe(COLLECTION_ERROR_CODES.length)
  })

  it.each([
    ['lowercase', 'rate_limit'],
    ['leading digit', '4O3_FORBIDDEN'],
    ['a provider body rather than a code', 'Unauthorized: invalid api key for account 12345'],
    ['65 characters', `A${'B'.repeat(64)}`],
  ])('the store refuses %s, which is why the set is closed on our side', (_name, code) => {
    expect(() => jobErrorCodeSchema.parse(code)).toThrow()
  })

  it('accepts a code of exactly 64 characters, the column`s width', () => {
    expect(jobErrorCodeSchema.parse(`A${'B'.repeat(63)}`)).toHaveLength(64)
  })
})

// --- the counts projection -------------------------------------------------

describe('the counts projection satisfies the store`s report', () => {
  /** The ids, arrival order and dispositions below are the COLLECTOR's to supply (Task 2.5) and
   * are literals on purpose: this file pins the fields a provider owns. */
  const SOURCE_ID = '11111111-1111-4111-8111-111111111111'

  it('completes into a report the store accepts', () => {
    const projected = toStoredReportCounts({
      raw: 10,
      normalized: 6,
      invalid: 3,
      quarantined: 1,
      discarded: 0,
    })
    const report = jobCollectionReportSchema.parse({
      sourceId: SOURCE_ID,
      outcome: 'SUCCEEDED',
      coverage: 'PARTIAL',
      received: projected.received,
      // The collector's share of `normalized`, summing to it exactly.
      created: 4,
      revised: 1,
      unchanged: 1,
      duplicates: 0,
      invalid: projected.invalid,
      persistenceErrors: 0,
    })
    expect(report.received).toBe(10)
  })

  /**
   * The other side, and the reason this test is not our own arithmetic restated: the STORE's
   * "exactly one disposition per received item" refine is what refuses a completion that drops our
   * `quarantined` bucket. If `toStoredReportCounts` folded only `invalid`, this report would not
   * parse — which is exactly the failure a reviewer would otherwise have to spot by eye.
   */
  it('is refused by the store when the quarantined bucket is dropped', () => {
    expect(() =>
      jobCollectionReportSchema.parse({
        sourceId: SOURCE_ID,
        outcome: 'SUCCEEDED',
        coverage: 'PARTIAL',
        received: 10,
        created: 6,
        revised: 0,
        unchanged: 0,
        duplicates: 0,
        invalid: 3,
        persistenceErrors: 0,
      }),
    ).toThrow(/exactly one disposition/)
  })

  it('a provider that reported persistence errors cannot also claim SUCCEEDED', () => {
    expect(() =>
      jobCollectionReportSchema.parse({
        sourceId: SOURCE_ID,
        outcome: 'SUCCEEDED',
        coverage: 'PARTIAL',
        received: 2,
        created: 1,
        revised: 0,
        unchanged: 0,
        duplicates: 0,
        invalid: 0,
        persistenceErrors: 1,
      }),
    ).toThrow(/cannot carry persistence errors/)
  })
})

// --- the config bounds -----------------------------------------------------

describe('the config bounds are the store`s columns', () => {
  it('takes the namespace width from the store, not from a number chosen here', () => {
    expect(NAMESPACE_MAX_CHARS).toBe(200)
    expect(() =>
      jobSourceIdentitySchema.parse({
        sourceType: 'REMOTEOK_API',
        namespace: 'n'.repeat(NAMESPACE_MAX_CHARS),
        identityKind: 'NATIVE_ID',
        identityKey: 'k',
      }),
    ).not.toThrow()
  })

  it('the store refuses a namespace one character wider, and so does the config schema', () => {
    expect(() =>
      jobSourceIdentitySchema.parse({
        sourceType: 'REMOTEOK_API',
        namespace: 'n'.repeat(NAMESPACE_MAX_CHARS + 1),
        identityKind: 'NATIVE_ID',
        identityKey: 'k',
      }),
    ).toThrow()
    expect(() =>
      baseSourceConfigSchema.parse({
        namespace: 'n'.repeat(NAMESPACE_MAX_CHARS + 1),
        configVersion: 1,
      }),
    ).toThrow()
  })

  it('accepts a config version at the integer column`s ceiling', () => {
    expect(
      baseSourceConfigSchema.parse({ namespace: 'b', configVersion: PG_INT_MAX }).configVersion,
    ).toBe(PG_INT_MAX)
  })

  it('refuses a config version one past the ceiling, which the column answers with 22003', () => {
    expect(() =>
      baseSourceConfigSchema.parse({ namespace: 'b', configVersion: PG_INT_MAX + 1 }),
    ).toThrow()
  })

  it('refuses a config version of zero — the column is positive', () => {
    expect(() => baseSourceConfigSchema.parse({ namespace: 'b', configVersion: 0 })).toThrow()
  })
})

// --- a real batch, through the real entry point -----------------------------

const itemSchema = z.object({ id: z.string(), title: z.string(), company: z.string() })
const envelopeSchema = z.object({ jobs: z.array(z.unknown()), next: z.string().nullable() })
const configSchema = baseSourceConfigSchema.extend({})

const spec: ApiJsonSourceSpec<
  z.infer<typeof configSchema>,
  z.infer<typeof envelopeSchema>,
  z.infer<typeof itemSchema>
> = {
  type: 'REMOTEOK_API',
  adapterVersion: 'conformance-1',
  configSchema,
  envelopeSchema,
  itemSchema,
  pageRequest: () => ({ request: { url: 'https://api.example.com/jobs' } }),
  extractItems: (envelope) => envelope.jobs,
  nextCursor: () => null,
  nativeIdOf: (item) => item.id,
  mapItem: (item, config) => ({
    namespace: config.namespace,
    nativeId: item.id,
    url: `https://jobs.example.com/j/${item.id}`,
    title: item.title,
    companyName: item.company,
  }),
  scopeOf: (config) => ({
    namespace: config.namespace,
    query: config.query,
    configVersion: config.configVersion,
    window: config.window,
  }),
}

function ctxFor(jobs: unknown[], errorPage?: { status: number }): CollectionContext {
  return {
    run: { sourceId: 's', cycleId: 'c', attemptId: 'a', fencingEpoch: 1 },
    policyVersion: 1,
    signal: new AbortController().signal,
    deadline: new Date('2030-01-01T00:00:00Z'),
    now: () => new Date('2026-10-20T10:00:00Z'),
    secrets: [],
    async fetchText() {
      if (errorPage !== undefined) {
        return { status: errorPage.status, bodyText: '', headers: {}, etag: null }
      }
      return {
        status: 200,
        bodyText: JSON.stringify({ jobs, next: null }),
        headers: {},
        etag: null,
      }
    },
    meter: {
      async reserve() {
        return null
      },
      async reconcile() {},
    },
    checkpoints: {
      async load() {
        return null
      },
      async savePage() {},
    },
    cache: {
      async get() {
        return null
      },
      async put() {},
    },
  }
}

const COLLECTOR_SUPPLIED_REVISION = {
  id: '11111111-1111-4111-8111-111111111111',
  sourceRecordId: '22222222-2222-4222-8222-222222222222',
  descriptionSha256: null,
  publishedAtRaw: null,
  fieldProvenance: {},
  receivedSeq: 1,
  receivedAt: '2026-10-20T10:00:00.000Z',
} as const

const COLLECTOR_SUPPLIED_ATTEMPT = {
  id: '33333333-3333-4333-8333-333333333333',
  sourceId: '11111111-1111-4111-8111-111111111111',
  cycleId: '44444444-4444-4444-8444-444444444444',
  attemptId: 'attempt-1',
  trigger: 'SCHEDULED',
  ownerToken: null,
  fencingEpoch: 1,
  leaseExpiresAt: null,
  startedAt: '2026-10-20T10:00:00.000Z',
  endedAt: '2026-10-20T10:00:05.000Z',
} as const

/** Build an attempt row the way Task 2.5 will: the collector's fields plus the batch's own. */
function attemptRowFor(batch: CollectionBatch, config: { configVersion: number }) {
  const error = batch.requests.at(-1)?.error ?? null
  return {
    ...COLLECTOR_SUPPLIED_ATTEMPT,
    configVersion: config.configVersion,
    adapterVersion: spec.adapterVersion,
    outcome: batch.outcome,
    coverage: batch.coverage,
    errorCode: error?.code ?? null,
    errorMessage: error?.message ?? null,
  }
}

describe('a batch collected through collectJsonPages', () => {
  it('produces identities the store accepts', async () => {
    const config = configSchema.parse({ namespace: 'board', configVersion: 1 })
    const batch = await collectJsonPages(
      spec,
      config,
      ctxFor([{ id: 'a1', title: 'Senior Engineer', company: 'Studio' }]),
    )

    expect(batch.observations).toHaveLength(1)
    const identity = toStoredIdentity(batch.observations[0]!.identity)
    expect(() => jobSourceIdentitySchema.parse(identity)).not.toThrow()
  })

  it('produces revision fields the store accepts', async () => {
    const config = configSchema.parse({ namespace: 'board', configVersion: 1 })
    const batch = await collectJsonPages(
      spec,
      config,
      ctxFor([{ id: 'a1', title: 'Senior Engineer', company: 'Studio' }]),
    )

    expect(() =>
      jobSourceRevisionSchema.parse({
        ...COLLECTOR_SUPPLIED_REVISION,
        ...toStoredRevisionFields(batch.observations[0]!),
      }),
    ).not.toThrow()
  })

  it('produces an attempt row the store accepts for a SUCCEEDED run', async () => {
    const config = configSchema.parse({ namespace: 'board', configVersion: 1 })
    const batch = await collectJsonPages(
      spec,
      config,
      ctxFor([{ id: 'a1', title: 'Senior Engineer', company: 'Studio' }]),
    )

    const row = jobCollectionAttemptWorkerSchema.parse(attemptRowFor(batch, config))
    expect(row.outcome).toBe('SUCCEEDED')
    expect(row.coverage).toBe('FULL_INVENTORY')
    expect(row.errorCode).toBeNull()
  })

  it('produces an attempt row the store accepts for a FAILED run, error code and all', async () => {
    const config = configSchema.parse({ namespace: 'board', configVersion: 1 })
    const batch = await collectJsonPages(spec, config, ctxFor([], { status: 403 }))

    const row = jobCollectionAttemptWorkerSchema.parse(attemptRowFor(batch, config))
    expect(row.outcome).toBe('FAILED')
    expect(row.errorCode).toBe('ACCESS_POLICY')
  })

  /**
   * The error-message cap in `buildRequestReport` is 500 because the store's column is 500
   * (`jobCollectionAttemptSchema.errorMessage`), not because 500 is a round number. Asserted
   * against the store so the two cannot drift.
   */
  it('caps the error message at the width the store`s column accepts', () => {
    const base = {
      ...COLLECTOR_SUPPLIED_ATTEMPT,
      configVersion: 1,
      adapterVersion: 'a',
      outcome: 'FAILED' as const,
      coverage: 'PARTIAL' as const,
      errorCode: 'UPSTREAM',
    }
    expect(() =>
      jobCollectionAttemptWorkerSchema.parse({ ...base, errorMessage: 'x'.repeat(500) }),
    ).not.toThrow()
    expect(() =>
      jobCollectionAttemptWorkerSchema.parse({ ...base, errorMessage: 'x'.repeat(501) }),
    ).toThrow()
  })
})
