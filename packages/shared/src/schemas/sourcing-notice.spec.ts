import { describe, expect, it } from 'vitest'
import { API_ERROR_CODES, API_ERROR_FALLBACK_EN } from './api-errors'
import { JOB_SOURCING_ERROR_MESSAGES, JOB_SOURCING_ERROR_PARAMS } from './api-errors/job-sourcing'
import { jobSourceOperationalListSchema } from './job-source-admin'
import {
  jobCollectionRunSchema,
  jobQueueListResponseSchema,
  SOURCING_NOTICE_VALUES,
  sourcingNoticeSchema,
} from './job-sourcing'

/** ADR 2026-11-03 §H.8: one closed-enum field on the queue list, the sources health list and the run. */
const queuePage = {
  items: [],
  nextCursor: null,
  counts: { NEW: 0, SUBMITTED: 0, HIDDEN: 0 },
  generation: null,
}
const responses = [
  ['jobQueueListResponseSchema', jobQueueListResponseSchema, queuePage],
  ['jobSourceOperationalListSchema', jobSourceOperationalListSchema, { items: [] }],
  ['jobCollectionRunSchema', jobCollectionRunSchema, { results: [], failures: [] }],
] as const

describe('sourcingNotice (H.8)', () => {
  it('is a closed enum with exactly one value, or null', () => {
    expect(SOURCING_NOTICE_VALUES).toEqual(['AI_LIMITS_EXHAUSTED'])
    expect(sourcingNoticeSchema.parse(null)).toBeNull()
    expect(sourcingNoticeSchema.parse('AI_LIMITS_EXHAUSTED')).toBe('AI_LIMITS_EXHAUSTED')
    expect(sourcingNoticeSchema.safeParse('LIMITS_EXHAUSTED').success).toBe(false)
    expect(sourcingNoticeSchema.safeParse(undefined).success).toBe(false)
  })

  it.each(responses)('%s carries the field and requires it', (_name, schema, base) => {
    for (const sourcingNotice of ['AI_LIMITS_EXHAUSTED', null] as const) {
      expect(schema.parse({ ...base, sourcingNotice }).sourcingNotice).toBe(sourcingNotice)
    }
    // Required, never optional: a producer that forgets it fails its own parse.
    expect(schema.safeParse(base).success).toBe(false)
    // No provider name, count or time can ride in it.
    expect(schema.safeParse({ ...base, sourcingNotice: 'gemini' }).success).toBe(false)
    expect(
      schema.safeParse({ ...base, sourcingNotice: { code: 'AI_LIMITS_EXHAUSTED' } }).success,
    ).toBe(false)
  })

  it('the queue list stays strict with the field present', () => {
    const page = { ...queuePage, sourcingNotice: null }
    expect(jobQueueListResponseSchema.safeParse({ ...page, provider: 'gemini' }).success).toBe(
      false,
    )
  })
})

describe('JOB_SOURCING_AI_LIMITS_EXHAUSTED (H.8 manual run)', () => {
  it('is a registered static code with the owner text and an English fallback', () => {
    expect(API_ERROR_CODES).toContain('JOB_SOURCING_AI_LIMITS_EXHAUSTED')
    expect(JOB_SOURCING_ERROR_PARAMS.JOB_SOURCING_AI_LIMITS_EXHAUSTED).toEqual([])
    expect(JOB_SOURCING_ERROR_MESSAGES.JOB_SOURCING_AI_LIMITS_EXHAUSTED).toEqual({
      id: 'api-error.JOB_SOURCING_AI_LIMITS_EXHAUSTED',
      message:
        'Пошук вакансій тимчасово недоступний: ліміти AI-моделей вичерпано. Спробуйте пізніше.',
    })
    expect(API_ERROR_FALLBACK_EN.JOB_SOURCING_AI_LIMITS_EXHAUSTED).toBe(
      'Vacancy search is temporarily unavailable: AI model limits are used up. Try again later.',
    )
  })
})

describe('JOB_SOURCING_COLLECTION_FAILED (manual run all sources failed)', () => {
  it('is a registered static code with the Ukrainian message and an English fallback', () => {
    expect(API_ERROR_CODES).toContain('JOB_SOURCING_COLLECTION_FAILED')
    expect(JOB_SOURCING_ERROR_PARAMS.JOB_SOURCING_COLLECTION_FAILED).toEqual([])
    expect(JOB_SOURCING_ERROR_MESSAGES.JOB_SOURCING_COLLECTION_FAILED).toEqual({
      id: 'api-error.JOB_SOURCING_COLLECTION_FAILED',
      message: 'Збір не вдався: жодне джерело не відпрацювало. Спробуйте пізніше.',
    })
    expect(API_ERROR_FALLBACK_EN.JOB_SOURCING_COLLECTION_FAILED).toBe(
      'Collection failed: no source completed. Try again later.',
    )
  })
})
