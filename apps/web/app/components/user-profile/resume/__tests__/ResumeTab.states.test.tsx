/**
 * ResumeTab: the edges ResumeTab.test.tsx leaves open — which content counts as
 * "filled in" for a read-only viewer, the manual-form dialog and focus state, the
 * upload from the empty state, the retry intake lock, the "facts changed" line,
 * a dirty-callback swap and a Submit answer without a resume.
 *
 * Same mocked hooks as ResumeTab.test.tsx (that file is at its size limit).
 */
import { act, fireEvent, render as rtlRender, screen, waitFor } from '@testing-library/react'
import type { ReactElement } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_RESUME_LAYOUT,
  EMPTY_RESUME_CONTENT,
  EMPTY_RESUME_FACTS,
  type ResumeContent,
  type ResumeFacts,
  type SeniorResumeDto,
  type SeniorResumeResponse,
} from '@crm/shared'
import { loadCatalog, I18nTestProvider } from '@/test/i18n'

const render = (ui: ReactElement) => rtlRender(ui, { wrapper: I18nTestProvider })

const { saveFactsMock, submitMock, uploadMock, state } = vi.hoisted(() => ({
  saveFactsMock: vi.fn(),
  submitMock: vi.fn(),
  uploadMock: vi.fn(),
  state: { resumeData: { resume: null, canEdit: true, canConfirm: false } as unknown },
}))

vi.mock('@/hooks/use-senior-resume', () => ({
  useSeniorResume: () => ({ data: state.resumeData, isLoading: false, isError: false }),
  useSaveResumeFacts: () => ({ mutateAsync: saveFactsMock, isPending: false }),
  useSubmitResume: () => ({ mutateAsync: submitMock, isPending: false }),
  useSaveResumeLayout: () => ({ mutate: vi.fn(), isPending: false }),
  useSaveResumeHeader: () => ({ mutate: vi.fn(), isPending: false }),
  useSetResumeTemplate: () => ({ mutate: vi.fn(), isPending: false }),
  useUploadResumeSource: () => ({ mutate: uploadMock, isPending: false }),
  useIngestResumeText: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteResume: () => ({ mutate: vi.fn(), isPending: false }),
  useResumeSourceUrl: () => ({ data: undefined }),
  useResumePdfBlob: () => ({ blobUrl: null, isLoading: false, hasError: false }),
  resumePdfUrl: (userId: string) => `/api/users/${userId}/resume/pdf`,
  useConfirmResume: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useEditStagedField: () => ({
    mutateAsync: vi.fn(),
    reset: vi.fn(),
    isPending: false,
    error: null,
  }),
  useRegenerateStagedField: () => ({ mutateAsync: vi.fn(), isPending: false }),
  API_BASE_URL: '/api',
}))

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

import { ResumeTab } from '../ResumeTab'

function response(overrides: Partial<SeniorResumeDto> = {}, canEdit = true): SeniorResumeResponse {
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
    recheckNeededAt: null,
    header: { displayName: null, email: null, phone: null, telegram: null },
    headerDefaults: {
      displayName: 'Jane Doe',
      email: 'jane@example.com',
      phone: null,
      telegram: null,
    },
    staged: null,
    verificationBusy: false,
    ...overrides,
  }
  return { resume, canEdit, canConfirm: false }
}

const setData = (data: SeniorResumeResponse) => {
  state.resumeData = data
}

const tab = (onDirtyChange?: (dirty: boolean) => void) => (
  <ResumeTab userId="senior-1" displayName="Alex Doe" {...(onDirtyChange && { onDirtyChange })} />
)

const COMPLETE_FACTS: ResumeFacts = {
  ...EMPTY_RESUME_FACTS,
  headline: 'Backend Engineer',
  skills: ['TypeScript', 'Node.js', 'PostgreSQL', 'React', 'Docker'],
  experience: [
    {
      company: 'Acme',
      role: 'Lead Engineer',
      location: null,
      start: '2021-01',
      end: '2024-06',
      current: false,
      technologies: [],
      notes: ['Led a team of five people'],
    },
  ],
  languages: [{ name: 'English', level: 'C1' }],
}

const FACTS_CHANGED = 'Факти змінено. Надішліть резюме на перевірку знову.'

beforeEach(async () => {
  vi.clearAllMocks()
  state.resumeData = { resume: null, canEdit: true, canConfirm: false }
  saveFactsMock.mockResolvedValue(undefined)
  await loadCatalog('uk')
})

describe('ResumeTab — what a read-only viewer counts as filled in', () => {
  it.each<[string, Partial<ResumeContent>]>([
    ['a summary', { summary: 'Senior developer' }],
    ['skills only', { skills: ['TypeScript'] }],
    [
      'experience only',
      { experience: [{ company: 'Acme', role: 'Lead', period: '2021', bullets: [] }] },
    ],
    ['education only', { education: [{ institution: 'KPI', degree: 'BSc', period: '2015' }] }],
    ['languages only', { languages: [{ name: 'English', level: 'C1' }] }],
    ['links only', { links: [{ label: 'GitHub', url: 'https://github.com/alex' }] }],
  ])('%s is a resume to show, not the "not filled in" line', (_, part) => {
    setData(response({ content: { ...EMPTY_RESUME_CONTENT, ...part } }, false))
    render(tab())
    expect(screen.queryByTestId('resume-empty-readonly')).not.toBeInTheDocument()
    expect(screen.getByTestId('resume-section-summary')).toBeInTheDocument()
  })

  it('a summary of spaces alone is not filled in', () => {
    setData(response({ content: { ...EMPTY_RESUME_CONTENT, summary: '   ' } }, false))
    render(tab())
    expect(screen.getByTestId('resume-empty-readonly')).toBeInTheDocument()
  })
})

describe('ResumeTab — the empty state and the manual form', () => {
  it('nothing has focus on the first render, and the manual form opens with no dialog', () => {
    render(tab())
    expect(screen.getByTestId('resume-fill-manually')).not.toHaveFocus()
    fireEvent.click(screen.getByTestId('resume-fill-manually'))
    expect(screen.getByTestId('resume-facts-form')).toBeInTheDocument()
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  })

  it('after leaving typed facts, reopening the manual form shows no leftover dialog', () => {
    render(tab())
    fireEvent.click(screen.getByTestId('resume-fill-manually'))
    fireEvent.change(screen.getByLabelText('Цільова посада'), { target: { value: 'Typed' } })
    fireEvent.click(screen.getByTestId('resume-manual-back'))
    fireEvent.click(screen.getByRole('button', { name: 'Покинути' }))
    fireEvent.click(screen.getByTestId('resume-fill-manually'))
    expect(screen.getByTestId('resume-facts-form')).toBeInTheDocument()
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  })

  it('a file chosen in the empty state goes to the upload mutation', () => {
    render(tab())
    const file = new File(['%PDF-1.4'], 'cv.pdf', { type: 'application/pdf' })
    fireEvent.change(screen.getByTestId('resume-file-input'), { target: { files: [file] } })
    expect(uploadMock).toHaveBeenCalledWith(file)
  })
})

describe('ResumeTab — status lines and locks', () => {
  it('a failed extraction offers an unlocked retry intake while no check runs', () => {
    setData(response({ status: 'FAILED', errorCode: 'NO_TEXT' }))
    render(tab())
    expect(screen.getByTestId('resume-upload-button')).toBeEnabled()
  })

  it('a VERIFIED resume with a verified version does not say the facts changed', () => {
    setData(response({ verificationStatus: 'VERIFIED', verifiedVersion: 2 }))
    render(tab())
    expect(screen.queryByText(FACTS_CHANGED)).not.toBeInTheDocument()
  })
})

describe('ResumeTab — callbacks', () => {
  it('a new onDirtyChange prop takes over: an edit after the swap reaches only the new one', () => {
    setData(response())
    const first = vi.fn()
    const second = vi.fn()
    const view = render(tab(first))
    view.rerender(tab(second))
    first.mockClear()
    fireEvent.change(screen.getByLabelText('Цільова посада'), { target: { value: 'Typed' } })
    expect(second).toHaveBeenCalledWith(true)
    expect(first).not.toHaveBeenCalledWith(true)
  })

  it('a Submit answer without a resume moves no focus', async () => {
    setData(response({ facts: COMPLETE_FACTS }))
    submitMock.mockResolvedValue({ resume: null, canEdit: true, canConfirm: false })
    render(tab())
    const submit = screen.getByTestId('resume-facts-submit')
    submit.focus()
    fireEvent.click(submit)
    await waitFor(() => expect(submitMock).toHaveBeenCalledTimes(1))
    await act(() => new Promise((settle) => setTimeout(settle, 20)))
    expect(submit).toHaveFocus()
  })

  it('a VERIFIED resume flagged "re-check needed" offers Submit, which starts the re-check (backlog 442)', async () => {
    setData(
      response({
        facts: COMPLETE_FACTS,
        verificationStatus: 'VERIFIED',
        verifiedVersion: 1,
        recheckNeededAt: '2026-11-15T10:00:00.000Z',
      }),
    )
    submitMock.mockResolvedValue({ resume: null, canEdit: true, canConfirm: false })
    render(tab())
    expect(screen.getByTestId('resume-recheck-needed')).toBeInTheDocument()
    const submit = screen.getByTestId('resume-facts-submit')
    expect(submit).toBeEnabled()
    fireEvent.click(submit)
    await waitFor(() => expect(submitMock).toHaveBeenCalledTimes(1))
  })

  it('a VERIFIED resume not flagged for re-check disables Submit with the already-verified reason (backlog 452)', () => {
    setData(
      response({
        facts: COMPLETE_FACTS,
        verificationStatus: 'VERIFIED',
        verifiedVersion: 1,
        recheckNeededAt: null,
      }),
    )
    render(tab())
    const submit = screen.getByTestId('resume-facts-submit')
    expect(submit).toBeDisabled()
    expect(submit).toHaveAccessibleDescription(
      'Резюме вже підтверджено. Змініть факти, щоб надіслати його знову.',
    )
    fireEvent.click(submit)
    expect(submitMock).not.toHaveBeenCalled()
  })

  it('editing facts on an unflagged VERIFIED resume enables Submit and saves first (backlog 452)', async () => {
    setData(
      response({
        facts: COMPLETE_FACTS,
        verificationStatus: 'VERIFIED',
        verifiedVersion: 1,
        recheckNeededAt: null,
      }),
    )
    saveFactsMock.mockResolvedValue({})
    submitMock.mockResolvedValue({ resume: null, canEdit: true, canConfirm: false })
    render(tab())
    const submit = screen.getByTestId('resume-facts-submit')
    expect(submit).toBeDisabled()

    const headline = screen.getByRole('textbox', { name: 'Цільова посада' })
    fireEvent.change(headline, { target: { value: 'Staff Engineer' } })

    expect(submit).toBeEnabled()
    fireEvent.click(submit)
    await waitFor(() => expect(saveFactsMock).toHaveBeenCalledTimes(1))
    expect(saveFactsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        facts: expect.objectContaining({ headline: 'Staff Engineer' }),
        silent: true,
      }),
    )
    await waitFor(() => expect(submitMock).toHaveBeenCalledTimes(1))
  })
})
