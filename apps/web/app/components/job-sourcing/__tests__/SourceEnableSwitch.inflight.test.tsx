/**
 * SourceEnableSwitch — the in-flight guard. The mutation hook is replaced by a double whose
 * `isPending` never flips, so the only thing that can stop a second request is the component's own
 * `inFlight` ref. (A real render re-disables the switch while pending, which hides the guard.)
 */
import type { ReactElement } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render as rtlRender, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { toast } from 'sonner'
import type { JobSourceOperationalRowDto } from '@crm/shared'
import { I18nTestProvider, loadCatalog } from '@/test/i18n'
import { useSetJobSourceEnabled } from '@/hooks/use-job-sourcing'
import { SourceEnableSwitch } from '../SourceAdminControls'

vi.mock('@/hooks/use-job-sourcing', () => ({ useSetJobSourceEnabled: vi.fn() }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const ID = '11111111-1111-4111-8111-111111111111'

const ROW: JobSourceOperationalRowDto = {
  id: ID,
  type: 'REMOTIVE_API',
  enabled: true,
  state: 'HEALTHY',
  reasonCode: null,
  lastCollectedAt: null,
  lastAttemptAt: null,
  lastSuccessAt: null,
  readiness: 'VERIFIED',
  readinessReason: null,
  consecutiveFailures: 0,
  cooldownUntil: null,
  newestItemPublishedAt: null,
  profileSummary: null,
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

type MutateOptions = { onError?: (e: unknown) => void; onSettled?: () => void }

function useDouble(mutate: (vars: unknown, opts?: MutateOptions) => void) {
  vi.mocked(useSetJobSourceEnabled).mockReturnValue({
    mutate,
    isPending: false,
  } as unknown as ReturnType<typeof useSetJobSourceEnabled>)
}

describe('SourceEnableSwitch — in-flight guard', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    await loadCatalog('en')
  })

  it('sends one request for two toggles while the first is still in flight', () => {
    const mutate = vi.fn()
    useDouble(mutate)
    render(<SourceEnableSwitch source={ROW} />)

    const sw = screen.getByRole('switch')
    fireEvent.click(sw)
    fireEvent.click(sw)

    expect(mutate).toHaveBeenCalledTimes(1)
    expect(mutate).toHaveBeenCalledWith({ id: ID, enabled: false }, expect.any(Object))
  })

  it('releases the guard once the request settles, so the next toggle is sent', () => {
    const mutate = vi.fn((_vars: unknown, opts?: MutateOptions) => opts?.onSettled?.())
    useDouble(mutate)
    render(<SourceEnableSwitch source={ROW} />)

    const sw = screen.getByRole('switch')
    fireEvent.click(sw)
    fireEvent.click(sw)

    expect(mutate).toHaveBeenCalledTimes(2)
  })

  it('shows the error toast when the mutation reports a failure', async () => {
    const mutate = vi.fn((_vars: unknown, opts?: MutateOptions) =>
      opts?.onError?.(new Error('boom')),
    )
    useDouble(mutate)
    render(<SourceEnableSwitch source={ROW} />)

    fireEvent.click(screen.getByRole('switch'))

    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1))
  })
})
