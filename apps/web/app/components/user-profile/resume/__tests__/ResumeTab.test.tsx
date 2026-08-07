/**
 * ResumeTab behaviour (task-resume-base §3, AC3/AC5/AC7).
 *
 * The data hooks are mocked so each state of the server-side machine can be
 * rendered deterministically — the wiring to the real endpoints is covered by
 * the API integration spec and the E2E run, not here.
 */
import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EMPTY_RESUME_CONTENT, type SeniorResumeDto, type SeniorResumeResponse } from '@crm/shared'

const saveMock = vi.fn()
const uploadMock = vi.fn()
const ingestTextMock = vi.fn()

let resumeData: SeniorResumeResponse = { resume: null, canEdit: true }
let isLoading = false

vi.mock('@/hooks/use-senior-resume', () => ({
  useSeniorResume: () => ({ data: resumeData, isLoading, isError: false }),
  useSaveResumeContent: () => ({ mutate: saveMock, isPending: false }),
  useUploadResumeSource: () => ({ mutate: uploadMock, isPending: false }),
  useIngestResumeText: () => ({ mutate: ingestTextMock, isPending: false }),
  useResumeSourceUrl: () => ({ data: undefined }),
  resumePdfUrl: (userId: string) => `/api/users/${userId}/resume/pdf`,
}))

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

import { ResumeTab } from '../ResumeTab'

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
    ...overrides,
  }
  return { resume, canEdit }
}

const FILLED = makeResponse({
  content: {
    summary: 'Синьор-разработчик',
    skills: ['TypeScript'],
    experience: [
      { company: 'Acme', role: 'Lead', period: '2021—2024', bullets: ['Вёл команду'] },
      { company: 'Beta', role: 'Dev', period: '2018—2021', bullets: [] },
    ],
    education: [],
    languages: [],
    links: [],
  },
})

beforeEach(() => {
  vi.clearAllMocks()
  resumeData = { resume: null, canEdit: true }
  isLoading = false
})

describe('ResumeTab — empty state', () => {
  it('invites an editor to upload a file or paste text', () => {
    resumeData = { resume: null, canEdit: true }
    render(<ResumeTab userId="senior-1" />)
    expect(screen.getByTestId('resume-intake')).toBeInTheDocument()
    expect(screen.getByTestId('resume-upload-button')).toBeInTheDocument()
    expect(screen.getByTestId('resume-paste-toggle')).toBeInTheDocument()
  })

  it('shows a read-only message instead of the upload UI when the viewer cannot edit', () => {
    resumeData = { resume: null, canEdit: false }
    render(<ResumeTab userId="senior-1" />)
    expect(screen.getByTestId('resume-empty-readonly')).toBeInTheDocument()
    expect(screen.queryByTestId('resume-upload-button')).not.toBeInTheDocument()
  })

  it('paste-text flow submits the text through the ingest mutation', () => {
    resumeData = { resume: null, canEdit: true }
    render(<ResumeTab userId="senior-1" />)
    fireEvent.click(screen.getByTestId('resume-paste-toggle'))
    fireEvent.change(screen.getByTestId('resume-text-input'), {
      target: { value: 'Иван Петров, синьор-разработчик с большим опытом работы.' },
    })
    fireEvent.click(screen.getByTestId('resume-text-submit'))
    expect(ingestTextMock).toHaveBeenCalledWith(
      'Иван Петров, синьор-разработчик с большим опытом работы.',
    )
  })
})

describe('ResumeTab — extraction states (AC3/AC5)', () => {
  it('QUEUED shows named progress, not a bare spinner, and keeps the form reachable', () => {
    resumeData = makeResponse({ status: 'QUEUED' })
    render(<ResumeTab userId="senior-1" />)
    const panel = screen.getByTestId('resume-progress')
    expect(panel).toHaveTextContent('очереди на распознавание')
    // The rest of the tab still renders — the user is not blocked.
    expect(screen.getByTestId('resume-section-summary')).toBeInTheDocument()
  })

  it('RUNNING shows its own copy', () => {
    resumeData = makeResponse({ status: 'RUNNING' })
    render(<ResumeTab userId="senior-1" />)
    expect(screen.getByTestId('resume-progress')).toHaveTextContent('Распознаём резюме')
  })

  it('FAILED/NO_TEXT explains the scan case and offers pasting text', () => {
    resumeData = makeResponse({
      status: 'FAILED',
      errorCode: 'NO_TEXT',
      errorMessage: 'Из файла не удалось извлечь текст',
    })
    render(<ResumeTab userId="senior-1" />)
    const panel = screen.getByTestId('resume-failed')
    expect(panel).toHaveTextContent('нет текстового слоя')
    expect(screen.getByTestId('resume-paste-toggle')).toBeInTheDocument()
  })

  it('AC5: QUOTA_EXCEEDED names the reset moment and leaves editing available', () => {
    resumeData = makeResponse({
      status: 'FAILED',
      errorCode: 'QUOTA_EXCEEDED',
      errorMessage: 'Исчерпан суточный лимит бесплатных запросов к ИИ.',
      quotaResetsAt: '2026-08-08T00:00:00.000Z',
    })
    render(<ResumeTab userId="senior-1" />)
    const panel = screen.getByTestId('resume-failed')
    expect(panel).toHaveTextContent('лимит')
    expect(panel).toHaveTextContent('августа')
    // Manual editing is NOT blocked by the quota wall.
    expect(screen.getByTestId('resume-edit-summary')).toBeInTheDocument()
  })

  it('AI_NOT_CONFIGURED tells the user to fill it in by hand', () => {
    resumeData = makeResponse({ status: 'FAILED', errorCode: 'AI_NOT_CONFIGURED' })
    render(<ResumeTab userId="senior-1" />)
    expect(screen.getByTestId('resume-failed')).toHaveTextContent('вручную')
  })
})

describe('ResumeTab — per-section editing', () => {
  it('edits only the section that was opened, and saves the whole content object', () => {
    resumeData = FILLED
    render(<ResumeTab userId="senior-1" />)

    fireEvent.click(screen.getByTestId('resume-edit-summary'))
    fireEvent.change(screen.getByTestId('resume-summary-input'), {
      target: { value: 'Обновлённое описание' },
    })
    // Other sections stay in view mode — no modal, no global form.
    expect(screen.queryByTestId('resume-skills-input')).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId('resume-save-summary'))
    expect(saveMock).toHaveBeenCalledTimes(1)
    const [payload] = saveMock.mock.calls[0] as [typeof EMPTY_RESUME_CONTENT]
    expect(payload.summary).toBe('Обновлённое описание')
    // Untouched sections are carried through unchanged.
    expect(payload.experience).toHaveLength(2)
  })

  it('Cancel restores the server value and drops the edit', () => {
    resumeData = FILLED
    render(<ResumeTab userId="senior-1" />)
    fireEvent.click(screen.getByTestId('resume-edit-summary'))
    fireEvent.change(screen.getByTestId('resume-summary-input'), { target: { value: 'мусор' } })
    fireEvent.click(screen.getByTestId('resume-cancel-summary'))
    expect(saveMock).not.toHaveBeenCalled()
    expect(screen.getByTestId('resume-summary-view')).toHaveTextContent('Синьор-разработчик')
  })

  it('Save is disabled until something actually changes', () => {
    resumeData = FILLED
    render(<ResumeTab userId="senior-1" />)
    fireEvent.click(screen.getByTestId('resume-edit-summary'))
    expect(screen.getByTestId('resume-save-summary')).toBeDisabled()
    fireEvent.change(screen.getByTestId('resume-summary-input'), { target: { value: 'иное' } })
    expect(screen.getByTestId('resume-save-summary')).toBeEnabled()
  })

  it('reports unsaved edits upward so the profile shell can guard the tab switch', () => {
    resumeData = FILLED
    const onDirtyChange = vi.fn()
    render(<ResumeTab userId="senior-1" onDirtyChange={onDirtyChange} />)

    fireEvent.click(screen.getByTestId('resume-edit-summary'))
    fireEvent.change(screen.getByTestId('resume-summary-input'), { target: { value: 'изменено' } })
    expect(onDirtyChange).toHaveBeenCalledWith(true)

    fireEvent.click(screen.getByTestId('resume-cancel-summary'))
    expect(onDirtyChange).toHaveBeenLastCalledWith(false)
  })

  it('hides every edit affordance from a viewer without write access', () => {
    resumeData = makeResponse(FILLED.resume as SeniorResumeDto, false)
    render(<ResumeTab userId="senior-1" />)
    expect(screen.getByTestId('resume-summary-view')).toBeInTheDocument()
    expect(screen.queryByTestId('resume-edit-summary')).not.toBeInTheDocument()
    expect(screen.queryByTestId('resume-edit-experience')).not.toBeInTheDocument()
  })
})

describe('ResumeTab — experience ordering (matters for task-resume-tailoring)', () => {
  it('moves an item up and persists the new order', () => {
    resumeData = FILLED
    render(<ResumeTab userId="senior-1" />)
    fireEvent.click(screen.getByTestId('resume-edit-experience'))
    fireEvent.click(screen.getByTestId('resume-experience-up-1'))
    fireEvent.click(screen.getByTestId('resume-save-experience'))

    const [payload] = saveMock.mock.calls[0] as [typeof EMPTY_RESUME_CONTENT]
    expect(payload.experience.map((e) => e.company)).toEqual(['Beta', 'Acme'])
  })

  it('adds and removes experience items', () => {
    resumeData = FILLED
    render(<ResumeTab userId="senior-1" />)
    fireEvent.click(screen.getByTestId('resume-edit-experience'))
    fireEvent.click(screen.getByTestId('resume-experience-add'))
    expect(screen.getByTestId('resume-experience-item-2')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('resume-experience-remove-0'))
    fireEvent.click(screen.getByTestId('resume-save-experience'))
    const [payload] = saveMock.mock.calls[0] as [typeof EMPTY_RESUME_CONTENT]
    expect(payload.experience.map((e) => e.company)).toEqual(['Beta', ''])
  })

  it('the first item cannot move up and the last cannot move down', () => {
    resumeData = FILLED
    render(<ResumeTab userId="senior-1" />)
    fireEvent.click(screen.getByTestId('resume-edit-experience'))
    expect(screen.getByTestId('resume-experience-up-0')).toBeDisabled()
    expect(screen.getByTestId('resume-experience-down-1')).toBeDisabled()
  })
})

describe('ResumeTab — AC7 untrusted content rendering', () => {
  it('renders markup from a resume as literal text, never as HTML', () => {
    resumeData = makeResponse({
      content: { ...EMPTY_RESUME_CONTENT, summary: '<img src=x onerror=alert(1)>' },
    })
    render(<ResumeTab userId="senior-1" />)
    const view = screen.getByTestId('resume-summary-view')
    expect(view).toHaveTextContent('<img src=x onerror=alert(1)>')
    expect(view.querySelector('img')).toBeNull()
  })

  it('refuses to make a javascript: link clickable — it degrades to plain text', () => {
    resumeData = makeResponse({
      content: {
        ...EMPTY_RESUME_CONTENT,
        links: [
          { label: 'Плохая', url: 'javascript:alert(1)' },
          { label: 'Хорошая', url: 'https://example.com' },
        ],
      },
    })
    render(<ResumeTab userId="senior-1" />)
    const list = screen.getByTestId('resume-links-view')
    const anchors = within(list).getAllByRole('link')
    expect(anchors).toHaveLength(1)
    expect(anchors[0]).toHaveAttribute('href', 'https://example.com')
    expect(list).toHaveTextContent('Плохая')
  })
})

describe('ResumeTab — downloads', () => {
  it('offers the PDF as a plain link (no post-await window.open, which mobile blocks)', () => {
    resumeData = FILLED
    render(<ResumeTab userId="senior-1" />)
    const link = screen.getByTestId('resume-download-pdf')
    expect(link.tagName).toBe('A')
    expect(link).toHaveAttribute('href', '/api/users/senior-1/resume/pdf')
  })

  it('shows the version and the last editor', () => {
    resumeData = makeResponse({
      ...(FILLED.resume as SeniorResumeDto),
      version: 7,
      updatedByName: 'Эйчар Иванова',
    })
    render(<ResumeTab userId="senior-1" />)
    expect(screen.getByTestId('resume-tab')).toHaveTextContent('Версия 7')
    expect(screen.getByTestId('resume-tab')).toHaveTextContent('Эйчар Иванова')
  })
})
