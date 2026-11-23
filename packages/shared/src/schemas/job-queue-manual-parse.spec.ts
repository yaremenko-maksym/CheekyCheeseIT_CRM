/** External vacancy intake PR 2 — the `POST /job-queue/manual/parse` wire contract and its 503 code. */
import { describe, expect, it } from 'vitest'
import { API_ERROR_CODES, API_ERROR_FALLBACK_EN } from './api-errors'
import { JOB_SOURCING_ERROR_MESSAGES, JOB_SOURCING_ERROR_PARAMS } from './api-errors/job-sourcing'
import { jobQueueManualParseRequestSchema, jobQueueManualParseResponseSchema } from './job-sourcing'

describe('jobQueueManualParseRequestSchema', () => {
  it('takes the text trimmed', () => {
    expect(jobQueueManualParseRequestSchema.parse({ text: '  Senior dev  ' })).toEqual({
      text: 'Senior dev',
    })
  })

  it('takes exactly 50 000 chars and refuses 50 001', () => {
    expect(jobQueueManualParseRequestSchema.safeParse({ text: 'a'.repeat(50_000) }).success).toBe(
      true,
    )
    expect(jobQueueManualParseRequestSchema.safeParse({ text: 'a'.repeat(50_001) }).success).toBe(
      false,
    )
  })

  it('refuses an empty or blank text, a missing one and an extra key', () => {
    expect(jobQueueManualParseRequestSchema.safeParse({ text: '' }).success).toBe(false)
    expect(jobQueueManualParseRequestSchema.safeParse({ text: '   ' }).success).toBe(false)
    expect(jobQueueManualParseRequestSchema.safeParse({}).success).toBe(false)
    expect(jobQueueManualParseRequestSchema.safeParse({ text: 'x', url: 'y' }).success).toBe(false)
  })
})

describe('jobQueueManualParseResponseSchema', () => {
  it('takes a bare negative and a full positive answer', () => {
    expect(jobQueueManualParseResponseSchema.parse({ isVacancy: false })).toEqual({
      isVacancy: false,
    })
    const full = { isVacancy: true, title: 'T', companyName: 'C', descriptionMd: 'D' }
    expect(jobQueueManualParseResponseSchema.parse(full)).toEqual(full)
  })

  it('caps each field at its maximum', () => {
    const at = (title: number, companyName: number, descriptionMd: number) =>
      jobQueueManualParseResponseSchema.safeParse({
        isVacancy: true,
        title: 'a'.repeat(title),
        companyName: 'a'.repeat(companyName),
        descriptionMd: 'a'.repeat(descriptionMd),
      }).success
    expect(at(500, 255, 50_000)).toBe(true)
    expect(at(501, 255, 50_000)).toBe(false)
    expect(at(500, 256, 50_000)).toBe(false)
    expect(at(500, 255, 50_001)).toBe(false)
  })

  it('refuses a missing isVacancy and an extra key', () => {
    expect(jobQueueManualParseResponseSchema.safeParse({ title: 'T' }).success).toBe(false)
    expect(
      jobQueueManualParseResponseSchema.safeParse({ isVacancy: true, applyUrl: 'x' }).success,
    ).toBe(false)
  })
})

describe('JOB_QUEUE_PARSE_UNAVAILABLE', () => {
  it('is a registered static code with the Ukrainian message and an English fallback', () => {
    expect(API_ERROR_CODES).toContain('JOB_QUEUE_PARSE_UNAVAILABLE')
    expect(JOB_SOURCING_ERROR_PARAMS.JOB_QUEUE_PARSE_UNAVAILABLE).toEqual([])
    expect(JOB_SOURCING_ERROR_MESSAGES.JOB_QUEUE_PARSE_UNAVAILABLE).toEqual({
      id: 'api-error.JOB_QUEUE_PARSE_UNAVAILABLE',
      message: 'Розпізнавання тексту вакансії зараз недоступне. Заповніть поля вручну.',
    })
    expect(API_ERROR_FALLBACK_EN.JOB_QUEUE_PARSE_UNAVAILABLE).toBe(
      'Reading the vacancy text is unavailable right now. Fill in the fields by hand.',
    )
  })
})
