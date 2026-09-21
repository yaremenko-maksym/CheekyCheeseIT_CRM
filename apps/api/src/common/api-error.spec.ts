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
  // declared at the time (`CONTRACT_TEMPLATE_MISSING`'s `role`) — the two
  // tests that used to exercise `interpolate()`'s substitution branch were
  // removed rather than kept on a synthetic call, with a note to reinstate
  // against whichever code next gave params to a call site. task-i18n-
  // stage4-task3 (PR #702) did: `DOCUMENT_TOO_LARGE` (`{maxMb}`, a plain
  // token) and `CONTRACT_ALREADY_STATUS_CANNOT_REVERT` (`{status, select,
  // ...}`, an ICU select) are both real, currently-shipping fallback
  // templates with real call sites passing `params`.
  //
  // SR-M-1 (PR #702 fix-round 1): these two tests are also the regression
  // guard for the regex → `@lingui/core` rewrite above — the OLD
  // `\{(\w+)\}` regex could interpolate the plain-token case but could
  // NEVER match the select case at all (comma before the closing content),
  // so it would have left the second test's message carrying raw `{status,
  // select, ...}` ICU syntax verbatim.
  it('interpolates a plain {token} param into the English fallback (DOCUMENT_TOO_LARGE)', () => {
    const e = apiError('DOCUMENT_TOO_LARGE', HttpStatus.PAYLOAD_TOO_LARGE, { maxMb: 10 })
    const response = e.getResponse() as { message: string }
    expect(response.message).toBe('The file is larger than 10 MB')
    expect(response.message).not.toMatch(/[{}]/)
  })

  it('renders an ICU {token, select, ...} param into the English fallback, not the raw template (CONTRACT_ALREADY_STATUS_CANNOT_REVERT)', () => {
    const e = apiError('CONTRACT_ALREADY_STATUS_CANNOT_REVERT', HttpStatus.CONFLICT, {
      status: 'SIGNED',
    })
    const response = e.getResponse() as { message: string }
    expect(response.message).toBe("Can't revert to draft: the contract is already signed")
    expect(response.message).not.toMatch(/[{}]/)
  })
})
