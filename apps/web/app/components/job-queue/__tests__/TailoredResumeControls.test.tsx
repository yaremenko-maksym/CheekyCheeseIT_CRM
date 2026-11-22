/** Tailored resume plan Task 13 — the per-senior controls of «Сеньйори зі збігом» (spec §4). */
import { useState, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import type { TailoredResumeDetailDto, TailoredResumeRowDto } from '@crm/shared'
import type { QueueScopeSignature } from '@/hooks/use-job-queue'
import { I18nTestProvider, loadCatalog } from '@/test/i18n'
import { api } from '@/lib/axios'
import { useJobQueueSeniors } from '@/hooks/use-job-queue'
import { MatchedSeniors } from '../MatchedSeniors'
import { TailoredResumeControls } from '../TailoredResumeControls'
import { useTailoredRows } from '../useTailoredResumes'
import { cardFixture, idleContinuation, OPP, senior } from './card-fixtures'

vi.mock('@/lib/axios', () => ({
  api: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    getUri: (config: { url: string; params?: Record<string, string> }) =>
      `/api${config.url}${config.params?.teamId ? `?teamId=${config.params.teamId}` : ''}`,
  },
}))
vi.mock('@/hooks/use-job-queue', async (orig) => ({
  ...(await orig<typeof import('@/hooks/use-job-queue')>()),
  useJobQueueSeniors: vi.fn(),
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

const get = vi.mocked(api.get)
const post = vi.mocked(api.post)
const put = vi.mocked(api.put)

const HR = { actorId: 'actor', role: 'HR' as const, teamId: null }
const TEAM = '99999999-9999-4999-8999-999999999999'
const HR_TEAM = { ...HR, teamId: TEAM }
const S1 = 'aaaaaaaa-0000-4000-8000-000000000001'
const RENDER_OLD = 'bbbbbbbb-0000-4000-8000-000000000001'
const RENDER_NEW = 'bbbbbbbb-0000-4000-8000-000000000002'
const RUN = 'cccccccc-0000-4000-8000-000000000001'

function row(over: Partial<TailoredResumeRowDto> = {}): TailoredResumeRowDto {
  return {
    seniorId: S1,
    eligibility: 'READY',
    runStatus: null,
    runStage: null,
    runErrorCode: null,
    published: false,
    pdfStatus: 'IDLE',
    pdfRenderId: null,
    baseChanged: false,
    ...over,
  }
}

const PUBLISHED = {
  runStatus: 'SUCCEEDED',
  published: true,
  pdfStatus: 'READY',
  pdfRenderId: RENDER_OLD,
} as const

function detail(over: Partial<TailoredResumeDetailDto> = {}): TailoredResumeDetailDto {
  return {
    ...row(PUBLISHED),
    coverLetter: 'Dear team, I build React apps.',
    editable: {
      summary: 'Frontend engineer.',
      skills: ['React', 'TypeScript'],
      experience: [
        { company: 'Acme', role: 'Engineer', period: '2020–2024', bullets: ['Built the UI'] },
      ],
    },
    summary: null,
    generatedAt: '2026-11-20T10:00:00.000Z',
    editedAt: null,
    ...over,
  }
}

const notFound = () => Promise.reject({ isAxiosError: true, response: { status: 404, data: {} } })
const ok = (data: unknown) => Promise.resolve({ data })

/** Answers GETs by path: the detail route answers each queued value in turn, then repeats the last. */
function routeGets({
  rows = [row()],
  details = [] as TailoredResumeDetailDto[],
}: { rows?: TailoredResumeRowDto[] | 'missing'; details?: TailoredResumeDetailDto[] } = {}) {
  const queue = [...details]
  get.mockImplementation((url: string) => {
    if (url.endsWith(`/seniors/${S1}/tailored`)) {
      const next = queue.length > 1 ? queue.shift() : queue[0]
      return next ? ok(next) : notFound()
    }
    if (url.endsWith(`/${OPP}/tailored`)) return rows === 'missing' ? notFound() : ok(rows)
    return Promise.reject(new Error(`unexpected GET ${url}`))
  })
}

const detailCalls = () => get.mock.calls.filter(([url]) => String(url).endsWith(`/${S1}/tailored`))
const batchCalls = () => get.mock.calls.filter(([url]) => String(url).endsWith(`/${OPP}/tailored`))

function Wrapper({ children }: { children: ReactNode }) {
  const [client] = useState(() => new QueryClient())
  return (
    <QueryClientProvider client={client}>
      <I18nTestProvider>{children}</I18nTestProvider>
    </QueryClientProvider>
  )
}

function renderControls(r: TailoredResumeRowDto = row(), scope: QueueScopeSignature = HR) {
  return render(
    <TailoredResumeControls scope={scope} opportunityId={OPP} seniorId={S1} row={r} />,
    { wrapper: Wrapper },
  )
}

let anchorClicks: string[]

beforeEach(async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  get.mockReset()
  post.mockReset()
  put.mockReset()
  vi.mocked(toast.success).mockClear()
  vi.mocked(useJobQueueSeniors).mockReturnValue(idleContinuation() as never)
  anchorClicks = []
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    anchorClicks.push(this.getAttribute('href') ?? '')
  })
  await loadCatalog('uk')
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const user = () => userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
/** A button that waits for the per-senior GET before it can be pressed. */
async function enabled(name: string) {
  const button = await screen.findByRole('button', { name })
  await waitFor(() => expect(button).toBeEnabled())
  return button
}
const tick = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms))

describe('useTailoredRows', () => {
  it('200 seniors → two batch requests of 100, no batch refetch on an interval', async () => {
    const ids = Array.from(
      { length: 200 },
      (_, i) => `aaaaaaaa-0000-4000-8000-${i.toString(16).padStart(12, '0')}`,
    )
    get.mockImplementation(() => ok([]))
    renderHook(() => useTailoredRows(HR_TEAM, OPP, ids), { wrapper: Wrapper })
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2))
    const sent = get.mock.calls.map(([url, config]) => ({
      url,
      params: (config as { params: Record<string, string> }).params,
    }))
    expect(sent[0]!.url).toBe(`/job-queue/${OPP}/tailored`)
    expect(sent.map((s) => s.params.teamId)).toEqual([TEAM, TEAM])
    expect(sent.map((s) => s.params.seniorIds!.split(',').length)).toEqual([100, 100])
    expect(sent[0]!.params.seniorIds!.split(',')[0]).toBe(ids[0])
    expect(sent[1]!.params.seniorIds!.split(',')[0]).toBe(ids[100])
    await tick(60_000)
    expect(get).toHaveBeenCalledTimes(2)
  })

  it('no seniors → no request (the API refuses an empty list)', async () => {
    renderHook(() => useTailoredRows(HR, OPP, []), { wrapper: Wrapper })
    await tick(1000)
    expect(get).not.toHaveBeenCalled()
  })

  it('maps every answered row by senior id', async () => {
    get.mockImplementation(() => ok([row({ eligibility: 'NON_ENGLISH' })]))
    const { result } = renderHook(() => useTailoredRows(HR, OPP, [S1]), { wrapper: Wrapper })
    await waitFor(() => expect(result.current.get(S1)?.eligibility).toBe('NON_ENGLISH'))
    expect(get.mock.calls[0]![1]).toEqual({ params: { seniorIds: S1 } })
  })
})

describe('MatchedSeniors wiring', () => {
  function renderCard() {
    return render(
      <MatchedSeniors
        scope={HR}
        card={cardFixture({
          seniors: { items: [senior()], totalCount: 1, nextCursor: null },
        })}
        onAccessLost={vi.fn()}
      />,
      { wrapper: Wrapper },
    )
  }

  it('batch GET 404 → no controls, no error text, no refetch (flag off)', async () => {
    routeGets({ rows: 'missing' })
    const { container } = renderCard()
    await waitFor(() => expect(batchCalls()).toHaveLength(1))
    await tick(60_000)
    expect(batchCalls()).toHaveLength(1)
    expect(screen.queryByTestId(`tailored-${S1}`)).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(container.textContent).not.toMatch(/помилк|CV/i)
  })

  it('a READY row shows its controls in the senior block (one batch request per card)', async () => {
    routeGets()
    renderCard()
    expect(await screen.findByRole('button', { name: 'Згенерувати CV і лист' })).toBeEnabled()
    expect(batchCalls()).toHaveLength(1)
  })

  it('a POSTING_PENDING row → one open call per card open; no pending row → none', async () => {
    post.mockImplementation(() =>
      ok({ opportunityId: OPP, detailEnqueued: 1, detailPending: true }),
    )
    routeGets({ rows: [row({ eligibility: 'POSTING_PENDING' })] })
    const first = renderCard()
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1))
    expect(post).toHaveBeenCalledWith(`/job-sourcing/opportunities/${OPP}/open`)
    first.rerender(
      <MatchedSeniors
        scope={HR}
        card={cardFixture({ seniors: { items: [senior()], totalCount: 1, nextCursor: null } })}
        onAccessLost={vi.fn()}
      />,
    )
    await tick(30_000)
    expect(post).toHaveBeenCalledTimes(1)
    first.unmount()

    renderCard()
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2))
    cleanup()

    post.mockClear()
    routeGets({ rows: [row()] })
    renderCard()
    await screen.findByRole('button', { name: 'Згенерувати CV і лист' })
    await tick(1000)
    expect(post).not.toHaveBeenCalled()
  })
})

describe('TailoredResumeControls', () => {
  it('READY row shows the generate button', () => {
    routeGets()
    renderControls()
    expect(screen.getByRole('button', { name: 'Згенерувати CV і лист' })).toBeEnabled()
    expect(screen.queryByRole('button', { name: 'Редагувати' })).toBeNull()
  })

  it('POSTING_PENDING row shows a disabled button with the reason', () => {
    routeGets()
    renderControls(row({ eligibility: 'POSTING_PENDING' }))
    expect(screen.getByRole('button', { name: 'Згенерувати CV і лист' })).toBeDisabled()
    expect(screen.getByTestId(`tailored-reason-${S1}`)).toHaveTextContent(
      'Опис вакансії ще завантажується',
    )
  })

  it.each([
    ['NO_VERIFIED_RESUME', 'Немає перевіреного базового резюме'],
    ['NON_ENGLISH', 'Базове резюме не англійською мовою'],
    ['NON_LATIN_NAME', 'Ім’я в резюме не латиницею'],
    ['POSTING_PENDING', 'Опис вакансії ще завантажується'],
  ] as const)('eligibility %s reads «%s»', (eligibility, text) => {
    routeGets()
    renderControls(row({ eligibility }))
    expect(screen.getByTestId(`tailored-reason-${S1}`)).toHaveTextContent(text)
  })

  it('RUNNING row shows the stage text and no button', async () => {
    routeGets({ details: [detail({ ...row({ runStatus: 'RUNNING', runStage: 'TAILORING' }) })] })
    renderControls(row({ runStatus: 'RUNNING', runStage: 'TAILORING' }))
    expect(screen.getByRole('status')).toHaveTextContent('Адаптуємо резюме…')
    expect(screen.queryByRole('button')).toBeNull()
  })

  it.each([
    [null, 'QUEUED', 'У черзі…'],
    ['FETCHING_POSTING', 'RUNNING', 'Завантажуємо опис вакансії…'],
    ['ANALYSING', 'RUNNING', 'Аналізуємо вакансію…'],
    ['TAILORING', 'RUNNING', 'Адаптуємо резюме…'],
    ['CHECKING', 'RUNNING', 'Перевіряємо факти…'],
    ['RENDERING', 'RUNNING', 'Створюємо PDF…'],
    ['VISUAL_CHECK', 'RUNNING', 'Візуальна перевірка PDF…'],
  ] as const)('stage %s (%s) reads «%s»', (runStage, runStatus, text) => {
    routeGets({ details: [detail(row({ runStatus, runStage }))] })
    renderControls(row({ runStatus, runStage }))
    expect(screen.getByRole('status')).toHaveTextContent(text)
  })

  it.each([
    ['BASE_NOT_VERIFIED', 'Базове резюме ще не перевірене.'],
    ['BASE_CHANGED', 'Базове резюме змінилося під час генерації. Спробуйте ще раз.'],
    ['NON_ENGLISH', 'Базове резюме не англійською мовою.'],
    ['NON_LATIN_NAME', 'Ім’я в резюме не латиницею.'],
    ['WRITER_UNAVAILABLE', 'Сервіс генерації тимчасово недоступний. Спробуйте пізніше.'],
    ['DECISION_UNAVAILABLE', 'Сервіс генерації тимчасово недоступний. Спробуйте пізніше.'],
    ['ENTAILMENT_UNAVAILABLE', 'Сервіс генерації тимчасово недоступний. Спробуйте пізніше.'],
    ['VISUAL_CHECK_UNAVAILABLE', 'Сервіс генерації тимчасово недоступний. Спробуйте пізніше.'],
    ['LIMITS_EXHAUSTED', 'Вичерпано ліміт запитів до моделей. Спробуйте пізніше.'],
    ['COVER_LETTER_UNGROUNDED', 'Супровідний лист не пройшов перевірку фактів.'],
    ['RENDER_FAILED', 'Не вдалося створити PDF.'],
    ['ATS_CHECK_FAILED', 'PDF не пройшов перевірку читабельності для ATS.'],
    ['GLYPH_CHECK_FAILED', 'PDF містить символи, що не відображаються.'],
    ['LAYOUT_UNFIXABLE', 'Резюме не вдалося вмістити в макет.'],
    ['VISUAL_CHECK_FAILED', 'PDF не пройшов візуальну перевірку.'],
    ['STALLED', 'Генерація зависла й була зупинена. Спробуйте ще раз.'],
    ['INTERNAL_ERROR', 'Внутрішня помилка. Спробуйте ще раз.'],
  ] as const)('runErrorCode %s reads «%s»', (runErrorCode, text) => {
    routeGets()
    renderControls(row({ runStatus: 'FAILED', runErrorCode }))
    expect(screen.getByTestId(`tailored-error-${S1}`)).toHaveTextContent(text)
    expect(screen.getByRole('button', { name: 'Згенерувати CV і лист' })).toBeEnabled()
  })

  it('a published row with a changed base shows the hint and keeps the download', async () => {
    routeGets({ details: [detail({ baseChanged: true })] })
    renderControls(row({ ...PUBLISHED, baseChanged: true }))
    expect(screen.getByTestId(`tailored-base-changed-${S1}`)).toHaveTextContent(
      'Резюме або вакансія змінилися після генерації — перегенерувати?',
    )
    expect(await screen.findByRole('button', { name: 'Завантажити CV' })).toBeEnabled()
    expect(screen.getByTestId(`tailored-base-changed-${S1}`)).not.toBeNull()
  })

  it('an unpublished row with baseChanged shows no hint', () => {
    routeGets()
    renderControls(row({ baseChanged: true }))
    expect(screen.queryByTestId(`tailored-base-changed-${S1}`)).toBeNull()
  })

  it('a published row mounts without downloading anything', async () => {
    routeGets({ details: [detail()] })
    renderControls(row(PUBLISHED))
    await enabled('Копіювати лист')
    await tick(20_000)
    expect(anchorClicks).toEqual([])
    expect(detailCalls()).toHaveLength(1)
  })

  it('Download CV downloads the PDF through an anchor in the team scope', async () => {
    routeGets({ details: [detail()] })
    renderControls(row(PUBLISHED), HR_TEAM)
    await user().click(await screen.findByRole('button', { name: 'Завантажити CV' }))
    expect(anchorClicks).toEqual([
      `/api/job-queue/${OPP}/seniors/${S1}/tailored/pdf?teamId=${TEAM}`,
    ])
  })

  it('SUCCEEDED transition triggers one download, not one per poll', async () => {
    post.mockImplementation(() => ok({ runId: RUN }))
    routeGets({
      details: [
        detail(row({ runStatus: 'QUEUED' })),
        detail(row({ runStatus: 'RUNNING', runStage: 'RENDERING' })),
        detail(),
      ],
    })
    renderControls()
    await user().click(screen.getByRole('button', { name: 'Згенерувати CV і лист' }))
    expect(post).toHaveBeenCalledWith(`/job-queue/${OPP}/seniors/${S1}/tailored`, {
      overwrite: false,
    })
    expect(await screen.findByRole('status')).toHaveTextContent('У черзі…')
    await tick(5000)
    expect(await screen.findByText('Створюємо PDF…')).toBeVisible()
    await tick(5000)
    await enabled('Копіювати лист')
    expect(anchorClicks).toEqual([`/api/job-queue/${OPP}/seniors/${S1}/tailored/pdf`])
    const polls = detailCalls().length
    await tick(30_000)
    expect(anchorClicks).toHaveLength(1)
    expect(detailCalls()).toHaveLength(polls)
  })

  it('generate in a team scope sends the team id', async () => {
    post.mockImplementation(() => ok({ runId: RUN }))
    routeGets({ details: [detail(row({ runStatus: 'QUEUED' }))] })
    renderControls(row(), HR_TEAM)
    await user().click(screen.getByRole('button', { name: 'Згенерувати CV і лист' }))
    expect(post).toHaveBeenCalledWith(`/job-queue/${OPP}/seniors/${S1}/tailored`, {
      teamId: TEAM,
      overwrite: false,
    })
  })

  it('a failed run stops the poll and shows its reason, with no download', async () => {
    post.mockImplementation(() => ok({ runId: RUN }))
    routeGets({
      details: [
        detail(row({ runStatus: 'RUNNING', runStage: 'CHECKING' })),
        detail(row({ runStatus: 'FAILED', runErrorCode: 'STALLED' })),
      ],
    })
    renderControls()
    await user().click(screen.getByRole('button', { name: 'Згенерувати CV і лист' }))
    await screen.findByText('Перевіряємо факти…')
    await tick(5000)
    expect(await screen.findByTestId(`tailored-error-${S1}`)).toHaveTextContent(
      'Генерація зависла й була зупинена. Спробуйте ще раз.',
    )
    const polls = detailCalls().length
    await tick(30_000)
    expect(detailCalls()).toHaveLength(polls)
    expect(anchorClicks).toEqual([])
  })

  it('a refused generate shows the localized API error', async () => {
    post.mockImplementation(() =>
      Promise.reject({
        isAxiosError: true,
        response: {
          status: 429,
          data: { statusCode: 429, code: 'TAILORED_RESUME_DAILY_CAP', message: 'cap' },
        },
      }),
    )
    routeGets()
    renderControls()
    await user().click(screen.getByRole('button', { name: 'Згенерувати CV і лист' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Команда вичерпала денний ліміт генерацій резюме. Спробуйте завтра.',
    )
  })

  it('copy writes the cover letter to the clipboard', async () => {
    // after setup: user-event installs its own clipboard stub
    const u = user()
    const writeText = vi.fn(() => Promise.resolve())
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    routeGets({ details: [detail()] })
    renderControls(row(PUBLISHED))
    await u.click(await enabled('Копіювати лист'))
    expect(writeText).toHaveBeenCalledWith('Dear team, I build React apps.')
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Лист скопійовано'))
  })

  it('regenerate asks for confirmation and sends overwrite: true', async () => {
    post.mockImplementation(() => ok({ runId: RUN }))
    routeGets({ details: [detail()] })
    renderControls(row(PUBLISHED))
    const u = user()
    await u.click(await screen.findByRole('button', { name: 'Перегенерувати' }))
    const dialog = await screen.findByRole('alertdialog')
    expect(dialog).toHaveTextContent(
      'Це замінить поточне CV і супровідний лист, разом із вашими правками.',
    )
    expect(post).not.toHaveBeenCalled()
    await u.click(screen.getByRole('button', { name: 'Замінити' }))
    expect(post).toHaveBeenCalledWith(`/job-queue/${OPP}/seniors/${S1}/tailored`, {
      overwrite: true,
    })
  })

  it('regenerate is disabled with the reason when the senior is not eligible', async () => {
    routeGets({ details: [detail({ eligibility: 'NO_VERIFIED_RESUME' })] })
    renderControls(row({ ...PUBLISHED, eligibility: 'NO_VERIFIED_RESUME' }))
    expect(await screen.findByRole('button', { name: 'Перегенерувати' })).toBeDisabled()
    expect(screen.getByTestId(`tailored-reason-${S1}`)).toHaveTextContent(
      'Немає перевіреного базового резюме',
    )
  })

  it('edit save → one download after READY with the PUT’s renderId', async () => {
    put.mockImplementation(() => ok({ renderId: RENDER_NEW }))
    routeGets({
      details: [
        detail(),
        detail(),
        detail({ pdfStatus: 'RUNNING', pdfRenderId: RENDER_NEW }),
        detail({ pdfStatus: 'READY', pdfRenderId: RENDER_NEW }),
      ],
    })
    renderControls(row(PUBLISHED))
    const u = user()
    await u.click(await enabled('Редагувати'))
    const summary = await screen.findByLabelText('Підсумок')
    fireEvent.change(summary, { target: { value: 'Senior frontend engineer.' } })
    fireEvent.change(screen.getByLabelText('Навички (по одній у рядку)'), {
      target: { value: 'React\n\nNode.js ' },
    })
    await u.click(screen.getByRole('button', { name: 'Зберегти' }))
    expect(put).toHaveBeenCalledWith(`/job-queue/${OPP}/seniors/${S1}/tailored`, {
      summary: 'Senior frontend engineer.',
      skills: ['React', 'Node.js'],
      bullets: [['Built the UI']],
      coverLetter: 'Dear team, I build React apps.',
    })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(anchorClicks).toEqual([])
    await tick(5000)
    await tick(5000)
    await waitFor(() => expect(anchorClicks).toHaveLength(1))
    const polls = detailCalls().length
    await tick(30_000)
    expect(anchorClicks).toHaveLength(1)
    expect(detailCalls()).toHaveLength(polls)
  })

  it('edit save → FAILED render: no download, error shown', async () => {
    put.mockImplementation(() => ok({ renderId: RENDER_NEW }))
    routeGets({
      details: [detail(), detail(), detail({ pdfStatus: 'FAILED', pdfRenderId: RENDER_NEW })],
    })
    renderControls(row(PUBLISHED))
    const u = user()
    await u.click(await enabled('Редагувати'))
    await u.click(await screen.findByRole('button', { name: 'Зберегти' }))
    await tick(5000)
    expect(await screen.findByTestId(`tailored-render-failed-${S1}`)).toHaveTextContent(
      'Не вдалося оновити PDF після редагування. Спробуйте зберегти ще раз.',
    )
    const polls = detailCalls().length
    await tick(30_000)
    expect(detailCalls()).toHaveLength(polls)
    expect(anchorClicks).toEqual([])
  })

  it('edit dialog refuses a summary over RESUME_LIMITS.summary', async () => {
    routeGets({ details: [detail()] })
    renderControls(row(PUBLISHED))
    const u = user()
    await u.click(await enabled('Редагувати'))
    fireEvent.change(await screen.findByLabelText('Підсумок'), {
      target: { value: 'x'.repeat(2001) },
    })
    await u.click(screen.getByRole('button', { name: 'Зберегти' }))
    expect(put).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog')).toHaveTextContent(
      'Поле «Підсумок» порожнє або перевищує ліміт.',
    )
  })

  it('edit dialog accepts a summary of exactly RESUME_LIMITS.summary', async () => {
    put.mockImplementation(() => ok({ renderId: RENDER_NEW }))
    routeGets({ details: [detail()] })
    renderControls(row(PUBLISHED))
    const u = user()
    await u.click(await enabled('Редагувати'))
    fireEvent.change(await screen.findByLabelText('Підсумок'), {
      target: { value: 'x'.repeat(2000) },
    })
    await u.click(screen.getByRole('button', { name: 'Зберегти' }))
    expect(put).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['Супровідний лист', ''],
    ['Acme — Engineer', ''],
  ])('edit dialog refuses an empty «%s»', async (label, value) => {
    routeGets({ details: [detail()] })
    renderControls(row(PUBLISHED))
    const u = user()
    await u.click(await enabled('Редагувати'))
    fireEvent.change(await screen.findByLabelText(label), { target: { value } })
    await u.click(screen.getByRole('button', { name: 'Зберегти' }))
    expect(put).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog')).toHaveTextContent('порожнє або перевищує ліміт')
  })

  it('a render in progress disables Download and Edit and says so', async () => {
    routeGets({ details: [detail({ pdfStatus: 'RUNNING' })] })
    renderControls(row({ ...PUBLISHED, pdfStatus: 'RUNNING' }))
    expect(await screen.findByRole('button', { name: 'Завантажити CV' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Редагувати' })).toBeDisabled()
    expect(screen.getByRole('status')).toHaveTextContent('Оновлюємо PDF…')
  })
})
