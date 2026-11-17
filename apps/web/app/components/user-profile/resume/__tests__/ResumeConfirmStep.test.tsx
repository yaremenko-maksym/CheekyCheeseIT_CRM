/**
 * ResumeConfirmStep rendered on its own: the summary facts line, the written blocks
 * (titles, periods, notes, edited badges, fallbacks), the inline edit (save, cancel,
 * shortcut, inline error), the busy state and the staged PDF card.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_RESUME_LAYOUT,
  EMPTY_RESUME_CONTENT,
  EMPTY_RESUME_FACTS,
  type SeniorResumeDto,
} from '@crm/shared'
import { loadCatalog, I18nTestProvider } from '@/test/i18n'

const { getMock, postMock, putMock, pdfMock } = vi.hoisted(() => ({
  getMock: vi.fn(),
  postMock: vi.fn(),
  putMock: vi.fn(),
  pdfMock: vi.fn(),
}))
vi.mock('@/lib/axios', () => ({ api: { get: getMock, post: postMock, put: putMock } }))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))
vi.mock('@/hooks/use-senior-resume', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/use-senior-resume')>()),
  useResumePdfBlob: pdfMock,
}))

import { API_BASE_URL } from '@/hooks/use-senior-resume'
import { FOCUS_REQUEST_TTL_MS, ResumeConfirmStep, useFocusAfterRender } from '../ResumeConfirmStep'

const USER = '33333333-3333-4333-8333-333333333333'
const RUN = '22222222-2222-4222-8222-222222222222'

type Staged = NonNullable<SeniorResumeDto['staged']>

const STAGED: Staged = {
  runId: RUN,
  content: {
    ...EMPTY_RESUME_CONTENT,
    summary: 'Backend engineer.',
    experience: [
      {
        role: 'Lead Engineer',
        company: 'Acme',
        period: '2020 — 2021',
        bullets: ['Built the API', 'Ran the team'],
      },
      { role: 'Lead Engineer', company: '', period: '', bullets: ['Wrote code'] },
    ],
  },
  layout: DEFAULT_RESUME_LAYOUT,
  templateName: 'classic',
  pdfAvailable: true,
  editedPaths: [],
}

const FACTS: SeniorResumeDto['facts'] = {
  ...EMPTY_RESUME_FACTS,
  headline: 'Backend',
  skills: ['a', 'b', 'c', 'd', 'e', 'f'],
  experience: [
    {
      company: 'Acme',
      role: 'Lead Engineer',
      location: null,
      start: '2020-01',
      end: '2021-12',
      current: false,
      technologies: [],
      notes: ['Built X'],
    },
  ],
}

function dto(overrides: Partial<SeniorResumeDto> = {}): SeniorResumeDto {
  return {
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
    facts: FACTS,
    verificationStatus: 'AWAITING_CONFIRM',
    verificationErrorCode: null,
    verificationReport: { gates: [], fallbacks: [] },
    verifiedVersion: null,
    verifiedAt: null,
    verifiedByName: null,
    recheckNeededAt: null,
    staged: STAGED,
    verificationBusy: false,
    ...overrides,
  }
}

function wrapper() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>
      <I18nTestProvider>{children}</I18nTestProvider>
    </QueryClientProvider>
  )
}

function step(resume: SeniorResumeDto, changingFacts = false) {
  return (
    <ResumeConfirmStep
      userId={USER}
      resume={resume}
      staged={resume.staged ?? STAGED}
      canConfirm
      changingFacts={changingFacts}
      onChangeFacts={() => {}}
      onStale={() => {}}
      onConfirmed={() => {}}
    />
  )
}

function renderStep(resume: SeniorResumeDto = dto()) {
  const view = render(step(resume), { wrapper: wrapper() })
  return {
    ...view,
    rerenderWith: (next: SeniorResumeDto, changingFacts = false) =>
      view.rerender(step(next, changingFacts)),
  }
}

const NULL_ANSWER = { data: { resume: null, canEdit: true, canConfirm: true } }

const apiError = (status: number, code: string) => ({
  response: { status, data: { statusCode: status, code, message: 'x' } },
})

beforeEach(async () => {
  vi.clearAllMocks()
  getMock.mockRejectedValue(new Error('no network here'))
  postMock.mockResolvedValue(NULL_ANSWER)
  putMock.mockResolvedValue(NULL_ANSWER)
  pdfMock.mockReturnValue({ blobUrl: null, isLoading: false, hasError: false })
  await loadCatalog('uk')
})

afterEach(() => {
  vi.useRealTimers()
})

const block = (i: number) => screen.getByTestId(`resume-confirm-block-experience-${i}`)
const summary = () => screen.getByTestId('resume-confirm-block-summary')

describe('ResumeConfirmStep — what the blocks show', () => {
  it('the summary facts line: headline, whole years, the first five skills', () => {
    renderStep()
    expect(within(summary()).getByText('Backend · 2 роки · a, b, c, d, e')).toBeInTheDocument()
  })

  it('the view tabs are named, and the busy lines show only while a run is busy', () => {
    const { rerenderWith } = renderStep()
    expect(screen.getByRole('tablist', { name: 'Перегляд' })).toBeInTheDocument()
    expect(screen.queryByTestId('resume-confirm-checking')).not.toBeInTheDocument()
    expect(screen.queryByText('Усі дії недоступні, поки триває перевірка.')).not.toBeInTheDocument()

    rerenderWith(dto({ verificationBusy: true }))
    const checking = screen.getByTestId('resume-confirm-checking')
    expect(checking).toHaveAttribute('tabindex', '-1')
    expect(checking.innerHTML).toContain('animate-pulse')
    expect(screen.getByText('Усі дії недоступні, поки триває перевірка.')).toBeInTheDocument()
  })

  it('a job title joins role and company, and drops an empty company', () => {
    renderStep()
    expect(
      within(block(0)).getByRole('heading', { name: 'Lead Engineer · Acme' }),
    ).toBeInTheDocument()
    expect(within(block(1)).getByRole('heading', { name: 'Lead Engineer' })).toBeInTheDocument()
  })

  it('the period shows in its own line, and an empty one shows nothing', () => {
    renderStep()
    expect(within(block(0)).getByText('2020 — 2021')).toHaveClass('tabular-nums')
    expect(block(1).innerHTML).not.toContain('tabular-nums')
  })

  it('notes come from the facts of the same job; a job without facts lists no notes', () => {
    renderStep()
    expect(within(block(0)).getByText('Built X')).toBeInTheDocument()
    // Block 1 has one written bullet and no facts behind it.
    expect(within(block(1)).getAllByRole('listitem')).toHaveLength(1)
  })

  it('the job regenerate button is named by its position', () => {
    renderStep()
    expect(
      within(block(0)).getByRole('button', { name: 'Згенерувати заново пункти, місце роботи 1' }),
    ).toBeInTheDocument()
  })

  it('a fallback on the summary shows its warning there', () => {
    renderStep(dto({ verificationReport: { gates: [], fallbacks: ['summary'] } }))
    expect(
      within(summary()).getByText(
        'Згенерований текст не пройшов звірку з фактами — тут ваші нотатки як є.',
      ),
    ).toBeInTheDocument()
    expect(
      within(block(0)).queryByText(
        'Згенерований текст не пройшов звірку з фактами — тут ваші нотатки як є.',
      ),
    ).not.toBeInTheDocument()
  })

  it('a hand-edited bullet gets a small badge, its block a full-size one', () => {
    const editedPaths = [
      { path: 'summary', userId: USER },
      { path: 'experience.0.bullets.1', userId: USER },
    ]
    renderStep(dto({ staged: { ...STAGED, editedPaths } }))
    const badges = within(block(0)).getAllByText('Змінено вручну')
    expect(badges).toHaveLength(2)
    const [full, small] = badges as [HTMLElement, HTMLElement]
    expect(full).toHaveClass('border-dashed')
    expect(full).not.toHaveClass('text-[11px]')
    expect(small).toHaveClass('border-dashed', 'px-1.5', 'py-0', 'text-[11px]')
    expect(within(block(1)).queryByText('Змінено вручну')).not.toBeInTheDocument()
  })
})

describe('ResumeConfirmStep — the inline edit', () => {
  const openBullet = () =>
    fireEvent.click(screen.getByRole('button', { name: 'Редагувати пункт 1, місце роботи 1' }))

  it('Save sends the typed text for the bullet path and closes the editor', async () => {
    renderStep()
    openBullet()
    fireEvent.change(screen.getByRole('textbox', { name: 'Пункт 1, місце роботи 1' }), {
      target: { value: 'Built the new API' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Зберегти' }))
    await waitFor(() =>
      expect(putMock).toHaveBeenCalledWith(`/users/${USER}/resume/staged`, {
        runId: RUN,
        path: 'experience.0.bullets.0',
        text: 'Built the new API',
      }),
    )
    await waitFor(() => expect(screen.queryByRole('textbox')).not.toBeInTheDocument())
  })

  it('Cancel and Escape close the editor and give focus back to its Edit button', async () => {
    renderStep()
    fireEvent.click(screen.getByRole('button', { name: 'Редагувати' }))
    fireEvent.click(screen.getByRole('button', { name: 'Скасувати' }))
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Редагувати' })).toHaveFocus())

    openBullet()
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' })
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Редагувати пункт 1, місце роботи 1' }),
      ).toHaveFocus(),
    )
  })

  it('Ctrl+Enter and Cmd+Enter save; plain Enter, other keys and a held key do not', async () => {
    renderStep()
    openBullet()
    const box = screen.getByRole('textbox')
    fireEvent.keyDown(box, { key: 'Enter' })
    fireEvent.keyDown(box, { key: 'a', ctrlKey: true })
    fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true, repeat: true })
    expect(putMock).not.toHaveBeenCalled()

    fireEvent.keyDown(box, { key: 'Enter', metaKey: true })
    await waitFor(() => expect(putMock).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.queryByRole('textbox')).not.toBeInTheDocument())

    openBullet()
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', ctrlKey: true })
    await waitFor(() => expect(putMock).toHaveBeenCalledTimes(2))
  })

  it('the shortcut does not save while the facts form is open', () => {
    const { rerenderWith } = renderStep()
    openBullet()
    rerenderWith(dto(), true)
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', ctrlKey: true })
    expect(putMock).not.toHaveBeenCalled()
  })

  it('a rejected text is shown under the field, any other error is not', async () => {
    putMock.mockRejectedValueOnce(apiError(400, 'RESUME_STAGED_TEXT_INVALID'))
    renderStep()
    openBullet()
    fireEvent.click(screen.getByRole('button', { name: 'Зберегти' }))
    const box = screen.getByRole('textbox')
    await waitFor(() => expect(box).toHaveAttribute('aria-invalid', 'true'))
    expect(box).toHaveAccessibleDescription()

    putMock.mockRejectedValueOnce(apiError(409, 'RESUME_CONFIRM_STALE'))
    fireEvent.click(screen.getByRole('button', { name: 'Зберегти' }))
    await waitFor(() => expect(box).not.toHaveAttribute('aria-invalid'))
    expect(block(0).innerHTML).not.toContain('text-destructive')
  })

  it('an answer without a resume closes the editor without a crash', async () => {
    renderStep()
    openBullet()
    fireEvent.click(screen.getByRole('button', { name: 'Зберегти' }))
    await waitFor(() => expect(screen.queryByRole('textbox')).not.toBeInTheDocument())

    fireEvent.click(within(summary()).getByRole('button', { name: 'Згенерувати заново' }))
    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith(`/users/${USER}/resume/staged/regenerate`, {
        runId: RUN,
        path: 'summary',
      }),
    )
  })

  it('a regenerate answer that is not busy does not pull focus to a later checking line', async () => {
    postMock.mockResolvedValueOnce({
      data: { resume: dto(), canEdit: true, canConfirm: true },
    })
    const { rerenderWith } = renderStep()
    fireEvent.click(within(summary()).getByRole('button', { name: 'Згенерувати заново' }))
    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1))
    await act(async () => {})
    rerenderWith(dto({ verificationBusy: true }))
    expect(screen.getByTestId('resume-confirm-checking')).not.toHaveFocus()
  })
})

describe('ResumeConfirmStep — the staged PDF', () => {
  it('asks for the staged PDF of this run and status, only when not busy', () => {
    const { rerenderWith } = renderStep()
    expect(pdfMock).toHaveBeenLastCalledWith(USER, true, `${RUN}:AWAITING_CONFIRM`, 'staged-pdf')
    rerenderWith(dto({ verificationBusy: true }))
    expect(pdfMock).toHaveBeenLastCalledWith(USER, false, `${RUN}:AWAITING_CONFIRM`, 'staged-pdf')
  })

  it('the download link shows only when not busy', () => {
    const { rerenderWith } = renderStep()
    expect(screen.getByRole('link', { name: 'Завантажити PDF' })).toHaveAttribute(
      'href',
      `${API_BASE_URL}/users/${USER}/resume/staged-pdf`,
    )
    rerenderWith(dto({ verificationBusy: true }))
    expect(screen.queryByRole('link', { name: 'Завантажити PDF' })).not.toBeInTheDocument()
  })

  it('the preview loads while busy or while the PDF is loading, and not otherwise', () => {
    const { rerenderWith } = renderStep()
    expect(screen.queryByText('Завантаження PDF…')).not.toBeInTheDocument()
    rerenderWith(dto({ verificationBusy: true }))
    expect(screen.getByText('Завантаження PDF…')).toBeInTheDocument()
    pdfMock.mockReturnValue({ blobUrl: null, isLoading: true, hasError: false })
    rerenderWith(dto())
    expect(screen.getByText('Завантаження PDF…')).toBeInTheDocument()
  })

  it('the fallback download names the file', () => {
    vi.useFakeTimers()
    pdfMock.mockReturnValue({ blobUrl: 'blob:staged', isLoading: false, hasError: false })
    renderStep()
    // The preview gives up on a blocked iframe after 3 s and offers the download instead.
    act(() => vi.advanceTimersByTime(3000))
    const links = screen.getAllByRole('link', { name: 'Завантажити PDF' })
    expect(links.map((a) => a.getAttribute('download'))).toContain(
      'Резюме перед підтвердженням.pdf',
    )
  })
})

function FocusProbe({ show }: { show: boolean }) {
  const focusAfterRender = useFocusAfterRender()
  return (
    <>
      <button type="button" onClick={() => focusAfterRender(['probe-target'])}>
        request
      </button>
      {show && (
        <button type="button" id="probe-target">
          target
        </button>
      )}
    </>
  )
}

describe('useFocusAfterRender — a new request restarts the wait', () => {
  it('a second request keeps the wait open past the first one’s deadline', () => {
    vi.useFakeTimers()
    const { rerender } = render(<FocusProbe show={false} />)
    fireEvent.click(screen.getByRole('button', { name: 'request' }))
    act(() => vi.advanceTimersByTime(FOCUS_REQUEST_TTL_MS - 400))
    fireEvent.click(screen.getByRole('button', { name: 'request' }))
    act(() => vi.advanceTimersByTime(500))
    rerender(<FocusProbe show />)
    expect(screen.getByRole('button', { name: 'target' })).toHaveFocus()
  })
})
