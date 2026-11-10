import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { formatRelativeTime, type JobSourceDto } from '@crm/shared'
import { I18nTestProvider, loadCatalog } from '@/test/i18n'

/**
 * Task 7.5 — the ADMIN source switch in `SourceBudgetPanel`.
 * Real hooks over a mocked axios: the request body, the refetch and the rollback are what the
 * ADMIN relies on, so they are asserted at the wire, not behind a hook mock.
 */
vi.mock('@/lib/axios', () => ({ api: { get: vi.fn(), patch: vi.fn() } }))

import { api } from '@/lib/axios'
import { getUserFacingErrorMessage } from '@/lib/axios-utils'
import { SourceBudgetPanel } from '../SourceBudgetPanel'

const NOW = new Date('2026-11-10T12:00:00.000Z')
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString()
const ahead = (ms: number) => new Date(NOW.getTime() + ms).toISOString()
const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

const ID_A = '55555555-5555-4555-8555-555555555555'
const ID_B = '66666666-6666-4666-8666-666666666666'

const source = (over: Partial<JobSourceDto> = {}): JobSourceDto => ({
  id: ID_A,
  type: 'DOU_RSS',
  enabled: true,
  triggerMode: 'SCHEDULED',
  lastCollectedAt: ago(12 * MIN),
  disabledReason: null,
  budget: {
    state: 'ACTIVE',
    limit: 500,
    window: 'MONTH',
    used: 232,
    remaining: 268,
    resetsAt: null,
  },
  readiness: 'VERIFIED',
  readinessReason: null,
  adminState: 'ACTIVE',
  lastAttemptAt: ago(12 * MIN),
  lastSuccessAt: ago(12 * MIN),
  lastNonemptyAt: ago(3 * HOUR),
  cooldownUntil: null,
  hostPausedUntil: null,
  hostPauseReason: null,
  lastErrorCode: null,
  ...over,
})

let listed: JobSourceDto[] = []

function renderPanel(props: { canView?: boolean; collapsible?: boolean } = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <I18nTestProvider>
      <QueryClientProvider client={queryClient}>
        <SourceBudgetPanel
          canView={props.canView ?? true}
          collapsible={props.collapsible ?? false}
        />
      </QueryClientProvider>
    </I18nTestProvider>,
  )
}

const sourceGets = () =>
  vi.mocked(api.get).mock.calls.filter(([url]) => url === '/job-sourcing/sources').length

beforeEach(async () => {
  await loadCatalog('uk')
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  listed = [source()]
  vi.mocked(api.get).mockReset()
  vi.mocked(api.patch).mockReset()
  vi.mocked(api.get).mockImplementation((async () => ({ data: { items: listed } })) as never)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('AC1 — the switch sends the inverted value, once, and refetches', () => {
  it('turns an enabled source off with exactly { enabled: false }, then refetches the list', async () => {
    vi.mocked(api.patch).mockResolvedValue({
      data: { id: ID_A, enabled: false, changed: true, cancelledRuns: 0 },
    })
    renderPanel()
    const toggle = await screen.findByRole('switch', { name: 'DOU' })
    expect(toggle).toHaveAttribute('aria-checked', 'true')
    expect(sourceGets()).toBe(1)

    listed = [source({ enabled: false })]
    await act(async () => {
      fireEvent.click(toggle)
    })

    expect(api.patch).toHaveBeenCalledTimes(1)
    expect(api.patch).toHaveBeenCalledWith(`/job-sourcing/sources/${ID_A}`, { enabled: false })
    await waitFor(() => expect(sourceGets()).toBe(2))
    await waitFor(() =>
      expect(screen.getByRole('switch', { name: 'DOU' })).toHaveAttribute('aria-checked', 'false'),
    )
  })

  it('turns a disabled source on with exactly { enabled: true }', async () => {
    listed = [source({ enabled: false })]
    vi.mocked(api.patch).mockResolvedValue({
      data: { id: ID_A, enabled: true, changed: true, cancelledRuns: 0 },
    })
    renderPanel()
    const toggle = await screen.findByRole('switch', { name: 'DOU' })
    expect(toggle).toHaveAttribute('aria-checked', 'false')

    await act(async () => {
      fireEvent.click(toggle)
    })

    expect(api.patch).toHaveBeenCalledTimes(1)
    expect(api.patch).toHaveBeenCalledWith(`/job-sourcing/sources/${ID_A}`, { enabled: true })
  })

  it('sends ONE request when the switch is activated twice before the answer', async () => {
    vi.mocked(api.patch).mockReturnValue(new Promise(() => {}) as never)
    renderPanel()
    const toggle = await screen.findByRole('switch', { name: 'DOU' })

    await act(async () => {
      fireEvent.click(toggle)
      fireEvent.click(toggle)
    })

    expect(api.patch).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(toggle).toBeDisabled())
  })

  it('only the toggled source is sent; the other one is untouched', async () => {
    listed = [source(), source({ id: ID_B, type: 'DJINNI_RSS' })]
    vi.mocked(api.patch).mockResolvedValue({
      data: { id: ID_B, enabled: false, changed: true, cancelledRuns: 0 },
    })
    renderPanel()
    const toggle = await screen.findByRole('switch', { name: 'Djinni' })

    await act(async () => {
      fireEvent.click(toggle)
    })

    expect(api.patch).toHaveBeenCalledTimes(1)
    expect(api.patch).toHaveBeenCalledWith(`/job-sourcing/sources/${ID_B}`, { enabled: false })
  })

  it('gives the switch a 44 px hit area', async () => {
    renderPanel()
    const toggle = await screen.findByRole('switch', { name: 'DOU' })
    expect(toggle.className).toContain('after:size-11')
  })
})

describe('AC2 — disabled, paused and blocked are three different states', () => {
  const chip = () => screen.getByTestId('job-source-state-chip')
  const note = () => screen.getByTestId('job-source-state-note')

  it('running: a check chip and no explanation line', async () => {
    renderPanel()
    await screen.findByRole('switch', { name: 'DOU' })
    expect(chip()).toHaveTextContent('Працює')
    expect(chip()).toHaveAttribute('data-state', 'running')
    expect(screen.queryByTestId('job-source-state-note')).toBeNull()
  })

  it('disabled by the admin: secondary chip with its plain explanation', async () => {
    listed = [source({ enabled: false })]
    renderPanel()
    await screen.findByRole('switch', { name: 'DOU' })
    expect(chip()).toHaveTextContent('Вимкнено')
    expect(chip()).toHaveAttribute('data-state', 'disabled')
    expect(note()).toHaveTextContent('Вимкнено адміністратором')
  })

  it('paused by a cooldown with a 429: names the time and the reason', async () => {
    const until = ahead(2 * HOUR)
    listed = [source({ cooldownUntil: until, lastErrorCode: 'HTTP_429' })]
    renderPanel()
    await screen.findByRole('switch', { name: 'DOU' })
    const time = new Date(until).toLocaleTimeString('uk', { hour: '2-digit', minute: '2-digit' })
    expect(chip()).toHaveTextContent('Призупинено')
    expect(chip()).toHaveAttribute('data-state', 'paused')
    expect(note()).toHaveTextContent(`Пауза до ${time}: джерело просило зачекати (429)`)
  })

  it('paused by a host ban with a challenge: names the challenge', async () => {
    listed = [source({ hostPausedUntil: ahead(HOUR), hostPauseReason: 'CHALLENGE_DETECTED' })]
    renderPanel()
    await screen.findByRole('switch', { name: 'DOU' })
    expect(chip()).toHaveAttribute('data-state', 'paused')
    expect(note()).toHaveTextContent('джерело вимагає перевірки (challenge)')
  })

  it('paused with an unknown code: shows the code, not a guess', async () => {
    listed = [source({ cooldownUntil: ahead(HOUR), lastErrorCode: 'HTTP_503' })]
    renderPanel()
    await screen.findByRole('switch', { name: 'DOU' })
    expect(note()).toHaveTextContent('код HTTP_503')
  })

  it('paused by the admin state without a time: says so', async () => {
    listed = [source({ adminState: 'PAUSED' })]
    renderPanel()
    await screen.findByRole('switch', { name: 'DOU' })
    expect(chip()).toHaveAttribute('data-state', 'paused')
    expect(note().textContent).toBe('Пауза без визначеного часу')
  })

  it('a cooldown already in the past is NOT a pause', async () => {
    listed = [source({ cooldownUntil: ago(MIN), hostPausedUntil: ago(MIN) })]
    renderPanel()
    await screen.findByRole('switch', { name: 'DOU' })
    expect(chip()).toHaveAttribute('data-state', 'running')
  })

  it('readiness-blocked: destructive chip with the readiness reason, even while switched off', async () => {
    listed = [
      source({ enabled: false, readiness: 'BLOCKED', readinessReason: 'сплив термін авторизації' }),
    ]
    renderPanel()
    await screen.findByRole('switch', { name: 'DOU' })
    expect(chip()).toHaveTextContent('Заблоковано')
    expect(chip()).toHaveAttribute('data-state', 'blocked')
    expect(note()).toHaveTextContent('Не готове: сплив термін авторизації')
  })

  it('a retired source reads as disabled', async () => {
    listed = [source({ adminState: 'RETIRED' })]
    renderPanel()
    await screen.findByRole('switch', { name: 'DOU' })
    expect(chip()).toHaveAttribute('data-state', 'disabled')
  })

  it('the three states carry three different icons and words', async () => {
    listed = [
      source({ id: ID_A, enabled: false }),
      source({ id: ID_B, type: 'DJINNI_RSS', cooldownUntil: ahead(HOUR) }),
      source({
        id: '77777777-7777-4777-8777-777777777777',
        type: 'REED_API',
        readiness: 'BLOCKED',
        readinessReason: 'політика',
      }),
    ]
    renderPanel()
    await screen.findByRole('switch', { name: 'DOU' })
    const chips = screen.getAllByTestId('job-source-state-chip')
    expect(chips.map((c) => c.textContent)).toEqual(['Вимкнено', 'Призупинено', 'Заблоковано'])
    const icons = screen
      .getAllByTestId('job-source-state-chip')
      .map((c) => c.getAttribute('data-icon'))
    expect(new Set(icons).size).toBe(3)
  })
})

describe('AC3 — quota bar', () => {
  it('draws used over the limit as a role=img whose label carries the numbers', async () => {
    renderPanel()
    await screen.findByRole('switch', { name: 'DOU' })
    const bar = screen.getByRole('img', { name: 'Використано 232 з 500' })
    expect(within(bar).getByTestId('job-source-quota-used')).toHaveStyle({ width: '46.4%' })
    expect(screen.getByTestId('job-source-quota-legend')).toHaveTextContent('Використано 232')
  })

  it('caps an overspent window at 100 %', async () => {
    listed = [
      source({
        budget: {
          state: 'EXHAUSTED',
          limit: 200,
          window: 'MONTH',
          used: 260,
          remaining: 0,
          resetsAt: null,
        },
      }),
    ]
    renderPanel()
    await screen.findByRole('switch', { name: 'DOU' })
    expect(screen.getByTestId('job-source-quota-used')).toHaveStyle({ width: '100%' })
  })

  it('draws no bar for an unlimited or a misconfigured source', async () => {
    listed = [
      source({
        budget: {
          state: 'UNLIMITED',
          limit: null,
          window: null,
          used: 4,
          remaining: null,
          resetsAt: null,
        },
      }),
      source({
        id: ID_B,
        type: 'DJINNI_RSS',
        budget: {
          state: 'MISCONFIGURED',
          limit: 0,
          window: null,
          used: 0,
          remaining: 0,
          resetsAt: null,
        },
      }),
    ]
    renderPanel()
    await screen.findByRole('switch', { name: 'DOU' })
    expect(screen.queryByRole('img')).toBeNull()
  })
})

describe('AC4 — timestamps', () => {
  const stamps = () => screen.getByTestId('job-source-timestamps')
  // <dt>/<dd> pairs by position: a value counts only if it sits at its label's index.
  const valueOf = (label: string) => {
    const terms = within(stamps())
      .getAllByRole('term')
      .map((el) => el.textContent)
    return within(stamps()).getAllByRole('definition')[terms.indexOf(label)]?.textContent
  }

  it('shows the three attempts relative, each under its own label', async () => {
    listed = [
      source({
        lastAttemptAt: ago(12 * MIN),
        lastSuccessAt: ago(2 * HOUR),
        lastNonemptyAt: ago(6 * DAY),
      }),
    ]
    renderPanel()
    await screen.findByRole('switch', { name: 'DOU' })
    // Same shared formatter as the queue rows; three different ages prove each value sits under
    // its own label.
    expect(valueOf('Остання спроба')).toBe(formatRelativeTime(ago(12 * MIN), 'uk'))
    expect(valueOf('Остання вдала')).toBe(formatRelativeTime(ago(2 * HOUR), 'uk'))
    expect(valueOf('Остання з даними')).toBe(formatRelativeTime(ago(6 * DAY), 'uk'))
    expect(
      new Set([12 * MIN, 2 * HOUR, 6 * DAY].map((ms) => formatRelativeTime(ago(ms), 'uk'))).size,
    ).toBe(3)
  })

  it('says «ніколи» for a null — and for a field an older server does not send', async () => {
    listed = [source({ lastAttemptAt: null, lastSuccessAt: null, lastNonemptyAt: undefined })]
    renderPanel()
    await screen.findByRole('switch', { name: 'DOU' })
    expect(valueOf('Остання спроба')).toBe('ніколи')
    expect(valueOf('Остання вдала')).toBe('ніколи')
    expect(valueOf('Остання з даними')).toBe('ніколи')
  })

  it('is one column on mobile and three from a 560 px container', async () => {
    renderPanel()
    await screen.findByRole('switch', { name: 'DOU' })
    expect(stamps().tagName).toBe('DL')
    expect(stamps().className).toContain('grid-cols-1')
    expect(stamps().className).toContain('@min-[560px]:grid-cols-3')
  })
})

describe('AC5 — a refused enable', () => {
  const blocked = () =>
    source({
      enabled: false,
      readiness: 'BLOCKED',
      readinessReason: 'сплив термін авторизації',
      budget: {
        state: 'ACTIVE',
        limit: 400,
        window: 'DAY',
        used: 310,
        remaining: 90,
        resetsAt: null,
      },
    })

  it('shows the readiness reason, puts the switch back and changes nothing else', async () => {
    listed = [blocked()]
    vi.mocked(api.patch).mockRejectedValue(new Error('409'))
    renderPanel()
    const toggle = await screen.findByRole('switch', { name: 'DOU' })
    const before = screen.getByTestId('job-source-card').textContent
    const getsBefore = sourceGets()

    await act(async () => {
      fireEvent.click(toggle)
    })

    const failure = await screen.findByTestId('job-source-enable-failure')
    expect(failure).toHaveAttribute('role', 'alert')
    expect(failure).toHaveTextContent('Не вдалося увімкнути')
    expect(failure).toHaveTextContent('Причина: сплив термін авторизації. Стан не змінено.')
    expect(screen.getByRole('switch', { name: 'DOU' })).toHaveAttribute('aria-checked', 'false')
    expect(screen.getByRole('switch', { name: 'DOU' })).not.toBeDisabled()
    // policy / cost state untouched: same chip, same note, same budget line, same bar, no refetch
    expect(screen.getByTestId('job-source-state-chip')).toHaveTextContent('Заблоковано')
    expect(screen.getByTestId('job-source-budget-remaining')).toHaveTextContent(
      'Осталось 90 из 400',
    )
    expect(screen.getByRole('img', { name: 'Використано 310 з 400' })).toBeInTheDocument()
    expect(screen.getByTestId('job-source-card').textContent).toBe(before + failure.textContent)
    expect(sourceGets()).toBe(getsBefore)
  })

  it('falls back to the server answer when the source states no readiness reason', async () => {
    listed = [source({ enabled: false })]
    const error = new Error('409')
    vi.mocked(api.patch).mockRejectedValue(error)
    renderPanel()
    const toggle = await screen.findByRole('switch', { name: 'DOU' })

    await act(async () => {
      fireEvent.click(toggle)
    })

    expect(await screen.findByTestId('job-source-enable-failure')).toHaveTextContent(
      `Причина: ${getUserFacingErrorMessage(error)}. Стан не змінено.`,
    )
  })

  it('a failed DISABLE is not worded as an enable failure', async () => {
    vi.mocked(api.patch).mockRejectedValue(new Error('500'))
    renderPanel()
    const toggle = await screen.findByRole('switch', { name: 'DOU' })

    await act(async () => {
      fireEvent.click(toggle)
    })

    const failure = await screen.findByTestId('job-source-enable-failure')
    expect(failure).toHaveTextContent('Не вдалося вимкнути')
    expect(screen.getByRole('switch', { name: 'DOU' })).toHaveAttribute('aria-checked', 'true')
  })

  it('clears the note on the next attempt', async () => {
    listed = [blocked()]
    vi.mocked(api.patch).mockRejectedValueOnce(new Error('409'))
    vi.mocked(api.patch).mockReturnValueOnce(new Promise(() => {}) as never)
    renderPanel()
    const toggle = await screen.findByRole('switch', { name: 'DOU' })

    await act(async () => {
      fireEvent.click(toggle)
    })
    await screen.findByTestId('job-source-enable-failure')
    await act(async () => {
      fireEvent.click(screen.getByRole('switch', { name: 'DOU' }))
    })

    await waitFor(() => expect(screen.queryByTestId('job-source-enable-failure')).toBeNull())
    expect(api.patch).toHaveBeenCalledTimes(2)
  })
})

describe('AC6 — non-ADMIN sees nothing', () => {
  it('renders nothing and fetches nothing for a viewer who may not manage sources', () => {
    renderPanel({ canView: false })
    expect(screen.queryByTestId('job-source-budgets')).toBeNull()
    expect(screen.queryByTestId('job-source-section')).toBeNull()
    expect(screen.queryByRole('switch')).toBeNull()
    expect(api.get).not.toHaveBeenCalled()
  })

  it('renders nothing for the collapsible page section either', () => {
    renderPanel({ canView: false, collapsible: true })
    expect(screen.queryByTestId('job-source-section')).toBeNull()
    expect(api.get).not.toHaveBeenCalled()
  })
})

describe('AC7 — the collapsed section and its summary (uk)', () => {
  const summaryOf = async () => (await screen.findByTestId('job-source-summary')).textContent

  const many = (n: number) =>
    Array.from({ length: n }, (_, i) =>
      source({ id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}` }),
    )

  it('is collapsed by default, titled «Джерела вакансій»', async () => {
    renderPanel({ collapsible: true })
    const section = await screen.findByTestId('job-source-section')
    expect(section.tagName).toBe('DETAILS')
    expect(section).not.toHaveAttribute('open')
    expect(within(section).getByText('Джерела вакансій')).toBeInTheDocument()
  })

  it.each([
    [0, '0 джерел'],
    [1, '1 джерело'],
    [2, '2 джерела'],
    [5, '5 джерел'],
    [11, '11 джерел'],
    [21, '21 джерело'],
    [22, '22 джерела'],
  ])('counts %i sources as «%s»', async (n, text) => {
    listed = many(n)
    renderPanel({ collapsible: true })
    await waitFor(() => expect(sourceGets()).toBe(1))
    expect(await summaryOf()).toBe(text)
  })

  it('appends the paused and the blocked counts, only when there are some', async () => {
    listed = [
      ...many(2),
      source({ id: ID_B, cooldownUntil: ahead(HOUR) }),
      source({
        id: '77777777-7777-4777-8777-777777777777',
        readiness: 'BLOCKED',
        readinessReason: 'x',
      }),
    ]
    renderPanel({ collapsible: true })
    expect(await summaryOf()).toBe('4 джерела · 1 призупинено · 1 заблоковано')
  })

  it('omits a zero count instead of printing «0 призупинено»', async () => {
    listed = [source({ readiness: 'BLOCKED', readinessReason: 'x' })]
    renderPanel({ collapsible: true })
    expect(await summaryOf()).toBe('1 джерело · 1 заблоковано')
  })

  it('shows no summary while the list is loading', () => {
    vi.mocked(api.get).mockReturnValue(new Promise(() => {}) as never)
    renderPanel({ collapsible: true })
    expect(screen.queryByTestId('job-source-summary')).toBeNull()
  })
})

describe('AC7 — English', () => {
  beforeEach(async () => {
    await loadCatalog('en')
  })
  afterEach(async () => {
    await loadCatalog('uk')
  })

  const many = (n: number) =>
    Array.from({ length: n }, (_, i) =>
      source({ id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}` }),
    )

  it.each([
    [1, '1 source'],
    [2, '2 sources'],
    [5, '5 sources'],
    [21, '21 sources'],
  ])('counts %i sources as «%s»', async (n, text) => {
    listed = many(n)
    renderPanel({ collapsible: true })
    expect((await screen.findByTestId('job-source-summary')).textContent).toBe(text)
  })

  it('words the summary, the states, the timestamps and the failure in English', async () => {
    listed = [
      source({ cooldownUntil: ahead(HOUR), lastErrorCode: 'HTTP_429' }),
      source({
        id: ID_B,
        type: 'DJINNI_RSS',
        readiness: 'BLOCKED',
        readinessReason: 'authorization expired',
        enabled: false,
      }),
    ]
    vi.mocked(api.patch).mockRejectedValue(new Error('409'))
    renderPanel({ collapsible: true })

    expect((await screen.findByTestId('job-source-summary')).textContent).toBe(
      '2 sources · 1 paused · 1 blocked',
    )
    const chips = screen.getAllByTestId('job-source-state-chip').map((c) => c.textContent)
    expect(chips).toEqual(['Paused', 'Blocked'])
    expect(screen.getAllByTestId('job-source-state-note')[1]).toHaveTextContent(
      'Not ready: authorization expired',
    )
    expect(screen.getAllByText('Last attempt')).toHaveLength(2)
    expect(screen.getAllByText(formatRelativeTime(ago(12 * MIN), 'en'))[0]).toBeInTheDocument()

    await act(async () => {
      fireEvent.click(screen.getByRole('switch', { name: 'Djinni' }))
    })
    const failure = await screen.findByTestId('job-source-enable-failure')
    expect(failure).toHaveTextContent('Could not enable')
    expect(failure).toHaveTextContent('Reason: authorization expired. Nothing was changed.')
    expect(screen.getAllByRole('img', { name: 'Used 232 of 500' })).toHaveLength(2)
  })
})
