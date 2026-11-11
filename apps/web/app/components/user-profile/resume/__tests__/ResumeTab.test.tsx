/**
 * ResumeTab behaviour (task-resume-base §3, AC3/AC5/AC7; verified base resume
 * design §3/§4 — the facts form replaces the per-section content editors).
 *
 * The data hooks are mocked so each state of the server-side machine can be
 * rendered deterministically — the wiring to the real endpoints is covered by
 * ResumeFactsForm.test.tsx (real hooks over a stubbed api), the API
 * integration spec and the E2E run, not here.
 */
import {
  fireEvent,
  render as rtlRender,
  screen,
  waitFor,
  within,
  type RenderOptions,
} from '@testing-library/react'
import type { ReactElement } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_RESUME_LAYOUT,
  EMPTY_RESUME_CONTENT,
  EMPTY_RESUME_FACTS,
  type SeniorResumeDto,
  type SeniorResumeResponse,
} from '@crm/shared'
import { loadCatalog, I18nTestProvider } from '@/test/i18n'

function render(ui: ReactElement, options?: RenderOptions) {
  return rtlRender(ui, { wrapper: I18nTestProvider, ...options })
}

const { saveFactsMock, submitMock, saveLayoutMock, uploadMock, ingestTextMock, deleteMock, state } =
  vi.hoisted(() => ({
    saveFactsMock: vi.fn(),
    submitMock: vi.fn(),
    saveLayoutMock: vi.fn(),
    uploadMock: vi.fn(),
    ingestTextMock: vi.fn(),
    deleteMock: vi.fn(),
    state: {
      resumeData: { resume: null, canEdit: true, canConfirm: false } as unknown,
      isLoading: false,
      // Mutable so a test can observe the delete confirm button's isPending-driven text.
      deleteIsPending: false,
    },
  }))

vi.mock('@/hooks/use-senior-resume', () => ({
  useSeniorResume: () => ({ data: state.resumeData, isLoading: state.isLoading, isError: false }),
  useSaveResumeFacts: () => ({ mutateAsync: saveFactsMock, isPending: false }),
  useSubmitResume: () => ({ mutateAsync: submitMock, isPending: false }),
  useSaveResumeLayout: () => ({ mutate: saveLayoutMock, isPending: false }),
  useUploadResumeSource: () => ({ mutate: uploadMock, isPending: false }),
  useIngestResumeText: () => ({ mutate: ingestTextMock, isPending: false }),
  useDeleteResume: () => ({ mutate: deleteMock, isPending: state.deleteIsPending }),
  useResumeSourceUrl: () => ({ data: undefined }),
  // No blob here: jsdom cannot load a blob iframe; the preview is covered elsewhere.
  useResumePdfBlob: () => ({ blobUrl: null, isLoading: false, hasError: false }),
  resumePdfUrl: (userId: string) => `/api/users/${userId}/resume/pdf`,
}))

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

import { ResumeTab } from '../ResumeTab'

function setData(data: SeniorResumeResponse) {
  state.resumeData = data
}

function makeResponse(
  overrides: Partial<SeniorResumeDto> = {},
  canEdit = true,
): SeniorResumeResponse {
  const resume: SeniorResumeDto = {
    id: '11111111-1111-4111-8111-111111111111',
    userId: 'senior-1',
    content: EMPTY_RESUME_CONTENT,
    status: 'READY',
    errorCode: null,
    errorMessage: null,
    quotaResetsAt: null,
    sourceFileName: null,
    sourceFileSizeBytes: null,
    hasSourceFile: false,
    version: 1,
    updatedByUserId: null,
    updatedByName: null,
    createdAt: '2026-08-07T10:00:00.000Z',
    updatedAt: '2026-08-07T10:00:00.000Z',
    layout: DEFAULT_RESUME_LAYOUT,
    templateName: 'classic',
    hasCustomTemplate: false,
    renderStatus: 'READY',
    renderError: null,
    pdfUpToDate: true,
    facts: EMPTY_RESUME_FACTS,
    verificationStatus: 'DRAFT',
    verificationErrorCode: null,
    verificationReport: null,
    verifiedVersion: null,
    verifiedAt: null,
    verifiedByName: null,
    staged: null,
    verificationBusy: false,
    ...overrides,
  }
  return { resume, canEdit, canConfirm: false }
}

const FILLED = makeResponse({
  content: {
    summary: 'Senior developer',
    skills: ['TypeScript'],
    experience: [{ company: 'Acme', role: 'Lead', period: '2021—2024', bullets: ['Led a team'] }],
    education: [],
    languages: [],
    links: [],
  },
  facts: { ...EMPTY_RESUME_FACTS, headline: 'Backend Engineer' },
})

const tab = (props: { displayName?: string; onDirtyChange?: (dirty: boolean) => void } = {}) => (
  <ResumeTab userId="senior-1" displayName={props.displayName ?? 'Alex Doe'} {...props} />
)

beforeEach(async () => {
  vi.clearAllMocks()
  state.resumeData = { resume: null, canEdit: true, canConfirm: false }
  state.isLoading = false
  state.deleteIsPending = false
  saveFactsMock.mockResolvedValue(undefined)
  submitMock.mockResolvedValue(undefined)
  await loadCatalog('uk')
})

describe('ResumeTab — empty state', () => {
  it('invites an editor to fill the facts by hand or upload to prefill', () => {
    render(tab())
    expect(screen.getByTestId('resume-intake')).toBeInTheDocument()
    expect(screen.getByTestId('resume-upload-button')).toBeInTheDocument()
    expect(screen.getByTestId('resume-paste-toggle')).toBeInTheDocument()
    expect(screen.getByTestId('resume-fill-manually')).toBeInTheDocument()
    expect(screen.queryByTestId('resume-facts-form')).not.toBeInTheDocument()
  })

  it('"Заповнити вручну" opens the empty facts form', () => {
    render(tab())
    fireEvent.click(screen.getByTestId('resume-fill-manually'))
    expect(screen.getByTestId('resume-facts-form')).toBeInTheDocument()
    expect(screen.getByLabelText('Цільова посада')).toHaveValue('')
  })

  it('shows a read-only message instead of the upload UI when the viewer cannot edit', () => {
    setData({ resume: null, canEdit: false, canConfirm: false })
    render(tab())
    expect(screen.getByTestId('resume-empty-readonly')).toBeInTheDocument()
    expect(screen.queryByTestId('resume-upload-button')).not.toBeInTheDocument()
    expect(screen.queryByTestId('resume-fill-manually')).not.toBeInTheDocument()
  })

  it('paste-text flow submits the text through the ingest mutation', () => {
    render(tab())
    fireEvent.click(screen.getByTestId('resume-paste-toggle'))
    fireEvent.change(screen.getByTestId('resume-text-input'), {
      target: { value: 'Alex Doe, a senior developer with plenty of experience.' },
    })
    fireEvent.click(screen.getByTestId('resume-text-submit'))
    expect(ingestTextMock).toHaveBeenCalledWith(
      'Alex Doe, a senior developer with plenty of experience.',
    )
  })
})

describe('ResumeTab — extraction states (AC3/AC5)', () => {
  it('QUEUED shows named progress, not a bare spinner, and keeps the facts form reachable', () => {
    setData(makeResponse({ status: 'QUEUED' }))
    render(tab())
    expect(screen.getByTestId('resume-progress')).toHaveTextContent('черзі на розпізнавання')
    expect(screen.getByTestId('resume-facts-form')).toBeInTheDocument()
  })

  it('RUNNING shows its own copy', () => {
    setData(makeResponse({ status: 'RUNNING' }))
    render(tab())
    expect(screen.getByTestId('resume-progress')).toHaveTextContent('Розпізнаємо резюме')
  })

  it('FAILED/NO_TEXT explains the scan case and offers pasting text', () => {
    setData(
      makeResponse({
        status: 'FAILED',
        errorCode: 'NO_TEXT',
        errorMessage: 'No text could be extracted',
      }),
    )
    render(tab())
    expect(screen.getByTestId('resume-failed')).toHaveTextContent('немає текстового шару')
    expect(screen.getByTestId('resume-paste-toggle')).toBeInTheDocument()
  })

  it('AC5: QUOTA_EXCEEDED names the reset moment and leaves the facts editable', () => {
    setData(
      makeResponse({
        status: 'FAILED',
        errorCode: 'QUOTA_EXCEEDED',
        errorMessage: 'Daily AI quota exhausted.',
        quotaResetsAt: '2026-08-08T00:00:00.000Z',
      }),
    )
    render(tab())
    const panel = screen.getByTestId('resume-failed')
    expect(panel).toHaveTextContent('ліміт')
    expect(panel).toHaveTextContent('серпня')
    expect(screen.getByLabelText('Цільова посада')).toBeEnabled()
  })

  it('AI_NOT_CONFIGURED tells the user to fill it in by hand', () => {
    setData(makeResponse({ status: 'FAILED', errorCode: 'AI_NOT_CONFIGURED' }))
    render(tab())
    expect(screen.getByTestId('resume-failed')).toHaveTextContent('вручну')
  })
})

describe('ResumeTab — facts form', () => {
  it('shows the stored facts, the Draft badge and no "facts changed" line before a first check', () => {
    setData(FILLED)
    render(tab())
    expect(screen.getByLabelText('Цільова посада')).toHaveValue('Backend Engineer')
    expect(screen.getByTestId('resume-verification-badge')).toHaveTextContent('Чернетка')
    expect(
      screen.queryByText('Факти змінено. Надішліть резюме на перевірку знову.'),
    ).not.toBeInTheDocument()
  })

  it('a DRAFT that was verified before says the facts changed', () => {
    setData(makeResponse({ ...(FILLED.resume as SeniorResumeDto), verifiedVersion: 3 }))
    render(tab())
    expect(
      screen.getByText('Факти змінено. Надішліть резюме на перевірку знову.'),
    ).toBeInTheDocument()
  })

  it('while a check runs the form is read-only and Submit is disabled', () => {
    setData(
      makeResponse({
        ...(FILLED.resume as SeniorResumeDto),
        verificationStatus: 'CHECKING',
        verificationBusy: true,
      }),
    )
    render(tab())
    expect(screen.getByLabelText('Цільова посада')).toBeDisabled()
    expect(screen.getByTestId('resume-facts-submit')).toBeDisabled()
  })

  it('the profile name feeds the live check (R32): a Cyrillic name is listed, not editable here', () => {
    setData(FILLED)
    render(tab({ displayName: 'Олександр Доу' }))
    const list = screen.getByRole('list', { name: 'Незаповнені поля' })
    expect(
      within(list).getByText('Ім’я в профілі має бути латиницею. Змініть його в профілі'),
    ).toBeInTheDocument()
  })

  it('Save sends the facts through the facts mutation', async () => {
    setData(FILLED)
    render(tab())
    fireEvent.change(screen.getByLabelText('Цільова посада'), {
      target: { value: 'Platform Engineer' },
    })
    fireEvent.click(screen.getByTestId('resume-facts-save'))
    await waitFor(() => expect(saveFactsMock).toHaveBeenCalledTimes(1))
    expect(saveFactsMock).toHaveBeenCalledWith({
      facts: expect.objectContaining({ headline: 'Platform Engineer' }),
      silent: false,
    })
  })

  it('reports unsaved facts upward so the profile shell can guard the tab switch', () => {
    setData(FILLED)
    const onDirtyChange = vi.fn()
    render(tab({ onDirtyChange }))
    expect(onDirtyChange).toHaveBeenLastCalledWith(false)
    fireEvent.change(screen.getByLabelText('Цільова посада'), { target: { value: 'Changed' } })
    expect(onDirtyChange).toHaveBeenLastCalledWith(true)
  })

  it('registers exactly one beforeunload listener for the whole tab', () => {
    setData(FILLED)
    const addSpy = vi.spyOn(window, 'addEventListener')
    render(tab())
    fireEvent.change(screen.getByLabelText('Цільова посада'), { target: { value: 'Changed' } })
    const unloadRegistrations = addSpy.mock.calls.filter(([type]) => type === 'beforeunload')
    expect(unloadRegistrations).toHaveLength(1)
    addSpy.mockRestore()
  })
})

describe('ResumeTab — a viewer without write access', () => {
  it('sees the resume text read-only and no facts form', () => {
    setData(makeResponse(FILLED.resume as SeniorResumeDto, false))
    render(tab())
    expect(screen.getByTestId('resume-summary-view')).toHaveTextContent('Senior developer')
    expect(screen.queryByTestId('resume-facts-form')).not.toBeInTheDocument()
    for (const [id, title] of [
      ['summary', 'Про себе'],
      ['skills', 'Навички'],
      ['experience', 'Досвід роботи'],
      ['education', 'Освіта'],
      ['languages', 'Мови'],
      ['links', 'Посилання'],
    ] as const) {
      expect(
        within(screen.getByTestId(`resume-section-${id}`)).getByText(title),
      ).toBeInTheDocument()
    }
  })

  it('an empty resume reads as not filled in yet', () => {
    setData(makeResponse({}, false))
    render(tab())
    expect(screen.getByTestId('resume-empty-readonly')).toBeInTheDocument()
  })
})

describe('ResumeTab — AC7 untrusted content rendering', () => {
  const INJECTED_MARKUP = '<img src=x onerror=alert(1)>'

  it('renders markup from a resume as literal text, never as HTML', () => {
    setData(makeResponse({ content: { ...EMPTY_RESUME_CONTENT, summary: INJECTED_MARKUP } }, false))
    render(tab())
    const view = screen.getByTestId('resume-summary-view')
    expect(view).toHaveTextContent(INJECTED_MARKUP)
    // `hidden: true`: an injected `<img>` may carry aria-hidden and still run its onerror.
    expect(within(view).queryByRole('img', { hidden: true })).toBeNull()
  })

  /** The absence check above has teeth: the same query DOES find a real `<img>`. */
  it('the "no <img> was created" check is not vacuous — the query finds a real one', () => {
    render(
      <div data-testid="xss-control">
        <img src="x" />
      </div>,
    )
    const control = screen.getByTestId('xss-control')
    expect(within(control).getByRole('img', { hidden: true })).toBeInTheDocument()
  })

  it('refuses to make a javascript: link clickable — it degrades to plain text', () => {
    setData(
      makeResponse(
        {
          content: {
            ...EMPTY_RESUME_CONTENT,
            links: [
              { label: 'Bad', url: 'javascript:alert(1)' },
              { label: 'Good', url: 'https://example.com' },
            ],
          },
        },
        false,
      ),
    )
    render(tab())
    const list = screen.getByTestId('resume-links-view')
    const anchors = within(list).getAllByRole('link')
    expect(anchors).toHaveLength(1)
    expect(anchors[0]).toHaveAttribute('href', 'https://example.com')
    expect(list).toHaveTextContent('Bad')
  })
})

describe('ResumeTab — downloads', () => {
  it('offers the PDF as a plain link (no post-await window.open, which mobile blocks)', () => {
    setData(FILLED)
    render(tab())
    const link = screen.getByTestId('resume-download-pdf')
    expect(link.tagName).toBe('A')
    expect(link).toHaveAttribute('href', '/api/users/senior-1/resume/pdf')
  })

  it('does not offer a PDF of an empty resume', () => {
    setData(makeResponse({ content: EMPTY_RESUME_CONTENT, status: 'FAILED' }))
    render(tab())
    expect(screen.queryByTestId('resume-download-pdf')).not.toBeInTheDocument()
  })

  it('does not offer erasure to a viewer without write access', () => {
    setData(makeResponse(FILLED.resume as SeniorResumeDto, false))
    render(tab())
    expect(screen.queryByTestId('resume-delete')).not.toBeInTheDocument()
  })

  it('shows the version and the last editor', () => {
    setData(
      makeResponse({
        ...(FILLED.resume as SeniorResumeDto),
        version: 7,
        updatedByName: 'HR Ivanova',
      }),
    )
    render(tab())
    expect(screen.getByTestId('resume-tab')).toHaveTextContent('Версія 7')
    expect(screen.getByTestId('resume-tab')).toHaveTextContent('HR Ivanova')
  })
})

/**
 * Erasure of personal data. Irreversible, and it takes the stored original with
 * it, so it must ask first and say exactly what disappears.
 */
describe('ResumeTab — deleting the resume', () => {
  it('asks before erasing anything', () => {
    setData(FILLED)
    render(tab())
    fireEvent.click(screen.getByTestId('resume-delete'))
    expect(screen.getByTestId('resume-delete-confirm-dialog')).toBeInTheDocument()
    expect(deleteMock).not.toHaveBeenCalled()
  })

  it('names the stored file that is about to go with it', () => {
    setData(
      makeResponse({
        ...(FILLED.resume as SeniorResumeDto),
        hasSourceFile: true,
        sourceFileName: 'resume-ivanova.pdf',
      }),
    )
    render(tab())
    fireEvent.click(screen.getByTestId('resume-delete'))
    expect(screen.getByTestId('resume-delete-confirm-dialog')).toHaveTextContent(
      'resume-ivanova.pdf',
    )
  })

  it('erases once confirmed', () => {
    setData(FILLED)
    render(tab())
    fireEvent.click(screen.getByTestId('resume-delete'))
    fireEvent.click(screen.getByTestId('resume-delete-confirm'))
    expect(deleteMock).toHaveBeenCalledTimes(1)
  })

  it('erases nothing when the dialog is dismissed', () => {
    setData(FILLED)
    render(tab())
    fireEvent.click(screen.getByTestId('resume-delete'))
    fireEvent.click(screen.getByTestId('resume-delete-cancel'))
    expect(deleteMock).not.toHaveBeenCalled()
  })

  it('is not offered before a resume exists', () => {
    render(tab())
    expect(screen.queryByTestId('resume-delete')).not.toBeInTheDocument()
  })

  it('is reachable when a file is stored but nothing was extracted', () => {
    setData(makeResponse({ hasSourceFile: true, sourceFileName: 'resume.pdf' }))
    render(tab())
    fireEvent.click(screen.getByTestId('resume-delete'))
    fireEvent.click(screen.getByTestId('resume-delete-confirm'))
    expect(deleteMock).toHaveBeenCalledTimes(1)
  })

  it('the confirm button reads "Видалити" while idle', () => {
    setData(FILLED)
    render(tab())
    fireEvent.click(screen.getByTestId('resume-delete'))
    expect(screen.getByTestId('resume-delete-confirm')).toHaveTextContent('Видалити')
    expect(screen.getByTestId('resume-delete-confirm')).not.toHaveTextContent('Видаляємо')
  })

  it('the confirm button says "Видаляємо…" while pending, and disables itself', () => {
    setData(FILLED)
    state.deleteIsPending = true
    render(tab())
    fireEvent.click(screen.getByTestId('resume-delete'))
    expect(screen.getByTestId('resume-delete-confirm')).toHaveTextContent('Видаляємо…')
    expect(screen.getByTestId('resume-delete-confirm')).toBeDisabled()
  })
})
