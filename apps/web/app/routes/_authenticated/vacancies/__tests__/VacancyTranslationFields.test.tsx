/**
 * task-i18n-stage3c-pr2 (CI-MUT, fix-round A) — the per-tab status label
 * («не перекладено»/«перекладено»/«помилка», surfaced only through each
 * tab's `aria-label`) and the title field's error-state label class had no
 * direct test — only exercised indirectly via `VacancySheet.test.tsx`'s
 * tab-switch tests, which never inspect the accessible name itself.
 */
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, expect, it, beforeEach } from 'vitest'
import { useForm } from '@tanstack/react-form'
import { loadCatalog, I18nTestProvider } from '@/test/i18n'
import { VacancyTranslationFields } from '../components/VacancyTranslationFields'

beforeEach(async () => {
  await loadCatalog('uk')
})

function Harness() {
  const form = useForm({
    defaultValues: {
      translations: {
        uk: { title: '', description: '' },
        ru: { title: '', description: '' },
        es: { title: '', description: '' },
        pt: { title: '', description: '' },
      },
    },
  })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- same AnyForm pattern the component itself uses
  return <VacancyTranslationFields form={form as any} />
}

function renderHarness() {
  return render(
    <I18nTestProvider>
      <Harness />
    </I18nTestProvider>,
  )
}

describe('VacancyTranslationFields — tab status aria-label (CI-MUT, fix-round A)', () => {
  it('an untranslated locale tab is named "…— не перекладено"', () => {
    renderHarness()
    expect(screen.getByTestId('vacancy-translation-tab-uk')).toHaveAccessibleName(
      'Українська — не перекладено',
    )
  })

  it('filling BOTH title and description flips the tab to "…— перекладено"', () => {
    renderHarness()
    fireEvent.change(screen.getByTestId('vacancy-translation-uk-title'), {
      target: { value: 'Senior React Developer' },
    })
    fireEvent.change(screen.getByTestId('vacancy-translation-uk-description'), {
      target: { value: 'A perfectly adequate description body here.' },
    })
    expect(screen.getByTestId('vacancy-translation-tab-uk')).toHaveAccessibleName(
      'Українська — перекладено',
    )
  })

  it('a validation error on the title flips the tab to "…— помилка"', () => {
    renderHarness()
    const title = screen.getByTestId('vacancy-translation-uk-title')
    fireEvent.change(title, { target: { value: 'ab' } })
    fireEvent.blur(title)
    expect(screen.getByTestId('vacancy-translation-tab-uk')).toHaveAccessibleName(
      'Українська — помилка',
    )
  })
})

describe('VacancyTranslationFields — title field error class (CI-MUT, fix-round A)', () => {
  it('too-short title: error text shown, label turns text-destructive', () => {
    renderHarness()
    const title = screen.getByTestId('vacancy-translation-uk-title')
    fireEvent.change(title, { target: { value: 'ab' } })
    fireEvent.blur(title)
    expect(screen.getAllByText('Назва')[0]!.className).toMatch(/text-destructive/)
    expect(screen.getAllByText('Назва')[0]!.className).toMatch(/text-xs/)
  })

  it('a long-enough title: no error, label stays plain', () => {
    renderHarness()
    const title = screen.getByTestId('vacancy-translation-uk-title')
    fireEvent.change(title, { target: { value: 'Senior React Developer' } })
    fireEvent.blur(title)
    expect(screen.getAllByText('Назва')[0]!.className).not.toMatch(/text-destructive/)
  })
})
