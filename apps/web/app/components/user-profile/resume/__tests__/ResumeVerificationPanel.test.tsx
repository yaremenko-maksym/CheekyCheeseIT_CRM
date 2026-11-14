/**
 * ResumeVerificationPanel — progress, the confirm step and the failure panel
 * (verified base resume design §5.3–§5.5).
 *
 * The panel runs the REAL resume query and action hooks over a stubbed `api`,
 * so a 409 is the error envelope the server sends and the refetch is a real
 * second GET, not a spy on the query client.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_RESUME_LAYOUT,
  EMPTY_RESUME_CONTENT,
  EMPTY_RESUME_FACTS,
  type SeniorResumeDto,
  type SeniorResumeResponse,
} from '@crm/shared'
import { loadCatalog, I18nTestProvider } from '@/test/i18n'

const { getMock, postMock, putMock, toastError } = vi.hoisted(() => ({
  getMock: vi.fn(),
  postMock: vi.fn(),
  putMock: vi.fn(),
  toastError: vi.fn(),
}))
vi.mock('@/lib/axios', () => ({ api: { get: getMock, post: postMock, put: putMock } }))
vi.mock('sonner', () => ({ toast: { error: toastError, success: vi.fn() } }))

import { useSeniorResume } from '@/hooks/use-senior-resume'
import { FOCUS_REQUEST_TTL_MS, useFocusAfterRender } from '../ResumeConfirmStep'
import { ResumeVerificationPanel, VerificationBadge } from '../ResumeVerificationPanel'

const RUN_ID = '22222222-2222-4222-8222-222222222222'
const USER = '33333333-3333-4333-8333-333333333333'

const STAGED: NonNullable<SeniorResumeDto['staged']> = {
  runId: RUN_ID,
  content: {
    ...EMPTY_RESUME_CONTENT,
    summary: 'Backend engineer with five years of TypeScript.',
    experience: [
      {
        company: 'Acme',
        role: 'Lead Engineer',
        period: '2021 - 2024',
        bullets: ['Led a team of five', 'Cut build time in half'],
      },
    ],
  },
  layout: DEFAULT_RESUME_LAYOUT,
  templateName: 'classic',
  pdfAvailable: true,
  editedPaths: [],
}

function makeResponse(
  overrides: Partial<SeniorResumeDto> = {},
  canConfirm = true,
): SeniorResumeResponse {
  const resume: SeniorResumeDto = {
    id: '11111111-1111-4111-8111-111111111111',
    userId: USER,
    content: EMPTY_RESUME_CONTENT,
    status: 'READY',
    errorCode: null,
    errorMessage: null,
    quotaResetsAt: null,
    sourceFileName: null,
    sourceFileSizeBytes: null,
    hasSourceFile: false,
    version: 3,
    updatedByUserId: null,
    updatedByName: null,
    createdAt: '2026-11-01T10:00:00.000Z',
    updatedAt: '2026-11-01T10:00:00.000Z',
    layout: DEFAULT_RESUME_LAYOUT,
    templateName: 'classic',
    hasCustomTemplate: false,
    renderStatus: 'READY',
    renderError: null,
    pdfUpToDate: true,
    facts: {
      ...EMPTY_RESUME_FACTS,
      headline: 'Backend Engineer',
      experience: [
        {
          company: 'Acme',
          role: 'Lead Engineer',
          location: null,
          start: '2021-01',
          end: '2024-06',
          current: false,
          technologies: ['TypeScript'],
          notes: ['Led a team of five people'],
        },
      ],
    },
    verificationStatus: 'AWAITING_CONFIRM',
    verificationErrorCode: null,
    verificationReport: { gates: [], fallbacks: [] },
    verifiedVersion: null,
    verifiedAt: null,
    verifiedByName: null,
    staged: STAGED,
    verificationBusy: false,
    ...overrides,
  }
  return { resume, canEdit: true, canConfirm }
}

/** The panel (and the toolbar badge) fed by the real resume query, as ResumeTab feeds them. */
function Wired() {
  const { data } = useSeniorResume(USER)
  if (!data?.resume) return null
  return (
    <>
      <VerificationBadge resume={data.resume} />
      <ResumeVerificationPanel
        userId={USER}
        resume={data.resume}
        canConfirm={data.canConfirm}
        onChangeFacts={() => {}}
      />
    </>
  )
}

const stagedPdfGets = () =>
  getMock.mock.calls.filter(([url]) => url === `/users/${USER}/resume/staged-pdf`).length

function renderWired(initial: SeniorResumeResponse) {
  let response = initial
  // The staged PDF is a blob jsdom cannot show; only the resume GET answers.
  getMock.mockImplementation((url: string) =>
    url.endsWith('/staged-pdf')
      ? Promise.reject(new Error('no PDF in jsdom'))
      : Promise.resolve({ data: response }),
  )
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const wrap = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>
      <I18nTestProvider>{children}</I18nTestProvider>
    </QueryClientProvider>
  )
  const view = render(<Wired />, { wrapper: wrap })
  /** The write (POST unless named) answers `next`, and so does every resume GET after it. */
  const postMovesServerTo = (next: SeniorResumeResponse, write = postMock) =>
    write.mockImplementation(() => {
      response = next
      return Promise.resolve({ data: next })
    })
  /** The server moved on: the next resume GET answers `next`, and the query refetches now. */
  const serverMovesTo = async (next: SeniorResumeResponse) => {
    response = next
    await act(() => qc.invalidateQueries())
  }
  return { ...view, serverMovesTo, postMovesServerTo }
}

beforeEach(async () => {
  vi.clearAllMocks()
  await loadCatalog('uk')
})

describe('ResumeVerificationPanel — confirm step', () => {
  it('F-1: the facts summary reads headline · years · top skills', async () => {
    renderWired(makeResponse())
    // 2021-01..2024-06 is 42 months: 3 whole years.
    expect(await screen.findByText('Backend Engineer · 3 роки · TypeScript')).toBeInTheDocument()
  })

  it('F-4: both tab panels, Tab stops by Radix design, show a visible focus ring', async () => {
    renderWired(makeResponse())
    await screen.findByTestId('resume-confirm-step')
    const panels = screen.getAllByRole('tabpanel', { hidden: true })
    expect(panels).toHaveLength(2)
    for (const panel of panels) expect(panel).toHaveClass('focus-visible:ring-2')
  })

  it('SENIOR sees no Confirm button', async () => {
    renderWired(makeResponse({}, false))
    expect(await screen.findByText('Перегляньте текст резюме')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Підтвердити' })).not.toBeInTheDocument()
    expect(
      screen.getByText('Резюме підтверджує HR. Ви можете змінити факти й надіслати знову.'),
    ).toBeInTheDocument()
    // Edit and Regenerate stay available to them.
    expect(screen.getByRole('button', { name: 'Згенерувати заново' })).toBeEnabled()
  })

  it('Confirm sends runId and version', async () => {
    postMock.mockResolvedValue({
      data: makeResponse({ verificationStatus: 'VERIFIED', staged: null }),
    })
    renderWired(makeResponse())
    fireEvent.click(await screen.findByRole('button', { name: 'Підтвердити' }))
    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith(`/users/${USER}/resume/confirm`, {
        runId: RUN_ID,
        version: 3,
      }),
    )
  })

  it('409 on confirm refetches', async () => {
    postMock.mockRejectedValue({
      response: {
        status: 409,
        data: { statusCode: 409, code: 'RESUME_CONFIRM_STALE', message: 'stale' },
      },
    })
    renderWired(makeResponse())
    fireEvent.click(await screen.findByRole('button', { name: 'Підтвердити' }))
    // The refetch answers what the server holds now: a newer staged result.
    const newer = makeResponse({
      version: 4,
      staged: { ...STAGED, content: { ...STAGED.content, summary: 'A newer staged summary.' } },
    })
    getMock.mockImplementation((url: string) =>
      url.endsWith('/staged-pdf')
        ? Promise.reject(new Error('no PDF in jsdom'))
        : Promise.resolve({ data: newer }),
    )
    const resumeGets = () =>
      getMock.mock.calls.filter(([url]) => url === `/users/${USER}/resume`).length
    await waitFor(() => expect(resumeGets()).toBe(2))
    expect(await screen.findByText('A newer staged summary.')).toBeInTheDocument()
    // Ruling R52: the inline notice is the only message for a stale run, and it
    // stays once the refetched result is on screen. No toast.
    expect(screen.getByTestId('resume-verification-stale')).toHaveTextContent(
      'Резюме змінилося після перевірки. Оновіть сторінку й перевірте його ще раз.',
    )
    expect(toastError).not.toHaveBeenCalled()
  })

  it('a non-stale error on confirm still toasts', async () => {
    postMock.mockRejectedValue({
      response: {
        status: 409,
        data: { statusCode: 409, code: 'RESUME_VERIFICATION_BUSY', message: 'busy' },
      },
    })
    renderWired(makeResponse())
    fireEvent.click(await screen.findByRole('button', { name: 'Підтвердити' }))
    await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1))
    // The uk catalog text for the code, never the server's English message.
    expect(toastError).toHaveBeenCalledWith(
      'Резюме зараз перевіряється. Зачекайте, доки перевірка завершиться.',
    )
    expect(screen.queryByTestId('resume-verification-stale')).toBeNull()
  })

  it('fallbacks listed as "kept from your notes"', async () => {
    renderWired(
      makeResponse({ verificationReport: { gates: [], fallbacks: ['experience.0.bullets.1'] } }),
    )
    const note = 'Згенерований текст не пройшов звірку з фактами — тут ваші нотатки як є.'
    const job = await screen.findByTestId('resume-confirm-block-experience-0')
    expect(within(job).getByText(note)).toBeInTheDocument()
    expect(within(screen.getByTestId('resume-confirm-block-summary')).queryByText(note)).toBeNull()
  })

  it('staged-edited path shows the "not fact-checked" mark', async () => {
    renderWired(
      makeResponse({
        staged: { ...STAGED, editedPaths: [{ path: 'summary', userId: USER }] },
      }),
    )
    const tip = 'Цей текст змінила людина — перевірку фактів для нього не запускали.'
    const summary = await screen.findByTestId('resume-confirm-block-summary')
    expect(within(summary).getByText('Змінено вручну')).toBeInTheDocument()
    expect(within(summary).getByTitle(tip)).toBeInTheDocument()
    const job = screen.getByTestId('resume-confirm-block-experience-0')
    expect(within(job).queryByText('Змінено вручну')).toBeNull()
  })

  it('an edited bullet badge is not nested in a <p> (QA-8 validateDOMNesting)', async () => {
    renderWired(
      makeResponse({
        staged: { ...STAGED, editedPaths: [{ path: 'experience.0.bullets.1', userId: USER }] },
      }),
    )
    const job = await screen.findByTestId('resume-confirm-block-experience-0')
    const badge = within(job).getAllByText('Змінено вручну').at(-1)
    expect(badge).toBeDefined()
    // The DOM nesting IS the behaviour under test; no Testing Library query expresses it.
    // eslint-disable-next-line testing-library/no-node-access
    expect(badge?.closest('p')).toBeNull()
    // eslint-disable-next-line testing-library/no-node-access
    expect(job.querySelector('p div')).toBeNull()
  })
})

describe('ResumeVerificationPanel — failure panel', () => {
  it('FAILED ATS_CHECK_FAILED shows the item path', async () => {
    renderWired(
      makeResponse({
        verificationStatus: 'FAILED',
        verificationErrorCode: 'ATS_CHECK_FAILED',
        staged: null,
        verificationReport: {
          gates: [
            {
              gate: 'ats',
              ok: false,
              items: [
                { path: 'experience[0].bullets[0]', reason: 'MISSING_TEXT' },
                { path: '', reason: 'HEADING_ORDER' },
                { path: 'pages[1]', reason: 'SOMETHING_NEW' },
              ],
            },
          ],
          fallbacks: [],
        },
      }),
    )
    const panel = await screen.findByRole('alert')
    expect(within(panel).getByText('ATS не прочитав PDF')).toBeInTheDocument()
    // A report path that maps to a facts field is a button.
    const row = within(panel).getByRole('button', { name: /Місце роботи 1 · Пункти/ })
    expect(row).toHaveTextContent('текст не знайдено в PDF')
    // An empty path is a resume-level line, never a field link.
    expect(within(panel).getByText('Резюме загалом')).toBeInTheDocument()
    expect(within(panel).queryByRole('button', { name: /Резюме загалом/ })).toBeNull()
    // A page row with an unknown reason gets the generic line, not the raw code.
    expect(within(panel).getByText('Сторінка 2')).toBeInTheDocument()
    expect(within(panel).getByText('автоматична перевірка не пройдена')).toBeInTheDocument()
    expect(within(panel).queryByText('SOMETHING_NEW')).toBeNull()
  })

  it.each(['ATS_CHECK_FAILED', 'GLYPH_CHECK_FAILED', 'VISUAL_CHECK_FAILED'] as const)(
    'FAILED %s without a report shows the whole-resume line its body points at (CR-L-3)',
    async (code) => {
      renderWired(
        makeResponse({
          verificationStatus: 'FAILED',
          verificationErrorCode: code,
          staged: null,
          verificationReport: null,
        }),
      )
      const panel = await screen.findByRole('alert')
      const items = within(panel).getByTestId('resume-verification-items')
      expect(within(items).getByText('Резюме загалом')).toBeInTheDocument()
      expect(within(items).getByText('автоматична перевірка не пройдена')).toBeInTheDocument()
      expect(within(items).queryByRole('button')).toBeNull()
    },
  )

  it('FAILED RENDER_FAILED without a report shows no list (its body names none)', async () => {
    renderWired(
      makeResponse({
        verificationStatus: 'FAILED',
        verificationErrorCode: 'RENDER_FAILED',
        staged: null,
        verificationReport: null,
      }),
    )
    const panel = await screen.findByRole('alert')
    expect(within(panel).queryByTestId('resume-verification-items')).toBeNull()
  })
})

describe('ResumeVerificationPanel — staged PDF', () => {
  it('staged PDF refetches when the check finishes (CHECKING -> AWAITING_CONFIRM)', async () => {
    const { serverMovesTo } = renderWired(makeResponse())
    await waitFor(() => expect(stagedPdfGets()).toBe(1))

    // A staged edit starts a run: same runId, the old PDF is still on the row.
    await serverMovesTo(makeResponse({ verificationStatus: 'CHECKING', verificationBusy: true }))
    expect(await screen.findByTestId('resume-confirm-checking')).toBeInTheDocument()
    expect(stagedPdfGets()).toBe(1)

    await serverMovesTo(makeResponse())
    await waitFor(() => expect(screen.queryByTestId('resume-confirm-checking')).toBeNull())
    await waitFor(() => expect(stagedPdfGets()).toBe(2))
  })

  it('names the template of the staged PDF', async () => {
    renderWired(makeResponse({ staged: { ...STAGED, templateName: 'modern' } }))
    const pdf = await screen.findByTestId('resume-staged-pdf')
    expect(within(pdf).getByTestId('resume-staged-pdf-template')).toHaveTextContent(
      'Шаблон: Сучасний',
    )
  })

  it('no staged PDF fetch while busy', async () => {
    renderWired(makeResponse({ verificationStatus: 'QUEUED', verificationBusy: true }))
    const pdf = await screen.findByTestId('resume-staged-pdf')
    expect(stagedPdfGets()).toBe(0)
    // No download of a PDF the run is about to replace.
    expect(within(pdf).queryByRole('link', { name: 'Завантажити PDF' })).toBeNull()
  })
})

describe('ResumeVerificationPanel — rulings', () => {
  it('F-3: each progress stage names its state for screen readers', async () => {
    renderWired(
      makeResponse({ verificationStatus: 'CHECKING', verificationBusy: true, staged: null }),
    )
    const progress = await screen.findByTestId('resume-verification-progress')
    const [queued, check, hr] = within(progress).getAllByRole('listitem')
    expect(queued).toHaveTextContent(/У черзі.*готово/)
    expect(check).toHaveTextContent(/Перевірка.*триває/)
    expect(check).toHaveAttribute('aria-current', 'step')
    expect(hr).toHaveTextContent(/Підтвердження HR.*очікує/)
  })

  it('a run with a staged result keeps the confirm step, read-only, progress line on top', async () => {
    renderWired(makeResponse({ verificationStatus: 'CHECKING', verificationBusy: true }))
    const step = await screen.findByTestId('resume-confirm-step')
    const checking = within(step).getByTestId('resume-confirm-checking')
    expect(checking).toHaveTextContent('Оновлюємо й перевіряємо текст…')
    const buttons = within(step).getAllByRole('button')
    // The line leads the step: it comes before every action in reading order.
    for (const button of buttons) {
      expect(checking.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
        Node.DOCUMENT_POSITION_FOLLOWING,
      )
    }
    expect(buttons.map((b) => b.textContent)).toEqual(
      expect.arrayContaining(['Підтвердити', 'Змінити факти', 'Згенерувати заново']),
    )
    for (const button of buttons) expect(button).toBeDisabled()
    expect(screen.queryByTestId('resume-verification-progress')).toBeNull()
  })

  it('VERIFIED with a code shows the warning and keeps the VERIFIED view', async () => {
    renderWired(
      makeResponse({
        verificationStatus: 'VERIFIED',
        verificationErrorCode: 'ATS_CHECK_FAILED',
        verifiedVersion: 3,
        verifiedAt: '2026-11-02T10:00:00.000Z',
        staged: null,
      }),
    )
    const warning = await screen.findByTestId('resume-verification-warning')
    expect(warning).toHaveTextContent(
      'Зміна шаблону чи оформлення не пройшла перевірку — залишено попередній варіант.',
    )
    expect(screen.getByTestId('resume-verification-badge')).toHaveTextContent('Перевірено')
    expect(screen.queryByTestId('resume-verification-failure')).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('the VERIFIED warning lists the failing fields its body points at (R63)', async () => {
    renderWired(
      makeResponse({
        verificationStatus: 'VERIFIED',
        verificationErrorCode: 'VISUAL_CHECK_FAILED',
        verifiedVersion: 3,
        staged: null,
        verificationReport: {
          gates: [
            {
              gate: 'visual',
              ok: false,
              items: [{ path: 'experience.0.bullets.0', reason: 'overflow' }],
            },
          ],
          fallbacks: [],
        },
      }),
    )
    const warning = await screen.findByTestId('resume-verification-warning')
    const items = within(warning).getByTestId('resume-verification-items')
    const row = within(items).getByRole('button', { name: /Місце роботи 1 · Пункти/ })
    expect(row).toHaveTextContent('текст виходить за поле')
  })

  it('FAILED INCOMPLETE with no gate items shows the whole-resume line its body points at (SO-3)', async () => {
    renderWired(
      makeResponse({
        verificationStatus: 'FAILED',
        verificationErrorCode: 'INCOMPLETE',
        staged: null,
        verificationReport: { gates: [], fallbacks: [] },
      }),
    )
    const panel = await screen.findByRole('alert')
    expect(panel).toHaveTextContent('заповніть поля зі списку')
    const items = within(panel).getByTestId('resume-verification-items')
    expect(within(items).getByText('Резюме загалом')).toBeInTheDocument()
  })

  it('a VERIFIED warning without item paths shows the whole-resume line, never an empty list', async () => {
    renderWired(
      makeResponse({
        verificationStatus: 'VERIFIED',
        verificationErrorCode: 'GLYPH_CHECK_FAILED',
        verifiedVersion: 3,
        staged: null,
        verificationReport: null,
      }),
    )
    const warning = await screen.findByTestId('resume-verification-warning')
    const items = within(warning).getByTestId('resume-verification-items')
    expect(within(items).getByText('Резюме загалом')).toBeInTheDocument()
    expect(within(items).getByText('автоматична перевірка не пройдена')).toBeInTheDocument()
    expect(within(items).queryByRole('button')).toBeNull()
  })

  it('a VERIFIED warning whose body names no list shows none', async () => {
    renderWired(
      makeResponse({
        verificationStatus: 'VERIFIED',
        verificationErrorCode: 'RENDER_FAILED',
        verifiedVersion: 3,
        staged: null,
      }),
    )
    const warning = await screen.findByTestId('resume-verification-warning')
    expect(within(warning).queryByTestId('resume-verification-items')).toBeNull()
  })

  it('a template run shows the neutral progress line, not the progress card', async () => {
    renderWired(
      makeResponse({
        verificationStatus: 'VERIFIED',
        verificationBusy: true,
        verifiedVersion: 3,
        staged: null,
      }),
    )
    const line = await screen.findByTestId('resume-verification-template-run')
    expect(line).toHaveTextContent('Перевіряємо нове оформлення')
    expect(screen.queryByTestId('resume-verification-progress')).toBeNull()
    expect(screen.queryByTestId('resume-confirm-step')).toBeNull()
  })
})

describe('ResumeVerificationPanel — focus (design §8)', () => {
  it('after Submit focus moves to the progress heading', async () => {
    const { postMovesServerTo } = renderWired(
      makeResponse({
        verificationStatus: 'FAILED',
        verificationErrorCode: 'ATS_CHECK_FAILED',
        staged: null,
      }),
    )
    postMovesServerTo(
      makeResponse({ verificationStatus: 'QUEUED', verificationBusy: true, staged: null }),
    )
    fireEvent.click(await screen.findByTestId('resume-verification-retry'))
    const heading = await screen.findByRole('heading', { name: 'У черзі на перевірку' })
    await waitFor(() => expect(heading).toHaveFocus())
  })

  it('the focused progress heading keeps focus as the run moves QUEUED -> CHECKING (QA-4)', async () => {
    const { postMovesServerTo, serverMovesTo } = renderWired(
      makeResponse({
        verificationStatus: 'FAILED',
        verificationErrorCode: 'ATS_CHECK_FAILED',
        staged: null,
      }),
    )
    postMovesServerTo(
      makeResponse({ verificationStatus: 'QUEUED', verificationBusy: true, staged: null }),
    )
    fireEvent.click(await screen.findByTestId('resume-verification-retry'))
    const queued = await screen.findByRole('heading', { name: 'У черзі на перевірку' })
    await waitFor(() => expect(queued).toHaveFocus())
    await serverMovesTo(
      makeResponse({ verificationStatus: 'CHECKING', verificationBusy: true, staged: null }),
    )
    const checking = await screen.findByRole('heading', { name: /Перевіряємо резюме/ })
    expect(checking).toHaveFocus()
  })

  it('after Confirm focus moves to the VERIFIED badge', async () => {
    const { postMovesServerTo } = renderWired(makeResponse())
    postMovesServerTo(
      makeResponse({
        verificationStatus: 'VERIFIED',
        verifiedVersion: 3,
        verifiedAt: '2026-11-02T10:00:00.000Z',
        staged: null,
      }),
    )
    fireEvent.click(await screen.findByRole('button', { name: 'Підтвердити' }))
    await waitFor(() =>
      expect(screen.getByTestId('resume-verification-badge')).toHaveTextContent('Перевірено'),
    )
    const status = screen.getByTestId('resume-verification-status')
    await waitFor(() => expect(status).toHaveFocus())
    expect(status).toContainElement(screen.getByTestId('resume-verification-badge'))
  })

  it('after a 409 "resume changed" focus moves to the notice', async () => {
    postMock.mockRejectedValue({
      response: {
        status: 409,
        data: { statusCode: 409, code: 'RESUME_CONFIRM_STALE', message: 'stale' },
      },
    })
    renderWired(makeResponse())
    fireEvent.click(await screen.findByRole('button', { name: 'Підтвердити' }))
    const notice = await screen.findByTestId('resume-verification-stale')
    expect(notice).toHaveTextContent(
      'Резюме змінилося після перевірки. Оновіть сторінку й перевірте його ще раз.',
    )
    await waitFor(() => expect(notice).toHaveFocus())
  })
  it('a non-busy retry answer moves no focus, even when a run starts soon after', async () => {
    const { postMovesServerTo, serverMovesTo } = renderWired(
      makeResponse({
        verificationStatus: 'FAILED',
        verificationErrorCode: 'ATS_CHECK_FAILED',
        staged: null,
      }),
    )
    postMovesServerTo(makeResponse({ verificationStatus: 'DRAFT', staged: null }))
    const retry = await screen.findByTestId('resume-verification-retry')
    retry.focus()
    fireEvent.click(retry)
    await waitFor(() => expect(screen.queryByTestId('resume-verification-retry')).toBeNull())
    // Within the focus TTL another run starts: its heading must not take focus.
    await serverMovesTo(
      makeResponse({ verificationStatus: 'QUEUED', verificationBusy: true, staged: null }),
    )
    const heading = await screen.findByRole('heading', { name: 'У черзі на перевірку' })
    expect(heading).not.toHaveFocus()
  })
})

describe('ResumeVerificationPanel — staged edits (fix round 3)', () => {
  const NEXT_RUN = '44444444-4444-4444-8444-444444444444'
  const nextRun = (overrides: Partial<SeniorResumeDto> = {}) =>
    makeResponse({ staged: { ...STAGED, runId: NEXT_RUN }, ...overrides })

  async function openSummaryEdit() {
    fireEvent.click(await screen.findByRole('button', { name: 'Редагувати' }))
    return screen.getByRole('textbox', { name: 'Про себе' })
  }

  it('Cmd+Enter while saving sends one request', async () => {
    let answer: (value: { data: SeniorResumeResponse }) => void = () => {}
    putMock.mockImplementation(
      () => new Promise<{ data: SeniorResumeResponse }>((resolve) => (answer = resolve)),
    )
    renderWired(makeResponse())
    const box = await openSummaryEdit()
    fireEvent.keyDown(box, { key: 'Enter', metaKey: true })
    // A held key repeats before the pending render lands.
    fireEvent.keyDown(box, { key: 'Enter', metaKey: true, repeat: true })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Зберегти' })).toBeDisabled())
    fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true })
    // The mutation calls the api a few microtasks after the key: let them run.
    await act(async () => {})
    expect(putMock).toHaveBeenCalledTimes(1)
    await act(async () => answer({ data: nextRun() }))
  })

  it('a new run closes the open inline edit', async () => {
    const { serverMovesTo } = renderWired(makeResponse())
    await openSummaryEdit()
    expect(
      screen.getByRole('button', { name: 'Редагувати пункт 1, місце роботи 1' }),
    ).toBeDisabled()
    await serverMovesTo(nextRun())
    await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Про себе' })).toBeNull())
    expect(screen.getByRole('button', { name: 'Редагувати' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Редагувати пункт 1, місце роботи 1' })).toBeEnabled()
  })

  it('Regenerate is disabled while an inline edit is open', async () => {
    renderWired(makeResponse())
    await openSummaryEdit()
    for (const button of screen.getAllByRole('button', { name: /Згенерувати заново/ }))
      expect(button).toBeDisabled()
  })

  it('a busy Save answer moves focus to the checking line', async () => {
    const { postMovesServerTo } = renderWired(makeResponse())
    postMovesServerTo(nextRun({ verificationStatus: 'QUEUED', verificationBusy: true }), putMock)
    await openSummaryEdit()
    fireEvent.click(screen.getByRole('button', { name: 'Зберегти' }))
    const checking = await screen.findByTestId('resume-confirm-checking')
    await waitFor(() => expect(checking).toHaveFocus())
  })

  it('a non-busy Save answer gives focus back to the block Edit button', async () => {
    const { postMovesServerTo } = renderWired(makeResponse())
    postMovesServerTo(nextRun(), putMock)
    await openSummaryEdit()
    fireEvent.click(screen.getByRole('button', { name: 'Зберегти' }))
    const editButton = await screen.findByRole('button', { name: 'Редагувати' })
    await waitFor(() => expect(editButton).toHaveFocus())
  })

  it('a busy Regenerate answer moves focus to the checking line', async () => {
    const { postMovesServerTo } = renderWired(makeResponse())
    postMovesServerTo(nextRun({ verificationStatus: 'QUEUED', verificationBusy: true }))
    fireEvent.click(await screen.findByRole('button', { name: 'Згенерувати заново' }))
    const checking = await screen.findByTestId('resume-confirm-checking')
    await waitFor(() => expect(checking).toHaveFocus())
  })
})

describe('useFocusAfterRender', () => {
  function Probe({ show }: { show: boolean }) {
    const focusAfterRender = useFocusAfterRender()
    return (
      <>
        <button type="button" onClick={() => focusAfterRender(['probe-target'])}>
          ask
        </button>
        {show && (
          <h3 id="probe-target" tabIndex={-1}>
            target
          </h3>
        )}
      </>
    )
  }

  it('focuses a target that renders within the TTL', () => {
    vi.useFakeTimers()
    try {
      const { rerender } = render(<Probe show={false} />)
      fireEvent.click(screen.getByRole('button', { name: 'ask' }))
      act(() => vi.advanceTimersByTime(FOCUS_REQUEST_TTL_MS - 1))
      rerender(<Probe show />)
      expect(screen.getByRole('heading', { name: 'target' })).toHaveFocus()
    } finally {
      vi.useRealTimers()
    }
  })

  it('focus request expires when no target renders', () => {
    vi.useFakeTimers()
    try {
      const { rerender } = render(<Probe show={false} />)
      fireEvent.click(screen.getByRole('button', { name: 'ask' }))
      act(() => vi.advanceTimersByTime(FOCUS_REQUEST_TTL_MS))
      rerender(<Probe show />)
      expect(screen.getByRole('heading', { name: 'target' })).not.toHaveFocus()
    } finally {
      vi.useRealTimers()
    }
  })

  it('waits for a disabled target to be enabled', () => {
    // A staged Save answers before the pending render ends: the Edit button is still disabled.
    function Gate({ enabled }: { enabled: boolean }) {
      const focusAfterRender = useFocusAfterRender()
      return (
        <>
          <button type="button" onClick={() => focusAfterRender(['gate-target'])}>
            ask
          </button>
          <button id="gate-target" type="button" disabled={!enabled}>
            target
          </button>
        </>
      )
    }
    const { rerender } = render(<Gate enabled={false} />)
    fireEvent.click(screen.getByRole('button', { name: 'ask' }))
    rerender(<Gate enabled />)
    expect(screen.getByRole('button', { name: 'target' })).toHaveFocus()
  })
})
