/**
 * `ResumeSectionCard` — the edit/save affordance shared by every resume
 * section. Two catalog strings here have no dedicated test anywhere else in
 * the suite (`ResumeTab.test.tsx` never opens a section for editing far
 * enough to see the Save button's saving-state text, and never inspects the
 * edit button's `aria-label`), so a mutant on either string survives
 * silently in whichever section happens to be under test.
 */
import { render as rtlRender, screen, type RenderOptions } from '@testing-library/react'
import type { ComponentProps, ReactElement } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { loadCatalog, I18nTestProvider } from '@/test/i18n'
import { ResumeSectionCard } from '../ResumeSectionCard'

function render(ui: ReactElement, options?: RenderOptions) {
  return rtlRender(ui, { wrapper: I18nTestProvider, ...options })
}

beforeEach(() => loadCatalog('uk'))

function renderCard(overrides: Partial<ComponentProps<typeof ResumeSectionCard>> = {}) {
  const onStartEdit = vi.fn()
  const onCancel = vi.fn()
  const onSave = vi.fn()
  render(
    <ResumeSectionCard
      title="Про себе"
      sectionId="summary"
      canEdit={true}
      isEditing={false}
      isDirty={false}
      isSaving={false}
      disableEdit={false}
      onStartEdit={onStartEdit}
      onCancel={onCancel}
      onSave={onSave}
      {...overrides}
    >
      <p>children</p>
    </ResumeSectionCard>,
  )
  return { onStartEdit, onCancel, onSave }
}

describe('ResumeSectionCard — edit button aria-label carries the section title', () => {
  it('names the section in the edit button, exactly, not a generic label', () => {
    renderCard({ title: 'Про себе' })
    expect(screen.getByRole('button', { name: 'Редагувати розділ «Про себе»' })).toBeInTheDocument()
  })

  it('changes when the title changes — the label is not a static string', () => {
    renderCard({ title: 'Навички' })
    expect(screen.getByRole('button', { name: 'Редагувати розділ «Навички»' })).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Редагувати розділ «Про себе»' }),
    ).not.toBeInTheDocument()
  })
})

describe('ResumeSectionCard — Save button text reflects the in-flight state', () => {
  it('reads "Зберегти" (exact) while idle', () => {
    renderCard({ isEditing: true, isDirty: true, isSaving: false })
    expect(screen.getByTestId('resume-save-summary')).toHaveTextContent('Зберегти')
    expect(screen.getByTestId('resume-save-summary')).not.toHaveTextContent('Зберігаємо')
  })

  it('reads "Зберігаємо…" (exact) while the mutation is in flight', () => {
    renderCard({ isEditing: true, isDirty: true, isSaving: true })
    expect(screen.getByTestId('resume-save-summary')).toHaveTextContent('Зберігаємо…')
    expect(screen.getByTestId('resume-save-summary')).not.toHaveTextContent('Зберегти')
  })
})
