/**
 * task-i18n-stage3c-pr2 (CI-MUT, fix-round A) — `VacancyFormFields`'s field-
 * level `onBlur` validators (title/slug/descriptionMd) and their error-state
 * `text-destructive` label classes had no DIRECT test (only exercised via
 * `VacancySheet.test.tsx`'s translation-tab failed-submit test, which never
 * blurs these three base fields with an invalid value) — the mutation gate
 * found 13 surviving mutants: the three `cn(err && 'text-destructive')`
 * conditionals and the slug field's `patternMsg` string literal.
 */
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, expect, it, beforeEach, vi } from 'vitest'
import { useForm } from '@tanstack/react-form'
import { loadCatalog, I18nTestProvider } from '@/test/i18n'
import { VacancyFormFields } from '../components/VacancyFormFields'

beforeEach(async () => {
  await loadCatalog('uk')
})

vi.mock('@/components/user-profile/contract/ContractEditor', () => ({
  ContractEditor: ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
    <textarea
      data-testid="vacancy-form-description"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  ),
}))

function Harness() {
  const form = useForm({
    defaultValues: {
      title: '',
      slug: '',
      domain: 'AI',
      employmentType: 'FULL_TIME',
      descriptionMd: '',
      salaryMin: '',
      salaryMax: '',
      salaryCurrency: 'USDT',
      salaryPeriod: 'MONTH',
      translations: { uk: { title: '', description: '' }, en: { title: '', description: '' } },
      skills: '',
      experienceMonths: '',
      qualifications: '',
      responsibilities: '',
      jobBenefits: '',
      workHours: '',
    },
  })
  return (
    <VacancyFormFields
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- same AnyForm pattern the component itself uses
      form={form as any}
      slugAutoLinked={false}
      onSlugAutoLinkedChange={() => {}}
    />
  )
}

function renderHarness() {
  return render(
    <I18nTestProvider>
      <Harness />
    </I18nTestProvider>,
  )
}

describe('VacancyFormFields — field-level validation errors (CI-MUT, fix-round A)', () => {
  it('title too short: error shown, label turns text-destructive', () => {
    renderHarness()
    const title = screen.getByTestId('vacancy-form-title')
    fireEvent.change(title, { target: { value: 'ab' } })
    fireEvent.blur(title)
    expect(screen.getByText('Мінімум 3 символи')).toBeInTheDocument()
    expect(screen.getByText('Назва вакансії').className).toMatch(/text-destructive/)
  })

  it('title long enough: no error, label stays plain', () => {
    renderHarness()
    const title = screen.getByTestId('vacancy-form-title')
    fireEvent.change(title, { target: { value: 'Senior React Developer' } })
    fireEvent.blur(title)
    expect(screen.queryByText('Мінімум 3 символи')).not.toBeInTheDocument()
    expect(screen.getByText('Назва вакансії').className).not.toMatch(/text-destructive/)
  })

  it('slug with an uppercase letter: the field-specific patternMsg, not the generic format error', () => {
    renderHarness()
    const slug = screen.getByTestId('vacancy-form-slug')
    fireEvent.change(slug, { target: { value: 'Bad-Slug' } })
    fireEvent.blur(slug)
    expect(screen.getByText('Малі латинські літери, цифри та дефіс')).toBeInTheDocument()
    expect(screen.getByText('URL-слаг').className).toMatch(/text-destructive/)
  })

  it('the work-hours field (VacancySeoFields) carries the catalog placeholder', () => {
    renderHarness()
    expect(screen.getByPlaceholderText('40 годин на тиждень')).toBeInTheDocument()
  })

  it('a valid slug: no error, label stays plain', () => {
    renderHarness()
    const slug = screen.getByTestId('vacancy-form-slug')
    fireEvent.change(slug, { target: { value: 'senior-react-developer' } })
    fireEvent.blur(slug)
    expect(screen.queryByText('Малі латинські літери, цифри та дефіс')).not.toBeInTheDocument()
    expect(screen.getByText('URL-слаг').className).not.toMatch(/text-destructive/)
  })

  // Note (fix-round A survey): `descriptionMd`'s own `onBlur` validator
  // cannot be exercised the same way — `VacancyFormFields.tsx` passes
  // `ContractEditor` no `onBlur` prop at all (only `value`/`onChange`), so
  // `field.handleBlur` never fires through user interaction with the real
  // component; this pre-dates this PR and is a product-behaviour gap, not an
  // i18n-text one — out of scope for this fix round. Its `cn(err &&
  // 'text-destructive')` mutant at line 274 stays uncovered for the same
  // reason `field.state.meta.isTouched` never becomes true here.
})
