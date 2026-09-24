import { HttpStatus } from '@nestjs/common'
import { describe, expect, it, vi } from 'vitest'
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

  // Mutation-gate finding (fix-round 1, `interpolate`'s `setupI18n({ locale:
  // 'en', messages: { en: {} } })` call): mutating the inner `en: {}` away
  // (`messages: {}`) survived — the RETURNED `message` text is identical
  // either way (verified empirically: `i18n._` falls back to `options.
  // message` regardless), but `@lingui/core` logs `console.warn('Messages
  // for locale "en" not loaded.')` on every single call when the `en` key
  // is missing — i.e. on every refused request in this repo, since
  // `interpolate` runs on every `apiError()` call. That is real,
  // observable, undesirable behavior (production log spam), just not
  // through the return value the earlier two tests already pin — this test
  // is what makes it observable to the mutation gate too.
  it('does not warn on a missing locale — the empty `en` catalog entry is registered, not omitted', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      apiError('TOS_ACCEPT_IMPERSONATION', HttpStatus.FORBIDDEN)
      expect(warnSpy).not.toHaveBeenCalled()
    } finally {
      warnSpy.mockRestore()
    }
  })

  // SR-M-1 (PR #704 fix-round 1): `@lingui/core`'s `I18n` constructor only
  // self-registers `compileMessage` as the message compiler when
  // `process.env.NODE_ENV !== 'production'` — the prod API runs with
  // `NODE_ENV=production`, so without `interpolate()` calling
  // `setMessagesCompiler` explicitly, `i18n._()` could not parse the raw
  // ICU fallback template at all: it would return it VERBATIM (braces and
  // all) and log a `console.warn('Uncompiled message detected! …')` on
  // every single `apiError()` call. Regression-guards both symptoms at
  // once, with `NODE_ENV` switched for the duration of the call — the
  // compiler is selected when the `I18n` instance is constructed, and
  // `interpolate()` constructs a fresh instance on every call, so toggling
  // the env var per-test is enough (no process restart needed).
  it('interpolates params into the English fallback even under NODE_ENV=production, without an "Uncompiled message" warning (SR-M-1)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const originalNodeEnv = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    try {
      const e = apiError('DOCUMENT_TOO_LARGE', HttpStatus.PAYLOAD_TOO_LARGE, { maxMb: 10 })
      const response = e.getResponse() as { message: string }
      expect(response.message).toBe('The file is larger than 10 MB')
      expect(response.message).not.toMatch(/[{}]/)
      expect(warnSpy).not.toHaveBeenCalled()
    } finally {
      process.env.NODE_ENV = originalNodeEnv
      warnSpy.mockRestore()
    }
  })
})
