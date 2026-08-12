import { describe, expect, it } from 'vitest'
import { jobCollectionRunSchema } from '@crm/shared'
import {
  DATABASE_FAILURE_MESSAGE,
  MAX_FAILURE_MESSAGE_CHARS,
  toSafeFailureMessage,
} from './safe-failure-message'

/**
 * Security-review round 5. The tests below use REAL error text, not short
 * placeholders: the whole finding is that a realistic message is long enough to
 * break the outgoing schema and detailed enough to leak the schema of our
 * database, and a 20-character stand-in demonstrates neither.
 */

/** Shaped like what Drizzle actually throws on a failed insert. */
const DRIZZLE_INSERT_ERROR = new Error(
  'Failed query: insert into "job_postings" ("id", "source_type", "source_id", "external_id", ' +
    '"url", "title", "company_name", "company_name_normalized", "location", "description_md", ' +
    '"published_at", "fingerprint", "collected_at", "updated_at") values (default, $1, $2, $3, $4, ' +
    '$5, $6, $7, $8, $9, $10, $11, default, default) returning "id", "source_type", "source_id", ' +
    '"external_id", "url", "title", "company_name", "company_name_normalized"\n' +
    'params: DOU_RSS,d5e6f7a8-1b2c-4d3e-dd00-000000000001,' +
    'https://jobs.dou.ua/companies/epam-systems/vacancies/356562,Senior Engineer,EPAM,epam,' +
    'Kyiv,We are hiring a senior engineer for a long-running platform team,2026-08-07',
)

/** Shaped like a raw node-postgres constraint violation. */
const PG_CONSTRAINT_ERROR = new Error(
  'null value in column "title" of relation "job_postings" violates not-null constraint',
)

describe('toSafeFailureMessage — length (the 400 this caused)', () => {
  it('caps a long message well below the schema limit', () => {
    const long = new Error('x'.repeat(5000))
    const message = toSafeFailureMessage(long)

    expect(message.length).toBeLessThanOrEqual(MAX_FAILURE_MESSAGE_CHARS)
    // The cap must sit strictly BELOW the wire contract, not on it.
    expect(MAX_FAILURE_MESSAGE_CHARS).toBeLessThan(1000)
  })

  it('the resulting run still parses against the OUTGOING schema', () => {
    // This is the exact regression: the response was `.parse()`d on the way out
    // and threw, so a partial-success run answered `400 Validation failed`
    // instead of reporting which source broke.
    const run = {
      results: [],
      failures: [
        {
          sourceType: 'DOU_RSS' as const,
          message: toSafeFailureMessage(DRIZZLE_INSERT_ERROR),
          // task-vacancy-matching §4: a failure now also states whether the
          // source stopped because its request budget is spent (a normal,
          // self-resolving condition) or because it broke. These two are
          // breakages, so `false`.
          budgetExhausted: false,
        },
        {
          sourceType: 'DOU_RSS' as const,
          message: toSafeFailureMessage(new Error('y'.repeat(9000))),
          budgetExhausted: false,
        },
      ],
    }
    expect(() => jobCollectionRunSchema.parse(run)).not.toThrow()
  })

  it('a raw message would NOT have parsed — the cap is doing real work', () => {
    const rawRun = {
      results: [],
      failures: [{ sourceType: 'DOU_RSS' as const, message: 'y'.repeat(9000) }],
    }
    expect(() => jobCollectionRunSchema.parse(rawRun)).toThrow()
  })
})

describe('toSafeFailureMessage — database internals (the leak)', () => {
  it('replaces a Drizzle statement dump instead of trimming it', () => {
    const message = toSafeFailureMessage(DRIZZLE_INSERT_ERROR)

    expect(message).toBe(DATABASE_FAILURE_MESSAGE)
    // No table, no column list, no bound parameters — trimming to 300 chars
    // would still have shipped the first 300 characters of our schema.
    expect(message).not.toContain('job_postings')
    expect(message).not.toContain('insert into')
    expect(message).not.toContain('params:')
    expect(message).not.toContain('jobs.dou.ua')
    expect(message).not.toContain('$1')
  })

  it('replaces a node-postgres constraint violation too', () => {
    const message = toSafeFailureMessage(PG_CONSTRAINT_ERROR)

    expect(message).toBe(DATABASE_FAILURE_MESSAGE)
    expect(message).not.toContain('job_postings')
    expect(message).not.toContain('title')
  })

  it('flattens multi-line text so nothing can smuggle a fake log line', () => {
    const message = toSafeFailureMessage(new Error('boom\n[ERROR] fabricated line'))
    expect(message).not.toContain('\n')
    expect(message).toContain('boom')
  })
})

describe('toSafeFailureMessage — keeps what the operator actually needs', () => {
  it('passes our own diagnostic messages through untouched', () => {
    const ours = new Error(
      'Source DOU_RSS returned 0 usable postings — feed format changed, source is down, ' +
        'or every entry was rejected. lastCollectedAt left unchanged.',
    )
    expect(toSafeFailureMessage(ours)).toBe(ours.message)
  })

  it('passes an allow-list rejection through', () => {
    const message = toSafeFailureMessage(
      new Error('DOU source config: category "Nope" is not allow-listed'),
    )
    expect(message).toContain('not allow-listed')
  })

  it('redacts credentials before truncating', () => {
    const message = toSafeFailureMessage(
      new Error(`request failed Authorization: Bearer sk-secret-token ${'z'.repeat(400)}`),
    )
    expect(message).not.toContain('sk-secret-token')
    expect(message).toContain('[redacted]')
    expect(message.length).toBeLessThanOrEqual(MAX_FAILURE_MESSAGE_CHARS)
  })

  it('handles a non-Error throw and an empty message', () => {
    expect(toSafeFailureMessage('plain string failure')).toBe('plain string failure')
    expect(toSafeFailureMessage(new Error('   '))).toBe('Неизвестная ошибка сбора')
    expect(toSafeFailureMessage(undefined)).toBeTruthy()
  })
})
