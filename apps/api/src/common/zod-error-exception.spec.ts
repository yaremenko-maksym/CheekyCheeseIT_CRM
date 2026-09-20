import { describe, expect, it } from 'vitest'
import { BadRequestException } from '@nestjs/common'
import { ZOD_ERROR_FALLBACK_EN } from '@crm/shared'
import { zodErrorBadRequest } from './zod-error-exception'

describe('zodErrorBadRequest', () => {
  it('builds a { statusCode, code, message } body for a coded zod.<CODE> value', () => {
    const exception = zodErrorBadRequest('zod.RECEIPT_REQUIRED')
    expect(exception).toBeInstanceOf(BadRequestException)
    expect(exception.getStatus()).toBe(400)
    expect(exception.getResponse()).toEqual({
      statusCode: 400,
      code: 'RECEIPT_REQUIRED',
      message: ZOD_ERROR_FALLBACK_EN.RECEIPT_REQUIRED,
    })
  })

  it('uses the SAME English fallback text as the Zod-boundary path for the same code', () => {
    const exception = zodErrorBadRequest('zod.SENDER_RECEIVER_SAME')
    const body = exception.getResponse() as { message: string }
    expect(body.message).toBe(ZOD_ERROR_FALLBACK_EN.SENDER_RECEIVER_SAME)
  })

  it('falls back to a plain string body for a non-coded (caller-supplied literal) message', () => {
    const exception = zodErrorBadRequest('Cannot transfer to yourself')
    expect(exception.getResponse()).toMatchObject({ message: 'Cannot transfer to yourself' })
  })

  it('falls back to a plain string body for an unknown zod.<CODE>-shaped message', () => {
    const exception = zodErrorBadRequest('zod.NOT_A_REAL_CODE')
    expect(exception.getResponse()).toMatchObject({ message: 'zod.NOT_A_REAL_CODE' })
  })

  /**
   * mutation-gate closure (same class as `zodErrorFallbackText`'s own pinning
   * test in `zod-errors.spec.ts`): a message with no `zod.` prefix at all
   * passes through unchanged EITHER because the early-return actually ran, OR
   * — if it were mutated away — because `message.slice(4)` happened not to
   * collide with a real code, so the earlier "non-coded" tests above cannot
   * tell the two apart. This message is built so a BROKEN early-return slices
   * its first 4 characters off into `RECEIPT_REQUIRED` — a REAL code — and
   * would build a coded body instead of the plain-string one the assertion
   * below requires.
   */
  it("a non-coded message whose 4th-character-onward slice collides with a real code still gets the plain-string body (pins the actual startsWith('zod.') check)", () => {
    const message = 'abcdRECEIPT_REQUIRED'
    expect(message.startsWith('zod.')).toBe(false)
    const exception = zodErrorBadRequest(message)
    expect(exception.getResponse()).toEqual({
      statusCode: 400,
      message,
      error: 'Bad Request',
    })
  })
})
