/**
 * SeniorAvailabilitySection (vacancy-queue design §5.2): reads GET /users/:id/availability, shows the
 * stored value, and PUTs the chosen one. The calendar popover is not driven here (DatePickerField
 * has its own tests); a stored day seeds the draft instead.
 */
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { I18nProvider } from '@lingui/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { i18n } from '@/lib/i18n'
import { SeniorAvailabilitySection } from '../SeniorAvailabilitySection'

vi.mock('@/lib/axios', () => ({ api: { get: vi.fn(), put: vi.fn() } }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import { api } from '@/lib/axios'
import { toast } from 'sonner'

const USER = '5a110014-0000-4000-bb00-0000000000a2'

function renderSection() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider i18n={i18n}>
        <SeniorAvailabilitySection userId={USER} />
      </I18nProvider>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('SeniorAvailabilitySection', () => {
  it('never set: «Не вказано», FREE without a day cannot be saved', async () => {
    vi.mocked(api.get).mockResolvedValue({ data: null })
    renderSection()
    expect(await screen.findByTestId('senior-availability-current')).toHaveTextContent('Не вказано')
    expect(vi.mocked(api.get)).toHaveBeenCalledWith(`/users/${USER}/availability`)
    expect(screen.getByTestId('senior-availability-from')).toBeInTheDocument()
    expect(screen.getByTestId('senior-availability-save')).toBeDisabled()
  })

  it('a stored FREE day is shown and seeds the draft; saving it PUTs the same value', async () => {
    const free = { status: 'FREE', availableFrom: '2026-11-01' }
    vi.mocked(api.get).mockResolvedValue({ data: free })
    vi.mocked(api.put).mockResolvedValue({ data: free })
    renderSection()
    expect(await screen.findByTestId('senior-availability-current')).toHaveTextContent(
      'Вільно з 1 листопада',
    )
    await userEvent.click(screen.getByTestId('senior-availability-save'))
    await waitFor(() =>
      expect(vi.mocked(api.put)).toHaveBeenCalledWith(`/users/${USER}/availability`, free),
    )
    expect(vi.mocked(toast.success)).toHaveBeenCalledWith('Доступність збережено')
  })

  it('switching to BUSY hides the day and PUTs {status: BUSY}; the stored value follows', async () => {
    vi.mocked(api.get).mockResolvedValue({ data: { status: 'FREE', availableFrom: '2026-11-01' } })
    vi.mocked(api.put).mockResolvedValue({ data: { status: 'BUSY' } })
    renderSection()
    await userEvent.click(await screen.findByTestId('senior-availability-status-busy'))
    expect(screen.queryByTestId('senior-availability-from')).toBeNull()
    await userEvent.click(screen.getByTestId('senior-availability-save'))
    await waitFor(() =>
      expect(screen.getByTestId('senior-availability-current')).toHaveTextContent('Зайнято'),
    )
    expect(vi.mocked(api.put)).toHaveBeenCalledWith(`/users/${USER}/availability`, {
      status: 'BUSY',
    })
  })

  it('a refused save keeps the stored value and toasts an error', async () => {
    vi.mocked(api.get).mockResolvedValue({ data: { status: 'BUSY' } })
    vi.mocked(api.put).mockRejectedValue(new Error('403'))
    renderSection()
    await userEvent.click(await screen.findByTestId('senior-availability-save'))
    await waitFor(() =>
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
        'Не вдалося зберегти доступність. Спробуйте ще раз',
      ),
    )
    expect(screen.getByTestId('senior-availability-current')).toHaveTextContent('Зайнято')
  })

  it('a failed read shows an alert, not a form', async () => {
    vi.mocked(api.get).mockRejectedValue(new Error('500'))
    renderSection()
    expect(await screen.findByRole('alert')).toHaveTextContent('Не вдалося завантажити доступність')
    expect(screen.queryByTestId('senior-availability-save')).toBeNull()
  })
})
