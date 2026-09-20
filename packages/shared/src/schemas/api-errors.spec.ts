import { describe, expect, it } from 'vitest'
import {
  API_ERROR_CODES,
  API_ERROR_FALLBACK_EN,
  API_ERROR_MESSAGES,
  apiErrorEnvelopeSchema,
} from './api-errors'

describe('api-errors', () => {
  it('every code has a message descriptor with an explicit id matching the code', () => {
    for (const code of API_ERROR_CODES) {
      expect(API_ERROR_MESSAGES[code].id).toBe(`api-error.${code}`)
      expect(API_ERROR_MESSAGES[code].message?.length ?? 0).toBeGreaterThan(0)
    }
  })

  it('every code has a non-empty English fallback', () => {
    for (const code of API_ERROR_CODES) {
      expect(API_ERROR_FALLBACK_EN[code].length).toBeGreaterThan(0)
    }
  })

  it('envelope accepts a minimal valid body', () => {
    expect(
      apiErrorEnvelopeSchema.safeParse({
        statusCode: 403,
        code: 'TOS_ACCEPT_IMPERSONATION',
        message: 'x',
      }).success,
    ).toBe(true)
  })

  it('envelope accepts string/number params', () => {
    expect(
      apiErrorEnvelopeSchema.safeParse({
        statusCode: 404,
        code: 'CONTRACT_TEMPLATE_MISSING',
        params: { role: 'SENIOR', attempt: 2 },
        message: 'x',
      }).success,
    ).toBe(true)
  })

  it('rejects a code outside the registry', () => {
    expect(
      apiErrorEnvelopeSchema.safeParse({ statusCode: 403, code: 'NOPE', message: 'x' }).success,
    ).toBe(false)
  })

  it('rejects a body missing the required message field', () => {
    expect(
      apiErrorEnvelopeSchema.safeParse({
        statusCode: 403,
        code: 'TOS_ACCEPT_IMPERSONATION',
      }).success,
    ).toBe(false)
  })
})
