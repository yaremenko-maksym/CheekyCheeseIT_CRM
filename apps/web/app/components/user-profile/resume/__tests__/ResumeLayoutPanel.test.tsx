/**
 * The layout switches (AC8) and the three honest states of the PDF panel.
 *
 * The switches are the ONLY typesetting a human may touch — the template is
 * code and stays on the server — so what these tests pin is that each switch
 * reaches the server as a distinct, validated change, and that nothing here
 * offers a way to edit the template itself.
 */
import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_RESUME_LAYOUT,
  EMPTY_RESUME_CONTENT,
  type ResumeLayoutOptions,
  type SeniorResumeDto,
} from '@crm/shared'
import { ResumeLayoutPanel, moveSection } from '../ResumeLayoutPanel'
import { ResumePdfPreview } from '../ResumePdfPreview'

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
    expect(within(panel).queryAllByRole('textbox')).toHaveLength(0)
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
  it('shows the document and a download link when the PDF matches the current resume', () => {
    render(<ResumePdfPreview resume={dto()} pdfUrl="/api/users/u1/resume/pdf" />)
    expect(screen.getByTestId('resume-pdf-object')).toHaveAttribute(
      'data',
      '/api/users/u1/resume/pdf',
    )
    expect(screen.getByTestId('resume-download-pdf')).toHaveAttribute(
      'href',
      '/api/users/u1/resume/pdf',
    )
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
