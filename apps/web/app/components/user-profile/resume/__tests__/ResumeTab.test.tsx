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
const deleteMock = vi.fn()

let resumeData: SeniorResumeResponse = { resume: null, canEdit: true }
let isLoading = false

vi.mock('@/hooks/use-senior-resume', () => ({
  useSeniorResume: () => ({ data: resumeData, isLoading, isError: false }),
  useSaveResumeContent: () => ({ mutate: saveMock, isPending: false }),
  useUploadResumeSource: () => ({ mutate: uploadMock, isPending: false }),
  useIngestResumeText: () => ({ mutate: ingestTextMock, isPending: false }),
  useDeleteResume: () => ({ mutate: deleteMock, isPending: false }),
  useResumeSourceUrl: () => ({ data: undefined }),
  resumePdfUrl: (userId: string) => `/api/users/${userId}/resume/pdf`,
}))

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

import { ResumeTab, mayStartEditing } from '../ResumeTab'

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

/**
 * The task's ONE hard condition on the editing model: "несохранённые правки не
 * должны теряться при переходе". Moving between sections was the route that
 * lost them — `startEdit` overwrote the draft with the server value, silently,
 * with no prompt and no undo, while every other section's Изменить button
 * stayed clickable throughout.
 *
 * These tests pin the path in BOTH directions, which is what was missing: the
 * button is unreachable while an edit is open, AND the draft survives if the
 * handler is reached anyway.
 */
describe('ResumeTab — unsaved edits survive a move between sections', () => {
  it('locks the other sections while one is being edited', () => {
    resumeData = FILLED
    render(<ResumeTab userId="senior-1" />)

    expect(screen.getByTestId('resume-edit-skills')).toBeEnabled()

    fireEvent.click(screen.getByTestId('resume-edit-summary'))
    fireEvent.change(screen.getByTestId('resume-summary-input'), {
      target: { value: 'важная правка' },
    })

    expect(screen.getByTestId('resume-edit-skills')).toBeDisabled()
    expect(screen.getByTestId('resume-edit-experience')).toBeDisabled()
    expect(screen.getByTestId('resume-edit-links')).toBeDisabled()
  })

  it('keeps the typed text when another section’s Изменить is clicked', () => {
    resumeData = FILLED
    render(<ResumeTab userId="senior-1" />)

    fireEvent.click(screen.getByTestId('resume-edit-summary'))
    fireEvent.change(screen.getByTestId('resume-summary-input'), {
      target: { value: 'важная правка' },
    })

    // The reviewer's probe: reach for a different section mid-edit.
    fireEvent.click(screen.getByTestId('resume-edit-skills'))

    // Still editing the summary, and the text is still there.
    expect(screen.getByTestId('resume-summary-input')).toHaveValue('важная правка')
    expect(screen.queryByTestId('resume-skills-input')).not.toBeInTheDocument()
  })

  it('saving the open section unlocks the others', () => {
    resumeData = FILLED
    render(<ResumeTab userId="senior-1" />)

    fireEvent.click(screen.getByTestId('resume-edit-summary'))
    fireEvent.change(screen.getByTestId('resume-summary-input'), { target: { value: 'готово' } })
    expect(screen.getByTestId('resume-edit-skills')).toBeDisabled()

    fireEvent.click(screen.getByTestId('resume-cancel-summary'))
    expect(screen.getByTestId('resume-edit-skills')).toBeEnabled()
  })

  it('explains why the other sections are locked instead of just greying them out', () => {
    resumeData = FILLED
    render(<ResumeTab userId="senior-1" />)

    fireEvent.click(screen.getByTestId('resume-edit-summary'))
    fireEvent.change(screen.getByTestId('resume-summary-input'), { target: { value: 'правка' } })

    expect(screen.getByTestId('resume-editing-hint-summary')).toHaveTextContent(
      /несохранённые правки/i,
    )
    expect(screen.getByTestId('resume-edit-skills')).toHaveAttribute(
      'title',
      expect.stringContaining('сохраните или отмените'),
    )
  })

  it('registers exactly one beforeunload listener for the whole tab', () => {
    resumeData = FILLED
    const addSpy = vi.spyOn(window, 'addEventListener')
    render(<ResumeTab userId="senior-1" />)

    fireEvent.click(screen.getByTestId('resume-edit-summary'))
    fireEvent.change(screen.getByTestId('resume-summary-input'), { target: { value: 'правка' } })

    // Six section cards used to register six identical handlers.
    const unloadRegistrations = addSpy.mock.calls.filter(([type]) => type === 'beforeunload')
    expect(unloadRegistrations).toHaveLength(1)
    addSpy.mockRestore()
  })
})

/**
 * "READY, but there is nothing in it" used to be a cul-de-sac: the invitation
 * screen offered a file and a paste box, and nothing else, even though the
 * section editors work perfectly well on empty content.
 */
describe('ResumeTab — filling the resume by hand', () => {
  it('offers a way out of the empty state that is not a file', () => {
    resumeData = makeResponse({ content: EMPTY_RESUME_CONTENT, status: 'READY' })
    render(<ResumeTab userId="senior-1" />)

    fireEvent.click(screen.getByTestId('resume-fill-manually'))

    // The real form, on empty content.
    expect(screen.getByTestId('resume-section-summary')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('resume-edit-summary'))
    fireEvent.change(screen.getByTestId('resume-summary-input'), {
      target: { value: 'Синьор, 8 лет опыта' },
    })
    fireEvent.click(screen.getByTestId('resume-save-summary'))

    const [payload] = saveMock.mock.calls[0] as [typeof EMPTY_RESUME_CONTENT]
    expect(payload.summary).toBe('Синьор, 8 лет опыта')
  })

  it('does not offer manual filling to a viewer without write access', () => {
    resumeData = makeResponse({ content: EMPTY_RESUME_CONTENT }, false)
    render(<ResumeTab userId="senior-1" />)
    expect(screen.queryByTestId('resume-fill-manually')).not.toBeInTheDocument()
    expect(screen.getByTestId('resume-empty-readonly')).toBeInTheDocument()
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
  const INJECTED_MARKUP = '<img src=x onerror=alert(1)>'

  it('renders markup from a resume as literal text, never as HTML', () => {
    resumeData = makeResponse({
      content: { ...EMPTY_RESUME_CONTENT, summary: INJECTED_MARKUP },
    })
    render(<ResumeTab userId="senior-1" />)
    const view = screen.getByTestId('resume-summary-view')
    expect(view).toHaveTextContent(INJECTED_MARKUP)
    // `hidden: true` so the query does not depend on the injected element being
    // exposed to the accessibility tree — an attacker's `<img>` may well carry
    // `aria-hidden`, and it would still have run its `onerror`.
    expect(within(view).queryByRole('img', { hidden: true })).toBeNull()
  })

  /**
   * The assertion above is an ABSENCE check, and an absence check against a
   * query that finds nothing anywhere is worth nothing. This pins that the
   * query has teeth: the same `queryByRole('img', { hidden: true })` DOES find
   * an `<img>` with neither `alt` nor accessible name — the exact shape the
   * injected markup would produce if React ever rendered it as HTML.
   *
   * (Written this way rather than with `container.querySelector`, which is what
   * the closed branch used and what `testing-library/no-node-access` rejected.
   * The rule's per-file exemption list in eslint.config.mjs exists for
   * assertions with no accessible form — this one has one, so it does not
   * belong there.)
   */
  it('the "no <img> was created" check is not vacuous — the query finds a real one', () => {
    render(
      <div data-testid="xss-control">
        <img src="x" />
      </div>,
    )
    const control = screen.getByTestId('xss-control')
    // `getByRole` throws when it finds nothing — that throw IS the assertion.
    expect(within(control).getByRole('img', { hidden: true })).toBeInTheDocument()
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

  it('does not offer a PDF of an empty resume', () => {
    // Reachable state: extraction finished but produced nothing usable, so the
    // row is READY with empty content. The button rendered anyway and handed
    // back a PDF containing only a name.
    resumeData = makeResponse({ content: EMPTY_RESUME_CONTENT, status: 'FAILED' })
    render(<ResumeTab userId="senior-1" />)
    expect(screen.queryByTestId('resume-download-pdf')).not.toBeInTheDocument()
  })

  it('does not offer erasure to a viewer without write access', () => {
    resumeData = makeResponse(FILLED.resume as SeniorResumeDto, false)
    render(<ResumeTab userId="senior-1" />)
    expect(screen.queryByTestId('resume-delete')).not.toBeInTheDocument()
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

/**
 * Erasure of personal data. Irreversible, and it takes the stored original with
 * it, so it must ask first and say exactly what disappears — a resume deleted
 * by a mis-click cannot be recovered from anywhere in this system.
 */
describe('ResumeTab — deleting the resume', () => {
  it('asks before erasing anything', () => {
    resumeData = FILLED
    render(<ResumeTab userId="senior-1" />)

    fireEvent.click(screen.getByTestId('resume-delete'))

    expect(screen.getByTestId('resume-delete-confirm-dialog')).toBeInTheDocument()
    expect(deleteMock).not.toHaveBeenCalled()
  })

  it('names the stored file that is about to go with it', () => {
    resumeData = makeResponse({
      ...(FILLED.resume as SeniorResumeDto),
      hasSourceFile: true,
      sourceFileName: 'резюме-иванова.pdf',
    })
    render(<ResumeTab userId="senior-1" />)

    fireEvent.click(screen.getByTestId('resume-delete'))
    expect(screen.getByTestId('resume-delete-confirm-dialog')).toHaveTextContent(
      'резюме-иванова.pdf',
    )
  })

  it('erases once confirmed', () => {
    resumeData = FILLED
    render(<ResumeTab userId="senior-1" />)

    fireEvent.click(screen.getByTestId('resume-delete'))
    fireEvent.click(screen.getByTestId('resume-delete-confirm'))

    expect(deleteMock).toHaveBeenCalledTimes(1)
  })

  it('erases nothing when the dialog is dismissed', () => {
    resumeData = FILLED
    render(<ResumeTab userId="senior-1" />)

    fireEvent.click(screen.getByTestId('resume-delete'))
    fireEvent.click(screen.getByTestId('resume-delete-cancel'))

    expect(deleteMock).not.toHaveBeenCalled()
  })

  it('is not offered before a resume exists', () => {
    resumeData = { resume: null, canEdit: true }
    render(<ResumeTab userId="senior-1" />)
    expect(screen.queryByTestId('resume-delete')).not.toBeInTheDocument()
  })
})

/**
 * The RULE behind the section lock, asserted directly.
 *
 * The visible half is the disabled Изменить button, and a disabled button
 * cannot be reached from a test: React reads `disabled` from its own props, so
 * stripping the DOM attribute never gets to the handler. That left the guard
 * inside `startEdit` unfalsifiable — deleting it failed nothing. Naming the
 * rule makes it testable on its own terms.
 *
 * MUTATION: make `mayStartEditing` always return true and the first case here
 * goes red (while the disabled-button tests above stay green — the two halves
 * are now pinned independently).
 */
describe('mayStartEditing', () => {
  it('refuses to switch away from a section that is open', () => {
    expect(mayStartEditing('summary', 'skills')).toBe(false)
    expect(mayStartEditing('experience', 'summary')).toBe(false)
  })

  it('allows opening when nothing is being edited', () => {
    expect(mayStartEditing(null, 'summary')).toBe(true)
    expect(mayStartEditing(null, 'links')).toBe(true)
  })

  it('treats re-opening the same section as a no-op, not a switch', () => {
    expect(mayStartEditing('summary', 'summary')).toBe(true)
  })
})

/**
 * READY + empty content + a file still in storage is a REACHABLE state: an
 * extraction that returns nothing usable leaves exactly that. It used to render
 * the invitation screen only — no toolbar — so the uploaded file could be
 * neither downloaded nor erased without first going through «Заполнить вручную».
 * A right-to-erasure control has to be reachable from the state the user is in.
 */
describe('ResumeTab — erasure is reachable from the empty state', () => {
  it('offers erase and the source download when a file exists but content is empty', () => {
    resumeData = makeResponse({
      content: EMPTY_RESUME_CONTENT,
      status: 'READY',
      hasSourceFile: true,
      sourceFileName: 'резюме.pdf',
    })
    render(<ResumeTab userId="senior-1" />)

    // Still the invitation screen...
    expect(screen.getByTestId('resume-fill-manually')).toBeInTheDocument()
    // ...but the file is reachable and removable from right here.
    expect(screen.getByTestId('resume-delete')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('resume-delete'))
    expect(screen.getByTestId('resume-delete-confirm-dialog')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('resume-delete-confirm'))
    expect(deleteMock).toHaveBeenCalledTimes(1)
  })

  it('does not offer erase in the empty state to a read-only viewer', () => {
    resumeData = makeResponse(
      { content: EMPTY_RESUME_CONTENT, status: 'READY', hasSourceFile: true },
      false,
    )
    render(<ResumeTab userId="senior-1" />)
    expect(screen.queryByTestId('resume-delete')).not.toBeInTheDocument()
  })
})
