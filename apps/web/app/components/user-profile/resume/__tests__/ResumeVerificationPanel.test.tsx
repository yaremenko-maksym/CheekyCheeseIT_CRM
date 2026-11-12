/**
 * ResumeVerificationPanel — progress, the confirm step and the failure panel
 * (verified base resume design §5.3–§5.5).
 *
 * The panel runs the REAL resume query and action hooks over a stubbed `api`,
 * so a 409 is the error envelope the server sends and the refetch is a real
 * second GET, not a spy on the query client.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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
import { ResumeVerificationPanel } from '../ResumeVerificationPanel'

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

/** The panel fed by the real resume query, as ResumeTab feeds it. */
function Wired() {
  const { data } = useSeniorResume(USER)
  if (!data?.resume) return null
  return (
    <ResumeVerificationPanel
      userId={USER}
      resume={data.resume}
      canConfirm={data.canConfirm}
      onChangeFacts={() => {}}
    />
  )
}

function renderWired(response: SeniorResumeResponse) {
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
  return render(<Wired />, { wrapper: wrap })
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
