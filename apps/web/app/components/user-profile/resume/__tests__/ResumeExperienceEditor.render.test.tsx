/**
 * `ResumeExperienceEditor` — the rendered wizard, not just `moveItem`
 * (covered separately in `ResumeExperienceEditor.test.tsx`). No render test
 * existed for this component before this round, so every aria-label,
 * placeholder, `data-testid` template, `position` computation, disabled-state
 * condition, and onChange wiring here had zero coverage.
 *
 * Two items are used throughout so that `position` (`index + 1`) is
 * distinguishable from a mutated `index - 1` on BOTH rows, and so the
 * per-index down-button `disabled` condition can be asserted as false on the
 * first row (only the LAST row is legitimately disabled).
 */
import { fireEvent, render as rtlRender, screen, type RenderOptions } from '@testing-library/react'
import type { ReactElement } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ResumeExperienceItem } from '@crm/shared'
import { loadCatalog, I18nTestProvider } from '@/test/i18n'
import { ResumeExperienceEditor } from '../ResumeExperienceEditor'

function render(ui: ReactElement, options?: RenderOptions) {
  return rtlRender(ui, { wrapper: I18nTestProvider, ...options })
}

beforeEach(() => loadCatalog('uk'))

const items: ResumeExperienceItem[] = [
  { role: 'Розробник', company: 'Acme', period: '2020 — 2022', bullets: ['Зробив A', 'Зробив B'] },
  { role: 'Тімлід', company: 'Beta', period: '2022 — наст. час', bullets: [] },
]

function renderEditor() {
  const onChange = vi.fn()
  render(<ResumeExperienceEditor items={items} onChange={onChange} />)
  return { onChange }
}

describe('position numbering (index + 1, not index - 1) drives every label on the row', () => {
  it('row 0: aria-labels say "1", not "-1" or "0"', () => {
    renderEditor()
    expect(screen.getByTestId('resume-experience-up-0')).toHaveAttribute(
      'aria-label',
      'Перемістити місце роботи 1 вгору',
    )
    expect(screen.getByTestId('resume-experience-down-0')).toHaveAttribute(
      'aria-label',
      'Перемістити місце роботи 1 вниз',
    )
    expect(screen.getByTestId('resume-experience-remove-0')).toHaveAttribute(
      'aria-label',
      'Видалити місце роботи 1',
    )
  })

  it('row 1: aria-labels say "2", not "0" — proves it tracks the row, not a constant', () => {
    renderEditor()
    expect(screen.getByTestId('resume-experience-up-1')).toHaveAttribute(
      'aria-label',
      'Перемістити місце роботи 2 вгору',
    )
    expect(screen.getByTestId('resume-experience-down-1')).toHaveAttribute(
      'aria-label',
      'Перемістити місце роботи 2 вниз',
    )
  })
})

describe('reorder/remove buttons: disabled state and click wiring', () => {
  it('the first row can move DOWN (only the LAST row is disabled)', () => {
    renderEditor()
    expect(screen.getByTestId('resume-experience-down-0')).not.toBeDisabled()
    expect(screen.getByTestId('resume-experience-down-1')).toBeDisabled()
  })

  it('the first row cannot move UP, the last row can', () => {
    renderEditor()
    expect(screen.getByTestId('resume-experience-up-0')).toBeDisabled()
    expect(screen.getByTestId('resume-experience-up-1')).not.toBeDisabled()
  })

  it('clicking "move down" on row 0 calls onChange with row 0 and row 1 swapped', () => {
    const { onChange } = renderEditor()
    fireEvent.click(screen.getByTestId('resume-experience-down-0'))
    expect(onChange).toHaveBeenCalledTimes(1)
    const next = onChange.mock.calls[0]?.[0] as ResumeExperienceItem[]
    expect(next.map((i) => i.role)).toEqual(['Тімлід', 'Розробник'])
  })

  it('clicking "remove" on row 0 calls onChange with only row 1 left', () => {
    const { onChange } = renderEditor()
    fireEvent.click(screen.getByTestId('resume-experience-remove-0'))
    expect(onChange).toHaveBeenCalledTimes(1)
    const next = onChange.mock.calls[0]?.[0] as ResumeExperienceItem[]
    expect(next.map((i) => i.role)).toEqual(['Тімлід'])
  })
})

describe('field labels and testids, exact — role/company/period/bullets', () => {
  it('role field: placeholder, aria-label, testid', () => {
    renderEditor()
    const input = screen.getByTestId('resume-experience-role-0')
    expect(input).toHaveAttribute('placeholder', 'Посада')
    expect(input).toHaveAttribute('aria-label', 'Посада, місце роботи 1')
    expect(input).toHaveValue('Розробник')
  })

  it('company field: placeholder, aria-label, testid', () => {
    renderEditor()
    const input = screen.getByTestId('resume-experience-company-0')
    expect(input).toHaveAttribute('placeholder', 'Компанія')
    expect(input).toHaveAttribute('aria-label', 'Компанія, місце роботи 1')
  })

  it('period field: placeholder, aria-label, testid', () => {
    renderEditor()
    const input = screen.getByTestId('resume-experience-period-0')
    expect(input).toHaveAttribute('placeholder', 'Період, наприклад 2021 — наст. час')
    expect(input).toHaveAttribute('aria-label', 'Період, місце роботи 1')
  })

  it('bullets field: placeholder, aria-label, testid, and newline-joined value', () => {
    renderEditor()
    const textarea = screen.getByTestId('resume-experience-bullets-0')
    expect(textarea).toHaveAttribute('placeholder', 'Досягнення — по одному в рядку')
    expect(textarea).toHaveAttribute('aria-label', 'Досягнення, місце роботи 1')
    // Two bullets joined with a REAL newline, not concatenated — this is what
    // distinguishes `.join('\n')` from a mutated `.join('')`.
    expect(textarea).toHaveValue('Зробив A\nЗробив B')
  })
})

describe('onChange wiring — typing in each field patches only that field', () => {
  it('role', () => {
    const { onChange } = renderEditor()
    fireEvent.change(screen.getByTestId('resume-experience-role-0'), {
      target: { value: 'Архітектор' },
    })
    expect(onChange).toHaveBeenCalledTimes(1)
    const next = onChange.mock.calls[0]?.[0] as ResumeExperienceItem[]
    expect(next[0]?.role).toBe('Архітектор')
    expect(next[0]?.company).toBe('Acme')
  })

  it('company', () => {
    const { onChange } = renderEditor()
    fireEvent.change(screen.getByTestId('resume-experience-company-0'), {
      target: { value: 'Gamma' },
    })
    const next = onChange.mock.calls[0]?.[0] as ResumeExperienceItem[]
    expect(next[0]?.company).toBe('Gamma')
  })

  it('period', () => {
    const { onChange } = renderEditor()
    fireEvent.change(screen.getByTestId('resume-experience-period-0'), {
      target: { value: '2019 — 2020' },
    })
    const next = onChange.mock.calls[0]?.[0] as ResumeExperienceItem[]
    expect(next[0]?.period).toBe('2019 — 2020')
  })

  it('bullets — split back into an array on newlines', () => {
    const { onChange } = renderEditor()
    fireEvent.change(screen.getByTestId('resume-experience-bullets-0'), {
      target: { value: 'Один\nДва\nТри' },
    })
    const next = onChange.mock.calls[0]?.[0] as ResumeExperienceItem[]
    expect(next[0]?.bullets).toEqual(['Один', 'Два', 'Три'])
  })
})

describe('add row', () => {
  it('appends an EMPTY item, exactly, via the add button', () => {
    const { onChange } = renderEditor()
    fireEvent.click(screen.getByTestId('resume-experience-add'))
    const next = onChange.mock.calls[0]?.[0] as ResumeExperienceItem[]
    expect(next).toHaveLength(3)
    expect(next[2]).toEqual({ company: '', role: '', period: '', bullets: [] })
  })
})
