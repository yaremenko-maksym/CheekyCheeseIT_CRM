/**
 * SeniorAvailabilitySection (vacancy-queue design §5.2): reads GET /users/:id/availability, shows the
 * stored value, and PUTs the chosen one. The calendar popover is not driven here (DatePickerField
 * has its own tests); a stored day seeds the draft instead.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { setupI18n } from '@lingui/core'
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

// far future: a FREE day that is today or past reads as plain «Вільно» (see the label)
const FUTURE = '2099-11-01'

function renderSection(i18nInstance = i18n, userIds: string[] = [USER]) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider i18n={i18nInstance}>
        {userIds.map((id) => (
          <SeniorAvailabilitySection key={id} userId={id} />
        ))}
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
    const free = { status: 'FREE', availableFrom: FUTURE }
    vi.mocked(api.get).mockResolvedValue({ data: free })
    vi.mocked(api.put).mockResolvedValue({ data: free })
    renderSection()
    // §5.2: a short month («1 лист.»), not the full «1 листопада» (SPEC-L-1)
    expect(await screen.findByTestId('senior-availability-current')).toHaveTextContent(
      /^Вільно з 1 лист\.$/,
    )
    await userEvent.click(screen.getByTestId('senior-availability-save'))
    await waitFor(() =>
      expect(vi.mocked(api.put)).toHaveBeenCalledWith(`/users/${USER}/availability`, free),
    )
    expect(vi.mocked(toast.success)).toHaveBeenCalledWith('Доступність збережено')
  })

  it('switching to BUSY hides the day and PUTs {status: BUSY}; the stored value follows', async () => {
    vi.mocked(api.get).mockResolvedValue({ data: { status: 'FREE', availableFrom: FUTURE } })
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
        'Не вдалося зберегти доступність. Спробуйте ще раз.',
      ),
    )
    expect(screen.getByTestId('senior-availability-current')).toHaveTextContent('Зайнято')
  })

  it('a stored FREE day already past reads as free now: plain «Вільно», no stale day', async () => {
    vi.mocked(api.get).mockResolvedValue({ data: { status: 'FREE', availableFrom: '2020-01-01' } })
    renderSection()
    const current = await screen.findByTestId('senior-availability-current')
    expect(current).toHaveTextContent(/^Вільно$/)
    expect(within(current).getByText('Вільно')).toHaveAttribute('data-availability', 'FREE')
  })

  it('English: the FREE option and a past day read «Available», never the resume «Relaxed» (COPY-H-1)', async () => {
    const { messages } = (await import('@crm/shared-i18n-locales/en/messages.po')) as {
      messages: Record<string, string>
    }
    const en = setupI18n({ locale: 'en', messages: { en: messages } })
    vi.mocked(api.get).mockResolvedValue({ data: { status: 'FREE', availableFrom: '2020-01-01' } })
    renderSection(en)
    expect(await screen.findByTestId('senior-availability-current')).toHaveTextContent(
      /^Available$/,
    )
    expect(screen.getByTestId('senior-availability-status-free')).toHaveTextContent('Available')
    expect(screen.getByTestId('senior-availability-status-busy')).toHaveTextContent('Busy')
    expect(screen.queryByText('Relaxed')).toBeNull()
  })

  it('while the read is pending: a loading line, then the value, never an alert', async () => {
    let resolve: (v: { data: unknown }) => void = () => undefined
    vi.mocked(api.get).mockReturnValue(new Promise((r) => (resolve = r)))
    renderSection()
    expect(await screen.findByText('Завантаження…')).toBeInTheDocument()
    expect(screen.queryByTestId('senior-availability-save')).toBeNull()
    resolve({ data: { status: 'BUSY' } })
    expect(await screen.findByTestId('senior-availability-current')).toHaveTextContent('Зайнято')
    expect(screen.queryByText('Завантаження…')).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('each senior keeps their own value: two sections on one page do not share a cache entry', async () => {
    const OTHER = '5a110014-0000-4000-bb00-0000000000a3'
    vi.mocked(api.get).mockImplementation((url: string) =>
      Promise.resolve({
        data: url.includes(OTHER) ? { status: 'BUSY' } : { status: 'FREE', availableFrom: FUTURE },
      }),
    )
    renderSection(i18n, [USER, OTHER])
    await waitFor(() =>
      expect(screen.getAllByTestId('senior-availability-current')).toHaveLength(2),
    )
    const [first, second] = screen.getAllByTestId('senior-availability-current')
    expect(first).toHaveTextContent(/^Вільно з 1 лист\.$/)
    expect(second).toHaveTextContent(/^Зайнято$/)
  })

  it('the toggle is a named radio group; choosing «Вільно» from BUSY asks for the day', async () => {
    vi.mocked(api.get).mockResolvedValue({ data: { status: 'BUSY' } })
    renderSection()
    expect(await screen.findByRole('radiogroup', { name: 'Доступність' })).toBeInTheDocument()
    expect(screen.queryByTestId('senior-availability-from')).toBeNull()
    await userEvent.click(screen.getByTestId('senior-availability-status-free'))
    expect(screen.getByTestId('senior-availability-status-free')).toHaveAttribute(
      'aria-checked',
      'true',
    )
    expect(screen.getByTestId('senior-availability-from')).toBeInTheDocument()
    expect(screen.getByTestId('senior-availability-save')).toBeDisabled()
  })

  it('submitting FREE without a day (e.g. Enter in the form) sends nothing', async () => {
    vi.mocked(api.get).mockResolvedValue({ data: null })
    renderSection()
    fireEvent.submit(await screen.findByTestId('senior-availability-save'))
    await new Promise((r) => setTimeout(r, 0))
    expect(vi.mocked(api.put)).not.toHaveBeenCalled()
  })

  it('a failed read shows an alert, not a form', async () => {
    vi.mocked(api.get).mockRejectedValue(new Error('500'))
    renderSection()
    expect(await screen.findByRole('alert')).toHaveTextContent('Не вдалося завантажити доступність')
    expect(screen.queryByTestId('senior-availability-save')).toBeNull()
  })
})
