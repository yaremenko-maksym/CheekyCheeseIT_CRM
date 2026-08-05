import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useGlobalErrorHandlers } from './use-global-error-handlers'
import { isTelemetryEnabled } from './config'
import { reportClientError } from './errors'

/**
 * task fix/api-error-messages security check (hardened after security-review
 * round 2, HIGH-1/MED-1): `axios.ts`'s response interceptor rewrites a
 * rejected axios error's `.message` to a user-facing string that MAY echo
 * backend-supplied text sourced from the response body — request-scoped,
 * can contain whatever the user submitted (e.g. an email). These tests pin
 * that an UNHANDLED rejection/global error never forwards that text OR a
 * poisoned `.stack` header to telemetry — only a structural, PII-free
 * marker (method + path without query string + status).
 *
 * Round-2 reviewer note: the previous version of this fixture was an object
 * literal with NO `.stack` field at all — which meant the ACTUAL defect
 * found (a `.stack` header poisoned by V8's lazy materialization reading a
 * post-mutation `.message`) was structurally invisible to this test; a test
 * that can't see the defect is worse than none. Fixtures below always carry
 * an explicit, realistic `.stack` (as if `axios.ts`'s HIGH-1 fix had NOT
 * run) so these tests would fail loudly if `sanitizeErrorForReport`
 * (errors.ts) ever stopped dropping it for axios errors. The second
 * `reportClientError` argument is asserted on directly — never
 * `expect.anything()`.
 *
 * `./errors` is partially mocked (`reportClientError` only) — the REAL
 * `sanitizeErrorForReport` runs, so these are integration tests of the
 * actual funnel these handlers route through, not of a re-mocked stand-in.
 */
vi.mock('./config', () => ({
  isTelemetryEnabled: vi.fn(() => true),
}))
vi.mock('./errors', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./errors')>()
  return { ...actual, reportClientError: vi.fn() }
})

// A minimal PromiseRejectionEvent stand-in — happy-dom doesn't construct a
// real one from `new Event(...)`, so we build a plain Event with the field
// the handler reads (`reason`) attached, and dispatch it directly.
function dispatchUnhandledRejection(reason: unknown): void {
  const event = Object.assign(new Event('unhandledrejection'), {
    reason,
    promise: Promise.resolve(),
  })
  window.dispatchEvent(event)
}

function dispatchWindowError(error: unknown, message: string): void {
  const event = Object.assign(new Event('error'), { error, message })
  window.dispatchEvent(event)
}

// A realistic pre-HIGH-1-fix poisoned stack — the header line V8 would have
// materialized AFTER axios.ts mutated `.message`, had that fix not run.
const POISONED_STACK = [
  'AxiosError: Пользователь user@example.com уже зарегистрирован',
  '    at settle (axios/lib/core/settle.js:19:12)',
  '    at Axios.request (axios/lib/core/Axios.js:41:25)',
].join('\n')

describe('useGlobalErrorHandlers — unhandledrejection', () => {
  afterEach(() => {
    vi.mocked(isTelemetryEnabled).mockReturnValue(true)
    vi.mocked(reportClientError).mockClear()
  })

  it('reports a plain Error rejection with its own message AND real stack (non-axios path unchanged)', () => {
    renderHook(() => useGlobalErrorHandlers())

    const err = new Error('boom')
    dispatchUnhandledRejection(err)

    expect(reportClientError).toHaveBeenCalledWith('Unhandled rejection: boom', {
      stack: err.stack,
    })
  })

  it('reports an axios rejection as a sanitized method+path+status marker — message AND stack scrubbed', () => {
    renderHook(() => useGlobalErrorHandlers())

    const axiosLikeError = {
      isAxiosError: true,
      message: 'Пользователь user@example.com уже зарегистрирован', // humanized, backend-echoed (axios.ts's design)
      stack: POISONED_STACK,
      response: {
        status: 409,
        data: { message: 'Пользователь user@example.com уже зарегистрирован' },
      },
      config: { method: 'post', url: '/users?email=user@example.com' },
    }

    dispatchUnhandledRejection(axiosLikeError)

    expect(reportClientError).toHaveBeenCalledWith(
      'Unhandled rejection: API error: POST /users → 409',
      {
        stack: undefined,
      },
    )
  })

  it('falls back to a generic "network" status marker when the axios error never got a response', () => {
    renderHook(() => useGlobalErrorHandlers())

    const axiosLikeError = {
      isAxiosError: true,
      message: 'Нет связи с сервером. Проверьте подключение к интернету и попробуйте снова.',
      stack: 'AxiosError: Нет связи с сервером...\n    at settle (axios/lib/core/settle.js:19:12)',
      config: { method: 'get', url: '/documents' },
    }

    dispatchUnhandledRejection(axiosLikeError)

    expect(reportClientError).toHaveBeenCalledWith(
      'Unhandled rejection: API error: GET /documents → network',
      { stack: undefined },
    )
  })

  it('does nothing when telemetry is disabled', () => {
    vi.mocked(isTelemetryEnabled).mockReturnValue(false)
    renderHook(() => useGlobalErrorHandlers())

    dispatchUnhandledRejection(new Error('boom'))

    expect(reportClientError).not.toHaveBeenCalled()
  })
})

describe('useGlobalErrorHandlers — window.onerror', () => {
  afterEach(() => {
    vi.mocked(isTelemetryEnabled).mockReturnValue(true)
    vi.mocked(reportClientError).mockClear()
  })

  it('reports a plain Error with its own message AND real stack', () => {
    renderHook(() => useGlobalErrorHandlers())

    const err = new Error('sync boom')
    dispatchWindowError(err, 'sync boom')

    expect(reportClientError).toHaveBeenCalledWith('sync boom', { stack: err.stack })
  })

  it('scrubs an axios error surfacing via window.onerror the same way as unhandledrejection', () => {
    renderHook(() => useGlobalErrorHandlers())

    // `event.error instanceof Error` gates this handler's axios-aware path
    // (real AxiosError DOES extend Error) — a plain object literal, unlike
    // in the unhandledrejection tests above, would silently skip
    // `sanitizeErrorForReport` here and defeat the point of this test.
    const axiosLikeError = Object.assign(
      new Error('Пользователь user@example.com уже зарегистрирован'),
      {
        isAxiosError: true,
        stack: POISONED_STACK,
        response: { status: 409, data: {} },
        config: { method: 'post', url: '/users?email=user@example.com' },
      },
    )

    dispatchWindowError(axiosLikeError, 'irrelevant native message')

    expect(reportClientError).toHaveBeenCalledWith('API error: POST /users → 409', {
      stack: undefined,
    })
  })

  it('falls back to the native event message when event.error is not an Error', () => {
    renderHook(() => useGlobalErrorHandlers())

    dispatchWindowError(undefined, 'Script error.')

    expect(reportClientError).toHaveBeenCalledWith('Script error.', {})
  })
})
