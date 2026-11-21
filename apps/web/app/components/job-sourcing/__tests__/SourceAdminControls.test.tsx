/**
 * SourceAdminControls: the admin list row's enable switch and "Reset failures" dialog.
 * The API is mocked; the hooks, the mutations and the toasts are real.
 */
import type { ReactElement } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render as rtlRender, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { toast } from 'sonner'
import type { JobSourceOperationalRowDto } from '@crm/shared'
import { I18nTestProvider, loadCatalog } from '@/test/i18n'
import { api } from '@/lib/axios'
import { SourceEnableSwitch, SourceResetFailures } from '../SourceAdminControls'

vi.mock('@/lib/axios', () => ({ api: { patch: vi.fn(), post: vi.fn() } }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const ID = '11111111-1111-4111-8111-111111111111'

function row(over: Partial<JobSourceOperationalRowDto> = {}): JobSourceOperationalRowDto {
  return {
    id: ID,
    type: 'REMOTIVE_API',
    enabled: true,
    state: 'HEALTHY',
    reasonCode: null,
    lastCollectedAt: null,
    lastAttemptAt: '2026-10-30T10:00:00.000Z',
    lastSuccessAt: '2026-10-30T10:00:00.000Z',
    readiness: 'VERIFIED',
    readinessReason: null,
    consecutiveFailures: 0,
    cooldownUntil: null,
    newestItemPublishedAt: null,
    profileSummary: null,
    ...over,
  }
}

function render(ui: ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return rtlRender(ui, {
    wrapper: ({ children }) => (
      <QueryClientProvider client={qc}>
        <I18nTestProvider>{children}</I18nTestProvider>
      </QueryClientProvider>
    ),
  })
}

describe('SourceEnableSwitch', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    await loadCatalog('en')
  })

  it('PATCHes the opposite enabled value and never shows an optimistic state', async () => {
    vi.mocked(api.patch).mockResolvedValue({
      data: { id: ID, enabled: false, changed: true, cancelledRuns: 0 },
    })
    render(<SourceEnableSwitch source={row({ enabled: true })} />)

    const sw = screen.getByRole('switch')
    expect(sw).toHaveAttribute('aria-checked', 'true')
    await userEvent.click(sw)

    expect(api.patch).toHaveBeenCalledWith(`/job-sourcing/sources/${ID}`, { enabled: false })
  })

  it('is disabled for a BLOCKED source and names its readiness reason', async () => {
    render(
      <SourceEnableSwitch
        source={row({ readiness: 'BLOCKED', readinessReason: 'NO_ADAPTER: no adapter wired' })}
      />,
    )

    const sw = screen.getByRole('switch')
    expect(sw).toBeDisabled()
    expect(screen.getByText(/Cannot enable/)).toBeInTheDocument()
    fireEvent.click(sw)
    expect(api.patch).not.toHaveBeenCalled()
  })

  it('joins every readiness code of a BLOCKED source into one reason, separated by "; "', () => {
    render(
      <SourceEnableSwitch
        source={row({
          readiness: 'BLOCKED',
          readinessReason: 'NO_ADAPTER: no adapter wired; KEY_REQUIRED: key missing',
        })}
      />,
    )

    expect(
      screen.getByText('Cannot enable: the source is not connected yet; an access key is required'),
    ).toBeInTheDocument()
  })

  it('names the state in its accessible label: "Collection on" when enabled, "Collection off" when not', () => {
    const { unmount } = render(<SourceEnableSwitch source={row({ enabled: true })} />)
    expect(screen.getByRole('switch', { name: 'Collection on' })).toBeInTheDocument()
    unmount()

    render(<SourceEnableSwitch source={row({ enabled: false })} />)
    expect(screen.getByRole('switch', { name: 'Collection off' })).toBeInTheDocument()
  })

  it('shows a toast with the API error text when the server refuses the write', async () => {
    vi.mocked(api.patch).mockRejectedValue({
      isAxiosError: true,
      response: { status: 409, data: { message: 'Source is blocked' } },
    })
    render(<SourceEnableSwitch source={row({ enabled: false })} />)

    await userEvent.click(screen.getByRole('switch'))

    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1))
    expect(vi.mocked(toast.error).mock.calls[0]?.[0]).toEqual(expect.any(String))
  })
})

describe('SourceResetFailures', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    await loadCatalog('en')
  })

  it('renders nothing while the failure cap is clear', () => {
    render(<SourceResetFailures source={row()} />)
    expect(screen.queryByRole('button', { name: 'Reset failures' })).not.toBeInTheDocument()
  })

  it('is offered when consecutive failures are above zero', () => {
    render(<SourceResetFailures source={row({ consecutiveFailures: 3 })} />)
    expect(screen.getByRole('button', { name: 'Reset failures' })).toBeInTheDocument()
  })

  it('is offered when a cooldown is set, even with no failures recorded', () => {
    render(<SourceResetFailures source={row({ cooldownUntil: '2026-10-31T10:00:00.000Z' })} />)
    expect(screen.getByRole('button', { name: 'Reset failures' })).toBeInTheDocument()
  })

  it('requires a non-blank reason before the reset is submitted', async () => {
    render(<SourceResetFailures source={row({ consecutiveFailures: 2 })} />)
    await userEvent.click(screen.getByRole('button', { name: 'Reset failures' }))

    const submit = screen.getByRole('button', { name: 'Reset' })
    expect(submit).toBeDisabled()
    await userEvent.type(screen.getByRole('textbox'), '   ')
    expect(submit).toBeDisabled()
    expect(api.post).not.toHaveBeenCalled()
  })

  it('POSTs the trimmed reason, then closes and confirms', async () => {
    vi.mocked(api.post).mockResolvedValue({ data: undefined })
    render(<SourceResetFailures source={row({ consecutiveFailures: 2 })} />)
    await userEvent.click(screen.getByRole('button', { name: 'Reset failures' }))
    await userEvent.type(screen.getByRole('textbox'), '  provider fixed its side  ')
    await userEvent.click(screen.getByRole('button', { name: 'Reset' }))

    await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(1))
    expect(api.post).toHaveBeenCalledWith(`/job-sourcing/admin/sources/${ID}/reset-failures`, {
      reason: 'provider fixed its side',
    })
  })

  it('shows a toast with the API error text when the reset is refused', async () => {
    vi.mocked(api.post).mockRejectedValue({
      isAxiosError: true,
      response: { status: 404, data: { message: 'Job source not found' } },
    })
    render(<SourceResetFailures source={row({ consecutiveFailures: 2 })} />)
    await userEvent.click(screen.getByRole('button', { name: 'Reset failures' }))
    await userEvent.type(screen.getByRole('textbox'), 'retry')
    await userEvent.click(screen.getByRole('button', { name: 'Reset' }))

    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1))
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('on success confirms with "Failures reset", closes the dialog and clears the reason', async () => {
    vi.mocked(api.post).mockResolvedValue({ data: undefined })
    render(<SourceResetFailures source={row({ consecutiveFailures: 2 })} />)
    await userEvent.click(screen.getByRole('button', { name: 'Reset failures' }))
    await userEvent.type(screen.getByRole('textbox'), 'provider fixed its side')
    await userEvent.click(screen.getByRole('button', { name: 'Reset' }))

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Failures reset'))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())

    await userEvent.click(screen.getByRole('button', { name: 'Reset failures' }))
    expect(screen.getByRole('textbox')).toHaveValue('')
  })

  it('does not submit a blank reason, even when the form is submitted directly', async () => {
    render(<SourceResetFailures source={row({ consecutiveFailures: 2 })} />)
    await userEvent.click(screen.getByRole('button', { name: 'Reset failures' }))
    await userEvent.type(screen.getByRole('textbox'), '   ')

    // A submit event on the textarea bubbles to the enclosing form, where React's onSubmit listens.
    fireEvent.submit(screen.getByRole('textbox'))

    expect(api.post).not.toHaveBeenCalled()
    expect(toast.error).not.toHaveBeenCalled()
    expect(toast.success).not.toHaveBeenCalled()
  })
})
