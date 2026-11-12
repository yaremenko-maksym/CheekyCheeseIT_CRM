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
  /** The POST answers `next`, and so does every resume GET after it. */
  const postMovesServerTo = (next: SeniorResumeResponse) =>
    postMock.mockImplementation(() => {
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
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        'Резюме змінилося після перевірки. Оновіть сторінку й перевірте його ще раз.',
      ),
    )
    const resumeGets = () =>
      getMock.mock.calls.filter(([url]) => url === `/users/${USER}/resume`).length
    await waitFor(() => expect(resumeGets()).toBe(2))
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

  it('no staged PDF fetch while busy', async () => {
    renderWired(makeResponse({ verificationStatus: 'QUEUED', verificationBusy: true }))
    const pdf = await screen.findByTestId('resume-staged-pdf')
    expect(stagedPdfGets()).toBe(0)
    // No download of a PDF the run is about to replace.
    expect(within(pdf).queryByRole('link', { name: 'Завантажити PDF' })).toBeNull()
  })
})

describe('ResumeVerificationPanel — rulings', () => {
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
})
