/**
 * task-i18n-stage3c-pr2 (CI-MUT, fix-round A) — `VacancySalaryFields`'s own
 * `validateAmount`/cross-field-min-max validators had ZERO direct coverage
 * before this round (only exercised through `VacancySheet.test.tsx`'s
 * happy-path fill, which never touches an invalid value at all) — the
 * mutation gate found 14 surviving mutants here: the amount-validity
 * boundary (empty / zero / negative / non-numeric / positive), the
 * max-below-min cross-check, and the error-state `text-destructive` label
 * class on both fields.
 */
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, expect, it, beforeEach } from 'vitest'
import { useForm } from '@tanstack/react-form'
import { loadCatalog, I18nTestProvider } from '@/test/i18n'
import { VacancySalaryFields } from '../components/VacancySalaryFields'

beforeEach(async () => {
  await loadCatalog('uk')
})

function Harness({ salaryMin = '', salaryMax = '' }: { salaryMin?: string; salaryMax?: string }) {
  const form = useForm({
    defaultValues: { salaryMin, salaryMax, salaryCurrency: 'USDT', salaryPeriod: 'MONTH' },
  })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- same AnyForm pattern VacancyFormFields.tsx itself uses
  return <VacancySalaryFields form={form as any} />
}

function renderHarness(props: { salaryMin?: string; salaryMax?: string } = {}) {
  return render(
    <I18nTestProvider>
      <Harness {...props} />
    </I18nTestProvider>,
  )
}

describe('VacancySalaryFields — validateAmount boundary (CI-MUT, fix-round A)', () => {
  it('empty value on blur: no error (a legacy vacancy can genuinely have no salary yet)', () => {
    renderHarness()
    const min = screen.getByTestId('vacancy-form-salary-min')
    fireEvent.blur(min)
    expect(screen.queryByText('Введіть додатне число')).not.toBeInTheDocument()
  })

  it('zero on blur: error "Введіть додатне число", label turns text-destructive', () => {
    renderHarness()
    const min = screen.getByTestId('vacancy-form-salary-min')
    fireEvent.change(min, { target: { value: '0' } })
    fireEvent.blur(min)
    expect(screen.getByText('Введіть додатне число')).toBeInTheDocument()
    expect(screen.getByText('Мінімум').className).toMatch(/text-destructive/)
    expect(screen.getByText('Мінімум').className).toMatch(/text-xs/)
  })

  // A negative sign or non-digit character never reaches `validateAmount` at
  // all: `normalizeDecimalInput` (the field's own `onChange`) strips every
  // non-digit character — including `-` — before `handleChange` ever runs,
  // so `n < 0` is unreachable through this component's real input pipeline.
  // `n <= 0` at n===0 (tested below) already discriminates the `<=`-vs-`<`
  // mutant and the `||`-vs-`&&` mutant on the same line (0 is simultaneously
  // "finite" and "not greater than zero", so only the OR/`<=` original
  // produces an error for it).

  it('a positive value on blur: no error, label stays the plain class', () => {
    renderHarness()
    const min = screen.getByTestId('vacancy-form-salary-min')
    fireEvent.change(min, { target: { value: '3000' } })
    fireEvent.blur(min)
    expect(screen.queryByText('Введіть додатне число')).not.toBeInTheDocument()
    expect(screen.getByText('Мінімум').className).not.toMatch(/text-destructive/)
  })
})

describe('VacancySalaryFields — max-below-min cross-check (CI-MUT, fix-round A)', () => {
  it('max less than an already-filled min: "Максимум не може бути меншим за мінімум", label red', () => {
    renderHarness({ salaryMin: '5000' })
    const max = screen.getByTestId('vacancy-form-salary-max')
    fireEvent.change(max, { target: { value: '3000' } })
    fireEvent.blur(max)
    expect(screen.getByText('Максимум не може бути меншим за мінімум')).toBeInTheDocument()
    expect(screen.getByText('Максимум').className).toMatch(/text-destructive/)
    expect(screen.getByText('Максимум').className).toMatch(/text-xs/)
  })

  it('max greater than min: no cross-check error', () => {
    renderHarness({ salaryMin: '3000' })
    const max = screen.getByTestId('vacancy-form-salary-max')
    fireEvent.change(max, { target: { value: '5000' } })
    fireEvent.blur(max)
    expect(screen.queryByText('Максимум не може бути меншим за мінімум')).not.toBeInTheDocument()
  })

  it('min left empty: max alone is validated for positivity only, no cross-check crash', () => {
    renderHarness()
    const max = screen.getByTestId('vacancy-form-salary-max')
    fireEvent.change(max, { target: { value: '5000' } })
    fireEvent.blur(max)
    expect(screen.queryByText('Максимум не може бути меншим за мінімум')).not.toBeInTheDocument()
    expect(screen.queryByText('Введіть додатне число')).not.toBeInTheDocument()
  })
})
