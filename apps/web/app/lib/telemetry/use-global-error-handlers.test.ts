import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useGlobalErrorHandlers } from './use-global-error-handlers'
import { isTelemetryEnabled } from './config'
import { reportClientError } from './errors'

/**
 * task fix/api-error-messages security check: `axios.ts`'s response
 * interceptor now rewrites a rejected axios error's `.message` to a
 * user-facing string that MAY echo backend-supplied text sourced from the
 * response body (`response.data.message`) — request-scoped, can contain
 * whatever the user submitted (e.g. an email). These tests pin that an
 * UNHANDLED axios rejection never forwards that text to telemetry — only a
 * structural, PII-free marker (method + path without query string + status).
 */
vi.mock('./config', () => ({
  isTelemetryEnabled: vi.fn(() => true),
}))
vi.mock('./errors', () => ({
  reportClientError: vi.fn(),
}))

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

describe('useGlobalErrorHandlers — unhandledrejection', () => {
  afterEach(() => {
    vi.mocked(isTelemetryEnabled).mockReturnValue(true)
    vi.mocked(reportClientError).mockClear()
  })

  it('reports a plain Error rejection with its own message (non-axios path unchanged)', () => {
    renderHook(() => useGlobalErrorHandlers())

    dispatchUnhandledRejection(new Error('boom'))

    expect(reportClientError).toHaveBeenCalledWith('Unhandled rejection: boom', expect.anything())
  })

  it('reports an axios rejection as a sanitized method+path+status marker, never the (possibly backend-echoed) message', () => {
    renderHook(() => useGlobalErrorHandlers())

    const axiosLikeError = {
      isAxiosError: true,
      message: 'Пользователь user@example.com уже зарегистрирован', // simulates a humanized, backend-echoed message
      response: {
        status: 409,
        data: { message: 'Пользователь user@example.com уже зарегистрирован' },
      },
      config: { method: 'post', url: '/users?email=user@example.com' },
    }

    dispatchUnhandledRejection(axiosLikeError)

    expect(reportClientError).toHaveBeenCalledOnce()
    const [reportedMessage] = vi.mocked(reportClientError).mock.calls[0] ?? []
    expect(reportedMessage).toBe('Unhandled rejection: Unhandled API error: POST /users → 409')
    // The PII-bearing text (email) must never reach telemetry — neither the
    // backend-echoed message nor the query string.
    expect(reportedMessage).not.toContain('user@example.com')
  })

  it('falls back to a generic "network" status marker when the axios error never got a response', () => {
    renderHook(() => useGlobalErrorHandlers())

    const axiosLikeError = {
      isAxiosError: true,
      message: 'Нет связи с сервером. Проверьте подключение к интернету и попробуйте снова.',
      config: { method: 'get', url: '/documents' },
    }

    dispatchUnhandledRejection(axiosLikeError)

    expect(reportClientError).toHaveBeenCalledWith(
      'Unhandled rejection: Unhandled API error: GET /documents → network',
      expect.anything(),
    )
  })

  it('does nothing when telemetry is disabled', () => {
    vi.mocked(isTelemetryEnabled).mockReturnValue(false)
    renderHook(() => useGlobalErrorHandlers())

    dispatchUnhandledRejection(new Error('boom'))

    expect(reportClientError).not.toHaveBeenCalled()
  })
})
