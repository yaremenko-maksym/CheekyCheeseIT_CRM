import { describe, expect, it } from 'vitest'
import { sanitizeErrorForReport } from './errors'

/**
 * security-review round 2, MED-1: `sanitizeErrorForReport` is the SINGLE
 * funnel all three telemetry entry points (`ErrorBoundary.tsx`,
 * `use-global-error-handlers.ts`'s `onError`/`onRejection`) route through.
 * These tests pin its contract directly — the fixture used by
 * `use-global-error-handlers.test.ts` was previously an object literal
 * with NO `.stack` at all, which meant the leak the security review found
 * (a poisoned `.stack` header) was structurally invisible to that test
 * ("a test that can't see the defect is worse than no test" — reviewer
 * note). These fixtures always carry a realistic, already-poisoned
 * multi-line `.stack` to prove it gets dropped, not just absent.
 */
describe('sanitizeErrorForReport', () => {
  it('drops the message AND stack for an axios error — never forwards backend-echoed text', () => {
    const poisonedStack = [
      'AxiosError: Пользователь vasya@example.com уже существует',
      '    at settle (axios/lib/core/settle.js:19:12)',
      '    at Axios.request (axios/lib/core/Axios.js:41:25)',
    ].join('\n')
    const axiosLikeError = {
      isAxiosError: true,
      message: 'Пользователь vasya@example.com уже существует', // humanized, backend-echoed (axios.ts's design)
      stack: poisonedStack, // realistic pre-HIGH-1-fix stack, IF this ever reached telemetry raw
      response: { status: 409, data: { message: 'Пользователь vasya@example.com уже существует' } },
      config: { method: 'post', url: '/users?email=vasya@example.com' },
    }

    const result = sanitizeErrorForReport(axiosLikeError)

    expect(result.message).toBe('API error: POST /users → 409')
    expect(result.stack).toBeUndefined()
    expect(result.message).not.toContain('vasya@example.com')
  })

  it('strips the query string from the path for a network error (no response)', () => {
    const axiosLikeError = {
      isAxiosError: true,
      message: 'Network Error',
      config: { method: 'get', url: '/documents?ownerId=abc-123' },
    }

    const result = sanitizeErrorForReport(axiosLikeError)

    expect(result.message).toBe('API error: GET /documents → network')
  })

  it('passes a plain Error through unchanged (message + real stack)', () => {
    const err = new Error('boom')
    const result = sanitizeErrorForReport(err)

    expect(result.message).toBe('boom')
    expect(result.stack).toBe(err.stack)
    expect(result.stack).toContain('Error: boom')
  })

  it('coerces a non-Error, non-axios reason to a string with no stack', () => {
    expect(sanitizeErrorForReport('a string throw')).toEqual({
      message: 'a string throw',
      stack: undefined,
    })
    expect(sanitizeErrorForReport(null)).toEqual({ message: 'null', stack: undefined })
  })
})
