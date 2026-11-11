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
    expect(note().textContent).toBe('Призупинено адміністратором')
  })

  it('a cooldown already in the past is NOT a pause', async () => {
    listed = [source({ cooldownUntil: ago(MIN), hostPausedUntil: ago(MIN) })]
    renderPanel()
    await screen.findByRole('switch', { name: 'DOU' })
    expect(chip()).toHaveAttribute('data-state', 'running')
  })

  it('readiness-blocked: destructive chip with the readiness reason, even while switched off', async () => {
    listed = [
      source({
        enabled: false,
        readiness: 'BLOCKED',
        readinessReason: 'AUTH_DEADLINE_PASSED: the authorization window closed on 2027-02-10',
      }),
    ]
    renderPanel()
    await screen.findByRole('switch', { name: 'DOU' })
    expect(chip()).toHaveTextContent('Заблоковано')
    expect(chip()).toHaveAttribute('data-state', 'blocked')
    expect(note().textContent).toBe('Не готове: сплив термін авторизації')
  })

  it('readiness-blocked with several codes: one phrase each, in order, joined by «; »', async () => {
    listed = [
      source({
        readiness: 'BLOCKED',
        readinessReason:
          'KEY_REQUIRED: set the API key; NO_CAPTURE: record a sample; KEY_REQUIRED: again',
      }),
    ]
    renderPanel()
    await screen.findByRole('switch', { name: 'DOU' })
    expect(note().textContent).toBe(
      'Не готове: потрібен ключ доступу; немає перевіреного зразка відповіді',
    )
  })

  it('readiness-blocked with an unknown code: the neutral phrase, never the server text', async () => {
    listed = [
      source({
        readiness: 'BLOCKED',
        readinessReason: 'SOMETHING_NEW: internal developer detail about the adapter',
      }),
    ]
    renderPanel()
    await screen.findByRole('switch', { name: 'DOU' })
    expect(note().textContent).toBe('Не готове до роботи')
    expect(document.body.textContent).not.toContain('developer detail')
    expect(document.body.textContent).not.toContain('SOMETHING_NEW')
  })

  it('readiness-blocked: the English detail after the code never reaches the page', async () => {
    listed = [
      source({
        readiness: 'BLOCKED',
        readinessReason: 'PERMISSION_PROHIBITED: robots.txt disallows /jobs for all agents',
      }),
    ]
    renderPanel()
    await screen.findByRole('switch', { name: 'DOU' })
    expect(note().textContent).toBe('Не готове: джерело забороняє автоматичний збір')
    expect(document.body.textContent).not.toContain('robots.txt')
    expect(document.body.textContent).not.toContain('PERMISSION_PROHIBITED')
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

describe('AC3 — three-segment quota bar', () => {
  const meter = (over: Partial<NonNullable<JobSourceDto['meter']>> = {}) => ({
    unit: 'REQUEST' as const,
    window: 'MONTH' as const,
    limit: 200,
    used: 120,
    reserved: 10,
    uncertain: 5,
    resetsAt: null,
    ...over,
  })
  // Intl puts a no-break space between a number and the currency / inside a group.
  const plain = (text: string | null) => (text ?? '').replace(/[  ]/g, ' ')
  const bar = (name: string) => screen.getByRole('img', { name: (n) => plain(n) === name })

  it('draws used / reserved / uncertain of the limit; the label and the legend carry all three numbers', async () => {
    listed = [source({ meter: meter() })]
    renderPanel()
    await screen.findByRole('switch', { name: 'DOU' })
    const img = bar('Використано 120, зарезервовано 10, невизначено 5 з 200')
    expect(within(img).getByTestId('job-source-quota-used')).toHaveStyle({ width: '60%' })
    expect(within(img).getByTestId('job-source-quota-reserved')).toHaveStyle({ width: '5%' })
    expect(within(img).getByTestId('job-source-quota-uncertain')).toHaveStyle({ width: '2.5%' })
    // The headline adds up everything the limit has committed: used + reserved + uncertain.
    expect(screen.getByTestId('job-source-quota-limit').textContent).toBe(
      'Ліміт: 135 / 200 запитів',
    )
    expect(screen.getByTestId('job-source-quota-legend-used')).toHaveTextContent('Використано 120')
    expect(screen.getByTestId('job-source-quota-legend-reserved')).toHaveTextContent(
      'Зарезервовано 10',
    )
    expect(screen.getByTestId('job-source-quota-legend-uncertain')).toHaveTextContent(
      'Невизначено 5',
    )
  })

  it('hatches the uncertain segment so the bar is not colour-only, and tints reserved', async () => {
    listed = [source({ meter: meter() })]
    renderPanel()
    await screen.findByRole('switch', { name: 'DOU' })
    expect(screen.getByTestId('job-source-quota-uncertain').className).toContain(
      'repeating-linear-gradient',
    )
    expect(screen.getByTestId('job-source-quota-used').className).toContain('bg-primary')
    expect(screen.getByTestId('job-source-quota-reserved').className).toContain(
      'bg-yellow-muted/60',
    )
    expect(screen.getByTestId('job-source-quota-used').className).not.toContain(
      'repeating-linear-gradient',
    )
    expect(screen.getByTestId('job-source-quota-reserved').className).not.toContain(
      'repeating-linear-gradient',
    )
  })

  it('the meter wins over the legacy budget counter', async () => {
    listed = [source({ meter: meter({ used: 40, reserved: 0, uncertain: 0 }) })]
    renderPanel()
    await screen.findByRole('switch', { name: 'DOU' })
    expect(bar('Використано 40, зарезервовано 0, невизначено 0 з 200')).toBeInTheDocument()
    expect(screen.queryByRole('img', { name: /232/ })).toBeNull()
  })

  it('without a meter it falls back to the legacy budget counter (no reserved / uncertain)', async () => {
    renderPanel()
    await screen.findByRole('switch', { name: 'DOU' })
    const img = bar('Використано 232, зарезервовано 0, невизначено 0 з 500')
    expect(within(img).getByTestId('job-source-quota-used')).toHaveStyle({ width: '46.4%' })
    expect(within(img).getByTestId('job-source-quota-reserved')).toHaveStyle({ width: '0%' })
    expect(within(img).getByTestId('job-source-quota-uncertain')).toHaveStyle({ width: '0%' })
    expect(screen.getByTestId('job-source-quota-limit').textContent).toBe(
      'Ліміт: 232 / 500 запитів',
    )
  })

  it('a null meter behaves like an absent one', async () => {
    listed = [source({ meter: null })]
    renderPanel()
    await screen.findByRole('switch', { name: 'DOU' })
    expect(bar('Використано 232, зарезервовано 0, невизначено 0 з 500')).toBeInTheDocument()
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

  it('draws no bar for a meter without a limit or with a zero limit', async () => {
    listed = [
      source({ meter: meter({ limit: null, window: 'LIFETIME' }) }),
      source({ id: ID_B, type: 'DJINNI_RSS', meter: meter({ limit: 0, used: 0 }) }),
    ]
    renderPanel()
    await screen.findByRole('switch', { name: 'DOU' })
    expect(screen.queryByRole('img')).toBeNull()
    expect(screen.queryByTestId('job-source-quota-limit')).toBeNull()
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

  it.each([
    ['RECORD' as const, 'Ліміт: 135 / 200 записів'],
    ['MODEL_CALL' as const, 'Ліміт: 135 / 200 викликів моделі'],
  ])('names the %s unit', async (unit, text) => {
    listed = [source({ meter: meter({ unit }) })]
    renderPanel()
    await screen.findByRole('switch', { name: 'DOU' })
    expect(screen.getByTestId('job-source-quota-limit').textContent).toBe(text)
  })

  it('shows a money meter in dollars, not in micros, with no unit word', async () => {
    listed = [
      source({
        meter: meter({
          unit: 'USD_MICROS',
          limit: 5_000_000,
          used: 1_500_000,
          reserved: 250_000,
          uncertain: 0,
        }),
      }),
    ]
    renderPanel()
    await screen.findByRole('switch', { name: 'DOU' })
    expect(
      bar('Використано 1,50 USD, зарезервовано 0,25 USD, невизначено 0,00 USD з 5,00 USD'),
    ).toBeInTheDocument()
    expect(plain(screen.getByTestId('job-source-quota-limit').textContent)).toBe(
      'Ліміт: 1,75 USD / 5,00 USD',
    )
    expect(plain(screen.getByTestId('job-source-quota-legend-used').textContent)).toBe(
      'Використано 1,50 USD',
    )
  })

  it('groups large counts the way the active locale does', async () => {
    listed = [source({ meter: meter({ limit: 20_000, used: 12_500, reserved: 0, uncertain: 0 }) })]
    renderPanel()
    await screen.findByRole('switch', { name: 'DOU' })
    expect(plain(screen.getByTestId('job-source-quota-limit').textContent)).toBe(
      'Ліміт: 12 500 / 20 000 запитів',
    )
    expect(plain(screen.getByTestId('job-source-quota-legend-used').textContent)).toBe(
      'Використано 12 500',
    )
  })

  // The unit word agrees with the limit (uk one / few / many / other).
  it.each([
    [1, 'запит'],
    [2, 'запити'],
    [5, 'запитів'],
    [11, 'запитів'],
    [21, 'запит'],
    [22, 'запити'],
    [25, 'запитів'],
  ])('agrees the REQUEST unit with a limit of %i: «%s»', async (limit, word) => {
    listed = [source({ meter: meter({ limit, used: 0, reserved: 0, uncertain: 0 }) })]
    renderPanel()
    await screen.findByRole('switch', { name: 'DOU' })
    expect(screen.getByTestId('job-source-quota-limit').textContent).toBe(
      `Ліміт: 0 / ${limit} ${word}`,
    )
  })

  it.each([
    [1, 'запис'],
    [3, 'записи'],
    [7, 'записів'],
  ])('agrees the RECORD unit with a limit of %i: «%s»', async (limit, word) => {
    listed = [
      source({ meter: meter({ unit: 'RECORD', limit, used: 0, reserved: 0, uncertain: 0 }) }),
    ]
    renderPanel()
    await screen.findByRole('switch', { name: 'DOU' })
    expect(screen.getByTestId('job-source-quota-limit').textContent).toBe(
      `Ліміт: 0 / ${limit} ${word}`,
    )
  })

  it.each([
    [1, 'виклик моделі'],
    [4, 'виклики моделі'],
    [9, 'викликів моделі'],
  ])('agrees the MODEL_CALL unit with a limit of %i: «%s»', async (limit, word) => {
    listed = [
      source({ meter: meter({ unit: 'MODEL_CALL', limit, used: 0, reserved: 0, uncertain: 0 }) }),
    ]
    renderPanel()
    await screen.findByRole('switch', { name: 'DOU' })
    expect(screen.getByTestId('job-source-quota-limit').textContent).toBe(
      `Ліміт: 0 / ${limit} ${word}`,
    )
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

  const dateOf = (iso: string, locale: string) =>
    new Date(iso).toLocaleDateString(locale, { day: '2-digit', month: '2-digit', year: 'numeric' })

  it('shows «Політика діє до» and «Авторизація до» with an absolute date when the source has deadlines', async () => {
    listed = [
      source({
        policyUntil: '2027-03-15T00:00:00.000Z',
        authUntil: '2027-02-10T00:00:00.000Z',
      }),
    ]
    renderPanel()
    await screen.findByRole('switch', { name: 'DOU' })
    expect(within(stamps()).getAllByRole('term')).toHaveLength(5)
    expect(valueOf('Політика діє до')).toBe(dateOf('2027-03-15T00:00:00.000Z', 'uk'))
    expect(valueOf('Авторизація до')).toBe(dateOf('2027-02-10T00:00:00.000Z', 'uk'))
    // an absolute date, not the relative «через N днів» the attempts use
    expect(valueOf('Авторизація до')).toMatch(/2027/)
    // the two deadlines differ, so each value sits under its own label
    expect(valueOf('Політика діє до')).not.toBe(valueOf('Авторизація до'))
  })

  it('says «ніколи» for a deadline that is null — and for one an older server does not send', async () => {
    listed = [source({ policyUntil: null, authUntil: undefined })]
    renderPanel()
    await screen.findByRole('switch', { name: 'DOU' })
    expect(within(stamps()).getAllByRole('term')).toHaveLength(5)
    expect(valueOf('Політика діє до')).toBe('ніколи')
    expect(valueOf('Авторизація до')).toBe('ніколи')
  })

  it('one deadline set, the other not: only the unset row says «ніколи»', async () => {
    listed = [source({ policyUntil: null, authUntil: '2027-02-10T00:00:00.000Z' })]
    renderPanel()
    await screen.findByRole('switch', { name: 'DOU' })
    expect(valueOf('Політика діє до')).toBe('ніколи')
    expect(valueOf('Авторизація до')).toBe(dateOf('2027-02-10T00:00:00.000Z', 'uk'))
  })

  it('is one column on mobile and three from a 560 px container', async () => {
    renderPanel()
    await screen.findByRole('switch', { name: 'DOU' })
    expect(stamps().tagName).toBe('DL')
    expect(stamps().className).toContain('grid-cols-1')
    expect(stamps().className).toContain('@min-[560px]:grid-cols-3')
    // a container query matches only inside an `@container` ancestor: the card is that container
    expect(screen.getByTestId('job-source-card')).toHaveClass('@container')
    expect(screen.getByTestId('job-source-card')).toContainElement(stamps())
  })
})

describe('AC5 — a refused enable', () => {
  const blocked = () =>
    source({
      enabled: false,
      readiness: 'BLOCKED',
      readinessReason: 'AUTH_DEADLINE_PASSED: the authorization window closed on 2027-02-10',
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
    expect(failure.textContent).toBe(
      'Не вдалося увімкнути. Причина: сплив термін авторизації. Стан не змінено.',
    )
    expect(failure.textContent).not.toContain('authorization window')
    expect(screen.getByRole('switch', { name: 'DOU' })).toHaveAttribute('aria-checked', 'false')
    expect(screen.getByRole('switch', { name: 'DOU' })).not.toBeDisabled()
    // policy / cost state untouched: same chip, same note, same budget line, same bar, no refetch
    expect(screen.getByTestId('job-source-state-chip')).toHaveTextContent('Заблоковано')
    expect(screen.getByTestId('job-source-budget-remaining')).toHaveTextContent(
      'Залишилось 90 з 400',
    )
    expect(
      screen.getByRole('img', { name: 'Використано 310, зарезервовано 0, невизначено 0 з 400' }),
    ).toBeInTheDocument()
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

    // one period after the server answer, never two
    const answer = getUserFacingErrorMessage(error)
    const sentence = /[.!?…]$/.test(answer) ? answer : `${answer}.`
    const failure = await screen.findByTestId('job-source-enable-failure')
    expect(failure.textContent).toBe(`Не вдалося увімкнути. ${sentence} Стан не змінено.`)
    expect(failure.textContent).not.toContain('..')
  })

  it('does not double the period when the server answer already ends with one', async () => {
    listed = [source({ enabled: false })]
    vi.mocked(api.patch).mockRejectedValue({
      isAxiosError: true,
      response: { status: 409, data: { message: 'Джерело зайняте іншим запуском.' } },
    })
    renderPanel()
    const toggle = await screen.findByRole('switch', { name: 'DOU' })

    await act(async () => {
      fireEvent.click(toggle)
    })

    const failure = await screen.findByTestId('job-source-enable-failure')
    expect(failure.textContent).toBe(
      'Не вдалося увімкнути. Джерело зайняте іншим запуском. Стан не змінено.',
    )
    expect(failure.textContent).not.toContain('..')
  })

  it('an unknown readiness code in the refusal reads «Не готове до роботи», never the server text', async () => {
    listed = [
      source({
        enabled: false,
        readiness: 'BLOCKED',
        readinessReason: 'SOMETHING_NEW: internal developer detail',
      }),
    ]
    vi.mocked(api.patch).mockRejectedValue(new Error('409'))
    renderPanel()
    const toggle = await screen.findByRole('switch', { name: 'DOU' })

    await act(async () => {
      fireEvent.click(toggle)
    })

    const failure = await screen.findByTestId('job-source-enable-failure')
    expect(failure.textContent).toBe('Не вдалося увімкнути. Не готове до роботи. Стан не змінено.')
    expect(failure.textContent).not.toContain('developer detail')
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
        readinessReason: 'AUTH_DEADLINE_PASSED: the authorization window closed on 2027-02-10',
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
    expect(screen.getAllByText('Last success')).toHaveLength(2)
    expect(screen.getAllByText(formatRelativeTime(ago(12 * MIN), 'en'))[0]).toBeInTheDocument()

    await act(async () => {
      fireEvent.click(screen.getByRole('switch', { name: 'Djinni' }))
    })
    const failure = await screen.findByTestId('job-source-enable-failure')
    expect(failure.textContent).toBe(
      'Could not enable. Reason: authorization expired. Nothing was changed.',
    )
    expect(
      screen.getAllByRole('img', { name: 'Used 232, reserved 0, uncertain 0 of 500' }),
    ).toHaveLength(2)
    expect(screen.getAllByTestId('job-source-quota-limit')[0]?.textContent).toBe(
      'Quota: 232 / 500 requests',
    )
    expect(screen.getAllByTestId('job-source-quota-legend-reserved')[0]).toHaveTextContent(
      'Reserved 0',
    )
    expect(screen.getAllByTestId('job-source-quota-legend-uncertain')[0]).toHaveTextContent(
      'Uncertain 0',
    )
  })
})

describe('exact rendering contract (state chips, notes, quota, panel shell)', () => {
  const chip = () => screen.getByTestId('job-source-state-chip')
  const note = () => screen.getByTestId('job-source-state-note')
  const ready = () => screen.findByRole('switch', { name: 'DOU' })
  const timeOnly = (iso: string) =>
    new Date(iso).toLocaleTimeString('uk', { hour: '2-digit', minute: '2-digit' })

  it.each([
    // design §7/§8: running outlined + check, disabled secondary fill + power, paused amber tint
    // from the design tokens + pause, blocked destructive outline + lock
    ['running', {}, 'Check', ['border-border']],
    ['disabled', { enabled: false }, 'Power', ['bg-secondary', 'text-foreground']],
    [
      'paused',
      { adminState: 'PAUSED' },
      'Pause',
      ['border-yellow-muted/40', 'bg-yellow-subtle', 'text-foreground'],
    ],
    [
      'blocked',
      { readiness: 'BLOCKED', readinessReason: 'x' },
      'Lock',
      ['border-destructive', 'text-destructive'],
    ],
  ] as const)(
    'the %s chip has its own icon, variant and aria-hidden icon',
    async (kind, over, icon, classes) => {
      listed = [source(over as Partial<JobSourceDto>)]
      renderPanel()
      await ready()
      expect(chip()).toHaveAttribute('data-state', kind)
      expect(chip()).toHaveAttribute('data-icon', icon)
      for (const cls of classes) expect(chip()).toHaveClass(cls)
      // a missing / empty variant falls back to the solid primary badge
      expect(chip()).not.toHaveClass('bg-primary')
      const svg = within(chip()).getByTestId('job-source-state-icon')
      expect(svg).toHaveAttribute('aria-hidden', 'true')
      expect(svg).toHaveClass('mr-1', 'size-3', 'shrink-0')
    },
  )

  it('only the paused chip is amber, through the design tokens and no raw amber / green classes', async () => {
    listed = [
      source({ id: ID_A }),
      source({ id: ID_B, type: 'DJINNI_RSS', enabled: false }),
      source({
        id: '77777777-7777-4777-8777-777777777777',
        type: 'REED_API',
        adminState: 'PAUSED',
      }),
      source({
        id: '88888888-8888-4888-8888-888888888888',
        type: 'JSEARCH_API',
        readiness: 'BLOCKED',
        readinessReason: 'x',
      }),
    ]
    renderPanel()
    await ready()
    const chips = screen.getAllByTestId('job-source-state-chip')
    expect(chips.map((c) => c.classList.contains('bg-yellow-subtle'))).toEqual([
      false,
      false,
      true,
      false,
    ])
    for (const c of chips) expect(c.className).not.toMatch(/amber|green-/)
  })

  it('a pause under 24 h shows the time only; 24 h or more shows the date too', async () => {
    const withDate = (iso: string) =>
      new Date(iso).toLocaleString('uk', {
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      })
    const soon = ahead(23 * HOUR)
    const exactly = ahead(DAY)
    const later = ahead(3 * DAY)
    for (const [iso, expected] of [
      [soon, timeOnly(soon)],
      [exactly, withDate(exactly)],
      [later, withDate(later)],
    ] as const) {
      listed = [source({ cooldownUntil: iso })]
      const { unmount } = renderPanel()
      await ready()
      expect(note().textContent).toBe(`Пауза до ${expected}`)
      unmount()
    }
  })

  it('a pause with no stated reason does not invent one', async () => {
    const until = ahead(HOUR)
    listed = [source({ cooldownUntil: until, lastErrorCode: null })]
    renderPanel()
    await ready()
    expect(note().textContent).toBe(`Пауза до ${timeOnly(until)}`)
  })

  it('a blocked source with no stated reason still says it is not ready', async () => {
    listed = [source({ readiness: 'BLOCKED', readinessReason: null })]
    renderPanel()
    await ready()
    expect(note().textContent).toBe('Не готове до роботи')
  })

  it('a cooldown that ends exactly now is over', async () => {
    listed = [source({ cooldownUntil: NOW.toISOString(), hostPausedUntil: NOW.toISOString() })]
    renderPanel()
    await ready()
    expect(chip()).toHaveAttribute('data-state', 'running')
  })

  it('draws a bar only for an ACTIVE or EXHAUSTED source that has a limit', async () => {
    const budget = (state: JobSourceDto['budget']['state'], limit: number | null) => ({
      state,
      limit,
      window: 'MONTH' as const,
      used: 1,
      remaining: 1,
      resetsAt: null,
    })
    listed = [
      source({ id: ID_A, budget: budget('UNLIMITED', 5) }),
      source({ id: ID_B, type: 'DJINNI_RSS', budget: budget('MISCONFIGURED', 5) }),
      source({
        id: '77777777-7777-4777-8777-777777777777',
        type: 'REED_API',
        budget: budget('ACTIVE', null),
      }),
    ]
    renderPanel()
    await ready()
    expect(screen.queryByRole('img')).toBeNull()
    expect(screen.queryByTestId('job-source-quota-legend')).toBeNull()
  })

  it('keeps the budget line exact when the server states no window', async () => {
    listed = [
      source({
        budget: { state: 'ACTIVE', limit: 5, window: null, used: 0, remaining: 3, resetsAt: null },
      }),
    ]
    renderPanel()
    await ready()
    expect(screen.getByTestId('job-source-budget-remaining').textContent).toBe('Залишилось 3 з 5 ')
  })

  it('lays the budget row out as the design says', async () => {
    renderPanel()
    await ready()
    const row = screen.getByTestId('job-source-budget-row')
    expect(row).toHaveClass(
      'flex',
      'flex-col',
      'gap-0.5',
      'text-xs',
      'sm:flex-row',
      'sm:items-center',
      'sm:justify-between',
      'sm:gap-3',
    )
    expect(row.textContent).toBe('(за розкладом)Залишилось 268 з 500 на місяць (використано 232)')
  })

  it('words the failure as one sentence with a space after the headline', async () => {
    listed = [
      source({
        enabled: false,
        readiness: 'BLOCKED',
        readinessReason: 'AUTH_DEADLINE_PASSED: window closed',
      }),
    ]
    vi.mocked(api.patch).mockRejectedValue(new Error('409'))
    renderPanel()
    const toggle = await ready()
    await act(async () => {
      fireEvent.click(toggle)
    })
    expect((await screen.findByTestId('job-source-enable-failure')).textContent).toBe(
      'Не вдалося увімкнути. Причина: сплив термін авторизації. Стан не змінено.',
    )
  })
})

describe('the panel shell', () => {
  const bare = () =>
    render(
      <I18nTestProvider>
        <QueryClientProvider client={new QueryClient()}>
          <SourceBudgetPanel canView />
        </QueryClientProvider>
      </I18nTestProvider>,
    )

  it('defaults to the always-open list: titled, ruled off, not collapsible', async () => {
    bare()
    await screen.findByRole('switch', { name: 'DOU' })
    expect(screen.getByRole('heading', { name: 'Бюджет джерел' })).toHaveClass(
      'text-sm',
      'font-medium',
      'text-foreground',
    )
    expect(screen.getByTestId('job-source-budgets')).toHaveClass(
      'mt-6',
      'border-t',
      'border-border/50',
      'pt-4',
    )
    expect(screen.queryByTestId('job-source-section')).toBeNull()
  })

  it('the collapsible form has no heading and no rule of its own', async () => {
    renderPanel({ collapsible: true })
    await screen.findByTestId('job-source-section')
    expect(screen.queryByRole('heading')).toBeNull()
    expect(screen.getByTestId('job-source-budgets')).not.toHaveAttribute('class')
  })
})

describe('COPY — English quota, deadlines and admin pause', () => {
  beforeEach(async () => {
    await loadCatalog('en')
  })
  afterEach(async () => {
    await loadCatalog('uk')
  })

  const meter = (over: Partial<NonNullable<JobSourceDto['meter']>> = {}) => ({
    unit: 'REQUEST' as const,
    window: 'MONTH' as const,
    limit: 20_000,
    used: 12_500,
    reserved: 0,
    uncertain: 0,
    resetsAt: null,
    ...over,
  })

  it('groups counts with commas and agrees the unit word', async () => {
    listed = [source({ meter: meter() })]
    renderPanel()
    await screen.findByRole('switch', { name: 'DOU' })
    expect(screen.getByTestId('job-source-quota-limit').textContent).toBe(
      'Quota: 12,500 / 20,000 requests',
    )
  })

  it.each([
    ['REQUEST' as const, 1, 'Quota: 0 / 1 request'],
    ['RECORD' as const, 2, 'Quota: 0 / 2 records'],
    ['MODEL_CALL' as const, 1, 'Quota: 0 / 1 model call'],
  ])('writes %s with a limit of %i as «%s»', async (unit, limit, text) => {
    listed = [source({ meter: meter({ unit, limit, used: 0 }) })]
    renderPanel()
    await screen.findByRole('switch', { name: 'DOU' })
    expect(screen.getByTestId('job-source-quota-limit').textContent).toBe(text)
  })

  it('writes money in US style', async () => {
    listed = [
      source({
        meter: meter({ unit: 'USD_MICROS', limit: 5_000_000, used: 1_500_000, reserved: 250_000 }),
      }),
    ]
    renderPanel()
    await screen.findByRole('switch', { name: 'DOU' })
    expect(screen.getByTestId('job-source-quota-limit').textContent).toBe('Quota: $1.75 / $5.00')
    expect(screen.getByRole('img', { name: /Used \$1\.50, reserved \$0\.25/ })).toBeInTheDocument()
  })

  it('words the deadline rows and the admin pause', async () => {
    listed = [
      source({ policyUntil: null, authUntil: '2027-02-10T00:00:00.000Z' }),
      source({ id: ID_B, type: 'DJINNI_RSS', adminState: 'PAUSED' }),
    ]
    renderPanel()
    await screen.findAllByRole('switch')
    expect(screen.getAllByText('Policy valid until')).toHaveLength(2)
    expect(screen.getAllByText('Authorization until')).toHaveLength(2)
    expect(screen.getAllByText('never')).toHaveLength(3)
    expect(screen.getAllByTestId('job-source-state-note')[0]?.textContent).toBe(
      'Paused by an administrator',
    )
  })
})
