import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { TelemetryErrorBoundary } from './ErrorBoundary'
import { reportClientError } from './errors'

/**
 * security-review round 2, MED-1: `componentDidCatch` now routes through
 * the SAME `sanitizeErrorForReport` funnel as the other two telemetry
 * entry points (see `use-global-error-handlers.test.ts` for the full
 * rationale) — this pins that a render-time axios error doesn't leak its
 * (possibly backend-echoed) message into telemetry just because it arrived
 * via this third, differently-implemented entry point.
 */
vi.mock('./errors', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./errors')>()
  return { ...actual, reportClientError: vi.fn() }
})

function ThrowOnRender({ error }: { error: unknown }): never {
  throw error
}

describe('TelemetryErrorBoundary', () => {
  afterEach(() => {
    vi.mocked(reportClientError).mockClear()
  })

  it('reports a plain render Error with its message', () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    render(
      <TelemetryErrorBoundary>
        <ThrowOnRender error={new Error('render boom')} />
      </TelemetryErrorBoundary>,
    )

    expect(reportClientError).toHaveBeenCalledWith(
      'render boom',
      expect.objectContaining({ stack: expect.any(String) }),
    )
    expect(screen.getByText('Что-то пошло не так')).toBeInTheDocument()
    consoleErrorSpy.mockRestore()
  })

  it('scrubs an axios error thrown during render — never forwards its (possibly backend-echoed) message', () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const axiosLikeError = Object.assign(
      new Error('Пользователь user@example.com уже зарегистрирован'),
      {
        isAxiosError: true,
        response: { status: 409, data: {} },
        config: { method: 'post', url: '/users?email=user@example.com' },
      },
    )

    render(
      <TelemetryErrorBoundary>
        <ThrowOnRender error={axiosLikeError} />
      </TelemetryErrorBoundary>,
    )

    expect(reportClientError).toHaveBeenCalledOnce()
    const [reportedMessage, reportedOpts] = vi.mocked(reportClientError).mock.calls[0] ?? []
    expect(reportedMessage).toBe('API error: POST /users → 409')
    // `sanitizeErrorForReport` drops the axios error's own `.stack`; what
    // reaches `reportClientError` here is React's OWN `info.componentStack`
    // fallback (component names only, never response-body content) — so we
    // assert on absence of the PII rather than a hardcoded `undefined`.
    expect(reportedOpts?.stack ?? '').not.toContain('user@example.com')
    consoleErrorSpy.mockRestore()
  })
})
