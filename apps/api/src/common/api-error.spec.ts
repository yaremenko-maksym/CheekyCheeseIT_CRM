import { HttpStatus } from '@nestjs/common'
import { describe, expect, it } from 'vitest'
import { API_ERROR_FALLBACK_EN } from '@crm/shared'
import { apiError } from './api-error'

describe('apiError', () => {
  it('omits params when none are given', () => {
    const e = apiError('TOS_ACCEPT_IMPERSONATION', HttpStatus.FORBIDDEN)
    expect(e.getStatus()).toBe(403)
    expect(e.getResponse()).toEqual({
      statusCode: 403,
      code: 'TOS_ACCEPT_IMPERSONATION',
      params: undefined,
      message: API_ERROR_FALLBACK_EN.TOS_ACCEPT_IMPERSONATION,
    })
  })

  it('builds an HttpException whose body matches the envelope shape for CONTRACT_TEMPLATE_MISSING (no params — COPY-M-6, PR #694 round 3)', () => {
    const e = apiError('CONTRACT_TEMPLATE_MISSING', HttpStatus.NOT_FOUND)
    expect(e.getStatus()).toBe(404)
    expect(e.getResponse()).toEqual({
      statusCode: 404,
      code: 'CONTRACT_TEMPLATE_MISSING',
      params: undefined,
      message: API_ERROR_FALLBACK_EN.CONTRACT_TEMPLATE_MISSING,
    })
  })

  // COPY-M-6 (PR #694 round 3) removed the only param any registered code
  // declared (`CONTRACT_TEMPLATE_MISSING`'s `role`) — every `ParamsFor<C>`
  // is `never` now, so no call site can reach `interpolate()`'s
  // substitution branch through the type-checked public surface, and no
  // fallback template carries a `{token}` left for it to substitute. The
  // two tests that exercised that branch (interpolating a real param, and
  // leaving an unsatisfied placeholder literal) are removed rather than
  // kept on a synthetic call — unlike the client-side `translateApiError`
  // case (`axios-utils.spec.ts`), there is no real fallback string left
  // with a placeholder to substitute INTO, so a synthetic test would only
  // verify a template that never ships. Reinstate against whichever code
  // stage 3 next gives params to.
})
