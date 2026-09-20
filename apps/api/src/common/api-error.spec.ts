import { HttpStatus } from '@nestjs/common'
import { describe, expect, it } from 'vitest'
import { apiError } from './api-error'

describe('apiError', () => {
  it('builds an HttpException whose body is the envelope, interpolating params into the English fallback', () => {
    const e = apiError('CONTRACT_TEMPLATE_MISSING', HttpStatus.NOT_FOUND, { role: 'SENIOR' })
    expect(e.getStatus()).toBe(404)
    expect(e.getResponse()).toEqual({
      statusCode: 404,
      code: 'CONTRACT_TEMPLATE_MISSING',
      params: { role: 'SENIOR' },
      message: 'No active contract template for role SENIOR',
    })
  })

  it('omits params when none are given', () => {
    const e = apiError('TOS_ACCEPT_IMPERSONATION', HttpStatus.FORBIDDEN)
    expect(e.getResponse()).toEqual({
      statusCode: 403,
      code: 'TOS_ACCEPT_IMPERSONATION',
      params: undefined,
      message: 'Accepting the terms is not allowed while impersonating',
    })
  })

  it('leaves an unsatisfied placeholder literal instead of throwing', () => {
    // SR-M-1 (PR #694 round 1) made `role` a compile-time-required third
    // argument for this code (`ParamsFor<'CONTRACT_TEMPLATE_MISSING'>` — see
    // `packages/shared/src/schemas/api-errors.ts`); this test exercises the
    // runtime fallback `interpolate()` still provides as defense-in-depth if
    // that guarantee is ever bypassed (e.g. an `as any` call site), so the
    // omission is deliberate and asserted with `@ts-expect-error`.
    // @ts-expect-error — `role` is required for this code; see comment above.
    const e = apiError('CONTRACT_TEMPLATE_MISSING', HttpStatus.NOT_FOUND)
    expect((e.getResponse() as { message: string }).message).toBe(
      'No active contract template for role {role}',
    )
  })
})
