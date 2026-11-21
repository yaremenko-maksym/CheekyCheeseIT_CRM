/**
 * SourceAdminControls: the admin list row's enable switch and "Reset failures" dialog.
 * The API is mocked; the hooks, the mutations and the toasts are real.
 */
import type { ReactElement } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render as rtlRender, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { toast } from 'sonner'
import type { JobSourceOperationalRowDto } from '@crm/shared'
import { I18nTestProvider, loadCatalog } from '@/test/i18n'
import { api } from '@/lib/axios'
import { jobSourceHealthQueryKey } from '@/hooks/use-job-source-admin'
import { SourceEnableHint, SourceEnableSwitch, SourceResetFailures } from '../SourceAdminControls'

vi.mock('@/lib/axios', () => ({ api: { patch: vi.fn(), post: vi.fn() } }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const ID = '11111111-1111-4111-8111-111111111111'
// REMOTIVE_API's display name (`sourceLabel`) plus the row's short id: the accessible name of both
// controls, unique even when several rows share one source type.
const SOURCE = 'Remotive (11111111)'

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

function render(
  ui: ReactElement,
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
) {
  return rtlRender(ui, {
    wrapper: ({ children }) => (
      <QueryClientProvider client={qc}>
        <I18nTestProvider>{children}</I18nTestProvider>
      </QueryClientProvider>
    ),
  })
}

const BLOCKED = { readiness: 'BLOCKED' as const, readinessReason: 'NO_ADAPTER: no adapter wired' }

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

    const sw = screen.getByRole('switch', { name: SOURCE })
    expect(sw).toHaveAttribute('aria-checked', 'true')
    await userEvent.click(sw)

    expect(api.patch).toHaveBeenCalledWith(`/job-sourcing/sources/${ID}`, { enabled: false })
  })

  it('lets an enabled BLOCKED source be switched off', async () => {
    vi.mocked(api.patch).mockResolvedValue({
      data: { id: ID, enabled: false, changed: true, cancelledRuns: 0 },
    })
    render(<SourceEnableSwitch source={row({ enabled: true, ...BLOCKED })} />)

    const sw = screen.getByRole('switch', { name: SOURCE })
    expect(sw).not.toHaveAttribute('aria-disabled')
    expect(sw).not.toHaveAttribute('aria-describedby')
    expect(screen.queryByText(/Cannot enable/)).not.toBeInTheDocument()
    await userEvent.click(sw)

    expect(api.patch).toHaveBeenCalledWith(`/job-sourcing/sources/${ID}`, { enabled: false })
  })

  it('keeps a disabled BLOCKED source inert and points its switch at the reason', async () => {
    const source = row({ enabled: false, ...BLOCKED })
    render(
      <>
        <SourceEnableSwitch source={source} hintId="hint" />
        <SourceEnableHint source={source} id="hint" />
      </>,
    )

    const sw = screen.getByRole('switch', { name: SOURCE })
    const hint = screen.getByText(/Cannot enable/)
    expect(sw).toHaveAttribute('aria-disabled', 'true')
    expect(sw).toHaveAttribute('aria-describedby', hint.id)
    fireEvent.click(sw)
    expect(api.patch).not.toHaveBeenCalled()
  })

  it('sends the enable of an off, not blocked source and shows no hint', async () => {
    vi.mocked(api.patch).mockResolvedValue({
      data: { id: ID, enabled: true, changed: true, cancelledRuns: 0 },
    })
    render(<SourceEnableSwitch source={row({ enabled: false })} />)

    const sw = screen.getByRole('switch', { name: SOURCE })
    expect(sw).not.toHaveAttribute('aria-describedby')
    await userEvent.click(sw)

    expect(api.patch).toHaveBeenCalledWith(`/job-sourcing/sources/${ID}`, { enabled: true })
  })

  it('joins every readiness code of a BLOCKED source into one reason, separated by "; "', () => {
    render(
      <SourceEnableHint
        id="hint"
        source={row({
          enabled: false,
          readiness: 'BLOCKED',
          readinessReason: 'NO_ADAPTER: no adapter wired; KEY_REQUIRED: key missing',
        })}
      />,
    )

    expect(
      screen.getByText('Cannot enable: the source is not connected yet; an access key is required'),
    ).toBeInTheDocument()
  })

  it('keeps aria-checked on the server value while the write is pending, and sends no second write', async () => {
    let settle!: (value: unknown) => void
    vi.mocked(api.patch).mockReturnValue(new Promise((resolve) => (settle = resolve)) as never)
    render(<SourceEnableSwitch source={row({ enabled: true })} />)

    const sw = screen.getByRole('switch', { name: SOURCE })
    await userEvent.click(sw)

    expect(sw).toHaveAttribute('aria-checked', 'true')
    expect(sw).toHaveAttribute('aria-disabled', 'true')
    await userEvent.click(sw)
    expect(api.patch).toHaveBeenCalledTimes(1)
    await act(async () => settle({ data: { id: ID, enabled: false, changed: true } }))
  })

  it('shows the readiness-refusal text in a toast and leaves the switch where it was', async () => {
    vi.mocked(api.patch).mockRejectedValue({
      isAxiosError: true,
      response: {
        status: 409,
        data: { statusCode: 409, code: 'JOB_SOURCE_NOT_READY', message: 'Source is not ready' },
      },
    })
    render(<SourceEnableSwitch source={row({ enabled: false })} />)

    const sw = screen.getByRole('switch', { name: SOURCE })
    await userEvent.click(sw)

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        'The source is not ready yet: finish its setup (readiness check, connection, quota meter), then switch it on',
      ),
    )
    expect(sw).toHaveAttribute('aria-checked', 'false')
  })

  it('renders no hint for a source that can be enabled, nor for an enabled BLOCKED one', () => {
    const { container, unmount } = render(<SourceEnableHint source={row()} id="hint" />)
    expect(container).toBeEmptyDOMElement()
    unmount()
    const blockedOn = render(
      <SourceEnableHint source={row({ enabled: true, ...BLOCKED })} id="hint" />,
    )
    expect(blockedOn.container).toBeEmptyDOMElement()
  })

  it('says "Blocked" when a BLOCKED source carries no readiness reason', () => {
    render(
      <SourceEnableHint
        source={row({ enabled: false, readiness: 'BLOCKED', readinessReason: null })}
        id="hint"
      />,
    )
    expect(screen.getByText('Blocked')).toHaveAttribute('id', 'hint')
  })

  it('gives rows of one source type distinct accessible names', () => {
    render(
      <>
        <SourceEnableSwitch source={row()} />
        <SourceEnableSwitch source={row({ id: '22222222-2222-4222-8222-222222222222' })} />
      </>,
    )
    expect(screen.getByRole('switch', { name: 'Remotive (11111111)' })).toBeInTheDocument()
    expect(screen.getByRole('switch', { name: 'Remotive (22222222)' })).toBeInTheDocument()
  })

  it('refetches the sources list after a refused enable so the row shows the server state', async () => {
    vi.mocked(api.patch).mockRejectedValue({
      isAxiosError: true,
      response: {
        status: 409,
        data: { statusCode: 409, code: 'JOB_SOURCE_NOT_READY', message: 'Source is not ready' },
      },
    })
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const invalidate = vi.spyOn(qc, 'invalidateQueries')
    render(<SourceEnableSwitch source={row({ enabled: false })} />, qc)

    await userEvent.click(screen.getByRole('switch', { name: SOURCE }))

    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({ queryKey: jobSourceHealthQueryKey }),
    )
    expect(toast.error).toHaveBeenCalledTimes(1)
  })

  it('names the source in its accessible name and shows the state as text', () => {
    const { unmount } = render(<SourceEnableSwitch source={row({ enabled: true })} />)
    expect(screen.getByRole('switch', { name: SOURCE })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByText('Running')).toBeInTheDocument()
    unmount()

    render(<SourceEnableSwitch source={row({ enabled: false })} />)
    expect(screen.getByRole('switch', { name: SOURCE })).toHaveAttribute('aria-checked', 'false')
    expect(screen.getByText('Disabled')).toBeInTheDocument()
  })

  it('shows a toast with the API error text when the server refuses the write', async () => {
    vi.mocked(api.patch).mockRejectedValue({
      isAxiosError: true,
      response: { status: 409, data: { message: 'Source is blocked' } },
    })
    render(<SourceEnableSwitch source={row({ enabled: false })} />)

    await userEvent.click(screen.getByRole('switch', { name: SOURCE }))

    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1))
    expect(vi.mocked(toast.error).mock.calls[0]?.[0]).toEqual(expect.any(String))
  })
})

describe('SourceResetFailures', () => {
  const TRIGGER = `Reset failures: ${SOURCE}`

  beforeEach(async () => {
    vi.clearAllMocks()
    await loadCatalog('en')
  })

  it('renders nothing while the failure cap is clear', () => {
    render(<SourceResetFailures source={row()} />)
    expect(screen.queryByRole('button', { name: TRIGGER })).not.toBeInTheDocument()
  })

  it('is offered when consecutive failures are above zero', () => {
    render(<SourceResetFailures source={row({ consecutiveFailures: 3 })} />)
    expect(screen.getByRole('button', { name: TRIGGER })).toBeInTheDocument()
  })

  it('keeps a 44 px hit area at every width without growing the visible trigger', () => {
    render(<SourceResetFailures source={row({ consecutiveFailures: 3 })} />)
    const trigger = screen.getByRole('button', { name: TRIGGER })
    // jsdom has no layout: the hit area is the `::after` box, 44 px (h-11) tall, centred on the button.
    expect(trigger).toHaveClass('relative', 'after:absolute', 'after:h-11', 'after:inset-x-0')
    expect(trigger).toHaveClass('min-h-11', 'sm:min-h-9')
  })

  it('is offered when a cooldown is set, even with no failures recorded', () => {
    render(<SourceResetFailures source={row({ cooldownUntil: '2026-10-31T10:00:00.000Z' })} />)
    expect(screen.getByRole('button', { name: TRIGGER })).toBeInTheDocument()
  })

  it('names the source in the dialog title and says what the reset clears', async () => {
    render(<SourceResetFailures source={row({ consecutiveFailures: 2 })} />)
    await userEvent.click(screen.getByRole('button', { name: TRIGGER }))

    const dialog = screen.getByRole('dialog', { name: `Reset source failures: ${SOURCE}` })
    expect(dialog).toHaveTextContent(
      'The failure counter and cooldown will be cleared. Collection resumes on schedule. Give a reason: it is written to the log.',
    )
  })

  it('requires a non-blank reason before the reset is submitted', async () => {
    render(<SourceResetFailures source={row({ consecutiveFailures: 2 })} />)
    await userEvent.click(screen.getByRole('button', { name: TRIGGER }))

    const submit = screen.getByRole('button', { name: 'Reset' })
    expect(submit).toBeDisabled()
    await userEvent.type(screen.getByRole('textbox'), '   ')
    expect(submit).toBeDisabled()
    expect(api.post).not.toHaveBeenCalled()
  })

  it('POSTs the trimmed reason, then closes and confirms', async () => {
    vi.mocked(api.post).mockResolvedValue({ data: undefined })
    render(<SourceResetFailures source={row({ consecutiveFailures: 2 })} />)
    await userEvent.click(screen.getByRole('button', { name: TRIGGER }))
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
    await userEvent.click(screen.getByRole('button', { name: TRIGGER }))
    await userEvent.type(screen.getByRole('textbox'), 'retry')
    await userEvent.click(screen.getByRole('button', { name: 'Reset' }))

    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1))
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('on success confirms with "Failures reset", closes the dialog and clears the reason', async () => {
    vi.mocked(api.post).mockResolvedValue({ data: undefined })
    render(<SourceResetFailures source={row({ consecutiveFailures: 2 })} />)
    await userEvent.click(screen.getByRole('button', { name: TRIGGER }))
    await userEvent.type(screen.getByRole('textbox'), 'provider fixed its side')
    await userEvent.click(screen.getByRole('button', { name: 'Reset' }))

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Failures reset'))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())

    await userEvent.click(screen.getByRole('button', { name: TRIGGER }))
    expect(screen.getByRole('textbox')).toHaveValue('')
  })

  it('does not submit a blank reason, even when the form is submitted directly', async () => {
    render(<SourceResetFailures source={row({ consecutiveFailures: 2 })} />)
    await userEvent.click(screen.getByRole('button', { name: TRIGGER }))
    await userEvent.type(screen.getByRole('textbox'), '   ')

    // A submit event on the textarea bubbles to the enclosing form, where React's onSubmit listens.
    fireEvent.submit(screen.getByRole('textbox'))
    // A mutation that ran anyway would fail its schema parse asynchronously: let that settle first.
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)))

    expect(api.post).not.toHaveBeenCalled()
    expect(toast.error).not.toHaveBeenCalled()
    expect(toast.success).not.toHaveBeenCalled()
  })
})
