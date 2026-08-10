/**
 * The layout switches (AC8) and the three honest states of the PDF panel.
 *
 * The switches are the ONLY typesetting a human may touch — the template is
 * code and stays on the server — so what these tests pin is that each switch
 * reaches the server as a distinct, validated change, and that nothing here
 * offers a way to edit the template itself.
 */
import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_RESUME_LAYOUT,
  EMPTY_RESUME_CONTENT,
  type ResumeLayoutOptions,
  type SeniorResumeDto,
} from '@crm/shared'
import { ResumeLayoutPanel, moveSection } from '../ResumeLayoutPanel'

/**
 * The blob hook is stubbed rather than the network: it owns `createObjectURL`,
 * which jsdom does not implement, and what these tests are about is what the
 * VIEWER receives, not how the bytes were obtained.
 */
let blobState: { blobUrl: string | null; isLoading: boolean; hasError: boolean } = {
  blobUrl: 'blob:http://localhost/resume-pdf',
  isLoading: false,
  hasError: false,
}

vi.mock('@/hooks/use-senior-resume', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useResumePdfBlob: () => blobState,
}))

beforeEach(() => {
  blobState = { blobUrl: 'blob:http://localhost/resume-pdf', isLoading: false, hasError: false }
})

const { ResumePdfPreview } = await import('../ResumePdfPreview')

/**
 * Shared by the "no template editor" assertion and by its non-vacuity control,
 * so a typo breaks the control instead of quietly disarming the assertion.
 */
const TEXT_INPUT_ROLE = 'textbox' as const

function renderPanel(overrides: Partial<ResumeLayoutOptions> = {}, canEdit = true) {
  const onSave = vi.fn()
  render(
    <ResumeLayoutPanel
      layout={{ ...DEFAULT_RESUME_LAYOUT, ...overrides }}
      canEdit={canEdit}
      isSaving={false}
      onSave={onSave}
    />,
  )
  return { onSave }
}

/** Apply the pending draft and return what the server would have received. */
function apply(onSave: ReturnType<typeof vi.fn>): ResumeLayoutOptions {
  fireEvent.click(screen.getByTestId('resume-layout-save'))
  expect(onSave).toHaveBeenCalledTimes(1)
  return onSave.mock.calls[0]?.[0] as ResumeLayoutOptions
}

describe('moveSection', () => {
  it('swaps with the neighbour in the requested direction', () => {
    expect(moveSection(['summary', 'skills', 'links'], 'skills', -1)).toEqual([
      'skills',
      'summary',
      'links',
    ])
    expect(moveSection(['summary', 'skills', 'links'], 'skills', 1)).toEqual([
      'summary',
      'links',
      'skills',
    ])
  })

  it('refuses to move past either end, and never mutates the input', () => {
    const order = ['summary', 'skills'] as const
    expect(moveSection(order, 'summary', -1)).toEqual(['summary', 'skills'])
    expect(moveSection(order, 'skills', 1)).toEqual(['summary', 'skills'])
    expect(order).toEqual(['summary', 'skills'])
  })
})

describe('AC8 — each switch reaches the server', () => {
  it('section order: moving a section down sends the new order', () => {
    const { onSave } = renderPanel()
    fireEvent.click(screen.getByTestId('resume-layout-down-summary'))
    expect(apply(onSave).sectionOrder.slice(0, 2)).toEqual(['skills', 'summary'])
  })

  it('hidden sections: hiding one sends it, and unhiding takes it back out', () => {
    const { onSave } = renderPanel()
    fireEvent.click(screen.getByTestId('resume-layout-toggle-links'))
    expect(apply(onSave).hiddenSections).toEqual(['links'])
  })

  it('unhiding removes the section from the list', () => {
    const { onSave } = renderPanel({ hiddenSections: ['links', 'languages'] })
    fireEvent.click(screen.getByTestId('resume-layout-toggle-links'))
    expect(apply(onSave).hiddenSections).toEqual(['languages'])
  })

  it('density and font scale send the chosen step', () => {
    const { onSave } = renderPanel()
    fireEvent.click(screen.getByTestId('resume-layout-density-compact'))
    fireEvent.click(screen.getByTestId('resume-layout-font-scale-large'))

    const saved = apply(onSave)
    expect(saved.density).toBe('compact')
    expect(saved.fontScale).toBe('large')
  })

  it('Применить is inert until something actually changes', () => {
    renderPanel()
    expect(screen.getByTestId('resume-layout-save')).toBeDisabled()
    fireEvent.click(screen.getByTestId('resume-layout-toggle-skills'))
    expect(screen.getByTestId('resume-layout-save')).toBeEnabled()
  })

  it('Сбросить returns every switch to the default', () => {
    const { onSave } = renderPanel({
      hiddenSections: ['links'],
      density: 'relaxed',
      fontScale: 'small',
    })
    fireEvent.click(screen.getByTestId('resume-layout-reset'))
    expect(apply(onSave)).toEqual(DEFAULT_RESUME_LAYOUT)
  })
})

describe('the panel offers switches and nothing else', () => {
  it('shows every section, in the stored order, even when the stored order is short', () => {
    // What a layout saved before a section existed looks like. Dropping the
    // newcomer would make it uneditable and invisible at the same time.
    renderPanel({ sectionOrder: ['links', 'summary'] as never })
    const list = screen.getByTestId('resume-layout-sections')
    expect(within(list).getAllByRole('listitem')).toHaveLength(6)
  })

  /**
   * There is no template editor, and that is a security property rather than a
   * missing feature: a template is executable typesetting code, and the split
   * only holds while nothing a human or a model types can reach it.
   */
  it('exposes no way to edit the template itself', () => {
    renderPanel()
    const panel = screen.getByTestId('resume-layout-panel')
    expect(within(panel).queryAllByRole(TEXT_INPUT_ROLE)).toHaveLength(0)
  })

  /**
   * The control for the assertion above.
   *
   * `queryAllByRole(...)` returning nothing proves the panel has no text input
   * ONLY if that query would have found one — the same shape as the `<object>`
   * preview test that passed for days while the preview was blank.
   *
   * BOTH USE THE SAME CONSTANT, and that is the point. The first version of
   * this control repeated the literal `'textbox'` independently, so a typo in
   * the assertion it guards left all 17 tests green — the control was proving
   * that ITS OWN string worked, not that the other one did. A shared constant
   * makes the claim true: mistype it now and the control fails first.
   */
  it('the "no textbox" check would notice a textbox', () => {
    render(
      <div data-testid="textbox-control">
        <textarea aria-label="template source" />
      </div>,
    )
    const control = screen.getByTestId('textbox-control')
    expect(within(control).queryAllByRole(TEXT_INPUT_ROLE)).toHaveLength(1)
  })

  it('is read-only for a viewer without write access', () => {
    renderPanel({}, false)
    expect(screen.queryByTestId('resume-layout-save')).not.toBeInTheDocument()
    expect(screen.getByTestId('resume-layout-toggle-links')).toBeDisabled()
    expect(screen.getByTestId('resume-layout-down-summary')).toBeDisabled()
  })
})

// ---------------------------------------------------------------------------

function dto(overrides: Partial<SeniorResumeDto> = {}): SeniorResumeDto {
  return {
    id: 'r1',
    userId: 'u1',
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
    createdAt: '2026-08-10T10:00:00.000Z',
    updatedAt: '2026-08-10T10:00:00.000Z',
    layout: DEFAULT_RESUME_LAYOUT,
    templateName: 'Стандартный шаблон',
    hasCustomTemplate: false,
    renderStatus: 'READY',
    renderError: null,
    pdfUpToDate: true,
    ...overrides,
  }
}

describe('ResumePdfPreview', () => {
  /**
   * THE ASSERTION IS ABOUT WHAT THE VIEWER IS POINTED AT, not that a viewer
   * exists.
   *
   * The first version of this test asserted `data="/api/users/u1/resume/pdf"`
   * on an `<object>` and passed for days while the preview showed a blank frame
   * at every width, in both themes: that route answers `Content-Disposition:
   * attachment`, which no embedded viewer will render. The element was there
   * the whole time. Presence was never the question.
   *
   * So the check is that the viewer receives a BLOB url — the one thing that
   * makes bytes actually appear — and, below, that no blob means no document is
   * claimed to be ready.
   */
  it('points the viewer at a blob, not at the attachment endpoint', async () => {
    render(<ResumePdfPreview resume={dto()} pdfUrl="/api/users/u1/resume/pdf" />)

    const frame = await screen.findByTitle(/Предпросмотр:/)
    const src = frame.getAttribute('src') ?? ''
    expect(src.startsWith('blob:')).toBe(true)
    // The attachment URL must NOT be what the viewer loads.
    expect(src).not.toContain('/resume/pdf')

    // The download button is the one place the attachment URL belongs.
    expect(screen.getByTestId('resume-download-pdf')).toHaveAttribute(
      'href',
      '/api/users/u1/resume/pdf',
    )
  })

  it('shows no document while the bytes are still loading', () => {
    blobState = { blobUrl: null, isLoading: true, hasError: false }
    render(<ResumePdfPreview resume={dto()} pdfUrl="/api/users/u1/resume/pdf" />)
    expect(screen.queryByTitle(/Предпросмотр:/)).not.toBeInTheDocument()
  })

  it('says so when the bytes cannot be fetched, instead of showing an empty frame', () => {
    blobState = { blobUrl: null, isLoading: false, hasError: true }
    render(<ResumePdfPreview resume={dto()} pdfUrl="/api/users/u1/resume/pdf" />)
    expect(screen.getByTestId('resume-pdf-object-error')).toBeInTheDocument()
  })

  /**
   * The distinction the whole fingerprint mechanism exists for: a render that
   * finished is not the same thing as a render of THIS text. Offering a stale
   * PDF as the current resume is worse than offering none, because nothing
   * about it looks wrong.
   */
  it('refuses to offer a PDF that no longer matches the resume', () => {
    render(
      <ResumePdfPreview
        resume={dto({ renderStatus: 'READY', pdfUpToDate: false })}
        pdfUrl="/api/users/u1/resume/pdf"
      />,
    )
    expect(screen.getByTestId('resume-pdf-pending')).toBeInTheDocument()
    expect(screen.queryByTestId('resume-download-pdf')).not.toBeInTheDocument()
  })

  it('names the failure instead of spinning forever', () => {
    render(
      <ResumePdfPreview
        resume={dto({
          renderStatus: 'FAILED',
          pdfUpToDate: false,
          renderError: 'Вёрстка не уложилась в 20 с.',
        })}
        pdfUrl="/api/users/u1/resume/pdf"
      />,
    )
    expect(screen.getByTestId('resume-pdf-failed')).toHaveTextContent('не уложилась')
    expect(screen.queryByTestId('resume-pdf-pending')).not.toBeInTheDocument()
  })
})
